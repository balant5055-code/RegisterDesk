// RD-RACEOPS-01 Sprint 3 · Event read — SERVER ONLY.
//
// READ-ONLY BY CONSTRUCTION. This module exposes no write method, so no caller can mutate
// an event, a draft, a registration or an identifier even by mistake.
//
// Resolves eventId → (slug, pass) and proves ownership. The resolution shape is taken from
// the canonical existing implementation, lib/registrations/importContext.ts:38-45, so
// Race Operations agrees with the rest of the platform about what "the organizer owns this
// event" means: the document exists at `users/{uid}/eventDrafts/{eventId}`, full stop.

import { adminDb } from '@/lib/firebase/admin'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { bibKey } from '@/features/race-operations/utils/publicKeys'
import type { RosterEntry } from '@/features/race-operations/import/validation/registrationMatch'

export interface ResolvedRace {
  eventId:   string
  eventSlug: string
  eventName: string
  /** Event start date, ISO yyyy-mm-dd, when the draft records one. Public display + JSON-LD. */
  eventDate: string | null
  passId:    string
  passName:  string
}

export type ResolveRaceOutcome =
  | { ok: true;  race: ResolvedRace }
  | { ok: false; status: number; error: string }

interface PassRecord { id?: unknown; name?: unknown }

/**
 * Resolves one (eventId, passId) pair for a workspace.
 *
 * `workspaceUid` MUST be `authz.workspaceUid` — never a caller-supplied value. Ownership
 * is the path: an event the workspace does not own is simply absent → 404.
 */
export async function resolveRace(
  workspaceUid: string,
  eventId:      string,
  passId:       string,
): Promise<ResolveRaceOutcome> {
  const draftSnap = await adminDb.doc(`users/${workspaceUid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return { ok: false, status: 404, error: 'Event not found' }

  const draft = draftSnap.data() as Record<string, unknown>
  const details = (draft.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo  as Record<string, unknown>) ?? {}
  const info    = (details.info as Record<string, unknown>) ?? {}
  const sched   = (details.schedule as Record<string, unknown>) ?? {}

  const eventSlug = typeof seo.urlSlug === 'string' ? seo.urlSlug : ''
  if (!eventSlug) return { ok: false, status: 409, error: 'This event has not been published yet.' }

  const eventName = typeof info.name === 'string' ? info.name : 'Untitled Event'
  const eventDate = typeof sched.startDate === 'string' && sched.startDate ? sched.startDate : null

  // The pass list is read from the PUBLISHED event, which is the source of truth for what
  // is live — not the draft, which the organizer may have edited since publishing.
  const event = await getEventBySlug(eventSlug)
  if (!event) return { ok: false, status: 409, error: 'This event has not been published yet.' }

  const passes = Array.isArray((event.pricing as Record<string, unknown> | null)?.passes)
    ? ((event.pricing as Record<string, unknown>).passes as PassRecord[])
    : []

  const pass = passes.find(p => typeof p?.id === 'string' && p.id === passId)
  if (!pass) {
    // "Race" is the organizer-facing word; a pass IS the race distance (Phase 0 · D2).
    return { ok: false, status: 404, error: 'Race not found on this event.' }
  }

  return {
    ok: true,
    race: {
      eventId,
      eventSlug,
      eventName,
      eventDate,
      passId,
      passName: typeof pass.name === 'string' && pass.name ? pass.name : 'Race',
    },
  }
}

// ─── RD-RESULTS-FIX-01 · the start list ───────────────────────────────────────

/**
 * Every CONFIRMED entrant for an event that has a bib, keyed by normalised bib.
 *
 * ═══ WHY THE WHOLE EVENT, NOT ONE RACE ═══════════════════════════════════════
 * Loading only the race being imported would make `WRONG_RACE` indistinguishable from
 * `UNKNOWN_RUNNER` — a 10K entrant in the half-marathon file would report as "not on the
 * start list", which sends the organizer looking for a registration that exists. Each entry
 * carries its own `passId` so the matcher can tell the two apart.
 *
 * Served by the EXISTING `(organizerUid, eventSlug, passId, registeredAt)` index, using its
 * leading fields only. Bounded by `limit` so a pathological event cannot load unboundedly;
 * the cap is reported to the caller rather than silently truncating a correctness check.
 */
export async function fetchEventRoster(params: {
  organizerUid: string
  eventSlug:    string
  limit?:       number
}): Promise<{ roster: Map<string, RosterEntry>; truncated: boolean }> {
  const limit = Math.min(Math.max(1, params.limit ?? 60_000), 60_000)

  const snap = await adminDb.collection('registrations')
    .where('organizerUid', '==', params.organizerUid)
    .where('eventSlug',    '==', params.eventSlug)
    .where('status',       '==', 'confirmed')
    .limit(limit)
    .get()

  const roster = new Map<string, RosterEntry>()
  for (const d of snap.docs) {
    const r = d.data() as {
      bibNumber?: unknown; passId?: unknown
      attendee?: { name?: unknown }
    }
    // An entrant with no bib cannot be matched to a timing row at all. Skipped rather than
    // stored, so `MISSING_RESULT` does not fire for everyone the organizer never numbered.
    if (typeof r.bibNumber !== 'string' || r.bibNumber.trim() === '') continue

    const key = bibKey(r.bibNumber)
    if (roster.has(key)) continue          // first wins; a duplicate bib is a registration problem

    roster.set(key, {
      bibKey:         key,
      registrationId: d.id,
      passId:         typeof r.passId === 'string' ? r.passId : '',
      name:           typeof r.attendee?.name === 'string' ? r.attendee.name : null,
    })
  }

  return { roster, truncated: snap.size === limit }
}
