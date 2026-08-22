// RD-FINANCE-P0 · the ONE server-side finance calculation layer. Server-only.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// The Finance table computed money in React:
//
//     const fees = t.platformFeeTotalPaise + t.gatewayFeeEstimatePaise      // ← in the component
//
// and rendered it as `Gross − Fees = Net`. Under the live `customer_pays` model that
// subtraction never happened: the attendee paid the fees ON TOP of the ticket, and the
// organizer received the full gross. Production shows it exactly —
// gross ₹250.00, fees ₹9.20, net ₹250.00 — three true numbers arranged into a false sum.
//
// So every figure the Finance UI shows is assembled here, server-side, in integer paise,
// and the component is left with formatting.
//
// ═══ WHAT THIS MODULE MAY AND MAY NOT DO ═════════════════════════════════════
// It NEVER recalculates money. `readFinanceFromLedger` is the authoritative reader
// (snapshot-first, ledger fallback, guaranteed byte-equal to what was stored), and the fee
// engine's outputs are read, not re-derived. Historical rows therefore keep the amounts and
// the rates that applied when they were written — nothing here consults today's config.
//
// It adds exactly two things the ledger cannot express on its own:
//   1. ATTRIBUTION — who actually bore each fee, so the UI stops implying a deduction that
//      did not occur. Derived from the stored fee model AND cross-checked against the stored
//      arithmetic; if the two disagree the row is marked `unknown` rather than guessed.
//   2. A READ-ONLY JOIN to the registration for the figures the ledger never stored:
//      what the attendee was charged, the coupon, and the pass.
//
// It writes nothing, and it must stay that way: this module is imported by a GET route.

import { adminDb } from '@/lib/firebase/admin'
import { readFinanceFromLedger } from '@/lib/platform/pricing'
import type { PlatformTransactionDocument } from '@/lib/fees/types'

/**
 * Who bore a fee.
 *
 * `unknown` is a real, useful answer: it means the stored fee model and the stored
 * arithmetic disagree, and inventing an attribution there is exactly the class of error this
 * module exists to prevent.
 */
export type FeeBearer = 'attendee' | 'organizer' | 'split' | 'none' | 'unknown'

/** Is the gateway number reconciled with Razorpay, or our own estimate? */
export type GatewayFeeBasis = 'estimated' | 'actual'

export interface FinanceTransactionView {
  // ── Identity ──────────────────────────────────────────────────────────────
  id:            string
  sourceId:      string          // registrationId | donationId
  sourceType:    string
  type:          string
  category:      string
  entityId:      string          // eventSlug | campaignSlug
  entityType:    string
  payerName:     string
  payerEmail:    string

  // ── Product (data-driven; never a hardcoded category) ─────────────────────
  passId:        string | null
  passName:      string | null

  // ── Money — ALL integer paise ─────────────────────────────────────────────
  /** List price before any coupon. Null when the registration recorded none. */
  originalAmountPaise:     number | null
  /** Coupon discount actually applied. 0 when no coupon was used. */
  discountAmountPaise:     number
  /** Ticket value the platform fee was charged on (post-discount). Authoritative. */
  grossAmountPaise:        number
  /** What the attendee was actually charged. Null when it cannot be sourced. */
  chargeAmountPaise:       number | null
  platformFeeBasePaise:    number
  platformFeeGstPaise:     number
  platformFeeTotalPaise:   number
  gatewayFeeEstimatePaise: number
  /** Null until a Razorpay settlement reconciliation exists. Never inferred. */
  gatewayFeeActualPaise:   number | null
  gatewayFeeBasis:         GatewayFeeBasis
  /** The organizer's settlement basis, straight from the ledger. */
  organizerNetPaise:       number
  refundAmountPaise:       number

