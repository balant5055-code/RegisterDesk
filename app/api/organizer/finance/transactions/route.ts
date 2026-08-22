// GET /api/organizer/finance/transactions
// Query params:
//   filter  = all | tickets | donations | refunds  (default: all)
//   limit   = 1–100                                (default: 50)
//   cursor  = platformTransactions document ID     (for next-page)
//
// Composite indexes required in Firestore:
//   platformTransactions: (organizerUid ASC, paidAt DESC)
//   platformTransactions: (organizerUid ASC, category ASC, paidAt DESC)
//   platformTransactions: (organizerUid ASC, status ASC,   paidAt DESC)

import { NextRequest, NextResponse }        from 'next/server'
import { authorizeWorkspace }               from '@/lib/team/workspace'
import { adminDb }                          from '@/lib/firebase/admin'
import { readFinanceFromLedger }            from '@/lib/platform/pricing'
import {
  buildFinanceTransactionView, loadRegistrationJoins, loadFinanceCoverage,
  type FinanceCoverage,
} from '@/lib/finance/financeService'
import type { PlatformTransactionDocument } from '@/lib/fees/types'

/**
 * RD-FINANCE-P1 — the wire shape.
 *
 * Every original field is retained with its original name and meaning, so existing readers
 * keep working; the new fields are purely additive. They are all assembled by
 * lib/finance/financeService.ts — this route performs no arithmetic of its own, and neither
 * does the client.
 */
export interface FinanceTransaction {
  // ── Original contract, unchanged ──────────────────────────────────────────
  id:                      string
  type:                    string
  category:                string
  entityId:                string
  entityType:              string
  payerName:               string
  payerEmail:              string
  grossAmountPaise:        number
  platformFeeTotalPaise:   number
  gatewayFeeEstimatePaise: number
  netSettlementPaise:      number
  feeModel:                string
  status:                  string
  paidAt:                  string | null

  // ── Added: what the ledger alone cannot express ───────────────────────────
  sourceId:                string
  passId:                  string | null
  passName:                string | null
  originalAmountPaise:     number | null
  discountAmountPaise:     number
  /** What the attendee was actually charged. Null when it cannot be sourced. */
  chargeAmountPaise:       number | null
  platformFeeBasePaise:    number
  platformFeeGstPaise:     number
  /** Null until Razorpay settlement reconciliation exists — never inferred. */
  gatewayFeeActualPaise:   number | null
  gatewayFeeBasis:         'estimated' | 'actual'
  /** Alias of netSettlementPaise under an unambiguous name. */
  organizerNetPaise:       number
  refundAmountPaise:       number
  /** Fees the ATTENDEE paid on top — NOT a deduction from the organizer. */
  attendeeBorneFeePaise:   number
  /** Fees genuinely deducted from the organizer's proceeds. */
  organizerBorneFeePaise:  number
  feeBearer:               'attendee' | 'organizer' | 'split' | 'none' | 'unknown'
  couponCode:              string | null
  refundStatus:            string | null
  paymentId:               string | null
  orderId:                 string | null
  figuresSource:           string
}

export interface FinanceTransactionsResponse {
  transactions: FinanceTransaction[]
  hasMore:      boolean
  nextCursor:   string | null
  /**
   * How much of the organizer's registration reality this ledger-backed list represents.
   * `platformTransactions` holds PAID transactions only, so a free registration has no row
   * here. Surfaced rather than hidden; free rows are never fabricated.
   */
  coverage:     FinanceCoverage
}

function tsToISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function')
    return (ts as { toDate: () => Date }).toDate().toISOString()
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'transactions')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { searchParams } = req.nextUrl
  const filter = searchParams.get('filter') ?? 'all'
  const limit  = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)))
  const cursor = searchParams.get('cursor') ?? ''

  const baseQ = adminDb
    .collection('platformTransactions')
    .where('organizerUid', '==', uid)

  const filteredQ =
    filter === 'tickets'   ? baseQ.where('category', '==', 'ticketed') :
    filter === 'donations' ? baseQ.where('category', '==', 'donation') :
    filter === 'refunds'   ? baseQ.where('status',   '==', 'refunded') :
    baseQ

  let q = filteredQ.orderBy('paidAt', 'desc').limit(limit + 1)

  if (cursor) {
    const cursorSnap = await adminDb.doc(`platformTransactions/${cursor}`).get()
    if (cursorSnap.exists) q = q.startAfter(cursorSnap)
  }

  const snap      = await q.get()
  const hasMore   = snap.docs.length > limit
  const pageDocs  = hasMore ? snap.docs.slice(0, limit) : snap.docs
  const nextCursor = hasMore ? (pageDocs[pageDocs.length - 1]?.id ?? null) : null

  const docs = pageDocs.map(doc => ({ id: doc.id, d: doc.data() as PlatformTransactionDocument }))

  // ONE batched read for the whole page. The join supplies what the ledger never stored —
  // the attendee's actual charge, the coupon and the pass — and is best-effort: if it fails
  // the ledger figures are still complete, so the page degrades rather than breaking.
  const regs = await loadRegistrationJoins(docs.map(x => x.d.sourceId))

  const transactions: FinanceTransaction[] = docs.map(({ id, d }) => {
    // RD-PRICING-02E: source finance figures from the immutable snapshot (ledger
    // fallback). Read-only; values are guaranteed byte-identical to the stored ledger.
    const fig  = readFinanceFromLedger(d)
    const view = buildFinanceTransactionView(
      { ...d, id } as PlatformTransactionDocument & Record<string, unknown>,
      fig,
      regs.get(d.sourceId) ?? null,
    )
    return {
      // Original contract — same names, same values, same source as before.
      id,
      type:                    view.type,
      category:                view.category,
      entityId:                view.entityId,
      entityType:              view.entityType,
      payerName:               view.payerName,
      payerEmail:              view.payerEmail,
      grossAmountPaise:        view.grossAmountPaise,
      platformFeeTotalPaise:   view.platformFeeTotalPaise,
      gatewayFeeEstimatePaise: view.gatewayFeeEstimatePaise,
      netSettlementPaise:      view.organizerNetPaise,
      feeModel:                view.feeModel,
      status:                  view.status,
      paidAt:                  view.paidAt ?? tsToISO(d.paidAt),

      // Additive.
      sourceId:                view.sourceId,
      passId:                  view.passId,
      passName:                view.passName,
      originalAmountPaise:     view.originalAmountPaise,
      discountAmountPaise:     view.discountAmountPaise,
      chargeAmountPaise:       view.chargeAmountPaise,
      platformFeeBasePaise:    view.platformFeeBasePaise,
      platformFeeGstPaise:     view.platformFeeGstPaise,
      gatewayFeeActualPaise:   view.gatewayFeeActualPaise,
      gatewayFeeBasis:         view.gatewayFeeBasis,
      organizerNetPaise:       view.organizerNetPaise,
      refundAmountPaise:       view.refundAmountPaise,
      attendeeBorneFeePaise:   view.attendeeBorneFeePaise,
      organizerBorneFeePaise:  view.organizerBorneFeePaise,
      feeBearer:               view.feeBearer,
      couponCode:              view.couponCode,
      refundStatus:            view.refundStatus,
      paymentId:               view.paymentId,
      orderId:                 view.orderId,
      figuresSource:           view.figuresSource,
    }
  })

  const coverage = await loadFinanceCoverage(uid, transactions.length)

  const response: FinanceTransactionsResponse = { transactions, hasMore, nextCursor, coverage }
  return NextResponse.json(response)
}
