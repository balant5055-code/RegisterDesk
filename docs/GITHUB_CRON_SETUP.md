# GitHub Actions Cron Scheduler — Setup

RegisterDesk's 20 background-processing endpoints under `/api/cron/*` are driven by
**GitHub Actions scheduled workflows**, not Vercel Cron. `vercel.json` keeps
`"crons": []` so GitHub is the **sole** scheduler (no double-firing).

The endpoints do all the work server-side and hold every downstream credential
(Firebase Admin, SES, Meta, Razorpay). GitHub only needs to **authenticate the
trigger** — so exactly two secrets are required.

---

## 1. Required GitHub Secrets

Set these under **Repo → Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value | Notes |
|---|---|---|
| `CRON_SECRET` | The bearer token for `/api/cron/*` | **Must equal** the app's `CRON_SECRET` env var in Vercel. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `CRON_BASE_URL` | Production origin, e.g. `https://registerdesk.in` | **No trailing slash.** The workflows POST to `$CRON_BASE_URL/api/cron/<name>`. |

No other secrets are needed by the workflows.

---

## 2. The workflows

Four workflows, one per cadence group. Each triggers its endpoints **sequentially**
(no parallel fan-out, no self-loop, no sleep), with per-step
`continue-on-error: true` so one endpoint's transient failure never blocks the rest.
Every curl uses `--retry 2 --retry-delay 5 --fail-with-body` (fails only after retries)
and a `--max-time` matched to the endpoint's server budget.

| File | Group | Schedule (UTC) | Endpoints (in order) | timeout | concurrency group |
|---|---|---|---|---|---|
| `.github/workflows/cron-runners.yml` | A | `*/5 * * * *` (every 5 min) | broadcasts → email-broadcasts → whatsapp-broadcasts → print-generation → print-packaging → certificate-jobs → registration-import → registration-bulk → report-exports | 12 min | `cron-runners` |
| `.github/workflows/cron-recovery.yml` | B | `*/10 * * * *` (every 10 min) | registration-reconciliation → donation-reconciliation → wallet-reconciliation → webhooks → reminders → ops-alerts | 10 min | `cron-recovery` |
| `.github/workflows/cron-cleanup.yml` | C | `0 * * * *` (hourly) | certificate-claims | 5 min | `cron-cleanup` |
| `.github/workflows/cron-maintenance.yml` | D | `0 2 * * *` (daily 02:00) | global-reconciliation → session-reconciliation → release-funds → storage-cleanup | 25 min | `cron-maintenance` |

All four set `cancel-in-progress: false` — a slow run is never cancelled; the next
scheduled run queues behind it. This is what guarantees the Group D reconcilers run
**single-instance**.

**Safety by construction:** all endpoints are idempotent, and the job runners are
lease + fencing-token protected (RD-OPS-GA-01), so GitHub's imprecise scheduling
(5-min floor, occasional delays) and any overlap can never double-execute.

**`--max-time` per endpoint:** 60s-budget endpoints use `--max-time 65`;
`global-reconciliation` and `session-reconciliation` (300s server budget,
`maxDuration=300`) use `--max-time 320`. A 65s client timeout on a 300s endpoint
would abort curl mid-run and retry into a **concurrent** reconciliation — forbidden
for those single-instance jobs — so the client timeout must exceed the server budget.

---

## 3. Setup steps

1. **Generate `CRON_SECRET`** (32 random bytes):
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Set it in Vercel**: Project → Settings → Environment Variables → `CRON_SECRET`
   (Production). Redeploy so the app picks it up.
3. **Add the two GitHub secrets** (`CRON_SECRET` identical to step 2, `CRON_BASE_URL`).
4. **Confirm `vercel.json`** still has `"crons": []` (GitHub is the only scheduler).
5. **Merge the four workflow files.** They activate on their schedules automatically.
   (GitHub only runs scheduled workflows from the **default branch**.)
