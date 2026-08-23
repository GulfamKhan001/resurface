-- Resurface — week 1 schema: the queue, and nothing else.
--
-- No AI, no transcription, no HTTP. Week 1's only job is a queue whose
-- properties survive workers being killed mid-flight. Everything here exists to
-- make one of those properties provable.

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ─── who and what ───

create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  handle     text not null unique,
  created_at timestamptz not null default now()
);

-- An asset is a thing in the world (one YouTube video), independent of how many
-- people saved it. `source_key` is the content address: the video id, or a hash
-- for uploads.
--
-- UNIQUE(source_kind, source_key) IS the dedup story. Ten users saving the same
-- video produce one row here, so one job, so one transcription bill.
create table if not exists assets (
  id          uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('youtube','rss','web','upload')),
  source_key  text not null,
  title       text,
  created_at  timestamptz not null default now(),
  unique (source_kind, source_key)
);

-- A save is one person's relationship to an asset. Re-pasting the same link is a
-- no-op rather than an error, which is why this constraint exists.
create table if not exists saves (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  asset_id   uuid not null references assets(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, asset_id)
);

-- ─── the queue ───

do $$ begin
  create type job_state as enum ('queued','leased','done','dead');
exception when duplicate_object then null; end $$;

-- jobs hangs off asset_id, NOT save_id. That single choice is what makes dedup
-- real: work is per-thing-in-the-world, not per-person-who-asked.
--
-- fairness_user_id is who to charge the work to for scheduling purposes — the
-- first saver. It is denormalised on purpose: the claim query orders by it and
-- must not join through saves on the hot path.
create table if not exists jobs (
  id               uuid primary key default gen_random_uuid(),
  asset_id         uuid not null references assets(id) on delete cascade,
  kind             text not null,
  state            job_state not null default 'queued',
  fairness_user_id uuid not null references users(id),

  attempts         int not null default 0,
  max_attempts     int not null default 5,

  -- available_at + lease_expires_at replace a scheduler entirely.
  --   backoff        = push available_at into the future
  --   crash recovery = an expired lease is claimable again, by anyone
  available_at     timestamptz not null default now(),
  lease_expires_at timestamptz,

  -- The fencing token. A worker proves it still owns the lease by presenting
  -- this. Without it, a worker that stalled past its lease could "complete" a
  -- job that another worker has already reclaimed and redone — the classic
  -- zombie-writer problem. Lease expiry alone does not prevent that, because the
  -- stalled worker's clock and the DB's clock are not the same clock.
  lease_token      uuid,

  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- In-flight coalescing, enforced by the database rather than remembered by code.
-- While a job for this asset+kind is queued or leased, a second enqueue cannot
-- create a duplicate. Once it reaches done/dead the index no longer covers it,
-- so the same asset can legitimately be re-processed later.
--
-- THIS is the feature that decided Postgres over MySQL. MySQL 8 has SKIP LOCKED,
-- but no partial indexes — the guarantee would have had to live in application
-- code, which is exactly where guarantees go to die.
create unique index if not exists jobs_inflight_uniq
  on jobs (asset_id, kind)
  where state in ('queued','leased');

-- Supports the claim query's WHERE. Partial, because claiming never looks at
-- done/dead rows and this table is expected to be mostly done/dead.
create index if not exists jobs_claimable_idx
  on jobs (available_at)
  where state = 'queued';

-- Supports the in_flight CTE that computes per-user fairness.
create index if not exists jobs_leased_by_user_idx
  on jobs (fairness_user_id, lease_expires_at)
  where state = 'leased';

-- ─── resumability ───

-- chunks is a TABLE, not a column on jobs. That is the whole point: a worker
-- that dies at chunk 7 of 12 resumes at 7 instead of re-spending on 1..6.
create table if not exists chunks (
  job_id     uuid not null references jobs(id) on delete cascade,
  idx        int  not null,
  state      text not null default 'pending' check (state in ('pending','done')),
  result     jsonb,
  updated_at timestamptz not null default now(),
  primary key (job_id, idx)
);

-- ─── proving the properties ───

-- At-least-once delivery means many ATTEMPTS but exactly one EFFECT. This table
-- is the effect. job_id as the PRIMARY KEY means a second completion of the same
-- job raises a unique violation instead of silently doing the work twice — the
-- chaos harness asserts on exactly this.
create table if not exists side_effects (
  job_id      uuid primary key references jobs(id) on delete cascade,
  worker_id   text not null,
  lease_token uuid not null,
  payload     jsonb,
  created_at  timestamptz not null default now()
);

-- Append-only attempt log. jobs.attempts is a counter and tells you nothing
-- about what happened; this is the audit trail the chaos report is built from.
create table if not exists job_runs (
  id          bigserial primary key,
  job_id      uuid not null references jobs(id) on delete cascade,
  attempt     int  not null,
  worker_id   text not null,
  lease_token uuid,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  outcome     text check (outcome in ('done','error','timeout','lost_lease')),
  error       text
);

create index if not exists job_runs_job_idx on job_runs (job_id, attempt);
