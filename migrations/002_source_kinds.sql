-- Align the asset kinds with what resolve() actually produces.
--
-- 001 wrote 'rss', which names the transport. resolve() produces 'podcast',
-- which names the content — and the content is what matters here, because a
-- podcast episode reached through a page, a feed or a direct audio link is the
-- same kind of thing and should dedup as one asset.
--
-- Found by the check constraint rejecting the first real insert, which is the
-- constraint doing exactly what it is for: a mismatch between the schema's idea
-- of the world and the code's should fail loudly on the first row, not quietly
-- accumulate as bad data.

alter table assets drop constraint if exists assets_source_kind_check;

alter table assets
  add constraint assets_source_kind_check
  check (source_kind in ('youtube', 'podcast', 'web', 'upload'));

-- Nothing to migrate: no rows used 'rss'.
update assets set source_kind = 'podcast' where source_kind = 'rss';

-- Whether this asset can ever have a transcript.
--
-- YouTube closed unauthenticated caption access, so those assets are saved with
-- title and channel only. Recording that as a column rather than inferring it
-- from source_kind keeps the reason with the row: if YouTube ever reopens, the
-- flag flips without a schema change.
alter table assets add column if not exists metadata_only boolean not null default false;
alter table assets add column if not exists source_tier text;
alter table assets add column if not exists cost_usd numeric(10,5) not null default 0;
