// RD-SUPPORT-01 — one support ticket for the organizer: the ticket, its thread and its status
// history (organizer whitelist view — no internal notes, assignee or admin ids). A ticket the
// caller may not see answers 404, exactly like one that does not exist.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { getOrganizerTicket } from '@/lib/support/service'
import { organizerCaller, supportErrorResponse, ID_RE, NO_STORE } from '@/lib/support/http'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { id } = await params
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
  try {
    const ticket = await getOrganizerTicket(organizerCaller(authz), id)
    if (!ticket) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
    return NextResponse.json({ ticket }, { headers: NO_STORE })
  } catch (err) { return supportErrorResponse(err, 'get') }
}
