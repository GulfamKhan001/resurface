-- Extraction output, and what it cost.
--
-- items hangs off asset_id, not job_id, for the same reason jobs does: the
-- extraction describes the thing in the world, so ten people who saved that
-- video share one set of items rather than each getting a private copy.
create table if not exists items (
  id          uuid primary key default gen_random_uuid(),
  asset_id    uuid not null references assets(id) on delete cascade,
  kind        text not null check (kind in ('recipe','workout','book','place','tool','idea')),
  title       text not null,
  detail      text not null,
  quote       text not null,
  -- What the model said about itself. Kept for eval work, never used for ranking.
  model_confidence numeric(4,3),
  -- What the grounding check concluded. This is what ranking uses.
  grounding   text not null check (grounding in ('exact','fuzzy')),
  trust       numeric(4,3) not null,
  created_at  timestamptz not null default now(),
  -- The same item extracted twice from overlapping chunks must not become two
  -- rows. Title is normalised by the app before insert.
  unique (asset_id, kind, title)
);

create index if not exists items_asset_idx on items (asset_id);
create index if not exists items_search_idx on items using gin (to_tsvector('english', title || ' ' || detail));

-- Rejected extractions are kept, not dropped.
--
-- These are the eval set. An item the model invented, or returned in the wrong
-- shape, is the most useful training signal available for improving the prompt —
-- and it is only useful if it was written down at the moment it happened.
create table if not exists extraction_rejects (
  id         bigserial primary key,
  asset_id   uuid references assets(id) on delete cascade,
  job_id     uuid references jobs(id) on delete cascade,
  stage      text not null check (stage in ('schema','grounding')),
  reason     text not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists rejects_stage_idx on extraction_rejects (stage, created_at desc);

-- Money, per job.
create table if not exists extraction_spend (
  job_id     uuid primary key references jobs(id) on delete cascade,
  usd        numeric(10,6) not null default 0,
  calls      int not null default 0,
  in_tokens  bigint not null default 0,
  out_tokens bigint not null default 0,
  updated_at timestamptz not null default now()
);
