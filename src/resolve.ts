// What is this link?
//
// Runs before anything expensive. Its whole job is to turn a pasted URL into a
// content address — the pair (source_kind, source_key) that the assets table is
// unique on. Get this right and dedup is free; get it wrong and the same video
// saved twice becomes two assets, two jobs, two transcription bills.
//
// Pure functions, no network. That matters because resolve() runs on the edge
// worker, which has 10ms of CPU and cannot afford to fetch anything.

export type SourceKind = "youtube" | "podcast" | "web" | "upload";

export interface Resolved {
  kind: SourceKind;
  /** The content address. Same video from two different URLs → same key. */
  key: string;
  /** Cleaned URL worth storing and showing. */
  canonical: string;
  /** True when this kind can never yield a transcript — see the YouTube note. */
  metadataOnly?: boolean;
  note?: string;
}

// Tracking parameters that change the URL without changing the content. Left in,
// the same article shared from two places would dedup as two assets.
const JUNK_PARAMS = /^(utm_|fbclid|gclid|mc_|ref|ref_src|si|feature|igshid|spm|__twitter|_hs|yclid|msclkid)/i;

function stripJunk(u: URL): URL {
  for (const k of [...u.searchParams.keys()]) {
    if (JUNK_PARAMS.test(k)) u.searchParams.delete(k);
  }
  u.hash = "";
  // Trailing slash is not content.
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u;
}

const YT_HOSTS = /^(www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com)$/i;

function youtubeId(u: URL): string | null {
  if (u.hostname.toLowerCase() === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (!YT_HOSTS.test(u.hostname)) return null;
  const v = u.searchParams.get("v");
  if (v) return v;
  // /shorts/ID, /embed/ID, /live/ID all identify the same video as /watch?v=ID
  const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/);
  return m ? m[2] : null;
}

// Audio file extensions, for a direct-link episode.
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav|flac)($|\?)/i;

const PODCAST_HOSTS = /(podcasts?\.apple\.com|open\.spotify\.com\/(episode|show)|pca\.st|overcast\.fm|castbox|podbean|buzzsprout|libsyn|simplecast|transistor\.fm|megaphone\.fm|anchor\.fm|captivate\.fm|redcircle|fireside\.fm|changelog\.com)/i;

export function resolve(raw: string): Resolved {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error(`Not a URL: ${String(raw).slice(0, 80)}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`Unsupported scheme: ${u.protocol}`);
  u = stripJunk(u);

  const ytId = youtubeId(u);
  if (ytId) {
    return {
      kind: "youtube",
      // The video id, not the URL: youtu.be/X, /shorts/X and /watch?v=X are one asset.
      key: `yt:${ytId}`,
      canonical: `https://www.youtube.com/watch?v=${ytId}`,
      // YouTube closed unauthenticated caption access in 2026 — the transcript
      // endpoint answers 200 with an empty body, on every format. Scraping around
      // that needs a proof-of-origin token, which is the same category of
      // decision as scraping Instagram, and this project said no to that.
      //
      // So a YouTube link is saved and searchable by title via the official
      // oEmbed endpoint, and honestly marked as having no transcript. A visible
      // partial capability beats a broken one that looks complete.
      metadataOnly: true,
      note: "YouTube blocks unauthenticated transcripts; title and channel only",
    };
  }

  if (AUDIO_EXT.test(u.pathname) || AUDIO_EXT.test(u.search)) {
    return { kind: "podcast", key: `audio:${u.hostname}${u.pathname}`, canonical: u.toString() };
  }

  if (PODCAST_HOSTS.test(u.hostname) || PODCAST_HOSTS.test(u.toString())) {
    return { kind: "podcast", key: `pod:${u.hostname}${u.pathname}${u.search}`, canonical: u.toString() };
  }

  return { kind: "web", key: `web:${u.hostname}${u.pathname}${u.search}`, canonical: u.toString() };
}
