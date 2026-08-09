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
import { addToSuppressionList, suppressEmailPlatformWide } from '@/lib/firebase/firestore/emailSuppressionList'

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
  bounce?: {
    bounceType?:    string    // 'Permanent' | 'Transient' | 'Undetermined'
    bounceSubType?: string    // 'General' | 'NoEmail' | 'Suppressed' | …
    timestamp?:     string
    bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string; status?: string }[]
  }
  complaint?: {
    complaintFeedbackType?: string   // 'abuse' | 'fraud' | 'not-spam' | …
    feedbackId?:            string
    timestamp?:             string
    complainedRecipients?: { emailAddress?: string }[]
  }
  delivery?:  { recipients?: string[] }
}

/** SES diagnostic for one recipient, truncated so a provider string cannot bloat the doc. */
function diagnosticFor(event: SesEvent, address: string): string | undefined {
  const hit = event.bounce?.bouncedRecipients?.find(r => r.emailAddress === address)
  const raw = hit?.diagnosticCode ?? hit?.status
  return raw ? String(raw).slice(0, 300) : undefined
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
    const reason: 'bounce' | 'complaint' = kind === 'Complaint' ? 'complaint' : 'bounce'
    const recipients = (kind === 'Complaint'
      ? event.complaint?.complainedRecipients
      : event.bounce?.bouncedRecipients
    )?.map(r => r.emailAddress ?? '').filter(Boolean) as string[] ?? []

    // ── RD-LAUNCH-05 · suppress from the SES RECIPIENT LIST, platform-wide ──
    //
    // Two defects are closed here.
    //
    // (1) Suppression used to happen only inside the matched-logs loop below, so a
    //     bounce whose emailLog could not be matched — pruned log, missing
    //     providerMessageId, or mail sent outside the logging path — was silently
    //     dropped and the dead address stayed deliverable. SES tells us exactly who
    //     bounced; that list is now the source of truth, independent of our logs.
    //
    // (2) It suppressed only under the sending organizer's uid. A hard bounce is a
    //     fact about the mailbox: it does not exist for anyone, and platform mail
    //     (OTP, welcome, settlement) has no organizer to attribute it to at all.
    //     These records are therefore written platform-wide.
    let suppressedCount = 0
    let duplicateCount  = 0
    if (isPermanent) {
      for (const address of recipients) {
        try {
          const res = await suppressEmailPlatformWide(address, reason, {
            bounceType:        event.bounce?.bounceType,
            bounceSubType:     event.bounce?.bounceSubType,
            complaintType:     event.complaint?.complaintFeedbackType,
            feedbackId:        event.complaint?.feedbackId,
            providerMessageId: messageId || undefined,
            diagnostic:        diagnosticFor(event, address),
            suppressedAt:      event.bounce?.timestamp ?? event.complaint?.timestamp,
          })
          if (res.alreadySuppressed) duplicateCount++
          else                       suppressedCount++
        } catch (err) {
          // Never 500 back to SNS for one address — AWS would retry the whole batch.
          console.error(`[ses-webhook] suppression write failed (${reason}):`,
            err instanceof Error ? err.message : err)
        }
      }
      console.warn(`[ses-webhook] ${reason} received — ${recipients.length} recipient(s), `
        + `${suppressedCount} newly suppressed, ${duplicateCount} already suppressed`)
    } else {
      console.warn(`[ses-webhook] transient bounce received (${event.bounce?.bounceType ?? 'unknown'}) — not suppressing`)
    }

    // Reconcile the Communication Log as before. Organizer-scoped suppression is kept
    // as well, so an organizer's own broadcast pre-filter stays correct.
    const matched = await matchLogs(messageId, recipients)
    for (const [logId, d] of matched) {
      await updateEmailLog(logId, 'failed', { error: reason })
      if (isPermanent && d.recipientEmail && d.organizerUid) {
        await addToSuppressionList(d.recipientEmail, d.organizerUid, reason).catch(() => { /* best-effort */ })
      }
    }
    return NextResponse.json({
      ok: true, kind, matched: matched.size,
      suppressed: suppressedCount, duplicates: duplicateCount,
    })
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
