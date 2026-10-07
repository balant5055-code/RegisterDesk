// RD-PAYMENT-PROVIDER-CONTRACT-04 · provider selection.
//
// ═══ WHY RESOLUTION THROWS INSTEAD OF FALLING BACK ═══════════════════════════
// The obvious shape here is `registry[id] ?? razorpayAdapter`. That is the one thing this
// module must not do. A fallback turns "this provider is not available" into "take the
// money through the other one", which is how an attendee ends up paying a gateway their
// organizer was never onboarded to — and it would do so silently, because a fallback has
// nothing to report.
//
// An unregistered provider is a programming error, so it fails like one, loudly, before any
// money moves.
//
// RD-PAYMENT-CASHFREE-SANDBOX-05 — Cashfree is now registered but GATED: resolution runs
// through `isProviderEnabled`, which requires an explicit sandbox flag, credentials, and a
// non-production NODE_ENV. Registered-but-disabled is the important distinction: the adapter
// exists and is testable, and an attendee payment still cannot reach it.

import type { PaymentProvider, PaymentProviderAdapter, RefundProviderAdapter } from '@/lib/payments/providers/types'
// `export *` below re-exports this, but a re-export is not a binding in this module's scope.
import { LEGACY_PROVIDER } from '@/lib/payments/providers/types'
import { razorpayAdapter } from '@/lib/payments/providers/razorpayAdapter'
import { cashfreeAdapter, isCashfreeConfigured, cashfreeEnvironment } from '@/lib/payments/providers/cashfreeAdapter'

export * from '@/lib/payments/providers/types'

/**
 * The providers that are actually wired up.
 *
 * Razorpay is the only entry, deliberately. Adding Cashfree is a later phase and is a
 * one-line change HERE plus an adapter — not a change anywhere in the payment domain, which
 * is the point of the contract.
 */
const REGISTRY: Partial<Record<PaymentProvider, PaymentProviderAdapter & Partial<RefundProviderAdapter>>> = {
  razorpay: razorpayAdapter,
  // Cashfree is REGISTERED but gated — see `isProviderEnabled`. Registering it lets the
  // adapter be resolved and tested without making it reachable by an attendee payment.
  cashfree: cashfreeAdapter,
}

/**
 * RD-PAYMENT-CASHFREE-SANDBOX-05 · Cashfree is OPT-IN and OFF BY DEFAULT.
 *
 * Three independent conditions, all of which must hold:
 *   1. `CASHFREE_SANDBOX_ENABLED === 'true'` — an explicit switch, not a side effect of
 *      credentials merely existing;
 *   2. credentials are present;
 *   3. NODE_ENV is not production — this phase is sandbox-only, so the flag cannot turn
 *      Cashfree on in production even if someone sets it there.
 *
 * Absent any of them, Cashfree is not enabled and `resolvePaymentProvider` throws. There is
 * deliberately no fallback to Razorpay: silently rerouting a payment to a different gateway
 * is worse than refusing, because it succeeds and nobody finds out.
 */
export function isCashfreeSandboxEnabled(): boolean {
  return (
    (process.env.CASHFREE_SANDBOX_ENABLED ?? '').trim() === 'true' &&
    cashfreeEnvironment() === 'sandbox' &&
    isCashfreeConfigured() &&
    process.env.NODE_ENV !== 'production'
  )
}

/**
 * ═══ CASHFREE PRODUCTION · PREPARED, AND OFF ════════════════════════════════
 *
 * This exists so that enabling production later is a CONFIGURATION change rather than
 * another pass through the payment architecture. It is off today and stays off until all
 * four conditions hold, none of which is satisfied by any current environment:
 *
 *   1. `CASHFREE_PRODUCTION_ENABLED === 'true'` — a flag that exists nowhere right now;
 *   2. `CASHFREE_ENV === 'production'` — the same switch that points the adapter at the
 *      production base URL, so the flag and the endpoint can never disagree;
 *   3. the PRODUCTION credentials are present — separate variables, so sandbox keys cannot
 *      satisfy this;
 *   4. `NODE_ENV === 'production'` — the mirror image of the sandbox gate. A developer
 *      machine cannot reach production Cashfree even with every other box ticked.
 *
 * Note the deliberate asymmetry with sandbox: sandbox requires NOT production, production
 * requires production. The two are mutually exclusive by construction, so there is no
 * configuration in which both are enabled and something has to choose between them.
 */
