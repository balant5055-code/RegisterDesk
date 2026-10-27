// RD-SUPPORT-01 — one ticket for a Super Admin.
//   GET   → the ticket, the full thread, the history with actors, and the internal notes.
//   PATCH → status / priority / assignee (whitelisted — validateAdminTicketPatch; an assignee must
//           be an active Super Admin). History, audit and any organizer notice commit together.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { validateAdminTicketPatch } from '@/lib/support/types'
import { adminGetTicket, adminUpdateTicket } from '@/lib/support/service'
import { supportErrorResponse, ID_RE, NO_STORE } from '@/lib/support/http'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
  try {
    const ticket = await adminGetTicket(id)
    if (!ticket) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
    return NextResponse.json({ ticket }, { headers: NO_STORE })
  } catch (err) { return supportErrorResponse(err, 'admin get') }
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const v = validateAdminTicketPatch(body)
  if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fields: v.errors, code: 'INVALID' }, { status: 400 })
  try {
    return NextResponse.json({ success: true, ...await adminUpdateTicket({ id, adminUid: gate.uid, patch: v.value }) }, { headers: NO_STORE })
  } catch (err) { return supportErrorResponse(err, 'admin update') }
}
