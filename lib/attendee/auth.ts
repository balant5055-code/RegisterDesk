// Attendee session management — server-only (Admin SDK + httpOnly cookie).
//
// Attendees have no Firebase Auth account; they authenticate by Email OTP and
// hold an opaque, HMAC-signed session cookie. The session record lives in
// attendeeSessions/{sessionId} (sessionId = 256-bit random, unguessable) and
// carries its own expiry, so sessions can be expired/revoked server-side.

import { randomBytes, createHmac, timingSafeEqual } from 'crypto'
import { cookies }            from 'next/headers'
import { FieldValue }         from 'firebase-admin/firestore'
import { adminDb }            from '@/lib/firebase/admin'
import { ATTENDEE_SESSION_SECRET } from '@/lib/env'

export const ATTENDEE_COOKIE   = 'attendee_session'
export const SESSION_TTL_MS    = 30 * 24 * 60 * 60 * 1_000   // 30 days
const SESSION_TTL_S            = SESSION_TTL_MS / 1_000
const HEX_64                   = /^[0-9a-f]{64}$/

const sessionsCol = () => adminDb.collection('attendeeSessions')

// ─── Token signing (tamper-evident cookie) ──────────────────────────────────

function sign(sessionId: string): string {
  const sig = createHmac('sha256', ATTENDEE_SESSION_SECRET).update(sessionId).digest('hex')
  return `${sessionId}.${sig}`
}

/** Verify the HMAC and return the sessionId, or null when malformed/forged. */
function unsign(token: string): string | null {
  const dot = token.lastIndexOf('.')
  if (dot < 0) return null
  const sessionId = token.slice(0, dot)
  const sig       = token.slice(dot + 1)
  if (!HEX_64.test(sessionId) || !HEX_64.test(sig)) return null
  const expected = createHmac('sha256', ATTENDEE_SESSION_SECRET).update(sessionId).digest()
  const actual   = Buffer.from(sig, 'hex')
  if (expected.length !== actual.length) return null
  return timingSafeEqual(expected, actual) ? sessionId : null
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface AttendeeSession {
  sessionId:       string
  email:           string   // display email as stored at login
  normalizedEmail: string
}

// ─── Create / verify / require / destroy ─────────────────────────────────────

export interface CreateSessionInput {
  email:           string
  normalizedEmail: string
  ip:              string
  userAgent:       string
}

/** Creates a session record and sets the signed httpOnly cookie. */
export async function createAttendeeSession(input: CreateSessionInput): Promise<AttendeeSession> {
  const sessionId = randomBytes(32).toString('hex')   // 256-bit, unguessable
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await sessionsCol().doc(sessionId).set({
    attendeeEmail:           input.email,
    attendeeEmailNormalized: input.normalizedEmail,
    createdAt:               FieldValue.serverTimestamp(),
    updatedAt:               FieldValue.serverTimestamp(),
    lastLoginAt:             FieldValue.serverTimestamp(),
    ip:                      input.ip,
    userAgent:               input.userAgent,
    expiresAt,
  })

  const jar = await cookies()
  jar.set(ATTENDEE_COOKIE, sign(sessionId), {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   SESSION_TTL_S,
  })

  return { sessionId, email: input.email, normalizedEmail: input.normalizedEmail }
}

/** Returns the current attendee session, or null when absent/invalid/expired. */
export async function verifyAttendeeSession(): Promise<AttendeeSession | null> {
  const jar = await cookies()
  const raw = jar.get(ATTENDEE_COOKIE)?.value
  if (!raw) return null

  const sessionId = unsign(raw)
  if (!sessionId) return null

  const snap = await sessionsCol().doc(sessionId).get()
  if (!snap.exists) return null
  const d = snap.data() as {
    attendeeEmail?: string
    attendeeEmailNormalized?: string
    expiresAt?: { toMillis?: () => number } | Date
  }

  const expiresMs =
    (d.expiresAt as { toMillis?: () => number })?.toMillis?.() ??
    (d.expiresAt as Date)?.getTime?.() ?? 0
  if (Date.now() > expiresMs) return null

  return {
    sessionId,
    email:           d.attendeeEmail ?? '',
    normalizedEmail: d.attendeeEmailNormalized ?? '',
  }
}

/** Like verifyAttendeeSession but intended for guard call sites (returns null → caller 401s). */
export async function requireAttendee(): Promise<AttendeeSession | null> {
  return verifyAttendeeSession()
}

/** Invalidates the session record and clears the cookie. */
export async function destroyAttendeeSession(): Promise<void> {
  const jar = await cookies()
  const raw = jar.get(ATTENDEE_COOKIE)?.value
  if (raw) {
    const sessionId = unsign(raw)
    if (sessionId) {
      await sessionsCol().doc(sessionId).delete().catch(() => { /* best-effort */ })
    }
  }
  jar.set(ATTENDEE_COOKIE, '', {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   0,
  })
}
