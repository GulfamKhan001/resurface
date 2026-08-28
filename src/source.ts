import type { Resolved } from "./resolve.ts";

// The cost cascade.
//
// This is the feature that makes the project something other than a wrapper
// around an API call: getting the text is a runtime CHOICE between a free path
// and a paid one, and the choice has to be made per item with no way to know in
// advance which will work.
//
// The original design put "native YouTube transcript" first. That step is gone:
// measured 2026-08-27, YouTube answers unauthenticated caption requests with
// HTTP 200 and an empty body, on every format. Not a 403 to route around — a
// successful-looking response containing nothing. The tiers below are the ones
// that actually work, each with a measured hit rate rather than an assumed one.

export type Tier = "rss_transcript" | "page_text" | "yt_description" | "oembed_metadata" | "paid_asr" | "none";

export interface SourceResult {
  tier: Tier;
  text: string | null;
  title: string | null;
  /** Real money spent getting this. Becomes a span attribute in week 5. */
  costUsd: number;
  /** Why this tier was chosen, and what was tried before it. */
  trail: string[];
  durationMin?: number;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DEEPGRAM_USD_PER_MIN = 0.0043;   // Nova-3 batch, verified 2026-08-20

async function get(url: string, timeoutMs = 20_000): Promise<Response | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? r : null;
  } catch {
    return null;
  }
}

// Visible page text. Same approach as the job pipeline's extractor, and the same
// two lessons baked in: strip scripts because the framework payload is not prose,
// and strip forms because a country <select> is thousands of characters of noise
// that will eat the whole extract before the content starts.
export function visibleText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|svg|form|select|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|li|ul|ol|div|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return stripped
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function titleOf(html: string): string | null {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1].trim();
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t ? t[1].trim() : null;
}

// ─── Tier: the creator's own description ───
//
// This tier exists because the earlier conclusion was wrong. Captions being
// blocked was tested and confirmed; whether the PAGE held anything else was not
// checked, and "YouTube is metadata-only" got written down on the strength of one
// failed path. It is not: shortDescription in the watch page carried 2,358
// characters of real planning advice on the first Shorts link tried in anger.
//
// Not a transcript, and never presented as one. It is what the creator wrote
// about their own video, which for recipe, gear-list and how-to content is
// frequently where the actual substance lives.
function youtubeDescription(html: string): string | null {
  // JSON-escaped inside the page payload, so let JSON.parse do the unescaping —
  // a manual unicode_escape mangles UTF-8 into mojibake ("don\u2019t" became
  // "donâ€™t" when decoded by hand).
  const m = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  let text: string;
  try {
    text = JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
  // Strip the promotional furniture most channels append: subscribe pleas, long
  // hashtag blocks, bare link lists. What is left is the part worth extracting.
  const cleaned = text
    .split("\n")
    .filter((line) => {
      const l = line.trim().toLowerCase();
      if (!l) return false;
      if (/^#\S+(\s+#\S+)*$/.test(l)) return false;                 // hashtag-only line
      if (/^(subscribe|follow me|like and subscribe|my gear|shop|buy)\b/.test(l)) return false;
      if (/^https?:\/\/\S+$/.test(l)) return false;                  // bare url
      return true;
    })
    .join("\n")
    .trim();
  return cleaned.length >= 200 ? cleaned.slice(0, 20_000) : null;
}

// ─── Tier: free, official metadata for a link we cannot transcribe ───
async function oembed(canonical: string): Promise<{ title: string | null; author: string | null }> {
  const r = await get(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`, 12_000);
  if (!r) return { title: null, author: null };
  try {
    const j = (await r.json()) as { title?: string; author_name?: string };
    return { title: j.title ?? null, author: j.author_name ?? null };
  } catch {
    return { title: null, author: null };
  }
}

// ─── Tier: free transcript published alongside the episode ───
//
// The podcast namespace has a <podcast:transcript> tag. Coverage is real but
// wildly uneven — measured on two feeds: Changelog 777 of 1013 episodes (77%),
// Simplecast's feed 0 of 2959. That variance is exactly why the cascade needs a
// paid fallback rather than assuming the free tier covers everything.
export function findTranscriptUrl(feedXml: string, episodeUrl: string): string | null {
  const items = feedXml.match(/<item[ >][\s\S]*?<\/item>/gi) || [];
  const needle = episodeUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  for (const item of items) {
    if (!item.includes(needle)) continue;
    const t = item.match(/<podcast:transcript[^>]*url=["']([^"']+)["'][^>]*>/i);
    if (t) return t[1];
  }
  return null;
}

export async function fetchSource(r: Resolved, opts: { allowPaid?: boolean } = {}): Promise<SourceResult> {
  const trail: string[] = [];

  // ── YouTube: no transcript, but the description is often real content ──
  if (r.kind === "youtube") {
    trail.push("youtube: transcript endpoint returns empty for unauthenticated callers — not attempted");
    const meta = await oembed(r.canonical);
    const title = meta.title ? `${meta.title}${meta.author ? ` — ${meta.author}` : ""}` : null;

    const page = await get(r.canonical);
    if (page) {
      const desc = youtubeDescription(await page.text());
      if (desc) {
        trail.push(`yt_description: ${desc.length} chars of the creator's own description (free)`);
        return { tier: "yt_description", text: desc, title, costUsd: 0, trail };
      }
      trail.push("yt_description: description too short or absent");
    } else {
      trail.push("yt_description: watch page unreachable");
    }

    trail.push(title ? "oembed: title and channel only" : "oembed: no data");
    return {
      // Deliberately not a fake transcript. A title is not content, and putting
      // it in the text field would let the extractor treat it as one.
      tier: title ? "oembed_metadata" : "none",
      text: null,
      title,
      costUsd: 0,
      trail,
    };
  }

  // ── Page text: free, and the highest-yield tier for articles ──
  if (r.kind === "web" || r.kind === "podcast") {
    const res = await get(r.canonical);
    if (res) {
      const html = await res.text();
      const text = visibleText(html);
      const title = titleOf(html);
      // A short page is a paywall, a cookie interstitial or a JS shell. Calling
      // that a transcript would poison the extractor with a nav menu.
      if (text.length >= 600) {
        trail.push(`page_text: ${text.length} chars extracted (free)`);
        return { tier: "page_text", text: text.slice(0, 200_000), title, costUsd: 0, trail };
      }
      trail.push(`page_text: only ${text.length} chars — too thin to trust, falling through`);
    } else {
      trail.push("page_text: page unreachable");
    }
  }

  // ── Paid ASR: last resort, and only with explicit permission ──
  if (r.kind === "podcast") {
    if (!opts.allowPaid) {
      trail.push("paid_asr: available but not authorised for this run");
      return { tier: "none", text: null, title: null, costUsd: 0, trail };
    }
    trail.push("paid_asr: would transcribe audio via Deepgram Nova-3 batch");
    // Not wired yet — week 3 proves the free tiers and the accounting first.
    // Writing the paid call before the free path is measured is how a project
    // ends up paying for something it did not need.
    return { tier: "none", text: null, title: null, costUsd: 0, trail };
  }

  trail.push("no tier produced usable text");
  return { tier: "none", text: null, title: null, costUsd: 0, trail };
}

export function estimateAsrCost(durationMin: number): number {
  return Math.round(durationMin * DEEPGRAM_USD_PER_MIN * 10000) / 10000;
}
