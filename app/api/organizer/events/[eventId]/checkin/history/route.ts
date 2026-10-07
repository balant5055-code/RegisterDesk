// GET /api/organizer/events/[eventId]/checkin/history
//
// RD-CHECKIN-04 — the READ side of the append-only check-in history.
//
// ═══ THE GAP THIS CLOSES ═════════════════════════════════════════════════════
// RD-CHECKIN-2.0 made every admission and every undo leave an immutable record.
// The final audit then found that nothing in the product ever read it: no route,
// no component. The evidence existed and was reachable only through the Firebase
// console — which is exactly the wrong answer to "who let this person in?", asked
// by an organizer, on the day, about their own event.
//
// ═══ THIS ROUTE ONLY READS ═══════════════════════════════════════════════════
// It contains no write of any kind and imports nothing that writes. History is
// append-only by construction (lib/checkin/history.ts has no update or delete
// path), and this surface must not become the exception.
//
// ═══ TWO VIEWS, ONE ROUTE ════════════════════════════════════════════════════
//   ?registrationId=…  → ONE participant's complete timeline, oldest first.
//                        Subcollection order; served by the automatic index.
//   (no parameter)     → the EVENT feed, newest first, paged with `before`.
//                        Collection-group query; needs the declared index.
//
// ═══ WHO MAY READ IT ═════════════════════════════════════════════════════════
// Gated on `registrations`, reusing the existing matrix rather than inventing a
// permission. That grant is exactly the set of roles that should see attendance
// evidence — owner, admin, manager — and it deliberately EXCLUDES both gate roles:
// `checkin_staff` and `checkin_lead` hold only gate permissions, so an operator
// cannot read the log of who else was admitted. `authorizeEvent` additionally
// derives the event from the ROUTE PATH, so scope is never taken from a body.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }            from '@/lib/firebase/admin'
import { authorizeEvent }     from '@/lib/team/workspace'
import { resolveCheckinReadiness, CHECKIN_BLOCKED_COPY } from '@/lib/checkin/readiness'
import { resolveOperatorNames } from '@/lib/checkin/operators'
import {
  getCheckinHistory, getEventCheckinHistory,
  EVENT_HISTORY_PAGE, EVENT_HISTORY_MAX_PAGE,
  type CheckinHistoryEntry,
} from '@/lib/checkin/history'
import { resolveIdentifierConfig } from '@/lib/identifiers/config'
import type { RegistrationDocument } from '@/lib/registrations/types'

export const dynamic = 'force-dynamic'

/** One history entry, joined with the participant it describes. */
export interface CheckinHistoryRow {
  id:              string
  action:          'CHECK_IN' | 'CHECK_IN_UNDO'
  occurredAt:      string | null
  method:          string
  /** The identifier held AT THE TIME of the action — historical, not current. */
  identifierValue: string | null
  reason:          string | null

  registrationId:  string
  /** Joined from the registration. Null when the registration no longer exists. */
  attendeeName:    string | null
  ticketCode:      string | null
  passName:        string | null

  /** Display name of the operator, or null when it could not be resolved. */
  operatorName:    string | null
}

export interface CheckinHistoryResponse {
  rows:  CheckinHistoryRow[]
  /** Present on the event feed only. Pass back as `before` for the older page. */
  nextBefore: string | null
  /** The event's configured identifier label, printed verbatim by the client. */
  identifierLabel: string
  /** True when the event issues identifiers at all. */
  identifiersEnabled: boolean
  /** 'event' | 'registration' — which view answered. */
  scope: 'event' | 'registration'
  /** For the page header. Resolved server-side; never taken from the client. */
  eventName: string
}

function toISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

/** A Firestore "this query needs an index that is not deployed" failure. */
function isMissingIndex(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown }
  return e?.code === 9 || (typeof e?.message === 'string' && /requires an index/i.test(e.message))
}

/**
 * Joins entries to their participants and operators, in TWO batched reads total.
 *
 * The naive version reads one registration and one user per row; on a 50-row page
 * that is a hundred round-trips, re-issued on every "load older". Distinct ids are
 * collected first and fetched with `getAll`, which is the same shape the recent
 * strip already uses.
 */
