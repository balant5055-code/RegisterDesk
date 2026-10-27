// RD-SUPPORT-01 — a screenshot on one of the caller's tickets, streamed after authorization.
// There is no public or token-bearing URL for these files: the bytes are private in storage and
// this route (or its Super Admin twin) is the only way to read them. Not cached anywhere.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { readOrganizerAttachment } from '@/lib/support/service'
import { attachmentHeaders } from '@/lib/support/attachments'
import { organizerCaller, supportErrorResponse, ID_RE } from '@/lib/support/http'

type Ctx = { params: Promise<{ id: string; attachmentId: string }> }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { id, attachmentId } = await params
  if (!ID_RE.test(id) || !ID_RE.test(attachmentId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const file = await readOrganizerAttachment(organizerCaller(authz), id, attachmentId)
    if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return new NextResponse(new Uint8Array(file.bytes), { headers: attachmentHeaders(file.contentType, file.name, file.bytes.byteLength) })
  } catch (err) { return supportErrorResponse(err, 'attachment') }
}
