// POST /api/organizer/donations/[donationId]/refund
//
// Organizer-initiated full or partial donation refund. Validates ownership +
// refundable balance, reserves locally, calls the Razorpay refund API, records
// an immutable donationRefunds entry, and applies accounting exactly-once
// (instant if the gateway returns 'processed', else via the refund.processed
// webhook). On any Razorpay failure, NO local financial state changes persist.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { verifyCaller }              from '@/lib/team/access'
import { razorpay }                  from '@/lib/razorpay/client'
import { checkRateLimit }            from '@/lib/rateLimit'
import { logAdminAction }            from '@/lib/admin/audit'
import { getDonation }               from '@/lib/firebase/firestore/donations'
import {
  reserveRefund, releaseReservation, ensureRefundRecord, applyDonationRefundAccounting,
} from '@/lib/donations/refundService'
import type { DonationRefundDocument } from '@/lib/donations/types'

export interface DonationRefundSummary {
  refundId:    string
  amountPaise: number
  status:      string
  reason:      string
  createdAt:   string | null
}

export interface DonationRefundStateResponse {
  grossPaise:      number
  refundedPaise:   number
  pendingPaise:    number
  refundablePaise: number
  status:          string
  refunds:         DonationRefundSummary[]
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ donationId: string }> },
): Promise<NextResponse<DonationRefundStateResponse | { error: string }>> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const uid = caller.uid

  const { donationId } = await context.params
  const donation = await getDonation(donationId)
  if (!donation) return NextResponse.json({ error: 'Donation not found' }, { status: 404 })
  if (donation.organizerUid !== uid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const refunded = donation.refundedAmountPaise ?? 0
  const pending  = donation.pendingRefundPaise ?? 0

  const snap = await adminDb.collection('donationRefunds')
    .where('donationId', '==', donationId)
    .orderBy('createdAt', 'desc')
    .get()

  const refunds: DonationRefundSummary[] = snap.docs.map(d => {
    const r = d.data() as DonationRefundDocument
    return { refundId: r.id, amountPaise: r.amountPaise, status: r.status, reason: r.reason, createdAt: tsToISO(r.createdAt) }
  })

  return NextResponse.json({
    grossPaise:      donation.amountPaise,
    refundedPaise:   refunded,
    pendingPaise:    pending,
    refundablePaise: donation.amountPaise - refunded - pending,
    status:          donation.status,
    refunds,
  })
}

export interface DonationRefundResponse {
  success:    boolean
  refundId?:  string
  status?:    string        // 'processed' | 'pending'
  error?:     string
  reason?:    string
}

const MAX_REASON = 500

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ donationId: string }> },
): Promise<NextResponse<DonationRefundResponse>> {
  // ── 1. Auth — canonical caller verification (email-verification gate) ─────
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const uid = caller.uid

  const rl = checkRateLimit(uid, 'donation-refund', 20, 60 * 60 * 1000)
  if (rl.limited) return NextResponse.json({ success: false, error: 'Too many refund requests. Please wait.' }, { status: 429 })

  const { donationId } = await context.params
  if (!donationId) return NextResponse.json({ success: false, error: 'donationId is required' }, { status: 400 })

  // ── 2. Parse ──────────────────────────────────────────────────────────────
  let amountPaise: number, reason: string
  try {
    const body = await req.json() as Record<string, unknown>
    amountPaise = typeof body.amountPaise === 'number' ? Math.round(body.amountPaise) : NaN
    reason      = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON) : ''
  } catch { return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 }) }

  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    return NextResponse.json({ success: false, error: 'amountPaise must be a positive integer' }, { status: 400 })
  }
  if (!reason) return NextResponse.json({ success: false, error: 'reason is required' }, { status: 400 })

  // ── 3. Load + validate ─────────────────────────────────────────────────────
  const donation = await getDonation(donationId)
  if (!donation) return NextResponse.json({ success: false, error: 'Donation not found' }, { status: 404 })
  if (donation.organizerUid !== uid) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  if (donation.status !== 'successful') {
    return NextResponse.json({ success: false, error: 'Only successful donations can be refunded' }, { status: 400 })
  }
  if (!donation.razorpayPaymentId) {
    return NextResponse.json({ success: false, error: 'No payment id recorded — cannot refund' }, { status: 422 })
  }
  const refundable = donation.amountPaise - (donation.refundedAmountPaise ?? 0) - (donation.pendingRefundPaise ?? 0)
  if (amountPaise > refundable) {
    return NextResponse.json(
      { success: false, reason: 'EXCEEDS_BALANCE', error: `Refund exceeds the refundable balance of ₹${(refundable / 100).toFixed(2)}.` },
      { status: 400 },
    )
  }

  // ── 4. Reserve locally (race-safety; Razorpay is the hard cap) ─────────────
  const reservation = await reserveRefund(donationId, amountPaise)
  if (!reservation.ok) {
    const map: Record<string, number> = { EXCEEDS_BALANCE: 400, NOT_SUCCESSFUL: 400, NOT_FOUND: 404 }
    return NextResponse.json(
      { success: false, reason: reservation.reason, error: 'Refund cannot be processed for this donation.' },
      { status: map[reservation.reason ?? ''] ?? 409 },
    )
  }

  // ── 5. Razorpay refund (no local financial change persists on failure) ─────
  let refundId: string
  let gatewayStatus: string
  try {
    const refund = await razorpay.payments.refund(donation.razorpayPaymentId, {
      amount:  amountPaise,
      speed:   'optimum',
      notes:   { donationId, reason: 'organizer_initiated' },
      receipt: `rfnd_don_${donationId}`.slice(0, 40),
    }) as { id: string; status: string }
    refundId      = refund.id
    gatewayStatus = refund.status
  } catch (err) {
    await releaseReservation(donationId, amountPaise)   // undo the reservation
    console.error('[donation/refund] Razorpay refund failed:', { donationId, err })
    void logAdminAction({
      adminUid: uid, action: 'donation.refund_failed', entityType: 'donation', entityId: donationId,
      metadata: { amountPaise, reason },
    }).catch(() => {})
    return NextResponse.json({ success: false, error: 'Razorpay refund failed. Please try again.' }, { status: 502 })
  }

  // ── 6. Record (immutable) + audit initiated ────────────────────────────────
  await ensureRefundRecord({
    refundId, donationId,
    campaignId:        donation.campaignId,
    campaignSlug:      donation.campaignSlug,
    organizerUid:      uid,
    razorpayPaymentId: donation.razorpayPaymentId,
    amountPaise,
    reason,
    initiatedBy:       uid,
  })
  void logAdminAction({
    adminUid: uid, action: 'donation.refund_initiated', entityType: 'donation', entityId: donationId,
    metadata: { amountPaise, reason, refundId },
  }).catch(() => {})

  // ── 7. Apply accounting now if the gateway already settled it ──────────────
  if (gatewayStatus === 'processed') {
    try {
      await applyDonationRefundAccounting(refundId)
      void logAdminAction({
        adminUid: uid, action: 'donation.refund_processed', entityType: 'donation', entityId: donationId,
        metadata: { amountPaise, refundId },
      }).catch(() => {})
    } catch (err) {
      // Reservation stays; the refund.processed webhook will complete accounting.
      console.error('[donation/refund] accounting deferred to webhook:', { donationId, refundId, err })
    }
  }

  return NextResponse.json({ success: true, refundId, status: gatewayStatus })
}
