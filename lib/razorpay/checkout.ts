// Razorpay Checkout — the BROWSER side.
//
// MC-08.2. Loading the gateway script and opening the modal was hand-rolled in four places
// (wallet top-up, event creation, campaign donation, attendee registration). Each copy had to
// re-derive the same two awkward facts: the script tag must be injected before the constructor
// exists, and a dismissed modal reports nothing at all unless you wire `ondismiss` yourself.
//
// This is the canonical implementation. It is deliberately NOT a payment flow — it neither
// creates orders nor verifies signatures. It opens a modal and reports what the shopper did.
// Everything that decides money still happens on the server.
//
// ═══ WHY A RESULT UNION AND NOT A THROW ══════════════════════════════════════
// Cancelling is not an error. It is the second most likely outcome of showing someone a
// payment form, and modelling it as an exception means every caller has to string-match an
// Error message to tell "changed their mind" apart from "the gateway is down" — which is
// exactly what the four existing copies do. A discriminated union makes the caller handle
// cancellation explicitly, because a flow that treats it as a failure will show a red error
// to someone who simply pressed Escape.
//
// ═══ SCOPE ═══════════════════════════════════════════════════════════════════
// The four pre-existing copies are live money paths and were left untouched — migrating them
// is mechanical but unverifiable without a payment sandbox. New callers use this one.

/** What Razorpay hands back on a completed payment. Field names are the gateway's. */
export interface RazorpayPaymentResult {
  razorpay_payment_id: string
  razorpay_order_id:   string
  razorpay_signature:  string
}

export type CheckoutOutcome =
  | { status: 'paid';      payment: RazorpayPaymentResult }
  /** The shopper closed the modal. Not an error — offer the action again. */
  | { status: 'cancelled' }
  /** The script would not load, or the constructor was missing after it did. */
  | { status: 'unavailable'; message: string }

export interface CheckoutRequest {
  /** Publishable key id from the server. Not a secret. */
  keyId:        string
  orderId:      string
  /** Display only — the gateway charges whatever the ORDER says, not this. */
  amountPaise:  number
  currency?:    string
  name?:        string
  description?: string
  /** Pre-fills the payment form. Never used as identity. */
  prefill?:     { name?: string; email?: string; contact?: string }
  notes?:       Record<string, string>
}

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js'

// Razorpay's own option shape. Declared locally rather than on `Window`: several modules in
// this repo already declare a global `Razorpay` with slightly different options, and widening
// the global would make all of them compile against a type none of them actually match.
interface RzpOptions {
  key:      string
  amount:   number
  currency: string
  order_id: string
  name?:        string
  description?: string
  prefill?: { name?: string; email?: string; contact?: string }
  notes?:   Record<string, string>
  handler:  (r: RazorpayPaymentResult) => void
  modal?:   { ondismiss?: () => void }
  theme?:   { color?: string }
}
type RzpCtor = new (options: RzpOptions) => { open(): void }

function ctor(): RzpCtor | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { Razorpay?: RzpCtor }).Razorpay ?? null
}

/**
 * Injects the gateway script, once.
 *
 * Reuses an already-present tag rather than appending a second one: a caller that opens
 * checkout twice would otherwise stack script tags on the page.
 */
export function loadRazorpayCheckout(): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false)
  if (ctor()) return Promise.resolve(true)

  const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`)
  const el = existing ?? document.createElement('script')

  return new Promise<boolean>(resolve => {
    el.addEventListener('load',  () => resolve(ctor() !== null), { once: true })
    el.addEventListener('error', () => resolve(false),           { once: true })
    if (!existing) {
      el.src   = SCRIPT_SRC
      el.async = true
      document.body.appendChild(el)
    }
  })
}

/**
 * Opens Razorpay Checkout and resolves once the shopper has finished with it.
 *
 * Resolves exactly once. Razorpay can fire `handler` and `ondismiss` in sequence for a single
 * payment — the modal closes after success — so without a latch a caller would see a paid
 * result immediately overwritten by a cancellation.
 */
export async function openRazorpayCheckout(req: CheckoutRequest): Promise<CheckoutOutcome> {
  const ready = await loadRazorpayCheckout()
  const Rzp   = ctor()
  if (!ready || !Rzp) {
    return {
      status: 'unavailable',
      message: 'Could not reach the payment gateway. Check your connection and try again.',
    }
  }

  return new Promise<CheckoutOutcome>(resolve => {
    let settled = false
    const once = (o: CheckoutOutcome) => { if (!settled) { settled = true; resolve(o) } }

    const rzp = new Rzp({
      key:         req.keyId,
      amount:      req.amountPaise,
      currency:    req.currency ?? 'INR',
      order_id:    req.orderId,
      name:        req.name ?? 'RegisterDesk',
      description: req.description,
      prefill:     req.prefill,
      notes:       req.notes,
      handler:     payment => once({ status: 'paid', payment }),
      modal:       { ondismiss: () => once({ status: 'cancelled' }) },
      theme:       { color: '#7C3AED' },
    })
    rzp.open()
  })
}
