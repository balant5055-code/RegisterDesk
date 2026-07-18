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
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { verifyCode } from '@/lib/otp'
import { getSecurityConfig } from '@/lib/config/resolveSecurityConfig'
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

  // Effective security policy (runtime override → Firestore → code default).
  const sec = await getSecurityConfig()

  const { otpId, code } = body
  if (!otpId || typeof otpId !== 'string') {
    return NextResponse.json({ error: 'MISSING_OTP_ID' }, { status: 400 })
  }
  if (!code || typeof code !== 'string' || !new RegExp(`^\\d{${sec.otpDigits}}$`).test(code)) {
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
  if (attempts >= sec.otpMaxAttempts) {
    return NextResponse.json({ error: 'MAX_ATTEMPTS_REACHED' }, { status: 400 })
  }

  // ── Verify code ─────────────────────────────────────────────────────────────
  const isValid = verifyCode(code, otp.salt as string, otp.codeHash as string)

  if (!isValid) {
    const newAttempts = attempts + 1
    await otpRef.update({ attempts: newAttempts })
    const attemptsLeft = sec.otpMaxAttempts - newAttempts
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

  // ── Update organizer document (self-heal an orphaned signup) ─────────────────
  // The profile is normally created client-side right after Firebase Auth signup
  // (createOrganizerProfile → users/{uid}). Those are two independent operations; if
  // the second never landed, the Auth user exists WITHOUT a Firestore profile and a
  // bare update() throws NOT_FOUND (RD-AUTH-OTP-01). So:
  //   • profile EXISTS  → apply the verification fields exactly as before (no change);
  //   • profile MISSING → create the COMPLETE canonical profile (same shape as
  //     createOrganizerProfile) with the verification state already applied, so no
  //     partial organizer document is ever produced.
  const userRef  = adminDb.collection('users').doc(uid)
  const userSnap = await userRef.get()

  if (userSnap.exists) {
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
  } else {
    // Orphaned signup: build the canonical organizer profile (mirrors
    // createOrganizerProfile) WITH verification applied. Values are sourced from the
    // verified token / OTP request; organizationName is unknown here so it stays empty
    // (schema-consistent) and is editable later from Settings. merge:true keeps the
    // write idempotent against a concurrent profile creation.
    const email = decoded.email ?? (otp.recipient as string | undefined) ?? ''
    const name  = (decoded.name as string | undefined) ?? (email ? email.split('@')[0] : '')
    batch.set(userRef, {
      uid,
      name,
      email,
      organizationName: '',
      role:             'organizer',
      emailVerified:    true,
      verification: { email: { verified: true, verifiedAt: FieldValue.serverTimestamp(), verifiedMethod: 'otp' } },
      trust: { level: 'email_verified', score: EMAIL_VERIFIED_SCORE, badges: FieldValue.arrayUnion('email') },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
  }

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
    if (notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
      const userDoc = await userRef.get()
      const name    = (userDoc.data()?.name as string | undefined) ?? ''
      const email   = (userDoc.data()?.email as string | undefined) ?? (otp.recipient as string)
      const orgName = (userDoc.data()?.organizationName as string | undefined) ?? ''
      void notificationEngine.send(NotificationType.ACCOUNT_WELCOME, { to: email, name, orgName }).catch(() => {})
    }
  } catch { /* non-fatal */ }

  return NextResponse.json({ verified: true })
}
