// GET /api/organizer/events/[eventId]/nominations/export
// Returns all nominations as a CSV file.
// Accepts token via header or query param (for <a download> links).

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspaceDownload } from '@/lib/team/workspace'
import { csvCell as csvEscape }        from '@/lib/utils/csv'

function toISO(ts: unknown): string {
  if (!ts) return ''
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return ''
}

async function resolveSlug(uid: string, eventId: string): Promise<{ slug: string; name: string } | null> {
  const snap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) return null
  const d    = snap.data() as Record<string, unknown>
  const seo  = ((d.eventDetails as Record<string, unknown>)?.seo  as Record<string, unknown>) ?? {}
  const info = ((d.eventDetails as Record<string, unknown>)?.info as Record<string, unknown>) ?? {}
  const slug = typeof seo.urlSlug === 'string' ? seo.urlSlug : ''
  const name = typeof info.name   === 'string' ? info.name   : 'Event'
  return slug ? { slug, name } : null
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const authz = await authorizeWorkspaceDownload(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params
  const meta = await resolveSlug(uid, eventId)
  if (!meta) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const snap = await adminDb
    .collection('eventNominations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', meta.slug)
    .orderBy('submittedAt', 'asc')
    .limit(5000)
    .get()

  const COLS = [
    'Nomination ID', 'Category', 'Nominee Name', 'Organization',
    'Description', 'Supporting URL', 'Status', 'Submitted At',
  ]

  const rows: string[][] = [COLS]

  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    rows.push([
      doc.id,
      String(d.category      ?? ''),
      String(d.nomineeName   ?? ''),
      String(d.organization  ?? ''),
      String(d.description   ?? ''),
      String(d.supportingUrl ?? ''),
      String(d.status        ?? 'pending'),
      toISO(d.submittedAt),
    ].map(csvEscape))
  }

  const csv      = rows.map(r => r.join(',')).join('\r\n')
  const filename = `${meta.slug}-nominations-${new Date().toISOString().slice(0, 10)}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
