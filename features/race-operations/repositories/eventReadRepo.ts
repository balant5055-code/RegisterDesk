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
import { isRaceOperationsAvailable } from '@/lib/events/eventCapabilities'
import type { RosterEntry } from '@/features/race-operations/import/validation/registrationMatch'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

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
  // RD-RACEOPS-02B · ownership AND the event-type capability, before any event data is used.
  const gate = await resolveRaceOpsEvent(workspaceUid, eventId)
  if (!gate.ok) return gate
  const draft = gate.draft
  const details = (draft.eventDetails as Record<string, unknown>) ?? {}
  const info    = (details.info as Record<string, unknown>) ?? {}
  const sched   = (details.schedule as Record<string, unknown>) ?? {}

  // RD-CE-FIX C1 · only a slug the live document proves is THIS workspace's event for THIS draft.
  const eventSlug = (await resolveOwnedEventSlug(workspaceUid, eventId, draft)) ?? ''
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
/**
 * RD-RACEOPS-02B · the event exists in THIS workspace and its TYPE admits Race Operations.
 *
 * ONE document — the draft the organizer owns — read before anything result-shaped is
 * touched. The type rule is the platform's own (`isRaceOperationsAvailable`, the same
 * predicate the sidebar row and the access gate use), so the API can never accept an event
 * the UI refuses, or the reverse. Called by `resolveRace` (session creation, versions,
 * rollback, export, snapshot build) and by the session-scoped services through
 * `requireEligibleSession`, so an import session for an event whose type no longer admits
 * results cannot be advanced or published either.
 *
 * A missing draft and a wrong-type draft answer differently on purpose: ownership is the
 * security boundary (404, as before); capability is a product rule (409, like the
 * "not published yet" refusal beside it) — an owner is told why, a stranger learns nothing.
 */
export const RACE_OPS_TYPE_ERROR =
  'Race Operations is not available for this event type. Race results can be published for sports events only.'

export type ResolveRaceOpsEventOutcome =
  | { ok: true;  draft: Record<string, unknown>; eventType: string | null }
  | { ok: false; status: number; error: string }

export async function resolveRaceOpsEvent(
  workspaceUid: string,
  eventId:      string,
): Promise<ResolveRaceOpsEventOutcome> {
  let draftSnap: FirebaseFirestore.DocumentSnapshot
  try {
    draftSnap = await adminDb.doc(`users/${workspaceUid}/eventDrafts/${eventId}`).get()
  } catch {
    // A path that cannot name a document cannot name an event the caller owns.
    return { ok: false, status: 404, error: 'Event not found' }
  }
  if (!draftSnap.exists) return { ok: false, status: 404, error: 'Event not found' }
  const draft = draftSnap.data() as Record<string, unknown>
  const eventType = typeof draft.eventType === 'string' ? draft.eventType : null
  if (!isRaceOperationsAvailable(eventType)) {
    return { ok: false, status: 409, error: RACE_OPS_TYPE_ERROR }
  }
  return { ok: true, draft, eventType }
}

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
