import { pool, tx } from "./db.ts";

// The queue. Postgres is the broker — there is no SQS, no Redis, no Kafka.
//
// That is a deliberate choice, not a shortcut: implementing leases, backoff and
// per-user fairness by hand is the thing being learned. A managed queue would
// hide every mechanism below behind a config flag.

export type JobKind = "transcribe" | "extract";

export interface Job {
  id: string;
  asset_id: string;
  kind: JobKind;
  attempts: number;
  max_attempts: number;
  fairness_user_id: string;
  lease_token: string;
}

const DEFAULT_LEASE_SECONDS = 30;

// ─── enqueue ───
//
// Returns the existing job when one is already in flight for this asset+kind,
// rather than creating a second one. This is singleflight, and it is enforced by
// the partial unique index rather than by checking-then-inserting — which would
// be a race with a window exactly as wide as the round trip.
export async function enqueue(
  assetId: string,
  kind: JobKind,
  fairnessUserId: string
): Promise<{ job: Job | null; coalesced: boolean }> {
  const { rows } = await pool.query<Job>(
    `insert into jobs (asset_id, kind, fairness_user_id)
     values ($1, $2, $3)
     on conflict (asset_id, kind) where state in ('queued','leased')
     do nothing
     returning id, asset_id, kind, attempts, max_attempts, fairness_user_id, lease_token`,
    [assetId, kind, fairnessUserId]
  );

  if (rows[0]) return { job: rows[0], coalesced: false };

  // DO NOTHING returns no row on conflict, so a caller who wants to attach as a
  // waiter needs the row that won. Not an error — the common path when several
  // people save the same video within seconds.
  const existing = await pool.query<Job>(
    `select id, asset_id, kind, attempts, max_attempts, fairness_user_id, lease_token
       from jobs
      where asset_id = $1 and kind = $2 and state in ('queued','leased')
      limit 1`,
    [assetId, kind]
  );
  return { job: existing.rows[0] ?? null, coalesced: true };
}

// ─── claim ───
//
// The centrepiece. One statement decides who runs next, and the ORDER BY is the
// entire anti-starvation mechanism: prefer the job whose owner currently has the
// fewest jobs in flight. One user pasting 200 links therefore cannot monopolise
// the workers, without any rate limiter, quota table or priority field.
//
// Two details that are easy to get wrong:
//
//   FOR UPDATE OF j  — not a bare FOR UPDATE. Postgres refuses to lock "the
//   nullable side of an outer join", and in_flight is LEFT JOINed, so a bare
//   FOR UPDATE fails at runtime with exactly that message.
//
//   SKIP LOCKED  — without it, ten workers serialise behind one row lock and the
//   queue's throughput collapses to one job at a time. With it, each worker takes
//   a different row and they never contend.
export async function claim(
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS
): Promise<Job | null> {
  return tx(async (c) => {
    const picked = await c.query<{ id: string }>(
      `with in_flight as (
         select fairness_user_id as uid, count(*) as n
           from jobs
          where state = 'leased' and lease_expires_at > now()
          group by 1
       )
       select j.id
         from jobs j
         left join in_flight f on f.uid = j.fairness_user_id
        where j.state = 'queued'
          and j.available_at <= now()
        order by coalesce(f.n, 0) asc, j.created_at asc
        for update of j skip locked
        limit 1`
    );
    if (!picked.rows[0]) return null;

    // A fresh lease_token per attempt. The previous holder's token is now stale,
    // which is what makes complete() safe.
    const leased = await c.query<Job>(
      `update jobs
          set state = 'leased',
              attempts = attempts + 1,
              lease_token = gen_random_uuid(),
              lease_expires_at = now() + ($2 || ' seconds')::interval,
              updated_at = now()
        where id = $1
        returning id, asset_id, kind, attempts, max_attempts, fairness_user_id, lease_token`,
      [picked.rows[0].id, String(leaseSeconds)]
    );

    const job = leased.rows[0];
    await c.query(
      `insert into job_runs (job_id, attempt, worker_id, lease_token)
       values ($1, $2, $3, $4)`,
      [job.id, job.attempts, workerId, job.lease_token]
    );
    return job;
  });
}

