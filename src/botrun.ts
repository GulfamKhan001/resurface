import { poll } from "./bot.ts";
import { pool, close } from "./db.ts";

// npm run bot            -- start polling
// npm run bot -- --allow <telegram_id> <handle> [dailyUsdCap]
const args = process.argv.slice(2);

if (args[0] === "--allow") {
  const [, id, handle, cap] = args;
  if (!id || !handle) {
    console.error("usage: npm run bot -- --allow <telegram_id> <handle> [dailyUsdCap]");
    process.exit(1);
  }
  await pool.query(
    `insert into bot_users (telegram_id, handle, daily_usd_cap) values ($1,$2,$3)
     on conflict (telegram_id) do update set handle = excluded.handle, daily_usd_cap = excluded.daily_usd_cap, active = true`,
    [Number(id), handle, Number(cap) || 0.25]
  );
  const { rows } = await pool.query(`select telegram_id, handle, daily_usd_cap, active from bot_users order by added_at`);
  console.log("  allowlist:");
  for (const r of rows) console.log(`    ${r.telegram_id}  ${r.handle}  cap $${r.daily_usd_cap}  ${r.active ? "active" : "disabled"}`);
  await close();
} else {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is not set in .env — see the setup steps.");
    process.exit(1);
  }
  const { rows } = await pool.query(`select count(*)::int n from bot_users where active`);
  if (rows[0].n === 0) {
    console.error("No one is allowlisted. An open bot wired to a paid API is a bad idea.");
    console.error("  npm run bot -- --allow <your_telegram_id> <handle>");
    await close();
    process.exit(1);
  }
  await poll();
}
