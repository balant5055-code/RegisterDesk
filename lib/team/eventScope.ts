// RD-CHECKIN-STAFF-01 — event-assignment enforcement for gate-only roles.
//
// `teamMembers.eventIds` stores eventDraft ids (what `/dashboard/events/[eventId]`
// and `/ops/checkin/[eventId]` address an event by). Registrations, however, carry
// an `eventSlug`. The gate scan path only ever knows the slug, so enforcing scope
// there needs an id→slug resolution.
//
// ═══ WHY A CACHE ═════════════════════════════════════════════════════════════
// A gate operator scans up to 120 tickets/minute against ONE event for hours. A
// naive resolver would add a Firestore read per assigned event per scan — measured
// at ~287 ms each from the serving region, which is the difference between a gate
// that keeps up with a queue and one that does not. The assignment is small,
// slow-moving data, so it is resolved once and reused.
//
// Bounded and short-lived, exactly like lib/certificates/generate.ts's template
// cache: a lambda serving a scan burst pays the read once, and a re-assignment is
// picked up within the TTL. Scope can only ever NARROW access, and the fail path
// below is closed, so a stale entry cannot widen it.

import { adminDb } from '@/lib/firebase/admin'
import { isCheckinOnlyRole } from '@/lib/team/types'
import type { WorkspaceContext } from '@/lib/team/workspace'

const SLUG_TTL_MS = 2 * 60_000
const SLUG_MAX    = 200

const _slugCache = new Map<string, { at: number; slug: string | null }>()

/** Test seam — lets a suite assert cold-path behaviour deterministically. */
export function __clearEventScopeCache(): void { _slugCache.clear() }

/**
 * The published slug for one of a workspace's events, or null when the event does
 * not exist in that workspace.
 *
 * Reads the SAME document the check-in surfaces already use to prove ownership
 * (`users/{workspaceUid}/eventDrafts/{eventId}`), so it introduces no new trust
 * path — an id belonging to another workspace simply resolves to null.
 */
export async function resolveEventSlug(workspaceUid: string, eventId: string): Promise<string | null> {
  const key = `${workspaceUid}:${eventId}`
  const hit = _slugCache.get(key)
  if (hit && Date.now() - hit.at < SLUG_TTL_MS) return hit.slug

  const snap = await adminDb.doc(`users/${workspaceUid}/eventDrafts/${eventId}`).get()
  const draft   = snap.exists ? snap.data() as Record<string, unknown> : null
  const details = draft?.eventDetails as Record<string, unknown> | null
  const seo     = details?.seo as Record<string, unknown> | null
  const slug    = typeof seo?.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null

  if (_slugCache.size >= SLUG_MAX) {
    const oldest = [..._slugCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) _slugCache.delete(oldest[0])
  }
  _slugCache.set(key, { at: Date.now(), slug })
  return slug
}

/**
 * May this caller act on the event identified by `eventSlug`?
 *
 * Mirrors requireEventScope() (which works on ids) for the slug-only paths. The
 * rules are identical and deliberately stated in the same order:
 *   • owners and non-gate roles          → unrestricted
 *   • gate role with no assignment ([])  → unrestricted (rows predating this field)
 *   • gate role with an assignment       → the slug must belong to an assigned event
 *
 * FAILS CLOSED: if an assigned id cannot be resolved to a slug, that assignment
 * simply does not match, so an unresolvable assignment denies rather than admits.
 */
export async function isEventSlugInScope(ctx: WorkspaceContext, eventSlug: string): Promise<boolean> {
  if (ctx.isOwner) return true
  if (!isCheckinOnlyRole(ctx.role)) return true
  if (ctx.eventIds.length === 0) return true
  if (!eventSlug) return false

  const slugs = await Promise.all(
    ctx.eventIds.map(id => resolveEventSlug(ctx.workspaceUid, id).catch(() => null)),
  )
  return slugs.includes(eventSlug)
}
