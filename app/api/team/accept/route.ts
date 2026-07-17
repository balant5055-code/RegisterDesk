// POST /api/team/accept  — accept a team invitation.
//
// The caller must be authenticated (existing user, or a newly signed-up user).
// The invite is matched by token; the accepting account's VERIFIED email must
// equal the invited email. Tokens are single-use (consumed on accept) and expire
// after 7 days — both enforced inside a transaction (replay-safe).

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }              from '@/lib/team/access'
import { acceptInvite }              from '@/lib/team/service'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'You must be signed in to accept an invitation.' }, { status: 401 })

  let body: { token?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }
  if (typeof body.token !== 'string' || !body.token) {
    return NextResponse.json({ error: 'Missing invitation token.' }, { status: 400 })
  }

  const result = await acceptInvite({ token: body.token, callerUid: caller.uid, callerEmail: caller.email })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ success: true, organizerUid: result.data.organizerUid })
}