6. **Confirm prerequisites are deployed**: the RD-OPS-GA-01 fencing token (overlap
   safety) and the RD-PERF-GA-01 Firestore indexes
   (`firebase deploy --only firestore:indexes`), so reconciliation/report queries
   don't throw.

---

## 4. Testing steps

- **Manual run:** every workflow has `workflow_dispatch`, so you can run it on demand
  from **Actions → (workflow) → Run workflow** without waiting for the schedule.
- **Auth smoke test** (from a shell with the secret):
  ```
  # Expect HTTP 200
  curl -i -X POST "$CRON_BASE_URL/api/cron/webhooks" -H "Authorization: Bearer $CRON_SECRET"

  # Expect HTTP 401 (fail-closed) — no/incorrect bearer
  curl -i -X POST "$CRON_BASE_URL/api/cron/webhooks"
  ```
- **Verify preflight:** temporarily unset a secret and dispatch a workflow — the
  "Preflight (secrets present)" step should fail with a clear `::error::` message.
- **Verify Group D single-instance:** dispatch `cron-maintenance` and confirm in the
  Actions log that a second dispatch queues (does not run concurrently) while the
  first is in progress.
- **Confirm the schedule fires:** after merging to the default branch, check the
  Actions tab shows scheduled runs at the expected cadence (allow a few minutes'
  slack — GitHub scheduled triggers are best-effort).

---

## 5. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Workflow step "Preflight" fails | A secret is missing/empty. Add `CRON_SECRET` / `CRON_BASE_URL`. |
| Every endpoint returns 401 | `CRON_SECRET` in GitHub ≠ the app's env value, or the app has no `CRON_SECRET` set (endpoints then fail closed by design). Re-sync both. |
| Curl "Could not resolve host" / connection errors | `CRON_BASE_URL` wrong or has a trailing slash / scheme missing. Use `https://<domain>` with no trailing slash. |
| A single endpoint step is red but the job is green | Expected: `continue-on-error: true` lets the rest run. Open the failed step's log for the response body (`--fail-with-body`). Authoritative **job-processing** failures surface via the app's `ops-alerts` cron + Sentry, not this scheduler. |
| Scheduled runs don't appear | Scheduled workflows run **only from the default branch**; ensure the files are merged there. GitHub may pause schedules on repos with no activity for 60 days. |
| Runs are late / skipped | GitHub scheduled triggers are best-effort (5-min floor, delays under load). Endpoints are idempotent, so a late/merged run just processes the next chunk. |
| `global-reconciliation` shows a curl timeout | It must use `--max-time 320`. A 65s timeout would abort + retry into a concurrent run — verify the maintenance workflow was not edited to 65s for those two steps. |
| Two maintenance runs overlapped | Check `concurrency.group: cron-maintenance` + `cancel-in-progress: false` are present. |

---

## 6. Production deployment checklist

- [ ] `CRON_SECRET` generated (32 bytes) and set **identically** in Vercel env and GitHub secret.
- [ ] `CRON_BASE_URL` GitHub secret = production origin, no trailing slash.
- [ ] `vercel.json` `crons` stays `[]` (GitHub is the sole scheduler).
- [ ] RD-OPS-GA-01 fencing token deployed (overlap/double-execution safety).
- [ ] RD-PERF-GA-01 Firestore indexes deployed (`firebase deploy --only firestore:indexes`).
- [ ] Four workflow files merged to the **default branch**.
- [ ] Auth smoke test passes: `200` with the bearer, `401` without.
- [ ] Each workflow dispatched manually once and inspected (all endpoints reached).
- [ ] Group D confirmed single-instance (second run queues, no overlap).
- [ ] `ops-alerts` delivery verified to reach operators; RD-OPS-GA-01 F7 (9 crons
      Sentry-blind for per-job failures) tracked so silent job failures surface.
- [ ] Firestore **native TTL policy** configured on `otpRequests` / `otpRateLimits`
      (RD-OPS-GA-01 F9 — no cleanup cron exists for these).
- [ ] First 24h of scheduled runs monitored in the Actions tab across all four cadences.
