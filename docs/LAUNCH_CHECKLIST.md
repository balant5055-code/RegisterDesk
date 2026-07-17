# RegisterDesk — Production Launch Checklist

Single source of truth for taking RegisterDesk live. Every item must be **green**
before General Availability. Grouped by dependency. Owner column is the team
responsible.

Legend: ⛔ blocks launch · ⚠️ required before scaling · ✅ verify

---

## 1. Firebase (Auth + Firestore + Storage)

| # | Item | Sev | Owner |
|---|------|-----|-------|
| 1.1 | Firebase project created; service-account key generated and base64-encoded into `FIREBASE_SERVICE_ACCOUNT_KEY` | ⛔ | Platform |
| 1.2 | `NEXT_PUBLIC_FIREBASE_*` web config set (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId) | ⛔ | Platform |
| 1.3 | **Authentication** → Email/Password provider enabled; email-verification (OTP) flow tested end-to-end | ⛔ | Platform |
| 1.4 | **Firestore rules deployed** (`firebase deploy --only firestore:rules`) — default-deny; all financial/PII collections server-only | ⛔ | Platform |
| 1.5 | **Firestore indexes deployed** (`firebase deploy --only firestore:indexes`) — includes `scheduledReminders(status,sendAt)` and `registrations(eventSlug,status)` added for the reminder engine | ⛔ | Platform |
| 1.6 | **Storage rules deployed** (`firebase deploy --only storage`) — owner-scoped writes, size + content-type limits, wildcard deny | ⛔ | Platform |
| 1.7 | Storage bucket `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` set (needed for certificate uploads) | ⚠️ | Platform |
| 1.8 | Firestore in **production mode** (not test mode); location chosen close to `ap-south-1` | ⛔ | Platform |

> **Index note:** reminders will NOT dispatch until 1.5 is deployed — the dispatch
> query throws `FAILED_PRECONDITION` without the composite index.
>
> **Deploy shortcut (GA-7E S1):** items 1.4–1.6 run together via `npm run deploy:firebase`
> (`firebase deploy --only firestore:rules,firestore:indexes,storage`). These artifacts
> deploy SEPARATELY from the Vercel code deploy — run this on **every** release that
> changes `firestore.rules`, `firestore.indexes.json`, or `storage.rules`, and again on
> any code rollback so rules/indexes never drift ahead of the code.

## 2. Razorpay (Payments)

| # | Item | Sev | Owner |
|---|------|-----|-------|
| 2.1 | `RAZORPAY_KEY_ID` is a **live** key (`rzp_live_*`) — startup refuses test keys in production | ⛔ | Finance |
| 2.2 | `RAZORPAY_KEY_SECRET` set (server-only) | ⛔ | Finance |
| 2.3 | `RAZORPAY_WEBHOOK_SECRET` set | ⛔ | Finance |
| 2.4 | `NEXT_PUBLIC_RAZORPAY_KEY_ID` set (client checkout) — **silent checkout failure if missing** | ⛔ | Finance |
| 2.5 | **BOTH webhook URLs registered** in Razorpay dashboard with the same secret: `/api/webhooks/razorpay` (registration + wallet top-up + registration refund) AND `/api/razorpay/webhook` (donations) | ⛔ | Finance |
| 2.6 | Webhook events subscribed: `payment.captured`, `payment.failed`, `refund.processed` | ⛔ | Finance |
| 2.7 | Settlement/payout bank details configured in Razorpay | ⚠️ | Finance |

> **Two-webhook note:** missing either URL silently disables crash-recovery
> reconciliation for that money type. Both are required.

## 3. Amazon SES (Email)

| # | Item | Sev | Owner |
|---|------|-----|-------|
| 3.1 | Sending domain verified + DKIM configured | ⛔ | Comms |
| 3.2 | Moved out of **SES sandbox** (production sending access) | ⛔ | Comms |
| 3.3 | `SES_FROM_EMAIL` set — **when blank, ALL email is silently disabled** (registrations still succeed, but no tickets/receipts/OTP) | ⛔ | Comms |
| 3.4 | `AWS_REGION` (default `ap-south-1`), and either both `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY` OR an attached IAM role | ⛔ | Comms |
| 3.5 | `SES_FROM_NAME` set (default `RegisterDesk`) | ✅ | Comms |
| 3.6 | **Bounce/complaint handling** — see Known Gap below | ⚠️ | Comms |

> **Known gap (track before scaling volume):** the delivery webhook
> (`/api/webhooks/resend`) parses Resend/Svix events, but SES emits bounces via
> **SNS**. Stand up an SNS endpoint feeding `addToSuppressionList`, or the
> suppression list won't populate → SES reputation risk. `RESEND_WEBHOOK_SECRET`
> gates the existing webhook.

## 4. Meta WhatsApp (optional channel)

