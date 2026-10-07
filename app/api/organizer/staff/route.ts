// GET  /api/organizer/staff — list this workspace's staff accounts.
// POST /api/organizer/staff — create one (owner only).
//
// RD-CHECKIN-2.0.
//
// The workspace is ALWAYS the caller's own uid — never a value from the request —
// so a team member calling this sees and manages their own (empty) workspace,
// never the owner's. Same rule the team routes follow.
//
// ═══ CREDENTIALS NEVER COME BACK ═════════════════════════════════════════════
// The list returns no password material of any kind: there is nowhere in this
// system that a stored password could be read from, by design. A newly created
// account returns its password EXACTLY ONCE, in the create response, so the
// organizer can hand it over — and never again. "I forgot it" is answered by
// issuing a new one, not by retrieving the old one.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireStaffManager } from '@/lib/team/access'
import { listStaffAccounts, createStaffAccount }    from '@/lib/staff/service'
import { RATE_POLICY, checkPolicy }                 from '@/lib/rateLimit/policies'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Owner of their OWN workspace may view staff accounts. This was
  // `requireAdmin(caller.uid, caller.uid)`, which resolves to owner for any caller
  // and so decided nothing; `requireStaffManager` keeps that outcome for a person
  // and refuses a gate credential.
  const access = await requireStaffManager(caller)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })

  const staff = await listStaffAccounts(caller.uid)
  return NextResponse.json({ staff }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Issuing a credential is an owner action, and a credential may not issue further
  // credentials — see requireStaffManager (RD-CHECKIN-07 Defect 1).
  const access = await requireStaffManager(caller)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })

  // Reuses the existing team-invite budget: both mint workspace access, and neither
  // is something an organizer does in bursts.
  const rl = checkPolicy(caller.uid, RATE_POLICY.teamInvite)
  if (rl.limited) return NextResponse.json(
    { error: 'Too many staff accounts created. Please try again later.' },
    { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
  )

  // ═══ THE PLAN GATE MOVED HERE (RD-TEAM-IMPL-01) ═════════════════════════════
  // Delegated workspace access is a paid feature, and the gate used to sit on the
  // team-invite route. That route no longer creates anything, so leaving the gate
  // there and not here would have turned a paid capability into a free one — the
  // same access, issued through a different door. Same feature key, same limit key,
  // now counted against the staff roster that actually grants the access.
  // RD-CAPACITY-01 · team access and the team-size cap were licence entitlements, and the
  // capacity model has neither. Every check that decides WHO may create a staff account —
  // verifyCaller and the owner check above — is unchanged, and the created account's own
  // permissions are unaffected: this removes a seat limit, not an authorization.

  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }) }

  const result = await createStaffAccount({
    organizerUid: caller.uid,
    actorUid:     caller.uid,
    username:     typeof body.username    === 'string' ? body.username    : '',
    displayName:  typeof body.displayName === 'string' ? body.displayName : '',
    role:         typeof body.role        === 'string' ? body.role        : '',
    eventIds:     body.eventIds,
    // An organizer MAY choose the first password; most will let one be generated.
    // Either way it is handed straight to Firebase and never stored here.
    password:     typeof body.password === 'string' && body.password ? body.password : undefined,
  })

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.data, { status: 201 })
}
