-- Trace context, carried on the job row.
--
-- This is the cross-runtime propagation problem, and the shape of it is what
-- makes it worth doing. A normal distributed trace passes `traceparent` as an
-- HTTP header from caller to callee. Here the boundary is not a request — the
-- edge worker accepts a link, writes a row, and returns. Minutes later a
-- different process in a different runtime picks that row up. There is no header
-- to put anything in, and nothing is waiting for a response.
--
-- So the carrier is a column. Same W3C spec, same string, different transport:
-- the edge writes traceparent when it enqueues, and the worker parses it and
-- continues the same trace instead of starting a new one. Without this, a single
-- user action shows up in Grafana as two unrelated traces and the question
-- "where did the time go between saving and seeing results" is unanswerable.
alter table jobs add column if not exists traceparent text;

-- Cost per job is already recorded in extraction_spend. This is the same number
-- on the span, kept here so a job row can be read on its own without a join —
-- the digest and the CLI both want it and neither should need the spans.
alter table jobs add column if not exists cost_usd numeric(10,6) not null default 0;
