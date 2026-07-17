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
  // Resolves the effective workspace owner uid (caller's own, or the org they're
  // an active member of) and enforces the 'events' permission.
  const authz = await authorizeWorkspace(req, 'events')
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

  const snap = await adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .where('status',       '==', 'confirmed')
    .select('attendee', 'bibNumber', 'bibCategory', 'passName')
    .get()

  const registrations: BibRegistration[] = snap.docs.map(doc => {
    const data    = doc.data() as Record<string, unknown>
    const attendee = data.attendee as Record<string, unknown>
    return {
      id:          doc.id,
      name:        String(attendee?.name  ?? ''),
      email:       String(attendee?.email ?? ''),
      passName:    String(data.passName   ?? ''),
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
