# RegisterDesk — Operations Runbook

Covers **operational monitoring** (what is logged, where to look) and **disaster
recovery** (operator actions per dependency outage). For deployment prerequisites
see `LAUNCH_CHECKLIST.md`.

---

## Part A — Operational Monitoring

Every critical operation writes a durable record. To investigate an incident,
start from the collection listed here.

### A.1 What is logged

| Operation | Durable record (Firestore) | Idempotency / notes |
|-----------|----------------------------|---------------------|
| Registration created/confirmed | `registrations/{id}` (status, paymentStatus), `registrationCounters/{slug}` | Written in one transaction; deterministic ticket-code claim |
| Payment captured | `platformTransactions/{eventId}` (fee breakdown), `paymentIntents`/`paymentEvents` | Idempotency: intent `status==='paid'` re-read in txn; `ptx_<id>` ledger key |
| Registration refund | `walletTransactions` reversal, `refundWebhookEvents/{refundId}`, `failedRefunds` on error | Claim `paid→refund_pending` transactionally; per-`refundId` guard |
| Settlement release | `settlementReleases`, `settlementRequests`, `organizerRevenueWallets` | Re-reads `releaseStatus` in txn (exactly-once) |
| License purchase | `licenseOrders/lic_<eventId>`, immutable `licenseHistory` | Deterministic order id; payment amount/order verified vs persisted order |
| Admin actions (grant/suspend/approve/reject/moderate/refund/clawback/override) | `adminAuditLogs` via `logAdminAction` (who/when/entity/before/after/reason) | IP not captured |
| Certificate generated/downloaded | `certificates/{id}` (downloadCount, lastDownloadedAt) | Deterministic claim id `sha256(eventId|regId|type)` |
| Reminder dispatched | `scheduledReminders/{id}` (status→sent/partial/failed/skipped, counts), `emailLogs` | Status-guarded claim `scheduled→sending`; stale-`sending` reaper |
| Broadcast sent | `broadcastCampaigns`, `communicationUsage`, `emailLogs` | Wallet charged once at start (idempotent `broadcast_<id>` ledger) |
| Wallet debit/credit | `walletTransactions` ledger (deterministic ids: `topup_<order>`, `license_<event>`, `broadcast_<id>`) | All mutations in Firestore transactions |
| Donation | `donations`, `donationCounters`, `platformTransactions`, `paymentEvents/{id}` | Order-binding + `ptx_<donationId>` idempotency |
| Cron execution | `cronMetrics` via `recordCronExecution` (ok, detail, duration) | Every cron records success/failure |
| Suspicious payment | `suspiciousPayments` (expected vs actual amount/order/currency) | Written by `flagSuspiciousPayment` on any verify mismatch |
| Error telemetry | Sentry via `captureError` / `captureFinancialError` | Degrades to console.error if `SENTRY_DSN` unset |

### A.2 Dashboards to watch daily (first 2 weeks)

- **`suspiciousPayments`** — any doc = a payment failed integrity verification. Investigate immediately.
- **`failedRefunds`** — Razorpay refund API failures awaiting manual retry (`/admin/failed-refunds`).
- **`reconciliationReports`** — counter mismatches from the nightly reconcilers (auto-repaired for events/passes/campaigns/sessions; **report-only** for wallets — a wallet mismatch is a financial-integrity signal).
- **`cronMetrics`** — confirm all 20 crons ran; watch durations vs `maxDuration`.
- **`GET /api/health`** (GA-7E S1) — unauthenticated probe returning `status` (ok/degraded/error), build `version`, Firestore connectivity, and a cron-health summary (`tracked`/`failing`/`stale`). Point an external uptime monitor at it. 503 = Firestore unreachable; 200 with `status:"degraded"` = crons failing/stale.
- **Sentry** — money-path and cron errors.

### A.3 Alerts (now automated in-app — GA-7E S1)

The following now fire automatically via `evaluateAlerts()` → the `ops-alerts` cron → the notification pipeline; **critical** alerts also POST to `OPS_ALERT_WEBHOOK_URL` (a Slack Incoming Webhook / generic JSON / PagerDuty proxy) **independently of SES**, so a mail outage cannot suppress the page:

1. `suspiciousPayments` / `failedRefunds` → critical.
2. **Wallet mismatch** (`reconciliationReports` wallet rows — never auto-repaired) → **critical** (GA-7E S1: previously dashboard-only).
3. **Dead-cron staleness** (GA-7E S1: a cron whose last success is older than 2× its interval — i.e. it *stopped firing*) → critical for financial/reconciliation/webhook crons, warning otherwise. Previously invisible.
4. Recorded cron `ok:false` within 24h → critical.
5. Counter drift (event/pass/campaign/session) → warning. Sentry spikes on `/api/registrations/*`, `/api/webhooks/*` → configure in Sentry.

Set `OPS_ALERT_WEBHOOK_URL` (env) to route criticals to on-call. `branding.supportEmail` remains the secondary (email) channel.

---

## Part B — Disaster Recovery

Design principle: **money is never lost on a transient failure** — it is recorded
for reconciliation and completed exactly-once by a cron or webhook. Below are the
failure modes and the operator actions.

