// POST /api/attendee/auth/verify-otp
//
// Body: { email, otp }
//
// Validates the OTP, atomically consumes it (single-use — replay-safe), then
// creates an attendee session + sets the signed httpOnly cookie. Returns the
// attendee identity.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { getClientIp } from '@/lib/rateLimit'
import { checkDistributedRateLimit } from '@/lib/rateLimit/redis'
import { normalizeEmail }            from '@/lib/attendee/identity'
import { createAttendeeSession }     from '@/lib/attendee/auth'
import { verifyCode } from '@/lib/otp'
import { getSecurityConfig } from '@/lib/config/resolveSecurityConfig'

interface OtpDoc {
  codeHash:  string
  salt:      string
  expiresAt: { toMillis?: () => number } | Date
  attempts:  number
}

class OtpError extends Error {
  constructor(public code: string, public status: number, public attemptsLeft?: number) { super(code) }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(req)

  // Per-IP verify throttle — blunts brute force across emails. Fail-CLOSED: a
  // Redis outage must not open OTP verification to unlimited guessing.
  const rl = await checkDistributedRateLimit({ key: `attendee-otp-verify:${ip}`, limit: 30, windowSeconds: 60 * 60 })
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 })
  }

  // Effective security policy (runtime override → Firestore → code default).
  const sec   = await getSecurityConfig()
  const otpRe = new RegExp(`^\\d{${sec.otpDigits}}$`)

  let email: string, otp: string
  try {
    const body = await req.json() as Record<string, unknown>
    email = typeof body.email === 'string' ? body.email : ''
    otp   = typeof body.otp === 'string' ? body.otp.trim() : ''
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const normalized = normalizeEmail(email)
  if (!normalized || !otpRe.test(otp)) {
    return NextResponse.json({ error: 'Invalid email or code.' }, { status: 400 })
  }

  const otpRef    = adminDb.collection('attendeeOtpRequests').doc(normalized)
  const userAgent = (req.headers.get('user-agent') ?? 'unknown').slice(0, 400)

  // ── Atomic check-and-consume (claims the OTP so it can never be reused) ───
  try {
    await adminDb.runTransaction(async tx => {
      const snap = await tx.get(otpRef)
      if (!snap.exists) throw new OtpError('INVALID_OR_EXPIRED', 400)
      const d = snap.data() as OtpDoc

      const expiresMs = (d.expiresAt as { toMillis?: () => number })?.toMillis?.()
        ?? (d.expiresAt as Date)?.getTime?.() ?? 0
      if (Date.now() > expiresMs) { tx.delete(otpRef); throw new OtpError('EXPIRED', 400) }

      const attempts = d.attempts ?? 0
      if (attempts >= sec.otpMaxAttempts) { tx.delete(otpRef); throw new OtpError('MAX_ATTEMPTS', 429) }

      if (!verifyCode(otp, d.salt, d.codeHash)) {
        tx.update(otpRef, { attempts: attempts + 1 })
        throw new OtpError('INVALID_CODE', 400, sec.otpMaxAttempts - (attempts + 1))
      }

      // Correct — consume (single-use): delete so a replay finds nothing.
      tx.delete(otpRef)
    })
  } catch (err) {
    if (err instanceof OtpError) {
      return NextResponse.json(
        { error: 'Invalid or expired code.', code: err.code, ...(err.attemptsLeft !== undefined ? { attemptsLeft: err.attemptsLeft } : {}) },
        { status: err.status },
      )
    }
    console.error('[attendee/verify-otp] transaction failed:', err)
    return NextResponse.json({ error: 'Could not verify the code. Please try again.' }, { status: 500 })
  }

  // ── Create session + set cookie ───────────────────────────────────────────
  await createAttendeeSession({ email: normalized, normalizedEmail: normalized, ip, userAgent })

  return NextResponse.json({ authenticated: true, email: normalized })
}
