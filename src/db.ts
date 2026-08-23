import pg from "pg";

// Neon over the wire — nothing is installed locally. An earlier attempt to
// `brew install postgresql` was rightly rejected: a hosted free Postgres gives
// real concurrent connections, which is what the queue needs to be tested
// honestly, and leaves the Mac alone.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "DATABASE_URL is not set.\n" +
      "  1. create a free project at https://neon.tech\n" +
      "  2. copy the pooled connection string (it contains '-pooler')\n" +
      "  3. put it in /Users/Me/resurface/.env as DATABASE_URL=postgresql://...\n"
  );
  process.exit(1);
}

export const pool = new pg.Pool({
  connectionString,
  // The chaos harness runs a dozen workers at once and each wants its own
  // connection; Neon's free tier allows far more than this through the pooler.
  max: 16,
  // A worker that hangs must not also hang the pool it borrowed from.
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  // A pool-level error is not a reason to take the process down — a single dead
  // backend connection is normal under the SIGKILL testing this project does.
  console.error("[pool]", err.message);
});

// Run fn inside a transaction, rolling back on throw. Every queue operation that
// touches more than one row goes through here, because "the work took effect"
// and "the job is marked done" must never be separately observable.
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    try {
      await c.query("rollback");
    } catch {
      // The connection is already gone — the rollback is implicit.
    }
    throw err;
  } finally {
    c.release();
  }
}

export async function close() {
  await pool.end();
}
