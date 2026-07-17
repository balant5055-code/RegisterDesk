// Server-only. THE single runtime source for wallet settings after RD-CONF-05.
// Resolves the effective wallet configuration via the Business Configuration Engine
// (runtime override → Firestore config → code default), so nothing
// reads wallet constants directly.
//
// EXTENSIBLE (Step 8): an optional resolution context (organizerUid / eventId) is
// accepted now but NOT yet applied — future organizer/event override layers slot in
// here without changing any caller. Order will be:
//   Global Defaults → Business Configuration → Organizer Override → Event Override.

import { businessConfig } from '@/lib/config/businessConfigService'
import type { WalletConfig } from '@/lib/config/businessConfig'

export interface WalletResolutionContext {
  organizerUid?: string   // reserved for a future organizer-override layer
  eventId?:      string   // reserved for a future event-override layer
}

/** The effective wallet configuration. Never undefined. */
export async function getWalletConfig(context?: WalletResolutionContext): Promise<WalletConfig> {
  void context   // reserved: future organizer/event override layers hook in here
  return businessConfig.getSection('wallet')
}
