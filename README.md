# Resurface

**It turns the links you save and never open into something you can actually search.**

Send it a link — an article, a podcast episode, a YouTube video — and it works out what is actually inside (a recipe, a tool, a book, a place, an idea), checks every claim against the source, and stores it as structured data you can search. Anything it cannot find a real quote for is thrown away rather than shown to you.

> **Status:** weeks 1–10 complete. Runs locally against a live [Neon](https://neon.tech) Postgres and a Telegram bot allowlisted to one person. **Nothing is deployed to a cloud provider** — see [What is not built](#what-is-not-built), which is deliberately specific.

---

## Why this is not a wrapper around an API call

Calling an LLM and rendering the response is CRUD with extra steps. The engineering here exists because the operation being wrapped is **slow** (minutes), **expensive** (real money per item), **non-deterministic** (same input, different output), and **fails halfway through**. CRUD is none of those things.

| | |
|---|---|
| **Cost cascade** | Free page text → free podcast transcript → free video description → metadata → paid ASR. A runtime choice per item, with the cost recorded on the trace span. |
| **Content-addressed dedup** | Ten people saving one video produce one asset, one job, ten saves. Enforced by a partial unique index, not by check-then-insert. Verified: 10 concurrent enqueues created **1** job. |
| **Resumability** | `chunks` is a table, not a column. A worker that dies at chunk 7 of 12 resumes at 7 and does not re-spend on 1–6. Checkpoints are scoped to an extractor version, so a prompt change invalidates them. |
| **Fair queueing** | Leases, visibility timeouts, fencing and per-user fairness — `ORDER BY in_flight ASC`, no rate limiter, no quota table. |
| **Grounding** | Every item carries a verbatim quote that is checked against the source. Trust is computed from that evidence; the model's own confidence can only *lower* it, never raise it. |
| **Evals** | Hand-labelled golden set kept separate from a regression baseline, with recall, precision traps, self-agreement and hallucination rate. |

---

## Measured, not assumed

Every number here came from a run, on the date shown. Where something was not measured, it says so.

### The cost cascade (2026-08-30)

| Tier | Cost | Hit rate / result |
|---|---|---|
| `page_text` | free | martinfowler.com 1,801 chars · changelog.com **111,902** chars |
| `rss_transcript` | free | Changelog **777/1013** episodes (77%) · Simplecast **0/2959** (0%) |
| `yt_description` | free | 1,740 usable chars from a Shorts link after stripping promo lines |
| `oembed_metadata` | free | title and channel only — the honest fallback |
| `paid_asr` | $0.0043/min | **not wired.** Deepgram's published Nova-3 batch price, never exercised |

That **77% against 0%** on two podcast feeds is the entire argument for having a paid fallback at all, and it is the kind of number the original design could only guess at.

### End-to-end ingest (2026-08-30)

```
yt_description     1,740 chars    1 chunk    3 items kept   0 discarded   $0.0026
page_text          1,801 chars    1 chunk    2 items kept   0 discarded   $0.0022
page_text        111,902 chars   10 chunks  23 items kept   2 discarded   $0.0533
                                            ──────────────────────────────────────
                                            28 items · mean trust 0.913 · $0.0581
```

Those 2 discards are the grounding check rejecting items whose quote could not be found in the source. **Extrapolating a monthly bill from three items would be dishonest**, so: a 112k-character podcast episode costs about 5 cents to extract, and most things are an order of magnitude smaller.

### Evals (2026-08-30, prompt `p2-2026-08-28`)

```
recall            1      7/7 labelled items found
trap avoidance    1      9/9 traps avoided
hallucination     0%     ungrounded items, discarded before storage
detail mentions   1      a rejected thing named in a detail — context, not a recommendation
self-agreement    0.75   same input twice, 4 cases
cost              $0.0125 over 12 calls
```

`self-agreement` was **1.0** on the previous run of the same prompt. That is not a regression — it is the reminder that a stability score is itself a sample, and the reason no single eval run is treated as a verdict.

### Chaos and crash recovery (2026-08-30)

```
npm run chaos       80 jobs · 8 workers · 79 done, 1 dead (poison), 0 stranded
                    11 zombie completions blocked · flooder finished last · 119.3s
npm run kill-test   6 workers SIGKILLed holding 3 leases
                    4 leases reclaimed · 40/40 effects · 0 stuck
```

---

## Architecture

```
  send a link  →  Telegram bot (long polling, allowlisted)
                        │
                        ▼
        POSTGRES IS THE QUEUE — Neon        SELECT … FOR UPDATE SKIP LOCKED
                        │                   leases · fairness · partial unique index
                        ▼
        WORKER                              resolve → source cascade → chunk
                        │                   → extract → verify → store
                        ▼
        items + GIN full-text index         ← search, ranked by relevance × trust
```

**Postgres is the broker.** No SQS, no Redis, no Kafka. Implementing leases, backoff and fairness by hand is the point; a managed queue hides every one of those mechanisms behind a config flag.

### The queue, in one query

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

- **`FOR UPDATE OF j`**, not a bare `FOR UPDATE`. Postgres refuses to lock "the nullable side of an outer join", and `in_flight` is LEFT JOINed.
- **`SKIP LOCKED`.** Without it, ten workers serialise behind one row lock and throughput collapses to one job at a time.

### Three guarantees, and where they live

- **In-flight coalescing** — `UNIQUE(asset_id, kind) WHERE state IN ('queued','leased')`. A partial unique index, so the guarantee is in the database rather than remembered by application code. This is the single feature that decided Postgres over MySQL: MySQL 8 has `SKIP LOCKED`, but no partial indexes.
- **Exactly one effect** — `side_effects.job_id` is the primary key. At-least-once delivery means many *attempts* and one *effect*; a second completion raises instead of silently doing the work twice.
- **Crash recovery without crash detection** — a dead worker stops extending its lease, and any expired lease is claimable again. No heartbeat table, no liveness service, no leader election.

**Fencing.** `complete()` requires the worker's `lease_token` *and* an unexpired lease. Expiry alone is not enough: a stalled worker still believes it owns the job, and its clock is not the database's clock.

### Search ranks by relevance × trust

```sql
ORDER BY ts_rank(...) * greatest(trust, 0.01) DESC
```

Relevance alone ranks the confident fabrications first. A verified loose match beats a perfect match that failed grounding — on real data, an item scoring 0.1065 relevance at 0.98 trust correctly outranks one scoring 0.1258 at 0.58.

---

## Running it

Requires **Node ≥ 22.18** — it runs TypeScript natively, no build step — and a free Neon Postgres project.

```bash
npm install
cp .env.example .env     # Neon *pooled* connection string, ANTHROPIC_API_KEY
npm run migrate
npm run eval             # golden set + regression baseline  (~$0.013)
npm run chaos            # 8 workers, deliberate failures, 5 asserted properties
npm run kill-test        # real child processes, SIGKILL mid-job
npm run bot              # Telegram front door (allowlist required)
```

> `npm run chaos` **truncates** assets, jobs, chunks and items. It refuses to run against a database holding real extracted rows unless you set `CHAOS_ALLOW_DESTRUCTIVE=1`. That guard exists because it once ate 50 real items mid-session — see [INCIDENTS.md](INCIDENTS.md).

### The chaos harness asserts, and exits non-zero

1. every job terminates — nothing left `queued` or `leased`
2. exactly one effect per completed job
3. zombie completions were actually rejected — if zero were blocked, fencing was never exercised and the run is hollow
4. the poison job reached `dead` instead of retrying forever
5. a user who floods the queue does not starve the others

A sixth outcome exists: **INCONCLUSIVE**, when the drain ceiling fires before the queue empties. That is a cut-short run, not a queue failure, and conflating the two made the harness cry wolf once already.

---

## What is not built

Stated plainly, because a diagram that shows aspirations as boxes is a lie told in ASCII.

- **No Cloudflare Workers edge tier.** `resolve()` is pure and network-free so it *can* run in a 10 ms CPU budget, and the tracer is hand-rolled against W3C Trace Context and OTLP/HTTP+JSON specifically so it runs where `AsyncLocalStorage` does not exist. Neither has been deployed.
- **No paid ASR.** The cascade has the tier and the price; nothing calls Deepgram. Every cost number here is Claude extraction only.
- **No object storage.** No audio or transcripts are retained.
- **No Grafana Cloud.** Tracing is verified against a local OTLP receiver on `:4318` — 9 spans, one trace id, single root, `worker.process` a child of `edge.accept` across a simulated queue boundary — and asserted against what the collector actually received, not what the code intended to send. It has never pointed at a hosted backend.
- **No web UI.** Telegram is the only front door.
- **One user.** Multi-user fairness is exercised by the chaos harness's flooder, not by real contention.

Deliberately out of scope: Instagram and TikTok (terms-of-service hostile and actively blocked), and YouTube captions, which need a proof-of-origin token — the same category of decision, declined for the same reason.

---

## Roadmap

| Weeks | | Status |
|---|---|---|
| 1–2 | Queue, leases, fairness, chaos harness | done, verified against a live database |
| 3 | Resolve, cost cascade, resumable chunking | done |
| 4 | Extraction, schema validation, grounding | done |
| 5 | OpenTelemetry across the queue boundary, cost on spans | done, local collector only |
| 6 | Telegram bot, caps, allowlist | done, one user |
| 7–8 | Evals: golden set, regression baseline, stability | done |
| 9–10 | Search, and write up the incidents | done — [INCIDENTS.md](INCIDENTS.md) |

---

## Stack

TypeScript on Node 22 (no build step) · Postgres (Neon) · Claude Haiku 4.5 for extraction · hand-rolled W3C Trace Context + OTLP · Telegram

Single runtime dependency: `pg`. The Anthropic call is one `fetch`; the tracer is ~200 lines against two specs. Both were owned rather than imported because the dependency cost more than the code.

## Licence

MIT
