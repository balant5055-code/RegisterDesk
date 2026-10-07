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
- **30** cron routes exist under `app/api/cron/`; **all 30** are scheduled, each exactly once.

## Schedules (UTC)

GitHub Actions cron runs in **UTC**. Scheduled runs can start several minutes late under load;
treat every cadence as "at most this often".

| Workflow | Group | Schedule | Routes, in order |
|---|---|---|---|
| `cron-runners.yml` | A — queue runners | `*/5 * * * *` | `broadcasts`, `email-broadcasts`, `whatsapp-broadcasts`, `print-generation`, `print-packaging`, `certificate-jobs`, `certificate-email-jobs`, `registration-import`, `registration-bulk`, `report-exports`, `identifier-assign`, `timing-tags`, `media-jobs`, `ai-jobs`, `whatsapp-inbound`, `job-reaper` |
| `cron-recovery.yml` | B — financial recovery, retries, dispatch | `*/10 * * * *` | `registration-reconciliation`, `donation-reconciliation`, `wallet-reconciliation`, `media-credit-reconciliation`, `media-credit-sessions`, `webhooks`, `reminders`, `capacity-alerts`, `ops-alerts` |
| `cron-cleanup.yml` | C — cleanup | `0 * * * *` | `certificate-claims` |
| `cron-maintenance.yml` | D — daily maintenance | `0 2 * * *` | `global-reconciliation`, `session-reconciliation`, `release-funds`, `storage-cleanup` |

`0 2 * * *` is 02:00 UTC = **07:30 IST**.

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
