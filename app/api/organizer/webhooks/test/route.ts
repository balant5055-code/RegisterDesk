// POST /api/organizer/webhooks/test
//
// Enqueues a synthetic webhook.test delivery and processes it INLINE so the
// organizer gets an immediate delivery result. Owner-only.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireOwner } from '@/lib/team/access'
import { requireFeature }             from '@/lib/licensing/workspaceEntitlements'
import { getWebhookConfig, enqueueWebhook, processWebhookDelivery } from '@/lib/integrations/webhooks'
import { logIntegrationAction }       from '@/lib/integrations/audit'
import { checkDistributedRateLimit }  from '@/lib/rateLimit/redis'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })
  // Entitlement: webhooks are part of the licensed API-access feature (apiAccess).
  const feat = await requireFeature(caller.uid, 'apiAccess')
  if (!feat.ok) return NextResponse.json({ error: feat.error }, { status: feat.status })

  // 10 test deliveries / 5 min per owner (distributed). Fail-open: a Redis outage
  // shouldn't block this low-risk authenticated action.
  const rl = await checkDistributedRateLimit({ key: `webhook-test:${caller.uid}`, limit: 10, windowSeconds: 5 * 60, failOpen: true })
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many test deliveries. Please wait a moment and try again.' }, { status: 429 })
  }

  const cfg = await getWebhookConfig(caller.uid)
  if (!cfg.webhookUrl) return NextResponse.json({ error: 'Configure a webhook URL first.' }, { status: 422 })

  // Reuse the registration.created shape as a harmless sample event.
  const deliveryId = await enqueueWebhook(caller.uid, 'registration.created', {
    test: true, message: 'This is a RegisterDesk test webhook.',
  })
  if (!deliveryId) return NextResponse.json({ error: 'Could not enqueue test delivery.' }, { status: 500 })

  const outcome = await processWebhookDelivery(deliveryId)

  void logIntegrationAction({
    organizerUid: caller.uid, actorUid: caller.uid, action: 'webhook.tested', entityId: 'webhook',
    metadata: { delivered: outcome.delivered, responseCode: outcome.responseCode },
  }).catch(() => {})

  return NextResponse.json({
    delivered:    outcome.delivered,
    responseCode: outcome.responseCode,
    deliveryId,
  })
}
