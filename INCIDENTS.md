# Incidents

Every bug below happened while building this, and every one is still visible in the code as a comment or a guard. They are written up because the failures were more instructive than the features, and because a project that only reports its successes is not reporting.

They fall into five groups, and the groups turned out to matter more than the individual bugs.

---

## 1. Tests that passed while testing nothing

The most dangerous failure in the whole project, three times over. A test that passes because the dangerous path never executed is worse than no test, because it also tells you to stop looking.

### The SIGKILL test killed processes that were already dead

`kill-test` reported success. It was killing six workers that had died on their first claim.

`workerId` came from `process.argv[2]`, but under `node --eval` the positional arguments start at `argv[1]`. So `workerId` was `undefined`, `job_runs` rejected the `NOT NULL` on `worker_id`, and every child died immediately. The test's subject had never been alive.

**Fixed** by passing the id through the environment, where there is no index to get wrong — and, more importantly, by making the test **assert its own precondition**: it now polls until leases genuinely exist and fails loudly if they never do. It also kills all workers at once, because staggering by 300 ms let the survivors absorb the reclaimed work and softened the exact scenario under test.

### A tracing assertion that could not fail

```js
durations.every(d => d < LIMIT)   // → true when durations is []
```

It printed `PASS, max -Infinityms` while the collector had received zero spans. `Array.every` on an empty array is vacuously true; `Math.max()` of nothing is `-Infinity`, which is smaller than any limit.

**Generalises to:** any assertion over a collection needs a companion assertion that the collection is non-empty. `-Infinity` in a report is a tell that nothing was measured.

### Two eval assertions passed for the wrong reason

Fixtures used a one-character title, which the schema rejected before execution ever reached the field the case existed to test. Both cases were green; neither was testing anything.

---

## 2. Measurements that measured the wrong thing

### The eval scored the extractor for being correct

`trap avoidance` sat at 0.889 with the `negation` case failing: *"We tried Kubernetes and it was the wrong call — we ripped it out. What worked was boring old systemd."*

The extractor was right every time. It extracted **systemd** and never recommended Kubernetes — but its detail read *"an alternative to Kubernetes"*, and the trap check substring-matched title **and** detail. Accurate, useful context was being scored as a precision failure.

The check conflated two different questions:

- *Did it **recommend** this?* — must look at the **title**, because the title is the claim.
- *Did it **fabricate** this?* — must look at the **detail**, because that is where an invented fact lands (title `Refactoring`, detail *"by Martin Fowler, 1999"*).

**Fixed** by splitting `forbid` (anywhere — fabrication) from `forbidAsItem` (title only — recommendation). Trap avoidance went 0.889 → 1.0 **with the prompt unchanged**, which is precisely why the eval prints the prompt version next to the diff: a score that moves without the thing under test moving is a measurement change, and it should be impossible to report one as the other. The Kubernetes mention is still counted and printed as `detail mentions`, just not scored.

**Generalises to:** when a metric improves, the first question is whether the system changed or the ruler did.

### `metadata_only` recorded a prediction, not a result

The column was written from the resolver's *guess* that a link would be unreadable, not from whether text was actually retrieved. Once YouTube descriptions started working, an asset holding 1,740 usable characters was still flagged metadata-only — and every query filtering on that column would have silently skipped it.

**Fixed** by deriving it from the outcome, and re-stating it in the `ON CONFLICT` branch so an asset first seen under a weaker tier does not keep a stale flag once a better tier starts working.

### A stability score treated as a verdict

Self-agreement measured 1.0 on one run and 0.75 on the next, same prompt, same cases. The number is a sample of a non-deterministic process, and a single run of it is not a measurement.

---

## 3. Conclusions drawn from one data point

### "YouTube is metadata-only"

Measured and confirmed: YouTube answers unauthenticated caption requests with **HTTP 200 and an empty body** — not a 403 to route around, a successful-looking response containing nothing.

The measurement was right. The conclusion drawn from it was not. Captions being blocked says nothing about the rest of the page, and for five weeks YouTube links returned a bare title on the strength of one tested path. The watch page carries `shortDescription`: **1,740 characters** of real content on the first link tried in anger, yielding three grounded items for $0.0026.

**Generalises to:** "X is impossible" earned from one probe is a statement about the probe.

### Two misdiagnoses in a single session

- A `bot_updates` row with `outcome = NULL` was read as a crash that had permanently swallowed a message. It was an ingest **still in flight**; it completed normally. The write-up had already been drafted as an incident before the row was re-checked.
- `pgrep` reported no bot running. The pattern simply did not match `botrun.ts`. The process had been alive the entire time.

