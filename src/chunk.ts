import { pool, tx } from "./db.ts";

// Chunking and resumability.
//
// A Changelog episode page yields 76,000 characters. That is far too much for one
// extraction call, so it gets split — and the moment work is split, the question
// "what happens if the worker dies at piece 7 of 12" becomes real money rather
// than a thought experiment.
//
// This is why `chunks` is a TABLE and not a column on jobs. A column means
// rewriting the whole blob to record progress, so there is no such thing as
// partial progress. A row per chunk means a worker that dies mid-job resumes at
// exactly the chunk it was on and never re-spends on the ones already done.

// Sized for the extraction model's context with room for the prompt and the
// response. Overlap exists because a recipe ingredient or a book title landing
// exactly on a boundary would otherwise be cut in half and extracted from
// neither side.
export const CHUNK_CHARS = 12_000;
export const OVERLAP_CHARS = 500;

export function splitText(text: string): string[] {
  const clean = String(text || "").trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_CHARS) return [clean];

  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_CHARS, clean.length);

    // Prefer to break at a paragraph, then a sentence, then a space. Cutting
    // mid-word produces fragments the extractor reads as noise.
    if (end < clean.length) {
      const window = clean.slice(Math.max(start + CHUNK_CHARS - 1200, start), end);
      const para = window.lastIndexOf("\n");
      const sent = window.lastIndexOf(". ");
      const space = window.lastIndexOf(" ");
      const rel = para > 200 ? para : sent > 200 ? sent + 1 : space > 200 ? space : -1;
      if (rel > 0) end = Math.max(start + CHUNK_CHARS - 1200, start) + rel;
    }

    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }
  return out.filter(Boolean);
}

// Write the chunk rows once, at the start of the job.
//
// ON CONFLICT DO NOTHING because this runs again on every retry of the job: a
// worker that died after planning but before finishing must find its existing
// chunks, not a fresh set with the completed ones wiped.
export async function planChunks(jobId: string, text: string): Promise<number> {
  const parts = splitText(text);
  if (!parts.length) return 0;
  await tx(async (c) => {
    for (let i = 0; i < parts.length; i++) {
      await c.query(
        `insert into chunks (job_id, idx, state) values ($1, $2, 'pending')
         on conflict (job_id, idx) do nothing`,
        [jobId, i]
      );
    }
  });
  return parts.length;
}

export interface PendingChunk { idx: number; text: string }

// Only the chunks still to do. The text is re-derived from the source rather
// than stored per row: splitText is deterministic, so the same input yields the
// same boundaries, and storing 76KB twice would be for nothing.
export async function pendingChunks(jobId: string, text: string): Promise<PendingChunk[]> {
  const parts = splitText(text);
  const { rows } = await pool.query<{ idx: number }>(
    `select idx from chunks where job_id = $1 and state = 'done'`,
    [jobId]
  );
  const done = new Set(rows.map((r) => r.idx));
  return parts.map((t, idx) => ({ idx, text: t })).filter((p) => !done.has(p.idx));
}

// Record one chunk's result. Its own transaction on purpose: the point of
// checkpointing is that finishing chunk 7 survives the worker dying on chunk 8,
// which cannot happen if all twelve share a transaction.
export async function completeChunk(jobId: string, idx: number, result: unknown): Promise<void> {
  await pool.query(
    `update chunks set state = 'done', result = $3, updated_at = now()
      where job_id = $1 and idx = $2`,
    [jobId, idx, JSON.stringify(result ?? null)]
  );
}

export async function chunkProgress(jobId: string): Promise<{ total: number; done: number }> {
  const { rows } = await pool.query<{ total: string; done: string }>(
    `select count(*) as total, count(*) filter (where state = 'done') as done
       from chunks where job_id = $1`,
    [jobId]
  );
  return { total: Number(rows[0]?.total ?? 0), done: Number(rows[0]?.done ?? 0) };
}

export async function chunkResults<T = unknown>(jobId: string): Promise<T[]> {
  const { rows } = await pool.query<{ result: T }>(
    `select result from chunks where job_id = $1 and state = 'done' order by idx`,
    [jobId]
  );
  return rows.map((r) => r.result).filter((r) => r != null);
}
