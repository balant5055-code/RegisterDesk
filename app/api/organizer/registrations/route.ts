// GET /api/organizer/registrations
//
// Returns all registration records for the authenticated organizer across all
// events. Stat totals come from the canonical registrationCounters (RD-DASHBOARD-01
// Phase 2), NOT from the returned list; the caller filters the list client-side
// using the URL query param (?status=confirmed|cancelled|pending).
//
// Optional query params:
//   eventId — draftId of an organizer event; when present, results are scoped
//             to that event only.  Omit to return registrations for all events.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }        from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import type { RegistrationDocument, RegistrationCounter } from '@/lib/registrations/types'
import { getEventStats } from '@/lib/firebase/firestore/registrationCounters'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'
import { resolveOwnedEventSlugs, resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

export interface AllRegistrationsResponse {
  registrations: SerializedRegistration[]
  stats: {
    total:      number
    confirmed:  number
    cancelled:  number
    pending:    number
    waitlisted: number
  }
}

function toISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

const EMPTY_RESPONSE: AllRegistrationsResponse = {
  registrations: [],
  stats: { total: 0, confirmed: 0, cancelled: 0, pending: 0, waitlisted: 0 },
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── Optional event filter ──────────────────────────────────────────────────
  // Resolve the eventId (draftId) to its URL slug, which is the field stored
  // on registration documents.  Ownership is verified implicitly: the draft
  // must live under users/{uid}/eventDrafts/{eventId}.
  const eventId     = req.nextUrl.searchParams.get('eventId') ?? null
  let   slugFilter: string | null = null

  if (eventId) {
    const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
    if (!draftSnap.exists) {
      // eventId not found under this organizer's drafts — return empty safely
      return NextResponse.json(EMPTY_RESPONSE satisfies AllRegistrationsResponse)
    }
    const draft      = draftSnap.data() as Record<string, unknown>
    // RD-CE-FIX C1 · only a slug the live document proves is THIS workspace's event for THIS draft.
    const slug       = await resolveOwnedEventSlug(uid, eventId, draft)
    // Draft events with no published slug have no registrations yet
    if (!slug) return NextResponse.json(EMPTY_RESPONSE satisfies AllRegistrationsResponse)
    slugFilter = slug
  }

  // ── Build Firestore query ──────────────────────────────────────────────────
  //
  // RD-REPORT-02 · this endpoint is a PARTICIPANT LIST, and now only that.
  //
  // It had no `orderBy` at all, so `.limit(300)` returned the first 300 documents by
  // document id — an arbitrary slice — which the route then sorted by date in memory. The
  // comment claimed "newest-first"; it was not. That was tolerable for a list and fatal
  // for the Reports hub, which charted those 300 rows as a time series and derived
  // week-over-week velocity from them. The hub now reads server-computed aggregates
  // (/api/organizer/dashboard) and no longer consumes this endpoint at all.
  //
  // The 300-row ceiling REMAINS, because a list is what this is. What changes is that the
  // window is now the genuinely most recent 300 rather than an arbitrary 300, so the
  // ceiling is a predictable "recent activity" window instead of a lottery.
  //
  // Ordering is served by existing composites — (organizerUid, registeredAt DESC) and
  // (organizerUid, eventSlug, registeredAt DESC). No new index.
  let baseQuery = adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)

  if (slugFilter) {
    baseQuery = baseQuery.where('eventSlug', '==', slugFilter)
  }

  const snap = await baseQuery.orderBy('registeredAt', 'desc').limit(300).get()

  const registrations: SerializedRegistration[] = snap.docs
    .map(doc => {
      const data = doc.data() as RegistrationDocument
      return {
        ...data,
        registeredAt: toISO(data.registeredAt),
        updatedAt:    toISO(data.updatedAt),
        emailSentAt:  toISO(data.emailSentAt),
        checkedInAt:  toISO(data.checkedInAt),
      } as SerializedRegistration
    })
    .sort((a, b) => {
      const at = a.registeredAt ? new Date(a.registeredAt).getTime() : 0
      const bt = b.registeredAt ? new Date(b.registeredAt).getTime() : 0
      return bt - at
    })

  // ── RD-DASHBOARD-01 Phase 2 (H2): registration stats come from the canonical
  //    registrationCounters SSOT — the SAME per-event statistics the event views read —
  //    never from filtering the (capped) list. This removes the 300-scan under-count and
  //    gives the hub ONE registration truth shared with every other surface. totalCount is
  //    confirmed; pending/cancelled/rejected are the maintained status fields.
  let confirmed = 0, pending = 0, cancelled = 0, rejected = 0

  if (slugFilter) {
    // Per-event: the canonical resolver for one event.
    const { counter } = await getEventStats(slugFilter)
    confirmed = counter?.totalCount     ?? 0
    pending   = counter?.pendingCount   ?? 0
    cancelled = counter?.cancelledCount ?? 0
    rejected  = counter?.rejectedCount  ?? 0
  } else {
    // Global: sum the organizer's per-event counters. Slugs come from the organizer's own
    // published events (bounded to the account's events, mirroring the dashboard route).
    const draftsSnap = await adminDb.collection(`users/${uid}/eventDrafts`).limit(500).get()
    // RD-CE-FIX C1 · only slugs the live documents prove belong to THIS workspace's drafts.
    const owned = await resolveOwnedEventSlugs(uid, draftsSnap.docs.map(d => ({ id: d.id, data: d.data() as Record<string, unknown> })))
    const slugs = Array.from(new Set(owned.values()))
    if (slugs.length > 0) {
      const counterSnaps = await adminDb.getAll(
        ...slugs.map(s => adminDb.collection('registrationCounters').doc(s)),
      )
      for (const cs of counterSnaps) {
        if (!cs.exists) continue
        const c = cs.data() as Partial<RegistrationCounter>
        confirmed += c.totalCount     ?? 0
        pending   += c.pendingCount   ?? 0
        cancelled += c.cancelledCount ?? 0
        rejected  += c.rejectedCount  ?? 0
      }
    }
  }

  const stats = {
    total:      confirmed + pending + cancelled + rejected,
    confirmed,
    cancelled,
    pending,
    // registrationCounters (the canonical SSOT) does not track a 'waitlisted' status count,
    // and the hub UI does not render it — so it stays 0 rather than reviving a list scan.
    waitlisted: 0,
  }

  return NextResponse.json({ registrations, stats } satisfies AllRegistrationsResponse)
}