export function isCashfreeProductionEnabled(): boolean {
  return (
    (process.env.CASHFREE_PRODUCTION_ENABLED ?? '').trim() === 'true' &&
    cashfreeEnvironment() === 'production' &&
    isCashfreeConfigured() &&
    process.env.NODE_ENV === 'production'
  )
}

/** Cashfree is reachable at all — in either environment. */
export function isCashfreeEnabled(): boolean {
  return isCashfreeSandboxEnabled() || isCashfreeProductionEnabled()
}

/** Is this provider wired up AND permitted right now? */
export function isProviderEnabled(id: PaymentProvider): boolean {
  if (id === 'cashfree') return isCashfreeEnabled()
  return REGISTRY[id] !== undefined
}

/**
 * The provider used for NEW attendee payments. Decided by the SERVER, never by the client.
 *
 * ═══ WHY THIS READS AN ENV VAR AND STILL IS NOT A SWITCH ANYONE CAN FLIP ═════
 *
 * RD-PAYMENT-CASHFREE-CHECKOUT-06 needs a real browser to reach Cashfree, which was
 * impossible while this was the literal `'razorpay'`. It is now derived, but from FOUR
 * conditions that must all hold, none of which a request can influence:
 *
 *   1. `PAYMENT_PROVIDER === 'cashfree'` — a deliberate, explicit deployment choice;
 *   2. the Cashfree sandbox flag is on;
 *   3. credentials are present;
 *   4. NODE_ENV is not production.
 *
 * (2–4 are `isCashfreeSandboxEnabled`.) Anything else — unset, misspelled, production, no
 * credentials — yields Razorpay. There is no code path by which a query parameter, a header,
 * a cookie or a client flag reaches this function, which is the point: the browser is TOLD
 * which provider its order belongs to and never gets to ask for one.
 */
export function resolveActivePaymentProvider(): PaymentProvider {
  const requested = (process.env.PAYMENT_PROVIDER ?? '').trim().toLowerCase()
  if (requested === 'cashfree' && isCashfreeEnabled()) return 'cashfree'
  // Razorpay remains the default for every deployment that does not opt in, so an existing
  // production environment behaves exactly as it did before this phase.
  return LEGACY_PROVIDER
}

/**
 * Evaluated once at import, like the constant it replaces. Call
 * `resolveActivePaymentProvider()` directly where a fresh read matters (tests stub env and
 * reset modules, which re-evaluates this too).
 */
export const ACTIVE_PAYMENT_PROVIDER: PaymentProvider = resolveActivePaymentProvider()

/**
 * ═══ THE AUTHORITATIVE GATEWAY FOR A **NEW** ORDER ══════════════════════════
 *
 * Layered, most specific first:
 *   1. the admin setting `payments.activeProvider` (Firestore, audited, 60s-cached);
 *   2. the `PAYMENT_PROVIDER` deployment variable, which predates the admin switch;
 *   3. Razorpay.
 *
 * Then the provider GATES apply regardless of which layer answered. Choosing Cashfree in
 * the admin UI does not bypass credentials, the sandbox flag or the production gate — it
 * only expresses a preference that the gates may still refuse.
 *
 * ═══ WHAT THIS IS NOT FOR ════════════════════════════════════════════════════
 * It answers "which gateway should the NEXT order use?" and nothing else. It must never be
 * consulted to decide what an EXISTING payment was taken through — that is
 * `intent.provider`, persisted at creation. Verification, webhooks, refunds, status and
 * reconciliation all read the payment's own provider, so switching the setting cannot
 * strand or re-route a payment that already exists.
 *
 * ═══ FAIL-SAFE vs FAIL-CLOSED — TWO DIFFERENT FAILURES ══════════════════════
 *
 * FAIL-SAFE (no preference): a configuration read that errors, or a document with no
 * setting, resolves to the env/Razorpay layers. Nobody chose Cashfree, so continuing on the
 * incumbent gateway is the correct reading of "we don't know" — a config outage must not
 * stop attendees paying.
 *
 * FAIL-CLOSED (explicit preference refused): if an administrator has DELIBERATELY selected
 * Cashfree and the gates refuse it, this returns a refusal instead of a provider. Quietly
 * charging through Razorpay would contradict an explicit instruction about where money
 * goes, and it would do so invisibly to the attendee and the organizer. The order is not
 * created at all.
 *
 * The distinction is the presence of an explicit choice, not the severity of the failure.
 */
