// Webhook engine — server-only. Config lives on users/{uid} (webhookUrl +
// webhookSecret). enqueueWebhook writes a pending delivery; the cron (or the test
// route) calls processWebhookDelivery which signs + POSTs with a 10s timeout and
// applies the exponential retry policy. Deliveries are at-least-once; consumers
// dedupe on deliveryId.

import { randomBytes, createHmac } from 'crypto'
import { fetch as undiciFetch, Agent } from 'undici'
import { FieldValue, Timestamp }   from 'firebase-admin/firestore'
import { adminDb }                 from '@/lib/firebase/admin'
import { captureWebhookError }     from '@/lib/monitoring/sentry'
import { validateWebhookTarget, ssrfSafeLookup } from '@/lib/security/ssrf'
import {
  type WebhookEventType, type WebhookConfig, type WebhookDeliveryDocument, type WebhookDeliveryView,
  WEBHOOK_BACKOFF_MS, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_TIMEOUT_MS,
} from '@/lib/integrations/types'

const DELIVERIES = 'webhookDeliveries'

// Shared dispatcher whose connector re-validates the ACTUAL connected address —
// the DNS-rebinding-resistant enforcement point (see lib/security/ssrf.ts).
const ssrfDispatcher = new Agent({ connect: { lookup: ssrfSafeLookup } })

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

// ─── Config (users/{uid}.webhookUrl + webhookSecret) ──────────────────────────

