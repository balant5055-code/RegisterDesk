// POST /api/checkin/session — session-level check-in (perm: checkin).
// Body: { sessionId, ticketCode? , registrationId? }. Idempotent + transactional.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { sessionCheckIn } from '@/lib/sessions/service'
import { SessionError } from '@/lib/sessions/types'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'checkin')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: { sessionId?: string; ticketCode?: string; registrationId?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const sessionId = (body.sessionId ?? '').trim()
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  // Resolve registrationId from ticketCode if needed (mirror the scan lookup).
  let registrationId = (body.registrationId ?? '').trim()
  if (!registrationId && body.ticketCode) {
    const snap = await adminDb.collection('registrations').where('ticketCode', '==', body.ticketCode.trim()).limit(1).get()
    if (snap.empty) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 })
    registrationId = snap.docs[0].id
  }
  if (!registrationId) return NextResponse.json({ error: 'ticketCode or registrationId required' }, { status: 400 })

  try {
    const result = await sessionCheckIn({ workspaceUid: authz.workspaceUid, sessionId, registrationId })
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    if (err instanceof SessionError) {
      const status = err.code === 'SESSION_NOT_FOUND' || err.code === 'REGISTRATION_NOT_FOUND' ? 404
        : err.code === 'REGISTRATION_INELIGIBLE' ? 422
        : 400
      return NextResponse.json({ error: err.code }, { status })
    }
    console.error('[checkin/session] failed:', err)
    return NextResponse.json({ error: 'Check-in failed' }, { status: 500 })
  }
}
