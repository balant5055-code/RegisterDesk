// Critical operational alert PUSH delivery (GA-5 S2). Server-only.
//
// Closes the "alerts are dashboard-only" gap by emailing the platform ops inbox when
// a CRITICAL operational alert fires. It REUSES existing infrastructure end-to-end —
// getOperationsHealth + evaluateAlerts (the same rules the admin dashboard shows),
// the notification engine (CUSTOM_EMAIL), and the branding support email — and adds
// NO new alerting subsystem. De-duplicated via a single state doc so it emails on a
// NEW critical condition or a periodic re-reminder, not every tick.

import { randomUUID } from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { getOperationsHealth, evaluateAlerts, type OperationalAlert } from './healthMetrics'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { emailShell, escHtml } from '@/lib/email/templates/base'
import { OPS_ALERT_WEBHOOK_URL } from '@/lib/env'

const STATE_DOC = 'operationsMetrics/_alertState'
const REMIND_MS = 6 * 60 * 60 * 1000   // re-email an unresolved critical set every 6h
/**
 * RD-NOTIFY-DEDUP-02 — how long a claim protects a delivery in progress. Longer than the route's
 * maxDuration (60 s) plus the cron's curl retry (--retry 2, --retry-delay 5, --max-time 65), so a retry
 * of a run that was cut off finds the claim still live and does not send again.
 */
export const ALERT_CLAIM_TTL_MS = 5 * 60 * 1000

interface AlertClaim {
  id:        string
  signature: string
  at:        number
  /** 'claimed' = nothing sent yet · 'sending' = a channel may have been called. */
  phase:     'claimed' | 'sending'
}
interface AlertState { signature?: string; lastSentAt?: number; claim?: AlertClaim }

export interface AlertDeliveryResult {
  critical:  number
  delivered: boolean
  email:     boolean
  webhook:   boolean
  reason:    'sent' | 'deduped' | 'in_flight' | 'no_critical' | 'email_unavailable' | 'no_recipient'
}

/**
 * RD-NOTIFY-DEDUP-02 — PURE. What a run should do, given the stored state. A claim older than the TTL
 * belongs to a run that died: in phase 'claimed' nothing was sent, so it is simply dropped; in phase
 * 'sending' an email may already have gone out, so it is settled AS SENT for its alert set (the next
 * send for that set waits for the reminder window) — the duplicate-avoiding side of the trade-off.
 */
export function planAlertDelivery(prev: AlertState | undefined, signature: string, now: number):
  | { action: 'in_flight' }
  | { action: 'deduped'; settle: Partial<AlertState> | null }
  | { action: 'claim'; settle: Partial<AlertState> | null } {
  let settle: Partial<AlertState> | null = null
  let effSignature = prev?.signature
  let effLastSentAt = prev?.lastSentAt
  const c = prev?.claim
  if (c) {
    if (now - c.at < ALERT_CLAIM_TTL_MS) return { action: 'in_flight' }
    if (c.phase === 'sending') {
      effSignature = c.signature
      effLastSentAt = Math.max(effLastSentAt ?? 0, c.at)
      settle = { signature: c.signature, lastSentAt: effLastSentAt }
    } else settle = {}
  }
  const changed = effSignature !== signature
  const stale   = typeof effLastSentAt !== 'number' || (now - effLastSentAt) >= REMIND_MS
  return changed || stale ? { action: 'claim', settle } : { action: 'deduped', settle }
}

// GA-7E S1 — out-of-band notifier. POSTs the critical alerts to OPS_ALERT_WEBHOOK_URL
// (Slack Incoming Webhook / generic JSON / PagerDuty proxy). Independent of SES so a mail
// outage never suppresses the page. Best-effort; never throws. Returns whether it delivered.
async function postAlertWebhook(alerts: OperationalAlert[], platformName: string, generatedAt: string): Promise<boolean> {
  const url = OPS_ALERT_WEBHOOK_URL
  if (!url) return false
  const text = `[${platformName}] Critical operations alert(s):\n` + alerts.map(a => `• ${a.message}`).join('\n')
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text, platformName, generatedAt, alerts }),   // `text` = Slack-native
    })
    return res.ok
  } catch { return false }
}

/**
 * Evaluates operational health and emails the ops inbox on critical alerts.
 * Idempotent per condition: the same critical set is re-sent only after REMIND_MS.
 * Never throws.
 */
