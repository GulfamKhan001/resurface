import { pool, close } from "./db.ts";
import { resolve } from "./resolve.ts";
import { fetchSource } from "./source.ts";
import { planChunks, pendingChunks, completeChunk, chunkProgress, chunkResults, splitText } from "./chunk.ts";

// Does a job that dies mid-way actually resume, and does it avoid paying twice?
//
// Week 1 proved the queue survives a worker being killed. This proves the WORK
// survives it — a different property, and the one that costs money when it is
// wrong. The extractor here is fake and counts its calls, because the assertion
// is about how many times each chunk is processed, not about what it returns.

const REAL_URL = "https://changelog.com/podcast/613";

let extractorCalls = 0;
const calledFor = new Set<number>();

// Stands in for the LLM. Counts calls so double-spend is measurable, and can be
// told to die at a specific chunk.
async function fakeExtract(idx: number, text: string, dieAt: number | null): Promise<{ idx: number; words: number }> {
  if (dieAt !== null && idx === dieAt) throw new Error(`worker died while extracting chunk ${idx}`);
  extractorCalls++;
  calledFor.add(idx);
  await new Promise((r) => setTimeout(r, 30));
  return { idx, words: text.split(/\s+/).length };
}

async function runUntil(jobId: string, text: string, dieAt: number | null): Promise<"finished" | "died"> {
  const todo = await pendingChunks(jobId, text);
  for (const c of todo) {
    try {
      const result = await fakeExtract(c.idx, c.text, dieAt);
      await completeChunk(jobId, c.idx, result);
    } catch {
      return "died";
    }
  }
  return "finished";
}

async function main() {
  console.log("resurface resumability test — real content, simulated death\n");

  // 1. Real source through the real cascade. No fixture: the point is that the
  //    chunk count comes from content that actually exists.
  const r = resolve(REAL_URL);
  const src = await fetchSource(r);
  if (!src.text) {
    console.log(`  FAIL  the cascade produced no text for ${REAL_URL}`);
    await close();
    process.exit(1);
  }
  console.log(`  source: ${r.kind} · tier ${src.tier} · $${src.costUsd} · ${src.text.length} chars`);

  const parts = splitText(src.text);
  console.log(`  splits into ${parts.length} chunks of <= 12,000 chars\n`);
  if (parts.length < 4) {
    console.log("  FAIL  need at least 4 chunks for this test to mean anything");
    await close();
    process.exit(1);
  }

  // 2. Set up a job to hang the chunks off.
  await pool.query(`truncate side_effects, job_runs, chunks, jobs, saves, assets, users restart identity cascade`);
  const { rows: u } = await pool.query<{ id: string }>(`insert into users (handle) values ('resume') returning id`);
  const { rows: a } = await pool.query<{ id: string }>(
    `insert into assets (source_kind, source_key, title) values ($1, $2, $3) returning id`,
    [r.kind, r.key, src.title]
  );
  const { rows: j } = await pool.query<{ id: string }>(
    `insert into jobs (asset_id, kind, fairness_user_id) values ($1, 'extract', $2) returning id`,
    [a[0].id, u[0].id]
  );
  const jobId = j[0].id;

  const planned = await planChunks(jobId, src.text);
  console.log(`  planned ${planned} chunk rows`);

  // 3. First attempt dies part-way.
  const dieAt = Math.floor(parts.length / 2);
  const first = await runUntil(jobId, src.text, dieAt);
  const afterCrash = await chunkProgress(jobId);
  console.log(`  attempt 1: ${first} at chunk ${dieAt} — ${afterCrash.done}/${afterCrash.total} done, ${extractorCalls} extractor calls`);

  // planChunks runs again on retry, as it would in the real worker. It must not
  // wipe the completed rows.
  const replanned = await planChunks(jobId, src.text);
  const afterReplan = await chunkProgress(jobId);
  console.log(`  re-planned (as a retry would): ${afterReplan.done}/${afterReplan.total} still done`);

  const callsBeforeResume = extractorCalls;

  // 4. Second attempt, healthy.
  const second = await runUntil(jobId, src.text, null);
  const final = await chunkProgress(jobId);
  const resumeCalls = extractorCalls - callsBeforeResume;
  console.log(`  attempt 2: ${second} — ${final.done}/${final.total} done, ${resumeCalls} further extractor calls\n`);

  // ── assertions ──
  let ok = true;
  const check = (label: string, pass: boolean, detail: string) => {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) ok = false;
  };

  check("every chunk completed", final.done === final.total, `${final.done}/${final.total}`);
  check("the crash left real work done", afterCrash.done === dieAt, `${afterCrash.done} chunks survived the crash`);
  check("re-planning did not wipe completed chunks", afterReplan.done === afterCrash.done, `${afterReplan.done} still done after re-plan`);
  check(
    "resume skipped the finished chunks",
    resumeCalls === parts.length - dieAt,
    `re-processed ${resumeCalls}, which is exactly the ${parts.length - dieAt} that were outstanding`
  );
  check(
    "no chunk was processed twice",
    extractorCalls === calledFor.size,
    `${extractorCalls} calls across ${calledFor.size} distinct chunks`
  );

  const merged = await chunkResults<{ idx: number; words: number }>(jobId);
  check("results are readable and ordered", merged.length === parts.length && merged[0].idx === 0, `${merged.length} results`);

  // The number that would have been money.
  const naive = parts.length + dieAt;
  console.log(`\n  without checkpointing this job would have cost ${naive} extractions; it cost ${extractorCalls}.`);
  console.log(`\n  ${ok ? "RESUMABILITY HOLDS" : "PROPERTY VIOLATED"}`);
  await close();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error("resumetest crashed:", e);
  await close().catch(() => {});
  process.exit(1);
});
