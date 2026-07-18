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
import { getClientIp } from '@/lib/rateLimit'
import { checkDistributedRateLimit } from '@/lib/rateLimit/redis'
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

  // ── Per-account throttle (RD-AUTH-GA-01) — defense-in-depth on top of the atomic
  //    attempts cap below. Mirrors the attendee verify route. Keyed by uid+IP.
  const ip = getClientIp(req)
  const rl = await checkDistributedRateLimit({ key: `organizer-otp-verify:${uid}:${ip}`, limit: 30, windowSeconds: 60 * 60 })
  if (!rl.allowed) {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 })
  }

  const otpRef  = adminDb.collection('otpRequests').doc(otpId)
  const userRef = adminDb.collection('users').doc(uid)

  // ── Atomic verify (RD-AUTH-GA-01) ────────────────────────────────────────────
  // The attempts gate + code check + attempts-increment / mark-verified all run in ONE
  // transaction, so concurrent requests against the same OTP can NEVER bypass the cap
  // (the previous non-atomic read→gate→update let N racers each pass the stale gate and
  // collapse to one increment, defeating the lockout). Firestore requires all reads
  // before writes, so both docs are read up front; the profile self-heal (RD-AUTH-OTP-02)
  // stays atomic with marking the OTP verified.
  type VerifyOutcome =
    | { kind: 'not_found' }
    | { kind: 'forbidden' }
    | { kind: 'already' }
    | { kind: 'expired' }
    | { kind: 'max' }
    | { kind: 'invalid'; attemptsLeft: number }
    | { kind: 'ok'; recipient: string }

  const outcome = await adminDb.runTransaction<VerifyOutcome>(async (tx) => {
    // READS FIRST (Firestore transaction rule).
    const [otpSnapT, userSnapT] = await Promise.all([tx.get(otpRef), tx.get(userRef)])
    if (!otpSnapT.exists) return { kind: 'not_found' }
    const otp = otpSnapT.data()!

    if (otp.uid !== uid)      return { kind: 'forbidden' }
    if (otp.verified === true) return { kind: 'already' }

    const expiresAt = (otp.expiresAt as { toMillis?(): number; getTime?(): number })
    const expiresMs = expiresAt?.toMillis?.() ?? (expiresAt as unknown as Date)?.getTime?.() ?? 0
    if (Date.now() > expiresMs) return { kind: 'expired' }

    const attempts = (otp.attempts as number) ?? 0
    if (attempts >= sec.otpMaxAttempts) return { kind: 'max' }

    // WRITES.
    if (!verifyCode(code, otp.salt as string, otp.codeHash as string)) {
      tx.update(otpRef, { attempts: FieldValue.increment(1) })
      return { kind: 'invalid', attemptsLeft: sec.otpMaxAttempts - (attempts + 1) }
    }

    // Valid — mark verified + self-heal the organizer profile atomically.
    tx.update(otpRef, { verified: true, verifiedAt: FieldValue.serverTimestamp() })
    if (userSnapT.exists) {
      tx.update(userRef, {
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
      // Orphaned signup: create the COMPLETE canonical profile (RD-AUTH-OTP-02) with
      // verification applied. organizationName unknown here → empty (editable in Settings).
      const email = decoded.email ?? (otp.recipient as string | undefined) ?? ''
      const name  = (decoded.name as string | undefined) ?? (email ? email.split('@')[0] : '')
      tx.set(userRef, {
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
    return { kind: 'ok', recipient: (otp.recipient as string | undefined) ?? '' }
  })

  switch (outcome.kind) {
    case 'not_found': return NextResponse.json({ error: 'OTP_NOT_FOUND' }, { status: 404 })
    case 'forbidden': return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
    case 'already':   return NextResponse.json({ error: 'ALREADY_VERIFIED' }, { status: 400 })
    case 'expired':   return NextResponse.json({ error: 'EXPIRED' }, { status: 400 })
    case 'max':       return NextResponse.json({ error: 'MAX_ATTEMPTS_REACHED' }, { status: 400 })
    case 'invalid':   return NextResponse.json({ error: 'INVALID_CODE', attemptsLeft: outcome.attemptsLeft }, { status: 400 })
  }

  // ── outcome.kind === 'ok' — Firebase Auth emailVerified = true ───────────────
  // Done after the transaction so the Firestore state is always consistent even if
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
      const email   = (userDoc.data()?.email as string | undefined) ?? outcome.recipient
      const orgName = (userDoc.data()?.organizationName as string | undefined) ?? ''
      void notificationEngine.send(NotificationType.ACCOUNT_WELCOME, { to: email, name, orgName }).catch(() => {})
    }
  } catch { /* non-fatal */ }

  return NextResponse.json({ verified: true })
}
