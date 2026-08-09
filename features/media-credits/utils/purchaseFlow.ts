// MC-08.2 · The purchase flow's decisions — PURE. No React, no fetch, no gateway.
//
// A purchase has more failure modes than successes, and every one of them is a moment where
// showing the wrong thing costs real money or real trust: nudging someone to pay twice,
// calling a captured payment "failed", or showing a red error to someone who pressed Escape.
//
// Extracted here so each of those can be asserted by a unit test rather than reproduced by
// hand against a live gateway. Same discipline as `ledgerMath` and `refundMath`.

/**
 * Where a purchase attempt is.
 *
 *   idle        nothing started, or the shopper backed out and may try again
 *   creating    asking the server for an order
 *   paying      the gateway modal is open — the shopper is in control
 *   verifying   the browser said "paid"; the server is deciding whether that is true
 *   granted     credits are in the wallet
 *   pending     money captured, credits NOT yet granted (HTTP 202) — owed, being reconciled
 *   failed      the attempt is over and no money was taken
 */
export type PurchasePhase =
  | 'idle' | 'creating' | 'paying' | 'verifying' | 'granted' | 'pending' | 'failed'

/** A phase the shopper cannot leave by clicking; the dialog must not close under them. */
export function isBusy(phase: PurchasePhase): boolean {
  return phase === 'creating' || phase === 'paying' || phase === 'verifying'
}

/**
 * Whether the wallet may have changed and the dashboard should re-read it.
 *
 * `pending` counts. The money is captured and reconciliation may land the grant at any
 * moment, so a dashboard that refuses to refresh would keep showing a stale balance long
 * after the credits arrived.
 */
export function shouldRefetch(phase: PurchasePhase): boolean {
  return phase === 'granted' || phase === 'pending'
}

/** Whether offering "try again" makes sense. Never after money has been taken. */
export function canRetry(phase: PurchasePhase): boolean {
  return phase === 'idle' || phase === 'failed'
}

export interface PhaseView {
  phase:   PurchasePhase
  title:   string
  message: string
  tone:    'neutral' | 'success' | 'warning' | 'danger'
}

/**
 * Classifies the server's answer to `POST /purchases/verify`.
 *
 * The 202 case is the one that matters. The payment succeeded but the grant transaction did
 * not, so the money is real and the credits are owed. Reporting that as a failure would push
 * someone into paying a second time for credits they have already bought — so it gets its own
 * terminal phase with wording that explicitly tells them not to retry.
 */
export function classifyVerifyResponse(
  httpStatus: number,
  body: { success?: boolean; pending?: boolean; error?: string } | null,
): PhaseView {
  if (httpStatus === 202 || body?.pending === true) {
    return {
      phase: 'pending',
      title: 'Payment received',
      message:
        'Your payment went through and your credits are being added. This usually takes a '
        + 'moment. Do not pay again — your purchase is recorded and will appear in your history.',
      tone: 'warning',
    }
  }

  if (httpStatus >= 200 && httpStatus < 300 && body?.success === true) {
    return {
      phase: 'granted',
      title: 'Credits added',
      message: 'Your credits are available now.',
      tone: 'success',
    }
  }

  // Anything else: no credits, and the server has already decided the payment was not valid.
  // The server's own wording is preferred when present — it distinguishes "credits are turned
  // off" from "signature did not match" without this file needing to know either.
  return {
    phase: 'failed',
    title: 'Payment could not be verified',
    message:
      body?.error
      ?? 'We could not verify this payment. If money was debited it will be refunded '
       + 'automatically. Please contact support if it does not reappear.',
    tone: 'danger',
  }
}

/** Classifies a failure to create the purchase intent. Nothing has been charged yet. */
export function classifyIntentFailure(httpStatus: number, error?: string): PhaseView {
  if (httpStatus === 429) {
    return {
      phase: 'failed',
      title: 'Too many attempts',
      message: error ?? 'Too many purchase requests. Please wait a few minutes and try again.',
      tone: 'warning',
    }
  }
  if (httpStatus === 403) {
    return {
      phase: 'failed',
      title: 'Purchase unavailable',
      message: error ?? 'You do not have permission to buy credits for this workspace.',
      tone: 'danger',
    }
  }
  return {
    phase: 'failed',
    title: 'Could not start the purchase',
    message: error ?? 'Something went wrong before any payment was taken. Please try again.',
    tone: 'danger',
  }
}

/**
 * The shopper closed the gateway. Explicitly NOT a failure.
 *
 * Returns to `idle`, with no error styling and no scary copy, because nothing went wrong and
 * nothing was charged.
 */
export function cancelledView(): PhaseView {
  return {
    phase: 'idle',
    title: 'Payment cancelled',
    message: 'No payment was taken. You can try again whenever you are ready.',
    tone: 'neutral',
  }
}

/** The gateway script never loaded. Distinct from a declined payment: nothing was attempted. */
export function gatewayUnavailableView(message: string): PhaseView {
  return { phase: 'failed', title: 'Payment gateway unavailable', message, tone: 'danger' }
}

/**
 * Guards the submit control.
 *
 * A purchase is only startable from a resting phase with a sane quantity. The quantity bound
 * mirrors `MAX_CREDITS_PER_PURCHASE` in purchaseService — the server rejects anything larger,
 * and letting the button fire a request that is certain to 400 is a worse experience than
 * disabling it.
 */
export const MAX_CREDITS_PER_PURCHASE = 1_000_000

export function canSubmit(phase: PurchasePhase, credits: number): boolean {
  if (!canRetry(phase)) return false
  return Number.isFinite(credits)
    && Number.isInteger(credits)
    && credits > 0
    && credits <= MAX_CREDITS_PER_PURCHASE
}