export async function getWebhookConfig(uid: string): Promise<WebhookConfig> {
  const snap = await adminDb.doc(`users/${uid}`).get()
  const d = snap.data() as { webhookUrl?: unknown; webhookSecret?: unknown } | undefined
  return {
    webhookUrl:    typeof d?.webhookUrl    === 'string' ? d.webhookUrl    : null,
    webhookSecret: typeof d?.webhookSecret === 'string' ? d.webhookSecret : null,
  }
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`
}

/** Sets the target URL and (optionally) rotates the signing secret. Returns the
 *  resulting config. Generates a secret on first configuration. */
export async function setWebhookConfig(
  uid: string, webhookUrl: string | null, rotateSecret = false,
): Promise<WebhookConfig> {
  const ref = adminDb.doc(`users/${uid}`)
  const cur = await getWebhookConfig(uid)
  const secret = (rotateSecret || !cur.webhookSecret) ? generateWebhookSecret() : cur.webhookSecret
  await ref.set({
    webhookUrl:    webhookUrl ? webhookUrl.trim() : null,
    webhookSecret: secret,
    webhookUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
  return { webhookUrl: webhookUrl ? webhookUrl.trim() : null, webhookSecret: secret }
}

// ─── Signing ──────────────────────────────────────────────────────────────────

export function signWebhookBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

// ─── Enqueue ──────────────────────────────────────────────────────────────────

/**
 * Records a pending webhook delivery for an organizer event. No-op (returns null)
 * when the organizer has no webhook URL configured. Fire-and-forget at call sites:
 * never throws into the business flow.
 */
export async function enqueueWebhook(
  organizerUid: string, eventType: WebhookEventType, data: Record<string, unknown>,
): Promise<string | null> {
  try {
    const cfg = await getWebhookConfig(organizerUid)
    if (!cfg.webhookUrl) return null

    const ref = adminDb.collection(DELIVERIES).doc()
    const payload = { event: eventType, deliveryId: ref.id, timestamp: new Date().toISOString(), data }
    const doc: WebhookDeliveryDocument = {
      deliveryId:   ref.id,
      organizerUid,
      eventType,
      targetUrl:    cfg.webhookUrl,
      payload,
      status:       'pending',
      attempts:     0,
      responseCode: null,
      responseBody: null,
      nextRetryAt:  FieldValue.serverTimestamp(),   // due immediately; cron picks it up
      lastError:    null,
      createdAt:    FieldValue.serverTimestamp(),
      updatedAt:    FieldValue.serverTimestamp(),
    }
    await ref.set(doc)
    return ref.id
  } catch (err) {
    captureWebhookError(err, { scope: 'enqueueWebhook.failed', detail: 'non-fatal', organizerUid, eventType })
    return null
  }
}

// ─── Delivery ─────────────────────────────────────────────────────────────────

export interface DeliveryOutcome { delivered: boolean; responseCode: number | null; attempts: number }

/**
 * Delivers (or retries) a single webhook. Claims the delivery in a transaction
 * (bumps attempts + pushes nextRetryAt out as a lock) so overlapping cron runs
 * never double-send within the send window. Signs the raw JSON body with the
 * organizer secret, POSTs with a 10s timeout, and records the result + the next
 * retry per the backoff policy. Success = 2xx; everything else retries until
 * WEBHOOK_MAX_ATTEMPTS, then 'failed'.
 */
export async function processWebhookDelivery(deliveryId: string): Promise<DeliveryOutcome> {
  const ref = adminDb.collection(DELIVERIES).doc(deliveryId)

  // ── Claim ──────────────────────────────────────────────────────────────────
  const claim = await adminDb.runTransaction<{ go: boolean; doc?: WebhookDeliveryDocument; attempt?: number }>(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { go: false }
    const d = snap.data() as WebhookDeliveryDocument
    if (d.status !== 'pending') return { go: false }
    const attempt = (d.attempts ?? 0) + 1
    // Lock for the send window so a concurrent cron run skips it.
    tx.update(ref, {
      attempts:    attempt,
      nextRetryAt: Timestamp.fromMillis(Date.now() + WEBHOOK_TIMEOUT_MS + 5_000),
      updatedAt:   FieldValue.serverTimestamp(),
    })
    return { go: true, doc: d, attempt }
  })
  if (!claim.go || !claim.doc || claim.attempt === undefined) {
    return { delivered: false, responseCode: null, attempts: 0 }
  }

  const d       = claim.doc
  const attempt = claim.attempt
  const cfg     = await getWebhookConfig(d.organizerUid)
  const secret  = cfg.webhookSecret ?? ''
  const body    = JSON.stringify(d.payload)
  const signature = signWebhookBody(body, secret)

  // ── SSRF pre-check (https + resolved-address safety). Fail closed. ──────────
  // A blocked/unresolvable target is a hard failure for this delivery — do not
  // retry an internal/invalid URL. The dispatcher below is the rebinding-proof
  // enforcement at connect time; this pre-check rejects obvious cases early.
  const target = await validateWebhookTarget(d.targetUrl)
  if (!target.ok) {
    captureWebhookError(`ssrf_blocked:${target.error}`, { scope: 'webhookDelivery.ssrf_blocked', deliveryId: d.deliveryId, reason: target.reason })
    await ref.update({
      status: 'failed', responseCode: null, responseBody: null,
      lastError: `ssrf_blocked:${target.error}`,
      nextRetryAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    })
    return { delivered: false, responseCode: null, attempts: attempt }
  }

  let responseCode: number | null = null
  let responseBody = ''
  let ok = false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
    try {
      const res = await undiciFetch(d.targetUrl, {
        method: 'POST',
        headers: {
          'content-type':            'application/json',
          'user-agent':              'RegisterDesk-Webhooks/1',
          'x-registerdesk-event':    d.eventType,
          'x-registerdesk-delivery': d.deliveryId,
          'x-registerdesk-signature': signature,
        },
        body,
        signal: controller.signal,
        dispatcher: ssrfDispatcher,   // connection-time SSRF enforcement
        redirect: 'manual',           // never auto-follow a redirect to an internal host
      })
      responseCode = res.status
      responseBody = (await res.text().catch(() => '')).slice(0, 1000)
      ok = res.status >= 200 && res.status < 300
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    responseBody = (err instanceof Error ? err.message : 'request_failed').slice(0, 1000)
  }

  // ── Record result ───────────────────────────────────────────────────────────
  if (ok) {
    await ref.update({
      status: 'delivered', responseCode, responseBody, lastError: null,
      updatedAt: FieldValue.serverTimestamp(),
    })
    return { delivered: true, responseCode, attempts: attempt }
  }

  const exhausted = attempt >= WEBHOOK_MAX_ATTEMPTS
  const delayMs   = WEBHOOK_BACKOFF_MS[Math.min(attempt - 1, WEBHOOK_BACKOFF_MS.length - 1)]
  await ref.update({
    status:       exhausted ? 'failed' : 'pending',
    responseCode,
    responseBody: responseBody || null,
    lastError:    responseBody || 'delivery_failed',
    nextRetryAt:  exhausted ? FieldValue.serverTimestamp() : Timestamp.fromMillis(Date.now() + delayMs),
    updatedAt:    FieldValue.serverTimestamp(),
  })
  // Alert only when a delivery is permanently given up (dead-letter), not on each retry.
  if (exhausted) {
    captureWebhookError('webhook_delivery_exhausted', { scope: 'webhookDelivery.exhausted', deliveryId: ref.id, responseCode, attempts: attempt })
  }
  return { delivered: false, responseCode, attempts: attempt }
}

// ─── Listing (organizer UI) ───────────────────────────────────────────────────

export async function listWebhookDeliveries(organizerUid: string, limitN = 50): Promise<WebhookDeliveryView[]> {
  const snap = await adminDb.collection(DELIVERIES)
    .where('organizerUid', '==', organizerUid)
    .orderBy('createdAt', 'desc')
    .limit(limitN)
    .get()
  return snap.docs.map(doc => {
    const d = doc.data() as WebhookDeliveryDocument
    return {
      deliveryId:   d.deliveryId,
      eventType:    d.eventType,
      status:       d.status,
      attempts:     d.attempts ?? 0,
      responseCode: d.responseCode ?? null,
      responseBody: d.responseBody ?? null,
      createdAt:    tsToISO(d.createdAt),
    }
  })
}

/** Finds due pending deliveries for the cron worker. */
export async function dueDeliveries(limitN = 50): Promise<string[]> {
  const snap = await adminDb.collection(DELIVERIES)
    .where('status', '==', 'pending')
    .where('nextRetryAt', '<=', Timestamp.now())
    .orderBy('nextRetryAt', 'asc')
    .limit(limitN)
    .get()
  return snap.docs.map(d => d.id)
}
