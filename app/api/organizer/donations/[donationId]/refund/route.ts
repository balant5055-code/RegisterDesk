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
import { resolveSuperAdminUid }      from '@/lib/admin/auth'
import { razorpay }                  from '@/lib/razorpay/client'
import { checkRateLimit }            from '@/lib/rateLimit'
import { logAdminActionOrRecord }    from '@/lib/admin/audit'
import { parseFinancialReason }      from '@/lib/admin/financialGuard'
import { getDonation }               from '@/lib/firebase/firestore/donations'
import {
  reserveRefund, releaseReservation, ensureRefundRecord, applyDonationRefundAccounting,
} from '@/lib/donations/refundService'
import type { DonationRefundDocument } from '@/lib/donations/types'

type ExistingRefundLookup =
  | { kind: 'found'; refundId: string; status: string }
  | { kind: 'none' }
  | { kind: 'uncertain'; why: string }

/**
 * RD-PHASE4-S4 · F5 — the Stage 1 C4 pattern, adapted to donations (which may carry several
 * LEGITIMATE partial refunds). Before creating a gateway refund, ask Razorpay which refunds this
 * payment already has and compare them with the ones RECORDED here (donationRefunds/{refundId}).
 * An unrecorded refund is one a previous attempt created but never recorded (its response was
 * lost). Fails CLOSED: a lookup failure, or any unrecorded refund that is not exactly one of this
 * amount, is 'uncertain' — and an uncertain refund never calls the gateway.
 */
