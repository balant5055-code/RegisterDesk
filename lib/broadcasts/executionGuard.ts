// RD-COMMS-P2-B — the EXECUTION-TIME gate of a broadcast. Server-only.
//
// The create route checks the organizer and the broadcast flag once, when the campaign is
// created. A scheduled campaign starts later, and a running job keeps sending for minutes; in
// between the organizer can be suspended, the broadcast feature switched off, the event
// cancelled / unpublished / taken down / archived, or WhatsApp disabled. This re-reads that
// authoritative state where sending actually happens — before a scheduled campaign is charged
// and started (send.ts) and at the start of every job chunk (each strategy's loadContext).
//
// It composes EXISTING authoritative checks only — no new policy:
//   organizer   isModerated (lib/admin/organizerStatus — the suspension/ban seam)
//   feature     getFeatureFlags().broadcast (the global broadcast switch the create route checks)
//   event       isContentTakenDown(moderationStatus) + effectiveLifecycleStatus — the same states
//               lib/registrations/gate.ts treats as unavailable / cancelled / not live, plus
//               archived. A published, registration-closed or COMPLETED event may still be
//               messaged (post-event communication, e.g. certificates).
//   WhatsApp    communication.whatsapp.enabled + the event's pricing.whatsappEnabled (exactly
//               what every transactional WhatsApp path checks)
//   email       communication.email.enabled (the platform email kill switch)
// A blocked broadcast is TERMINAL ('failed' with this reason) — it is never retried.

import { adminDb } from '@/lib/firebase/admin'
import { isModerated } from '@/lib/admin/organizerStatus'
import { getFeatureFlags } from '@/lib/config/resolveFeatureFlags'
import { isContentTakenDown } from '@/lib/admin/moderation'
import { effectiveLifecycleStatus } from '@/lib/events/listingTabs'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import type { ModerationStatus } from '@/lib/admin/moderation'

export type BroadcastBlockReason =
  | 'organizer_suspended' | 'broadcasts_disabled'
  | 'event_unavailable' | 'event_cancelled' | 'event_not_live'
  | 'whatsapp_disabled' | 'email_disabled'

/** Lifecycle states in which an event's attendees must not be broadcast to (beyond `cancelled`). */
const NOT_LIVE = new Set(['pending_review', 'changes_requested', 'draft', 'unpublished', 'archived'])

/** Prefix a job's systemic error carries when the gate stopped it (see blockReasonOf). */
const BLOCKED_PREFIX = 'blocked:'
export const blockedJobError = (r: BroadcastBlockReason) => `${BLOCKED_PREFIX}${r}`
/** The block reason a job error carries, or null for any other failure. */
export function blockReasonOf(error: unknown): BroadcastBlockReason | null {
  return typeof error === 'string' && error.startsWith(BLOCKED_PREFIX) ? error.slice(BLOCKED_PREFIX.length) as BroadcastBlockReason : null
}

/** The EVENT half of the gate, on an already-read event doc (null = missing): not this organizer's,
 *  taken down, cancelled or not live. Pure. Shared with reminder dispatch (RD-COMMS-P2-E). */
export function eventExecutionBlock(
  ev: Record<string, unknown> | null, organizerUid: string,
): 'event_unavailable' | 'event_cancelled' | 'event_not_live' | null {
  if (!ev || ev.uid !== organizerUid) return 'event_unavailable'
  if (isContentTakenDown(ev.moderationStatus as ModerationStatus | undefined)) return 'event_unavailable'
  const ls = effectiveLifecycleStatus(ev)
  if (ls === 'cancelled') return 'event_cancelled'
  if (NOT_LIVE.has(ls)) return 'event_not_live'
  return null
}

/** Why this broadcast may NOT send right now, or null when it may. */
export async function broadcastExecutionBlock(args: {
  organizerUid: string; eventSlug: string; channel: string
}): Promise<BroadcastBlockReason | null> {
  if (await isModerated(args.organizerUid)) return 'organizer_suspended'
  if (!(await getFeatureFlags()).broadcast) return 'broadcasts_disabled'

  const snap = args.eventSlug ? await adminDb.collection('events').doc(args.eventSlug).get() : null
  const ev = snap?.exists ? snap.data() as Record<string, unknown> : null
  const eventBlock = eventExecutionBlock(ev, args.organizerUid)
  if (eventBlock) return eventBlock

  const comm = await getCommunicationConfig()
  if (args.channel === 'whatsapp') {
    const pricing = ev?.pricing as { whatsappEnabled?: unknown } | undefined   // ev is non-null past eventExecutionBlock
    if (!comm.whatsapp.enabled || pricing?.whatsappEnabled !== true) return 'whatsapp_disabled'
  } else if (args.channel === 'email') {
    if (!comm.email.enabled) return 'email_disabled'
  }
  return null
}
