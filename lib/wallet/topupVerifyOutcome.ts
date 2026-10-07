// lib/wallet/topupVerifyOutcome.ts
// RD-WALLET-W1.1 — how a client must read POST /api/organizer/wallet/topup/verify. Pure and
// client-safe (no SDK). Used by the event-wizard top-up; the rule it encodes is the one that
// matters for money: after the organizer has PAID, only an explicit success is "credited", and
// every uncertain outcome must stop them from paying again.
//
//   200 success                → credited
//   202 PAYMENT_NOT_CAPTURED   → pending   (authorised, not captured — credited on capture)
//   202 pending (no code)      → pending   (credit deferred to the recorded reconciliation)
//   409 DUPLICATE_PAYMENT      → duplicate (a second payment: not credited, not auto-refunded)
//   409 NEEDS_REVIEW           → review    (payment received, could not be matched — reviewed)
//   503 REVIEW_UNRECORDED      → review    (W2.c — held for review, NOT auto-credited; the review
//                                record could not be written yet, so support is named)
//   400 NEEDS_REVIEW           → review    (W2.c — captured but mismatched: held for review)
//   503 CREDIT_DEFERRED        → deferred  (credit not confirmed or recorded — recovered later)
//   other 5xx (e.g. 502)       → unconfirmed (the payment could not be verified AFTER the organizer
//                                paid — the wizard's only "retry" would be paying again)
//   anything else (4xx)        → failed    (the existing error handling)

export type TopupVerifyOutcome =
  | { kind: 'credited';  newBalance: number }
  | { kind: 'pending';   message: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'review';    message: string }
  | { kind: 'deferred';  message: string }
  | { kind: 'unconfirmed'; message: string }
  | { kind: 'failed';    message: string }

/** Outcomes after which a NEW payment must not be started (money may already have moved). */
export type TopupHoldKind = 'pending' | 'duplicate' | 'review' | 'deferred' | 'unconfirmed'

export const TOPUP_OUTCOME_MESSAGES = {
  pending:
    'Your payment is authorised but not yet captured, so your wallet has not been credited yet. ' +
    'It will be credited automatically once the payment is captured. Please do not pay again.',
  pendingDeferred:
    'Payment received — your wallet will be credited shortly. Please do not pay again.',
  duplicate:
    'This top-up was already paid and credited. Your additional payment was NOT added to your wallet ' +
    'and has NOT been refunded automatically — it has been flagged for review. Please do not pay again.',
  review:
    'Your payment was received but could not be matched to this top-up automatically. It has been sent ' +
    'for review — your wallet has not been credited yet. Please do not pay again.',
  // RD-WALLET-W2.c — never promises an automatic credit: this payment is held for manual review.
  reviewUnrecorded:
    'Your payment was received but could not be matched to this top-up automatically, and it has NOT been ' +
    'added to your wallet. We could not finish sending it for review just now — please contact support with ' +
    'your payment reference. Please do not pay again.',
  deferred:
    // RD-WALLET-W2.c — also shown when the system could not tell whether the order is held for
    // review, so it never promises an automatic credit.
    'Payment received, but we could not confirm your wallet credit right now. Your wallet has not been credited ' +
    'yet — it will be completed or sent for review. Please do not pay again; if your balance has not updated ' +
    'soon, contact support with your payment reference.',
  // RD-WALLET-W2.c — the payment could not be verified (network / gateway): its outcome is
  // unknown, so no automatic credit is promised.
  unconfirmed:
    'We could not confirm your payment yet, and your wallet has not been credited. Please do not pay again — ' +
    'if you completed the payment, it will be completed or sent for review. Contact support with your payment ' +
    'reference if your balance has not updated soon.',
  // RD-WALLET-W2.f.1 — a review that ended WITHOUT a credit (status 'not_credited'). Final, not
  // "under review"; no internal detail (reviewer, reason, refund reference) is ever shown.
  notCredited:
    'This payment was not added to your wallet. If money left your account and you have not received it back, ' +
    'please contact support with your payment reference. You can start a new top-up if you still need funds.',
} as const

/** RD-WALLET-W2.c — how a surface presents a PAID but not-credited outcome. */
export type TopupHoldTone =
  | 'awaiting_credit'   // genuinely eligible for the automatic path (capture / recorded retry)
  | 'review'            // held for review (mismatch, duplicate, review hold) — not credited automatically
  | 'uncertain'         // the credit could not be confirmed either way

export interface TopupHoldPresentation {
  tone:      TopupHoldTone
  /** True only when an automatic credit is genuinely expected (the message may say so). */
  autoRetry: boolean
  message:   string
}

/**
 * Pure. For every outcome after which the organizer has paid but is NOT credited: the message to
 * show and whether an automatic credit may be promised. None of these may offer "pay again".
 */
export function describeTopupHold(
  outcome: Exclude<TopupVerifyOutcome, { kind: 'credited' } | { kind: 'failed' }>,
): TopupHoldPresentation {
  switch (outcome.kind) {
    case 'pending':     return { tone: 'awaiting_credit', autoRetry: true,  message: outcome.message }
    case 'review':
    case 'duplicate':   return { tone: 'review',          autoRetry: false, message: outcome.message }
    case 'deferred':
    case 'unconfirmed': return { tone: 'uncertain',       autoRetry: false, message: outcome.message }
  }
}

export function classifyTopupVerifyResponse(
  status: number,
  body: { success?: unknown; newBalance?: unknown; error?: unknown; pending?: unknown; code?: unknown } | null | undefined,
): TopupVerifyOutcome {
  const b = body ?? {}
  const code = typeof b.code === 'string' ? b.code : null
  if (status === 200 && b.success === true) {
    return { kind: 'credited', newBalance: typeof b.newBalance === 'number' ? b.newBalance : 0 }
  }
  if (code === 'PAYMENT_NOT_CAPTURED') return { kind: 'pending', message: TOPUP_OUTCOME_MESSAGES.pending }
  if (code === 'DUPLICATE_PAYMENT')    return { kind: 'duplicate', message: TOPUP_OUTCOME_MESSAGES.duplicate }
  if (code === 'NEEDS_REVIEW')         return { kind: 'review', message: TOPUP_OUTCOME_MESSAGES.review }
  if (code === 'REVIEW_UNRECORDED')    return { kind: 'review', message: TOPUP_OUTCOME_MESSAGES.reviewUnrecorded }
  if (code === 'CREDIT_DEFERRED' || status === 503) return { kind: 'deferred', message: TOPUP_OUTCOME_MESSAGES.deferred }
  if (status === 202 || b.pending === true) return { kind: 'pending', message: TOPUP_OUTCOME_MESSAGES.pendingDeferred }
  if (status >= 500) return { kind: 'unconfirmed', message: TOPUP_OUTCOME_MESSAGES.unconfirmed }
  return { kind: 'failed', message: typeof b.error === 'string' && b.error ? b.error : 'Payment verification failed.' }
}