export type ActiveProviderResolution =
  | { ok: true;  provider: PaymentProvider }
  | { ok: false; reason: 'cashfree_not_ready' }

export async function resolveActivePaymentProviderForNewOrder(): Promise<ActiveProviderResolution> {
  let configured: string | null = null
  try {
    const { businessConfig } = await import('@/lib/config/businessConfigService')
    configured = (await businessConfig.getValue('payments', 'activeProvider')) ?? null
  } catch {
    // Unreadable config is not a payment outage. Fall through to the env layer.
    configured = null
  }

  const requested = (configured ?? process.env.PAYMENT_PROVIDER ?? '').trim().toLowerCase()

  if (requested === 'cashfree') {
    // The admin can SELECT Cashfree; only the gates can GRANT it.
    if (isCashfreeEnabled()) return { ok: true, provider: 'cashfree' }

    // Explicitly chosen and refused → STOP. No Razorpay order is minted as a substitute:
    // routing money through a gateway nobody selected is a worse outcome than declining the
    // payment, because it succeeds and therefore nobody investigates.
    //
    // AWAITED, not fire-and-forget. A refusal only happens on a misconfiguration, so the
    // cost is paid almost never — and awaiting turns "we try to report this" into "this is
    // reported before the caller is told", which is the guarantee worth having.
    await reportRefusedGatewayPreference()
    return { ok: false, reason: 'cashfree_not_ready' }
  }

  // No preference, or Razorpay explicitly. Either way the incumbent gateway.
  return { ok: true, provider: LEGACY_PROVIDER }
}

/** Reported, never silent — a refused preference is a misconfiguration someone must see. */
async function reportRefusedGatewayPreference(): Promise<void> {
  try {
    const { captureFinancialError } = await import('@/lib/monitoring/sentry')
    captureFinancialError('gateway_preference_refused', {
      scope:  'providers.active_provider_refused',
      detail: 'payments.activeProvider selects cashfree but the provider gates refuse it; ' +
              'new payment orders are BLOCKED — no razorpay order is created as a fallback',
    })
  } catch { /* reporting must never break order creation */ }
}

export function resolvePaymentProvider(id: PaymentProvider): PaymentProviderAdapter {
  const adapter = isProviderEnabled(id) ? REGISTRY[id] : undefined
  if (!adapter) {
    throw new Error(
      `[payments] Provider '${id}' is not enabled. Refusing to fall back to another ` +
      `gateway — a payment must go to the provider it was created for.`,
    )
  }
  return adapter
}

export function resolveRefundProvider(id: PaymentProvider): RefundProviderAdapter {
  // Goes through the SAME gate as payments. Resolving a refund adapter for a provider that
  // is not enabled would be a hole in the opposite direction: money leaving through a
  // gateway that is not permitted to take any.
  const adapter = isProviderEnabled(id) ? REGISTRY[id] : undefined
  if (!adapter || typeof (adapter as RefundProviderAdapter).refund !== 'function') {
    throw new Error(`[payments] Provider '${id}' cannot issue refunds.`)
  }
  return adapter as RefundProviderAdapter
}
