// Server-only. THE single runtime source for settlement settings after RD-CONF-07.
// Resolves the effective settlement configuration via the Business Configuration
// Engine (runtime override → Firestore config → code default), so
// nothing reads settlement constants directly.
//
// EXTENSIBLE (Step 8): an optional resolution context (organizerUid / eventId) is
// accepted now but NOT yet applied — future organizer/event override layers slot in
// here without changing any caller. Order will be:
//   Global Defaults → Business Configuration → Organizer Override → Event Override.

import { businessConfig } from '@/lib/config/businessConfigService'
import type { SettlementsConfig } from '@/lib/config/businessConfig'

export interface SettlementResolutionContext {
  organizerUid?: string   // reserved for a future organizer-override layer
  eventId?:      string   // reserved for a future event-override layer
}

/** The effective settlement configuration. Never undefined. */
export async function getSettlementConfig(context?: SettlementResolutionContext): Promise<SettlementsConfig> {
  void context   // reserved: future organizer/event override layers hook in here
  return businessConfig.getSection('settlements')
}
