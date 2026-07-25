// RD-PLATFORM-COMMS-01 Phase 4I — pure playground projections (isomorphic, server-free).
//
// The honest per-channel timeline-stage reachability, split out so it is testable without
// pulling the server resolvers. Pure — no I/O.

import type { TemplateChannel } from '@/lib/communications/templates/registry'
import type { TimelineStatus } from '@/lib/communications/timeline/types'
import type { TimelineStageProjection } from './types'

export const STAGES: TimelineStatus[] = ['queued', 'accepted', 'sent', 'delivered', 'opened', 'clicked', 'failed', 'cancelled']

/** Which lifecycle stages a channel can actually reach today (honest projection). PURE. */
export function reachableStages(channel: TemplateChannel): TimelineStageProjection[] {
  const email = channel === 'email'
  const wa    = channel === 'whatsapp'
  const inapp = channel === 'inapp'
  const note = (s: TimelineStatus): string => {
    if (s === 'delivered' && email) return 'Email delivery is not tracked yet (no bounce webhook)'
    if ((s === 'opened' || s === 'clicked') && email) return 'Email engagement tracking is not wired'
    if (s === 'opened' && wa) return 'WhatsApp "read" maps to opened'
    if (s === 'clicked') return 'Not tracked for this channel'
    return ''
  }
  const reach = (s: TimelineStatus): boolean => {
    switch (s) {
      case 'queued': case 'accepted': case 'sent': case 'failed': case 'cancelled': return true
      case 'delivered': return wa || inapp
      case 'opened':    return wa
      case 'clicked':   return false
      default:          return false
    }
  }
  return STAGES.map(stage => ({ stage, reachable: reach(stage), note: note(stage) }))
}

export function providerFor(channel: TemplateChannel): string {
  return channel === 'whatsapp' ? 'meta' : channel === 'inapp' ? 'inapp' : 'ses'
}