  // ── Attribution — the fix for the false subtraction ────────────────────────
  /** Fees the ATTENDEE paid on top of the ticket. Not a deduction from the organizer. */
  attendeeBorneFeePaise:   number
  /** Fees genuinely deducted from the organizer's proceeds. */
  organizerBorneFeePaise:  number
  feeModel:                string
  feeBearer:               FeeBearer

  // ── Classification ────────────────────────────────────────────────────────
  couponCode:    string | null
  status:        string
  refundStatus:  string | null
  paymentId:     string | null
  orderId:       string | null
  paidAt:        string | null
  /** Provenance of the figures: 'financials' | 'snapshot' | 'fallback'. */
  figuresSource: string
}

/**
 * How much of this page's reality the ledger actually represents.
 *
 * `platformTransactions` holds PAID transactions only — a free registration never creates
 * one. In production that is 775 ledger rows against 2,334 registrations, so a Finance
 * surface that silently equates the two under-reports by two thirds. The counts are exposed
 * so the UI can say so instead of implying completeness. Free registrations are NOT
 * fabricated as ledger rows.
 */
export interface FinanceCoverage {
  ledgerTransactions:    number
  totalRegistrations:    number
  freeRegistrations:     number
  /** True when free registrations exist that this ledger-backed list cannot show. */
  hasUnrepresentedFree:  boolean
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)
const intOrNull = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

function tsToISO(ts: unknown): string | null {
  if (!ts) return null
  const d = ts as { toDate?: () => Date }
  return typeof d.toDate === 'function' ? d.toDate().toISOString() : null
}

/**
 * Split the stored fees between attendee and organizer.
 *
 * ═══ TWO INDEPENDENT SOURCES, DELIBERATELY ═══════════════════════════════════
 * The fee model says what SHOULD have happened; the stored arithmetic says what DID. Under
 * `customer_pays` the ledger's net equals gross (the organizer lost nothing); under
 * `organizer_pays` net equals gross minus both fees. Deriving the bearer from the model
 * alone would keep believing the label after a mislabelled write; deriving it from the
 * arithmetic alone cannot distinguish a zero-fee row.
 *
 * So both are computed and required to agree. A disagreement yields `unknown` with a zero
 * split — the UI then shows the fees without asserting who paid them, which is the honest
 * rendering of a row we cannot explain.
 *
 * NOTHING here recalculates a fee. It only attributes amounts the ledger already stored.
 */
export function attributeFees(input: {
  feeModel:                string
  grossAmountPaise:        number
  platformFeeTotalPaise:   number
  gatewayFeeEstimatePaise: number
  netSettlementPaise:      number
  /** Preferred when the canonical breakdown was persisted — then no derivation is needed. */
  attendeeFeeTotalPaise?:  number
  organizerFeeTotalPaise?: number
}): { attendeeBorneFeePaise: number; organizerBorneFeePaise: number; feeBearer: FeeBearer } {
  const feesTotal = input.platformFeeTotalPaise + input.gatewayFeeEstimatePaise

  // 1 · The canonical breakdown, when the writer persisted one. Highest priority — it is a
  //     stored fact rather than anything inferred here.
  if (typeof input.attendeeFeeTotalPaise === 'number' && typeof input.organizerFeeTotalPaise === 'number') {
    const a = Math.trunc(input.attendeeFeeTotalPaise)
    const o = Math.trunc(input.organizerFeeTotalPaise)
    return {
      attendeeBorneFeePaise:  a,
      organizerBorneFeePaise: o,
      feeBearer: a > 0 && o > 0 ? 'split' : a > 0 ? 'attendee' : o > 0 ? 'organizer' : 'none',
    }
  }

  if (feesTotal === 0) {
    return { attendeeBorneFeePaise: 0, organizerBorneFeePaise: 0, feeBearer: 'none' }
  }

  // 2 · What the stored arithmetic implies, independent of the label.
  const organizerLost = input.grossAmountPaise - input.netSettlementPaise
  const arithmeticSaysAttendee  = organizerLost === 0
  const arithmeticSaysOrganizer = organizerLost === feesTotal

  // 3 · What the stored fee model claims.
  if (input.feeModel === 'customer_pays' && arithmeticSaysAttendee) {
    return { attendeeBorneFeePaise: feesTotal, organizerBorneFeePaise: 0, feeBearer: 'attendee' }
  }
  if (input.feeModel === 'organizer_pays' && arithmeticSaysOrganizer) {
    return { attendeeBorneFeePaise: 0, organizerBorneFeePaise: feesTotal, feeBearer: 'organizer' }
  }
  if (input.feeModel === 'no_fee' && feesTotal === 0) {
    return { attendeeBorneFeePaise: 0, organizerBorneFeePaise: 0, feeBearer: 'none' }
  }
  // `hybrid` splits by a ratio that is NOT stored on the ledger, so it cannot be
  // reconstructed here. Reported as a split of a known total with an unknown division
  // rather than invented.
  if (input.feeModel === 'hybrid' && organizerLost > 0 && organizerLost < feesTotal) {
    return {
      attendeeBorneFeePaise:  feesTotal - organizerLost,
      organizerBorneFeePaise: organizerLost,
      feeBearer:              'split',
    }
  }

  return { attendeeBorneFeePaise: 0, organizerBorneFeePaise: 0, feeBearer: 'unknown' }
}

