// RD-PAYMENT-CASHFREE-CHECKOUT-06 · the browser's provider-neutral checkout.
//
// ═══ WHAT THIS MODULE IS FOR ═════════════════════════════════════════════════
// One function — `openCheckout` — that takes the handoff the SERVER issued and opens that
// provider's checkout. Every provider-specific browser detail (script URL, global name,
// constructor shape, callback contract) lives here and nowhere else, so RegisterClient,
// RegistrationUI and CheckoutPanels stay free of gateway code.
//
// ═══ THE RULE THAT SHAPES THE WHOLE FILE ═════════════════════════════════════
// A checkout that "returned" is NOT a payment that succeeded.
//
// Razorpay's `handler` fires only after money has been taken, so its result is strong
// evidence. Cashfree's is not evidence at all: RD-PAYMENT-CASHFREE-SANDBOX-05B measured a
// real sandbox UPI collect sitting at PENDING for ~30 seconds AFTER checkout closed, and the
// v3 SDK's `checkout()` promise resolves with `{ error?, redirect? }` — it reports no payment
// status and is documented not to return payment details at all.
//
// So this module never decides that a payment succeeded. It returns what HAPPENED IN THE
// BROWSER, and the caller asks the server what is TRUE. The outcome type has no `succeeded`
// member on purpose — there is no way to express "paid" from here.

import type { CheckoutHandoff } from '@/lib/payments/providers/types'

/** What Razorpay's checkout hands back — the fields verify-payment already expects. */
export interface RazorpayCheckoutPayload {
  razorpay_payment_id: string
  razorpay_order_id:   string
  razorpay_signature:  string
}

/**
 * The result of opening a checkout — deliberately NOT a payment result.
 *
 *  · `signed`    — Razorpay returned a signed payload. The SERVER still verifies it.
 *  · `submitted` — the attendee completed Cashfree's flow. Proves nothing; poll the server.
 *  · `dismissed` — the attendee closed checkout without completing.
 *  · `unavailable` — checkout could not be opened at all (script blocked, bad session).
 */
export type CheckoutOutcome =
  | { kind: 'signed';      provider: 'razorpay'; payload: RazorpayCheckoutPayload }
  | { kind: 'submitted';   provider: 'cashfree' }
  | { kind: 'dismissed';   provider: 'razorpay' | 'cashfree' }
  | { kind: 'unavailable'; provider: 'razorpay' | 'cashfree'; reason: string }

export interface CheckoutContext {
  orderId:       string
  amountPaise:   number
  currency:      string
  eventName:     string
  passName:      string
  attendeeName:  string
  attendeeEmail: string
  attendeePhone?: string
}

// ─── Script loading ───────────────────────────────────────────────────────────

/** Loads a script once. Repeat calls resolve against the element already in the document. */
function loadScript(src: string, isReady: () => boolean): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (isReady()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('script failed')), { once: true })
      // Already finished loading before we attached: the readiness probe is the only
      // reliable signal, since a completed script fires no further events.
      if (isReady()) resolve()
      return
    }
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => reject(new Error('script failed'))
    document.body.appendChild(el)
  })
}

// ─── Razorpay ─────────────────────────────────────────────────────────────────

const RAZORPAY_SRC = 'https://checkout.razorpay.com/v1/checkout.js'

export function prefetchRazorpay(): Promise<void> {
  return loadScript(RAZORPAY_SRC, () => Boolean(window.Razorpay)).catch(() => {})
}

