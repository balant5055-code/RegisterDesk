// RD-REFUND-MANUAL-01 · PURE rules for Super Admin MANUAL attendee refunds — money returned to an
// attendee OUTSIDE the payment gateway (bank transfer, UPI, cash, cheque) and recorded in RegisterDesk.
// No Firestore I/O, no network, no clock: lib/refunds/manualRefunds.ts owns the I/O and calls into this.
// (canonicalUtr is shared with the payout recording paths rather than copied; its module imports the
// Admin SDK, so unit tests stub '@/lib/firebase/admin'.)
//
// ═══ WHAT A MANUAL REFUND IS — AND IS NOT ════════════════════════════════════
// RegisterDesk never sends this money. A Super Admin REQUESTS a refund (maker), the transfer is made
// outside the platform, and a DIFFERENT Super Admin COMPLETES it with the transfer reference (checker).
// Completion applies the accounting; nothing here calls a gateway or a bank.
//
// ═══ ACCOUNTING — THE DONATION REVERSAL MODEL, REUSED ═════════════════════════
// A registration's settlement transaction (ptx_{registrationId}) credited the organizer its NET. A refund
// of `amount` (gross, out of `charged`) reverses the organizer's PROPORTIONAL share of that net,
// cumulatively exact (lib/donations/reversalMath.ts planDonationReversal — the same model donation
// refunds use): round(net × amount / charged), and the refund that completes the charge reverses exactly
// what is left. So a full refund reverses exactly the credited net — the same debit a full gateway refund
// makes — and partial refunds never leave a residue or over-reverse by rounding.
//
// The reversal is a separate NEGATIVE ledger row (ptx_mrefund_{id}, parentTransactionId = the original),
// exactly like a donation refund: every reader that sums net (wallet reconciliation, organizer payable,
// finance totals) is already correct for it, and the original row is never flipped in place.

import { planDonationReversal } from '@/lib/donations/reversalMath'
import { canonicalUtr } from '@/lib/settlements/confirmedTransfer'
import { maskAccountNumber, maskUpi } from '@/lib/payout/mask'

export const MANUAL_REFUNDS_COLLECTION       = 'manualRegistrationRefunds'
/** One reference, one manual refund (canonical form; create-once). */
export const MANUAL_REFUND_REFERENCES_COLLECTION = 'manualRefundReferences'

export const MANUAL_REFUND_METHODS = ['bank_transfer', 'upi', 'cash', 'cheque', 'other'] as const
export type ManualRefundMethod = typeof MANUAL_REFUND_METHODS[number]

/**
 *   pending   — requested (maker). The registration is claimed `refund_pending` (so no gateway refund can
 *               start) and the payment intent records it (so a gateway refund that arrives anyway is held
 *               for review, never applied). An unreleased settlement is held.
 *   completed — a different Super Admin recorded the transfer reference (checker). Accounting applied
 *               in the same transaction. Terminal.
 *   cancelled — withdrawn before completion: every claim and hold is lifted. Terminal.
 */
export type ManualRefundStatus = 'pending' | 'completed' | 'cancelled'

export interface ManualRefundRecipient {
  name:   string
  /** Masked only — a full account number / UPI id is never stored. */
  detail: string | null
}

export interface ManualRefundDocument {
  id:              string
  registrationId:  string
  eventSlug:       string | null
  organizerUid:    string
  /** The payment this refund returns money for (the registration's settled payment). */
  orderId:         string
  paymentId:       string | null
  provider:        string
  amountPaise:     number
  chargedPaise:    number
  currency:        'INR'
  method:          ManualRefundMethod
  recipient:       ManualRefundRecipient
  reason:          string
  status:          ManualRefundStatus
  requestedBy:     string
  requestedAt:     unknown
  /** How exclusivity with gateway refunds was established at request time. */
  gatewayCheck:    'razorpay_no_refunds' | 'provider_unsupported_confirmed'
  /** Whether the request placed the settlement on hold (it is lifted on completion / cancellation). */
  heldSettlement:  boolean
  completedBy?:    string
  completedAt?:    unknown
  reference?:      string          // canonical transfer reference / UTR / receipt number
  transferredOn?:  string          // YYYY-MM-DD, as stated by the checker
  completionNote?: string
  /** Set on completion: the accounting it applied. */
  accounting?: {
    reversalNetPaise:  number
    debitedPaise:      number
    clawbackId:        string | null
    fullyRefunded:     boolean
    bucket:            'pending' | 'available'
  }
  cancelledBy?:    string
  cancelledAt?:    unknown
  cancelReason?:   string
}

// ─── validation ─────────────────────────────────────────────────────────────────────────────

const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/

/** The id of a request, derived from the caller's idempotency key — a resubmission resolves to the SAME record. */
export function manualRefundId(registrationId: string, requestKey: unknown): string | null {
  if (typeof requestKey !== 'string' || !REQUEST_KEY_RE.test(requestKey)) return null
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(registrationId)) return null
  return `mrr_${registrationId}_${requestKey}`
}

