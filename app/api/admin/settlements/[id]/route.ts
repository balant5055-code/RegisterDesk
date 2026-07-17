// PATCH /api/admin/settlements/[id]
// Body: { action: 'approve' | 'reject' | 'paid', adminNote?: string }
//
// State machine:
//   pending  → approve → approved
//   pending  → reject  → rejected
//   approved → paid    → paid       (atomic wallet debit)
//   approved → reject  → rejected

import { NextRequest, NextResponse } from 'next/server'
import { captureFinancialError }      from '@/lib/monitoring/sentry'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
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
import { logAdminAction } from '@/lib/admin/audit'
import { enqueueWebhook } from '@/lib/integrations/webhooks'
import { isPayoutProfileVerified, PAYOUT_PROFILE_UNVERIFIED_MESSAGE } from '@/lib/payout/verification'
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

export interface AdminSettlementPatchResponse {
  id:     string
  status: SettlementStatus
}

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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

  const settlementRef = adminDb.doc(`settlementRequests/${id}`)

  // ── approve ───────────────────────────────────────────────────────────────────

  if (action === 'approve') {
    const snap = await settlementRef.get()
    if (!snap.exists) return NextResponse.json({ error: 'Settlement not found' }, { status: 404 })
    const d = snap.data() as SettlementRequestDoc
    if (d.status !== 'pending') {
      return NextResponse.json(
        { error: `Cannot approve a '${d.status}' settlement.` }, { status: 409 },
      )
    }
    // P9.1: never approve a payout without a verified payout profile.
    if (!(await isPayoutProfileVerified(d.organizerUid))) {
      return NextResponse.json({ error: PAYOUT_PROFILE_UNVERIFIED_MESSAGE }, { status: 422 })
    }
    await settlementRef.update({
      status:     'approved',
      approvedAt: FieldValue.serverTimestamp(),
      updatedAt:  FieldValue.serverTimestamp(),
      ...(adminNote ? { adminNote } : {}),
    })

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

    void logAdminAction({
      adminUid,
      action:     'settlement.approved',
      entityType: 'settlement',
      entityId:   id,
      metadata:   { organizerUid: d.organizerUid, amountPaise: d.amountPaise, adminNote: adminNote || undefined },
    }).catch(err => captureFinancialError(err, { scope: 'settlement.approved_audit_failed', id }))

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
          status:    'rejected',
          updatedAt: FieldValue.serverTimestamp(),
          adminNote: adminNote || d.adminNote,
        })

        if (d.reserved === true && walletSnap?.exists) {
          const wallet  = walletSnap.data() as OrganizerRevenueWallet
          const release = Math.min(wallet.inTransitPaise ?? 0, d.amountPaise)
          tx.update(walletRef, {
            inTransitPaise: (wallet.inTransitPaise ?? 0) - release,
            updatedAt:      FieldValue.serverTimestamp(),
          })
        }

        return { organizerUid: d.organizerUid, amountPaise: d.amountPaise, adminNote: adminNote || d.adminNote }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'UNKNOWN'
      if (msg === 'NOT_FOUND') return NextResponse.json({ error: 'Settlement not found' }, { status: 404 })
      if (msg.startsWith('WRONG_STATE:')) {
        return NextResponse.json({ error: `Cannot reject a '${msg.split(':')[1]}' settlement.` }, { status: 409 })
      }
      return NextResponse.json({ error: msg }, { status: 422 })
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

    void logAdminAction({
      adminUid,
      action:     'settlement.rejected',
      entityType: 'settlement',
      entityId:   id,
      metadata:   { organizerUid: captured.organizerUid, amountPaise: captured.amountPaise, adminNote: captured.adminNote || undefined },
    }).catch(err => captureFinancialError(err, { scope: 'settlement.rejected_audit_failed', id }))

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

      // P9.1: re-verify the payout profile INSIDE the transaction before any
      // money moves — a payout must never reach an unverified bank profile.
      const profileSnap = await tx.get(adminDb.doc(`organizerPayoutProfiles/${settlement.organizerUid}`))
      if (!profileSnap.exists || (profileSnap.data() as OrganizerPayoutProfileDoc).isVerified !== true) {
        throw new Error('UNVERIFIED_PROFILE')
      }

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
        status:    'paid',
        paidAt:    FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        adminNote: adminNote || settlement.adminNote,
        utrNumber,
        ...(bankReference ? { bankReference } : {}),
        ...(paidBy        ? { paidBy }        : {}),
        ...(paymentNotes  ? { paymentNotes }  : {}),
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

    void logAdminAction({
      adminUid,
      action:     'settlement.paid',
      entityType: 'settlement',
      entityId:   id,
      metadata:   {
        organizerUid:  capturedOrganizerUid,
        amountPaise:   capturedAmountPaise,
        utrNumber,
        ...(bankReference ? { bankReference } : {}),
        ...(paidBy        ? { paidBy }        : {}),
      },
    }).catch(err => captureFinancialError(err, { scope: 'settlement.paid_audit_failed', id }))

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
    return NextResponse.json({ error: msg }, { status: 422 })
  }
}
