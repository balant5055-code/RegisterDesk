// POST /api/auth/verify-otp
// Validates a submitted OTP against the hashed value in Firestore.
// On success: marks Firestore doc verified, sets Firebase Auth emailVerified = true,
// updates the organizer document with verification + trust data.
//
// All writes are batched atomically. Firebase Auth update is separate (Admin SDK
// does not support batching Auth + Firestore).

import { NextResponse }       from 'next/server'
import { FieldValue }         from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase/admin'
import { getEmailProvider }   from '@/lib/email'
import { verifyCode, OTP_MAX_ATTEMPTS } from '@/lib/otp'
import type { DecodedIdToken } from 'firebase-admin/auth'

// Trust score granted for email verification (adds to the 20-point base)
const EMAIL_VERIFIED_SCORE = 45   // 20 base + 25 email = 45 total

export async function POST(req: Request): Promise<NextResponse> {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const bearer = req.headers.get('authorization')?.slice(7)
  if (!bearer) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  let decoded: DecodedIdToken
  try {
    decoded = await adminAuth.verifyIdToken(bearer)
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  const uid = decoded.uid

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: { otpId?: string; code?: string }
  try {
    body = await req.json() as { otpId?: string; code?: string }
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 })
  }

  const { otpId, code } = body
  if (!otpId || typeof otpId !== 'string') {
    return NextResponse.json({ error: 'MISSING_OTP_ID' }, { status: 400 })
  }
  if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: 'INVALID_CODE_FORMAT' }, { status: 400 })
  }

  // ── Load OTP request ────────────────────────────────────────────────────────
  const otpRef  = adminDb.collection('otpRequests').doc(otpId)
  const otpSnap = await otpRef.get()

  if (!otpSnap.exists) {
    return NextResponse.json({ error: 'OTP_NOT_FOUND' }, { status: 404 })
  }

  const otp = otpSnap.data()!

  // UID mismatch — someone else's OTP
  if (otp.uid !== uid) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  }

  // Already verified
  if (otp.verified === true) {
    return NextResponse.json({ error: 'ALREADY_VERIFIED' }, { status: 400 })
  }

  // Expired
  const expiresAt = (otp.expiresAt as { toMillis?(): number; getTime?(): number })
  const expiresMs = expiresAt?.toMillis?.() ?? (expiresAt as unknown as Date)?.getTime?.() ?? 0
  if (Date.now() > expiresMs) {
    return NextResponse.json({ error: 'EXPIRED' }, { status: 400 })
  }

  // Max attempts reached
  const attempts = (otp.attempts as number) ?? 0
  if (attempts >= OTP_MAX_ATTEMPTS) {
    return NextResponse.json({ error: 'MAX_ATTEMPTS_REACHED' }, { status: 400 })
  }

  // ── Verify code ─────────────────────────────────────────────────────────────
  const isValid = verifyCode(code, otp.salt as string, otp.codeHash as string)

  if (!isValid) {
    const newAttempts = attempts + 1
    await otpRef.update({ attempts: newAttempts })
    const attemptsLeft = OTP_MAX_ATTEMPTS - newAttempts
    return NextResponse.json(
      { error: 'INVALID_CODE', attemptsLeft },
      { status: 400 },
    )
  }

  // ── Mark OTP as verified ─────────────────────────────────────────────────────
  const batch = adminDb.batch()

  batch.update(otpRef, {
    verified:   true,
    verifiedAt: FieldValue.serverTimestamp(),
  })

  // ── Update organizer document ────────────────────────────────────────────────
  const userRef = adminDb.collection('users').doc(uid)
  batch.update(userRef, {
    emailVerified: true,           // backward-compat flat field
    'verification.email.verified':      true,
    'verification.email.verifiedAt':    FieldValue.serverTimestamp(),
    'verification.email.verifiedMethod': 'otp',
    'trust.level':  'email_verified',
    'trust.score':  EMAIL_VERIFIED_SCORE,
    'trust.badges': FieldValue.arrayUnion('email'),
    updatedAt:      FieldValue.serverTimestamp(),
  })

  await batch.commit()

  // ── Set Firebase Auth emailVerified = true ───────────────────────────────────
  // Done after the batch so the Firestore state is always consistent even if
  // the Admin Auth update has transient issues.
  try {
    await adminAuth.updateUser(uid, { emailVerified: true })
  } catch {
    // Non-fatal: the Firestore verification record is the source of truth.
    // Firebase Auth will sync on next sign-in or token refresh.
  }

  // ── Send welcome email (fire-and-forget) ────────────────────────────────────
  try {
    const emailProvider = getEmailProvider()
    if (emailProvider) {
      const userDoc = await userRef.get()
      const name    = (userDoc.data()?.name as string | undefined) ?? ''
      const email   = (userDoc.data()?.email as string | undefined) ?? (otp.recipient as string)
      const orgName = (userDoc.data()?.organizationName as string | undefined) ?? ''
      emailProvider.sendWelcomeEmail({ to: email, name, orgName }).catch(() => {})
    }
  } catch { /* non-fatal */ }

  return NextResponse.json({ verified: true })
}
