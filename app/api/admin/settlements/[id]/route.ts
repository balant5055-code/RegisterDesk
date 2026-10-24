// PATCH /api/admin/settlements/[id]
// Body: { action: 'approve' | 'reject' | 'paid', reason?: string, adminNote?: string, … }
//
// State machine:
//   pending  → approve → approved
//   pending  → reject  → rejected
//   approved → paid    → paid       (atomic wallet debit)
//   approved → reject  → rejected
//
// RD-PHASE4-S4 — financial controls:
//   • D1 Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim alone → 403 SUPER_ADMIN_REQUIRED.
//   • D3 every action needs a 3–500 character reason (`reason`, falling back to `adminNote`).
//   • D2 maker-checker: the Super Admin who APPROVED cannot mark the same settlement PAID
//     (409 MAKER_CHECKER_REQUIRED) — enforced inside the paid transaction, never bypassed.
//   • D5 approve and paid re-check the payout destination INSIDE the transaction against the
//     destination snapshotted when the organizer requested (409 DESTINATION_CHANGED).
//   • D6/F1 the audit row is staged in the SAME transaction as the change (stageAdminAudit):
//     the change and its audit commit together or not at all.
//
// M1 (payout/refund integrity) — a request a refund left unbacked is held for review (payoutReview.status
// 'open', reservation released; lib/settlements/payoutReview.ts). While it is open: approve and paid refuse
// (409 UNDER_REVIEW). A Super Admin resolves it with:
//   resume_review   → re-reserve it (only if the free balance covers it now); status unchanged
//   reject          → as before; an APPROVED request under review also needs confirmNoTransfer: true
//   record_transfer → the bank transfer HAD already completed (approved + under review; UTR, maker-checker and
//                     destination binding as for paid): recorded paid; available covers what it can and the
//                     rest becomes a 'payout_shortfall' clawback; other reservations that no longer fit go to
//                     review in the same transaction. Nothing here makes or retries a bank transfer.
//
// M1.2 (owner-approved):
//   A · reject of ANY approved request (under review or not) needs confirmNoTransfer: true (strict boolean) — an
//       approved request may already have been transferred; refused while a transfer exception is pending.
//   B · the changed-destination exception (lib/settlements/confirmedTransfer.ts) records a transfer that ALREADY
//       completed to the request's ORIGINAL destination after the organizer's payout details changed:
//         transfer_exception_initiate → Super Admin, UTR, reason, evidence (original destination + completed
//                                       transfer); only when the standard binding refuses; UTR unused elsewhere
//         transfer_exception_approve  → a DIFFERENT Super Admin (also not the request's approver), restating the
//                                       amount, UTR and evidence fingerprint; records it paid ONCE (UTR reserved)
//         transfer_exception_decline  → kept as evidence; the request is unchanged
//       It never sends, retries or authorizes a transfer, and the ordinary paid / record_transfer guards are unchanged.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import type { OrganizerRevenueWallet } from '@/lib/fees/types'
import type {
  SettlementRequestDoc,
  SettlementStatus,
} from '@/lib/settlements/types'
import {
  sendSettlementApprovedEmail,
  sendSettlementRejectedEmail,
  sendSettlementPaidEmail,
} from '@/lib/settlements/sendSettlementEmail'
import { NotificationType } from '@/lib/notifications'
import { sendOrganizerWhatsApp } from '@/lib/notifications/organizerWhatsApp'
import { notifySettlement } from '@/lib/notifications/inbox/notify'
import { stageAdminAudit } from '@/lib/admin/audit'
import {
  requireSuperAdmin, parseFinancialReason, reasonErrorResponse, configuredSuperAdminCount,
} from '@/lib/admin/financialGuard'
import { enqueueWebhook } from '@/lib/integrations/webhooks'
import { PAYOUT_PROFILE_UNVERIFIED_MESSAGE } from '@/lib/payout/verification'
import { checkSettlementBinding, DESTINATION_CHANGED_MESSAGE } from '@/lib/payout/binding'
import { readOpenPayoutRequests } from '@/lib/settlements/payoutReview'
import { logClawbackEvent } from '@/lib/clawbacks/clawbackService'
import {
  stageConfirmedTransferPaid, normalizeUtr, canonicalUtr, validateTransferEvidence, transferExceptionFingerprint,
  readTransferReferenceConflict, TRANSFER_REFERENCES_COLLECTION,
} from '@/lib/settlements/confirmedTransfer'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import type { OrganizerPayoutProfileDoc } from '@/lib/payout/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tsToISO(ts: unknown): string {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return new Date().toISOString()
}

async function fetchOrganizerProfile(
  uid: string,
): Promise<{ name: string; email: string } | null> {
  try {
    const snap = await adminDb.doc(`users/${uid}`).get()
    if (!snap.exists) return null
    const d = snap.data() as Record<string, unknown>
    const email = typeof d.email === 'string' ? d.email.trim() : ''
    if (!email) return null
    return {
      name:  typeof d.name === 'string' ? d.name : '',
      email,
    }
  } catch {
    return null
  }
}

const UNDER_REVIEW_MESSAGE =
  'This payout request is on hold for review: a refund reduced the balance backing it. Resolve the review first (resume it if the balance now covers it, reject it, or record a bank transfer that already completed).'
const underReviewResponse = () => NextResponse.json({ error: UNDER_REVIEW_MESSAGE, code: 'UNDER_REVIEW' }, { status: 409 })
const EXCEPTION_PENDING_MESSAGE =
  'A changed-destination transfer exception is pending approval for this payout: a transfer is claimed to have completed. Approve or decline the exception first.'
const exceptionPendingResponse = () => NextResponse.json({ error: EXCEPTION_PENDING_MESSAGE, code: 'EXCEPTION_PENDING' }, { status: 409 })
// M1.3 — one UTR, one payout (lib/settlements/confirmedTransfer.ts). Refused before any write.
const utrInUseResponse = () => NextResponse.json({ error: 'This transfer reference (UTR) is already recorded against another payout. Nothing was recorded — investigate before retrying.', code: 'UTR_IN_USE' }, { status: 409 })
const utrInvalidResponse = () => NextResponse.json({ error: 'The UTR must contain letters and digits only (spaces and hyphens are ignored), up to 64 characters.', code: 'UTR_INVALID' }, { status: 422 })
/** M1.3 — maker-checker for the exception has NO bypass: explain what to do when no eligible approver exists. */
function exceptionMakerCheckerMessage(): string {
  const base = 'A different Super Admin — not the one who requested the exception, and not the one who approved the payout — must approve it.'
  return configuredSuperAdminCount() < 3
    ? `${base} Only ${configuredSuperAdminCount()} Super Admin(s) are configured, so no eligible approver may exist: the exception stays PENDING (nothing was recorded). Follow the manual fallback (Operations Runbook B.12) until an independent Super Admin can approve it. This control cannot be bypassed.`
    : base
}

