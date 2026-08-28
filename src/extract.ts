import { pool } from "./db.ts";
import { validateExtraction, parseJsonLoose, ITEM_KINDS, type ExtractedItem } from "./schema.ts";

// The extraction stage — the first thing in this pipeline that costs money.
//
// The spend guard is written before the call rather than after, because the job
// pipeline this project sits alongside taught the lesson expensively: it hit a
// zero balance mid-run and, because errors were caught per stage, it failed
// SILENTLY. Jobs simply stopped being scored and nothing said so for days.
//
// No SDK. One fetch against the Messages API keeps this project at a single
// runtime dependency and no build step, and the request shape is small enough
// that owning it is cheaper than owning a dependency.

const MODEL = "claude-haiku-4-5-20251001";
const PRICE_IN_PER_MTOK = 1.0;
const PRICE_OUT_PER_MTOK = 5.0;

// A ceiling on one run, not a monthly budget. The failure this prevents is a
// loop over a 200-chunk transcript quietly costing real money.
export const MAX_RUN_USD = Number(process.env.MAX_EXTRACT_USD) || 0.5;

export class BudgetExceeded extends Error {
  constructor(spent: number) {
    super(`extraction budget exhausted: $${spent.toFixed(4)} of $${MAX_RUN_USD}`);
    this.name = "BudgetExceeded";
  }
}

export interface Spend { usd: number; calls: number; inTok: number; outTok: number }

export function newSpend(): Spend {
  return { usd: 0, calls: 0, inTok: 0, outTok: 0 };
}

function priceOf(usage: { input_tokens?: number; output_tokens?: number }): number {
  const i = usage.input_tokens ?? 0;
  const o = usage.output_tokens ?? 0;
  return (i / 1e6) * PRICE_IN_PER_MTOK + (o / 1e6) * PRICE_OUT_PER_MTOK;
}

const PROMPT = `You extract things worth remembering from a transcript or article.

Return ONLY a JSON array. No prose, no markdown fence, no explanation.

Each element:
{
  "kind": one of ${ITEM_KINDS.map((k) => `"${k}"`).join(" | ")},
  "title": short name of the thing (2-200 chars),
  "detail": what was actually said about it, in one or two sentences,
  "quote": a VERBATIM span copied exactly from the text below that this came from,
  "confidence": 0-1, how sure you are this is really being recommended or described
}

Rules that matter more than completeness:
- The "quote" must be copied character-for-character from the text. It is checked
  against the source afterwards, and anything that cannot be found is discarded.
- Extract only things actually mentioned. Do not add well-known examples, do not
  infer what the speaker probably meant, do not complete a partial list.
- If the text contains nothing worth saving, return []. An empty array is a
  correct answer and is strongly preferred to a plausible invention.
- Prefer 3 solid items over 12 speculative ones.`;

export async function extractChunk(
  text: string,
  spend: Spend,
  opts: { signal?: AbortSignal } = {}
): Promise<{ items: ExtractedItem[]; rejected: { reason: string; raw: unknown }[]; raw: string }> {
  if (spend.usd >= MAX_RUN_USD) throw new BudgetExceeded(spend.usd);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: `${PROMPT}\n\n---\nTEXT:\n${text}` }],
    }),
    signal: opts.signal ?? AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  // Charge on ACTUAL usage, never on an estimate. An estimate that drifts low is
  // how a budget silently stops being a budget.
  const cost = priceOf(json.usage ?? {});
  spend.usd += cost;
  spend.calls += 1;
  spend.inTok += json.usage?.input_tokens ?? 0;
  spend.outTok += json.usage?.output_tokens ?? 0;

  const raw = (json.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("");
  const { items, rejected } = validateExtraction(parseJsonLoose(raw));
  return { items, rejected, raw };
}

// ─── merging across chunks ───
//
// Chunks overlap by 500 characters so an item on a boundary is not cut in half.
// The cost of that is duplicates: something mentioned in the overlap gets
// extracted by both neighbouring chunks. Merging has to collapse them, and it
// has to do so on the CONTENT rather than the position, because the two copies
// will have slightly different wording.
function mergeKey(i: ExtractedItem): string {
  return `${i.kind}:${i.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}

export function mergeItems(perChunk: ExtractedItem[][]): { items: ExtractedItem[]; duplicatesCollapsed: number } {
  const byKey = new Map<string, ExtractedItem>();
  let dupes = 0;
  for (const list of perChunk) {
    for (const item of list) {
      const k = mergeKey(item);
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, item); continue; }
      dupes++;
      // Keep the more confident version, and the longer detail — the copy from
      // the chunk that saw more surrounding context is usually the better one.
      if (item.confidence > prev.confidence) byKey.set(k, item);
      else if (item.confidence === prev.confidence && item.detail.length > prev.detail.length) byKey.set(k, item);
    }
  }
  return { items: [...byKey.values()], duplicatesCollapsed: dupes };
}

export async function recordSpend(jobId: string, spend: Spend): Promise<void> {
  await pool.query(
    `update jobs set updated_at = now() where id = $1`,
    [jobId]
  ).catch(() => {});
  await pool.query(
    `insert into extraction_spend (job_id, usd, calls, in_tokens, out_tokens)
     values ($1, $2, $3, $4, $5)
     on conflict (job_id) do update set
       usd = extraction_spend.usd + excluded.usd,
       calls = extraction_spend.calls + excluded.calls,
       in_tokens = extraction_spend.in_tokens + excluded.in_tokens,
       out_tokens = extraction_spend.out_tokens + excluded.out_tokens`,
    [jobId, spend.usd, spend.calls, spend.inTok, spend.outTok]
  );
}
