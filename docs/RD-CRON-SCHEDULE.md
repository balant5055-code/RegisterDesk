# RD-CRON-SCHEDULE — what runs, and how often

> **Corrected in RD-WALLET-W2.g (G11).** This file previously described an all-Vercel-Cron
> plan (RD-CRON-CLOSURE-01: "24 routes, 23 scheduled", per-route cadences such as every minute
> or every 5 minutes) that was **never shipped**. The real scheduler is GitHub Actions. Every
> schedule below is copied from the workflow files, and `tests/unit/cronScheduleDoc.test.ts`
> fails if this table and the workflows disagree. Setup, secrets and troubleshooting live in
> [GITHUB_CRON_SETUP.md](GITHUB_CRON_SETUP.md).

## Source of truth

- **`.github/workflows/cron-*.yml`** — four grouped workflows. Each step is
  `curl -X POST "$CRON_BASE_URL/api/cron/<route>"` with `Authorization: Bearer $CRON_SECRET`,
  `continue-on-error: true` and `--retry 2`. The steps of a group run **sequentially**, in the
  order listed.
- **`vercel.json`** is `{}` — it declares **no** crons. Never add one there for a route that a
  workflow already calls: every route must have exactly one scheduler.
- **35** cron routes exist under `app/api/cron/`; **all 35** are scheduled, each exactly once.

## Schedules (UTC)

GitHub Actions cron runs in **UTC**. Scheduled runs can start several minutes late under load;
treat every cadence as "at most this often".

| Workflow | Group | Schedule | Routes, in order |
|---|---|---|---|
| `cron-runners.yml` | A — queue runners | `*/5 * * * *` | `broadcasts`, `email-broadcasts`, `whatsapp-broadcasts`, `print-generation`, `print-packaging`, `certificate-jobs`, `certificate-email-jobs`, `registration-import`, `registration-bulk`, `report-exports`, `identifier-assign`, `timing-tags`, `media-jobs`, `ai-jobs`, `whatsapp-inbound`, `job-reaper` |
| `cron-recovery.yml` | B — financial recovery, retries, dispatch | `*/10 * * * *` | `registration-reconciliation`, `donation-reconciliation`, `wallet-reconciliation`, `badge-orders-reconcile`, `badge-rounds-reconcile`, `media-credit-reconciliation`, `media-credit-sessions`, `webhooks`, `reminders`, `review-deadlines`, `capacity-alerts`, `ops-alerts` |
| `cron-cleanup.yml` | C — cleanup | `0 * * * *` | `certificate-claims`, `whatsapp-templates` |
| `cron-maintenance.yml` | D — daily maintenance | `0 2 * * *` | `global-reconciliation`, `session-reconciliation`, `release-funds`, `storage-cleanup`, `print-runs-reconcile` |

`0 2 * * *` is 02:00 UTC = **07:30 IST**.

## Event review deadlines (RD-REVIEW-02)

