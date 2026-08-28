import { pool } from "./db.ts";
import { resolve } from "./resolve.ts";
import { ingest } from "./pipeline.ts";
import { startSpan, flush } from "./trace.ts";

// The Telegram front door.
//
// Allowlisted to one person today, deliberately built so that opening it to
// friends is a row in bot_users rather than a rewrite. Everything that would be
// needed for multiple users — the per-user daily cap, the rate limit, the
// duplicate-update guard — is enforced from day one, because the failure they
// prevent is not "a stranger abuses this", it is "I paste 200 links by accident",
// and that costs the same whoever does it.
//
// A Telegram bot is PUBLIC by default. Anyone who finds the username can message
// it, and Telegram offers no auth layer to lean on, so the allowlist has to live
// here. An open bot wired to a paid API is someone else's budget to spend.

const MAX_LINKS_PER_HOUR = Number(process.env.BOT_MAX_LINKS_PER_HOUR) || 20;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number };
    text?: string;
  };
}

async function api(method: string, body: unknown): Promise<unknown> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

export async function reply(chatId: number, text: string): Promise<void> {
  // Never let a failed reply fail the ingest that already succeeded. The work is
  // done and stored; not being able to say so is a smaller problem.
  await api("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  }).catch((e) => console.error("[bot] reply failed:", (e as Error).message));
}

interface Allowed { telegram_id: string; handle: string; daily_usd_cap: string }

async function checkAccess(id: number): Promise<{ ok: true; user: Allowed } | { ok: false; why: string }> {
  const { rows } = await pool.query<Allowed>(
    `select telegram_id, handle, daily_usd_cap from bot_users where telegram_id = $1 and active`,
    [id]
  );
  if (!rows[0]) return { ok: false, why: "not_allowlisted" };

  const cap = Number(rows[0].daily_usd_cap);
  const { rows: s } = await pool.query<{ usd: string; links: number }>(
    `select usd, links from bot_spend where telegram_id = $1 and day = current_date`,
    [id]
  );
  const spent = Number(s[0]?.usd ?? 0);
  if (spent >= cap) return { ok: false, why: `daily_cap:${spent.toFixed(4)}/${cap}` };

  // Rate limit on links, separate from spend. A run that costs nothing (a
  // metadata-only YouTube link) still consumes attention and API calls.
  const { rows: h } = await pool.query<{ n: string }>(
    `select count(*) n from bot_updates where telegram_id = $1 and handled_at > now() - interval '1 hour' and outcome = 'ingested'`,
    [id]
  );
  if (Number(h[0]?.n ?? 0) >= MAX_LINKS_PER_HOUR) return { ok: false, why: "rate_limited" };

  return { ok: true, user: rows[0] };
}

async function chargeUser(id: number, usd: number): Promise<void> {
  await pool.query(
    `insert into bot_spend (telegram_id, day, usd, links) values ($1, current_date, $2, 1)
     on conflict (telegram_id, day) do update set usd = bot_spend.usd + excluded.usd, links = bot_spend.links + 1`,
    [id, usd]
  );
}

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function formatResult(r: Awaited<ReturnType<typeof ingest>>, itemLines: string[]): string {
  const head = r.tier === "oembed_metadata"
    ? `Saved, but <b>no transcript available</b>.\nYouTube blocks transcript access for unauthenticated callers, so this is findable by title only.`
    : `<b>${r.kept}</b> item${r.kept === 1 ? "" : "s"} from ${r.chars.toLocaleString()} characters`;

  const lines = [head];
  if (itemLines.length) lines.push("", ...itemLines);
  if (r.discarded) lines.push("", `<i>${r.discarded} discarded — quote not found in the source.</i>`);
  lines.push("", `<code>${r.tier} · ${r.chunks.done}/${r.chunks.total} chunks · $${r.spend.usd.toFixed(4)}</code>`);
  return lines.join("\n");
}

// Handle one update. Shared by both entry points — the poller that runs today and
// the webhook that will run once this is deployed — so the logic that matters
// cannot drift between them.
export async function handleUpdate(u: TelegramUpdate): Promise<string> {
  const msg = u.message;
  if (!msg?.from || !msg.text) return "ignored:no_text";

  // Telegram redelivers an update if the handler does not acknowledge fast
  // enough, so the same message genuinely arrives twice. update_id as a primary
  // key makes reprocessing impossible rather than unlikely — the same reasoning
  // as side_effects.job_id in the queue.
  const claimed = await pool.query(
    `insert into bot_updates (update_id, telegram_id, text) values ($1,$2,$3)
     on conflict (update_id) do nothing`,
    [u.update_id, msg.from.id, msg.text.slice(0, 500)]
  );
  if (claimed.rowCount === 0) return "ignored:duplicate";

  const finish = async (outcome: string) => {
    await pool.query(`update bot_updates set outcome = $2 where update_id = $1`, [u.update_id, outcome]);
    return outcome;
  };

  const access = await checkAccess(msg.from.id);
  if (!access.ok) {
    // Silence for strangers, an explanation for allowlisted users who hit a cap.
    // Telling an unknown sender that they are "not authorised" confirms the bot
    // is real and worth probing; saying nothing does not.
    if (access.why === "not_allowlisted") {
      console.log(`[bot] ignored message from ${msg.from.id} (${msg.from.username ?? "?"}) — not allowlisted`);
      return finish("ignored:not_allowlisted");
    }
    if (access.why.startsWith("daily_cap")) {
      const [, nums] = access.why.split(":");
      await reply(msg.chat.id, `Daily spend cap reached (<code>$${nums}</code>). Resets at midnight UTC.`);
    } else {
      await reply(msg.chat.id, `Slow down — ${MAX_LINKS_PER_HOUR} links an hour. Try again shortly.`);
    }
    return finish(`rejected:${access.why}`);
  }

  const text = msg.text.trim();
  if (text === "/start" || text === "/help") {
    await reply(msg.chat.id, [
      "<b>Resurface</b>",
      "",
      "Send me a link — an article, a podcast episode, a YouTube video — and I'll pull out what's actually in it and make it searchable.",
      "",
      "Every item is checked against the source before it's kept, so anything I can't find a real quote for gets thrown away rather than shown to you.",
      "",
      "<code>/stats</code> — what today has cost",
    ].join("\n"));
    return finish("help");
  }

  if (text === "/stats") {
    const { rows } = await pool.query<{ usd: string; links: number }>(
      `select coalesce(usd,0) usd, coalesce(links,0) links from bot_spend where telegram_id=$1 and day=current_date`,
      [msg.from.id]
    );
    const { rows: tot } = await pool.query<{ assets: string; items: string; usd: string }>(
      `select (select count(*) from assets) assets, (select count(*) from items) items,
              (select coalesce(round(sum(usd),4),0) from extraction_spend) usd`
    );
    await reply(msg.chat.id, [
      `<b>Today</b>: ${rows[0]?.links ?? 0} links · $${Number(rows[0]?.usd ?? 0).toFixed(4)} of $${access.user.daily_usd_cap}`,
      `<b>All time</b>: ${tot[0].assets} saved · ${tot[0].items} items · $${tot[0].usd}`,
    ].join("\n"));
    return finish("stats");
  }

  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (!url) {
    await reply(msg.chat.id, "Send me a link and I'll have a go at it.");
    return finish("ignored:no_url");
  }

  // Validate before acknowledging, so an unsupported link fails fast and cheap.
  try {
    resolve(url);
  } catch (e) {
    await reply(msg.chat.id, `I can't read that: ${esc((e as Error).message)}`);
    return finish("rejected:unresolvable");
  }

  // The trace starts HERE — this is the real edge of the system, and the span it
  // creates is the one the worker continues via jobs.traceparent.
  const span = startSpan("bot.receive", null, { "telegram.user": msg.from.id, "resurface.url": url });

  await reply(msg.chat.id, "Working on it…");
  try {
    const r = await ingest(url, access.user.handle, { parent: span.ctx });
    await chargeUser(msg.from.id, r.spend.usd);

    const { rows } = await pool.query<{ kind: string; title: string; trust: string }>(
      `select kind, title, trust from items where asset_id = $1 order by trust desc limit 10`,
      [r.assetId]
    );
    const lines = rows.map((i) => `• <b>${esc(i.title)}</b> <i>${i.kind}</i>`);
    await reply(msg.chat.id, formatResult(r, lines));

    span.set({ "items.kept": r.kept, "source.tier": r.tier }).cost(r.spend.usd).end();
    await flush();
    return finish("ingested");
  } catch (e) {
    span.fail(e).end();
    await flush();
    await reply(msg.chat.id, `That failed: ${esc((e as Error).message.slice(0, 200))}`);
    return finish("failed");
  }
}

// ─── entry point: long polling ───
//
// Polling rather than a webhook because nothing is deployed yet and a webhook
// needs a public HTTPS endpoint. handleUpdate is shared, so switching to a
// webhook later changes how updates arrive and nothing about what happens to
// them.
export async function poll(): Promise<void> {
  const me = (await api("getMe", {})) as { username: string };
  console.log(`[bot] @${me.username} polling — allowlist only`);

  let offset = 0;
  for (;;) {
    try {
      const updates = (await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] })) as TelegramUpdate[];
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        const outcome = await handleUpdate(u).catch((e) => `error:${(e as Error).message.slice(0, 60)}`);
        console.log(`[bot] update ${u.update_id} → ${outcome}`);
      }
    } catch (e) {
      // A polling failure is transient — network, Telegram hiccup. Back off and
      // carry on rather than exiting, or one blip ends the session.
      console.error("[bot] poll error:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
