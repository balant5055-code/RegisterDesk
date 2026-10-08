// GET/POST /api/webhooks/whatsapp — Meta Cloud API webhook.
//
// GET  — the one-time verification handshake. Meta calls this with
//        ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<nonce>.
//        We echo the challenge ONLY when the token matches META_WEBHOOK_VERIFY_TOKEN.
// POST — event delivery. The X-Hub-Signature-256 HMAC (app secret) is verified and
//        invalid signatures are rejected (401). A valid delivery carries two kinds of
//        event, handled independently:
//          • statuses[] (WA-2) — delivery reporting on outbound messages. Best-effort
//            and order-safe; ALWAYS acknowledged 200 (unchanged).
//          • messages[] (WhatsApp Inbox) — inbound attendee messages. A durable,
//            idempotent receipt is written BEFORE acknowledging; if that write fails the
//            webhook answers 500 so Meta redelivers (a redelivery of a message already
//            stored is a no-op). Routing runs after the response, with a cron sweep as
//            the recovery path.

import { NextRequest, NextResponse, after } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { getWebhookVerifyToken } from '@/lib/whatsapp'
import { parseWhatsAppStatusEvents } from '@/lib/whatsapp/webhookStatus'
import { parseWhatsAppInboundMessages } from '@/lib/whatsapp/webhookInbound'
import { applyWhatsAppDeliveryStatus } from '@/lib/email-logs/whatsappStatus'
import { reconcileWhatsAppAcceptance } from '@/lib/whatsapp/acceptanceRecovery'
import { recordInboundMessages, routeInboundBatch } from '@/lib/whatsapp-inbox/persist'
import { applyInboundOptCommands } from '@/lib/whatsapp/broadcastConsent'
import { META_APP_SECRET } from '@/lib/env'

export const dynamic     = 'force-dynamic'
// Status updates are applied sequentially and inbound routing runs in after(), which
// shares this budget — the same 30s the Resend/SES webhooks declare.
export const maxDuration = 30

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

  let payload: unknown = null
  let parseError: unknown = null
  try { payload = JSON.parse(raw) } catch (err) { parseError = err }

  // Inbound messages FIRST: durability is the priority, and it must not wait behind a long
  // run of status transactions. Content is never logged — counts only.
  const inbound = parseWhatsAppInboundMessages(payload)
  let inboundFailed = 0
  if (inbound.length) {
    const rec = await recordInboundMessages(inbound)
    inboundFailed = rec.failed
    if (rec.created.length) after(() => routeInboundBatch(rec.created))
    console.info(`[webhooks/whatsapp] inbound · received=${inbound.length} created=${rec.created.length} duplicates=${rec.duplicates} failed=${rec.failed}`)

    // RD-COMMS-WA-CONSENT — a message that IS a STOP/START command changes the number's ORGANIZER
    // BROADCAST opt-out (lib/whatsapp/broadcastConsent). Applied synchronously, for redeliveries
    // too (idempotent per wamid), and a failure asks Meta to redeliver — an opt-out must not be
    // lost. Any other message changes nothing; routing above is untouched; no auto-reply is sent.
    try {
      const opt = await applyInboundOptCommands(inbound)
      if (opt.applied || opt.superseded) console.info(`[webhooks/whatsapp] opt commands · applied=${opt.applied} superseded=${opt.superseded} duplicates=${opt.duplicates}`)
    } catch (err) {
      inboundFailed++
      console.error('[webhooks/whatsapp] opt command not recorded — asking Meta to redeliver:', err instanceof Error ? err.message : err)
    }
  }

  // Valid delivery — process status events. Parsing + updates are best-effort and
  // fully idempotent/order-safe (applyWhatsAppDeliveryStatus), so we always ACK 200:
  // losing a status update only affects delivery reporting, and a non-200 would make
  // Meta retry-storm. wamid → emailLogs updates BOTH broadcast + transactional rows.
  let processed = 0
  let reconcileFailed = 0
  try {
    if (parseError) throw parseError
    const events = parseWhatsAppStatusEvents(payload)
    for (const event of events) {
      // RD-CLOSE — every status event proves Meta ACCEPTED the message (Meta only reports on
      // accepted messages). Replaying the acceptance record from the echoed callback data is
      // idempotent and recovers an acceptance whose local persistence was lost. It runs BEFORE
      // the status update so a recovered log row exists for that update to advance.
      await reconcileWhatsAppAcceptance(event).catch(err => { reconcileFailed++; console.error('[webhooks/whatsapp] acceptance reconcile failed:', err) })
      processed += await applyWhatsAppDeliveryStatus(event).catch(() => 0)
    }
  } catch (err) {
    console.error('[webhooks/whatsapp] processing error:', err)
  }

  // An inbound receipt that could not be written is the one case worth a redelivery:
  // Meta retries, the receipts already stored are skipped as duplicates, and the status
  // updates above are idempotent, so the retry costs nothing and loses nothing.
  // RD-CLOSE — an acceptance that could not be recorded is a billing fact still owed: ask Meta to
  // redeliver. Every step here is idempotent (the acceptance record is keyed by the wamid; status
  // updates only advance), so a redelivery costs nothing and loses nothing.
  if (inboundFailed > 0 || reconcileFailed > 0) {
    return NextResponse.json({ received: false, processed }, { status: 500 })
  }
  return NextResponse.json({ received: true, processed })
}
