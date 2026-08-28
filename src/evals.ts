import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { extractChunk, newSpend, PROMPT_VERSION } from "./extract.ts";
import { verifyAll } from "./verify.ts";
import type { ExtractedItem } from "./schema.ts";

// Evaluating a non-deterministic extractor.
//
// The hard part is not measuring quality, it is that the same input can legitimately
// produce different output. So none of the assertions here are string equality:
//
//   recall     did it find the things a human labelled as present?
//   precision  did it avoid the traps a human labelled as absent?
//   stability  run the same input twice — how much of the output agrees with itself?
//   grounding  what fraction of what it produced could not be found in the source?
//
// Stability is the one people leave out, and it is the one that tells you whether
// a change in the other three means anything. A prompt whose recall moved from
// 0.7 to 0.8 has not necessarily improved if its run-to-run agreement is 0.6.

interface GoldenCase {
  id: string;
  note: string;
  text: string;
  expect: { kind: string; titleContains: string[] }[];
  forbid: string[];
}

export interface CaseResult {
  id: string;
  extracted: number;
  grounded: number;
  matched: number;
  expected: number;
  trapsHit: string[];
  recall: number;
  precisionProxy: number;
  items: { kind: string; title: string; trust: number }[];
}

export interface EvalRun {
  promptVersion: string;
  at: string;
  cases: CaseResult[];
  totals: {
    expected: number; matched: number; recall: number;
    traps: number; trapsHit: number; trapAvoidance: number;
    extracted: number; grounded: number; hallucinationRate: number;
    usd: number; calls: number;
  };
  stability?: { casesRun: number; agreement: number };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// An expectation matches if the kind agrees and ANY of the title fragments appears.
// Deliberately loose on wording: "Roast Aubergine with Buttermilk Sauce" and
// "Ottolenghi aubergine" are the same find, and a scorer that calls the second a
// miss is measuring phrasing rather than extraction.
function findsExpectation(items: ExtractedItem[], exp: { kind: string; titleContains: string[] }): boolean {
  return items.some((i) => {
    if (i.kind !== exp.kind) return false;
    const hay = norm(`${i.title} ${i.detail}`);
    return exp.titleContains.some((frag) => hay.includes(norm(frag)));
  });
}

function trapsTriggered(items: ExtractedItem[], forbid: string[]): string[] {
  const hay = items.map((i) => norm(`${i.title} ${i.detail}`));
  return forbid.filter((f) => hay.some((h) => h.includes(norm(f))));
}

async function runCase(c: GoldenCase, spend: ReturnType<typeof newSpend>): Promise<CaseResult> {
  const { items } = await extractChunk(c.text, spend);
  const report = verifyAll(items, c.text);
  const kept = report.kept;

  const matched = c.expect.filter((e) => findsExpectation(kept, e)).length;
  const trapsHit = trapsTriggered(kept, c.forbid);

  return {
    id: c.id,
    extracted: items.length,
    grounded: kept.length,
    matched,
    expected: c.expect.length,
    trapsHit,
    recall: c.expect.length ? matched / c.expect.length : 1,
    // Not true precision — that needs every extraction labelled, not just the
    // traps. This is "did it avoid the specific mistakes a human anticipated",
    // which is weaker and is named accordingly.
    precisionProxy: c.forbid.length ? 1 - trapsHit.length / c.forbid.length : 1,
    items: kept.map((i) => ({ kind: i.kind, title: i.title, trust: i.trust })),
  };
}

export async function runEvals(opts: { stability?: boolean } = {}): Promise<EvalRun> {
  const path = new URL("../evals/cases.json", import.meta.url);
  const golden = JSON.parse(readFileSync(path, "utf8")) as { cases: GoldenCase[] };
  const spend = newSpend();
  const results: CaseResult[] = [];

  for (const c of golden.cases) {
    results.push(await runCase(c, spend));
  }

  const totals = {
    expected: results.reduce((n, r) => n + r.expected, 0),
    matched: results.reduce((n, r) => n + r.matched, 0),
    recall: 0,
    traps: golden.cases.reduce((n, c) => n + c.forbid.length, 0),
    trapsHit: results.reduce((n, r) => n + r.trapsHit.length, 0),
    trapAvoidance: 0,
    extracted: results.reduce((n, r) => n + r.extracted, 0),
    grounded: results.reduce((n, r) => n + r.grounded, 0),
    hallucinationRate: 0,
    usd: Math.round(spend.usd * 1e6) / 1e6,
    calls: spend.calls,
  };
  totals.recall = totals.expected ? Math.round((totals.matched / totals.expected) * 1000) / 1000 : 1;
  totals.trapAvoidance = totals.traps ? Math.round((1 - totals.trapsHit / totals.traps) * 1000) / 1000 : 1;
  totals.hallucinationRate = totals.extracted
    ? Math.round(((totals.extracted - totals.grounded) / totals.extracted) * 1000) / 10
    : 0;

  const run: EvalRun = { promptVersion: PROMPT_VERSION, at: new Date().toISOString(), cases: results, totals };

  // Stability: re-run a subset and measure self-agreement. Without this number,
  // any movement in recall is unattributable — you cannot tell a better prompt
  // from a luckier sample.
  if (opts.stability) {
    const subset = golden.cases.filter((c) => c.expect.length > 0).slice(0, 4);
    let agree = 0, total = 0;
    for (const c of subset) {
      const second = await runCase(c, spend);
      const first = results.find((r) => r.id === c.id)!;
      const a = new Set(first.items.map((i) => `${i.kind}:${norm(i.title)}`));
      const b = new Set(second.items.map((i) => `${i.kind}:${norm(i.title)}`));
      const union = new Set([...a, ...b]);
      const inter = [...a].filter((x) => b.has(x)).length;
      if (union.size) { agree += inter / union.size; total++; }
    }
    run.stability = { casesRun: total, agreement: total ? Math.round((agree / total) * 1000) / 1000 : 1 };
    run.totals.usd = Math.round(spend.usd * 1e6) / 1e6;
    run.totals.calls = spend.calls;
  }

  return run;
}

// ─── regression baseline ───
//
// Separate from the golden set and never conflated with it. This records what the
// current prompt DOES, so a change can be compared against it. It says nothing
// about correctness — a baseline captured from a bad prompt faithfully preserves
// the badness. Its only job is to answer "did this edit change anything, and in
// which direction".
const BASELINE = new URL("../evals/baseline.json", import.meta.url);

export function loadBaseline(): EvalRun | null {
  try {
    return existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as EvalRun) : null;
  } catch {
    return null;
  }
}

export function saveBaseline(run: EvalRun): void {
  writeFileSync(BASELINE, JSON.stringify(run, null, 2));
}

export function compare(current: EvalRun, base: EvalRun) {
  const d = (a: number, b: number) => Math.round((a - b) * 1000) / 1000;
  return {
    promptChanged: current.promptVersion !== base.promptVersion,
    recall: d(current.totals.recall, base.totals.recall),
    trapAvoidance: d(current.totals.trapAvoidance, base.totals.trapAvoidance),
    hallucinationRate: d(current.totals.hallucinationRate, base.totals.hallucinationRate),
    usd: d(current.totals.usd, base.totals.usd),
    perCase: current.cases.map((c) => {
      const b = base.cases.find((x) => x.id === c.id);
      return b ? { id: c.id, recall: d(c.recall, b.recall), traps: c.trapsHit.length - b.trapsHit.length } : { id: c.id, recall: 0, traps: 0, isNew: true };
    }).filter((x) => x.recall !== 0 || x.traps !== 0 || "isNew" in x),
  };
}
