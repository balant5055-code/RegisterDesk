// GET /api/organizer/events/[eventId]/registrations
//
// Query params:
//   limit  — 25 | 50 | 100 (default 50); ignored when all=true
//   cursor — registration doc ID to start after (server-side cursor pagination)
//   all    — 'true' to load full dataset (capped at 2000) for search/filter mode

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }        from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getEventStats } from '@/lib/firebase/firestore/registrationCounters'
import type { RegistrationDocument }  from '@/lib/registrations/types'

// ─── Serialized shape (Timestamps → ISO strings) ──────────────────────────────

export interface SerializedRegistration extends Omit<RegistrationDocument, 'registeredAt' | 'updatedAt' | 'emailSentAt' | 'checkedInAt'> {
  registeredAt: string | null
  updatedAt:    string | null
  emailSentAt:  string | null
  checkedInAt:  string | null
}

export interface RegistrationsApiResponse {
  registrations: SerializedRegistration[]
  eventName:     string
  eventSlug:     string
  passes:        { id: string; name: string }[]
  fieldLabels:   Record<string, string>
  stats: {
    total:      number
    confirmed:  number
    pending:    number
    cancelled:  number
    waitlisted: number
    rejected:   number
    checkedIn:  number
  }
  hasMore:    boolean
  nextCursor: string | null
  totalCount: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function serializeDoc(doc: { data(): unknown }): SerializedRegistration {
  const data = doc.data() as RegistrationDocument
  return {
    ...data,
    registeredAt: toISO(data.registeredAt),
    updatedAt:    toISO(data.updatedAt),
    emailSentAt:  toISO(data.emailSentAt),
    checkedInAt:  toISO(data.checkedInAt),
  } as SerializedRegistration
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<RegistrationsApiResponse | { error: string }>> {
  try {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params

  // ── 2. Verify ownership ────────────────────────────────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const draft = draftSnap.data() as Record<string, unknown>
  if (draft.status !== 'published') {
    return NextResponse.json({ error: 'Event is not published' }, { status: 403 })
  }

  // ── 3. Extract event metadata ───────────────────────────────────────────────
  const rawDetails = draft.eventDetails as Record<string, unknown> | null
  const rawSeo     = rawDetails?.seo  as Record<string, unknown> | null
  const rawInfo    = rawDetails?.info as Record<string, unknown> | null
  const slug       = typeof rawSeo?.urlSlug === 'string' ? rawSeo.urlSlug : ''
  const eventName  = typeof rawInfo?.name   === 'string' ? rawInfo.name   : 'Event'
  if (!slug) return NextResponse.json({ error: 'Event slug not resolved' }, { status: 404 })

  // ── 4. Build pass list ─────────────────────────────────────────────────────
  const rawPricing = draft.pricing as Record<string, unknown> | null
  const rawPasses  = Array.isArray(rawPricing?.passes) ? rawPricing.passes as Record<string, unknown>[] : []
  const passes     = rawPasses.map(p => ({
    id:   String(p.id   ?? ''),
    name: String(p.name ?? 'Pass'),
  }))

  // ── 5. Build fieldId → label map ───────────────────────────────────────────
  const rawForm = draft.registrationForm as {
    sections?: Array<{ fields: Array<{ id: string; label: string }> }>
  } | null
  const fieldLabels: Record<string, string> = {}
  for (const section of rawForm?.sections ?? []) {
    for (const field of section.fields ?? []) {
      if (field.id && field.label) fieldLabels[field.id] = field.label
    }
  }

  // ── 6. Parse query params ──────────────────────────────────────────────────
  const params   = req.nextUrl.searchParams
  const allMode  = params.get('all') === 'true'
  const rawLimit = Number(params.get('limit') ?? '50')
  const pageSize = [25, 50, 100].includes(rawLimit) ? rawLimit : 50
  const cursor   = params.get('cursor') ?? null

  // ── 7. Stats — O(1) from the per-event statistics doc (EA-2 S1) ────────────
  // The status breakdown is served from registrationCounters/{slug} instead of
  // scanning every registration on each page load. Falls back to the former
  // projected scan for events whose stats doc has not yet been backfilled
  // (statsVersion < current) so legacy events are never mis-reported.
  // (Waitlist entries live in a separate `waitlists` collection, so the
  // registrations status breakdown never contains 'waitlisted'.)
  const stats = { total: 0, confirmed: 0, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 }
  const { counter, complete } = await getEventStats(slug)

  if (complete && counter) {
    stats.confirmed  = counter.totalCount     ?? 0
    stats.pending    = counter.pendingCount   ?? 0
    stats.cancelled  = counter.cancelledCount ?? 0
    stats.rejected   = counter.rejectedCount  ?? 0
    stats.checkedIn  = counter.checkedInCount ?? 0
    stats.total      = stats.confirmed + stats.pending + stats.cancelled + stats.rejected + stats.waitlisted
  } else {
    // Fallback: projected scan (two equality filters, auto single-field index).
    const statsSnap = await adminDb
      .collection('registrations')
      .where('organizerUid', '==', uid)
      .where('eventSlug',    '==', slug)
      .select('status', 'checkedIn')
      .get()
    for (const doc of statsSnap.docs) {
      const d = doc.data() as { status?: string; checkedIn?: boolean }
      stats.total++
      if      (d.status === 'confirmed')  stats.confirmed++
      else if (d.status === 'pending')    stats.pending++
      else if (d.status === 'cancelled')  stats.cancelled++
      else if (d.status === 'waitlisted') stats.waitlisted++
      else if (d.status === 'rejected')   stats.rejected++
      if (d.checkedIn) stats.checkedIn++
    }
  }

  // ── 8. Registrations query ─────────────────────────────────────────────────
  // Requires composite index: (organizerUid ASC, eventSlug ASC, registeredAt DESC)
  const baseQuery = adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .orderBy('registeredAt', 'desc')

  let registrations: SerializedRegistration[]
  let hasMore    = false
  let nextCursor: string | null = null

  if (allMode) {
    // Full-load mode for search/filter — cap at 2000 docs
    const snap = await baseQuery.limit(2000).get()
    registrations = snap.docs.map(serializeDoc)
    hasMore = snap.size === 2000
  } else {
    // Cursor-based paginated mode
    let pageQuery = baseQuery.limit(pageSize + 1)
    if (cursor) {
      const cursorDoc = await adminDb.collection('registrations').doc(cursor).get()
      if (cursorDoc.exists) {
        pageQuery = baseQuery.startAfter(cursorDoc).limit(pageSize + 1)
      }
    }
    const snap = await pageQuery.get()
    hasMore    = snap.size > pageSize
    const docs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs
    nextCursor = hasMore ? docs[docs.length - 1].id : null
    registrations = docs.map(serializeDoc)
  }

  return NextResponse.json({
    registrations,
    eventName,
    eventSlug: slug,
    passes,
    fieldLabels,
    stats,
    hasMore,
    nextCursor,
    totalCount: stats.total,
  })
  } catch (error) {
    // Logged server-side; return a generic message rather than the raw exception.
    console.error('EVENT_REGISTRATIONS_ERROR', error)
    return NextResponse.json(
      { error: 'Failed to load registrations.' },
      { status: 500 },
    )
  }
}
