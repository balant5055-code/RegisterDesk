// RD-SUPPORT-01 — an INTERNAL note on a ticket. Super Admin only; never shown to the organizer,
// never in a notification or email. The audit row records that a note was added, not its text.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { validateNote } from '@/lib/support/types'
import { adminAddNote } from '@/lib/support/service'
import { supportErrorResponse, ID_RE, NO_STORE } from '@/lib/support/http'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const v = validateNote(body)
  if (!v.ok) return NextResponse.json({ error: v.errors.text, code: 'INVALID' }, { status: 400 })
  try {
    return NextResponse.json({ success: true, ...await adminAddNote({ id, adminUid: gate.uid, text: v.value.text }) }, { status: 201, headers: NO_STORE })
  } catch (err) { return supportErrorResponse(err, 'admin note') }
}
