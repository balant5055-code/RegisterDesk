# RegisterDesk — Operator Guide

Role-based how-to for running the platform. Five audiences: Platform Admin,
Organizer, Support, Finance, Communication. For deployment see
`LAUNCH_CHECKLIST.md`; for incidents see `OPERATIONS_RUNBOOK.md`.

---

## 1. Platform Admin

**Console:** `/admin` (redirects to `/admin/dashboard`). Access requires a Firebase
custom claim `{ admin: true }` or membership in `ADMIN_UIDS`. Every admin action
requires a reason and writes an immutable `adminAuditLogs` entry.

| Task | Where | Notes |
|------|-------|-------|
| Approve / reject / request-changes on events | `/admin/event-approvals` | Reject returns the event to draft with a reason; organizer can resubmit |
| Moderate content / take down / restore | `/admin/moderation` | Take-down requires a reason; taken-down events refuse registration and refund captured payments |
| Suspend / reactivate / ban organizers | `/admin/organizers` | Suspended organizers are blocked from publishing; reason required |
| License management (grant/comp, override price/limit/features, upgrade/downgrade, suspend, refund, reissue, note) | `/admin/licenses` | Overrides apply immediately to publish, entitlements, registration limit, pricing. Capacity override updates `event.totalCapacity` (the enforced field) |
| Business Configuration (runtime policy) | `/admin/business-configuration` | Edits validated + versioned + audited. **Secrets are never stored here** — they stay in env |
| Reminders (platform toggle + analytics) | `/admin/reminders` | Enable/disable kinds, offsets; cancel scheduled reminders |
| Communications (platform-wide usage/costs) | `/admin/communications` | Read-only analytics |
| Incidents | `/admin/incidents` | Track/resolve operational incidents |
| Audit log | `/admin/audit` | Immutable record of every admin action |

**Golden rules:** never edit Firestore directly (bypasses validation + audit);
never put secrets in Business Configuration; every destructive action is logged.

## 2. Organizer

**Workspace:** `/dashboard`. Sign up → verify email (OTP) → create workspace →
buy a license (Starter is free) → build event → publish (auto or admin-approved).

| Task | Where |
|------|-------|
| Create / edit / publish an event | `/dashboard/events` (wizard) |
| Manage attendees, check-in | `/dashboard/registrations`, `/dashboard/check-in` |
| Coupons, passes, waitlist, sessions | Event → tabs |
| Wallet (top-up, transactions, usage) | `/dashboard/wallet` |
| Communication Center (messages, broadcasts, reminders, templates, analytics, billing) | `/dashboard/communications` |
| Certificates | `/dashboard/communications/certificates` |
| Analytics / insights | `/dashboard/analytics` |
| Finance / settlements / payout profile | `/dashboard/finance` |
| License Center (per-event tier, features, billing, upgrade) | `/dashboard/settings/billing/licenses/[eventId]` |
| Team, branding, custom domain, API keys | `/dashboard/settings` |

**Notes:** email must be verified before publishing/collecting payments (enforced
server-side). Communication is charged from the wallet as messages are sent —
nothing upfront. Free-tier limits are enforced by the license.

## 3. Support Team

Front-line troubleshooting. Support does **not** move money — escalate to Finance
for refunds/settlements.

**Support Workspace (`/admin/support`, GA-7E S1):** the fastest first stop. The
**cross-entity lookup** resolves a single query — registration id, ticket code,
attendee email, payment id, certificate id, or organizer uid/email — to the matching
registrations, certificates, and organizers (read-only, PII-lean, capped at 20 hits;
no need to hand-query Firestore for the routine cases below). From the results you can
**resend a ticket email** (reuses the same guarded send path as the organizer flow —
blocked for cancelled/rejected/refunded) or **resend a certificate email** (disabled
for revoked certs). Both resends are recorded in `adminAuditLogs`
(`support.ticket_resent` / `support.certificate_resent`).

