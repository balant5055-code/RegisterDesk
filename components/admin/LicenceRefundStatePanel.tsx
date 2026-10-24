'use client'

// RD-SA-COMMERCE-P1 (P1-5) — ONE read-only view of a licence's refund state, shared by every licence
// console (Licenses drawer, License Center drawer, Event 360). Shown only when there is something to see.
// The two recovery actions are optional callbacks; the server re-verifies everything (age, gateway,
// wallet, finalization) — see docs/RD-SA-COMMERCE-P1-REFUND-HOLDS.md.

import type { LicenseRefundStateView } from '@/lib/admin/licenseAdminTypes'

const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const fmtDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

const PHASE_LABEL: Record<string, string> = {
  claimed:    'claimed — not yet sent to Razorpay',
  gateway:    'sent to Razorpay',
  unknown:    'Razorpay outcome NOT confirmed — reconcile',
  completing: 'being completed by a Super Admin',
  reconcile:  'money refunded — internal finalization incomplete; use “Complete refund”',
}

export function LicenceRefundStatePanel({ state, onRelease, onComplete, onAcknowledgeFailure, busy }: {
  state: LicenseRefundStateView
  onRelease?: () => void
  onComplete?: () => void
  /** M2 — record the Super Admin decision on a refund that failed at the gateway (moves no money). */
  onAcknowledgeFailure?: () => void
  busy?: boolean
}) {
  const { hold, review, legacyRefundingOrder, refundFailure } = state
  if (!hold && !review && !state.refundedAt && !legacyRefundingOrder && !refundFailure) return null
  const releasable = hold ? hold.releaseAgeReached : true
  const showActions = (hold || legacyRefundingOrder) && (onRelease || onComplete)
  return (
    <div className="space-y-2" data-testid="licence-refund-state">
      {hold && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px]">
          <p className="font-semibold text-destructive">Refund in progress — new sales are blocked</p>
          <p className="mt-0.5 text-foreground">
            Order {hold.orderId ?? '—'} · claimed {fmtDateTime(hold.at)}{hold.ageHours !== null ? ` (${hold.ageHours} h ago)` : ''} by {hold.by ?? '—'}
          </p>
          {hold.phase && <p className="mt-0.5 text-foreground">State: {PHASE_LABEL[hold.phase] ?? hold.phase}{hold.gatewayOutcome ? ` (lookup: ${hold.gatewayOutcome})` : ''}</p>}
          <p className="mt-0.5 text-muted-foreground">
            A hold is never released for being old. {releasable
              ? 'Check Razorpay first: “Complete refund” only succeeds when it shows the full refund; “Release refund hold” only when it shows none.'
              : `It cannot be released before ${fmtDateTime(hold.releasableAfter)} — the refund may still be finishing.`}
          </p>
        </div>
      )}
      {!hold && legacyRefundingOrder && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px]">
          <p className="font-semibold text-amber-800">Order {legacyRefundingOrder.orderId} is stuck in “refunding”</p>
          <p className="mt-0.5 text-foreground">Left by an earlier refund (since {fmtDateTime(legacyRefundingOrder.since)}). Check Razorpay, then complete or release it.</p>
        </div>
      )}
      {showActions && (
        <div className="flex flex-wrap gap-2">
          {onComplete && (
            <button type="button" onClick={onComplete} disabled={busy}
              className="inline-flex items-center rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
              Complete refund
            </button>
          )}
          {onRelease && (
            <button type="button" onClick={onRelease} disabled={busy || !releasable}
              title={releasable ? undefined : 'Available 15 minutes after the refund was claimed'}
              className="inline-flex items-center rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
              Release refund hold
            </button>
          )}
        </div>
      )}
      {refundFailure && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px]">
          <p className="font-semibold text-destructive">
            {refundFailure.status === 'open' ? 'Licence refund FAILED at Razorpay after it was accepted' : 'Failed licence refund — acknowledged'}
          </p>
          <p className="mt-0.5 text-foreground">
            {refundFailure.refundIds.join(', ') || '—'}{refundFailure.amountPaise !== null ? ` · ${rupees(refundFailure.amountPaise)}` : ''} · gateway evidence: {refundFailure.evidence ?? '—'} · since {fmtDateTime(refundFailure.firstAt)}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            The licence stays refunded (sales blocked). Nothing was retried or restored. Decide outside this screen: re-issue the refund, or restore the entitlement with the confirmed Reactivate / Reissue action.
            {refundFailure.acknowledgedReason ? ` Acknowledged by ${refundFailure.acknowledgedBy ?? '—'}: ${refundFailure.acknowledgedReason}` : ''}
          </p>
          {refundFailure.status === 'open' && onAcknowledgeFailure && (
            <button type="button" onClick={onAcknowledgeFailure} disabled={busy}
              className="mt-2 inline-flex items-center rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
              Acknowledge refund failure
            </button>
          )}
        </div>
      )}
      {review && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px]">
          <p className="font-semibold text-amber-800">Refund refused for review</p>
          <p className="mt-0.5 text-foreground">
            {review.conflicts.join(', ') || '—'} · asked {fmtDateTime(review.at)} by {review.by ?? '—'}
            {review.totalRefundPaise !== null ? ` · ${rupees(review.totalRefundPaise)}` : ''}
            {review.sold !== null ? ` · ${review.sold} registrations` : ''}
          </p>
          {review.reason && <p className="mt-0.5 text-muted-foreground">Reason: {review.reason}</p>}
        </div>
      )}
      {state.refundedAt && (
        <p className="text-[12px] text-muted-foreground">
          Refunded {fmtDateTime(state.refundedAt)}{state.entitlementRestoredAt ? ` · entitlement restored ${fmtDateTime(state.entitlementRestoredAt)}` : ' · sales blocked until a Super Admin restores the entitlement'}
        </p>
      )}
    </div>
  )
}
