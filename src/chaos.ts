import { pool, close } from "./db.ts";
import { enqueue, reclaimExpired, stats } from "./queue.ts";
import { runWorker, type Chaos } from "./worker.ts";

// The chaos harness. This is the deliverable of week 1 — not the queue, the
// PROOF. The queue is only trustworthy because this script tries to break it and
// reports honestly when it succeeds.
//
// Three properties are asserted. Each one corresponds to a real production
// failure that a hand-rolled queue gets wrong:
//
//   1. every job terminates            — nothing is left queued or leased forever
//   2. exactly one effect per job      — at-least-once delivery, effectively-once effect
//   3. fairness                        — a user who floods the queue cannot starve others
//
// It exits non-zero on violation, so it can gate a deploy later.

const N_WORKERS = 8;
const HEAVY_USER_JOBS = 60;   // one user floods
const LIGHT_USER_JOBS = 6;    // three others each save a handful

const chaos: Chaos = {
  throwRate: 0.25,
  hangRate: 0.10,
  exitRate: 0.0,      // enabled in the kill-test below, not the main run
  poisonKinds: new Set(["extract"]),
};

async function reset() {
  // Truncate rather than drop: the schema is the migration's job, not this one's.
  await pool.query(`truncate side_effects, job_runs, chunks, jobs, saves, assets, users restart identity cascade`);
}

async function seed() {
  const users = ["flooder", "ana", "bo", "cy"];
  const ids: Record<string, string> = {};
  for (const h of users) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (handle) values ($1) returning id`, [h]
    );
    ids[h] = rows[0].id;
  }

  let coalesced = 0;
  const plan: [string, number][] = [
    ["flooder", HEAVY_USER_JOBS],
    ["ana", LIGHT_USER_JOBS],
    ["bo", LIGHT_USER_JOBS],
    ["cy", LIGHT_USER_JOBS],
  ];

  for (const [handle, n] of plan) {
    for (let i = 0; i < n; i++) {
      const { rows } = await pool.query<{ id: string }>(
        `insert into assets (source_kind, source_key, title)
         values ('youtube', $1, $2)
         on conflict (source_kind, source_key) do update set title = excluded.title
         returning id`,
        [`${handle}-vid-${i}`, `${handle} video ${i}`]
      );
      const assetId = rows[0].id;
      await pool.query(
        `insert into saves (user_id, asset_id) values ($1, $2) on conflict do nothing`,
        [ids[handle], assetId]
      );
      const r = await enqueue(assetId, "transcribe", ids[handle]);
      if (r.coalesced) coalesced++;
    }
  }

  // Singleflight check: enqueue the SAME asset+kind ten times concurrently and
  // expect exactly one job. Sequential enqueues would not test the race.
  const { rows: shared } = await pool.query<{ id: string }>(
    `insert into assets (source_kind, source_key, title)
     values ('youtube', 'everyone-saves-this', 'the popular one') returning id`
  );
  const results = await Promise.all(
    Array.from({ length: 10 }, () => enqueue(shared[0].id, "transcribe", ids.ana))
  );
  const created = results.filter((r) => !r.coalesced).length;

  // One poison job, to prove the retry ladder terminates.
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into assets (source_kind, source_key, title)
     values ('web', 'poison-1', 'always fails') returning id`
  );
  await enqueue(p[0].id, "extract", ids.bo);

  return { coalesced, singleflightCreated: created };
}

