// Critical operational alert PUSH delivery (GA-5 S2). Server-only.
//
// Closes the "alerts are dashboard-only" gap by emailing the platform ops inbox when
// a CRITICAL operational alert fires. It REUSES existing infrastructure end-to-end —
// getOperationsHealth + evaluateAlerts (the same rules the admin dashboard shows),
// the notification engine (CUSTOM_EMAIL), and the branding support email — and adds
// NO new alerting subsystem. De-duplicated via a single state doc so it emails on a
// NEW critical condition or a periodic re-reminder, not every tick.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { getOperationsHealth, evaluateAlerts, type OperationalAlert } from './healthMetrics'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { emailShell, escHtml } from '@/lib/email/templates/base'
import { OPS_ALERT_WEBHOOK_URL } from '@/lib/env'

const STATE_DOC = 'operationsMetrics/_alertState'
const REMIND_MS = 6 * 60 * 60 * 1000   // re-email an unresolved critical set every 6h

interface AlertState { signature?: string; lastSentAt?: number }

export interface AlertDeliveryResult {
  critical:  number
  delivered: boolean
  email:     boolean
  webhook:   boolean
  reason:    'sent' | 'deduped' | 'no_critical' | 'email_unavailable' | 'no_recipient'
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
  const prev = (await stateRef.get().catch(() => null))?.data() as AlertState | undefined
  const changed = prev?.signature !== signature
  const stale   = !prev?.lastSentAt || (now - prev.lastSentAt) >= REMIND_MS
  if (!changed && !stale) return { critical: critical.length, delivered: false, email: false, webhook: false, reason: 'deduped' }

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

  // Delivery succeeds if AT LEAST ONE channel worked.
  if (!emailSent && !webhookSent) {
    const reason = !notificationEngine.isAvailable(NotificationChannel.EMAIL) || !to ? 'email_unavailable' : 'no_recipient'
    return { critical: critical.length, delivered: false, email: false, webhook: false, reason }
  }

  await stateRef.set({ signature, lastSentAt: now, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
  return { critical: critical.length, delivered: true, email: emailSent, webhook: webhookSent, reason: 'sent' }
}
