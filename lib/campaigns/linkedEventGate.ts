// ─── A donation campaign linked to an event is public only while its event is ──
//
// An `event_plus_donation` submission writes donationCampaigns/{slug} with status 'active'
// in the SAME transaction that creates the event as 'pending_review' (app/api/events/publish).
// Every campaign gate checked only the campaign's own status / visibility / moderation, so
// the campaign of an event nobody had approved was publicly reachable, listed on /causes and
// in the sitemap, and accepted real donation orders. Rejecting, requesting changes,
// unpublishing, cancelling or archiving the event never touched the campaign either.
//
// The rule, enforced READ-SIDE (no migration, nothing written):
//   • a campaign with no linked event (a standalone donation_only campaign) is unaffected;
//   • a linked campaign is available only when its event passes the canonical public-event
//     gate (isPubliclyViewable — the lifecycle allow-list plus moderation) AND is not
//     cancelled. A cancelled event still shows its cancellation notice, but is not something
//     to raise money for — the sitemap already excludes cancelled events for the same reason.
//   • a linked event that cannot be read or does not exist fails CLOSED.
//
// Applied at every public boundary: the /campaign/[slug] layout gate, donation-order
// creation, /causes (listCampaigns), the sitemap, and the event page's donation panel.
// Completing a payment for an order that already exists (verify / webhook) is deliberately
// NOT gated: that money has been taken, and refusing to record it would strand it.

import { adminDb } from '@/lib/firebase/admin'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { isPubliclyViewable, type PublicGateSubject } from '@/lib/events/publicEventGate'
import { deriveLifecycleStatus } from '@/lib/events/lifecycleStateMachine'

/** The campaign fields this gate reads — any campaign document satisfies it. */
export interface LinkedCampaignSubject {
  slug?:            unknown
  campaignType?:    unknown
  linkedEventSlug?: unknown
  linkedEventId?:   unknown
}

const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * The slug of the event this campaign belongs to, or null for a standalone campaign.
 * An `event_plus_donation` campaign is always linked — if its pointer fields are missing it
 * falls back to its own slug (publish writes both with the same value), never to "unlinked".
 */
export function linkedEventSlugOf(c: LinkedCampaignSubject, docId?: string): string | null {
  const explicit = nonEmpty(c.linkedEventSlug) ?? nonEmpty(c.linkedEventId)
  if (explicit) return explicit
  if (c.campaignType === 'event_plus_donation') return nonEmpty(c.slug) ?? nonEmpty(docId)
  return null
}

/** PURE. May a campaign linked to this event be shown publicly / take donations? */
export function linkedEventAllowsCampaign(event: PublicGateSubject | null | undefined): boolean {
  return isPubliclyViewable(event) && event.lifecycleStatus !== 'cancelled'
}

/** One campaign: true when it is standalone, or its linked event allows it. */
export async function campaignLinkedEventAllows(c: LinkedCampaignSubject, docId?: string): Promise<boolean> {
  const eventSlug = linkedEventSlugOf(c, docId)
  if (!eventSlug) return true
  try {
    return linkedEventAllowsCampaign(await getEventBySlug(eventSlug))
  } catch {
    return false
  }
}

/**
 * Many campaigns at once (listings, sitemap): the set of linked EVENT slugs that allow their
 * campaign. One batched read; any failure yields an empty set, i.e. every linked campaign is
 * withheld (fail closed) while standalone campaigns are unaffected.
 */
export async function linkedEventsAllowingCampaigns(eventSlugs: Iterable<string>): Promise<Set<string>> {
  const unique = Array.from(new Set(Array.from(eventSlugs).filter(Boolean)))
  const allowed = new Set<string>()
  if (!unique.length) return allowed
  try {
    for (let i = 0; i < unique.length; i += 300) {
      const refs  = unique.slice(i, i + 300).map(s => adminDb.collection('events').doc(s))
      const snaps = await adminDb.getAll(...refs, { fieldMask: ['lifecycleStatus', 'status', 'moderationStatus'] })
      for (const s of snaps) {
        if (!s.exists) continue
        const raw = s.data() as Record<string, unknown>
        // Same lifecycle derivation getEventBySlug applies, so a legacy event without the
        // field answers identically here and in the single-campaign path.
        const subject = { lifecycleStatus: deriveLifecycleStatus(raw), moderationStatus: raw.moderationStatus } as PublicGateSubject
        if (linkedEventAllowsCampaign(subject)) allowed.add(s.id)
      }
    }
  } catch {
    return new Set()
  }
  return allowed
}