| Symptom | Check | Action |
|---------|-------|--------|
| "I didn't get my ticket/receipt email" | `emailLogs` for the recipient (status sent/failed/skipped) | If `skipped` → SES not configured; if `failed` → **resend from the Support Workspace** (look up by email/ticket code → *Resend ticket*); confirm not on suppression list |
| "My registration didn't complete but I paid" | Razorpay dashboard for the payment; `registrations` + `paymentEvents` | If captured but no registration, the webhook/cron reconciles within ~10 min; verify webhook registered |
| "Certificate won't download" | Registration status (must be confirmed, not refunded); `certificates/{id}` | Certificate download is a capability URL — **resend from the Support Workspace** (look up by certificate id → *Resend certificate*; disabled if revoked) |
| "Can't verify my email" | User doc exists in `users/{uid}`; OTP flow | Re-send OTP; if profile doc missing, escalate (rare orphaned-signup case) |
| Organizer "can't publish" | Email verified? License paid for the tier? Required fields complete? | Publish is gated server-side on all three |
| "Event page 404s" | Event `lifecycleStatus` (draft/pending/archived don't render) + moderation status | |

**Escalation:** money → Finance; delivery/reputation → Communication; auth/data →
Platform Admin.

## 4. Finance Team

Owns all money movement. Everything is auditable.

| Task | Where | Guardrail |
|------|-------|-----------|
| Review settlements + release funds | `/admin/finance` | Release is exactly-once (re-reads `releaseStatus`); confirm the release is attributed in audit |
| Failed refunds (Razorpay API errors) | `/admin/failed-refunds` | Retry from here; each refund is idempotent per `refundId` — safe to retry |
| Clawbacks (recover over-paid settlements) | `/admin/clawbacks` | Waive / mark-recovered — both audited |
| Wallet top-ups | `/admin/wallet-topups` | Exactly-once credit (`topup_<order>`) |
| Finance reports / exports | `/admin/finance-reports` | CSV/XLSX/PDF |
| License refunds | `/admin/licenses` → refund action | Gateway refund + wallet credit-back + cancel license; idempotent ledger |

**Daily checks:** `suspiciousPayments` (integrity mismatches),
`reconciliationReports` **wallet** rows (financial invariant — never auto-repaired),
`failedRefunds`. Any wallet reconciliation mismatch is a page-Finance event.

**Money invariants (verified in code):** amounts are server-authoritative (never
trusted from the client); all balance mutations are Firestore transactions; every
refund/credit is idempotent; fees are integer paise with no double-counting.

## 5. Communication Team

Owns deliverability and messaging.

| Task | Where |
|------|-------|
| Platform-wide comms usage, costs, failures | `/admin/communications` |
| Reminder settings (kinds, offsets, enable/disable) | `/admin/reminders` |
| Email templates (transactional) | Organizer `/dashboard/communications` → Templates (view) + email-templates editor |
| Broadcasts | Organizer `/dashboard/communications` → Broadcasts |

**Deliverability responsibilities:**
- Keep SES out of the sandbox; monitor bounce/complaint rate (via SNS once wired).
- Maintain the default OG card at `/marketing/og/default.png` (1200×630).
- WhatsApp: do not advertise until wiring + template approval are complete.
- Email is single-attempt (no auto-retry) — a transient SES failure requires a
  manual resend; watch `emailLogs` for `failed` clusters.

---

## Quick reference — key collections

`registrations`, `registrationCounters`, `platformTransactions`,
`organizerRevenueWallets`, `organizerWallets`, `walletTransactions`,
`eventLicenses`, `licenseOrders`, `licenseHistory`, `scheduledReminders`,
`broadcastCampaigns`, `communicationUsage`, `emailLogs`, `certificates`,
`donations`, `donationCounters`, `adminAuditLogs`, `suspiciousPayments`,
`failedRefunds`, `reconciliationReports`, `cronMetrics`.

All financial/PII collections are **server-only** (Firestore rules deny client
access); reach them via the Admin SDK / admin console, never the client.
