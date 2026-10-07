// PATCH /api/admin/payout-profiles/[uid]
//
// Verify or reject an organizer's payout profile.
//
// Body: { action: 'verify'; reason: string; expectedUpdatedAt: string }
//     | { action: 'reject'; rejectionNote: string; expectedUpdatedAt?: string }
//
// verify  — sets isVerified=true, verifiedAt=now, verifiedBy=adminUid, verifiedVersion, clears rejectionNote
// reject  — sets isVerified=false, rejectionNote=note, clears verifiedAt, verifiedBy and verifiedVersion
//
// RD-PHASE4-S4 (D1, D3, D5) — Super Admin only; a 3–500 character reason; verify/reject run in a
// TRANSACTION that re-reads the profile and refuses a STALE review (the details changed since the
// admin loaded them → 409 STALE_PAYOUT_PROFILE), and stages BOTH the payoutProfileHistory entry
// and the adminAuditLogs row in that same transaction. `verifiedVersion` binds settlements to the
// exact destination reviewed (lib/payout/binding.ts). No payout identifier is logged or returned.

import { NextRequest, NextResponse }      from 'next/server'
import { FieldValue }                     from 'firebase-admin/firestore'
import { adminDb }                        from '@/lib/firebase/admin'
import { stageAdminAudit }                from '@/lib/admin/audit'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { profileUpdatedAtMillis }         from '@/lib/payout/binding'
import { buildAdminReviewHistoryRecord, snapshotFromDoc } from '@/lib/payout/historyRecord'
import { stageHistoryRecord }             from '@/lib/payout/history'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import type { OrganizerPayoutProfileDoc } from '@/lib/payout/types'
import {
  readVendorPreparationStatus, canAdminTransition, hasReviewablePayoutProfile,
  type VendorPreparationStatus,
} from '@/lib/payout/vendorStatus'
import type { AdminPayoutProfilePatchResponse } from '@/lib/payout/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface RouteContext {
  params: Promise<{ uid: string }>
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

interface PatchBody {
  action?:        unknown
  rejectionNote?: unknown
  reviewNote?:    unknown
  reason?:        unknown
  expectedUpdatedAt?: unknown
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const adminUid = guard.uid

  const { uid } = await ctx.params

  let body: PatchBody
  try { body = await req.json() as PatchBody }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const action = typeof body.action === 'string' ? body.action : ''
  const VENDOR_ACTIONS: Record<string, VendorPreparationStatus> = {
    vendor_mark_reviewed:   'locally_reviewed',
    vendor_request_changes: 'changes_requested',
  }
  const isVendorAction = action in VENDOR_ACTIONS
  if (action !== 'verify' && action !== 'reject' && !isVendorAction) {
    return NextResponse.json(
      { error: "action must be 'verify', 'reject', 'vendor_mark_reviewed' or 'vendor_request_changes'" },
      { status: 400 },
    )
  }

  // Validate rejection note when rejecting
  const rejectionNote = typeof body.rejectionNote === 'string' ? body.rejectionNote.trim() : ''
  const reviewNote    = typeof body.reviewNote    === 'string' ? body.reviewNote.trim()    : ''
  if (action === 'reject' && !rejectionNote) {
    return NextResponse.json({ error: 'rejectionNote is required when rejecting' }, { status: 400 })
  }

  // RD-PHASE4-S4 · D3 — the reason (a rejection's reason IS its note) and D5 — the version reviewed.
  let reason = ''
  let expectedMs: number | null = null
  if (action === 'verify' || action === 'reject') {
    const r = action === 'reject' ? parseFinancialReason(body.rejectionNote, body.reason) : parseFinancialReason(body.reason)
    if (!r.ok) return reasonErrorResponse(r)
    reason = r.reason
    const rawExpected = typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt.trim() : ''
    if (rawExpected) {
      const ms = Date.parse(rawExpected)
      if (!Number.isFinite(ms)) return NextResponse.json({ error: 'expectedUpdatedAt must be an ISO timestamp.', code: 'INVALID_EXPECTED_VERSION' }, { status: 400 })
      expectedMs = ms
    } else if (action === 'verify') {
      // A verification must name the version of the details the admin actually reviewed.
      return NextResponse.json({ error: 'Reload the payout profile and verify again (the reviewed version is missing).', code: 'EXPECTED_VERSION_REQUIRED' }, { status: 400 })
    }
  }

  const docRef = adminDb.doc(`organizerPayoutProfiles/${uid}`)
  const snap   = await docRef.get()
  if (!snap.exists) {
    return NextResponse.json({ error: 'Payout profile not found' }, { status: 404 })
  }

  const profile = snap.data() as OrganizerPayoutProfileDoc

