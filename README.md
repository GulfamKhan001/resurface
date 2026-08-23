# Resurface

**It turns the stuff you save and never watch into something you can actually search.**

Forward a link — a YouTube video, a podcast, an article — and it transcribes it, works out what is actually inside it (a recipe, a workout, a book recommendation, a place), and stores that as structured, searchable data instead of another unread bookmark.

> **Status: week 1 of 10.** The queue and its chaos harness are built. Transcription is not wired up yet. See [the roadmap](#roadmap) for what is real and what is not.

---

## Why this is not a wrapper around an API call

Calling an LLM and rendering the response is CRUD with extra steps. The engineering here exists because the operation being wrapped is **slow** (minutes), **expensive** (real money per item), **non-deterministic** (same input, different output), and **fails halfway through**. CRUD is none of those things.

Five things follow from that, and they are the actual project:

| | |
|---|---|
| **Cost cascade** | Native captions (free) → RSS transcript (free) → paid ASR (last resort). A runtime choice between a free path and a paid one, with the cost recorded on the trace span. Measured ~3.5× cheaper than going straight to ASR. |
| **Content-addressed dedup** | Ten people saving one video produce one asset, one job, ten saves. A second request while a job is in flight attaches as a waiter instead of starting duplicate work — enforced by a partial unique index, not by check-then-insert. |
| **Resumability** | `chunks` is a table, not a column. A worker that dies at chunk 7 of 12 resumes at 7 and does not re-spend on 1–6. |
| **Fair queueing** | Leases, visibility timeouts, backpressure and per-user fairness. One person pasting 200 links cannot starve everyone else — expressed as `ORDER BY in_flight ASC`, with no rate limiter or quota table. |
| **Evals** | Golden set, schema-validated output, prompt-version regression runs, per-field confidence, user corrections fed back as new eval cases. |

---

## Architecture

```
forward a link  (Telegram bot / web)
      │
      ▼
  EDGE API — Cloudflare Workers      always-on, free, I/O only (10 ms CPU)
      │                              accept · enqueue · report status
      ▼
  POSTGRES IS THE QUEUE — Neon       SELECT … FOR UPDATE SKIP LOCKED
      │                              leases · fairness · partial unique index
      ▼
  WORKERS — Cloud Run                long-running, CPU-heavy, scales to zero
      │   resolve → source → transcribe → extract → verify → index
      ▼
  R2 (audio + transcripts)   ·   OpenTelemetry → Grafana Cloud
```

**Two runtimes on purpose.** Cloudflare Workers allows 10 ms of CPU per invocation — network waits do not count, so it can accept a request and write a row, but it physically cannot transcribe audio. That forces a split between an always-on front door and an expensive back room.

**Postgres is the broker.** No SQS, no Redis, no Kafka. Implementing leases, backoff and fairness by hand is the point; a managed queue hides every one of those mechanisms behind a config flag.

---

## The queue, in one query

```sql
WITH in_flight AS (
  SELECT fairness_user_id AS uid, COUNT(*) AS n FROM jobs
   WHERE state = 'leased' AND lease_expires_at > now() GROUP BY 1)
SELECT j.* FROM jobs j LEFT JOIN in_flight f ON f.uid = j.fairness_user_id
 WHERE j.state = 'queued' AND j.available_at <= now()
 ORDER BY COALESCE(f.n, 0) ASC, j.created_at ASC
   FOR UPDATE OF j SKIP LOCKED LIMIT 1;
```

`ORDER BY in_flight ASC` is the entire anti-starvation mechanism.

Two details that are easy to get wrong:

- **`FOR UPDATE OF j`**, not a bare `FOR UPDATE`. Postgres refuses to lock "the nullable side of an outer join", and `in_flight` is LEFT JOINed.
- **`SKIP LOCKED`.** Without it, ten workers serialise behind one row lock and throughput collapses to one job at a time.

### Three guarantees, and where they live

- **In-flight coalescing** — `UNIQUE(asset_id, kind) WHERE state IN ('queued','leased')`. A partial unique index, so the guarantee is in the database rather than remembered by application code. This is the single feature that decided Postgres over MySQL: MySQL 8 has `SKIP LOCKED`, but no partial indexes.
- **Exactly one effect** — `side_effects.job_id` is the primary key. At-least-once delivery means many *attempts* and one *effect*; a second completion raises instead of silently doing the work twice.
- **Crash recovery without crash detection** — a dead worker stops extending its lease, and any expired lease is claimable again. No heartbeat table, no liveness service, no leader election.

**Fencing.** `complete()` requires the worker's `lease_token` *and* an unexpired lease. Expiry alone is not enough: a stalled worker still believes it owns the job, and its clock is not the database's clock. Without the token, a zombie could overwrite a good result with a stale one.

---

## Running it

Requires **Node ≥ 22.18** (it runs TypeScript natively — no build step) and a free [Neon](https://neon.tech) Postgres project.

```bash
npm install
cp .env.example .env          # add your Neon *pooled* connection string
npm run migrate               # apply migrations/001_init.sql
npm run chaos                 # 8 workers, deliberate failures, 5 assertions
npm run kill-test             # real child processes, SIGKILL mid-job
```

### The chaos harness is the deliverable

Week 1 does **no real work on purpose**. The worker only sleeps, and fails in the four ways that actually break queues: it throws, it hangs past its lease, it hard-exits, and one job kind is poison and fails every time.

`npm run chaos` asserts, and exits non-zero on any violation:

1. every job terminates — nothing left `queued` or `leased`
2. exactly one effect per completed job
3. zombie completions were actually rejected — if zero were blocked, the fencing was never exercised and the run is hollow
4. the poison job reached `dead` instead of retrying forever
5. a user who floods the queue does not starve the others

`npm run kill-test` is the honest version: real child processes killed with `SIGKILL`, so nothing but lease expiry can recover the work.

---

## Roadmap

| Weeks | | Status |
|---|---|---|
| 1–2 | Queue, leases, fairness, chaos harness | code complete, not yet run against a database |
| 3–4 | Real pipeline: resolve → cost cascade → chunked transcription → extraction | not started |
| 5 | OpenTelemetry across edge and workers, cost as a span attribute | not started |
| 6 | Telegram bot, dedup and fairness under real load | not started |
| 7–8 | Evals: golden set, schema validation, prompt-version regression | not started |
| 9–10 | Ship publicly, and write up the incidents | not started |

Deliberately out of scope: Instagram and TikTok (terms-of-service hostile and actively blocked — same engineering, none of the legal cliff).

---

## Stack

TypeScript on Node 22 · Postgres (Neon) · Cloudflare Workers · Cloud Run · Cloudflare R2 · OpenTelemetry → Grafana Cloud · Claude for extraction · Deepgram for ASR fallback

Runs at **$0 when idle**, and around **$3/month** at a hundred items — the cascade is why.

## Licence

MIT
