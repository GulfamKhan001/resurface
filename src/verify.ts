import type { ExtractedItem } from "./schema.ts";

// Grounding: does the transcript actually say this?
//
// This is the answer to the question almost nobody building on an LLM in 2026
// can answer — "how do you know the extraction is right, without a human
// checking it?" — and it is the same move as reconciling two systems that
// disagree about money. You do not ask the source whether it is telling the
// truth. You check its claims against an independent record.
//
// Here the independent record is the transcript the extraction came from. Every
// item carries a verbatim quote; if that quote is not in the source, the item is
// not grounded, whatever the model's confidence said.

export type Grounding = "exact" | "fuzzy" | "not_found";

export interface VerifiedItem extends ExtractedItem {
  grounding: Grounding;
  /** 0-1, computed from evidence — NOT the model's self-reported number. */
  trust: number;
  reason: string;
}

// Normalise for comparison. Transcripts and model output disagree about
// whitespace, smart quotes and casing constantly, and none of those differences
// mean the quote was invented.
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Longest run of consecutive quote words that appears in the source, as a
// fraction of the quote. Word-level rather than character-level because a model
// that drops "the" is paraphrasing, not fabricating, and character similarity
// would score that far more harshly than it deserves.
function longestRunRatio(quote: string, source: string): number {
  const q = norm(quote).split(" ").filter(Boolean);
  if (!q.length) return 0;
  const s = norm(source);
  let best = 0;
  for (let start = 0; start < q.length; start++) {
    // Extend while the phrase is still present. Once it stops matching, no
    // longer phrase from this start can match either.
    let end = start + best;                 // no point re-checking shorter runs
    while (end < q.length) {
      const phrase = q.slice(start, end + 1).join(" ");
      if (!s.includes(phrase)) break;
      end++;
    }
    best = Math.max(best, end - start);
    if (best === q.length) break;
  }
  return best / q.length;
}

// Thresholds chosen to be forgiving of transcription and punctuation drift, and
// unforgiving of invention. A quote sharing under half its words in sequence
// with the source is not a quote.
const EXACT_MIN = 0.95;
const FUZZY_MIN = 0.55;

export function verifyItem(item: ExtractedItem, source: string): VerifiedItem {
  const normSource = norm(source);
  const exact = normSource.includes(norm(item.quote));
  const ratio = exact ? 1 : longestRunRatio(item.quote, source);

  let grounding: Grounding;
  if (exact || ratio >= EXACT_MIN) grounding = "exact";
  else if (ratio >= FUZZY_MIN) grounding = "fuzzy";
  else grounding = "not_found";

  // Trust is computed from evidence, then the model's own confidence is allowed
  // to lower it but never to raise it.
  //
  // A model's self-reported confidence is not a probability — it is a token
  // sequence that correlates loosely with correctness and is famously
  // overconfident on invented content. Letting it raise trust would mean a
  // confidently hallucinated item outranking a hedged real one, which is exactly
  // backwards.
  const base = grounding === "exact" ? 1 : grounding === "fuzzy" ? 0.6 : 0;
  const trust = Math.round(Math.min(base, base * (0.5 + item.confidence / 2)) * 100) / 100;

  const reason =
    grounding === "exact" ? "quote found verbatim in the source"
    : grounding === "fuzzy" ? `${Math.round(ratio * 100)}% of the quote's words appear in sequence — probably paraphrased`
    : `quote not present in the source (best run ${Math.round(ratio * 100)}%) — treated as unsupported`;

  return { ...item, grounding, trust, reason };
}

export interface VerifyReport {
  kept: VerifiedItem[];
  discarded: VerifiedItem[];
  counts: { exact: number; fuzzy: number; not_found: number };
  hallucinationRate: number;
}

// Anything ungrounded is discarded rather than shown with a warning. A user who
// sees an item at all will believe it, so a caveat next to a fabrication is not
// a safeguard — it is a fabrication with a footnote.
export function verifyAll(items: ExtractedItem[], source: string): VerifyReport {
  const all = items.map((i) => verifyItem(i, source));
  const kept = all.filter((i) => i.grounding !== "not_found");
  const discarded = all.filter((i) => i.grounding === "not_found");
  const counts = {
    exact: all.filter((i) => i.grounding === "exact").length,
    fuzzy: all.filter((i) => i.grounding === "fuzzy").length,
    not_found: discarded.length,
  };
  return {
    kept,
    discarded,
    counts,
    // The headline number: what fraction of what the model produced could not be
    // supported by the text it was given.
    hallucinationRate: all.length ? Math.round((discarded.length / all.length) * 1000) / 10 : 0,
  };
}
