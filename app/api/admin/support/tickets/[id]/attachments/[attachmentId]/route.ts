// RD-SUPPORT-01 — a ticket screenshot for a Super Admin, streamed after requireSuperAdmin. Same
// private-storage rule as the organizer route: no public or token-bearing URL exists.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { readAdminAttachment } from '@/lib/support/service'
import { attachmentHeaders } from '@/lib/support/attachments'
import { supportErrorResponse, ID_RE } from '@/lib/support/http'

type Ctx = { params: Promise<{ id: string; attachmentId: string }> }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id, attachmentId } = await params
  if (!ID_RE.test(id) || !ID_RE.test(attachmentId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const file = await readAdminAttachment(id, attachmentId)
    if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return new NextResponse(new Uint8Array(file.bytes), { headers: attachmentHeaders(file.contentType, file.name, file.bytes.byteLength) })
  } catch (err) { return supportErrorResponse(err, 'admin attachment') }
}
