// POST /api/staff/password — a staff operator changes their OWN password.
//
// RD-CHECKIN-2.0.
//
// ═══ WHY THE CURRENT PASSWORD IS NOT SENT HERE ═══════════════════════════════
// Firebase owns the credential; this process never sees a stored password and
// cannot verify one. Re-authentication therefore happens where it can actually be
// checked — on the client, via Firebase's own reauthenticateWithCredential — and
// this route only acts on an ID token that was minted from a successful sign-in and
// is verified again here with `checkRevoked`.
//
// The new password is passed to Firebase and to nothing else. It is not stored, not
// logged, not echoed back, and does not appear in any audit record.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }              from '@/lib/team/access'
import { getStaffAccount, setOwnStaffPassword } from '@/lib/staff/service'
import { checkRateLimit }            from '@/lib/rateLimit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Password changes are rare; a tight budget keeps this from being usable to
  // hammer the Auth backend from one session.
  const rl = checkRateLimit(caller.uid, 'staff-password', 5, 10 * 60_000)
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many attempts. Try again shortly.' }, { status: 429 })
  }

  // Only a staff credential may use this. Organizers and email-invited members own
  // real mailboxes and change their password through the ordinary reset flow.
  const staff = await getStaffAccount(caller.uid)
  if (!staff) return NextResponse.json({ error: 'Not a staff account.' }, { status: 403 })
  if (staff.status !== 'active') {
    return NextResponse.json({ error: 'This account is suspended.' }, { status: 403 })
  }

  let password: string
  try {
    const body = await req.json() as { password?: unknown }
    if (typeof body.password !== 'string') {
      return NextResponse.json({ error: 'A new password is required.' }, { status: 400 })
    }
    password = body.password
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const result = await setOwnStaffPassword(caller.uid, password)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ ok: true })
}