/** D2 — actionable, and explicit that the control is never bypassed. */
function makerCheckerMessage(): string {
  return configuredSuperAdminCount() < 2
    ? 'You approved this settlement, so a different Super Admin must mark it paid. Only one Super Admin is configured: add a second Super Admin to ADMIN_UIDS before this payout can be recorded. This control cannot be bypassed.'
    : 'You approved this settlement, so a different Super Admin must mark it paid. Ask another Super Admin to record the payout.'
}

export interface AdminSettlementPatchResponse {
  id:     string
  status: SettlementStatus
}

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const adminUid = guard.uid

  const { id } = await params

  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const action        = body.action
  const adminNote     = typeof body.adminNote     === 'string' ? body.adminNote.trim()     : ''
  const utrNumber     = typeof body.utrNumber     === 'string' ? body.utrNumber.trim()     : ''
  const bankReference = typeof body.bankReference === 'string' ? body.bankReference.trim() : ''
  const paidBy        = typeof body.paidBy        === 'string' ? body.paidBy.trim()        : ''
  const paymentNotes  = typeof body.paymentNotes  === 'string' ? body.paymentNotes.trim()  : ''

  const ACTIONS = ['approve', 'reject', 'paid', 'resume_review', 'record_transfer', 'transfer_exception_initiate', 'transfer_exception_approve', 'transfer_exception_decline'] as const
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: `action must be: ${ACTIONS.join(' | ')}` },
      { status: 422 },
    )
  }

  // D3 — a reason for every settlement decision.
  const reasonResult = parseFinancialReason(body.reason, body.adminNote)
  if (!reasonResult.ok) return reasonErrorResponse(reasonResult)
  const reason = reasonResult.reason

  const settlementRef = adminDb.doc(`settlementRequests/${id}`)

  // ── approve ───────────────────────────────────────────────────────────────────

  if (action === 'approve') {
    // Flip pending → approved inside a transaction that RE-READS status, so a
    // concurrent reject (which atomically releases the payout hold) is never
    // silently clobbered back to 'approved' (M-1). Mirrors the reject/paid txns.
    // RD-PHASE4-S4: the payout destination is checked in the SAME transaction (D5), the
    // approver is recorded for maker-checker (D2) and the audit row is staged (D6).
    let d: SettlementRequestDoc
    try {
      d = await adminDb.runTransaction(async tx => {
        const fresh = await tx.get(settlementRef)
        if (!fresh.exists) throw new Error('NOT_FOUND')
        const s = fresh.data() as SettlementRequestDoc
        if (s.status !== 'pending') throw new Error(`WRONG_STATE:${s.status}`)
        if (s.payoutReview?.status === 'open') throw new Error('UNDER_REVIEW')   // M1
        // P9.1: never approve a payout without a verified payout profile.
        const profileSnap = await tx.get(adminDb.doc(`organizerPayoutProfiles/${s.organizerUid}`))
        const binding = checkSettlementBinding(
          s.payoutDestination,
          profileSnap.exists ? profileSnap.data() as OrganizerPayoutProfileDoc : null,
        )
        if (!binding.ok) throw new Error(binding.code)
        tx.update(settlementRef, {
          status:     'approved',
          approvedAt: FieldValue.serverTimestamp(),
          approvedBy: adminUid,
          updatedAt:  FieldValue.serverTimestamp(),
          ...(adminNote ? { adminNote } : {}),
        })
        stageAdminAudit(tx, {
          adminUid,
          actorRole:     'super_admin',
          action:        'settlement.approved',
          entityType:    'settlement',
          entityId:      id,
          reason,
          changedFields: ['status', 'approvedAt', 'approvedBy'],
          before:        { status: 'pending' },
          after:         { status: 'approved', approvedBy: adminUid },
          metadata:      {
            organizerUid:       s.organizerUid,
            amountPaise:        s.amountPaise,
            adminNote:          adminNote || null,
            destinationBinding: binding.mode,
            destination:        s.payoutDestination?.label ?? null,
          },
          correlation:   { settlementId: id, organizerUid: s.organizerUid },
        })
        return s
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'UNKNOWN'
      if (msg === 'NOT_FOUND') return NextResponse.json({ error: 'Settlement not found' }, { status: 404 })
      if (msg.startsWith('WRONG_STATE:')) {
        return NextResponse.json({ error: `Cannot approve a '${msg.split(':')[1]}' settlement.` }, { status: 409 })
      }
      if (msg === 'UNVERIFIED_PROFILE') return NextResponse.json({ error: PAYOUT_PROFILE_UNVERIFIED_MESSAGE }, { status: 422 })
      if (msg === 'DESTINATION_CHANGED') {
        return NextResponse.json({ error: DESTINATION_CHANGED_MESSAGE, code: 'DESTINATION_CHANGED' }, { status: 409 })
      }
      if (msg === 'UNDER_REVIEW') return underReviewResponse()
      console.error('[settlement] approve failed:', { id, msg })
      return NextResponse.json({ error: 'The approval could not be saved. Nothing was changed.' }, { status: 500 })
    }

    void (async () => {
      try {
        const profile = await fetchOrganizerProfile(d.organizerUid)
        if (profile) {
          await sendSettlementApprovedEmail({
            to:            profile.email,
            organizerName: profile.name,
            amountPaise:   d.amountPaise,
            requestedAt:   tsToISO(d.requestedAt),
          })
          // Settlement Ready — organizer WhatsApp (FREE, Phase G3.5).
          void sendOrganizerWhatsApp({
            type:         NotificationType.SETTLEMENT_APPROVED,
            organizerUid: d.organizerUid,
            variables:    { organizerName: profile.name, amount: `₹${(d.amountPaise / 100).toLocaleString('en-IN')}` },
          })
        }
      } catch (err) {
        console.error('[settlement] Failed to send approved email:', { id, err })
      }
    })()

    // H.4.3: organizer Notification Center inbox (best-effort).
    void notifySettlement({ workspaceUid: d.organizerUid, settlementId: id, kind: 'approved', amountPaise: d.amountPaise })

    return NextResponse.json({ id, status: 'approved' } satisfies AdminSettlementPatchResponse)
  }

  // ── reject ────────────────────────────────────────────────────────────────────

  if (action === 'reject') {
    // Transactional so the reservation hold (inTransitPaise) is released
    // atomically with the status flip. Gated on `reserved` so legacy pre-fix
    // requests (no hold) don't decrement inTransitPaise.
    let captured: { organizerUid: string; amountPaise: number; adminNote: string }
    try {
      captured = await adminDb.runTransaction(async tx => {
        const snap = await tx.get(settlementRef)
        if (!snap.exists) throw new Error('NOT_FOUND')
        const d = snap.data() as SettlementRequestDoc
        if (d.status !== 'pending' && d.status !== 'approved') {
          throw new Error(`WRONG_STATE:${d.status}`)
        }
        // M1.2 (policy A) — ANY approved request may already have been transferred (approve → transfer → mark
        // paid): rejecting it needs the Super Admin's explicit confirmation that NO bank transfer was made. Not
        // being marked paid proves nothing. A pending transfer exception claims a transfer: never rejected.
        const reviewOpen = d.payoutReview?.status === 'open'
        if (d.transferException?.status === 'pending_approval') throw new Error('EXCEPTION_PENDING')
        if (d.status === 'approved' && body.confirmNoTransfer !== true) throw new Error('TRANSFER_CONFIRMATION_REQUIRED')

        const walletRef  = adminDb.doc(`organizerRevenueWallets/${d.organizerUid}`)
        const walletSnap = d.reserved === true ? await tx.get(walletRef) : null

        tx.update(settlementRef, {
          status:     'rejected',
          rejectedBy: adminUid,
          updatedAt:  FieldValue.serverTimestamp(),
          adminNote:  adminNote || d.adminNote,
          ...(reviewOpen ? {
            'payoutReview.status': 'resolved', 'payoutReview.outcome': 'rejected', 'payoutReview.resolvedAt': FieldValue.serverTimestamp(),
            'payoutReview.resolvedBy': adminUid, 'payoutReview.resolutionReason': reason,
          } : {}),
        })

        let releasedHoldPaise = 0
        if (d.reserved === true && walletSnap?.exists) {
          const wallet  = walletSnap.data() as OrganizerRevenueWallet
          const release = Math.min(wallet.inTransitPaise ?? 0, d.amountPaise)
          releasedHoldPaise = release
          tx.update(walletRef, {
            inTransitPaise: (wallet.inTransitPaise ?? 0) - release,
            updatedAt:      FieldValue.serverTimestamp(),
          })
        }

        stageAdminAudit(tx, {
          adminUid,
          actorRole:     'super_admin',
          action:        'settlement.rejected',
          entityType:    'settlement',
          entityId:      id,
          reason,
          changedFields: ['status', 'rejectedBy', 'adminNote'],
          before:        { status: d.status },
          after:         { status: 'rejected' },
          metadata:      {
            organizerUid:      d.organizerUid,
            amountPaise:       d.amountPaise,
            adminNote:         (adminNote || d.adminNote) || null,
            releasedHoldPaise,
            ...(d.status === 'approved' ? { confirmNoTransfer: true } : {}),
            ...(reviewOpen ? { reviewResolution: 'rejected', reviewTrigger: d.payoutReview?.trigger ?? null } : {}),
          },
          correlation:   { settlementId: id, organizerUid: d.organizerUid },
        })

        return { organizerUid: d.organizerUid, amountPaise: d.amountPaise, adminNote: adminNote || d.adminNote }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'UNKNOWN'
      if (msg === 'NOT_FOUND') return NextResponse.json({ error: 'Settlement not found' }, { status: 404 })
      if (msg.startsWith('WRONG_STATE:')) {
        return NextResponse.json({ error: `Cannot reject a '${msg.split(':')[1]}' settlement.` }, { status: 409 })
      }
      if (msg === 'TRANSFER_CONFIRMATION_REQUIRED') {
        return NextResponse.json({
          error: 'This payout is approved, so its bank transfer may already have been made. Confirm that NO transfer was made (confirmNoTransfer: true) to reject it; if it was transferred, record the transfer instead.',
          code: 'TRANSFER_CONFIRMATION_REQUIRED',
        }, { status: 409 })
      }
      if (msg === 'EXCEPTION_PENDING') return exceptionPendingResponse()
      console.error('[settlement] reject failed:', { id, msg })
      return NextResponse.json({ error: 'The rejection could not be saved. Nothing was changed.' }, { status: 500 })
    }

    void (async () => {
      try {
        const profile = await fetchOrganizerProfile(captured.organizerUid)
        if (profile) {
          await sendSettlementRejectedEmail({
            to:            profile.email,
            organizerName: profile.name,
            amountPaise:   captured.amountPaise,
            adminNote:     captured.adminNote || undefined,
          })
        }
      } catch (err) {
        console.error('[settlement] Failed to send rejected email:', { id, err })
      }
    })()

    // H.4.3: organizer Notification Center inbox (best-effort).
    void notifySettlement({ workspaceUid: captured.organizerUid, settlementId: id, kind: 'rejected', amountPaise: captured.amountPaise, reason: captured.adminNote || undefined })

    return NextResponse.json({ id, status: 'rejected' } satisfies AdminSettlementPatchResponse)
  }

  // ── M1 · resume_review: re-reserve a reviewed request, only if the free balance covers it NOW ─────────────────

  if (action === 'resume_review') {
    let captured: { organizerUid: string; amountPaise: number; status: SettlementStatus; reviewRef: string }
    try {
      captured = await adminDb.runTransaction(async tx => {
        const snap = await tx.get(settlementRef)
        if (!snap.exists) throw new Error('NOT_FOUND')
        const d = snap.data() as SettlementRequestDoc
        if (d.status !== 'pending' && d.status !== 'approved') throw new Error(`WRONG_STATE:${d.status}`)
        if (d.payoutReview?.status !== 'open') throw new Error('NOT_UNDER_REVIEW')
        const walletRef  = adminDb.doc(`organizerRevenueWallets/${d.organizerUid}`)
        const walletSnap = await tx.get(walletRef)
        if (!walletSnap.exists) throw new Error('NO_WALLET')
        const w        = walletSnap.data() as OrganizerRevenueWallet
        const inTransit = w.inTransitPaise ?? 0
        const free      = w.availablePaise - inTransit
        if (d.amountPaise > free) throw new Error(`STILL_UNFUNDED:${free}`)
        tx.update(settlementRef, {
          reserved: true,
          'payoutReview.status': 'resolved', 'payoutReview.outcome': 'resumed', 'payoutReview.resolvedAt': FieldValue.serverTimestamp(),
          'payoutReview.resolvedBy': adminUid, 'payoutReview.resolutionReason': reason,
          updatedAt: FieldValue.serverTimestamp(),
        })
        tx.update(walletRef, { inTransitPaise: inTransit + d.amountPaise, updatedAt: FieldValue.serverTimestamp() })
        stageAdminAudit(tx, {
          adminUid, actorRole: 'super_admin', action: 'settlement.review_resumed', entityType: 'settlement', entityId: id, reason,
          changedFields: ['reserved', 'payoutReview'],
          before: { status: d.status, reserved: false, review: 'open' },
          after:  { status: d.status, reserved: true, review: 'resolved' },
          metadata: { organizerUid: d.organizerUid, amountPaise: d.amountPaise, availablePaise: w.availablePaise, inTransitBeforePaise: inTransit, freeBeforePaise: free, reviewTrigger: d.payoutReview?.trigger ?? null },
          correlation: { settlementId: id, organizerUid: d.organizerUid },
        })
        return { organizerUid: d.organizerUid, amountPaise: d.amountPaise, status: d.status, reviewRef: d.payoutReview?.trigger?.ref ?? 'review' }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'UNKNOWN'
      if (msg === 'NOT_FOUND') return NextResponse.json({ error: 'Settlement not found' }, { status: 404 })
      if (msg.startsWith('WRONG_STATE:')) return NextResponse.json({ error: `Cannot resume a '${msg.split(':')[1]}' settlement.` }, { status: 409 })
      if (msg === 'NOT_UNDER_REVIEW') return NextResponse.json({ error: 'This settlement is not under review.', code: 'NOT_UNDER_REVIEW' }, { status: 409 })
      if (msg === 'NO_WALLET') return NextResponse.json({ error: 'Organizer revenue wallet not found.' }, { status: 400 })
      if (msg.startsWith('STILL_UNFUNDED:')) {
        const free = parseInt(msg.split(':')[1] ?? '0', 10)
        return NextResponse.json({ error: `The balance free for payouts (₹${(free / 100).toFixed(2)}) still does not cover this request. It stays under review.`, code: 'STILL_UNFUNDED' }, { status: 409 })
      }
      console.error('[settlement] resume_review failed:', { id, msg })
      return NextResponse.json({ error: 'The review could not be resolved. Nothing was changed.' }, { status: 500 })
    }
    // M1.1 — one notice per resolved review (keyed by the review's trigger): a later review's resume is notified too
    void notifySettlement({ workspaceUid: captured.organizerUid, settlementId: id, kind: 'resumed', amountPaise: captured.amountPaise, eventKey: captured.reviewRef })
    return NextResponse.json({ id, status: captured.status } satisfies AdminSettlementPatchResponse)
  }

  // ── M1 · record_transfer: the bank transfer of a reviewed, APPROVED request had already completed ─────────────
  // Records the truth (paid, with the UTR) — never a second transfer. Available covers what it can; the rest is
  // owed by the organizer as a 'payout_shortfall' clawback (recovered from future releases, like a refund of
  // paid-out money). Reservations of other requests that no longer fit go to review in the same transaction.

  if (action === 'record_transfer') {
    if (!utrNumber) {
      return NextResponse.json({ error: 'utrNumber is required to record a completed transfer.' }, { status: 422 })
    }
    const recordUtr = canonicalUtr(utrNumber)   // M1.3
    if (!recordUtr) return utrInvalidResponse()
    let out: { organizerUid: string; amountPaise: number; shortfallPaise: number; clawbackId: string | null; reviewed: string[] }
    try {
      out = await adminDb.runTransaction(async tx => {
        const snap = await tx.get(settlementRef)
        if (!snap.exists) throw new Error('NOT_FOUND')
        const settlement = snap.data() as SettlementRequestDoc
        if (settlement.status !== 'approved') throw new Error(`WRONG_STATE:${settlement.status}`)
        if (settlement.payoutReview?.status !== 'open') throw new Error('NOT_UNDER_REVIEW')
        if (settlement.transferException?.status === 'pending_approval') throw new Error('EXCEPTION_PENDING')
        if (settlement.approvedBy && settlement.approvedBy === adminUid) throw new Error('MAKER_CHECKER')
        const profileSnap = await tx.get(adminDb.doc(`organizerPayoutProfiles/${settlement.organizerUid}`))
        const binding = checkSettlementBinding(settlement.payoutDestination, profileSnap.exists ? profileSnap.data() as OrganizerPayoutProfileDoc : null)
        if (!binding.ok) throw new Error(binding.code)
        const walletRef  = adminDb.doc(`organizerRevenueWallets/${settlement.organizerUid}`)
        const walletSnap = await tx.get(walletRef)
        if (!walletSnap.exists) throw new Error('NO_WALLET')
        const wallet   = walletSnap.data() as OrganizerRevenueWallet
        const requests = (await readOpenPayoutRequests(tx, settlement.organizerUid)).filter(r => r.id !== id)
        // M1.3 — one UTR, one payout: refused before any write; reserved atomically with the payout
        if (await readTransferReferenceConflict(tx, recordUtr, id, utrNumber)) throw new Error('UTR_IN_USE')
        tx.create(adminDb.collection(TRANSFER_REFERENCES_COLLECTION).doc(recordUtr), {
          utrNumber: recordUtr, settlementId: id, organizerUid: settlement.organizerUid, amountPaise: settlement.amountPaise,
          recordedVia: 'record_transfer', recordedBy: adminUid, createdAt: FieldValue.serverTimestamp(),
        })
        // ── writes (the shared confirmed-transfer accounting; M1.2) ──
        const amount = settlement.amountPaise
        const plan   = stageConfirmedTransferPaid(tx, { settlementId: id, settlement, walletRef, wallet, otherRequests: requests })
        const take = plan.takePaise, shortfall = plan.shortfallPaise, newAvailable = plan.newAvailable
        const claw = plan.clawbackId ? { clawbackId: plan.clawbackId } : null
        tx.update(settlementRef, {
          status: 'paid', paidAt: FieldValue.serverTimestamp(), paidByAdmin: adminUid, updatedAt: FieldValue.serverTimestamp(),
          adminNote: adminNote || settlement.adminNote, utrNumber,
          ...(bankReference ? { bankReference } : {}), ...(paidBy ? { paidBy } : {}), ...(paymentNotes ? { paymentNotes } : {}),
          'payoutReview.status': 'resolved', 'payoutReview.outcome': 'paid_after_transfer', 'payoutReview.resolvedAt': FieldValue.serverTimestamp(),
          'payoutReview.resolvedBy': adminUid, 'payoutReview.resolutionReason': reason,
          'payoutReview.shortfallPaise': shortfall, 'payoutReview.clawbackId': claw?.clawbackId ?? null,
        })
        stageAdminAudit(tx, {
          adminUid, actorRole: 'super_admin', action: 'settlement.paid', entityType: 'settlement', entityId: id, reason,
          changedFields: ['status', 'paidAt', 'paidByAdmin', 'utrNumber', 'payoutReview'],
          before: { status: 'approved', review: 'open', availablePaise: wallet.availablePaise, settledPaise: wallet.settledPaise },
          after:  { status: 'paid', review: 'resolved', availablePaise: newAvailable, settledPaise: wallet.settledPaise + amount },
          metadata: {
            organizerUid: settlement.organizerUid, amountPaise: amount, utrNumber, bankReference: bankReference || null, paidBy: paidBy || null,
            approvedBy: settlement.approvedBy ?? null, makerChecker: settlement.approvedBy ? 'distinct_approver' : 'legacy_no_approver',
            destinationBinding: binding.mode, destination: settlement.payoutDestination?.label ?? null,
            reviewResolution: 'paid_after_transfer', takenFromAvailablePaise: take, shortfallPaise: shortfall, clawbackId: claw?.clawbackId ?? null,
            reviewTrigger: settlement.payoutReview?.trigger ?? null, otherRequestsReviewed: plan.reviewed,
          },
          correlation: { settlementId: id, organizerUid: settlement.organizerUid, utrNumber },
        })
        return { organizerUid: settlement.organizerUid, amountPaise: amount, shortfallPaise: shortfall, clawbackId: claw?.clawbackId ?? null, reviewed: plan.reviewed }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'UNKNOWN'
      if (msg === 'NOT_FOUND') return NextResponse.json({ error: 'Settlement not found' }, { status: 404 })
      if (msg.startsWith('WRONG_STATE:')) return NextResponse.json({ error: `Only an approved settlement under review can be recorded as transferred (current: '${msg.split(':')[1]}').` }, { status: 409 })
      if (msg === 'NOT_UNDER_REVIEW') return NextResponse.json({ error: 'This settlement is not under review: use Mark Paid.', code: 'NOT_UNDER_REVIEW' }, { status: 409 })
      if (msg === 'EXCEPTION_PENDING') return exceptionPendingResponse()
      if (msg === 'UTR_IN_USE' || /ALREADY_EXISTS|already exists/i.test(msg)) return utrInUseResponse()
      if (msg === 'MAKER_CHECKER') return NextResponse.json({ error: makerCheckerMessage(), code: 'MAKER_CHECKER_REQUIRED' }, { status: 409 })
      if (msg === 'UNVERIFIED_PROFILE') return NextResponse.json({ error: PAYOUT_PROFILE_UNVERIFIED_MESSAGE }, { status: 422 })
      if (msg === 'DESTINATION_CHANGED') return NextResponse.json({ error: DESTINATION_CHANGED_MESSAGE, code: 'DESTINATION_CHANGED' }, { status: 409 })
      if (msg === 'NO_WALLET') return NextResponse.json({ error: 'Organizer revenue wallet not found.' }, { status: 400 })
      console.error('[settlement] record_transfer failed:', { id, msg })
      return NextResponse.json({ error: 'The transfer could not be recorded. Nothing was changed.' }, { status: 500 })
    }
    if (out.clawbackId) {
      // awaited; never throws (a failed audit write is recorded for reconciliation)
      await logClawbackEvent(adminUid, 'clawback.created', out.clawbackId, { settlementId: id, outstandingPaise: out.shortfallPaise, reason: 'payout_shortfall' })
      captureFinancialError(new Error(`payout recorded after transfer with a shortfall: ${id}`), {
        scope: 'settlement.record_transfer_shortfall', settlementId: id, shortfallPaise: out.shortfallPaise, clawbackId: out.clawbackId,
      })
    }
    if (out.reviewed.length > 0) {
      captureFinancialError(new Error(`payout request(s) held for review after a recorded transfer ${id}`), {
        scope: 'settlement.record_transfer_review_opened', settlementId: id, settlementIds: out.reviewed.join(','),
      })
    }
    void notifySettlement({ workspaceUid: out.organizerUid, settlementId: id, kind: 'paid', amountPaise: out.amountPaise })
    void enqueueWebhook(out.organizerUid, 'settlement.paid', { settlementId: id, amountPaise: out.amountPaise, utrNumber }).catch(() => {})
    return NextResponse.json({ id, status: 'paid' } satisfies AdminSettlementPatchResponse)
  }

  // ── M1.2 · B · changed-destination exception: INITIATE (Super Admin; evidence; no money moves) ────────────────

  if (action === 'transfer_exception_initiate') {
    const utr = normalizeUtr(body.utrNumber)
    if (!utr) return NextResponse.json({ error: 'A valid UTR / bank transfer reference (6–40 letters or digits) is required.', code: 'UTR_REQUIRED' }, { status: 422 })
    let result: { duplicate: boolean; fingerprint: string; organizerUid: string }
    try {
      result = await adminDb.runTransaction(async tx => {
        const snap = await tx.get(settlementRef)
        if (!snap.exists) throw new Error('NOT_FOUND')
        const d = snap.data() as SettlementRequestDoc
        if (d.status !== 'approved') throw new Error(`WRONG_STATE:${d.status}`)
        const ev = validateTransferEvidence(body.evidence, d.payoutDestination)
        if (!ev.ok) throw new Error(`EVIDENCE:${ev.code}:${ev.error}`)
        const fingerprint = transferExceptionFingerprint({ settlementId: id, amountPaise: d.amountPaise, utr, evidence: ev.evidence })
        if (d.transferException?.status === 'pending_approval') {
          if (d.transferException.fingerprint === fingerprint) return { duplicate: true, fingerprint, organizerUid: d.organizerUid }
          throw new Error('EXCEPTION_PENDING')
        }
        // only when the STANDARD path refuses because the destination changed — never a way around a working guard
        const profileSnap = await tx.get(adminDb.doc(`organizerPayoutProfiles/${d.organizerUid}`))
        const binding = checkSettlementBinding(d.payoutDestination, profileSnap.exists ? profileSnap.data() as OrganizerPayoutProfileDoc : null)
        if (binding.ok) throw new Error('DESTINATION_UNCHANGED')
        const conflict = await readTransferReferenceConflict(tx, utr, id, String(body.utrNumber))
        if (conflict) throw new Error(`UTR_IN_USE:${conflict}`)
        tx.update(settlementRef, {
          transferException: {
            status: 'pending_approval', amountPaise: d.amountPaise, utrNumber: utr, reason, evidence: ev.evidence, fingerprint,
            bindingCodeAtRequest: binding.code, initiatedBy: adminUid, initiatedAt: FieldValue.serverTimestamp(),
          },
          updatedAt: FieldValue.serverTimestamp(),
        })
        stageAdminAudit(tx, {
          adminUid, actorRole: 'super_admin', action: 'settlement.transfer_exception_requested', entityType: 'settlement', entityId: id, reason,
          changedFields: ['transferException'],
          before: { status: 'approved', exception: d.transferException?.status ?? null },
          after:  { status: 'approved', exception: 'pending_approval' },
          metadata: {
            organizerUid: d.organizerUid, amountPaise: d.amountPaise, utrNumber: utr, fingerprint, bindingCode: binding.code,
            evidence: { originalDestination: ev.evidence.originalDestination, transferSource: ev.evidence.transfer.source, transferReference: ev.evidence.transfer.reference },
          },
          correlation: { settlementId: id, organizerUid: d.organizerUid, utrNumber: utr },
        })
        return { duplicate: false, fingerprint, organizerUid: d.organizerUid }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'UNKNOWN'
      if (msg === 'NOT_FOUND') return NextResponse.json({ error: 'Settlement not found' }, { status: 404 })
      if (msg.startsWith('WRONG_STATE:')) return NextResponse.json({ error: `Only an approved payout can carry a transfer exception (current: '${msg.split(':')[1]}').` }, { status: 409 })
      if (msg.startsWith('EVIDENCE:')) { const [, code, ...rest] = msg.split(':'); return NextResponse.json({ error: rest.join(':'), code }, { status: 422 }) }
      if (msg === 'EXCEPTION_PENDING') return exceptionPendingResponse()
      if (msg === 'DESTINATION_UNCHANGED') return NextResponse.json({ error: 'The payout destination has NOT changed: use the standard Mark Paid / Record transfer path.', code: 'DESTINATION_UNCHANGED' }, { status: 409 })
      if (msg.startsWith('UTR_IN_USE:')) return NextResponse.json({ error: 'This transfer reference is already recorded on another payout request. Investigate manually.', code: 'UTR_IN_USE' }, { status: 409 })
      console.error('[settlement] transfer_exception_initiate failed:', { id, msg })
      return NextResponse.json({ error: 'The exception could not be requested. Nothing was changed.' }, { status: 500 })
    }
    return NextResponse.json({ id, status: 'approved', exception: 'pending_approval', fingerprint: result.fingerprint, duplicate: result.duplicate })
  }

  // ── M1.2 · B · APPROVE (a different Super Admin; bound to amount, UTR and evidence; records it paid ONCE) ────────

  if (action === 'transfer_exception_approve') {
    const utr = normalizeUtr(body.utrNumber)
    const expectedAmount = body.expectedAmountPaise
    const expectedFingerprint = typeof body.evidenceFingerprint === 'string' ? body.evidenceFingerprint : ''
    if (!utr || typeof expectedAmount !== 'number' || !expectedFingerprint) {
      return NextResponse.json({ error: 'Approval must restate the UTR, the expected amount (expectedAmountPaise) and the evidence fingerprint.', code: 'APPROVAL_BINDING_REQUIRED' }, { status: 422 })
    }
    let out: { duplicate: boolean; organizerUid: string; amountPaise: number; shortfallPaise: number; clawbackId: string | null; reviewed: string[] }
    try {
      out = await adminDb.runTransaction(async tx => {
        const snap = await tx.get(settlementRef)
        if (!snap.exists) throw new Error('NOT_FOUND')
        const d = snap.data() as SettlementRequestDoc
        const ex = d.transferException
        const bindingMatches = !!ex && ex.amountPaise === expectedAmount && d.amountPaise === expectedAmount && ex.utrNumber === utr && ex.fingerprint === expectedFingerprint
        // idempotent replay: this exact approval already recorded the transfer
        if (d.status === 'paid' && ex?.status === 'approved' && bindingMatches) {
          return { duplicate: true, organizerUid: d.organizerUid, amountPaise: d.amountPaise, shortfallPaise: 0, clawbackId: null, reviewed: [] }
        }
        if (d.status !== 'approved') throw new Error(`WRONG_STATE:${d.status}`)
        if (!ex || ex.status !== 'pending_approval') throw new Error('NO_PENDING_EXCEPTION')
        if (ex.initiatedBy === adminUid || (d.approvedBy && d.approvedBy === adminUid)) throw new Error('MAKER_CHECKER_EXCEPTION')
        if (!bindingMatches) throw new Error('APPROVAL_MISMATCH')
        // re-validate the evidence against the request as it is NOW, and that the destination still differs
        const ev = validateTransferEvidence(ex.evidence, d.payoutDestination)
        if (!ev.ok || transferExceptionFingerprint({ settlementId: id, amountPaise: d.amountPaise, utr, evidence: ev.evidence }) !== ex.fingerprint) throw new Error('EVIDENCE_STALE')
        const profileSnap = await tx.get(adminDb.doc(`organizerPayoutProfiles/${d.organizerUid}`))
        const binding = checkSettlementBinding(d.payoutDestination, profileSnap.exists ? profileSnap.data() as OrganizerPayoutProfileDoc : null)
        if (binding.ok) throw new Error('DESTINATION_UNCHANGED')
        const conflict = await readTransferReferenceConflict(tx, utr, id, utr)
        if (conflict) throw new Error(`UTR_IN_USE:${conflict}`)
        const walletRef  = adminDb.doc(`organizerRevenueWallets/${d.organizerUid}`)
        const walletSnap = await tx.get(walletRef)
        if (!walletSnap.exists) throw new Error('NO_WALLET')
        const wallet   = walletSnap.data() as OrganizerRevenueWallet
        const requests = (await readOpenPayoutRequests(tx, d.organizerUid)).filter(r => r.id !== id)
        // ── writes ──
        // the transfer reference, ONCE (create fails if any other path already reserved it)
        tx.create(adminDb.collection(TRANSFER_REFERENCES_COLLECTION).doc(utr), {
          utrNumber: utr, settlementId: id, organizerUid: d.organizerUid, amountPaise: d.amountPaise,
          recordedVia: 'transfer_exception', initiatedBy: ex.initiatedBy, approvedBy: adminUid, createdAt: FieldValue.serverTimestamp(),
        })
        const plan = stageConfirmedTransferPaid(tx, { settlementId: id, settlement: d, walletRef, wallet, otherRequests: requests })
        const reviewOpen = d.payoutReview?.status === 'open'
        tx.update(settlementRef, {
          status: 'paid', paidAt: FieldValue.serverTimestamp(), paidByAdmin: adminUid, updatedAt: FieldValue.serverTimestamp(), utrNumber: utr,
          reserved: false,
          'transferException.status': 'approved', 'transferException.approvedBy': adminUid, 'transferException.approvedAt': FieldValue.serverTimestamp(),
          'transferException.approvalReason': reason,
          ...(reviewOpen ? {
            'payoutReview.status': 'resolved', 'payoutReview.outcome': 'paid_after_transfer', 'payoutReview.resolvedAt': FieldValue.serverTimestamp(),
            'payoutReview.resolvedBy': adminUid, 'payoutReview.resolutionReason': reason,
            'payoutReview.shortfallPaise': plan.shortfallPaise, 'payoutReview.clawbackId': plan.clawbackId,
          } : {}),
        })
        stageAdminAudit(tx, {
          adminUid, actorRole: 'super_admin', action: 'settlement.paid', entityType: 'settlement', entityId: id, reason,
          changedFields: ['status', 'paidAt', 'paidByAdmin', 'utrNumber', 'transferException', ...(reviewOpen ? ['payoutReview'] : [])],
          before: { status: 'approved', exception: 'pending_approval', availablePaise: wallet.availablePaise, settledPaise: wallet.settledPaise },
          after:  { status: 'paid', exception: 'approved', availablePaise: plan.newAvailable, settledPaise: wallet.settledPaise + d.amountPaise },
          metadata: {
            organizerUid: d.organizerUid, amountPaise: d.amountPaise, utrNumber: utr,
            paidVia: 'transfer_exception', exceptionInitiatedBy: ex.initiatedBy, exceptionApprovedBy: adminUid, settlementApprovedBy: d.approvedBy ?? null,
            makerChecker: 'distinct_initiator_and_approver', bindingCode: binding.code, fingerprint: ex.fingerprint,
            evidence: { originalDestination: ex.evidence.originalDestination, transferSource: ex.evidence.transfer.source, transferReference: ex.evidence.transfer.reference },
            takenFromAvailablePaise: plan.takePaise, shortfallPaise: plan.shortfallPaise, clawbackId: plan.clawbackId,
            ...(reviewOpen ? { reviewResolution: 'paid_after_transfer', reviewTrigger: d.payoutReview?.trigger ?? null } : {}),
            otherRequestsReviewed: plan.reviewed,
          },
          correlation: { settlementId: id, organizerUid: d.organizerUid, utrNumber: utr },
        })
        return { duplicate: false, organizerUid: d.organizerUid, amountPaise: d.amountPaise, shortfallPaise: plan.shortfallPaise, clawbackId: plan.clawbackId, reviewed: plan.reviewed }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'UNKNOWN'
      if (msg === 'NOT_FOUND') return NextResponse.json({ error: 'Settlement not found' }, { status: 404 })
      if (msg.startsWith('WRONG_STATE:')) return NextResponse.json({ error: `The payout is not awaiting this approval (current: '${msg.split(':')[1]}').`, code: 'WRONG_STATE' }, { status: 409 })
      if (msg === 'NO_PENDING_EXCEPTION') return NextResponse.json({ error: 'No transfer exception is pending approval for this payout.', code: 'NO_PENDING_EXCEPTION' }, { status: 409 })
      if (msg === 'MAKER_CHECKER_EXCEPTION') return NextResponse.json({ error: exceptionMakerCheckerMessage(), code: 'MAKER_CHECKER_REQUIRED', exception: 'pending_approval' }, { status: 409 })
      if (msg === 'APPROVAL_MISMATCH') return NextResponse.json({ error: 'The amount, UTR or evidence fingerprint does not match the pending exception. Nothing was recorded.', code: 'APPROVAL_MISMATCH' }, { status: 409 })
      if (msg === 'EVIDENCE_STALE') return NextResponse.json({ error: 'The request changed since the exception was requested; its evidence no longer matches. Decline it and investigate.', code: 'EVIDENCE_STALE' }, { status: 409 })
      if (msg === 'DESTINATION_UNCHANGED') return NextResponse.json({ error: 'The payout destination no longer differs: decline the exception and use the standard path.', code: 'DESTINATION_UNCHANGED' }, { status: 409 })
      if (msg.startsWith('UTR_IN_USE:') || /ALREADY_EXISTS|already exists/i.test(msg)) return NextResponse.json({ error: 'This transfer reference is already recorded on another payout request. Nothing was recorded.', code: 'UTR_IN_USE' }, { status: 409 })
      if (msg === 'NO_WALLET') return NextResponse.json({ error: 'Organizer revenue wallet not found.' }, { status: 400 })
      console.error('[settlement] transfer_exception_approve failed:', { id, msg })
      return NextResponse.json({ error: 'The transfer could not be recorded. Nothing was changed.' }, { status: 500 })
    }
    if (!out.duplicate) {
      if (out.clawbackId) {
        await logClawbackEvent(adminUid, 'clawback.created', out.clawbackId, { settlementId: id, outstandingPaise: out.shortfallPaise, reason: 'payout_shortfall' })
        captureFinancialError(new Error(`payout recorded by transfer exception with a shortfall: ${id}`), {
          scope: 'settlement.transfer_exception_shortfall', settlementId: id, shortfallPaise: out.shortfallPaise, clawbackId: out.clawbackId,
        })
      }
      if (out.reviewed.length > 0) {
        captureFinancialError(new Error(`payout request(s) held for review after a transfer exception ${id}`), {
          scope: 'settlement.transfer_exception_review_opened', settlementId: id, settlementIds: out.reviewed.join(','),
        })
      }
      void notifySettlement({ workspaceUid: out.organizerUid, settlementId: id, kind: 'paid', amountPaise: out.amountPaise })
      void enqueueWebhook(out.organizerUid, 'settlement.paid', { settlementId: id, amountPaise: out.amountPaise, utrNumber: utr }).catch(() => {})
    }
    return NextResponse.json({ id, status: 'paid', duplicate: out.duplicate })
  }

  // ── M1.2 · B · DECLINE (kept as evidence; the request itself is unchanged) ──────────────────────────────────

  if (action === 'transfer_exception_decline') {
    try {
      await adminDb.runTransaction(async tx => {
        const snap = await tx.get(settlementRef)
        if (!snap.exists) throw new Error('NOT_FOUND')
        const d = snap.data() as SettlementRequestDoc
        const ex = d.transferException
        if (!ex || ex.status !== 'pending_approval') throw new Error('NO_PENDING_EXCEPTION')
        const declined = { ...ex, status: 'declined' as const, declinedBy: adminUid, declinedAt: FieldValue.serverTimestamp(), declineReason: reason }
        tx.update(settlementRef, {
          transferException: FieldValue.delete(),
          [`transferExceptionHistory.${ex.fingerprint.slice(0, 16)}_${Date.now()}`]: declined,
          updatedAt: FieldValue.serverTimestamp(),
        })
        stageAdminAudit(tx, {
          adminUid, actorRole: 'super_admin', action: 'settlement.transfer_exception_declined', entityType: 'settlement', entityId: id, reason,
          changedFields: ['transferException', 'transferExceptionHistory'],
          before: { exception: 'pending_approval' }, after: { exception: 'declined' },
          metadata: { organizerUid: d.organizerUid, amountPaise: ex.amountPaise, utrNumber: ex.utrNumber, fingerprint: ex.fingerprint, initiatedBy: ex.initiatedBy },
          correlation: { settlementId: id, organizerUid: d.organizerUid, utrNumber: ex.utrNumber },
        })
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'UNKNOWN'
      if (msg === 'NOT_FOUND') return NextResponse.json({ error: 'Settlement not found' }, { status: 404 })
      if (msg === 'NO_PENDING_EXCEPTION') return NextResponse.json({ error: 'No transfer exception is pending approval for this payout.', code: 'NO_PENDING_EXCEPTION' }, { status: 409 })
      console.error('[settlement] transfer_exception_decline failed:', { id, msg })
      return NextResponse.json({ error: 'The exception could not be declined. Nothing was changed.' }, { status: 500 })
    }
    return NextResponse.json({ id, status: 'approved', exception: 'declined' })
  }

  // ── paid: atomic Firestore transaction ────────────────────────────────────────
  // Reads settlement + wallet together, validates balance, then:
  //   settlement.status   → paid
  //   wallet.availablePaise -= amountPaise
  //   wallet.settledPaise   += amountPaise

  if (!utrNumber) {
    return NextResponse.json(
      { error: 'utrNumber is required to mark a settlement as paid.' },
      { status: 422 },
    )
  }
  // M1.3 — one UTR, one payout: the shared canonical form (validated before any write)
  const paidUtr = canonicalUtr(utrNumber)
  if (!paidUtr) return utrInvalidResponse()

  try {
    let capturedOrganizerUid = ''
    let capturedAmountPaise  = 0

    const resultStatus = await adminDb.runTransaction(async tx => {
      const settlementSnap = await tx.get(settlementRef)
      if (!settlementSnap.exists) throw new Error('NOT_FOUND')

      const settlement = settlementSnap.data() as SettlementRequestDoc
      if (settlement.status !== 'approved') {
        throw new Error(`WRONG_STATE:${settlement.status}`)
      }
      // M1 — a request held for review is never paid here (resolve the review; record_transfer if it was sent)
      if (settlement.payoutReview?.status === 'open') throw new Error('UNDER_REVIEW')
      if (settlement.transferException?.status === 'pending_approval') throw new Error('EXCEPTION_PENDING')   // M1.2

      // D2 — maker-checker. Approvals recorded before `approvedBy` existed carry no approver;
      // they are allowed and flagged in the audit row (`makerChecker: 'legacy_no_approver'`).
      if (settlement.approvedBy && settlement.approvedBy === adminUid) {
        throw new Error('MAKER_CHECKER')
      }

      // P9.1 + D5: re-verify the payout destination INSIDE the transaction before any money
      // moves — verified, and (when the request snapshotted one) the SAME verified destination.
      const profileSnap = await tx.get(adminDb.doc(`organizerPayoutProfiles/${settlement.organizerUid}`))
      const binding = checkSettlementBinding(
        settlement.payoutDestination,
        profileSnap.exists ? profileSnap.data() as OrganizerPayoutProfileDoc : null,
      )
      if (!binding.ok) throw new Error(binding.code)

      capturedOrganizerUid = settlement.organizerUid
      capturedAmountPaise  = settlement.amountPaise

      const walletRef  = adminDb.doc(`organizerRevenueWallets/${settlement.organizerUid}`)
      const walletSnap = await tx.get(walletRef)
      if (!walletSnap.exists) throw new Error('NO_WALLET')

      const wallet = walletSnap.data() as OrganizerRevenueWallet
      if (wallet.availablePaise < settlement.amountPaise) {
        throw new Error(`INSUFFICIENT:${wallet.availablePaise}`)
      }
      // M1.3 — one UTR, one payout: refused before any write; reserved atomically with the payout below
      if (await readTransferReferenceConflict(tx, paidUtr, id, utrNumber)) throw new Error('UTR_IN_USE')
      tx.create(adminDb.collection(TRANSFER_REFERENCES_COLLECTION).doc(paidUtr), {
        utrNumber: paidUtr, settlementId: id, organizerUid: settlement.organizerUid, amountPaise: settlement.amountPaise,
        recordedVia: 'mark_paid', recordedBy: adminUid, createdAt: FieldValue.serverTimestamp(),
      })

      // Release the reservation hold as the funds become settled. Gated on
      // `reserved` so legacy pre-fix requests (no hold) don't decrement.
      const releaseHold = settlement.reserved === true
        ? Math.min(wallet.inTransitPaise ?? 0, settlement.amountPaise)
        : 0

      tx.update(walletRef, {
        availablePaise:   wallet.availablePaise - settlement.amountPaise,
        settledPaise:     wallet.settledPaise   + settlement.amountPaise,
        inTransitPaise:   (wallet.inTransitPaise ?? 0) - releaseHold,
        lastSettlementAt: FieldValue.serverTimestamp(),
        updatedAt:        FieldValue.serverTimestamp(),
      })

      tx.update(settlementRef, {
        status:      'paid',
        paidAt:      FieldValue.serverTimestamp(),
        paidByAdmin: adminUid,
        updatedAt:   FieldValue.serverTimestamp(),
        adminNote:   adminNote || settlement.adminNote,
        utrNumber,
        ...(bankReference ? { bankReference } : {}),
        ...(paidBy        ? { paidBy }        : {}),
        ...(paymentNotes  ? { paymentNotes }  : {}),
      })

      stageAdminAudit(tx, {
        adminUid,
        actorRole:     'super_admin',
        action:        'settlement.paid',
        entityType:    'settlement',
        entityId:      id,
        reason,
        changedFields: ['status', 'paidAt', 'paidByAdmin', 'utrNumber'],
        before:        { status: 'approved', availablePaise: wallet.availablePaise, settledPaise: wallet.settledPaise },
        after:         {
          status:         'paid',
          availablePaise: wallet.availablePaise - settlement.amountPaise,
          settledPaise:   wallet.settledPaise   + settlement.amountPaise,
        },
        metadata:      {
          organizerUid:       settlement.organizerUid,
          amountPaise:        settlement.amountPaise,
          utrNumber,
          bankReference:      bankReference || null,
          paidBy:             paidBy || null,
          approvedBy:         settlement.approvedBy ?? null,
          makerChecker:       settlement.approvedBy ? 'distinct_approver' : 'legacy_no_approver',
          destinationBinding: binding.mode,
          destination:        settlement.payoutDestination?.label ?? null,
          releasedHoldPaise:  releaseHold,
        },
        correlation:   { settlementId: id, organizerUid: settlement.organizerUid, utrNumber },
      })

      return 'paid' as SettlementStatus
    })

    void (async () => {
      try {
        const profile = await fetchOrganizerProfile(capturedOrganizerUid)
        if (profile) {
          await sendSettlementPaidEmail({
            to:             profile.email,
            organizerName:  profile.name,
            amountPaise:    capturedAmountPaise,
            utrNumber,
            bankReference:  bankReference || undefined,
            paidAt:         new Date().toISOString(),
          })
        }
      } catch (err) {
        console.error('[settlement] Failed to send paid email:', { id, err })
      }
    })()

    // H.4.3: organizer Notification Center inbox (best-effort).
    void notifySettlement({ workspaceUid: capturedOrganizerUid, settlementId: id, kind: 'paid', amountPaise: capturedAmountPaise })

    // Organizer webhook (fire-and-forget; no-op when no webhook configured).
    void enqueueWebhook(capturedOrganizerUid, 'settlement.paid', {
      settlementId: id, amountPaise: capturedAmountPaise, utrNumber,
    }).catch(() => {})

    return NextResponse.json({ id, status: resultStatus } satisfies AdminSettlementPatchResponse)

  } catch (e) {
    const msg = e instanceof Error ? e.message : 'UNKNOWN'
    if (msg === 'NOT_FOUND')  return NextResponse.json({ error: 'Settlement not found' }, { status: 404 })
    if (msg === 'NO_WALLET')  return NextResponse.json({ error: 'Organizer revenue wallet not found.' }, { status: 400 })
    if (msg === 'UNVERIFIED_PROFILE') return NextResponse.json({ error: PAYOUT_PROFILE_UNVERIFIED_MESSAGE }, { status: 422 })
    if (msg === 'DESTINATION_CHANGED') {
      return NextResponse.json({ error: DESTINATION_CHANGED_MESSAGE, code: 'DESTINATION_CHANGED' }, { status: 409 })
    }
    if (msg === 'MAKER_CHECKER') {
      return NextResponse.json({ error: makerCheckerMessage(), code: 'MAKER_CHECKER_REQUIRED' }, { status: 409 })
    }
    if (msg === 'UNDER_REVIEW') return underReviewResponse()
    if (msg === 'EXCEPTION_PENDING') return exceptionPendingResponse()
    if (msg === 'UTR_IN_USE' || /ALREADY_EXISTS|already exists/i.test(msg)) return utrInUseResponse()
    if (msg.startsWith('WRONG_STATE:')) {
      const state = msg.split(':')[1]
      return NextResponse.json(
        { error: `Settlement must be 'approved' before marking paid (current: '${state}').` },
        { status: 409 },
      )
    }
    if (msg.startsWith('INSUFFICIENT:')) {
      const avail = parseInt(msg.split(':')[1] ?? '0', 10)
      return NextResponse.json(
        { error: `Insufficient available balance. Available: ₹${(avail / 100).toFixed(2)}.` },
        { status: 422 },
      )
    }
    console.error('[settlement] mark-paid failed:', { id, msg })
    return NextResponse.json({ error: 'The payout could not be recorded. Nothing was changed.' }, { status: 500 })
  }
}