Both are recorded because the fix that came out of the first one — reclaiming stale claims — is still correct on inspection, and it would have been easy to justify it with an incident that never happened. The guard's comment says so explicitly.

---

## 4. Destructive and dishonest defaults

### The chaos harness truncated the live database

`reset()` ran `TRUNCATE … CASCADE` over `assets`, `jobs`, `chunks` and `items`, in whatever database `DATABASE_URL` pointed at — which is the real one, because there is only one. It destroyed **50 real extracted items** mid-session. The only reason the numbers in the README survived is that they had been copied out minutes earlier.

**Fixed** with a refusal: the harness counts real rows and exits non-zero unless `CHAOS_ALLOW_DESTRUCTIVE=1` is set. The proper fix is a separate database, and the comment says that too.

**Generalises to:** a destructive test that runs silently against production is a worse bug than anything the test is looking for.

### The safety valve and the assertion contradicted each other

`chaos` reported **PROPERTY VIOLATED — 1 job still queued** on a queue that had done nothing wrong.

Workers wait for jobs sitting in backoff rather than exiting — `hasPendingWork()`, itself the fix for an earlier incident. That wait is bounded by `drainTimeoutMs`, defaulting to **120 s**, so a genuinely wedged job cannot pin every worker forever. The run took **143 s**. The ceiling fired, workers exited, and one job in backoff was stranded.

Both mechanisms were correct. What was wrong was reporting a cut-short run and a stranded job as the same result.

**Fixed** by raising the ceiling above the observed runtime, and by adding a sixth outcome — **INCONCLUSIVE** — that still exits non-zero but says the property was untested rather than violated. A harness that cries wolf trains you to ignore it.

### Workers exited while a job sat in backoff

The first chaos run left the poison job at attempt 4 of 5, permanently unfinished. `runWorker` treated *"claim() returned null"* as *"the queue is drained"*, but `stopAfterIdle × 120 ms` is about 1.4 s of patience while the fourth backoff window is 8–24 s. Every worker quit during it.

**Generalises to:** "nothing claimable right now" is not "no work remains". The same mistake in production is an autoscaler that scales to zero on visible queue depth and never runs the retry.

---

## 5. The feature that was never built

The GIN full-text index on `items` was created in **migration 003**. Nothing ever queried it.

For five weeks this could ingest, extract, verify, chunk, resume, trace and bill for work — and the one sentence on the tin, *"makes it searchable"*, was the only part with no code behind it. The bot's own help text promised it. The infrastructure was more interesting to build than the feature.

Found by reading the README as a stranger would, in the week meant for shipping it.

Search now ranks by `ts_rank × trust`, because relevance alone puts the confident fabrications first.

---

## Smaller, sharper

- **`FOR UPDATE OF j`, not `FOR UPDATE`.** Postgres refuses to lock "the nullable side of an outer join" and the fairness CTE is `LEFT JOIN`ed. Without `OF j` the claim query does not run at all.
- **Checkpoints outlived their extractor.** The first real extraction reported `7/7 done, 0 items, $0 spent` — resuming against checkpoints written by a previous prompt. Migration 004 scopes them to `extractor_version`; a prompt change now invalidates them instead of silently skipping the work.
- **`ORDER BY rank * trust` does not compile.** Postgres accepts a bare output alias in `ORDER BY` but not that alias inside an expression. The ranking moved into a subquery — which also stops the tsvector being rebuilt twice per row.
- **The long poll aborted before it returned.** `getUpdates` asked Telegram to hold the connection 25 s while the fetch timed out at 20 s. Every idle cycle logged a timeout and reconnected. Messages still arrived, which is why it read as noise rather than a bug.
- **TypeScript parameter properties fail at runtime.** Node strips types; it does not *synthesise* code, and `constructor(private name: string)` is shorthand for an assignment that must be generated. It surfaces as `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — and `tsc` will not catch it, because it is valid TypeScript.
- **`tsc --noEmit | head -20` reports `head`'s exit code.** Two "typecheck passed" claims were false before this was noticed. Capture the output and test it for emptiness instead.
- **Commit messages were mangled by the shell.** Four commit bodies contain `/bin/zsh.0043` where `$0.0043` was written: an unquoted heredoc expanded `$0`. They are public and left uncorrected, because rewriting published history to hide a typo is a worse habit than the typo.
