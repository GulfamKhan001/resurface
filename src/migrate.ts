import { readdir, readFile } from "node:fs/promises";
import { pool, close } from "./db.ts";

// Migrations are plain .sql applied in filename order, recorded so they run once.
// No migration framework: one table and a loop is the whole feature, and it stays
// legible to anyone reading the repo.
async function main() {
  await pool.query(
    `create table if not exists _migrations (
       name text primary key, applied_at timestamptz not null default now())`
  );
  const dir = new URL("../migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await pool.query<{ name: string }>(`select name from _migrations`);
  const done = new Set(rows.map((r) => r.name));

  for (const f of files) {
    if (done.has(f)) { console.log(`  skip ${f}`); continue; }
    const sql = await readFile(new URL(f, dir), "utf8");
    await pool.query("begin");
    try {
      await pool.query(sql);
      await pool.query(`insert into _migrations (name) values ($1)`, [f]);
      await pool.query("commit");
      console.log(`  applied ${f}`);
    } catch (err) {
      await pool.query("rollback");
      throw new Error(`${f} failed: ${(err as Error).message}`);
    }
  }
  await close();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
