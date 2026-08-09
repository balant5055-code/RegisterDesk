# RD-CRON-CLOSURE-01 — Scheduled job configuration

`vercel.json` is JSON and cannot carry comments, so the reasoning for every schedule
lives here. **Change the two together.**

24 cron routes exist. **23 are scheduled. One is deliberately not.**

## Prerequisites (not satisfied by this file alone)

| Requirement | Why |
|---|---|
| **Vercel Pro** (or above) | Hobby allows 2 cron jobs at daily granularity only, and caps `maxDuration` at 60s. `global-reconciliation` and `session-reconciliation` already declare `maxDuration = 300`, so the codebase assumes Pro regardless of this file. 23 jobs is within Pro's 40-cron limit. |
| **`CRON_SECRET` set in Production** | `lib/cron/auth.ts` throws at module init in real production when it is unset, so every `/api/cron/*` route fails closed. Vercel Cron sends it automatically as `Authorization: Bearer <CRON_SECRET>`. |
| **A deploy** | A schedule only exists once `vercel.json` ships. Editing this file locally changes nothing in production. |

## Timezone

Vercel Cron runs in **UTC**. Daily jobs are placed at 21:30–22:00 UTC = **03:00–03:30 IST**,
the low-traffic window for an India-first product.

## Schedules and their basis

Cadence is taken from the route's own documentation wherever it exists. Where it does not,
the basis is stated as *derived* — those are the tunable ones.

### Documented in the route

| Job | Schedule | Evidence |
|---|---|---|
| `broadcasts` | `* * * * *` | "Runs every minute." Bounded `MAX_PER_RUN = 25`; "the next minute picks up the rest". |
| `webhooks` | `* * * * *` | "Runs every minute. Processes due pending webhook deliveries (`nextRetryAt <= now`)". `MAX_PER_RUN = 50`. |
| `reminders` | `*/15 * * * *` | "Runs every 15 minutes." |
| `release-funds` | `0 * * * *` | "Hourly: … once the T+2 hold expires". Hourly is far finer than a T+2 hold needs, which is the point — it bounds the delay after eligibility. |
| `global-reconciliation` | `30 21 * * *` | "Daily platform-wide counter reconciliation." `maxDuration = 300`. |
| `session-reconciliation` | `45 21 * * *` | "Daily: rebuilds `eventSessions` counters." `maxDuration = 300`. Offset 15 min from the job above so two 300s runs never overlap. |

### Derived from design

| Job | Schedule | Basis |
|---|---|---|
| `certificate-jobs`, `email-broadcasts`, `whatsapp-broadcasts`, `registration-import`, `registration-bulk`, `report-exports`, `print-generation`, `print-packaging` | `*/2 * * * *` | All eight are the same shape: a drive-loop with `CRON_BUDGET_MS = 50_000` that yields and resumes — "next tick resumes the rest". The codebase's own precedent for advancing a queue promptly is every minute (`broadcasts`, `webhooks`). Halved to 2 minutes because eight of them share the tick budget. **Tunable**: raise to `* * * * *` if job start-latency matters more than invocation count. |
| `wallet-reconciliation`, `donation-reconciliation`, `registration-reconciliation` | `*/5 * * * *` | These are **money-recovery drainers**, not report-only checkers: each replays an idempotent credit for a captured payment whose post-commit wallet write failed. An organizer is *uncredited* until one runs, so the cadence is minutes, not days. |
| `media-credit-reconciliation` | `*/5 * * * *` | "Drains BOTH queues and reports orphans." `limit: 100`, `budgetMs: 45_000`. No-ops when `creditsEnabled` is false. |
| `media-credit-sessions` | `*/5 * * * *` | Upload-session reclamation. `LIMIT = 200`, `BUDGET_MS = 45_000`. Held credits stay reserved until it runs. |
| `certificate-claims` | `*/5 * * * *` | `CLAIM_TTL_MS = 15 * 60_000`. A sweep must run well inside the TTL; 5 min gives three passes per window. |
| `ops-alerts` | `*/5 * * * *` | Critical alert delivery, de-duped by `deliverCriticalAlerts`. Alerting is worthless if it lags. |
| `media-jobs` | `*/10 * * * *` | Media maintenance: drives open bulk batches, reclaims stranded uploads. The manual Maintenance page remains the operator override. |
| `storage-cleanup` | `0 22 * * *` | `RETENTION_MS = 7 days`, `MAX_PER_PREFIX = 500`. Deletes only regenerable transient artifacts; daily is ample against a 7-day window. |

## NOT scheduled

| Job | Why |
|---|---|
| `ai-jobs` | The route short-circuits before touching Firestore when no provider is configured, and says why: *"with no provider there is nothing a scan could usefully return, and a tick that reads the queue every minute to discover that would be pure cost."* No AI provider is implemented (RD-AI-01 ships the queue, dispatcher and interface — no vendor). Scheduling it would bill invocations to return `reason: 'no_provider'`. **Add `{ "path": "/api/cron/ai-jobs", "schedule": "*/2 * * * *" }` at the same time as the first provider.** |

## Overlap safety

Every scheduled job tolerates a second invocation arriving before the first finishes:

- **Status-guarded claims** — `broadcasts` transitions `scheduled→sending` under a guard;
  `certificate-jobs` documents that a concurrent claimant "returns" rather than double-runs.
- **Idempotent replay** — the three financial drainers replay `recordPlatformTransactionAndCredit`
  / `atomicTopupCredit`, which credit exactly once.
- **Age-rechecked deletes** — `certificate-claims` re-checks age transactionally per delete.
- **Bounded + cursor-resumed** — every job caps its own work (`MAX_PER_RUN`, `LIMIT`, `BATCH`,
  `budgetMs`) and resumes from a cursor rather than restarting.

The two 300-second daily jobs are the only ones where a genuine overlap would be expensive,
and they are deliberately offset by 15 minutes.
