// MSG91 transactional SMS provider (India DLT). Server-only.
//
// Deliberately small and isolated: the notification engine's provider abstraction is
// EmailProvider-shaped (22 template methods), so routing SMS through it would mean
// redesigning it. This mirrors the precedent already set by attendee WhatsApp
// (lib/registrations/sendWhatsAppConfirmation.ts), which also calls its provider
// directly and logs through writeEmailLog rather than the engine.
//
// DLT: India requires every transactional SMS to be sent against a template that is
// pre-approved on the operator's DLT portal and registered in MSG91 as a Flow. This
// module NEVER composes message text — it submits the configured template id plus
// variables, and MSG91 renders the approved body. There is no code path that can send
// unapproved content.

import { MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_TEMPLATE_ID } from '@/lib/env'

/** MSG91 Flow API v5 — the DLT-approved template submission endpoint. */
const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow/'

/** Matches the SES/Resend request timeout so no send path can hang. */
const MSG91_TIMEOUT_MS = 15_000

export type SmsFailureKind =
  /** Worth retrying: timeout, 429, 5xx, network. */
  | 'transient'
  /** Never retry: bad number, bad/unapproved template, auth rejected. */
  | 'permanent'

export interface SmsResult {
  success:      boolean
  messageId?:   string
  error?:       string        // client-safe label — never carries credentials
  errorDetail?: string        // server-only diagnostics
  failure?:     SmsFailureKind
}

/** True only when every credential is present. Unset ⇒ SMS is silently disabled. */
export function isMsg91Configured(): boolean {
  return !!(MSG91_AUTH_KEY && MSG91_SENDER_ID && MSG91_TEMPLATE_ID)
}

/** The configured template id, for logging/diagnostics. Never the auth key. */
export function msg91TemplateId(): string { return MSG91_TEMPLATE_ID }

/**
 * Classifies an HTTP status into retry policy. 4xx other than 429 is permanent:
 * retrying an invalid number or an unapproved template just burns quota forever.
 */
function classifyStatus(status: number): SmsFailureKind {
  if (status === 429) return 'transient'
  if (status >= 500)  return 'transient'
  return 'permanent'
}

/** Client-safe error label. Mirrors normalizeSesError/normalizeResendError. */
function normalizeError(msg: string): string {
  const m = msg.toLowerCase()
  if (/timeout|abort/.test(m))              return 'SMS provider timed out'
  if (/rate.?limit|too many/.test(m))       return 'SMS provider rate limit reached'
  if (/template|dlt|flow/.test(m))          return 'SMS template is not approved'
  if (/mobile|number|invalid recipient/.test(m)) return 'Invalid mobile number'
  if (/auth|unauthor|forbidden/.test(m))    return 'SMS provider rejected the credentials'
  return 'SMS could not be sent'
}

/**
 * Sends ONE transactional SMS through the configured DLT template.
 *
 * @param mobile     digits-only E.164 WITHOUT '+' (e.g. 919876543210) — produced by
 *                   lib/communication/phone.normalizePhoneNumber, never raw input.
 * @param variables  DLT template variables, keyed exactly as the approved template
 *                   declares them.
 *
 * NEVER throws — every outcome is a value, so no caller can be broken by SMS.
 */
export async function sendMsg91Sms(
  mobile: string,
  variables: Record<string, string>,
): Promise<SmsResult> {
  if (!isMsg91Configured()) {
    return { success: false, error: 'SMS is not configured', failure: 'permanent' }
  }
  if (!/^\d{10,15}$/.test(mobile)) {
    return { success: false, error: 'Invalid mobile number', failure: 'permanent' }
  }

  try {
    const res = await fetch(MSG91_FLOW_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Header-only credential. Never logged, never echoed into any result field.
        authkey: MSG91_AUTH_KEY,
      },
      body: JSON.stringify({
        template_id: MSG91_TEMPLATE_ID,
        sender:      MSG91_SENDER_ID,
        short_url:   '0',
        recipients: [{ mobiles: mobile, ...variables }],
      }),
      signal: AbortSignal.timeout(MSG91_TIMEOUT_MS),
    })

    const bodyText = await res.text().catch(() => '')

    if (!res.ok) {
      const failure = classifyStatus(res.status)
      console.error('[msg91] send failed', { status: res.status, failure, body: bodyText.slice(0, 200) })
      return {
        success: false,
        error:       normalizeError(bodyText || `HTTP ${res.status}`),
        errorDetail: `HTTP ${res.status} · ${bodyText.slice(0, 200)}`,
        failure,
      }
    }

    // MSG91 returns 200 with { type: 'success' | 'error' } — a 200 is not proof of accept.
    let parsed: { type?: string; message?: string; request_id?: string } = {}
    try { parsed = JSON.parse(bodyText) as typeof parsed } catch { /* non-JSON 200 */ }

    if (parsed.type === 'error') {
      const detail = String(parsed.message ?? 'unknown')
      console.error('[msg91] send rejected', { detail: detail.slice(0, 200) })
      return {
        success: false,
        error:       normalizeError(detail),
        errorDetail: detail.slice(0, 200),
        // A rejected submission is a content/recipient problem, not a blip.
        failure: 'permanent',
      }
    }

    return { success: true, messageId: parsed.request_id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[msg91] send threw', { message: msg.slice(0, 200) })
    return {
      success: false,
      error:       normalizeError(msg),
      errorDetail: msg.slice(0, 200),
      failure: 'transient',      // timeout / network — safe to retry
    }
  }
}
