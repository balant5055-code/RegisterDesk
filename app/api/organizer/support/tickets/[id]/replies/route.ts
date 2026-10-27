// RD-SUPPORT-01 — the organizer replies on a ticket, or reopens a resolved one (`reopen: true`,
// with a message). JSON, or multipart with up to 3 screenshots. The lifecycle rules (who may reply
// in which status, the reopen window) are lib/support/types; the transaction re-checks them.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { checkRateLimit } from '@/lib/rateLimit'
import { validateReply } from '@/lib/support/types'
import { organizerReply } from '@/lib/support/service'
import { parseMessageRequest, organizerCaller, supportErrorResponse, rateLimited, ID_RE, NO_STORE } from '@/lib/support/http'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { id } = await params
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
  const rl = checkRateLimit(authz.callerUid, 'support-ticket-reply', 30, 10 * 60 * 1000)
  if (rl.limited) return rateLimited(rl.resetAt)

  const parsed = await parseMessageRequest(req)
  if (!parsed.ok) return parsed.response
  const v = validateReply(parsed.payload)
  if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fields: v.errors, code: 'INVALID' }, { status: 400 })
  try {
    const result = await organizerReply({ caller: organizerCaller(authz), id, body: v.value.body, reopen: v.value.reopen, files: parsed.files })
    return NextResponse.json({ success: true, ...result }, { headers: NO_STORE })
  } catch (err) { return supportErrorResponse(err, 'reply') }
}
