import { pool, tx, close } from "./db.ts";
import { resolve } from "./resolve.ts";
import { fetchSource } from "./source.ts";
import { planChunks, pendingChunks, completeChunk, chunkResults, chunkProgress, splitText } from "./chunk.ts";
import { extractChunk, mergeItems, recordSpend, newSpend, BudgetExceeded, type Spend } from "./extract.ts";
import { verifyAll } from "./verify.ts";
import type { ExtractedItem } from "./schema.ts";
import { startSpan, traced, formatTraceparent, parseTraceparent, flush, type SpanContext } from "./trace.ts";

// The whole thing, end to end:
//   resolve -> source (cost cascade) -> chunk -> extract (checkpointed) ->
//   merge -> verify (grounding) -> store
//
// Every stage here was proven separately before being wired together, which is
// why this file is mostly plumbing. That was the point of doing weeks 1 and 3
// with no AI in them: when this run misbehaves, the queue, the checkpoints and
// the cascade are already known-good, so the fault has one place left to be.

export interface RunResult {
  assetId: string;
  jobId: string;
  kind: string;
  tier: string;
  chars: number;
  chunks: { total: number; done: number };
  extracted: number;
  duplicatesCollapsed: number;
  kept: number;
  discarded: number;
  hallucinationRate: number;
  schemaRejects: number;
  spend: Spend;
  trail: string[];
  traceId?: string;
}

export async function ingest(url: string, handle = "me", opts: { budgetUsd?: number; parent?: SpanContext | null } = {}): Promise<RunResult> {
  // The root span stands in for what the edge worker would create on accepting
  // the link. Passing opts.parent is how the real edge tier hands the trace over.
  const root = startSpan("ingest", opts.parent ?? null, { "resurface.url": url });
  const trace = root.ctx;

  const r = resolve(url);
  root.set({ "asset.kind": r.kind, "asset.key": r.key });

  // ── user + asset + save. Content-addressed, so the second person to save this
  //    reuses the asset and never triggers a second extraction. ──
  const { rows: u } = await pool.query<{ id: string }>(
    `insert into users (handle) values ($1) on conflict (handle) do update set handle = excluded.handle returning id`,
    [handle]
  );
  const userId = u[0].id;

  const src = await traced("source.fetch", trace, { "asset.kind": r.kind }, async (span) => {
    const out = await fetchSource(r);
    // The tier IS the cost decision — putting it on the span is what makes
    // "why was this item expensive?" answerable from a trace alone.
    span.set({ "source.tier": out.tier, "source.chars": out.text?.length ?? 0 }).cost(out.costUsd);
    return out;
  });

  const { rows: a } = await pool.query<{ id: string }>(
    `insert into assets (source_kind, source_key, title, metadata_only, source_tier, cost_usd)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (source_kind, source_key) do update set
       title = coalesce(excluded.title, assets.title),
       source_tier = excluded.source_tier
     returning id`,
    [r.kind, r.key, src.title, !!r.metadataOnly, src.tier, src.costUsd]
  );
  const assetId = a[0].id;

  await pool.query(
    `insert into saves (user_id, asset_id) values ($1,$2) on conflict do nothing`,
    [userId, assetId]
  );

  // ── a job to hang the chunks and the spend off ──
  const { rows: j } = await pool.query<{ id: string }>(
    `insert into jobs (asset_id, kind, fairness_user_id) values ($1,'extract',$2)
     on conflict (asset_id, kind) where state in ('queued','leased') do nothing
     returning id`,
    [assetId, userId]
  );
  const jobId = j[0]?.id
    ?? (await pool.query<{ id: string }>(`select id from jobs where asset_id=$1 and kind='extract' order by created_at desc limit 1`, [assetId])).rows[0].id;

  // Hand the trace across the queue boundary. There is no HTTP header here —
  // the next stage may run minutes later in a different runtime — so the W3C
  // traceparent travels on the row instead. See migration 005.
  await pool.query(`update jobs set traceparent = $2 where id = $1`, [jobId, formatTraceparent(trace)]);

  const base: RunResult = {
    assetId, jobId, kind: r.kind, tier: src.tier,
    chars: src.text?.length ?? 0,
    chunks: { total: 0, done: 0 },
    extracted: 0, duplicatesCollapsed: 0, kept: 0, discarded: 0,
    hallucinationRate: 0, schemaRejects: 0,
    spend: newSpend(), trail: [...src.trail],
  };

  // Nothing to extract from is a legitimate outcome, not a failure. A YouTube
  // link is saved and findable by title; pretending otherwise would mean storing
  // a title as if it were content.
  if (!src.text) {
    base.trail.push("no transcript available — asset saved as metadata only");
    await pool.query(`update jobs set state='done', updated_at=now() where id=$1`, [jobId]);
    root.set({ "outcome": "metadata_only" }).end();
    base.traceId = trace.traceId;
    return base;
  }

  // Captured after the guard above. TypeScript's narrowing of src.text does not
  // survive into the async closures below, and widening the signature to accept
  // null would push the check down into verifyAll where it does not belong.
  const sourceText: string = src.text;

  // ── chunk + extract, resuming anything already done ──
  const total = await planChunks(jobId, sourceText);
  const todo = await pendingChunks(jobId, sourceText);
  base.trail.push(`${total} chunks planned, ${todo.length} outstanding`);

  const spend = newSpend();
  let schemaRejects = 0;

  for (const c of todo) {
    try {
      const before = spend.usd;
      const { items, rejected } = await traced("extract.chunk", trace, { "chunk.idx": c.idx, "chunk.chars": c.text.length }, async (span) => {
        const out = await extractChunk(c.text, spend);
        span.set({ "items.extracted": out.items.length, "items.rejected": out.rejected.length })
            .cost(spend.usd - before);
        return out;
      });
      schemaRejects += rejected.length;
      for (const rej of rejected) {
        // Kept deliberately — these are the eval set. See migration 003.
        await pool.query(
          `insert into extraction_rejects (asset_id, job_id, stage, reason, payload) values ($1,$2,'schema',$3,$4)`,
          [assetId, jobId, rej.reason, JSON.stringify(rej.raw ?? null)]
        ).catch(() => {});
      }
      await completeChunk(jobId, c.idx, items);
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        base.trail.push(`budget stopped the run at chunk ${c.idx} — the finished chunks are checkpointed and will resume`);
        break;
      }
      base.trail.push(`chunk ${c.idx} failed: ${(err as Error).message.slice(0, 100)}`);
      // Leave it pending. Nothing is lost; the next run picks it up.
    }
  }

  base.spend = spend;
  base.chunks = await chunkProgress(jobId);
  base.schemaRejects = schemaRejects;
  await recordSpend(jobId, spend);

  // ── merge across the overlap, then check every claim against the source ──
  const perChunk = await chunkResults<ExtractedItem[]>(jobId);
  const { items, duplicatesCollapsed } = mergeItems(perChunk.filter(Array.isArray));
  base.extracted = items.length;
  base.duplicatesCollapsed = duplicatesCollapsed;

  const report = await traced("verify.grounding", trace, { "items.in": items.length }, async (span) => {
    const rep = verifyAll(items, sourceText);
    span.set({
      "grounding.exact": rep.counts.exact,
      "grounding.fuzzy": rep.counts.fuzzy,
      "grounding.discarded": rep.counts.not_found,
      "grounding.hallucination_rate": rep.hallucinationRate,
    });
    return rep;
  });
  base.kept = report.kept.length;
  base.discarded = report.discarded.length;
  base.hallucinationRate = report.hallucinationRate;

  for (const d of report.discarded) {
    await pool.query(
      `insert into extraction_rejects (asset_id, job_id, stage, reason, payload) values ($1,$2,'grounding',$3,$4)`,
      [assetId, jobId, d.reason, JSON.stringify({ title: d.title, quote: d.quote, confidence: d.confidence })]
    ).catch(() => {});
  }

  await tx(async (c) => {
    for (const it of report.kept) {
      await c.query(
        `insert into items (asset_id, kind, title, detail, quote, model_confidence, grounding, trust)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (asset_id, kind, title) do update set
           trust = greatest(items.trust, excluded.trust),
           detail = case when length(excluded.detail) > length(items.detail) then excluded.detail else items.detail end`,
        [assetId, it.kind, it.title, it.detail, it.quote, it.confidence, it.grounding, it.trust]
      );
    }
    await c.query(`update jobs set state='done', cost_usd=$2, updated_at=now() where id=$1`, [jobId, spend.usd]);
  });

  root.set({
    "items.kept": base.kept,
    "items.discarded": base.discarded,
    "chunks.total": base.chunks.total,
    "llm.calls": spend.calls,
    "llm.in_tokens": spend.inTok,
    "llm.out_tokens": spend.outTok,
  }).cost(spend.usd);
  root.end();
  base.traceId = trace.traceId;
  return base;
}

