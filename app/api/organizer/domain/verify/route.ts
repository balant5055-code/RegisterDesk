// POST /api/organizer/domain/verify — checks DNS propagation for the custom
// domain. On success → status 'verified' + SSL 'active'. Owner-only + plan-gated.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireOwner } from '@/lib/team/access'
import { requireFeature }             from '@/lib/licensing/workspaceEntitlements'
import { verifyDomain }               from '@/lib/domains/service'
import { logDomainAction }            from '@/lib/domains/audit'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })
  const feat = await requireFeature(caller.uid, 'customDomain')
  if (!feat.ok) return NextResponse.json({ error: feat.error }, { status: feat.status })

  const result = await verifyDomain(caller.uid)
  if (result.ok) {
    void logDomainAction({
      organizerUid: caller.uid, actorUid: caller.uid, action: 'domain.verified',
      domain: result.config.customDomain ?? '',
    }).catch(() => {})
    return NextResponse.json({ config: result.config })
  }

  if (result.config?.customDomain) {
    void logDomainAction({
      organizerUid: caller.uid, actorUid: caller.uid, action: 'domain.failed',
      domain: result.config.customDomain, metadata: { error: result.error },
    }).catch(() => {})
  }
  return NextResponse.json({ error: result.error, config: result.config }, { status: result.status })
}
