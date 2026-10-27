// RD-SUPPORT-01 — Confirm & Close: the organizer agrees a RESOLVED ticket is fixed (resolved → closed).
// Only from Resolved; `expectedStatus` refuses a stale page. A ticket the caller may not see answers
// 404, exactly like one that does not exist. One Super Admin notice per closure (the outbox).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { checkRateLimit } from '@/lib/rateLimit'
import { isTicketStatus } from '@/lib/support/types'
import { organizerConfirmClose } from '@/lib/support/service'
import { organizerCaller, supportErrorResponse, rateLimited, ID_RE, NO_STORE } from '@/lib/support/http'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { id } = await params
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
  const rl = checkRateLimit(authz.callerUid, 'support-ticket-reply', 30, 10 * 60 * 1000)
  if (rl.limited) return rateLimited(rl.resetAt)
  let body: { expectedStatus?: unknown } = {}
  try { body = await req.json() as typeof body } catch { /* an empty body is fine */ }
  if (body.expectedStatus !== undefined && !isTicketStatus(body.expectedStatus)) {
    return NextResponse.json({ error: 'Unknown status.', code: 'INVALID' }, { status: 400 })
  }
  try {
    const result = await organizerConfirmClose({ caller: organizerCaller(authz), id, expectedStatus: isTicketStatus(body.expectedStatus) ? body.expectedStatus : undefined })
    return NextResponse.json({ success: true, ...result }, { headers: NO_STORE })
  } catch (err) { return supportErrorResponse(err, 'close') }
}
