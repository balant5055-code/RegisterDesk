// GET /api/checkin/ops/[eventId]
//
// RD-CHECKIN-STAFF-01 — the bootstrap call for the dedicated gate surface at
// /ops/checkin/[eventId].
//
// ═══ WHY THIS ROUTE EXISTS ═══════════════════════════════════════════════════
// The gate page needs three things before it can render: the event's name, the
// slug the scan/cache endpoints are keyed by, and the live attendance numbers.
// Today that means the organizer attendance endpoint, which returns recent
// check-in rows, per-pass revenue-adjacent breakdowns and hourly analytics — none
// of which a gate operator needs, and all of which they should not be handed.
// This returns exactly the four fields the gate renders and nothing else.
//
// ═══ THIS IS THE PAGE'S REAL GATE ════════════════════════════════════════════
// `middleware.ts` cannot verify a Firebase ID token (Edge runtime, no Admin SDK —
// see the note in that file), and app/(dashboard)/layout.tsx is a client
// component, so NO organizer page has a server-side render gate. The established
// pattern in this repo is the one app/(admin)/layout.tsx uses: render a shell,
// then have it call a Node route handler with a Bearer token before showing
// anything. This is that route for /ops.
//
// Hiding navigation is not a control. The control is that this route — and every
// check-in route the page then calls — independently re-authorizes through
// authorizeEvent, so a gate operator who types another event's id into the URL
// gets a 403 here and an empty page, not a working gate.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeEvent }            from '@/lib/team/workspace'
import { isCheckinOnlyRole }         from '@/lib/team/types'
import { getEventCheckInStatus }     from '@/lib/checkin/eventStatus'
import { getEventStats, aggregateRegistrationStatusCounts } from '@/lib/firebase/firestore/registrationCounters'

export const dynamic = 'force-dynamic'

export interface OpsCheckinContext {
  eventId:      string
  eventSlug:    string
  eventName:    string
  /** Live attendance for the gate header. */
  checkedIn:    number
  totalExpected: number
  /** Drives which controls the surface offers — never trusted by the APIs themselves. */
  canUndo:      boolean
  canWalkIn:    boolean
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<OpsCheckinContext | { error: string }>> {
  // eventId comes from the ROUTE PATH. authorizeEvent verifies the token, resolves
  // the workspace, requires `checkin`, and — for a gate-only role — confirms this
  // event is one they are assigned to.
  const { eventId } = await context.params

  const authz = await authorizeEvent(req, 'checkin', eventId)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // Ownership + slug, from the same document every other check-in surface uses.
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const draft   = draftSnap.data() as Record<string, unknown>
  const details = (draft.eventDetails as Record<string, unknown>) ?? {}
  const info    = (details.info as Record<string, unknown>) ?? {}
  const seo     = (details.seo  as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null
  if (!slug) return NextResponse.json({ error: 'Event slug not resolved' }, { status: 404 })

  const status = await getEventCheckInStatus(slug)
  if (status !== 'ok') {
    return NextResponse.json({ error: 'This event is not accepting check-ins.' }, { status: 403 })
  }

  // Canonical counters — the SAME source and the SAME canonical/fallback split the
  // attendance dashboard uses, so the gate header can never disagree with the
  // organizer view. `complete` means the denormalized stats have been backfilled to
  // the current version; otherwise fall back to the shared aggregate reader rather
  // than reading a missing field as zero.
  const { counter, complete } = await getEventStats(slug)
  let checkedIn     = counter?.checkedInCount ?? 0
  let totalExpected = counter?.totalCount     ?? 0
  if (!complete) {
    const counts = await aggregateRegistrationStatusCounts(uid, slug)
    checkedIn     = counts.checkedIn
    totalExpected = counts.confirmed
  }

  // Capability hints for the UI only. A gate-only role gets neither control, and
  // both underlying routes independently require `registrations`, so flipping
  // these in the browser changes what is drawn and nothing about what is allowed.
  const gateOnly = !authz.isOwner && isCheckinOnlyRole(authz.role)

  return NextResponse.json({
    eventId,
    eventSlug:     slug,
    eventName:     typeof info.name === 'string' ? info.name : 'Event',
    checkedIn,
    totalExpected,
    canUndo:       !gateOnly,
    canWalkIn:     !gateOnly,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
