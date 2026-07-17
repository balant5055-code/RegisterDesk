// GET/POST /api/webhooks/whatsapp — Meta Cloud API webhook.
//
// GET  — the one-time verification handshake. Meta calls this with
//        ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<nonce>.
//        We echo the challenge ONLY when the token matches META_WEBHOOK_VERIFY_TOKEN.
// POST — event delivery. The X-Hub-Signature-256 HMAC (app secret) is verified and
//        invalid signatures are rejected (401). Valid deliveries are acknowledged
//        with 200. Event PROCESSING (status/message parsing) remains a future
//        phase, so there is no duplicate-processing risk today.

import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { getWebhookVerifyToken } from '@/lib/whatsapp'
import { parseWhatsAppStatusEvents } from '@/lib/whatsapp/webhookStatus'
import { applyWhatsAppDeliveryStatus } from '@/lib/email-logs/whatsappStatus'
import { META_APP_SECRET } from '@/lib/env'

export const dynamic = 'force-dynamic'

// Constant-time string comparison — avoids leaking the verify token via timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function GET(req: NextRequest): NextResponse {
  const params    = req.nextUrl.searchParams
  const mode      = params.get('hub.mode')
  const token     = params.get('hub.verify_token')
  const challenge = params.get('hub.challenge')

  const verifyToken = getWebhookVerifyToken()
  // Fail closed when WhatsApp is not configured.
  if (!verifyToken) {
    return new NextResponse('WhatsApp webhook not configured', { status: 503 })
  }

  if (mode === 'subscribe' && token && challenge && safeEqual(token, verifyToken)) {
    // Meta requires the raw challenge echoed back as text/plain.
    return new NextResponse(challenge, {
      status:  200,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  return new NextResponse('Forbidden', { status: 403 })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Fail closed when the app secret isn't configured — cannot verify signatures.
  if (!META_APP_SECRET) {
    return new NextResponse('WhatsApp webhook not configured', { status: 503 })
  }

  // Verify Meta's X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(rawBody, appSecret).
  const signature = req.headers.get('x-hub-signature-256') ?? ''
  const raw       = await req.text()
  const expected  = `sha256=${createHmac('sha256', META_APP_SECRET).update(raw).digest('hex')}`

  if (!signature || !safeEqual(signature, expected)) {
    return new NextResponse('Invalid signature', { status: 401 })
  }

  // Valid delivery — process status events. Parsing + updates are best-effort and
  // fully idempotent/order-safe (applyWhatsAppDeliveryStatus), so we always ACK 200:
  // losing a status update only affects delivery reporting, and a non-200 would make
  // Meta retry-storm. wamid → emailLogs updates BOTH broadcast + transactional rows.
  let processed = 0
  try {
    const events = parseWhatsAppStatusEvents(JSON.parse(raw))
    for (const event of events) {
      processed += await applyWhatsAppDeliveryStatus(event).catch(() => 0)
    }
  } catch (err) {
    console.error('[webhooks/whatsapp] processing error:', err)
  }

  return NextResponse.json({ received: true, processed })
}