export async function deliverCriticalAlerts(now: number): Promise<AlertDeliveryResult> {
  const health = await getOperationsHealth()
  const critical = evaluateAlerts(health).filter(a => a.severity === 'critical')
  const stateRef = adminDb.doc(STATE_DOC)

  if (critical.length === 0) {
    // Clear the signature so a future recurrence of the same condition re-alerts.
    await stateRef.set({ signature: '', lastClearedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
    return { critical: 0, delivered: false, email: false, webhook: false, reason: 'no_critical' }
  }

  const signature = critical.map(a => a.id).sort().join('|')

  // RD-NOTIFY-DEDUP-02 — CLAIM before sending, in a transaction. It used to read the state, send, and
  // only then record the send: two overlapping runs — or the cron's curl retry of a run that was cut off
  // after sending — both saw "not sent yet" and both emailed the ops inbox. Now exactly one run per
  // (alert set, reminder window) holds the claim; the others answer 'in_flight' or 'deduped'.
  //
  // TRADE-OFF (documented, not exactly-once): a run that dies AFTER calling a channel cannot know whether
  // the email went out. Its claim is then settled as sent (no duplicate) and the next email for that set
  // waits for the 6-hour reminder — or goes out at once if the set changes. A run that dies BEFORE any
  // channel is called leaves a 'claimed' claim, which expires and is retried normally (no loss).
  const claimId = randomUUID()
  let plan: ReturnType<typeof planAlertDelivery>
  try {
    plan = await adminDb.runTransaction(async txn => {
      const prev = (await txn.get(stateRef)).data() as AlertState | undefined
      const p = planAlertDelivery(prev, signature, now)
      if (p.action === 'in_flight') return p
      const settled = p.settle ? { ...p.settle, claim: FieldValue.delete() } : {}
      if (p.action === 'deduped') { if (p.settle) txn.set(stateRef, settled, { merge: true }); return p }
      txn.set(stateRef, { ...settled, claim: { id: claimId, signature, at: now, phase: 'claimed' } satisfies AlertClaim, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      return p
    })
  } catch (err) {
    console.error('[ops-alerts] claim failed', err)
    return { critical: critical.length, delivered: false, email: false, webhook: false, reason: 'in_flight' }
  }
  if (plan.action === 'in_flight') return { critical: critical.length, delivered: false, email: false, webhook: false, reason: 'in_flight' }
  if (plan.action === 'deduped')   return { critical: critical.length, delivered: false, email: false, webhook: false, reason: 'deduped' }

  // Still ours? Mark the claim 'sending' immediately before the first channel is called.
  const stillOurs = await adminDb.runTransaction(async txn => {
    const cur = (await txn.get(stateRef)).data() as AlertState | undefined
    if (cur?.claim?.id !== claimId) return false
    txn.update(stateRef, { 'claim.phase': 'sending' })
    return true
  }).catch(() => false)
  if (!stillOurs) return { critical: critical.length, delivered: false, email: false, webhook: false, reason: 'in_flight' }

  const branding = await getBrandingConfig()

  // Out-of-band channel FIRST — independent of SES so a mail outage can't suppress the page.
  const webhookSent = await postAlertWebhook(critical, branding.platformName, health.generatedAt)

  // Email channel (best-effort).
  let emailSent = false
  const to = branding.supportEmail
  if (notificationEngine.isAvailable(NotificationChannel.EMAIL) && to) {
    const subject = `[${branding.platformName}] Critical operations alert (${critical.length})`
    const body =
      `<p>The following <strong>critical</strong> operational alert(s) require attention:</p>` +
      `<ul>${critical.map(a => `<li>${escHtml(a.message)}</li>`).join('')}</ul>` +
      `<p>Open the Operations dashboard for detail. Generated ${escHtml(health.generatedAt)}.</p>`
    try {
      await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to, subject, html: emailShell(subject, body) })
      emailSent = true
    } catch { emailSent = false }
  }

  // Delivery succeeds if AT LEAST ONE channel worked. Either way the claim is released — but only
  // while it is still ours (a run that outlived its claim never overwrites a newer one).
  const delivered = emailSent || webhookSent
  await adminDb.runTransaction(async txn => {
    const cur = (await txn.get(stateRef)).data() as AlertState | undefined
    if (cur?.claim?.id !== claimId) return
    txn.set(stateRef, {
      ...(delivered ? { signature, lastSentAt: now } : {}),
      claim: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
  }).catch(err => console.error('[ops-alerts] settle failed', err))

  if (!delivered) {
    const reason = !notificationEngine.isAvailable(NotificationChannel.EMAIL) || !to ? 'email_unavailable' : 'no_recipient'
    return { critical: critical.length, delivered: false, email: false, webhook: false, reason }
  }
  return { critical: critical.length, delivered: true, email: emailSent, webhook: webhookSent, reason: 'sent' }
}