| # | Item | Sev | Owner |
|---|------|-----|-------|
| 4.1 | All-or-nothing: `META_APP_ID`, `META_APP_SECRET`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_BUSINESS_ACCOUNT_ID`, `META_WEBHOOK_VERIFY_TOKEN` (partial config = startup fail) | ⚠️ | Comms |
| 4.2 | WhatsApp templates approved in Meta Business Manager | ⚠️ | Comms |
| 4.3 | **Awareness:** WhatsApp is foundation-only — no message is routed to WhatsApp yet. Do NOT advertise WhatsApp delivery until wiring is complete. Leave all `META_*` unset to keep the channel disabled. | ✅ | Comms |

## 5. Upstash Redis (rate limiting)

| # | Item | Sev | Owner |
|---|------|-----|-------|
| 5.1 | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set — **mandatory in true production** (startup fails without them) | ⛔ | Platform |
| 5.2 | Verify distributed rate-limits active on payment verify, OTP, order create | ✅ | Platform |

## 6. Vercel Cron

| # | Item | Sev | Owner |
|---|------|-----|-------|
| 6.1 | Deployed on **Vercel Pro** — the 20 crons include per-minute schedules Hobby cannot run | ⛔ | Platform |
| 6.2 | `CRON_SECRET` set — **mandatory in true production**; without it every cron fails closed and all background processing stops (reconciliation, webhooks, broadcasts, reminders, fund release, certificates) | ⛔ | Platform |
| 6.3 | All 20 crons present in `vercel.json` and firing (check `cronMetrics` / `/api/health` / logs) | ⛔ | Platform |
| 6.4 | `OPS_ALERT_WEBHOOK_URL` set (Slack/PagerDuty proxy) so critical ops alerts page on-call independently of email (GA-7E S1) | ⚠️ | Platform |
| 6.5 | External uptime monitor pointed at **`GET /api/health`** (GA-7E S1) | ⚠️ | Platform |

## 7. Secrets / HMAC

| # | Item | Sev | Owner |
|---|------|-----|-------|
| 7.1 | `TICKET_SECRET` set (32-byte hex) — backs ticket/receipt/attendee-session/payout-PII tokens | ⛔ | Platform |
| 7.2 | Optionally set dedicated `RECEIPT_TOKEN_SECRET`, `ATTENDEE_SESSION_SECRET`, `PAYOUT_PII_SECRET` (fall back to `TICKET_SECRET`) | ✅ | Platform |
| 7.3 | `PAYOUT_PII_SECRET` set to a **dedicated** value BEFORE storing real payout PII (rotating it later makes existing ciphertext undecryptable) | ⚠️ | Finance |

## 8. App URL / DNS / SSL

| # | Item | Sev | Owner |
|---|------|-----|-------|
| 8.1 | `NEXT_PUBLIC_APP_URL` set to the production base URL, no trailing slash — **all email links embed this** | ⛔ | Platform |
| 8.2 | `NEXT_PUBLIC_BASE_URL` set for SEO/OG canonical URLs | ⚠️ | Platform |
| 8.3 | Primary domain + DNS pointed to Vercel; SSL/TLS auto-provisioned and valid | ⛔ | Platform |
| 8.4 | Organizer custom domains (if used) verified via `/admin/domains` | ✅ | Platform |
| 8.5 | Default OpenGraph card present at `/marketing/og/default.png` (replace the placeholder with a 1200×630 branded asset) | ⚠️ | Comms |

## 9. Monitoring

| # | Item | Sev | Owner |
|---|------|-----|-------|
| 9.1 | `SENTRY_DSN` set — money paths + cron catch blocks call `captureError`/`captureFinancialError`; without it they degrade to console.error | ⚠️ | Platform |
| 9.2 | `cronMetrics` reviewed for all 20 crons after first day (durations vs `maxDuration`) | ✅ | Platform |
| 9.3 | Alerting on: cron failures, `suspiciousPayments` writes, `failedRefunds` writes, `reconciliationReports` mismatches | ⚠️ | Platform |

## 10. Backup / Recovery

| # | Item | Sev | Owner |
|---|------|-----|-------|
| 10.1 | Firestore **scheduled backups** enabled (GCP Firestore managed backups or scheduled export to GCS) | ⛔ | Platform |
| 10.2 | Backup restore drill performed at least once | ⚠️ | Platform |
| 10.3 | Storage bucket versioning / lifecycle policy set | ✅ | Platform |
| 10.4 | Secrets stored in a manager (not committed); `.env*` gitignored (verified) | ⛔ | Platform |
| 10.5 | Disaster-recovery runbook reviewed by on-call (see `OPERATIONS_RUNBOOK.md`) | ⛔ | Platform |

---

## Pre-GA hard gates (the short list)

1. Deploy Firestore **indexes** (1.5) — reminders depend on it.
2. Register **both** Razorpay webhooks (2.5).
3. `CRON_SECRET` + Vercel **Pro** (6.1, 6.2).
4. `UPSTASH_*` (5.1) + all required env (2.x, 3.3, 7.1, 8.1).
5. Firestore **backups** enabled (10.1).
6. SES out of sandbox (3.2).
