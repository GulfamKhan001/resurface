import { claim, complete, fail, hasPendingWork, heartbeat, type Job } from "./queue.ts";

// A deliberately terrible worker.
//
// Week 1 does no real work on purpose. If the pipeline were real, a failing run
// could mean a bad prompt, a flaky transcription API, or a broken lease — and
// there would be no way to tell which. So this worker only sleeps, and it fails
// in the four ways that actually break queues in production:
//
//   throws         — ordinary error, should retry with backoff
//   hangs          — exceeds its lease without dying, becomes a zombie writer
//   dies silently  — process gone, lease must expire and be reclaimed
//   poison         — fails every single time, must end as 'dead' not loop forever
//
// The chaos harness turns these on and asserts the queue holds anyway.

export interface Chaos {
  throwRate: number;   // fraction of jobs that throw
  hangRate: number;    // fraction that outlive their lease
  exitRate: number;    // fraction that hard-exit the process
  poisonKinds: Set<string>;
}

export const NO_CHAOS: Chaos = { throwRate: 0, hangRate: 0, exitRate: 0, poisonKinds: new Set() };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function doWork(job: Job, chaos: Chaos, leaseSeconds: number) {
  // Poison jobs fail deterministically — the retry ladder must terminate.
  if (chaos.poisonKinds.has(job.kind)) throw new Error(`poison: ${job.kind} always fails`);

  if (Math.random() < chaos.exitRate) {
    // Hard kill mid-job: no rollback, no cleanup, no chance to fail() politely.
    // Nothing but lease expiry can recover this.
    process.exit(9);
  }

  if (Math.random() < chaos.hangRate) {
    // Sleep past the lease WITHOUT heartbeating. The job gets reclaimed and
    // redone elsewhere while this worker still believes it owns it — then it
    // wakes and tries to complete. That attempt must be rejected.
    await sleep((leaseSeconds + 2) * 1000);
    return { note: "zombie — completed after losing its lease" };
  }

  // Honest work: several short steps, heartbeating between them. A real
  // transcription would checkpoint into `chunks` here.
  for (let step = 0; step < 3; step++) {
    await sleep(80 + Math.random() * 120);
    const alive = await heartbeat(job.id, job.lease_token, leaseSeconds);
    if (!alive) throw new Error("lost lease mid-work");
  }

  if (Math.random() < chaos.throwRate) throw new Error("transient failure");
  return { note: "ok", attempts: job.attempts };
}

export async function runWorker(opts: {
  workerId: string;
  chaos?: Chaos;
  leaseSeconds?: number;
  stopAfterIdle?: number;   // consecutive TRULY-empty polls before exiting
  drainTimeoutMs?: number;  // hard ceiling on waiting for backoff to clear
  signal?: AbortSignal;
}) {
  const chaos = opts.chaos ?? NO_CHAOS;
  const leaseSeconds = opts.leaseSeconds ?? 6;
  const stopAfterIdle = opts.stopAfterIdle ?? 8;
  const drainTimeoutMs = opts.drainTimeoutMs ?? 120_000;
  let idle = 0;
  const startedAt = Date.now();
  const tally = { done: 0, retried: 0, dead: 0, lostLease: 0, waitedForBackoff: 0 };

  while (!opts.signal?.aborted && idle < stopAfterIdle) {
    const job = await claim(opts.workerId, leaseSeconds);
    if (!job) {
      // Nothing claimable — but that is not the same as nothing left to do. If
      // work is merely waiting on backoff (or held by a worker that might die),
      // keep waiting instead of counting this as idle and exiting.
      //
      // Bounded by drainTimeoutMs on purpose: without a ceiling, a genuinely
      // wedged job would keep every worker spinning forever, which is a worse
      // failure than exiting early.
      if (Date.now() - startedAt < drainTimeoutMs && (await hasPendingWork())) {
        tally.waitedForBackoff++;
        await sleep(400);
        continue;
      }
      idle++;
      await sleep(120);
      continue;
    }
    idle = 0;

    try {
      const payload = await doWork(job, chaos, leaseSeconds);
      const ok = await complete(job.id, job.lease_token, opts.workerId, payload);
      ok ? tally.done++ : tally.lostLease++;
    } catch (err) {
      const outcome = await fail(job.id, job.lease_token, (err as Error).message);
      if (outcome === "dead") tally.dead++;
      else if (outcome === "retry") tally.retried++;
      else tally.lostLease++;
    }
  }
  return tally;
}
