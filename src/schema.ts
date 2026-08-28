// What we pull out of a saved thing, and the validator that refuses to trust it.
//
// Hand-rolled rather than importing a validation library. Two reasons: this
// project keeps exactly one runtime dependency and no build step, and — the one
// that matters in an interview — being able to explain what your validator does
// on malformed input is worth more than being able to name the library you
// imported.
//
// The premise is that the model WILL return something wrong eventually: a field
// missing, a string where a number belongs, an item invented outright. Every one
// of those has to be caught here rather than reaching storage, because a bad row
// is far more expensive to notice later than a rejected response is now.

export type ItemKind = "recipe" | "workout" | "book" | "place" | "tool" | "idea";

export interface ExtractedItem {
  kind: ItemKind;
  title: string;
  detail: string;
  /** Verbatim span from the transcript this was taken from. The grounding check
   *  needs it, so it is required rather than nice to have. */
  quote: string;
  /** The model's own confidence, 0-1. Treated as a weak hint, never as a
   *  probability — see the note in verify.ts. */
  confidence: number;
}

export const ITEM_KINDS: ItemKind[] = ["recipe", "workout", "book", "place", "tool", "idea"];

export interface ValidationResult {
  items: ExtractedItem[];
  rejected: { reason: string; raw: unknown }[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Validate one item. Returns the reason it failed rather than a boolean, because
// "the model got it wrong" is not one failure mode — knowing WHICH is what makes
// a prompt fixable.
function validateItem(raw: unknown): { ok: true; item: ExtractedItem } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: "not an object" };

  const kind = raw.kind;
  if (typeof kind !== "string" || !ITEM_KINDS.includes(kind as ItemKind)) {
    return { ok: false, reason: `kind not one of ${ITEM_KINDS.join("|")} (got ${JSON.stringify(kind)})` };
  }

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (title.length < 2) return { ok: false, reason: "title missing or too short" };
  if (title.length > 200) return { ok: false, reason: "title implausibly long — likely a paragraph" };

  const detail = typeof raw.detail === "string" ? raw.detail.trim() : "";
  if (!detail) return { ok: false, reason: "detail missing" };

  // A quote is mandatory. Without it there is nothing to check the claim
  // against, and an unverifiable extraction is exactly the thing this project
  // exists to avoid producing.
  const quote = typeof raw.quote === "string" ? raw.quote.trim() : "";
  if (quote.length < 10) return { ok: false, reason: "quote missing or too short to verify against the source" };

  // Accept a number or a numeric string, because models return both, but reject
  // anything outside 0-1 rather than silently clamping — a confidence of 95
  // means the model misunderstood the scale, and that is worth knowing.
  const rawConf = typeof raw.confidence === "string" ? Number(raw.confidence) : raw.confidence;
  if (typeof rawConf !== "number" || Number.isNaN(rawConf)) return { ok: false, reason: "confidence not a number" };
  if (rawConf < 0 || rawConf > 1) return { ok: false, reason: `confidence outside 0-1 (got ${rawConf})` };

  return {
    ok: true,
    item: { kind: kind as ItemKind, title, detail: detail.slice(0, 2000), quote: quote.slice(0, 500), confidence: rawConf },
  };
}

export function validateExtraction(parsed: unknown): ValidationResult {
  const items: ExtractedItem[] = [];
  const rejected: { reason: string; raw: unknown }[] = [];

  // Accept either a bare array or {items:[...]}, because both come back in
  // practice and refusing one would be pedantry rather than safety.
  const list = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : null;

  if (!list) {
    rejected.push({ reason: "response was neither an array nor {items:[...]}", raw: parsed });
    return { items, rejected };
  }

  for (const raw of list) {
    const r = validateItem(raw);
    if (r.ok) items.push(r.item);
    else rejected.push({ reason: r.reason, raw });
  }
  return { items, rejected };
}

// Models wrap JSON in prose and fences no matter how firmly told not to. The
// greedy /\{[\s\S]*\}/ regex dies on trailing text containing a brace, so fall
// back to walking the string and tracking depth, ignoring braces inside strings.
export function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;

  try {
    return JSON.parse(body.trim());
  } catch { /* fall through */ }

  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;

  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