// ─── heartbeat ───
//
// Extends a lease, but only for the worker that still holds it. A worker doing
// genuinely long work must keep saying so; one that has stalled stops extending
// and is reclaimed. Returns false when the lease was already lost, which is the
// worker's signal to abandon its work rather than finish and try to commit.
export async function heartbeat(
  jobId: string,
  leaseToken: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update jobs
        set lease_expires_at = now() + ($3 || ' seconds')::interval,
            updated_at = now()
      where id = $1
        and lease_token = $2
        and state = 'leased'
        and lease_expires_at > now()`,
    [jobId, leaseToken, String(leaseSeconds)]
  );
  return rowCount === 1;
}

// ─── complete ───
//
// Fenced on lease ownership. A worker whose lease expired must NOT be able to
// complete, because the job has by then been reclaimed and possibly finished by
// someone else; letting the zombie write would overwrite a good result with a
// stale one.
//
// The side_effects insert and the state change are one transaction, so "the work
// took effect" and "the job is done" cannot disagree. side_effects has job_id as
// its primary key, so a second effect raises rather than duplicating — that
// violation is the property the chaos harness is looking for.
export async function complete(
  jobId: string,
  leaseToken: string,
  workerId: string,
  payload: unknown
): Promise<boolean> {
  return tx(async (c) => {
    const { rowCount } = await c.query(
      `update jobs
          set state = 'done', lease_token = null, lease_expires_at = null, updated_at = now()
        where id = $1
          and lease_token = $2
          and state = 'leased'
          and lease_expires_at > now()`,
      [jobId, leaseToken]
    );
    if (rowCount !== 1) {
      // Lost the race. Record the attempt so the log shows the zombie was
      // stopped here, then let the transaction commit that fact only.
      await c.query(
        `update job_runs set finished_at = now(), outcome = 'lost_lease'
          where job_id = $1 and lease_token = $2 and finished_at is null`,
        [jobId, leaseToken]
      );
      return false;
    }

    await c.query(
      `insert into side_effects (job_id, worker_id, lease_token, payload)
       values ($1, $2, $3, $4)
       on conflict (job_id) do nothing`,
      [jobId, workerId, leaseToken, JSON.stringify(payload ?? null)]
    );
    await c.query(
      `update job_runs set finished_at = now(), outcome = 'done'
        where job_id = $1 and lease_token = $2 and finished_at is null`,
      [jobId, leaseToken]
    );
    return true;
  });
}

// ─── fail ───
//
// Exponential backoff with jitter. The jitter matters: without it a batch of
// jobs that failed together retries together forever, hammering whatever is
// already broken in perfect lockstep.
//
// Past max_attempts a job goes to 'dead' rather than looping. A poison message
// that retries indefinitely is how a queue quietly stops making progress.
export async function fail(
  jobId: string,
  leaseToken: string,
  error: string
): Promise<"retry" | "dead" | "lost_lease"> {
  return tx(async (c) => {
    const { rows } = await c.query<{ attempts: number; max_attempts: number }>(
      `select attempts, max_attempts from jobs
        where id = $1 and lease_token = $2 and state = 'leased'`,
      [jobId, leaseToken]
    );
    if (!rows[0]) return "lost_lease";

    const dead = rows[0].attempts >= rows[0].max_attempts;
    const backoffSeconds = Math.min(2 ** rows[0].attempts, 300) * (0.5 + Math.random());

    await c.query(
      `update jobs
          set state = $3::job_state,
              last_error = $4,
              lease_token = null,
              lease_expires_at = null,
              available_at = case when $3 = 'queued'
                                  then now() + ($5 || ' seconds')::interval
                                  else available_at end,
              updated_at = now()
        where id = $1 and lease_token = $2`,
      [jobId, leaseToken, dead ? "dead" : "queued", error.slice(0, 500), String(backoffSeconds)]
    );
    await c.query(
      `update job_runs set finished_at = now(), outcome = 'error', error = $3
        where job_id = $1 and lease_token = $2 and finished_at is null`,
      [jobId, leaseToken, error.slice(0, 500)]
    );
    return dead ? "dead" : "retry";
  });
}

// ─── reclaim ───
//
// Crash recovery, and it needs no crash detection: a worker that died simply
// stops extending its lease, and once the lease expires the row is claimable
// again. There is no heartbeat table, no liveness service, no leader election.
//
// This is what makes SIGKILL survivable, which is the entire week-1 exercise.
export async function reclaimExpired(): Promise<number> {
  const { rowCount } = await pool.query(
    `update jobs
        set state = 'queued', lease_token = null, lease_expires_at = null, updated_at = now()
      where state = 'leased' and lease_expires_at <= now()`
  );
  return rowCount ?? 0;
}

export async function stats() {
  const { rows } = await pool.query(
    `select state, count(*)::int as n from jobs group by state order by state`
  );
  return rows as { state: string; n: number }[];
}
