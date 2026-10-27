// RD-SUPPORT-01 — organizer support tickets.
//   GET  → the caller's tickets (owner / workspace admin: every ticket of the workspace; any other
//          member: the tickets they opened). Newest activity first, bounded.
//   POST → open a ticket. JSON, or multipart with up to 3 screenshots (see lib/support/http).
//
// authorizeAnyWorkspace: any active member of a workspace may ask for help — except gate-only
// check-in roles, which have no organizer surface. Only the validator's whitelisted fields are
// stored; status, assignee and notes are Super Admin fields and cannot be set here.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { checkRateLimit } from '@/lib/rateLimit'
import { validateTicket } from '@/lib/support/types'
import { createTicket, listOrganizerTickets } from '@/lib/support/service'
import { parseMessageRequest, organizerCaller, supportErrorResponse, rateLimited, NO_STORE, IDEMPOTENCY_KEY_RE } from '@/lib/support/http'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  try {
    return NextResponse.json({ tickets: await listOrganizerTickets(organizerCaller(authz)) }, { headers: NO_STORE })
  } catch (err) { return supportErrorResponse(err, 'list') }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  // Burst control per person (in-process); the durable per-workspace daily cap is in the transaction.
  const rl = checkRateLimit(authz.callerUid, 'support-ticket-create', 5, 10 * 60 * 1000)
  if (rl.limited) return rateLimited(rl.resetAt)

  const parsed = await parseMessageRequest(req)
  if (!parsed.ok) return parsed.response
  const v = validateTicket(parsed.payload)
  if (!v.ok) return NextResponse.json({ error: 'Please fix the highlighted fields.', fields: v.errors, code: 'INVALID' }, { status: 400 })
  // Optional Idempotency-Key: a repeated submission (double click, network retry) returns the ticket
  // the first one opened — 200 + replayed — with no second ticket and no second notification.
  const key = req.headers.get('idempotency-key')
  if (key !== null && !IDEMPOTENCY_KEY_RE.test(key)) return NextResponse.json({ error: 'Invalid Idempotency-Key.', code: 'INVALID' }, { status: 400 })
  try {
    const { id, number, replayed } = await createTicket({ caller: organizerCaller(authz), input: v.value, files: parsed.files, idempotencyKey: key })
    return NextResponse.json({ success: true, id, number, replayed }, { status: replayed ? 200 : 201, headers: NO_STORE })
  } catch (err) { return supportErrorResponse(err, 'create') }
}
