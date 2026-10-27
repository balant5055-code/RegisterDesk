// RD-SUPPORT-01 — a Super Admin reply the organizer will see, optionally moving the status in the
// same save. One organizer notice per reply (status change folded in). Text only.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { validateAdminReply } from '@/lib/support/types'
import { adminReply } from '@/lib/support/service'
import { supportErrorResponse, ID_RE, NO_STORE } from '@/lib/support/http'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const v = validateAdminReply(body)
  if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fields: v.errors, code: 'INVALID' }, { status: 400 })
  try {
    return NextResponse.json({ success: true, ...await adminReply({ id, adminUid: gate.uid, ...v.value }) }, { headers: NO_STORE })
  } catch (err) { return supportErrorResponse(err, 'admin reply') }
}