### B.1 Payment interruption (client crashes mid-payment)
- **Automatic:** Razorpay captures the payment; the `payment.captured` webhook
  (`/api/webhooks/razorpay`) reconstructs the registration + credits the organizer
  even if the client never returned. `registration-reconciliation` cron (every
  10 min) is the backstop.
- **Operator:** none normally. If a registration is missing but payment shows in
  Razorpay, confirm the webhook is registered (Checklist 2.5) and check
  `paymentEvents`/`cronMetrics`. License payments are the exception — see Known
  Issues in the final report (no license webhook backstop).

### B.2 Webhook retry (Razorpay retries a delivery)
- **Automatic:** every webhook handler is idempotent (event-claim docs:
  `paymentEvents/{id}`, `refundWebhookEvents/{refundId}`). Duplicate deliveries are
  no-ops. `/api/cron/webhooks` also drains any queued/failed webhook processing.
- **Operator:** none. To replay, re-send from the Razorpay dashboard — safe.

### B.3 Cron failure (a run errors or times out)
- **Automatic:** crons are idempotent and resume next tick. Reconciliation uses
  durable cursors (covers the full set across ticks). Reminder dispatch has a
  wall-clock budget + stale-`sending` reaper.
- **Operator:** check `cronMetrics` for the failing cron; read Sentry for the
  cause. Manually trigger by calling the cron URL with
  `Authorization: Bearer $CRON_SECRET`. If `CRON_SECRET` is unset, ALL crons fail
  closed — set it and redeploy.

### B.4 Firestore outage / degraded
- **Automatic:** reads fail-safe where designed (Business Config → code defaults;
  analytics degrade to empty, never 500 the page). Writes retry via Firestore SDK.
- **Operator:** monitor GCP status. No manual data entry — once Firestore
  recovers, reconciliation crons repair any counter drift. Do NOT bypass the
  transaction paths.

### B.5 SES outage (email sending fails)
- **Automatic:** email failures are logged to `emailLogs` (status `failed`) and
  **never block** registration/payment. SES send is single-attempt (no retry).
- **Operator:** confirm SES health + sandbox status. Bulk re-send is manual (there
  is no automatic email retry queue) — resend from the affected flow. Watch the
  suppression list once the SNS bounce endpoint is live.

### B.6 Meta / WhatsApp outage
- **Automatic:** WhatsApp is not wired for delivery yet, so no customer impact.
  When enabled, sends are best-effort and logged; failures don't block email.
- **Operator:** none pre-GA.

### B.7 Razorpay outage (payments unavailable)
- **Automatic:** order creation / checkout fails cleanly with a 502; no partial
  state is written. Wallet-covered flows (no gateway) still work.
- **Operator:** surface a status banner. When Razorpay recovers, in-flight
  captured payments reconcile via webhook/cron. Verify no `suspiciousPayments`
  accumulated.

### B.8 Redis (Upstash) outage
- **Automatic:** distributed rate-limits fail **closed** on the sensitive money
  paths (payment verify, OTP) — requests are rejected rather than un-throttled.
  Some public validators fail open by design.
- **Operator:** restore Upstash quickly — a prolonged outage blocks payment
  verification. Confirm `UPSTASH_*` env is correct.

### B.9 Storage (Firebase Storage) outage
- **Automatic:** certificate generation/upload throws and is retried by the
  certificate cron (bounded batches, resumable). Event/branding image reads may
  404 temporarily.
- **Operator:** monitor GCP Storage; certificate jobs resume automatically on
  recovery (idempotent claim ids prevent duplicates).

### B.10 Full recovery drill (quarterly)
1. Restore latest Firestore backup to a staging project.
2. Point staging env at it; run each cron once manually.
3. Verify `reconciliationReports` shows no unexpected wallet mismatches.
4. Confirm a test registration → payment → ticket email → certificate works.

### B.11 Firestore backup / PITR verification (GA-5 — MUST be confirmed before launch)
The application is stateless-recoverable (idempotent ledgers, reconciliation crons),
but the durable store of record is Firestore. Backups are a **GCP project setting**,
not application code — this repo cannot create them. Before go-live, an operator MUST
verify the following in the GCP console for the production project and record the date:

- [ ] **Point-in-Time Recovery (PITR) enabled** on the production Firestore database
      (Firestore → Backups/PITR). Confirms a rolling recovery window (default 7 days).
- [ ] **Scheduled backups configured** — a daily backup schedule with a retention that
      meets the business RPO (e.g. 14 days). (`gcloud firestore backups schedules create`.)
- [ ] **Storage bucket** (generated certificates / print assets / templates) has
      Object Versioning or a retention/lifecycle policy appropriate to the RPO.
- [ ] **Restore path tested** at least once (the B.10 drill) and the restore RTO recorded.
- [ ] **Composite indexes** deployed from `firestore.indexes.json` and finished building
      (a restore to a fresh project must re-deploy indexes before serving reads).

If PITR/scheduled backups are NOT enabled, treat it as a launch blocker: a data-loss
event would be unrecoverable regardless of the application's idempotency guarantees.