- **`review-deadlines` — every 10 minutes** (Group B, after `reminders` and before `ops-alerts`,
  so the notices it stages are delivered by the same tick's outbox drain). After a Super Admin
  requests changes it sends the reminders (+12 h, +22 h), moves the event to **Action Required**
  when the first 24-hour deadline passes, sends a reminder 4 h before the second deadline, and
  closes the event (`lifecycleStatus: 'cancelled'` + `reviewClosure.source: 'deadline_expired'`)
  when the second 24-hour deadline passes. Every step is a status + review-cycle compare-and-set,
  so repeated or overlapping runs do nothing twice. It never moves money.
- A run may act up to ~10 minutes (more under GitHub load) after a deadline; the deadline itself
  is still exact, because resubmission and voluntary closure are refused by the server once it
  has passed, whether or not this job has run yet.
- It is scheduled only from the **default branch**: the step takes effect once this workflow
  change is merged to `master`. It uses the existing `CRON_BASE_URL` / `CRON_SECRET` secrets —
  no new secret, and it queries a single-field range (`reviewDeadlineNextAt <= now`), so no new
  Firestore index is needed.

## What the cadence means for money paths

- **`wallet-reconciliation` — every 10 minutes** (Group B). One run does three things, in order:
  the W2.a retry of recorded top-up credits, the W2.c stale top-up sweep (report mode unless
  `WALLET_TOPUP_SWEEP_MODE=enforce`), and the abandoned-order watch. A captured top-up whose
  credit failed is therefore retried within about 10 minutes (then on the W2.a backoff).
  Records the retry gives up on (`exhausted`), refusals (`needs_review`) and duplicate payments
  (`duplicate_payment`) are never retried by any cron — they wait for a Super Admin
  (Admin › Wallet Top-ups) and are counted on the Operations dashboard.
- **`registration-reconciliation`, `donation-reconciliation`, `media-credit-reconciliation`** —
  every 10 minutes, the same idempotent replay of a credit for a captured payment.
- **`release-funds`** — daily at 02:00 UTC (Group D), not hourly: an eligible release can wait up
  to a day after its hold expires.
- **`webhooks`** — every 10 minutes (Group B): a due webhook re-delivery waits up to ~10 minutes.
- **`ops-alerts`** — every 10 minutes, last in Group B, after the recovery jobs of the same tick.
- **`badge-orders-reconcile`** — every 10 minutes (Group B). ID-badge purchase checkouts expire 30
  minutes after creation; after a further 30-minute grace the sweep settles a captured payment the
  client and webhook missed (activated once, or held for review), expires an order Razorpay confirms
  unpaid, and leaves an authorised or unknown one for the next run. Captures on an order expired in
  the last 7 days are held, never activated. It never refunds.
- **`badge-rounds-reconcile`** — every 10 minutes (Group B), right after `badge-orders-reconcile`. Settles
  ID-badge billing rounds left open by a job that ended without settling them (crash, failed or
  cancelled job — including an Operations Center cancel whose settlement failed — or a deleted job).
  Its own 40-second budget and a saved cursor (`system/printBadgeRoundSweep`), so it does not depend
  on time left over in `print-generation`, whose inline sweep stays as a fast path. A round of a job
  that is still running is never settled, however old; such rounds are counted as `staleActive`.
  A round that fails to settle is retried first on the next run. It never charges or refunds.
- **`capacity-alerts`** — listed in Group B, but **held back since 2026-10-13**: its step runs only
  when the repository Actions variable `CAPACITY_ALERTS_ENABLED` is exactly `true`. Unset or any
  other value skips it on both scheduled and manual runs, so no capacity-threshold notification is
  sent until an owner sets that variable (Settings → Secrets and variables → Actions → Variables).

## Differences from the earlier (unshipped) plan

These are facts about the live schedule, recorded so nobody reads the old cadences as current.
Whether any of them should change is a separate decision.

| Route | Earlier plan | Actual |
|---|---|---|
| `broadcasts`, `webhooks` | every minute | every 5 min (A) / every 10 min (B) |
| the eight queue runners (`certificate-jobs`, `email-broadcasts`, …) | every 2 minutes | every 5 minutes (A) |
| `wallet-`, `donation-`, `registration-reconciliation`, `media-credit-reconciliation`, `media-credit-sessions`, `ops-alerts` | every 5 minutes | every 10 minutes (B) |
| `reminders` | every 15 minutes | every 10 minutes (B) |
| `release-funds` | hourly | daily 02:00 UTC (D) |
| `global-reconciliation`, `session-reconciliation` | 21:30 / 21:45 UTC, 15 min apart | 02:00 UTC, one after the other in one job (D) |
| `storage-cleanup` | 22:00 UTC | 02:00 UTC, last in D |
| `certificate-claims` | every 5 minutes ("well inside" its 15-minute claim TTL) | hourly (C) — not re-assessed here |
| `ai-jobs` | not scheduled | every 5 minutes (A) |
| `media-jobs` | every 10 minutes | every 5 minutes (A) |
| `capacity-alerts`, `certificate-email-jobs`, `identifier-assign`, `timing-tags`, `whatsapp-inbound`, `job-reaper` | (did not exist) | as in the table above |

## Overlap safety

- **One run per group at a time** — each workflow has its own `concurrency` group with
  `cancel-in-progress: false`, so a slow run delays the next tick instead of overlapping it, and
  the steps inside a run are sequential.
- **Idempotent routes** — the financial drainers replay exactly-once credits
  (`recordPlatformTransactionAndCredit`, `atomicTopupCredit`); the queue runners are lease- and
  cursor-fenced; deletes re-check age.
- **Bounded work** — each route caps its own work per call (`MAX_PER_RUN`, `LIMIT`, `budgetMs`,
  …) and resumes from a cursor. `curl --max-time` is 65 s, except the two 300-second daily
  reconciliations in Group D, which use 320 s.

## Not verifiable from the repository

Whether the workflows are enabled on GitHub, whether `CRON_SECRET` / `CRON_BASE_URL` are set, and
how late GitHub actually starts each scheduled run. Check the Actions tab and the Operations
dashboard's cron-health panel (`operationsMetrics`).
