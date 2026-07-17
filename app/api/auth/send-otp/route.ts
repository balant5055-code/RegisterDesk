// POST /api/auth/send-otp
// Generates and emails an OTP for the authenticated organizer.
// Phase 1: email channel only. SMS/WhatsApp channels added in later phases.
//
// Security model:
//   - Recipient email is read from Firebase Auth server-side — never from the request body.
//   - 60-second per-request cooldown prevents rapid re-sends.
//   - 5-sends-per-hour rate limit per uid+channel prevents abuse.
//   - OTP stored as SHA-256(code + salt) — never plain text.

import { NextResponse }    from 'next/server'
import { FieldValue }      from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase/admin'
import { notificationEngine, NotificationType } from '@/lib/notifications'
import { writeEmailLog }       from '@/lib/email-logs/write'
import { EMAIL_PROVIDER_NAME } from '@/lib/email'
import { generateCode, generateSalt, hashCode } from '@/lib/otp'
import { getSecurityConfig } from '@/lib/config/resolveSecurityConfig'
import type { DecodedIdToken } from 'firebase-admin/auth'

const HOUR_MS = 60 * 60 * 1_000

// Human-readable label for the Communication Log (emailLogs) row only. Mirrors the
// subject in lib/email/templates/otp.ts — the email itself is still rendered by the
// Template Registry via the Notification Engine (this route never renders it).
const OTP_EMAIL_SUBJECT = 'Your RegisterDesk verification code'