async function findUnrecordedGatewayRefund(paymentId: string, amountPaise: number): Promise<ExistingRefundLookup> {
  let res: { items?: unknown } | null | undefined
  try {
    res = await razorpay.payments.fetchMultipleRefund(paymentId) as { items?: unknown } | null | undefined
  } catch {
    return { kind: 'uncertain', why: 'lookup_failed' }
  }
  if (!res || !Array.isArray(res.items)) return { kind: 'uncertain', why: 'lookup_malformed' }
  const live = (res.items as Array<{ id?: unknown; amount?: unknown; status?: unknown } | null>)
    .filter((r): r is { id: string; amount?: unknown; status?: unknown } => !!r && r.status !== 'failed' && typeof r.id === 'string' && r.id !== '')
  if (live.length === 0) return { kind: 'none' }
  let recorded: FirebaseFirestore.DocumentSnapshot[]
  try {
    recorded = await adminDb.getAll(...live.map(r => adminDb.collection('donationRefunds').doc(r.id)))
  } catch {
    return { kind: 'uncertain', why: 'local_lookup_failed' }
  }
  const unrecorded = live.filter((_, i) => !recorded[i]?.exists)
  if (unrecorded.length === 0) return { kind: 'none' }
  if (unrecorded.length === 1 && unrecorded[0].amount === amountPaise) {
    return { kind: 'found', refundId: unrecorded[0].id, status: typeof unrecorded[0].status === 'string' ? unrecorded[0].status : 'pending' }
  }
  return { kind: 'uncertain', why: 'unrecorded_refund_on_payment' }
}

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
  // ── 1. Auth — SUPER ADMIN ONLY ────────────────────────────────────────────
  //
  // RD-PAYMENT-REFUND-AUTHORITY-02. This was `verifyCaller` plus an ownership check, so the
  // organizer who received a donation could refund it themselves. A donation is a donor's
  // money; returning it is a platform financial action with a counterparty, and it now needs
  // the same authority as every other refund.
  //
  // The ownership check further down is DELIBERATELY LEFT IN PLACE. It is no longer an
  // authorization gate — a super admin passes it by construction below — but it still
  // guarantees the donation and the organizer agree before any accounting is applied.
  const superAdminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!superAdminUid) {
    return NextResponse.json(
      { success: false, error: 'Refunds can only be initiated by a platform super administrator.' },
      { status: 403 },
    )
  }

  const rl = checkRateLimit(superAdminUid, 'donation-refund', 20, 60 * 60 * 1000)
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
  // RD-PHASE4-S4 · D3 — 3–500 characters (the existing required-reason check above is kept).
  const reasonCheck = parseFinancialReason(reason)
  if (!reasonCheck.ok) return NextResponse.json({ success: false, error: reasonCheck.error, code: reasonCheck.code }, { status: 400 })

  // ── 3. Load + validate ─────────────────────────────────────────────────────
  const donation = await getDonation(donationId)
  if (!donation) return NextResponse.json({ success: false, error: 'Donation not found' }, { status: 404 })
  // The caller is a super admin, so there is no workspace to match against. What still has
  // to hold is that the donation knows which workspace it belongs to — the refund accounting
  // below debits that organizer, and debiting nobody would silently skip the reversal.
  if (typeof donation.organizerUid !== 'string' || !donation.organizerUid) {
    return NextResponse.json(
      { success: false, error: 'This donation has no organizer and cannot be refunded automatically.' },
      { status: 409 },
    )
  }
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
  // RD-PHASE4-S4 · F5 — fail-closed existing-refund lookup BEFORE any new gateway refund.
  const existing = await findUnrecordedGatewayRefund(donation.razorpayPaymentId, amountPaise)
  if (existing.kind === 'uncertain') {
    await releaseReservation(donationId, amountPaise)
    await logAdminActionOrRecord({
      adminUid: superAdminUid, actorRole: 'super_admin', action: 'donation.refund_failed', entityType: 'donation', entityId: donationId,
      reason,
      metadata: { amountPaise, outcome: 'refund_status_uncertain', why: existing.why },
      correlation: { donationId, paymentId: donation.razorpayPaymentId },
    })
    return NextResponse.json({
      success: false,
      code:    'REFUND_STATUS_UNCERTAIN',
      error:   'Razorpay shows a refund on this payment that RegisterDesk has not recorded (or the refund status could not be checked). No new refund was issued; reconcile this donation before retrying.',
    }, { status: 409 })
  }
  try {
    if (existing.kind === 'found') {
      // A previous attempt's refund whose response was lost — adopt it, never create a second.
      refundId      = existing.refundId
      gatewayStatus = existing.status
    } else {
      const refund = await razorpay.payments.refund(donation.razorpayPaymentId, {
        amount:  amountPaise,
        speed:   'optimum',
        notes:   { donationId, reason: 'organizer_initiated' },
        receipt: `rfnd_don_${donationId}`.slice(0, 40),
      }) as { id: string; status: string }
      refundId      = refund.id
      gatewayStatus = refund.status
    }
  } catch (err) {
    await releaseReservation(donationId, amountPaise)   // undo the reservation
    console.error('[donation/refund] Razorpay refund failed:', { donationId, err })
    await logAdminActionOrRecord({
      adminUid: superAdminUid, actorRole: 'super_admin', action: 'donation.refund_failed', entityType: 'donation', entityId: donationId,
      reason,
      metadata: { amountPaise, reason },
      correlation: { donationId, paymentId: donation.razorpayPaymentId },
    })
    return NextResponse.json({ success: false, error: 'Razorpay refund failed. Please try again.' }, { status: 502 })
  }

  // ── 6. Record (immutable) + audit initiated ────────────────────────────────
  await ensureRefundRecord({
    refundId, donationId,
    campaignId:        donation.campaignId,
    campaignSlug:      donation.campaignSlug,
    organizerUid:      donation.organizerUid,
    razorpayPaymentId: donation.razorpayPaymentId,
    amountPaise,
    reason,
    initiatedBy:       superAdminUid,
  })
  // Money has moved: awaited, never throws; a failed audit write is recorded for reconciliation.
  await logAdminActionOrRecord({
    adminUid: superAdminUid, actorRole: 'super_admin', action: 'donation.refund_initiated', entityType: 'donation', entityId: donationId,
    reason,
    metadata: { amountPaise, reason, refundId, adoptedExisting: existing.kind === 'found' },
    correlation: { donationId, refundId, paymentId: donation.razorpayPaymentId },
  })

  // ── 7. Apply accounting now if the gateway already settled it ──────────────
  if (gatewayStatus === 'processed') {
    try {
      await applyDonationRefundAccounting(refundId)
      await logAdminActionOrRecord({
        adminUid: superAdminUid, actorRole: 'super_admin', action: 'donation.refund_processed', entityType: 'donation', entityId: donationId,
        metadata: { amountPaise, refundId },
        correlation: { donationId, refundId },
      })
    } catch (err) {
      // Reservation stays; the refund.processed webhook will complete accounting.
      console.error('[donation/refund] accounting deferred to webhook:', { donationId, refundId, err })
    }
  }

  return NextResponse.json({ success: true, refundId, status: gatewayStatus })
}
