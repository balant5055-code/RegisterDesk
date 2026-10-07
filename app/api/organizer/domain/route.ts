// GET    /api/organizer/domain  — current custom-domain configuration + DNS records.
// POST   /api/organizer/domain  — set/update the custom domain.
// DELETE /api/organizer/domain  — remove the custom domain.
//
// Owner-only. (RD-CAPACITY-01: custom domains are no longer a licensed feature — there is no
// plan/tier gate and no 402.)

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireOwner } from '@/lib/team/access'
import { getDomainConfig, setDomain, removeDomain } from '@/lib/domains/service'
import { logDomainAction }            from '@/lib/domains/audit'

async function gate(req: NextRequest): Promise<{ uid: string } | NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })
  // RD-CAPACITY-01 · a custom domain is no longer a licensed feature. Ownership stands.
  return { uid: caller.uid }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const g = await gate(req)
  if (g instanceof NextResponse) return g
  return NextResponse.json({ config: await getDomainConfig(g.uid) }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const g = await gate(req)
  if (g instanceof NextResponse) return g

  let body: { domain?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (typeof body.domain !== 'string' || !body.domain.trim()) {
    return NextResponse.json({ error: 'A domain is required.' }, { status: 400 })
  }

  const result = await setDomain(g.uid, body.domain)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  void logDomainAction({
    organizerUid: g.uid, actorUid: g.uid, action: 'domain.added',
    domain: result.config.customDomain ?? '',
  }).catch(() => {})

  return NextResponse.json({ config: result.config }, { status: 201 })
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const g = await gate(req)
  if (g instanceof NextResponse) return g

  const prev   = await getDomainConfig(g.uid)
  const config = await removeDomain(g.uid)
  if (prev.customDomain) {
    void logDomainAction({
      organizerUid: g.uid, actorUid: g.uid, action: 'domain.removed', domain: prev.customDomain,
    }).catch(() => {})
  }
  return NextResponse.json({ config })
}
