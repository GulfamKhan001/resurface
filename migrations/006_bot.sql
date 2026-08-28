-- Bot access and per-user spend.
--
-- Built for the allowlist-of-one case but shaped for the multi-user case, because
-- the difference between them should be a row rather than a rewrite. If this ever
-- opens to friends, the only change is inserting more rows here.
create table if not exists bot_users (
  telegram_id  bigint primary key,
  handle       text not null,
  -- Daily ceiling on extraction spend for THIS person. Enforced from day one even
  -- for the owner: the failure being prevented is pasting 200 links by accident,
  -- which costs the same whoever does it.
  daily_usd_cap numeric(8,4) not null default 0.25,
  active       boolean not null default true,
  added_at     timestamptz not null default now()
);

-- Spend per user per day, so the cap is enforceable without scanning jobs.
create table if not exists bot_spend (
  telegram_id bigint not null references bot_users(telegram_id) on delete cascade,
  day         date not null,
  usd         numeric(10,6) not null default 0,
  links       int not null default 0,
  primary key (telegram_id, day)
);

-- Every inbound message, kept.
--
-- Telegram retries an update if the handler does not acknowledge quickly, so the
-- same message can arrive more than once. update_id as a unique key makes
-- reprocessing impossible rather than unlikely — the same reasoning as
-- side_effects.job_id in the queue.
create table if not exists bot_updates (
  update_id   bigint primary key,
  telegram_id bigint,
  text        text,
  handled_at  timestamptz not null default now(),
  outcome     text
);
