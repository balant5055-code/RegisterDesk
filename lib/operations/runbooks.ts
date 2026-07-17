// Operational runbooks (Phase G.6). Pure data — no server imports, safe to render
// directly in the admin client. Each runbook is the standing response procedure for
// a class of production failure, referencing the real endpoints/collections of this
// system. Stored as code so they version with the app and are surfaced in admin.

export interface RunbookStep { title: string; detail: string }
export interface RunbookReference { label: string; href: string }

export interface Runbook {
  id:       string
  title:    string
  trigger:  string                       // the alert/condition that invokes this runbook
  severity: 'critical' | 'high' | 'medium'
  steps:    RunbookStep[]
  references: RunbookReference[]
}

export const RUNBOOKS: Runbook[] = [
  {
    id: 'payment-failure',
    title: 'Payment / Verification Failure',
    trigger: 'Spike in failed payment verifications, suspicious payments, or uncredited registrations.',
    severity: 'critical',
    steps: [
      { title: 'Confirm scope', detail: 'Operations → Financial Health: check pending registration/donation reconciliation. Sentry area:financial for verify-payment / razorpay scopes.' },
      { title: 'Check gateway', detail: 'Confirm Razorpay dashboard status + that RAZORPAY_WEBHOOK_SECRET / keys are valid. Verify the order webhooks are reachable (signature 400s indicate a secret mismatch).' },
      { title: 'Reconcile credits', detail: 'The registration/donation reconciliation crons replay deferred wallet/ledger credits idempotently. Force a run if the backlog is large.' },
      { title: 'Suspicious payments', detail: 'Review suspiciousPayments docs (amount/order mismatches) — these are NOT auto-processed; decide refund vs manual confirm.' },
      { title: 'Verify', detail: 'Pending reconciliation counts return to ~0; no new flagged payments.' },
    ],
    references: [
      { label: 'Operations dashboard', href: '/admin/operations' },
      { label: 'Failed refunds', href: '/admin/operations' },
    ],
  },
  {
    id: 'webhook-failure',
    title: 'Webhook Delivery Failure',
    trigger: 'Webhook failures > 10, or oldest pending delivery growing.',
    severity: 'high',
    steps: [
      { title: 'Confirm scope', detail: 'Operations → Webhook Health: pending vs failed vs oldest-pending. Sentry area:webhook (webhookDelivery.exhausted = dead-lettered).' },
      { title: 'Check the cron', detail: 'Operations → Cron Health: confirm the webhooks cron ran recently and succeeded. If CRON_SECRET is misconfigured every cron is rejected — verify env.' },
      { title: 'Inspect the target', detail: 'A single organizer endpoint being down (or SSRF-blocked) drives most failures; the delivery doc lastError shows the cause. Exhausted deliveries (5 attempts) are terminal.' },
      { title: 'Drain', detail: 'Pending deliveries auto-retry on backoff via the cron. For a transient outage now resolved, the next cron tick clears the queue.' },
      { title: 'Verify', detail: 'Pending count drains; no growth in failed/exhausted.' },
    ],
    references: [{ label: 'Operations dashboard', href: '/admin/operations' }],
  },
  {
    id: 'settlement-failure',
    title: 'Settlement / Payout Failure',
    trigger: 'Funds not releasing pending→available, rejected settlements, or wallet balance mismatch.',
    severity: 'critical',
    steps: [
      { title: 'Confirm scope', detail: 'Operations → Financial Health (pending settlements) + Data Integrity (wallet mismatches, report-only). Cron Health: release-funds last success.' },
      { title: 'Release engine', detail: 'release-funds cron moves T+2-held funds; if it has not run, trigger it. Releases are exactly-once (transactional re-read).' },
      { title: 'Wallet mismatch', detail: 'A reconciliationReports wallet mismatch is REPORT-ONLY — never auto-repaired. Investigate platformTransactions Σnet + outstanding clawbacks vs the wallet buckets manually.' },
      { title: 'Payout proof', detail: 'Paid settlements require a UTR. Reconcile rejected/pending requests with the bank statement before re-approving.' },
      { title: 'Verify', detail: 'Pending settlements clear; no wallet mismatch in the next reconciliation run.' },
    ],
    references: [{ label: 'Operations dashboard', href: '/admin/operations' }, { label: 'Admin finance', href: '/admin/finance' }],
  },
  {
    id: 'refund-failure',
    title: 'Refund Failure',
    trigger: 'failedRefunds > 0 (a refund could not be issued at the gateway).',
    severity: 'critical',
    steps: [
      { title: 'Confirm scope', detail: 'Operations → Dead Letter Queue: failed refunds count + oldest. Each failedRefunds doc holds orderId/paymentId/reason.' },
      { title: 'Check the payment state', detail: 'In Razorpay confirm the payment is refundable (captured, not already refunded). A non-refundable state needs manual handling.' },
      { title: 'Retry', detail: 'Use the admin failed-refunds retry — it re-issues the Razorpay refund, reverses the ledger atomically, and releases held session seats. Idempotent.' },
      { title: 'Verify', detail: 'failedRefunds count drops; the registration shows paymentStatus refunded.' },
    ],
    references: [{ label: 'Operations dashboard', href: '/admin/operations' }],
  },
  {
    id: 'cron-failure',
    title: 'Cron Failure',
    trigger: 'A cron failed within the last 24h (Operations → Cron Health flags it red).',
    severity: 'high',
    steps: [
      { title: 'Identify', detail: 'Operations → Cron Health: which cron, last success vs last failure, failure count. operationsMetrics/{cronName}.lastDetail has the run summary.' },
      { title: 'Check CRON_SECRET', detail: 'If ALL crons show no recent success, CRON_SECRET is likely unset/misconfigured — every cron fail-closes. Production startup enforces it; verify the deploy env.' },
      { title: 'Inspect Sentry', detail: 'scope:cron.* / area:financial,settlement_release,session_reconciliation for the thrown error.' },
      { title: 'Re-run', detail: 'Crons are idempotent — manually invoke the failing cron with the Bearer CRON_SECRET to clear the backlog; reconciliation crons self-heal counters.' },
      { title: 'Verify', detail: 'The cron’s next run succeeds; runCount advances and failedWithin24h clears.' },
    ],
    references: [{ label: 'Operations dashboard', href: '/admin/operations' }],
  },
]