  // ═══ CASHFREE VENDOR PREPARATION · A LOCAL REVIEW, AND ONLY THAT ══════════
  //
  // This records that a RegisterDesk admin has looked at the payout details and considers
  // the organizer ready to be put forward to Cashfree. It is OUR opinion, stored in OUR
  // status field.
  //
  // It deliberately does NOT touch `cashfreeVendorId`, `vendorKycStatus`, `vendorCreatedAt`
  // or `vendorLastSyncedAt`. No vendor is created, no KYC is approved, and Cashfree is not
  // contacted — none of which a local review is evidence of. Those fields belong to a
  // future onboarding integration that has actually spoken to Cashfree.
  if (isVendorAction) {
    const next    = VENDOR_ACTIONS[action]
    const current = readVendorPreparationStatus(profile.vendorStatus)

    // A review needs something to review. Without payout details there is nothing an admin
    // could have checked, so the transition is refused rather than recorded as a review.
    if (!hasReviewablePayoutProfile(profile)) {
      return NextResponse.json(
        { error: 'This organizer has not supplied the payout details required for review.' },
        { status: 409 },
      )
    }
    if (!canAdminTransition(current, next)) {
      return NextResponse.json(
        { error: `Cannot move vendor preparation from '${current}' to '${next}'.` },
        { status: 409 },
      )
    }
    // A reason is required in both directions — an approval with no rationale is as
    // unauditable as a rejection with none.
    if (!reviewNote) {
      return NextResponse.json({ error: 'reviewNote is required' }, { status: 400 })
    }

    // Audited through the SAME mechanism as verify/reject, carrying the previous and new
    // status plus the reason. RD-PHASE4-S4 — the row commits in the same batch as the change.
    const batch = adminDb.batch()
    batch.update(docRef, {
      vendorStatus:     next,
      vendorReviewedBy: adminUid,
      vendorReviewedAt: FieldValue.serverTimestamp(),
      vendorReviewNote: reviewNote,
      updatedAt:        FieldValue.serverTimestamp(),
    })
    stageAdminAudit(batch, {
      adminUid,
      actorRole:  'super_admin',
      action:     next === 'locally_reviewed' ? 'payout_profile.vendor_reviewed' : 'payout_profile.vendor_changes_requested',
      entityType: 'payout_profile',
      entityId:   uid,
      reason:     reviewNote,
      before:     { vendorStatus: current },
      after:      { vendorStatus: next },
      metadata:   { previousStatus: current, newStatus: next, reviewNote },
    })
    await batch.commit()

    return NextResponse.json({ success: true, vendorStatus: next })
  }

  // ── Write: ONE transaction — stale check, profile change, history entry, audit row ─────────

  try {
    await adminDb.runTransaction(async tx => {
      const fresh = await tx.get(docRef)
      if (!fresh.exists) throw new Error('NOT_FOUND')
      const p = fresh.data() as OrganizerPayoutProfileDoc
      const version = profileUpdatedAtMillis(p)
      if (expectedMs !== null && version !== expectedMs) throw new Error('STALE')
      const wasVerified = p.isVerified === true

      if (action === 'verify') {
        tx.update(docRef, {
          isVerified:      true,
          verifiedAt:      FieldValue.serverTimestamp(),
          verifiedBy:      adminUid,
          // The binding version: the updatedAt of the details reviewed (never the new stamp).
          verifiedVersion: version,
          rejectionNote:   null,
          updatedAt:       FieldValue.serverTimestamp(),
        })
      } else {
        tx.update(docRef, {
          isVerified:      false,
          verifiedAt:      null,
          verifiedBy:      null,
          verifiedVersion: null,
          rejectionNote,
          updatedAt:       FieldValue.serverTimestamp(),
        })
      }

      const history = buildAdminReviewHistoryRecord({
        organizerUid: uid,
        actorUid:     adminUid,
        snapshot:     snapshotFromDoc(p),
        action:       action === 'verify' ? 'admin_verified' : 'admin_rejected',
        wasVerified,
        reason,
      })
      stageHistoryRecord(tx, history)
      stageAdminAudit(tx, {
        adminUid,
        actorRole:     'super_admin',
        action:        action === 'verify' ? 'payout_profile.verified' : 'payout_profile.rejected',
        entityType:    'payout_profile',
        entityId:      uid,
        reason,
        changedFields: ['isVerified', 'verifiedAt', 'verifiedBy', 'verifiedVersion', 'rejectionNote'],
        before:        { isVerified: wasVerified, verifiedVersion: p.verifiedVersion ?? null },
        after:         { isVerified: action === 'verify', verifiedVersion: action === 'verify' ? version : null },
        // Masked only — the destination label the history already stores.
        metadata:      { destination: history.next.label, reviewedVersion: version },
        correlation:   { organizerUid: uid },
      })
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'UNKNOWN'
    if (msg === 'NOT_FOUND') return NextResponse.json({ error: 'Payout profile not found' }, { status: 404 })
    if (msg === 'STALE') {
      return NextResponse.json({
        error: 'The organizer changed these payout details after you loaded them. Reload and review the current details.',
        code:  'STALE_PAYOUT_PROFILE',
      }, { status: 409 })
    }
    console.error('[payout_profile] review failed:', msg)
    return NextResponse.json({ error: 'The review could not be saved. Nothing was changed.' }, { status: 500 })
  }

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
