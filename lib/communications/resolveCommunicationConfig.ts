// Server-only. THE single runtime source for communication settings after
// RD-CONF-04. Resolves the effective communication configuration across the canonical
// hierarchy so nothing reads communication constants — or merges configuration — directly:
//
//   Platform (Business Configuration)  <  Organizer override  <  Event override
//
// RD-COMMS-01 Phase 3: the organizer/event override LAYERS are now live via the canonical
// resolveCommunicationConfiguration resolver. Their STORAGE does not exist yet (it lands with
// the Phase 4 organizer settings UI + per-event config), so the loaders below return null and
// resolution collapses to the platform layer — byte-identical to prior behavior, and the send
// hot path (getCommunicationConfig() with no context) takes an early return with no extra I/O.

import { businessConfig } from '@/lib/config/businessConfigService'
import type { CommunicationConfig } from '@/lib/config/businessConfig'
import {
  resolveCommunicationConfiguration,
  type CommunicationConfigOverride,
} from '@/lib/communications/config/resolver'

export interface CommunicationResolutionContext {
  organizerUid?: string   // organizer-override layer scope
  eventId?:      string   // event-override layer scope
}

// ─── Override-layer loaders (Phase 4 storage seam) ───────────────────────────────
// These are the ONLY place future organizer/event communication overrides are fetched.
// Returning null today keeps resolution on the platform layer with zero added reads.

async function loadOrganizerCommunicationOverride(
  organizerUid: string,
): Promise<CommunicationConfigOverride | null> {
  void organizerUid   // Phase 4: read the organizer's saved communication override here.
  return null
}

async function loadEventCommunicationOverride(
  eventId: string,
): Promise<CommunicationConfigOverride | null> {
  void eventId        // Phase 4: read the event's saved communication override here.
  return null
}

/** The effective communication configuration for a scope. Never undefined. Resolves the full
 *  Platform → Organizer → Event hierarchy through the canonical resolver. */
export async function getCommunicationConfig(
  context?: CommunicationResolutionContext,
): Promise<CommunicationConfig> {
  const platform = await businessConfig.getSection('communication')

  // Fast path: platform-only resolution (the send/billing/reminder hot path). Identical to
  // the pre-Phase-3 behavior — no override loads, no re-merge.
  if (!context?.organizerUid && !context?.eventId) return platform

  const [organizer, event] = await Promise.all([
    context.organizerUid ? loadOrganizerCommunicationOverride(context.organizerUid) : Promise.resolve(null),
    context.eventId      ? loadEventCommunicationOverride(context.eventId)          : Promise.resolve(null),
  ])
  return resolveCommunicationConfiguration(platform, organizer, event)
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
