// Server-only. THE single runtime source for communication settings after
// RD-CONF-04. Resolves the effective communication configuration via the Business
// Configuration Engine (runtime override → Firestore config → code default), so
// nothing reads communication constants directly.
//
// EXTENSIBLE (Step 8): an optional resolution context (organizerUid / eventId) is
// accepted now but NOT yet applied. Future organizer- and event-override layers
// slot in here — callers already pass (or omit) the context, so adding those layers
// changes no call site. Order will be:
//   Global Defaults → Business Configuration → Organizer Override → Event Override.

import { businessConfig } from '@/lib/config/businessConfigService'
import type { CommunicationConfig } from '@/lib/config/businessConfig'

export interface CommunicationResolutionContext {
  organizerUid?: string   // reserved for a future organizer-override layer
  eventId?:      string   // reserved for a future event-override layer
}

/** The effective communication configuration. Never undefined. */
export async function getCommunicationConfig(
  context?: CommunicationResolutionContext,
): Promise<CommunicationConfig> {
  void context   // reserved: future organizer/event override layers hook in here
  return businessConfig.getSection('communication')
}

// ─── Convenience accessors (single source — callers never read constants) ────────

export async function getWhatsappPricePaise(ctx?: CommunicationResolutionContext): Promise<number> {
  return (await getCommunicationConfig(ctx)).whatsapp.pricePaise
}

export async function getSmsPricePaise(ctx?: CommunicationResolutionContext): Promise<number> {
  return (await getCommunicationConfig(ctx)).sms.pricePaise
}

export async function isChannelEnabled(
  channel: 'email' | 'whatsapp' | 'sms',
  ctx?: CommunicationResolutionContext,
): Promise<boolean> {
  return (await getCommunicationConfig(ctx))[channel].enabled
}
