// RD-PRINT-BILL-P6 · What a badge-generation or badge-purchase response MEANS for the UI. Pure.
//
// Built only from the codes the routes actually return:
//   POST /api/organizer/print-jobs          (+ /quote, /[jobId]/retry)  — Phase 5
//   POST /api/organizer/events/[slug]/print-badges/{quote,purchase}     — Phase 4
//   POST /api/licensing/checkout/confirm  (bdg_ orders)                 — Phase 4
// Nothing here decides a price, a count or whether a payment succeeded: the server's message is
// shown as given, and every figure stays the server's.

import type { PrintBadgeQuote } from '@/lib/printAssets/generationJob'

export type QuoteReason = 'required' | 'invalid' | 'expired' | 'changed'

export type BadgeGenerationOutcome =
  | { kind: 'success'; jobId: string | null; existing: boolean }
  /** A fresh server quote must be (re)confirmed — same selection, same requestId. */
  | { kind: 'needs_quote'; reason: QuoteReason; quote: PrintBadgeQuote | null; message: string }
  /** The same request is still being created — retry later with the SAME requestId. */
  | { kind: 'in_progress'; message: string }
  /** The requestId was used for a different request. Never silently re-sent under a new id. */
  | { kind: 'conflict'; message: string }
  | { kind: 'insufficient'; quote: PrintBadgeQuote | null; message: string }
  | { kind: 'owner_required'; message: string }
  /** The job's billing state moved under the request (retry route) — reload and try again. */
  | { kind: 'billing_changed'; message: string }
  /** The job is running right now (retry route). */
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string; retryable: boolean }

export const QUOTE_REASON: Record<string, QuoteReason> = {
  BILLING_QUOTE_REQUIRED: 'required', QUOTE_INVALID: 'invalid', QUOTE_EXPIRED: 'expired', QUOTE_CHANGED: 'changed',
}

const FALLBACK = 'Something went wrong. Please try again.'

/** Maps a generation response (create or retry). `status` 0 = the request never reached the server. */
export function mapGenerationResponse(status: number, body: unknown): BadgeGenerationOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const message = typeof b.error === 'string' && b.error ? b.error : FALLBACK
  const code = typeof b.code === 'string' ? b.code : null
  const quote = b.quote && typeof b.quote === 'object' ? b.quote as PrintBadgeQuote : null

  if (status >= 200 && status < 300 && b.success === true) {
    const job = b.job as { jobId?: unknown } | null | undefined
    const jobId = typeof b.jobId === 'string' ? b.jobId : typeof job?.jobId === 'string' ? job.jobId : null
    return { kind: 'success', jobId, existing: status === 200 && typeof b.jobId === 'string' }
  }
  if (status === 0) return { kind: 'error', message: 'Could not reach RegisterDesk. Check your connection and try again.', retryable: true }
  if (code && code in QUOTE_REASON) return { kind: 'needs_quote', reason: QUOTE_REASON[code], quote, message }
  switch (code) {
    case 'REQUEST_IN_PROGRESS':        return { kind: 'in_progress', message }
    case 'REQUEST_ID_REUSED':          return { kind: 'conflict', message }
    case 'INSUFFICIENT_BADGE_UNITS':   return { kind: 'insufficient', quote, message }
    case 'OWNER_REQUIRED':             return { kind: 'owner_required', message }
    case 'BILLING_STATE_CHANGED':      return { kind: 'billing_changed', message }
    case 'BILLING_UNAVAILABLE':        return { kind: 'error', message, retryable: true }
    case 'EVENT_OWNERSHIP_UNVERIFIED': return { kind: 'error', message, retryable: false }
    case 'REQUEST_ID_REQUIRED':        return { kind: 'error', message, retryable: false }
    case 'TEMPLATE_ARCHIVED':          return { kind: 'error', message, retryable: false }
    // RD-PRINT-P8 — a paid job cannot be reopened once its organizer leaves the pilot (start a new, free job).
    case 'PILOT_REMOVED':              return { kind: 'error', message, retryable: false }
  }
  // The retry route answers a running job with a plain 409 and this exact message.
  if (status === 409 && message === 'Job is currently processing') return { kind: 'busy', message }
  return { kind: 'error', message, retryable: status >= 500 || status === 429 }
}

export type BadgePurchaseOutcome =
  | { kind: 'checkout' }                     // a Razorpay order to pay (handed to openCheckout)
  | { kind: 'applied'; quantity: number | null }   // free-coupon order: units applied now
  | { kind: 'already_paid' }                 // this purchase request was already paid
  /** Payment is being verified / captured — never "pay again". */
  | { kind: 'processing'; message: string }
  /** Payment held for review (refund / duplicate / suspicious) — the server's message, verbatim. */
  | { kind: 'held'; message: string }
  | { kind: 'refused'; code: string | null; message: string; retryable: boolean }

/** Maps a badge purchase or confirm response. Success is only what the SERVER reports. */
export function mapPurchaseResponse(status: number, body: unknown): BadgePurchaseOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const message = typeof b.error === 'string' && b.error ? b.error : FALLBACK
  const code = typeof b.code === 'string' ? b.code : null
  if (status >= 200 && status < 300) {
    if (b.alreadyPaid === true) return { kind: 'already_paid' }
    if (b.applied === true) return { kind: 'applied', quantity: typeof b.quantity === 'number' ? b.quantity : null }
    if (b.checkout && typeof b.checkout === 'object') return { kind: 'checkout' }
    if (b.success === true) return { kind: 'applied', quantity: typeof b.quantity === 'number' ? b.quantity : null }
    return { kind: 'refused', code: null, message: FALLBACK, retryable: true }
  }
  if (status === 0) return { kind: 'refused', code: null, message: 'Could not reach RegisterDesk. Check your connection and try again.', retryable: true }
  if (code === 'PAYMENT_PROCESSING' || code === 'PAYMENT_NOT_CAPTURED') return { kind: 'processing', message }
  if (code === 'PAYMENT_HELD') return { kind: 'held', message }
  return { kind: 'refused', code, message, retryable: status >= 500 || status === 429 }
}

/** Server-message friendly label for a purchase state reported by the summary. */
export const PURCHASE_STATE_TEXT: Record<string, string> = {
  available:          'Available to buy',
  not_released:       'ID badge purchases are not available yet.',
  not_for_sale:       'ID badges are not on sale right now.',
  not_configured:     'Badge pricing is not configured yet.',
  unavailable:        'Badge pricing could not be read. Please try again.',
  badges_not_charged: 'Badges for this event are free — no units are needed.',
  event_not_eligible: 'Badges can be bought only for a published event that is not cancelled, completed or archived.',
  // RD-PRINT-P8 — the server's pilot decision; this text only reports it.
  not_in_pilot:       'ID badge purchases are open to pilot organizers only. Badge generation stays free for this event.',
}
