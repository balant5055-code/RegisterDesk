// GET  /api/organizer/events/[eventId]/bibs  — bib summary (assigned vs unassigned)
// POST /api/organizer/events/[eventId]/bibs  — assign or clear a bib

import { NextRequest, NextResponse }                          from 'next/server'
import { adminDb }                                            from '@/lib/firebase/admin'
import { authorizeWorkspace }                                 from '@/lib/team/workspace'
import { assignManualBib, assignSequentialBib, clearBib }    from '@/lib/sports/bibNumbers'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BibRegistration {
  id:          string
  name:        string
  email:       string
  passName:    string
  /**
   * RD-BIB-UX-04 · ADDITIVE. The pass the registration is on, so the manual
   * assignment panel can show which number RANGE applies to this participant
   * instead of matching pass NAMES, which are organizer text and not a key.
   * Read from the same document, in the same projection — zero extra reads.
   */
  passId:      string | null
  /**
   * RD-BIB-TIMING-01 · ADDITIVE. The timing device this participant carries, when
   * one is attached. The Participants list needs it to warn BEFORE the click that
   * removing the number will be refused. Same document, same projection — no extra
   * read. Null when none is attached, and null for events with no timing capability.
   */
  timingTag:   string | null
  /**
   * RD-BIB-TIMING-03 · ADDITIVE. The mobile number, for the Timing Chips
   * workspace: at a start line an organizer usually knows a participant by phone,
   * not by number. It comes from the SAME `attendee` map the name and email are
   * already read from, so this is a projection mapping change and costs no extra
   * read and no new index. Empty string when the registration carries none.
   */
  mobile:      string
  bibNumber:   string | null
  bibCategory: string | null
}

export interface BibSummaryResponse {
  eventSlug:     string
  registrations: BibRegistration[]
  assigned:      number
  unassigned:    number
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveSlug(uid: string, eventId: string): Promise<string | null> {
  const snap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) return null
  const d   = snap.data() as Record<string, unknown>
  const seo = (d.eventDetails as Record<string, unknown>)?.seo as Record<string, unknown>
  return typeof seo?.urlSlug === 'string' ? seo.urlSlug : null
}

async function getUid(req: NextRequest): Promise<string | null> {
  // RD-BIB-01 · aligned to `participants`, the permission every OTHER identifier
  // surface requires.
  //
  // This route both lists the roster and ASSIGNS identifiers through the engine, and
  // it was the only door to that engine guarded by a different key (`events`).
  //
  // Verified before changing it: `ROLE_PERMISSIONS` grants `events` and
  // `participants` to exactly the same roles today — owner, admin and manager — so
  // no existing caller loses or gains anything. What it removes is the future in
  // which a role is given `events` alone and can silently issue printed numbers.
  const authz = await authorizeWorkspace(req, 'participants')
  return authz.ok ? authz.workspaceUid : null
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<BibSummaryResponse | { error: string }>> {
  const uid = await getUid(req)
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { eventId } = await context.params
  const slug = await resolveSlug(uid, eventId)
  if (!slug) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  // ── RD-BIB-01 · a bound, because this read had none ────────────────────────
  //
  // This query returned EVERY confirmed registration, unprojected by count, and the
  // identifier workspace called it on mount. On a 20,000-participant event that is
  // 20,000 documents sent to a browser to render a list and a few statistics that
  // now come from aggregates instead.
  //
  // The default is deliberately left UNBOUNDED so no existing caller changes
  // behaviour; the workspace passes `?limit=`. The unbounded form is deprecated and
  // should be removed once this route's remaining consumers are retired.
  const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? '')
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : null

  let query = adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .where('status',       '==', 'confirmed')
    .select('attendee', 'bibNumber', 'bibCategory', 'passName', 'passId', 'timingTag')
  if (limit !== null) query = query.limit(limit)
  const snap = await query.get()

  const registrations: BibRegistration[] = snap.docs.map(doc => {
    const data    = doc.data() as Record<string, unknown>
    const attendee = data.attendee as Record<string, unknown>
    return {
      id:          doc.id,
      name:        String(attendee?.name  ?? ''),
      email:       String(attendee?.email ?? ''),
      mobile:      String(attendee?.phone ?? ''),
      passName:    String(data.passName   ?? ''),
      passId:      typeof data.passId === 'string' ? data.passId : null,
      timingTag:   (() => {
        const t = data.timingTag as { tag?: unknown; state?: unknown } | null | undefined
        return t?.state === 'assigned' && typeof t.tag === 'string' ? t.tag : null
      })(),
      bibNumber:   (data.bibNumber   as string | null) ?? null,
      bibCategory: (data.bibCategory as string | null) ?? null,
    }
  })

  return NextResponse.json({
    eventSlug:  slug,
    registrations,
    assigned:   registrations.filter(r => r.bibNumber).length,
    unassigned: registrations.filter(r => !r.bibNumber).length,
  })
}

// ─── POST ─────────────────────────────────────────────────────────────────────

interface BibActionBody {
  action:         'sequential' | 'manual' | 'clear'
  registrationId: string
  bibNumber?:     string
  bibCategory?:   string
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const uid = await getUid(req)
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { eventId } = await context.params
  const slug = await resolveSlug(uid, eventId)
  if (!slug) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const body = await req.json() as BibActionBody
  const { action, registrationId, bibNumber, bibCategory = '' } = body

  if (!registrationId) return NextResponse.json({ error: 'registrationId required' }, { status: 400 })

  // Verify the registration belongs to this organizer + event
  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
  const regData = regSnap.data() as Record<string, unknown>
  if (regData.eventSlug !== slug || regData.organizerUid !== uid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    if (action === 'sequential') {
      const result = await assignSequentialBib(slug, registrationId, bibCategory, uid)
      return NextResponse.json(result)
    }

    if (action === 'manual') {
      if (!bibNumber?.trim()) return NextResponse.json({ error: 'bibNumber required' }, { status: 400 })
      await assignManualBib(slug, registrationId, bibNumber.trim(), bibCategory, uid)
      return NextResponse.json({ bibNumber: bibNumber.trim(), bibCategory })
    }

    if (action === 'clear') {
      const currentBib = regData.bibNumber as string | null | undefined
      await clearBib(slug, registrationId, currentBib, uid)
      return NextResponse.json({ cleared: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Assignment failed'
    return NextResponse.json({ error: message }, { status: 409 })
  }
}