/** The registration fields this module joins. All optional — legacy rows carry none. */
export interface RegistrationJoin {
  amount?:         unknown   // paise, what the attendee was charged
  originalAmount?: unknown   // paise, pre-coupon list price
  discountAmount?: unknown   // paise
  couponCode?:     unknown
  passId?:         unknown
  passName?:       unknown
  refundAmount?:   unknown
  refundStatus?:   unknown
  paymentId?:      unknown
  razorpayOrderId?: unknown
}

/**
 * Assemble ONE finance row. PURE — no I/O, so it is fully unit-testable and cannot write.
 *
 * `ledgerFigures` must come from `readFinanceFromLedger`, which is the authoritative reader.
 * `reg` is the read-only registration join, and may be null: every field it supplies
 * degrades to null/0 rather than being fabricated.
 */
export function buildFinanceTransactionView(
  doc: PlatformTransactionDocument & Record<string, unknown>,
  ledgerFigures: ReturnType<typeof readFinanceFromLedger>,
  reg: RegistrationJoin | null,
): FinanceTransactionView {
  const fig = ledgerFigures

  const attribution = attributeFees({
    feeModel:                doc.feeModel,
    grossAmountPaise:        fig.grossAmountPaise,
    platformFeeTotalPaise:   fig.platformFeeTotalPaise,
    gatewayFeeEstimatePaise: fig.gatewayFeeEstimatePaise,
    netSettlementPaise:      fig.netSettlementPaise,
    attendeeFeeTotalPaise:   fig.attendeeFeeTotalPaise,
    organizerFeeTotalPaise:  fig.organizerFeeTotalPaise,
  })

  // What the attendee paid. Preference order is by AUTHORITY, not convenience:
  //   1. the canonical persisted breakdown (chargeAmountPaise), when a writer stored one;
  //   2. the registration's own `amount`, which is the value handed to Razorpay.
  // Never derived by adding fees to gross — that would silently invent a charge for any row
  // whose stored figures disagree, which is the exact failure mode being fixed.
  const chargeAmountPaise = intOrNull(fig.chargeAmountPaise) ?? intOrNull(reg?.amount)

  // gatewayFeeActualPaise has NO writer anywhere in the codebase and the Razorpay
  // Settlements API is not integrated, so this is null in practice. It is read rather than
  // assumed so that the day a reconciliation job lands, this surface reports actuals with no
  // further change — and until then the basis is honestly 'estimated'.
  const gatewayFeeActualPaise = intOrNull(doc.gatewayFeeActualPaise)

  return {
    id:         doc.id,
    sourceId:   doc.sourceId,
    sourceType: doc.sourceType,
    type:       doc.type,
    category:   doc.category,
    entityId:   doc.entityId,
    entityType: doc.entityType,
    payerName:  doc.payerName,
    payerEmail: doc.payerEmail,

    passId:   str(reg?.passId),
    passName: str(reg?.passName),

    originalAmountPaise:     intOrNull(reg?.originalAmount),
    discountAmountPaise:     int(reg?.discountAmount),
    grossAmountPaise:        fig.grossAmountPaise,
    chargeAmountPaise,
    platformFeeBasePaise:    fig.platformFeeBasePaise,
    platformFeeGstPaise:     fig.platformFeeGstPaise,
    platformFeeTotalPaise:   fig.platformFeeTotalPaise,
    gatewayFeeEstimatePaise: fig.gatewayFeeEstimatePaise,
    gatewayFeeActualPaise,
    gatewayFeeBasis:         gatewayFeeActualPaise === null ? 'estimated' : 'actual',
    organizerNetPaise:       fig.netSettlementPaise,
    refundAmountPaise:       int(reg?.refundAmount),

    attendeeBorneFeePaise:  attribution.attendeeBorneFeePaise,
    organizerBorneFeePaise: attribution.organizerBorneFeePaise,
    feeModel:               doc.feeModel,
    feeBearer:              attribution.feeBearer,

    couponCode:   str(reg?.couponCode),
    status:       doc.status,
    refundStatus: str(reg?.refundStatus),
    paymentId:    str(doc.gatewayPaymentId) ?? str(reg?.paymentId),
    orderId:      str(doc.gatewayOrderId)   ?? str(reg?.razorpayOrderId),
    paidAt:       tsToISO((doc as Record<string, unknown>).paidAt),
    figuresSource: fig.source,
  }
}

