// RD-PLATFORM-COMMS-01 Phase 4C — Communication Registry resolver (server-only).
//
// Enriches the declarative catalog (./catalog) with the channel SUPPORT + ENABLED state that
// must be DERIVED from real runtime sources rather than duplicated:
//   • email support  — every NotificationType has an email dispatcher/template (always true)
//   • whatsapp support — presence in the canonical WhatsApp template registry (lib/whatsapp)
//   • sms / push      — the CHANNEL_CAPABILITIES SSOT (no transport → false)
//   • enabled         — the platform email channel enablement from the communication config
//
// READ-ONLY: reads the same canonical sources the send path uses; sends/mutates nothing and
// changes no dispatch, template, or policy behavior.

import { COMMUNICATION_REGISTRY, type CommRegistryEntry } from './catalog'
import { WHATSAPP_TEMPLATE_REGISTRY } from '@/lib/whatsapp'
import { isChannelImplemented } from '@/lib/communications/health/channels'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'

export interface ResolvedRegistryEntry extends CommRegistryEntry {
  supports: {
    email:    boolean
    whatsapp: boolean
    inapp:    boolean
    sms:      boolean
    push:     boolean
  }
  defaultChannels: string[]   // channels this notification uses by default
  enabled:         boolean     // able to fire today (platform email channel is on)
}

function hasWhatsAppTemplate(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(WHATSAPP_TEMPLATE_REGISTRY, id)
}

/** Resolve the full registry with derived channel support + enabled state. */
export async function resolveCommunicationRegistry(): Promise<ResolvedRegistryEntry[]> {
  const cfg          = await getCommunicationConfig()
  const emailEnabled = cfg.email.enabled

  return COMMUNICATION_REGISTRY.map((e): ResolvedRegistryEntry => {
    const supports = {
      email:    true,                       // every notification has an email template/dispatcher
      whatsapp: hasWhatsAppTemplate(e.id),  // canonical WhatsApp template registry
      inapp:    e.supportsInApp,
      sms:      isChannelImplemented('sms'),  // false — no transport
      push:     isChannelImplemented('push'), // false — no transport
    }
    const defaultChannels = [
      'email',
      ...(supports.whatsapp ? ['whatsapp'] : []),
      ...(supports.inapp ? ['inapp'] : []),
    ]
    return { ...e, supports, defaultChannels, enabled: emailEnabled }
  })
}
