// GET /api/organizer/email-logs
//
// Returns up to 200 emailLogs entries for the authenticated organizer.
// Supports optional query params:
//   status        — queued|sent|delivered|failed
//   templateKey   — e.g. registration_submitted
//   dateFrom      — ISO date string (inclusive)
//   dateTo        — ISO date string (inclusive, end of day)
//   limit         — max 200 (default 100)

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import type { EmailLog }             from '@/lib/email-logs/types'
import { authorizeWorkspace }        from '@/lib/team/workspace'

type GetResponse =
  | { success: true;  logs: EmailLog[]; total: number }
  | { success: false; error: string }

function tsToIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return new Date().toISOString()
}

export async function GET(req: NextRequest): Promise<NextResponse<GetResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { searchParams } = req.nextUrl
  const status      = searchParams.get('status')      ?? ''
  const templateKey = searchParams.get('templateKey') ?? ''
  const dateFrom    = searchParams.get('dateFrom')    ?? ''
  const dateTo      = searchParams.get('dateTo')      ?? ''
  const rawLimit    = parseInt(searchParams.get('limit') ?? '100', 10)
  const limit       = Math.min(isNaN(rawLimit) ? 100 : rawLimit, 200)

  // Build Firestore query
  let query = adminDb.collection('emailLogs')
    .where('organizerUid', '==', uid)
    .orderBy('createdAt', 'desc') as FirebaseFirestore.Query

  if (status)      query = query.where('status',      '==', status)
  if (templateKey) query = query.where('templateKey', '==', templateKey)

  if (dateFrom) {
    const from = new Date(dateFrom)
    from.setHours(0, 0, 0, 0)
    query = query.where('createdAt', '>=', from)
  }
  if (dateTo) {
    const to = new Date(dateTo)
    to.setHours(23, 59, 59, 999)
    query = query.where('createdAt', '<=', to)
  }

  const snap = await query.limit(limit).get()

  const logs: EmailLog[] = snap.docs.map(doc => {
    const d = doc.data()
    return {
      id:                doc.id,
      organizerUid:      typeof d.organizerUid      === 'string' ? d.organizerUid      : '',
      eventId:           typeof d.eventId            === 'string' ? d.eventId            : '',
      eventSlug:         typeof d.eventSlug          === 'string' ? d.eventSlug          : '',
      eventName:         typeof d.eventName          === 'string' ? d.eventName          : '',
      templateKey:       typeof d.templateKey        === 'string' ? d.templateKey        : '',
      recipientEmail:    typeof d.recipientEmail     === 'string' ? d.recipientEmail     : '',
      recipientName:     typeof d.recipientName      === 'string' ? d.recipientName      : '',
      subject:           typeof d.subject            === 'string' ? d.subject            : '',
      status:            typeof d.status             === 'string' ? d.status             : 'queued',
      provider:          typeof d.provider           === 'string' ? d.provider           : '',
      providerMessageId: typeof d.providerMessageId  === 'string' ? d.providerMessageId  : undefined,
      error:             typeof d.error              === 'string' ? d.error              : undefined,
      registrationId:    typeof d.registrationId     === 'string' ? d.registrationId     : '',
      createdAt:         tsToIso(d.createdAt),
      updatedAt:         tsToIso(d.updatedAt),
    } as EmailLog
  })

  return NextResponse.json({ success: true, logs, total: logs.length })
}
