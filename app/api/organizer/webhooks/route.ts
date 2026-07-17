// GET /api/organizer/webhooks   — webhook config (url + secret) + recent deliveries.
// PUT /api/organizer/webhooks   — set the target URL; optionally rotate the secret.
// Owner-only. The secret is the organizer's own HMAC signing key — returned only
// to the owner (needed to verify X-RegisterDesk-Signature), never exposed elsewhere.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireOwner } from '@/lib/team/access'
import { requireFeature }             from '@/lib/licensing/workspaceEntitlements'
import { getWebhookConfig, setWebhookConfig, listWebhookDeliveries } from '@/lib/integrations/webhooks'
import { logIntegrationAction }       from '@/lib/integrations/audit'
import { validateWebhookTarget }      from '@/lib/security/ssrf'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })
  // Entitlement: webhooks are part of the licensed API-access feature (apiAccess).
  const feat = await requireFeature(caller.uid, 'apiAccess')
  if (!feat.ok) return NextResponse.json({ error: feat.error }, { status: feat.status })

  const [config, deliveries] = await Promise.all([
    getWebhookConfig(caller.uid),
    listWebhookDeliveries(caller.uid, 50),
  ])
  return NextResponse.json({ config, deliveries }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })
  const feat = await requireFeature(caller.uid, 'apiAccess')
  if (!feat.ok) return NextResponse.json({ error: feat.error }, { status: feat.status })

  let body: { webhookUrl?: unknown; rotateSecret?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const url = body.webhookUrl === null || body.webhookUrl === '' ? null
    : typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : undefined
  if (url === undefined) return NextResponse.json({ error: 'webhookUrl must be a string or null.' }, { status: 400 })

  // SSRF: reject non-https + any URL that resolves to a private/internal address.
  // Validated at save-time so bad targets never reach the delivery engine.
  if (url !== null) {
    const target = await validateWebhookTarget(url)
    if (!target.ok) {
      return NextResponse.json(
        { error: 'INVALID_WEBHOOK_TARGET', detail: target.error, reason: target.reason },
        { status: 400 },
      )
    }
  }

  const existed = (await getWebhookConfig(caller.uid)).webhookUrl !== null
  const config  = await setWebhookConfig(caller.uid, url, body.rotateSecret === true)

  void logIntegrationAction({
    organizerUid: caller.uid, actorUid: caller.uid,
    action: existed ? 'webhook.updated' : 'webhook.created', entityId: 'webhook',
    metadata: { hasUrl: url !== null, rotated: body.rotateSecret === true },
  }).catch(() => {})

  return NextResponse.json({ config })
}