export async function POST(req: Request): Promise<NextResponse> {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const bearer = req.headers.get('authorization')?.slice(7)   // strip "Bearer "
  if (!bearer) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  let decoded: DecodedIdToken
  try {
    decoded = await adminAuth.verifyIdToken(bearer)
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  const uid = decoded.uid

  // ── Already verified? ───────────────────────────────────────────────────────
  if (decoded.email_verified) {
    return NextResponse.json({ error: 'ALREADY_VERIFIED' }, { status: 400 })
  }

  // ── Resolve email from Firebase Auth (server-side — not from request body) ─
  let recipient: string
  try {
    const authUser = await adminAuth.getUser(uid)
    if (!authUser.email) {
      return NextResponse.json({ error: 'NO_EMAIL' }, { status: 400 })
    }
    recipient = authUser.email
  } catch {
    return NextResponse.json({ error: 'USER_NOT_FOUND' }, { status: 404 })
  }

  const channel = 'email'
  const now     = Date.now()

  // Effective security policy (runtime override → Firestore → code default).
  const sec          = await getSecurityConfig()
  const resendWaitMs = sec.otpResendWaitSeconds * 1_000
  const ttlMs        = sec.otpTtlSeconds * 1_000

  // ── Rate limit ──────────────────────────────────────────────────────────────
  const limitRef  = adminDb.collection('otpRateLimits').doc(`${uid}_${channel}`)
  const limitSnap = await limitRef.get()

  if (limitSnap.exists) {
    const d           = limitSnap.data()!
    const windowStart = (d.windowStart as { toMillis?(): number })?.toMillis?.() ?? 0
    const lastSentAt  = (d.lastSentAt  as { toMillis?(): number })?.toMillis?.() ?? 0

    // Per-request cooldown
    if (now - lastSentAt < resendWaitMs) {
      const secondsLeft = Math.ceil((resendWaitMs - (now - lastSentAt)) / 1_000)
      return NextResponse.json({ error: 'COOLDOWN_ACTIVE', secondsLeft }, { status: 429 })
    }

    // Hourly cap
    const inWindow = now - windowStart < HOUR_MS
    if (inWindow && (d.count ?? 0) >= sec.otpMaxSendsPerHour) {
      const resetInMin = Math.ceil((HOUR_MS - (now - windowStart)) / 60_000)
      return NextResponse.json({ error: 'RATE_LIMITED', resetInMinutes: resetInMin }, { status: 429 })
    }
  }

  // ── Generate OTP ────────────────────────────────────────────────────────────
  const code    = generateCode(sec.otpDigits)
  const salt    = generateSalt()
  const hash    = hashCode(code, salt)
  const otpRef  = adminDb.collection('otpRequests').doc()   // auto-id
  const otpId   = otpRef.id
  const expiresAt = new Date(now + ttlMs)
  const ip      = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
               ?? req.headers.get('x-real-ip')
               ?? 'unknown'

  // ── Batch write: OTP doc + rate-limit update ─────────────────────────────────
  const batch = adminDb.batch()

  batch.set(otpRef, {
    uid,
    channel,
    recipient,
    codeHash:   hash,
    salt,
    expiresAt,
    attempts:   0,
    verified:   false,
    verifiedAt: null,
    createdAt:  FieldValue.serverTimestamp(),
    ip,
  })

  // Upsert rate-limit doc (reset window if expired)
  const existingSnap = await limitRef.get()
  if (existingSnap.exists) {
    const windowStart = (existingSnap.data()!.windowStart as { toMillis?(): number })?.toMillis?.() ?? 0
    const inWindow    = now - windowStart < HOUR_MS
    batch.update(limitRef, {
      count:       inWindow ? FieldValue.increment(1) : 1,
      windowStart: inWindow ? FieldValue.delete()     : new Date(now),
      lastSentAt:  new Date(now),
    })
  } else {
    batch.set(limitRef, {
      count:       1,
      windowStart: new Date(now),
      lastSentAt:  new Date(now),
    })
  }

  await batch.commit()

  // ── Send verification email — AWAITED so the API response reflects delivery ──
  // OTP integrity: the OTP doc is already committed above and is NEVER mutated,
  // deleted, or regenerated here — a delivery failure leaves the stored code valid.

  // Name for personalisation. A failed lookup is non-fatal (we fall back to the
  // local-part of the email); it is NOT a delivery failure, so it is not surfaced.
  let displayName = recipient.split('@')[0]
  try {
    const userDoc = await adminDb.collection('users').doc(uid).get()
    if (userDoc.exists) displayName = (userDoc.data()?.name as string | undefined) ?? displayName
  } catch (err) {
    console.warn('[send-otp] displayName lookup failed (non-fatal):', err)
  }

  // Reuse the Notification Engine → SES Provider → Template Registry. The engine
  // returns the shared NotificationResult (EmailResult) { success, messageId?, error? }.
  // A missing/disabled provider is surfaced by the engine as
  // { success: false, error: 'provider_unavailable' } — no separate guard needed.
  const result = await notificationEngine.send(NotificationType.EMAIL_VERIFICATION, {
    to:   recipient,
    name: displayName,
    code,
  })

  // Reuse the existing Communication Log (emailLogs). Written for BOTH outcomes,
  // AFTER the send, and AWAITED so the row is durable before the response returns
  // (writeEmailLog never throws — it self-logs on failure and returns '').
  await writeEmailLog({
    organizerUid:      uid,
    eventId:           '',
    eventSlug:         '',
    eventName:         '',
    templateKey:       NotificationType.EMAIL_VERIFICATION,
    recipientEmail:    recipient,
    recipientName:     displayName,
    subject:           OTP_EMAIL_SUBJECT,
    status:            result.success ? 'sent' : 'failed',
    provider:          EMAIL_PROVIDER_NAME,
    channel:           'email',
    providerMessageId: result.messageId,
    // Server-only diagnostic (full SES exception) is persisted here for debugging;
    // it is NEVER returned to the client (the response below stays generic).
    error:             result.success ? undefined : (result.errorDetail ?? result.error),
  })

  const responseBody = {
    otpId,
    expiresAt:   expiresAt.toISOString(),
    resendAfter: new Date(now + resendWaitMs).toISOString(),
  }

  // Do NOT pretend success when delivery failed. The OTP remains valid, so its
  // metadata is still returned, but with a structured, non-2xx error. The
  // normalized provider reason is recorded only in emailLogs — never leaked to the
  // client (no raw AWS/SES details in the response body).
  if (!result.success) {
    return NextResponse.json(
      { error: 'EMAIL_DELIVERY_FAILED', ...responseBody },
      { status: 502 },
    )
  }

  return NextResponse.json(responseBody)
}