/**
 * Batch-load the registrations behind a page of ledger rows. READ-ONLY.
 *
 * One `getAll` for the whole page rather than a read per row, and it degrades to an empty
 * map on failure so a Finance page never fails because a join did — the ledger figures are
 * complete on their own; the join only enriches them.
 */
export async function loadRegistrationJoins(sourceIds: string[]): Promise<Map<string, RegistrationJoin>> {
  const ids = [...new Set(sourceIds.filter(id => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return new Map()
  try {
    const refs  = ids.map(id => adminDb.collection('registrations').doc(id))
    const snaps = await adminDb.getAll(...refs)
    const out   = new Map<string, RegistrationJoin>()
    for (const s of snaps) if (s.exists) out.set(s.id, s.data() as RegistrationJoin)
    return out
  } catch {
    return new Map()
  }
}

/**
 * Registration coverage for one workspace, via COUNT aggregates.
 *
 * Aggregates transfer no documents, so this stays cheap on a 2,334-registration event. It
 * exists so the UI can state that a ledger-backed list shows paid transactions only, rather
 * than presenting 775 rows as if they were every registration.
 */
export async function loadFinanceCoverage(
  organizerUid: string,
  ledgerTransactions: number,
): Promise<FinanceCoverage> {
  const empty: FinanceCoverage = {
    ledgerTransactions, totalRegistrations: 0, freeRegistrations: 0, hasUnrepresentedFree: false,
  }
  try {
    const regQ = adminDb.collection('registrations').where('organizerUid', '==', organizerUid)
    const [totalAgg, freeAgg] = await Promise.all([
      regQ.count().get(),
      regQ.where('amount', '==', 0).count().get(),
    ])
    const totalRegistrations = int(totalAgg.data().count)
    const freeRegistrations  = int(freeAgg.data().count)
    return {
      ledgerTransactions,
      totalRegistrations,
      freeRegistrations,
      hasUnrepresentedFree: freeRegistrations > 0,
    }
  } catch {
    // A missing composite index must not fail the page; the UI treats 0/false as "unknown".
    return empty
  }
}
