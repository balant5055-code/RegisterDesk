// POST /api/attendee/auth/request-otp
//
// Body: { email }
//
// Sends a 6-digit Email OTP to an attendee (someone who registered or donated
// with that email). Anti-enumeration: ALWAYS returns { success: true } — the OTP
// is generated/sent only when the email actually exists, so the response never
// reveals whether an email is in the system.
//
// Storage: attendeeOtpRequests/{normalizedEmail} (one active OTP per email,
// hashed). Rate limited per email (cooldown + hourly cap) and per IP.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { getClientIp } from '@/lib/rateLimit'
import { checkDistributedRateLimit } from '@/lib/rateLimit/redis'
import { normalizeEmail, attendeeEmailExists } from '@/lib/attendee/identity'
import { generateCode, generateSalt, hashCode } from '@/lib/otp'
import { getSecurityConfig } from '@/lib/config/resolveSecurityConfig'

const HOUR_MS  = 60 * 60 * 1_000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(req)

  // Per-IP cap (blunts enumeration sweeps regardless of email). Fail-open: an
  // OTP-request flood during a Redis outage is email-cost, not a security breach.
  const ipRl = await checkDistributedRateLimit({ key: `attendee-otp-ip:${ip}`, limit: 20, windowSeconds: HOUR_MS / 1000, failOpen: true })
  if (!ipRl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  let email: string
  try {
    const body = await req.json() as Record<string, unknown>
    email = typeof body.email === 'string' ? body.email : ''
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const normalized = normalizeEmail(email)
  if (!EMAIL_RE.test(normalized) || normalized.length > 320) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
  }

  // From here on, ALWAYS return success (anti-enumeration). Work is conditional.
  const success = NextResponse.json({ success: true })

  // ── Per-email rate limit (cooldown + hourly cap) ──────────────────────────
  const now      = Date.now()
  // Effective security policy (runtime override → Firestore → code default).
  const sec          = await getSecurityConfig()
  const resendWaitMs = sec.otpResendWaitSeconds * 1_000
  const ttlMs        = sec.otpTtlSeconds * 1_000
  const limitRef = adminDb.collection('attendeeOtpRateLimits').doc(normalized)
  const limitSnap = await limitRef.get()
  if (limitSnap.exists) {
    const d           = limitSnap.data()!
    const windowStart = (d.windowStart as { toMillis?(): number })?.toMillis?.() ?? 0
    const lastSentAt  = (d.lastSentAt  as { toMillis?(): number })?.toMillis?.() ?? 0
    if (now - lastSentAt < resendWaitMs) return success                 // cooldown — silently ok
    if (now - windowStart < HOUR_MS && (d.count ?? 0) >= sec.otpMaxSendsPerHour) return success  // capped
  }

  // ── Only send if the email belongs to a real registration/donation ────────
  const exists = await attendeeEmailExists(normalized)
  if (!exists) return success   // do not reveal non-existence

  // ── Generate + store hashed OTP (single active per email) ─────────────────
  const code = generateCode(sec.otpDigits)
  const salt = generateSalt()
  const batch = adminDb.batch()

  batch.set(adminDb.collection('attendeeOtpRequests').doc(normalized), {
    normalizedEmail: normalized,
    codeHash:        hashCode(code, salt),
    salt,
    expiresAt:       new Date(now + ttlMs),
    attempts:        0,
    createdAt:       FieldValue.serverTimestamp(),
    ip,
  })

  const inWindow = limitSnap.exists &&
    now - ((limitSnap.data()!.windowStart as { toMillis?(): number })?.toMillis?.() ?? 0) < HOUR_MS
  batch.set(limitRef, {
    count:       inWindow ? FieldValue.increment(1) : 1,
    windowStart: inWindow ? (limitSnap.data()!.windowStart ?? new Date(now)) : new Date(now),
    lastSentAt:  new Date(now),
  }, { merge: true })

  await batch.commit()

  // ── Send email (best-effort; OTP doc already persisted) ───────────────────
  if (notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
    void notificationEngine.send(NotificationType.EMAIL_VERIFICATION, { to: normalized, name: normalized.split('@')[0], code })
      .catch(err => console.error('[attendee/request-otp] email send failed:', err))
  }

  return success
}