async function openRazorpay(
  keyId: string, ctx: CheckoutContext,
): Promise<CheckoutOutcome> {
  try {
    await loadScript(RAZORPAY_SRC, () => Boolean(window.Razorpay))
  } catch {
    return { kind: 'unavailable', provider: 'razorpay', reason: 'script' }
  }

  return new Promise<CheckoutOutcome>(resolve => {
    // Unchanged from the pre-phase implementation, field for field — this phase must not
    // alter how Razorpay behaves.
    const rzp = new window.Razorpay({
      key:         keyId,
      amount:      ctx.amountPaise,
      currency:    ctx.currency,
      order_id:    ctx.orderId,
      name:        ctx.eventName,
      description: ctx.passName,
      prefill: {
        name:    ctx.attendeeName,
        email:   ctx.attendeeEmail,
        contact: ctx.attendeePhone,
      },
      handler: (payload: RazorpayCheckoutPayload) =>
        resolve({ kind: 'signed', provider: 'razorpay', payload }),
      modal: { ondismiss: () => resolve({ kind: 'dismissed', provider: 'razorpay' }) },
      theme: { color: '#e5277e' },
    })
    rzp.open()
  })
}

// ─── Cashfree ─────────────────────────────────────────────────────────────────

/**
 * Cashfree JS SDK v3, per the current official integration:
 *   script  https://sdk.cashfree.com/js/v3/cashfree.js
 *   factory Cashfree({ mode: 'sandbox' })
 *   open    cashfree.checkout({ paymentSessionId, redirectTarget: '_modal' })
 *
 * `checkout()` resolves with `{ error?, redirect? }`. There is no success field, and the
 * documentation is explicit that payment details are NOT returned by `checkout()` — which
 * matches this module's rule: the browser cannot tell us a payment succeeded.
 */
const CASHFREE_SRC = 'https://sdk.cashfree.com/js/v3/cashfree.js'

interface CashfreeCheckoutResult {
  error?:    { message?: string }
  redirect?: boolean
}
interface CashfreeInstance {
  checkout(opts: { paymentSessionId: string; redirectTarget?: string }): Promise<CashfreeCheckoutResult>
}
type CashfreeFactory = (opts: { mode: 'sandbox' | 'production' }) => CashfreeInstance

function cashfreeGlobal(): CashfreeFactory | undefined {
  return (window as unknown as { Cashfree?: CashfreeFactory }).Cashfree
}

async function openCashfree(
  paymentSessionId: string, mode: 'sandbox' | 'production',
): Promise<CheckoutOutcome> {
  try {
    await loadScript(CASHFREE_SRC, () => typeof cashfreeGlobal() === 'function')
  } catch {
    return { kind: 'unavailable', provider: 'cashfree', reason: 'script' }
  }
  const factory = cashfreeGlobal()
  if (typeof factory !== 'function') {
    return { kind: 'unavailable', provider: 'cashfree', reason: 'sdk' }
  }

  try {
    // The SDK environment comes from the server's handoff, never from anything this page can
    // see. It used to be the literal 'sandbox', which would have opened a sandbox SDK against
    // a production session the moment production was switched on — a broken checkout that
    // looks like a gateway fault rather than a misconfiguration.
    const cashfree = factory({ mode })
    const result = await cashfree.checkout({ paymentSessionId, redirectTarget: '_modal' })

    if (result?.error) {
      // Cashfree reports a closed modal through the same channel as a genuine error, and the
      // distinction does not matter here: neither is proof of payment, and the caller polls
      // the server either way. Treated as dismissed so the attendee sees a recoverable state.
      return { kind: 'dismissed', provider: 'cashfree' }
    }
    // The flow completed in the browser. This is NOT success — the payment may still be
    // PENDING at Cashfree for another half minute.
    return { kind: 'submitted', provider: 'cashfree' }
  } catch {
    return { kind: 'unavailable', provider: 'cashfree', reason: 'checkout' }
  }
}

// ─── The one entry point ──────────────────────────────────────────────────────

/**
 * Opens checkout for the handoff the server issued.
 *
 * The provider comes from `handoff.provider` — the SERVER's word. Nothing here reads an env
 * var, a URL parameter or a client flag, and there is no branch that picks a provider from
 * which fields happen to be present.
 */
export function openCheckout(
  handoff: CheckoutHandoff, ctx: CheckoutContext,
): Promise<CheckoutOutcome> {
  switch (handoff.provider) {
    case 'razorpay': return openRazorpay(handoff.keyId, ctx)
    case 'cashfree': return openCashfree(handoff.paymentSessionId, handoff.mode)
  }
}
