import { spawn } from "node:child_process";
import { pool, close } from "./db.ts";
import { enqueue, reclaimExpired, stats } from "./queue.ts";

// SIGKILL test — the one the in-process chaos harness cannot do honestly.
//
// chaos.ts runs workers as promises in one process, so "a worker died" is
// simulated. Here the workers are real child processes and they are killed with
// SIGKILL: no unwinding, no finally block, no chance to fail() politely, and the
// DB connection dies mid-transaction. The only thing that can recover the work
// is lease expiry.
//
// If this passes, "the worker crashed" is genuinely a non-event, which is the
// claim being made in week 1.

const WORKERS = 6;
const JOBS = 40;
const LEASE_SECONDS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seed() {
  await pool.query(`truncate side_effects, job_runs, chunks, jobs, saves, assets, users restart identity cascade`);
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (handle) values ('killtest') returning id`
  );
  const uid = rows[0].id;
  for (let i = 0; i < JOBS; i++) {
    const { rows: a } = await pool.query<{ id: string }>(
      `insert into assets (source_kind, source_key) values ('youtube', $1) returning id`,
      [`kill-${i}`]
    );
    await enqueue(a[0].id, "transcribe", uid);
  }
}

// A child that claims and processes jobs slowly, so there is always something
// in flight to interrupt.
const CHILD = `
import { runWorker } from "${new URL("./worker.ts", import.meta.url).pathname}";
await runWorker({
  workerId: process.argv[2],
  leaseSeconds: ${LEASE_SECONDS},
  stopAfterIdle: 1000,
  chaos: { throwRate: 0.05, hangRate: 0, exitRate: 0, poisonKinds: new Set() },
});
`;

async function main() {
  console.log("resurface SIGKILL test — real processes, kill -9 mid-job\n");
  await seed();
  console.log(`seeded ${JOBS} jobs, lease = ${LEASE_SECONDS}s`);

  const children = Array.from({ length: WORKERS }, (_, i) =>
    spawn(process.execPath, ["--input-type=module", "--eval", CHILD, `k${i}`], {
      stdio: ["ignore", "ignore", "inherit"],
      env: process.env,
    })
  );
  console.log(`spawned ${WORKERS} worker processes: ${children.map((c) => c.pid).join(", ")}`);

  // Let them get hold of some work, then start killing.
  await sleep(1500);
  let killed = 0;
  for (const c of children) {
    if (c.exitCode === null) {
      c.kill("SIGKILL");
      killed++;
      await sleep(300);
    }
  }
  console.log(`SIGKILLed ${killed} workers while they held leases`);

  const leasedAtKill = await pool.query<{ n: number }>(
    `select count(*)::int as n from jobs where state = 'leased'`
  );
  console.log(`  jobs stranded in 'leased' immediately after: ${leasedAtKill.rows[0].n}`);
  if (leasedAtKill.rows[0].n === 0) {
    console.log("  (nothing was in flight — increase JOBS or the pre-kill delay to make this meaningful)");
  }

  // Nothing but lease expiry can save these. Wait it out, sweeping as production would.
  console.log(`\nwaiting for leases to expire and the sweeper to reclaim...`);
  let reclaimed = 0;
  for (let i = 0; i < Math.ceil(LEASE_SECONDS) + 4; i++) {
    reclaimed += await reclaimExpired();
    await sleep(1000);
  }
  console.log(`  reclaimed ${reclaimed} expired lease(s)`);

  // Fresh, healthy workers drain the remainder.
  const { runWorker } = await import("./worker.ts");
  const survivors = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      runWorker({ workerId: `recover${i}`, leaseSeconds: LEASE_SECONDS, stopAfterIdle: 15 })
    )
  );
  const recovered = survivors.reduce((n, t) => n + t.done, 0);
  console.log(`  replacement workers completed ${recovered} job(s)\n`);

  const final = await stats();
  const { rows: eff } = await pool.query<{ effects: number; stuck: number }>(
    `select (select count(*)::int from side_effects) as effects,
            (select count(*)::int from jobs where state in ('queued','leased')) as stuck`
  );
  console.log(`final states: ${JSON.stringify(final)}`);

  const ok = eff[0].stuck === 0 && eff[0].effects === JOBS;
  console.log(`\n  ${ok ? "PASS" : "FAIL"}  no work lost to SIGKILL — ${eff[0].effects}/${JOBS} effects, ${eff[0].stuck} stuck`);
  if (!ok && eff[0].effects < JOBS) {
    // Being specific about which jobs vanished is the difference between a
    // useful failure and a mystery.
    const { rows: missing } = await pool.query<{ id: string; state: string; attempts: number; last_error: string }>(
      `select j.id, j.state::text, j.attempts, coalesce(j.last_error,'') as last_error
         from jobs j left join side_effects s on s.job_id = j.id
        where s.job_id is null limit 10`
    );
    console.log("  jobs with no effect:");
    for (const m of missing) console.log(`    ${m.id.slice(0, 8)} ${m.state} attempts=${m.attempts} ${m.last_error.slice(0, 60)}`);
  }

  await close();
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error("killtest crashed:", err);
  await close().catch(() => {});
  process.exit(1);
});
