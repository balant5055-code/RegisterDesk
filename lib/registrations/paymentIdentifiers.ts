// The provider-neutral way to read a registration's payment identifiers.
//
// ═══ WHY A RESOLVER RATHER THAN A MIGRATION ═════════════════════════════════
//
// `registrations.razorpayOrderId` was written by EVERY settlement path, so it held whichever
// provider's order id settled the registration — a field named for one gateway carrying
// another's identifier. New writes fix that at the source (`paymentOrderId` +
// `paymentProvider`), but historical documents cannot be un-written.
//
// A bulk backfill was considered and rejected as unnecessary, on a fact rather than a hope:
// NO PRODUCTION REGISTRATION CAN CONTAIN A CASHFREE ORDER ID. Cashfree has never been the
// active provider in any deployment — `ACTIVE_PAYMENT_PROVIDER` was the literal 'razorpay'
// until the checkout phase, `PAYMENT_PROVIDER` is unset everywhere, and production Cashfree
// is disabled behind four gates. The only records that ever carried a Cashfree id in that
// field were created in the emulator during sandbox testing.
//
// So the legacy fallback below is unambiguous by construction: a document with only
// `razorpayOrderId` is a Razorpay document. That is what makes rewriting millions of
// historical records — a risky, un-reviewable operation on financial data — unnecessary.
//
// The helpers still take provider information into account where it exists, so the day that
// assumption stops holding, the stored discriminator wins over the inference.

import { readProvider, type PaymentProvider } from '@/lib/payments/providers/types'

/**
 * The subset of a registration these helpers read.
 *
 * Every field is `unknown` because the callers genuinely hold loose shapes — Firestore
 * snapshots, finance joins declared with `unknown` fields, serialized rows. The helpers
 * below narrow with `typeof` anyway, so accepting `unknown` is honest rather than lax: it
 * lets every real caller pass its document without a cast, and a cast is exactly how a
 * reader ends up bypassing this module.
 */
export interface RegistrationPaymentIdentifiers {
  paymentOrderId?:  unknown
  razorpayOrderId?: unknown
  paymentProvider?: unknown
}

/**
 * Which gateway took the money for this registration.
 *
 * Absent ⇒ `razorpay`. Identical in spirit to `readProvider` on the payment intent: a
 * statement of fact about history, not a guess — every registration written before the
 * discriminator existed was Razorpay's.
 */
export function resolveRegistrationProvider(
  reg: RegistrationPaymentIdentifiers | null | undefined,
): PaymentProvider {
  return readProvider(reg?.paymentProvider)
}

/**
 * The provider order id, wherever it happens to live.
 *
 * `paymentOrderId` wins when present. `razorpayOrderId` is the legacy location and is only
 * consulted as a fallback — never merged, never preferred.
 *
 * Returns null rather than '' so "no order" is distinguishable from "an empty string was
 * stored", which matters to the callers that query on this value.
 */
export function resolveRegistrationOrderId(
  reg: RegistrationPaymentIdentifiers | null | undefined,
): string | null {
  const canonical = typeof reg?.paymentOrderId === 'string' ? reg.paymentOrderId.trim() : ''
  if (canonical) return canonical
  const legacy = typeof reg?.razorpayOrderId === 'string' ? reg.razorpayOrderId.trim() : ''
  return legacy || null
}

/**
 * The fields to WRITE on a newly settled registration.
 *
 * One place decides the shape, so the settlement transaction cannot drift from what the
 * readers expect. `razorpayOrderId` is mirrored ONLY for Razorpay:
 *
 *   · it keeps every existing reader, export column and support lookup working exactly as
 *     before for the provider that has all the history;
 *   · and it stops the misnaming at the source — a Cashfree registration simply does not
 *     have the field, rather than having it filled with something that is not a Razorpay id.
 */
export function buildRegistrationPaymentFields(
  provider: unknown, orderId: string,
): { paymentOrderId: string; paymentProvider: PaymentProvider; razorpayOrderId?: string } {
  // NORMALIZED here, deliberately, rather than trusting the caller to have done it.
  //
  // `PaymentIntentRecord.provider` is non-optional on the type but absent on every document
  // written before the discriminator existed, and any caller that materialised its intent
  // with a raw `doc.data() as PaymentIntentRecord` hands over `undefined` while the compiler
  // reports a valid provider. Taking it at face value would compare `undefined === 'razorpay'`,
  // skip the legacy mirror, and quietly stop writing `razorpayOrderId` for Razorpay
  // registrations — breaking every existing reader for the provider that has all the history.
  const resolved = readProvider(provider)
  return {
    paymentOrderId:  orderId,
    paymentProvider: resolved,
    ...(resolved === 'razorpay' ? { razorpayOrderId: orderId } : {}),
  }
}
