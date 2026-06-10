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
import { getEmailProvider }   from '@/lib/email'
import {
  generateCode, generateSalt, hashCode,
  OTP_TTL_MS, OTP_RESEND_WAIT,
} from '@/lib/otp'
import type { DecodedIdToken } from 'firebase-admin/auth'

const MAX_SENDS_PER_HOUR = 5
const HOUR_MS            = 60 * 60 * 1_000

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

  // ── Rate limit ──────────────────────────────────────────────────────────────
  const limitRef  = adminDb.collection('otpRateLimits').doc(`${uid}_${channel}`)
  const limitSnap = await limitRef.get()

  if (limitSnap.exists) {
    const d           = limitSnap.data()!
    const windowStart = (d.windowStart as { toMillis?(): number })?.toMillis?.() ?? 0
    const lastSentAt  = (d.lastSentAt  as { toMillis?(): number })?.toMillis?.() ?? 0

    // Per-request cooldown
    if (now - lastSentAt < OTP_RESEND_WAIT) {
      const secondsLeft = Math.ceil((OTP_RESEND_WAIT - (now - lastSentAt)) / 1_000)
      return NextResponse.json({ error: 'COOLDOWN_ACTIVE', secondsLeft }, { status: 429 })
    }

    // Hourly cap
    const inWindow = now - windowStart < HOUR_MS
    if (inWindow && (d.count ?? 0) >= MAX_SENDS_PER_HOUR) {
      const resetInMin = Math.ceil((HOUR_MS - (now - windowStart)) / 60_000)
      return NextResponse.json({ error: 'RATE_LIMITED', resetInMinutes: resetInMin }, { status: 429 })
    }
  }

  // ── Generate OTP ────────────────────────────────────────────────────────────
  const code    = generateCode()
  const salt    = generateSalt()
  const hash    = hashCode(code, salt)
  const otpRef  = adminDb.collection('otpRequests').doc()   // auto-id
  const otpId   = otpRef.id
  const expiresAt = new Date(now + OTP_TTL_MS)
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

  // ── Send email (fire-and-forget — OTP doc is written first) ─────────────────
  const emailProvider = getEmailProvider()
  if (emailProvider) {
    // Get name from Firestore for personalisation
    let displayName = recipient.split('@')[0]
    try {
      const userDoc = await adminDb.collection('users').doc(uid).get()
      if (userDoc.exists) displayName = (userDoc.data()?.name as string | undefined) ?? displayName
    } catch { /* non-fatal */ }

    emailProvider.sendOtpEmail({
      to:   recipient,
      name: displayName,
      code,
    }).catch(() => { /* email failure never blocks OTP creation */ })
  }

  return NextResponse.json({
    otpId,
    expiresAt:   expiresAt.toISOString(),
    resendAfter: new Date(now + OTP_RESEND_WAIT).toISOString(),
  })
}
