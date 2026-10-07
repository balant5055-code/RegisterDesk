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

  if (action !== 'approve' && action !== 'reject' && action !== 'paid') {
    return NextResponse.json(
      { error: 'action must be: approve | reject | paid' },
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

        const walletRef  = adminDb.doc(`organizerRevenueWallets/${d.organizerUid}`)
        const walletSnap = d.reserved === true ? await tx.get(walletRef) : null

        tx.update(settlementRef, {
          status:     'rejected',
          rejectedBy: adminUid,
          updatedAt:  FieldValue.serverTimestamp(),
          adminNote:  adminNote || d.adminNote,
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
