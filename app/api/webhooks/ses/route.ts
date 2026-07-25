// POST /api/webhooks/ses
//
// Processes Amazon SES delivery notifications delivered via SNS (the production email
// transport is SES, so THIS — not the Resend webhook — is what reconciles delivery status).
// Handles:
//   • SNS SubscriptionConfirmation → confirms the subscription (after signature check).
//   • SES Bounce (Permanent) / Complaint → mark the matching email log(s) failed and add
//     the recipient to the sending organizer's suppression list.
//   • SES Delivery → advance the matching log(s) to delivered.
//
// Reuses the EXISTING delivery-update + suppression logic (updateEmailLog /
// addToSuppressionList) and matches by the stored SES MessageId (providerMessageId) — no
// duplicate log/suppression architecture. Security: every SNS message is signature-verified
// against the AWS signing certificate (fail-closed); an invalid/unsigned message is rejected.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { adminDb }              from '@/lib/firebase/admin'
import { updateEmailLog }       from '@/lib/email-logs/write'
import { addToSuppressionList } from '@/lib/firebase/firestore/emailSuppressionList'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const LOG_QUERY_LIMIT = 50

// ─── SNS signature verification (no SDK) ──────────────────────────────────────
// Fields signed per message type, in the AWS-specified order. Only present keys are
// included in the canonical string as `Key\nValue\n`.
const SIGNABLE_KEYS: Record<string, string[]> = {
  Notification:             ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation:  ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
}

const certCache = new Map<string, string>()

async function fetchSigningCert(url: string): Promise<string | null> {
  // SSRF guard — the cert host MUST be an AWS SNS domain.
  let host: string
  try { host = new URL(url).host } catch { return null }
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) return null
  const cached = certCache.get(url)
  if (cached) return cached
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const pem = await res.text()
    certCache.set(url, pem)
    return pem
  } catch { return null }
}

async function verifySnsSignature(msg: Record<string, unknown>): Promise<boolean> {
  const type = String(msg.Type ?? '')
  const keys = SIGNABLE_KEYS[type]
  if (!keys) return false
  const certUrl = String(msg.SigningCertURL ?? '')
  const signature = String(msg.Signature ?? '')
  if (!certUrl || !signature) return false

  let canonical = ''
  for (const key of keys) {
    const value = msg[key]
    if (value === undefined || value === null) continue
    canonical += `${key}\n${String(value)}\n`
  }

  const cert = await fetchSigningCert(certUrl)
  if (!cert) return false

  const algo = String(msg.SignatureVersion ?? '1') === '2' ? 'RSA-SHA256' : 'RSA-SHA1'
  try {
    return crypto.createVerify(algo).update(canonical, 'utf8').verify(cert, signature, 'base64')
  } catch { return false }
}

// ─── SES event shapes (inside the SNS `Message` string) ───────────────────────
interface SesEvent {
  notificationType?: string   // 'Bounce' | 'Complaint' | 'Delivery'
  eventType?:        string   // some SES configs use eventType instead
  mail?:      { messageId?: string; destination?: string[] }
  bounce?:    { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] }
  complaint?: { complainedRecipients?: { emailAddress?: string }[] }
  delivery?:  { recipients?: string[] }
}

type LogData = { organizerUid?: string; recipientEmail?: string; status?: string }

async function matchLogs(messageId: string, recipients: string[]): Promise<Map<string, LogData>> {
  const col = adminDb.collection('emailLogs')
  const matched = new Map<string, LogData>()
  if (messageId) {
    const snap = await col.where('providerMessageId', '==', messageId).limit(LOG_QUERY_LIMIT).get()
    snap.docs.forEach(d => matched.set(d.id, d.data() as LogData))
  }
  if (matched.size === 0) {
    for (const email of recipients.slice(0, 5)) {
      const snap = await col.where('recipientEmail', '==', email).limit(LOG_QUERY_LIMIT).get()
      snap.docs.forEach(d => matched.set(d.id, d.data() as LogData))
    }
  }
  return matched
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text()
  let sns: Record<string, unknown>
  try { sns = JSON.parse(raw) as Record<string, unknown> } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  // Fail-closed signature verification for EVERY SNS message.
  if (!(await verifySnsSignature(sns))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const type = String(sns.Type ?? '')

  // First-time subscription — confirm it (signature already verified above).
  if (type === 'SubscriptionConfirmation') {
    const subscribeUrl = String(sns.SubscribeURL ?? '')
    try { if (subscribeUrl) await fetch(subscribeUrl) } catch { /* AWS retries */ }
    return NextResponse.json({ ok: true, confirmed: true })
  }

  if (type !== 'Notification') {
    return NextResponse.json({ ok: true, ignored: type })
  }

  let event: SesEvent
  try { event = JSON.parse(String(sns.Message ?? '{}')) as SesEvent } catch { return NextResponse.json({ error: 'Invalid message' }, { status: 400 }) }

  const kind      = event.notificationType ?? event.eventType ?? ''
  const messageId = event.mail?.messageId ?? ''

  if (kind === 'Bounce' || kind === 'Complaint') {
    // Only PERMANENT bounces + complaints suppress; transient bounces are not permanent failures.
    const isPermanent = kind === 'Complaint' || event.bounce?.bounceType === 'Permanent'
    const reason = kind === 'Complaint' ? 'complaint' : 'bounce'
    const recipients = (kind === 'Complaint'
      ? event.complaint?.complainedRecipients
      : event.bounce?.bouncedRecipients
    )?.map(r => r.emailAddress ?? '').filter(Boolean) as string[] ?? []

    const matched = await matchLogs(messageId, recipients)
    for (const [logId, d] of matched) {
      await updateEmailLog(logId, 'failed', { error: reason })
      if (isPermanent && d.recipientEmail && d.organizerUid) {
        await addToSuppressionList(d.recipientEmail, d.organizerUid, reason).catch(() => { /* best-effort */ })
      }
    }
    return NextResponse.json({ ok: true, kind, matched: matched.size })
  }

  if (kind === 'Delivery') {
    const recipients = event.delivery?.recipients ?? event.mail?.destination ?? []
    const matched = await matchLogs(messageId, recipients)
    for (const [logId, d] of matched) {
      if (d.status !== 'failed') await updateEmailLog(logId, 'delivered')   // never override a bounce
    }
    return NextResponse.json({ ok: true, kind, matched: matched.size })
  }

  return NextResponse.json({ ok: true, kind })
}
