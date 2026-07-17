// POST /api/webhooks/resend
//
// Processes Resend delivery webhooks (Svix-signed). Handles:
//   • email.bounced / email.complained → mark the matching email log(s) failed
//     and add the recipient to the sending organizer's suppression list.
//   • email.delivered                  → advance the matching log(s) to delivered.
//
// Security: the Svix signature is verified against RESEND_WEBHOOK_SECRET. When the
// secret is unset, the route fails closed (401) — it never processes unsigned data.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { adminDb }                   from '@/lib/firebase/admin'
import { updateEmailLog }            from '@/lib/email-logs/write'
import { addToSuppressionList }      from '@/lib/firebase/firestore/emailSuppressionList'
import { RESEND_WEBHOOK_SECRET }     from '@/lib/env'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const LOG_QUERY_LIMIT = 50

// ─── Svix signature verification (no SDK) ─────────────────────────────────────
// Signed content = `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 keyed
// by the base64-decoded secret (after the `whsec_` prefix), base64-compared
// (timing-safe) against each `v1,<sig>` entry in the svix-signature header.
function verifySvix(rawBody: string, headers: Headers, secret: string): boolean {
  const id   = headers.get('svix-id')
  const ts   = headers.get('svix-timestamp')
  const sigs = headers.get('svix-signature')
  if (!id || !ts || !sigs) return false

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest()

  for (const part of sigs.split(' ')) {
    const comma = part.indexOf(',')
    const value = comma >= 0 ? part.slice(comma + 1) : part
    let actual: Buffer
    try { actual = Buffer.from(value, 'base64') } catch { continue }
    if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) return true
  }
  return false
}

interface ResendEvent {
  type?: string
  data?: { email_id?: string; to?: string[] | string }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!RESEND_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 401 })
  }

  const raw = await req.text()
  if (!verifySvix(raw, req.headers, RESEND_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let event: ResendEvent
  try { event = JSON.parse(raw) as ResendEvent } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const type      = event.type ?? ''
  const messageId = event.data?.email_id ?? ''
  const toField   = event.data?.to
  const recipients = Array.isArray(toField) ? toField : (typeof toField === 'string' ? [toField] : [])

  // Resolve the affected email-log docs: by provider message id first (exact),
  // else by recipient address. Bounded by LOG_QUERY_LIMIT.
  const col = adminDb.collection('emailLogs')
  const matched = new Map<string, { organizerUid?: string; recipientEmail?: string; status?: string }>()

  if (messageId) {
    const snap = await col.where('providerMessageId', '==', messageId).limit(LOG_QUERY_LIMIT).get()
    snap.docs.forEach(d => matched.set(d.id, d.data() as { organizerUid?: string; recipientEmail?: string; status?: string }))
  }
  if (matched.size === 0) {
    for (const email of recipients.slice(0, 5)) {
      const snap = await col.where('recipientEmail', '==', email).limit(LOG_QUERY_LIMIT).get()
      snap.docs.forEach(d => matched.set(d.id, d.data() as { organizerUid?: string; recipientEmail?: string; status?: string }))
    }
  }

  if (type === 'email.bounced' || type === 'email.complained') {
    const reason = type === 'email.bounced' ? 'bounce' : 'complaint'
    for (const [logId, d] of matched) {
      await updateEmailLog(logId, 'failed', { error: reason })
      if (d.recipientEmail && d.organizerUid) {
        await addToSuppressionList(d.recipientEmail, d.organizerUid, reason).catch(() => { /* best-effort */ })
      }
    }
  } else if (type === 'email.delivered') {
    for (const [logId, d] of matched) {
      if (d.status !== 'failed') await updateEmailLog(logId, 'delivered')   // never override a bounce
    }
  }
  // Other event types are acknowledged without action.

  return NextResponse.json({ ok: true, type, matched: matched.size })
}
