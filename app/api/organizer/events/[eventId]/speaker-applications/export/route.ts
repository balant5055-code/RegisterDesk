// GET /api/organizer/events/[eventId]/speaker-applications/export?token=...
// Returns a CSV file of all speaker applications.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspaceDownload } from '@/lib/team/workspace'
import { csvCell as csv }             from '@/lib/utils/csv'

function toISO(ts: unknown): string {
  if (!ts) return ''
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function')
    return (ts as { toDate: () => Date }).toDate().toISOString()
  return ''
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const authz = await authorizeWorkspaceDownload(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const d    = draftSnap.data() as Record<string, unknown>
  const ed   = d.eventDetails as Record<string, unknown> | null
  const seo  = ed?.seo as Record<string, unknown> | null
  const slug = typeof seo?.urlSlug === 'string' ? seo.urlSlug : ''
  if (!slug) return NextResponse.json({ error: 'Event slug not found' }, { status: 404 })

  const snap = await adminDb
    .collection('speakerApplications')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .orderBy('submittedAt', 'desc')
    .limit(1000)
    .get()

  const headers = [
    'ID', 'Status', 'Submitted At',
    'Name', 'Email', 'Phone', 'Job Title', 'Company',
    'Talk Title', 'Talk Duration', 'Talk Abstract',
    'Bio', 'Previous Speaking', 'Portfolio URL',
  ]

  const rows = snap.docs.map(doc => {
    const a = doc.data() as Record<string, unknown>
    return [
      doc.id,
      String(a.status        ?? 'pending'),
      toISO(a.submittedAt),
      String(a.name          ?? ''),
      String(a.email         ?? ''),
      String(a.phone         ?? ''),
      String(a.jobTitle      ?? ''),
      String(a.company       ?? ''),
      String(a.talkTitle     ?? ''),
      String(a.talkDuration  ?? ''),
      String(a.talkAbstract  ?? ''),
      String(a.bio           ?? ''),
      String(a.previousSpeaking ?? ''),
      String(a.portfolioUrl  ?? ''),
    ].map(csv).join(',')
  })

  const csvBody = [headers.map(csv).join(','), ...rows].join('\r\n')
  const date    = new Date().toISOString().slice(0, 10)

  return new NextResponse(csvBody, {
    status: 200,
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="speaker-applications-${slug}-${date}.csv"`,
    },
  })
}
