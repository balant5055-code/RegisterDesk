// GET  /api/organizer/api-keys  — list this organizer's API keys (no hashes).
// POST /api/organizer/api-keys  — create a key; returns the plaintext ONCE.
// Owner-only.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireOwner } from '@/lib/team/access'
import { requireFeature }             from '@/lib/licensing/workspaceEntitlements'
import { createApiKey, listApiKeys }  from '@/lib/integrations/apiKeys'
import { logIntegrationAction }       from '@/lib/integrations/audit'
import { isApiKeyPermission, type ApiKeyPermission } from '@/lib/integrations/types'
import { RATE_POLICY, checkPolicy }   from '@/lib/rateLimit/policies'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })
  // Entitlement: API access is a licensed feature (apiAccess). Enforced server-side,
  // not just hidden in the UI, so it tracks the effective license/config override.
  const feat = await requireFeature(caller.uid, 'apiAccess')
  if (!feat.ok) return NextResponse.json({ error: feat.error }, { status: feat.status })

  const keys = await listApiKeys(caller.uid)
  return NextResponse.json({ keys }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })
  const feat = await requireFeature(caller.uid, 'apiAccess')
  if (!feat.ok) return NextResponse.json({ error: feat.error }, { status: feat.status })

  // Throttle credential creation against automation / key-spraying.
  const rl = checkPolicy(caller.uid, RATE_POLICY.apiKeyCreate)
  if (rl.limited) return NextResponse.json(
    { error: 'Too many requests. Please try again later.' },
    { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
  )

  let body: { name?: unknown; permissions?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'A name is required.' }, { status: 400 })

  const permissions: ApiKeyPermission[] = Array.isArray(body.permissions)
    ? [...new Set(body.permissions.filter(isApiKeyPermission))]
    : []
  if (permissions.length === 0) {
    return NextResponse.json({ error: 'At least one valid permission is required.' }, { status: 400 })
  }

  const { view, plaintextKey } = await createApiKey(caller.uid, name, permissions)

  void logIntegrationAction({
    organizerUid: caller.uid, actorUid: caller.uid, action: 'apikey.created',
    entityId: view.keyId, metadata: { name: view.name, permissions },
  }).catch(() => {})

  // plaintextKey is returned exactly once — the client must surface it now.
  return NextResponse.json({ key: view, plaintextKey }, { status: 201 })
}
