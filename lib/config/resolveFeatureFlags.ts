// Server-only. THE single runtime source for platform feature toggles after
// RD-CONF-08. Resolves the effective feature flags via the Business Configuration
// Engine (runtime override → Firestore config → code default).
//
// Feature flags are GLOBAL master switches layered ABOVE any per-license / per-
// channel gate — they never replace them (e.g. whatsapp/sms stay governed by
// communication config; customDomains/whiteLabel/publicApi by license entitlements).
//
// EXTENSIBLE (Step 8): an optional resolution context (organizerUid / eventId) is
// accepted now but NOT yet applied — future organizer/event override layers slot in
// here without changing any caller.

import { businessConfig } from '@/lib/config/businessConfigService'
import type { FeatureFlagsConfig } from '@/lib/config/businessConfig'

export interface FeatureFlagsContext {
  organizerUid?: string   // reserved for a future organizer-override layer
  eventId?:      string   // reserved for a future event-override layer
}

/** The effective feature flags. Never undefined. */
export async function getFeatureFlags(context?: FeatureFlagsContext): Promise<FeatureFlagsConfig> {
  void context   // reserved: future organizer/event override layers hook in here
  return businessConfig.getSection('featureFlags')
}
