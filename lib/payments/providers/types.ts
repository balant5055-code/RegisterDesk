// RD-PAYMENT-PROVIDER-CONTRACT-04 · the provider-neutral payment contract.
//
// ═══ WHAT THIS IS FOR ════════════════════════════════════════════════════════
// RegisterDesk takes attendee money through exactly one gateway today. Cashfree Easy Split
// is coming, and the thing that must NOT happen when it arrives is a second registration
// pipeline: a captured payment has to reach `settleCapturedRegistration` the same way
// whoever captured it, or the payment→registration guarantee has to be re-proved per
// provider.
//
// So the boundary is drawn here, before there is a second provider to argue with. A
// provider adapter turns its own SDK's shapes into the normalized types below; nothing
// above the adapter ever sees a gateway type.
//
// ═══ WHY THE CONTRACT IS SPLIT, NOT ONE BIG INTERFACE ════════════════════════
// Razorpay (as RegisterDesk uses it) takes payments and issues refunds. Easy Split also
// settles to vendors and splits at capture. Folding all of that into one interface would
// force the Razorpay adapter to carry `settle()` and `split()` methods it must implement by
// throwing — which is a lie the type system would then help spread.
//
// Capabilities are therefore separate interfaces. A provider declares what it can do by
// which ones it implements, and a caller that needs splitting asks for a `SplitProvider`
// rather than a `PaymentProvider` it hopes is one.

/**
 * The canonical provider discriminator. ONE definition — string literals like 'razorpay'
 * must not be scattered through business logic.
 *
 * `cashfree` is declared but NOT selectable: no adapter is registered for it in this phase,
 * so `resolvePaymentProvider('cashfree')` throws. It is present so that the persisted
 * discriminator, the reconciliation reads and the tests can all be written against the real
 * union now, instead of a single-member union that widens later and silently invalidates
 * every exhaustiveness check written against it.
 */
export const PAYMENT_PROVIDERS = ['razorpay', 'cashfree'] as const
export type PaymentProvider = typeof PAYMENT_PROVIDERS[number]

/**
 * The provider every record predating this phase belongs to.
 *
 * READ/RECONCILIATION USE ONLY. A historical `paymentIntents` or `platformTransactions`
 * document has no `provider` field because Razorpay was the only possibility when it was
 * written, so reading it as Razorpay is a statement of fact, not a guess.
 *
 * It is deliberately NOT a default for writes. Guessing a provider for a NEW payment would
 * be routing money on an assumption; new records assign it explicitly and the compiler
 * enforces that by making the field required on the record types.
 */
export const LEGACY_PROVIDER: PaymentProvider = 'razorpay'

/** Normalizes a stored discriminator that may predate the field. Reads only. */
export function readProvider(stored: unknown): PaymentProvider {
  return stored === 'razorpay' || stored === 'cashfree' ? stored : LEGACY_PROVIDER
}

// ─── Normalized payment vocabulary ────────────────────────────────────────────

/**
 * Payment state, in RegisterDesk's words rather than a gateway's.
 *
 * `authorized` is kept distinct from `captured` because the recovery sweep already treats
 * them differently — an authorized payment is money held but not taken, and settling one is
 * a different decision from settling a capture.
 */
export type NormalizedPaymentStatus =
  | 'created' | 'pending' | 'authorized' | 'captured' | 'failed' | 'refunded'

/**
 * ═══ WHY `pending` EXISTS, AND WHY COLLAPSING IT IS A DOUBLE CHARGE ══════════
 *
 * RD-PAYMENT-CASHFREE-SANDBOX-05B measured a real sandbox UPI collect sitting at Cashfree's
 * PENDING for ~30 seconds before it turned SUCCESS. Razorpay's checkout hands back a payment
 * that is already captured, so RegisterDesk never needed a word for "in flight".
 *
 * Until this existed, PENDING and NOT_ATTEMPTED both normalized to `created`, and
 * /api/registrations/payment-status reads "not captured, not authorized" as
 * `awaiting_payment · canRetry: true` — it releases the form so the attendee can pay. Do that
 * while a UPI collect is still travelling and the attendee is invited to pay a second time
 * for a payment that is about to succeed.
 *
 * `pending` is therefore NOT a cosmetic state: it is the difference between "nobody has paid"
 * and "somebody is paying". It is never success — a pending payment settles nothing — and it
 * is never failure either.
 */

/**
 * Provider-specific data the BROWSER needs to open checkout.
 *
 * Discriminated on `provider` so the client cannot read Razorpay fields off a Cashfree order,
 * and so adding a provider is a compiler error at every switch rather than a silent fallthrough.
 *
 * This is the ONLY provider data that crosses to the client. It carries a public key id and a
 * session handle — never a client secret, a webhook secret, or any server configuration.
 */
export type CheckoutHandoff =
  | { provider: 'razorpay'; keyId: string }
  /**
   * `mode` tells the browser which Cashfree SDK environment to instantiate. It comes from the
   * SERVER's own `CASHFREE_ENV`, for the same reason the provider does: the client must not
   * infer it. A sandbox SDK opened against a production session (or the reverse) simply fails,
   * and the failure would look like a broken checkout rather than a misconfiguration.
   *
   * It is an ENVIRONMENT NAME, not a credential — `payment_session_id` remains the only
   * sensitive-ish value that crosses, and it is a single-use handle Cashfree itself issues.
   */
  | { provider: 'cashfree'; paymentSessionId: string; mode: CashfreeEnvironment }

/** Which Cashfree deployment a call is addressed to. Never inferred from NODE_ENV alone. */
export type CashfreeEnvironment = 'sandbox' | 'production'

