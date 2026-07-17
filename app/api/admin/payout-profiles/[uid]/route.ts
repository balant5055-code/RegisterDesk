// PATCH /api/admin/payout-profiles/[uid]
//
// Verify or reject an organizer's payout profile.
//
// Body: { action: 'verify' } | { action: 'reject'; rejectionNote: string }
//
// verify  — sets isVerified=true, verifiedAt=now, verifiedBy=adminUid, clears rejectionNote
// reject  — sets isVerified=false, rejectionNote=note, clears verifiedAt and verifiedBy

import { NextRequest, NextResponse }      from 'next/server'
import { FieldValue }                     from 'firebase-admin/firestore'
import { adminDb }                        from '@/lib/firebase/admin'
import { resolveAdminUid }                from '@/lib/admin/auth'
import { logAdminAction }                 from '@/lib/admin/audit'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import type { OrganizerPayoutProfileDoc } from '@/lib/payout/types'
import type { AdminPayoutProfilePatchResponse } from '@/lib/payout/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface RouteContext {
  params: Promise<{ uid: string }>
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

interface PatchBody {
  action?:        unknown
  rejectionNote?: unknown
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { uid } = await ctx.params

  let body: PatchBody
  try { body = await req.json() as PatchBody }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const action = typeof body.action === 'string' ? body.action : ''
  if (action !== 'verify' && action !== 'reject') {
    return NextResponse.json({ error: "action must be 'verify' or 'reject'" }, { status: 400 })
  }

  // Validate rejection note when rejecting
  const rejectionNote = typeof body.rejectionNote === 'string' ? body.rejectionNote.trim() : ''
  if (action === 'reject' && !rejectionNote) {
    return NextResponse.json({ error: 'rejectionNote is required when rejecting' }, { status: 400 })
  }

  const docRef = adminDb.doc(`organizerPayoutProfiles/${uid}`)
  const snap   = await docRef.get()
  if (!snap.exists) {
    return NextResponse.json({ error: 'Payout profile not found' }, { status: 404 })
  }

  const profile = snap.data() as OrganizerPayoutProfileDoc

  // ── Write ──────────────────────────────────────────────────────────────────

  if (action === 'verify') {
    await docRef.update({
      isVerified:    true,
      verifiedAt:    FieldValue.serverTimestamp(),
      verifiedBy:    adminUid,
      rejectionNote: null,
      updatedAt:     FieldValue.serverTimestamp(),
    })
  } else {
    await docRef.update({
      isVerified:    false,
      verifiedAt:    null,
      verifiedBy:    null,
      rejectionNote,
      updatedAt:     FieldValue.serverTimestamp(),
    })
  }

  // ── Fire-and-forget: audit log ─────────────────────────────────────────────

  void logAdminAction({
    adminUid,
    action:     action === 'verify' ? 'payout_profile.verified' : 'payout_profile.rejected',
    entityType: 'payout_profile',
    entityId:   uid,
    metadata:   action === 'reject' ? { rejectionNote } : undefined,
  }).catch((err: unknown) => console.error('[audit] payout_profile log failed:', err))

  // ── Fire-and-forget: email notification ───────────────────────────────────

  void (async () => {
    try {
      if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return

      // Fetch organizer contact info from users/{uid}
      const userSnap = await adminDb.doc(`users/${uid}`).get()
      if (!userSnap.exists) return
      const userData = userSnap.data() as { name?: string; email?: string }
      const organizerName  = userData.name  ?? uid
      const organizerEmail = userData.email ?? ''
      if (!organizerEmail) return

      if (action === 'verify') {
        await notificationEngine.send(NotificationType.PAYOUT_PROFILE_VERIFIED, {
          to:               organizerEmail,
          organizerName,
          accountHolderName: profile.accountHolderName,
          payoutMethod:      profile.payoutMethod,
        })
      } else {
        await notificationEngine.send(NotificationType.PAYOUT_PROFILE_REJECTED, {
          to:               organizerEmail,
          organizerName,
          accountHolderName: profile.accountHolderName,
          rejectionNote:    rejectionNote || undefined,
        })
      }
    } catch (err) {
      console.error('[email] payout_profile notification failed:', err)
    }
  })()

  return NextResponse.json({
    uid,
    isVerified: action === 'verify',
  } satisfies AdminPayoutProfilePatchResponse)
}