// CLI: node --env-file=.env src/pipeline.ts <url>
if (process.argv[1]?.endsWith("pipeline.ts")) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: npm run ingest -- <url>");
    process.exit(1);
  }
  const t0 = Date.now();
  ingest(url)
    .then(async (r) => {
      console.log(`\n  ${url}\n`);
      for (const t of r.trail) console.log(`  · ${t}`);
      console.log(`\n  kind ${r.kind} · tier ${r.tier} · ${r.chars} chars · ${r.chunks.done}/${r.chunks.total} chunks`);
      console.log(`  extracted ${r.extracted} (collapsed ${r.duplicatesCollapsed} overlap duplicates)`);
      console.log(`  grounded ${r.kept} · discarded ${r.discarded} · hallucination rate ${r.hallucinationRate}%`);
      console.log(`  schema rejects ${r.schemaRejects}`);
      console.log(`  spend $${r.spend.usd.toFixed(4)} over ${r.spend.calls} calls (${r.spend.inTok} in / ${r.spend.outTok} out)`);
      console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
      const { rows } = await pool.query<{ kind: string; title: string; trust: string; grounding: string }>(
        `select kind, title, trust, grounding from items where asset_id=$1 order by trust desc, kind limit 15`, [r.assetId]
      );
      for (const i of rows) console.log(`    ${String(i.trust).padStart(5)} ${i.grounding.padEnd(6)} ${i.kind.padEnd(8)} ${i.title.slice(0, 60)}`);
      // Flush at the end of the run, not on a timer: a worker that scales to
      // zero has no timer to fire, and losing the spans for the run that just
      // finished is the usual way self-hosted tracing quietly stops working.
      const f = await flush();
      console.log(`\n  trace ${r.traceId}`);
      console.log(`  spans: ${f.exported} ${f.ok ? (f.reason ? "(" + f.reason + ")" : "exported") : "FAILED: " + f.reason}`);
      await close();
    })
    .catch(async (e) => { console.error("ingest failed:", e); await close().catch(() => {}); process.exit(1); });
}
