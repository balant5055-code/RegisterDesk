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
import { ORGANIZER_ROLE } from '@/lib/organizer/identity'
import { isStaffEmail } from '@/lib/staff/types'
import { getSecurityConfig } from '@/lib/config/resolveSecurityConfig'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'
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
    // checkRevoked: true — consistent with the auth-critical verifiers (verifyCaller,
    // resolveAdminUid) so a revoked session can't complete email verification.
    decoded = await adminAuth.verifyIdToken(bearer, true)
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
    // RD-ORGANIZER-NOTIFY-03 · `activated` is true ONLY on the commit that turned this
    // account into a usable organizer — a pending row promoted to active, or the
    // orphan-heal branch creating an already-verified profile. It is false when an
    // account that was already active (a grandfathered document with no accountStatus,
    // or a moderated one) merely re-verifies. The admin notification reads this flag, so
    // "a new organizer registered" can never be announced twice for one account, and a
    // replay never reaches this branch at all.
    | { kind: 'ok'; recipient: string; activated: boolean }

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
    // Reset per attempt: the callback can be RE-RUN by Firestore on contention, so a
    // flag that survived a retry could report an activation the winning commit did not
    // perform.
    let activated = false
    tx.update(otpRef, { verified: true, verifiedAt: FieldValue.serverTimestamp() })
    if (userSnapT.exists) {
      // RD-ORGANIZER-SIGNUP-02 · pending → active, and ONLY pending → active.
      //
      // The activation rides inside THIS transaction, so it cannot outlive a failed
      // verification or vice versa. It is conditional on the stored value because the
      // lifecycle this phase introduces is exactly one edge: a signup that has not been
      // activated becomes one that has. A `suspended` or `banned` document must survive
      // a verification untouched — otherwise an admin who moderates an account that had
      // never verified its email would find the moderation quietly undone by the next
      // OTP. (Hard to reach: moderation revokes refresh tokens and send-otp refuses an
      // already-verified caller. "Hard to reach" is not "cannot happen", and the safe
      // direction costs one comparison.)
      //
      // RD-PHASE4 signup transition · a document with NO accountStatus is either a
      // grandfathered organizer (predates the field and already verified — left exactly as
      // it is, and never announced again) or a signup from an OLDER app bundle that did not
      // send the field yet (the transitional create rule accepts it). The second is a new,
      // never-verified signup and is activated like a pending row. They are told apart by the
      // stored verification: only a document with NEITHER verified flag set is treated as new.
      const stored = userSnapT.data() as {
        accountStatus?: unknown; emailVerified?: unknown; verification?: { email?: { verified?: unknown } }
      }
      const storedStatus = stored.accountStatus
      const legacyUnverified = storedStatus == null
        && stored.emailVerified !== true
        && stored.verification?.email?.verified !== true
      const promote = storedStatus === 'pending' || legacyUnverified
      activated = promote
      tx.update(userRef, {
        emailVerified: true,           // backward-compat flat field
        ...(promote ? { accountStatus: 'active' } : {}),
        // RD-WORKSPACE-OWNERSHIP-01 · backfill the explicit marker on profiles that
        // predate it, so legacy organizers self-heal one verification at a time instead
        // of needing a bulk migration. A completed email OTP is proof this is a person's
        // organizer account and not a gate credential: those authenticate with a username
        // on the reserved .invalid domain and never verify an email address. The guard is
        // therefore belt-and-braces, and costs one string comparison.
        ...(isStaffEmail(decoded.email) ? {} : { workspaceOwner: true }),
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
        role:             ORGANIZER_ROLE,
        // RD-WORKSPACE-OWNERSHIP-01 · see the sibling branch. This reconstructs an
        // organizer profile from a verified email, which a gate credential cannot have.
        ...(isStaffEmail(email) ? {} : { workspaceOwner: true }),
        // RD-ORGANIZER-SIGNUP-02 · this branch only runs when the profile does not
        // exist, so there is no pending row to promote — the account is created in
        // its activated state, which is what a completed verification means.
        accountStatus:    'active',
        emailVerified:    true,
        verification: { email: { verified: true, verifiedAt: FieldValue.serverTimestamp(), verifiedMethod: 'otp' } },
        trust: { level: 'email_verified', score: EMAIL_VERIFIED_SCORE, badges: FieldValue.arrayUnion('email') },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      activated = true
    }
    return { kind: 'ok', recipient: (otp.recipient as string | undefined) ?? '', activated }
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

  // ── Send welcome email, and tell the platform a new organizer has arrived ───
  //
  // RD-ORGANIZER-NOTIFY-03 · both are fire-and-forget, after the commit, and neither
  // can fail the verification:
  //   • ACCOUNT_WELCOME goes to the organizer — unchanged from before this phase.
  //   • ORGANIZER_REGISTERED goes to the PLATFORM's own support inbox, and ONLY when
  //     this commit actually activated the account (`outcome.activated`). A replay
  //     returned ALREADY_VERIFIED long before this line; a wrong, expired, foreign or
  //     capped code returned from the switch above; and an account that was already
  //     active merely re-verifying leaves the flag false. So one account can produce
  //     at most one "new organizer" notice.
  //
  // The profile is read ONCE and both notifications share it — no extra Firestore read
  // was added for the admin notice.
  try {
    if (notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
      const userDoc = await userRef.get()
      const name    = (userDoc.data()?.name as string | undefined) ?? ''
      const email   = (userDoc.data()?.email as string | undefined) ?? outcome.recipient
      const orgName = (userDoc.data()?.organizationName as string | undefined) ?? ''
      void notificationEngine.send(NotificationType.ACCOUNT_WELCOME, { to: email, name, orgName }).catch(() => {})

      if (outcome.activated) {
        // The recipient is resolved SERVER-SIDE from the branding config — the same
        // inbox the operations alerts use. Nothing the signup typed can redirect it.
        void getBrandingConfig()
          .then(branding => {
            const to = branding.supportEmail
            if (!to) return
            return notificationEngine.send(NotificationType.ORGANIZER_REGISTERED, {
              to,
              organizerName:    name,
              organizationName: orgName,
              organizerEmail:   email,
              uid,
              registeredAt:     new Date().toISOString(),
            })
          })
          // Logged, never thrown: an admin notice that does not arrive must not turn a
          // completed registration into a failed one, and an unhandled rejection here
          // would take the process down rather than the email.
          .catch((err: unknown) => console.error('[verify-otp] ORGANIZER_REGISTERED failed:', { uid, err }))
      }
    }
  } catch { /* non-fatal */ }

  return NextResponse.json({ verified: true })
}