async function hydrate(
  entries: CheckinHistoryEntry[],
  workspaceUid: string,
  eventSlug: string,
): Promise<CheckinHistoryRow[]> {
  // Defence in depth. The query is already scoped by eventSlug (globally unique)
  // and the caller's ownership of it was proved above, but an entry that does not
  // match the resolved workspace and event is dropped rather than rendered.
  const safe = entries.filter(e => e.organizerUid === workspaceUid && e.eventSlug === eventSlug)

  const regIds = [...new Set(safe.map(e => e.registrationId).filter(Boolean))]
  const regs = new Map<string, RegistrationDocument>()
  if (regIds.length) {
    const snaps = await adminDb.getAll(
      ...regIds.map(id => adminDb.collection('registrations').doc(id)),
    ).catch(() => [])
    for (const s of snaps) {
      if (s.exists) regs.set(s.id, s.data() as RegistrationDocument)
    }
  }

  const names = await resolveOperatorNames(safe.map(e => e.operatorUid))

  return safe.map(e => {
    const reg = regs.get(e.registrationId)
    return {
      id:              e.id,
      action:          e.action,
      occurredAt:      toISO(e.occurredAt),
      method:          e.method,
      identifierValue: e.identifierValue ?? null,
      reason:          e.reason ?? null,
      registrationId:  e.registrationId,
      // A deleted registration leaves its history behind — that is the point of an
      // append-only log. The row renders with a null attendee rather than vanishing.
      attendeeName:    reg?.attendee?.name ?? null,
      ticketCode:      reg?.ticketCode ?? null,
      passName:        reg?.passName ?? null,
      operatorName:    names[e.operatorUid] ?? null,
    }
  })
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<CheckinHistoryResponse | { error: string }>> {
  const { eventId } = await context.params

  // ── 1. Authenticated → role/staff status → event scope → permission ───────
  const authz = await authorizeEvent(req, 'registrations', eventId)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── 2. Organizer ownership of THIS event, via the one readiness resolver ──
  //
  // A closed or cancelled event must still be inspectable — the whole point of an
  // audit trail is that it outlives the operation — so only ownership and slug
  // resolution are required here, not `ok`. `not_found` is the ownership failure.
  const ready = await resolveCheckinReadiness(uid, eventId)
  if ((!ready.ok && ready.reason === 'not_found') || !ready.eventSlug) {
    return NextResponse.json({ error: CHECKIN_BLOCKED_COPY.not_found }, { status: 404 })
  }
  const slug = ready.eventSlug

  const { config: idConfig } = await resolveIdentifierConfig(slug)
  const meta = {
    identifierLabel:    idConfig.label,
    identifiersEnabled: idConfig.enabled,
    eventName:          ready.eventName ?? 'Event',
  }

  const registrationId = (req.nextUrl.searchParams.get('registrationId') ?? '').trim()

  // ── 3a. ONE participant's complete timeline ───────────────────────────────
  if (registrationId) {
    // The registration must belong to this workspace AND this event before any of
    // its history is read. Without this, a registration id from a sibling event —
    // or another organizer's — would return that participant's timeline.
    const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
    const reg = regSnap.exists ? regSnap.data() as RegistrationDocument : null
    if (!reg || reg.organizerUid !== uid || reg.eventSlug !== slug) {
      // Same shape as "no history", so a probe cannot distinguish a foreign
      // registration from one with an empty timeline.
      return NextResponse.json({ rows: [], nextBefore: null, scope: 'registration', ...meta })
    }

    const entries = await getCheckinHistory(registrationId)
    const rows    = await hydrate(entries, uid, slug)
    return NextResponse.json({ rows, nextBefore: null, scope: 'registration', ...meta })
  }

  // ── 3b. The EVENT feed ────────────────────────────────────────────────────
  const limitRaw = Number.parseInt(req.nextUrl.searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), EVENT_HISTORY_MAX_PAGE)
    : EVENT_HISTORY_PAGE

  const beforeRaw = req.nextUrl.searchParams.get('before')
  let before: Date | null = null
  if (beforeRaw) {
    const d = new Date(beforeRaw)
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: 'Invalid `before` cursor.' }, { status: 400 })
    }
    before = d
  }

  try {
    const page = await getEventCheckinHistory(slug, { limit, before })
    const rows = await hydrate(page.entries, uid, slug)
    return NextResponse.json({ rows, nextBefore: page.nextBefore, scope: 'event', ...meta })
  } catch (err) {
    if (!isMissingIndex(err)) throw err
    // Honest, and deliberately not an empty list: "nothing happened at this gate"
    // is a false statement about an event that ran, and it is the one answer an
    // audit trail must never give by accident.
    return NextResponse.json(
      { error: 'Check-in history is not available yet on this deployment. The required Firestore index has not been created.' },
      { status: 503 },
    )
  }
}