/** An order opened at the provider, as the payment domain sees it. */
export interface NormalizedOrder {
  provider:        PaymentProvider
  providerOrderId: string
  amountPaise:     number
  currency:        'INR'
  /**
   * What the browser needs to launch this provider's checkout.
   *
   * Cashfree returns `payment_session_id` from Create Order and it is the ONLY token that can
   * open its checkout — RD-PAYMENT-CASHFREE-SANDBOX-05B proved the adapter was parsing it and
   * throwing it away, which is why a Cashfree order could be created but never paid.
   */
  checkout:        CheckoutHandoff
}

/** A payment the provider reports against an order. */
export interface NormalizedPayment {
  provider:          PaymentProvider
  providerPaymentId: string
  providerOrderId:   string | null
  status:            NormalizedPaymentStatus
  amountPaise:       number
  currency:          string
  /** Epoch ms when the provider says it was captured, when the provider reports one. */
  capturedAtMs:      number | null
}

/** The outcome of a refund request. Authorization happens ABOVE the adapter — see below. */
export interface NormalizedRefund {
  provider:         PaymentProvider
  providerRefundId: string
  status:           string
  amountPaise:      number
}

/** A provider event (webhook) reduced to what the payment domain acts on. */
export interface NormalizedProviderEvent {
  provider:    PaymentProvider
  /** The provider's own event id, where it sends one — the idempotency handle. */
  eventId:     string | null
  kind:        'PAYMENT_SUCCESS' | 'PAYMENT_FAILED' | 'REFUND_SUCCESS' | 'UNHANDLED'
  payment:     NormalizedPayment | null
  /** The provider's raw event name, kept for logs and reconciliation only. */
  providerEventName: string
}

// ─── Capabilities ─────────────────────────────────────────────────────────────

/** Taking money. Every provider implements this. */
export interface PaymentProviderAdapter {
  readonly id: PaymentProvider

  /**
   * Opens an order for an amount RegisterDesk has already decided.
   *
   * `customer` is OPTIONAL in the contract and REQUIRED by some providers. Razorpay opens an
   * order from an amount alone; Cashfree's Create Order refuses without `customer_details`
   * (a customer id and a 10-digit phone). It is optional here rather than mandatory because
   * making it required would change the Razorpay path — which this phase must not do — and
   * because RegisterDesk genuinely allows attendees with no phone number. A provider that
   * needs it fails closed with a clear message; it never invents a placeholder.
   */
  createOrder(input: {
    amountPaise: number
    currency:    'INR'
    receipt:     string
    customer?: {
      id:     string
      phone?: string
      email?: string
      name?:  string
    }
  }): Promise<NormalizedOrder>

  /**
   * The browser handoff for an order that ALREADY exists.
   *
   * create-order does not always mint a new order: an unchanged retry reuses one, and a lost
   * race hands back the winner's. Those paths must still tell the browser how to open
   * checkout, and they cannot simply repeat what `createOrder` returned because they never
   * called it.
   *
   * Razorpay answers from configuration (the publishable key id) and touches no network.
   * Cashfree must ask — `payment_session_id` is minted with the order and is deliberately NOT
   * persisted by RegisterDesk: a payment session is the provider's to hand out, and storing a
   * short-lived token would only create a second thing that can be stale or leak.
   */
  getCheckoutHandoff(providerOrderId: string): Promise<CheckoutHandoff>

  /**
   * Every payment the provider holds against an order.
   *
   * This is the reconciliation primitive: the capture sweep uses it to ask the provider
   * what actually happened, rather than trusting anything RegisterDesk stored.
   */
  fetchOrderPayments(providerOrderId: string): Promise<NormalizedPayment[]>

  /** One payment by its provider id. */
  fetchPayment(providerPaymentId: string): Promise<NormalizedPayment | null>

  /**
   * Verifies the signature a CHECKOUT returns through the browser.
   * Timing-safe, and false for anything malformed — never throws on bad input.
   */
  verifyCheckoutSignature(input: {
    providerOrderId:   string
    providerPaymentId: string
    signature:         string
  }): Promise<boolean>

  /** Verifies a webhook signature over the RAW body. */
  verifyWebhookSignature(rawBody: string, signature: string): Promise<boolean>
}

/**
 * Giving money back.
 *
 * Separate from `PaymentProviderAdapter` on purpose, and note what is NOT here: there is no
 * `mayRefund()` and no actor argument. The adapter performs a refund; it never decides
 * whether one is allowed. That decision lives in RegisterDesk behind `resolveSuperAdminUid`
 * (RD-PAYMENT-REFUND-AUTHORITY-02), and putting any part of it into a provider adapter
 * would create exactly the second authorization path that phase eliminated.
 */
export interface RefundProviderAdapter {
  readonly id: PaymentProvider
  /**
   * `providerOrderId` is optional in the contract and required by some providers: Razorpay
   * refunds a PAYMENT (`/payments/{id}/refund`), Cashfree refunds against an ORDER
   * (`/orders/{order_id}/refunds`). Rather than force every caller to supply both, the
   * contract carries both and each adapter takes what its API addresses — failing closed,
   * with a clear message, when its own required identifier is missing.
   *
   * `receipt` doubles as the merchant-supplied refund id where a provider offers one, which
   * is what makes a retry idempotent rather than a second refund.
   */
  refund(input: {
    providerPaymentId: string
    providerOrderId?:  string
    amountPaise:       number
    reason:            string
    receipt:           string
  }): Promise<NormalizedRefund>
}

/**
 * Marketplace settlement and split-at-capture.
 *
 * Declared so the shape of the Cashfree work is visible from here, and deliberately NOT
 * implemented by anything in this phase. Razorpay-as-configured does not split, so it does
 * not implement this — which is the whole reason capabilities are separate interfaces.
 */
export interface SplitProviderAdapter {
  readonly id: PaymentProvider
}
