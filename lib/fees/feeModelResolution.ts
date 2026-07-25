// RD-PAYMENT-02 — canonical per-event fee-model resolution. PURE: no I/O, no SDK deps,
// so it is safe to import from BOTH the server (ledger pipeline) and the client (Event
// Builder previews). Extracted from resolveFeeConfig.ts in Phase 3 so the wizard can
// resolve the effective fee model without pulling the server-only config service
// (businessConfigService → firebase-admin). resolveFeeConfig.ts re-exports everything
// here, so existing server importers are unchanged.

import type { FeeModel } from './types'

export interface FeeResolutionContext {
  organizerUid?: string   // reserved for a future organizer-override layer
  eventId?:      string   // reserved for a future event-override layer
  // Candidate fee models, consulted in precedence order by resolveEffectiveFeeModel:
  // Event → Organizer → Platform → default organizer_pays. All OPTIONAL; when none is
  // supplied the effective model is organizer_pays (today's universal case).
  eventFeeModel?:     FeeModel | null   // from the event's pricing.feeModel, mapped builder→engine
  organizerFeeModel?: FeeModel | null   // reserved: an organizer-level default (none today)
  platformFeeModel?:  FeeModel | null   // reserved: platform commercial model (dormant → organizer_pays)
}

// The universal fallback fee model — production has always been organizer_pays.
export const DEFAULT_FEE_MODEL: FeeModel = 'organizer_pays'

/**
 * Canonical per-event fee-model resolution. Applies the precedence
 * Event → Organizer → Platform → default organizer_pays. Pure. Every event today resolves
 * to organizer_pays (the builder value is "Coming Soon"-locked, and the organizer/platform
 * layers are dormant), so this is behaviour-neutral until later phases populate candidates.
 */
export function resolveEffectiveFeeModel(context: FeeResolutionContext = {}): FeeModel {
  return context.eventFeeModel
    ?? context.organizerFeeModel
    ?? context.platformFeeModel
    ?? DEFAULT_FEE_MODEL
}
