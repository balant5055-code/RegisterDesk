// RD-PREPROD · who may SELECT Cashfree in the admin Business Configuration — pure, no imports.
//
// `payments.activeProvider` lives in the ONE production Firestore. Selecting 'cashfree' while
// the Cashfree production gate is shut does not fall back to Razorpay — by design
// (resolveActivePaymentProviderForNewOrder FAILS CLOSED on a refused explicit choice), so it
// stops every new attendee payment. The save is therefore refused up front instead of being
// discovered at checkout.
//
// The one exception is a Firestore EMULATOR with the Cashfree SANDBOX gate open: that config
// document cannot reach production, and it is how the sandbox checkout is exercised locally.
// Selecting Razorpay is never refused.

export interface CashfreeGateState {
  productionEnabled: boolean   // isCashfreeProductionEnabled()
  sandboxEnabled:    boolean   // isCashfreeSandboxEnabled()
  emulator:          boolean   // FIRESTORE_EMULATOR_HOST is set
}

/** The refusal message, or null when the selection may be saved. */
export function activeProviderSelectionRefusal(requested: unknown, gates: CashfreeGateState): string | null {
  if (requested !== 'cashfree') return null
  if (gates.productionEnabled) return null
  if (gates.emulator && gates.sandboxEnabled) return null
  return 'Cashfree cannot be selected: Cashfree production is not enabled on this deployment. ' +
         'Selecting it would block every new payment (there is no fallback to Razorpay).'
}