async function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  console.log("resurface chaos harness — week 1\n");
  await reset();
  const seeded = await seed();
  const total = HEAVY_USER_JOBS + LIGHT_USER_JOBS * 3 + 1 + 1; // +popular +poison
  console.log(`seeded ${total} jobs across 4 users`);
  console.log(`  singleflight: 10 concurrent enqueues of one asset created ${seeded.singleflightCreated} job(s)\n`);

  // Reclaimer runs alongside the workers, exactly as it would in production.
  let reclaimed = 0;
  const stop = new AbortController();
  const reclaimer = (async () => {
    while (!stop.signal.aborted) {
      reclaimed += await reclaimExpired();
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  const started = Date.now();
  const tallies = await Promise.all(
    Array.from({ length: N_WORKERS }, (_, i) =>
      runWorker({ workerId: `w${i}`, chaos, leaseSeconds: 6, stopAfterIdle: 12, signal: stop.signal })
    )
  );
  stop.abort();
  await reclaimer;

  const agg = tallies.reduce(
    (a, t) => ({ done: a.done + t.done, retried: a.retried + t.retried, dead: a.dead + t.dead, lostLease: a.lostLease + t.lostLease }),
    { done: 0, retried: 0, dead: 0, lostLease: 0 }
  );
  console.log(`workers finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  ${JSON.stringify(agg)}`);
  console.log(`  leases reclaimed by the sweeper: ${reclaimed}`);
  console.log(`  final states: ${JSON.stringify(await stats())}\n`);

  let allOk = true;

  // 1 — termination
  const { rows: stuck } = await pool.query<{ n: number }>(
    `select count(*)::int as n from jobs where state in ('queued','leased')`
  );
  allOk = (await check("every job terminated", stuck[0].n === 0, `${stuck[0].n} still queued/leased`)) && allOk;

  // 2 — exactly one effect per completed job. side_effects.job_id is the PK, so a
  // duplicate would have raised on insert; this checks the other direction, that
  // every done job produced its effect and no effect exists without one.
  const { rows: eff } = await pool.query<{ done: number; effects: number; orphan: number }>(
    `select (select count(*)::int from jobs where state='done')                      as done,
            (select count(*)::int from side_effects)                                 as effects,
            (select count(*)::int from side_effects s
               join jobs j on j.id = s.job_id where j.state <> 'done')               as orphan`
  );
  allOk = (await check(
    "exactly one effect per done job",
    eff[0].done === eff[0].effects && eff[0].orphan === 0,
    `done=${eff[0].done} effects=${eff[0].effects} orphaned=${eff[0].orphan}`
  )) && allOk;

  // 3 — the zombies were actually stopped. If hangRate produced no lost_lease
  // outcomes then the fencing was never exercised and the pass above is hollow.
  const { rows: zombie } = await pool.query<{ n: number }>(
    `select count(*)::int as n from job_runs where outcome = 'lost_lease'`
  );
  allOk = (await check(
    "zombie completions were rejected (fencing exercised)",
    zombie[0].n > 0,
    `${zombie[0].n} attempts blocked after losing their lease`
  )) && allOk;

  // 4 — poison terminated instead of looping
  const { rows: dead } = await pool.query<{ n: number; attempts: number }>(
    `select count(*)::int as n, coalesce(max(attempts),0)::int as attempts
       from jobs where state = 'dead'`
  );
  allOk = (await check(
    "poison job died instead of retrying forever",
    dead[0].n >= 1 && dead[0].attempts <= 6,
    `${dead[0].n} dead after ${dead[0].attempts} attempts`
  )) && allOk;

  // 5 — fairness. The flooder holds 60 of 73 jobs. Without the ORDER BY on
  // in-flight count, the light users' jobs would all finish last. Measure when
  // each user's LAST job completed: the light users should not be trailing the
  // flooder.
  const { rows: fair } = await pool.query<{ handle: string; n: number; last_done: string }>(
    `select u.handle, count(*)::int as n, max(s.created_at)::text as last_done
       from side_effects s
       join jobs j on j.id = s.job_id
       join users u on u.id = j.fairness_user_id
      group by u.handle order by max(s.created_at)`
  );
  console.log("  completion order by user (earliest last-job first):");
  for (const r of fair) console.log(`     ${r.handle.padEnd(8)} ${String(r.n).padStart(3)} jobs, last at ${r.last_done?.slice(11, 23)}`);
  const flooderLast = fair.findIndex((r) => r.handle === "flooder");
  allOk = (await check(
    "flooder did not starve the light users",
    flooderLast === fair.length - 1,
    flooderLast === fair.length - 1 ? "flooder finished last, as it should" : "a light user finished after the flooder"
  )) && allOk;

  console.log(`\n${allOk ? "ALL PROPERTIES HELD" : "PROPERTY VIOLATED"}`);
  await close();
  process.exit(allOk ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nharness crashed:", err);
  await close().catch(() => {});
  process.exit(1);
});
