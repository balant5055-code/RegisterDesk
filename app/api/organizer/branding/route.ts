// GET /api/organizer/branding  — current white-label branding.
// PUT /api/organizer/branding  — update branding.
//
// Owner-only. (RD-CAPACITY-01: white-label branding is no longer a licensed feature — there is no
// plan/tier gate and no 402.)

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireOwner } from '@/lib/team/access'
import { getBranding, setBranding, type BrandingPatch } from '@/lib/branding/service'
import { RATE_POLICY, checkPolicy }   from '@/lib/rateLimit/policies'

async function gate(req: NextRequest): Promise<{ uid: string } | NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })
  // RD-CAPACITY-01 · white-label branding is no longer a licensed feature. Ownership is
  // still enforced above — this gate only ever decided ENTITLEMENT, never access.
  return { uid: caller.uid }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const g = await gate(req)
  if (g instanceof NextResponse) return g
  return NextResponse.json({ branding: await getBranding(g.uid) }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const g = await gate(req)
  if (g instanceof NextResponse) return g

  const rl = checkPolicy(g.uid, RATE_POLICY.brandingUpdate)
  if (rl.limited) return NextResponse.json(
    { error: 'Too many requests. Please try again later.' },
    { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
  )

  let body: BrandingPatch
  try { body = await req.json() as BrandingPatch } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const result = await setBranding(g.uid, body)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ branding: result.branding })
}
