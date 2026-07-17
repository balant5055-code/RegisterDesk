// GET /api/organizer/events/[eventId]/nominations
// Returns all nominations for the event with KPI summary.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'

// ─── Response types ───────────────────────────────────────────────────────────

export interface NominationSummary {
  id:           string
  category:     string
  nomineeName:  string
  organization: string
  description:  string
  supportingUrl: string
  status:       string
  submittedAt:  string
}

export interface NominationsApiResponse {
  total:       number
  byCategory:  Record<string, number>
  nominations: NominationSummary[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISO(ts: unknown): string {
  if (!ts) return ''
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return ''
}

async function resolveSlug(uid: string, eventId: string): Promise<string | null> {
  const snap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) return null
  const d   = snap.data() as Record<string, unknown>
  const seo = ((d.eventDetails as Record<string, unknown>)?.seo as Record<string, unknown>) ?? {}
  return typeof seo.urlSlug === 'string' ? seo.urlSlug : null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<NominationsApiResponse | { error: string }>> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params
  const slug = await resolveSlug(uid, eventId)
  if (!slug) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const snap = await adminDb
    .collection('eventNominations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .orderBy('submittedAt', 'desc')
    .limit(1000)
    .get()

  const nominations: NominationSummary[] = snap.docs.map(doc => {
    const d = doc.data() as Record<string, unknown>
    return {
      id:           doc.id,
      category:     String(d.category     ?? ''),
      nomineeName:  String(d.nomineeName  ?? ''),
      organization: String(d.organization ?? ''),
      description:  String(d.description  ?? ''),
      supportingUrl: String(d.supportingUrl ?? ''),
      status:       String(d.status       ?? 'pending'),
      submittedAt:  toISO(d.submittedAt),
    }
  })

  const byCategory: Record<string, number> = {}
  for (const n of nominations) {
    byCategory[n.category] = (byCategory[n.category] ?? 0) + 1
  }

  return NextResponse.json({ total: nominations.length, byCategory, nominations })
}
