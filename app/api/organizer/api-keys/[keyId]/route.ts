// DELETE /api/organizer/api-keys/[keyId]  — revoke a key (owner-only).

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireOwner } from '@/lib/team/access'
import { revokeApiKey }               from '@/lib/integrations/apiKeys'
import { logIntegrationAction }       from '@/lib/integrations/audit'

export async function DELETE(
  req: NextRequest, { params }: { params: Promise<{ keyId: string }> },
): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })

  const { keyId } = await params
  const ok = await revokeApiKey(caller.uid, keyId)   // verifies ownership internally
  if (!ok) return NextResponse.json({ error: 'API key not found.' }, { status: 404 })

  void logIntegrationAction({
    organizerUid: caller.uid, actorUid: caller.uid, action: 'apikey.revoked', entityId: keyId,
  }).catch(() => {})

  return NextResponse.json({ success: true })
}