export function isManualRefundMethod(v: unknown): v is ManualRefundMethod {
  return typeof v === 'string' && (MANUAL_REFUND_METHODS as readonly string[]).includes(v)
}

/** Recipient as stored: a name, and a MASKED detail for the method (never a full account / UPI id). */
export function buildRecipient(method: ManualRefundMethod, name: unknown, detail: unknown): ManualRefundRecipient | null {
  const n = typeof name === 'string' ? name.trim().slice(0, 120) : ''
  if (n.length < 2) return null
  const d = typeof detail === 'string' ? detail.trim() : ''
  if (method === 'bank_transfer') {
    if (!/^\d{4,20}$/.test(d.replace(/\s/g, ''))) return null
    return { name: n, detail: maskAccountNumber(d.replace(/\s/g, '')) }
  }
  if (method === 'upi') {
    if (!/^[^\s@]{2,}@[A-Za-z0-9.-]{2,}$/.test(d)) return null
    return { name: n, detail: maskUpi(d) }
  }
  return { name: n, detail: d ? d.slice(0, 80) : null }
}

/** The transfer reference recorded on completion, canonical (one reference ⇒ one refund). */
export function canonicalReference(raw: unknown): string | null {
  return canonicalUtr(raw)
}

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v)
}

// ─── exclusivity + amounts ──────────────────────────────────────────────────────────────────

export type RequestRefusal =
  | 'NOT_PAID'                  // registration is not 'paid' (already refunded, refund in progress, free, …)
  | 'NO_PAYMENT_RECORD'         // no payment intent for the registration
  | 'NO_LEDGER_ENTRY'           // no settlement transaction — nothing to account against
  | 'LEDGER_REVERSED'           // the settlement transaction was already reversed (gateway refund / dispute)
  | 'GATEWAY_REFUND_EXISTS'     // a gateway refund of this payment is counted / recorded / known to the gateway
  | 'INVALID_AMOUNT'
  | 'EXCEEDS_REFUNDABLE'

/** Integer-paise amount, positive, within what is still refundable. Pure. */
export function checkRefundAmount(amountPaise: unknown, chargedPaise: number, alreadyRefundedPaise: number):
  { ok: true; amountPaise: number; fullRefund: boolean } | { ok: false; code: 'INVALID_AMOUNT' | 'EXCEEDS_REFUNDABLE' } {
  if (typeof amountPaise !== 'number' || !Number.isInteger(amountPaise) || amountPaise <= 0) return { ok: false, code: 'INVALID_AMOUNT' }
  if (!Number.isInteger(chargedPaise) || chargedPaise <= 0) return { ok: false, code: 'INVALID_AMOUNT' }
  const remaining = chargedPaise - Math.max(0, alreadyRefundedPaise)
  if (amountPaise > remaining) return { ok: false, code: 'EXCEEDS_REFUNDABLE' }
  return { ok: true, amountPaise, fullRefund: amountPaise === remaining }
}

/** Σ of the manual refunds recorded on the intent (pending AND completed — both are money committed out). */
export function sumManualRefunds(map: unknown): number {
  if (!map || typeof map !== 'object') return 0
  return Object.values(map as Record<string, unknown>)
    .reduce<number>((s, v) => s + (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0), 0)
}

/** Has ANY gateway refund of this payment been counted on its intent? Pure. */
export function hasCountedGatewayRefunds(gatewayRefundsPaise: unknown): boolean {
  return !!gatewayRefundsPaise && typeof gatewayRefundsPaise === 'object' && Object.keys(gatewayRefundsPaise as object).length > 0
}

/**
 * The organizer's share to reverse for this refund — the donation model, cumulatively exact. Pure.
 * `alreadyRefundedGrossPaise` counts only COMPLETED manual refunds (their nets are already reversed).
 */
export function planManualReversal(input: {
  chargedPaise: number; netPaise: number; alreadyRefundedGrossPaise: number; refundGrossPaise: number; alreadyReversedNetPaise: number
}): { reversalNetPaise: number; fullyRefunded: boolean } {
  const p = planDonationReversal({
    grossPaise: input.chargedPaise, netPaise: input.netPaise,
    alreadyRefundedGrossPaise: input.alreadyRefundedGrossPaise, refundGrossPaise: input.refundGrossPaise,
    alreadyReversedNetPaise: input.alreadyReversedNetPaise,
  })
  return { reversalNetPaise: p.reversalNetPaise, fullyRefunded: p.completesGross }
}

/** The net of the original settlement still releasable after manual reversals. Never negative. Pure. */
export function releasableNetAfterManualRefunds(netPaise: number, manualReversedNetPaise: unknown): number {
  const reversed = typeof manualReversedNetPaise === 'number' && Number.isFinite(manualReversedNetPaise) ? Math.max(0, manualReversedNetPaise) : 0
  return Math.max(0, netPaise - reversed)
}
