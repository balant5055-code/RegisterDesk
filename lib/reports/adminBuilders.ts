// Admin (platform-wide) report builder. Aggregates the SAME stored ledger fields
// the organizer reports use — no separate financial math. Revenue comes entirely
// from one-time transaction fees on the Event License model (no subscriptions/MRR).

import { adminDb } from '@/lib/firebase/admin'
import type { Query } from 'firebase-admin/firestore'
import type { ReportTable, ReportFilters, ReportRow } from '@/lib/reports/types'
import { dayBoundDates } from '@/lib/reports/format'
import { readReportFromLedgerData } from '@/lib/platform/pricing'

// ═══ RD-ANALYTICS-12-07 · WHAT WAS WRONG ══════════════════════════════════════
//
// All three reads selected a fixed slice of the collection and applied the requested date
// range afterwards, in memory:
//
//     platformTransactions  .orderBy('paidAt','desc').limit(ADMIN_CAP + 1)   → inRange(paidAt)
//     donationRefunds       .orderBy('createdAt','desc').limit(ADMIN_CAP + 1)→ inRange(createdAt)
//     settlementRequests    .where('status','==','paid').limit(ADMIN_CAP)    → inRange(paidAt ?? requestedAt)
//
// Above 10,000 records that does not truncate an answer, it replaces one: the rows for the
// requested period were never fetched, so a historical platform report came back short or
// empty while presenting as authoritative. These figures are GMV, platform fees and GST.
//
// The settlement read was worse in two further ways. With no `orderBy` Firestore falls back
// to `__name__` ascending, so the 10,000 rows chosen were the first document IDs — arbitrary
// with respect to time. And settlements were excluded from the `truncated` flag entirely, so
// a short settlement total could be reported with `truncated: false`.
//
// ═══ WHAT HAPPENS NOW ═════════════════════════════════════════════════════════
// The date range is part of the QUERY, and results are read through a keyset cursor. This is
// the pattern RD-ANALYTICS-12-01 proved for the organizer reports, adapted for platform
// scope: there is deliberately NO `organizerUid` equality here, because an admin report is
// platform-wide by definition.
//
// ═══ MEMORY ═══════════════════════════════════════════════════════════════════
// This report is aggregate-only — five totals and a count. Every page is folded into running
// counters and discarded, so nothing accumulates and memory is O(page) at any volume. That
// is why no row cap is reused from the organizer side: there are no rows to cap.

/** One Firestore page. Matches the organizer builders' page size. */
const PAGE_SIZE = 1_000

/**
 * Documents EXAMINED before the walk stops and declares itself truncated.
 *
 * A WORK bound, not a correctness one: the date range is already applied by the query, so
 * this is only reached by a genuinely enormous window (or an unbounded request). When it is
 * reached the report says so — it must never look complete.
 */
const ADMIN_SCAN_CAP = 200_000

export interface AdminFinanceTotals {
  /** RD-FIN-02 · gross of SALES (captures) only — donation reversal rows are refunds, not sales. */
  gmvPaise: number; feesPaise: number; gstPaise: number
  /** Donation refunds actually processed (unchanged meaning). */
  refundsPaise: number; settlementsPaise: number
  transactionCount: number; truncated: boolean
  /** RD-FIN-02 · registration refunds ISSUED AT THE GATEWAY (every registrationRefunds record is one). */
  registrationRefundsPaise: number; registrationRefundCount: number
  /** Donation refunds approved but not yet paid — reported, never deducted. */
  donationRefundsPendingPaise: number
  /** Σ gross of donation reversal rows (negative) — kept out of GMV, shown for audit. */
  reversalGrossPaise: number
  /** GMV − registration refunds − donation refunds. */
  netGmvPaise: number
}

/**
 * A PLATFORM-WIDE date-scoped query. No `organizerUid` — that is the point of an admin report.
 *
 * The range is on the SAME field the query orders by, which is what lets Firestore serve
 * `platformTransactions` and `donationRefunds` from their automatic single-field indexes with
 * no composite declared. `settlementRequests` adds an equality on `status`, and therefore does
 * need one — see firestore.indexes.json (status ASC, paidAt DESC).
 */
function platformScoped(
  collection: string, dateField: string, f: ReportFilters,
  equalities: ReadonlyArray<readonly [string, string]> = [],
): Query {
  let q: Query = adminDb.collection(collection)
  for (const [field, value] of equalities) q = q.where(field, '==', value)

  // The same UTC day bounds this report has always used. `dayBoundDates` derives them from
  // `rangeBounds`, so this phase cannot have changed what a day means — that is deliberately
  // out of scope here.
  const { fromDate, toDate } = dayBoundDates(f.from, f.to)
  if (fromDate) q = q.where(dateField, '>=', fromDate)
  if (toDate)   q = q.where(dateField, '<=', toDate)

  return q.orderBy(dateField, 'desc')
}

/**
 * Fold every matching document into the caller's accumulator, retaining none of them.
 *
 * `startAfter` takes the last SNAPSHOT of the previous page, so ordering is deterministic and
 * no document can be skipped or counted twice; a short page ends the walk. `truncated` is true
 * only when the work bound was actually reached — paging through several pages is normal and
 * must not be reported as partial data.
 */
async function reducePlatform(
  collection: string, dateField: string, f: ReportFilters,
  equalities: ReadonlyArray<readonly [string, string]>,
  onDoc: (data: FirebaseFirestore.DocumentData) => void,
): Promise<{ truncated: boolean }> {
  const base = platformScoped(collection, dateField, f, equalities)
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined
  let scanned = 0

  for (;;) {
    const page = await (cursor ? base.startAfter(cursor) : base).limit(PAGE_SIZE).get()
    if (page.empty) return { truncated: false }

    for (const doc of page.docs) {
      onDoc(doc.data())
      if (++scanned >= ADMIN_SCAN_CAP) return { truncated: true }
    }

    if (page.size < PAGE_SIZE) return { truncated: false }
    cursor = page.docs[page.docs.length - 1]
  }
}

export async function computeAdminTotals(f: ReportFilters): Promise<AdminFinanceTotals> {
  let gmv = 0, fees = 0, gst = 0, count = 0, reversalGross = 0
  let refunds = 0, donationPending = 0
  let regRefunds = 0, regRefundCount = 0
  let settlements = 0

  const [txn, refundRead, regRefundRead, settleRead] = await Promise.all([
    reducePlatform('platformTransactions', 'paidAt', f, [], d => {
      const fig = readReportFromLedgerData(d)   // RD-PRICING-02F: snapshot-first (== ledger)
      fees += fig.platformFeeTotalPaise
      gst  += fig.platformFeeGstPaise
      // RD-FIN-02 · a donation reversal row (negative, parentTransactionId) is a REFUND, already
      // reported under "Refunds: donations" — counting it in GMV too deducted that refund twice.
      if (typeof d.parentTransactionId === 'string' && d.parentTransactionId) { reversalGross += fig.grossAmountPaise; return }
      gmv  += fig.grossAmountPaise
      count++
    }),
    reducePlatform('donationRefunds', 'createdAt', f, [], d => {
      if (d.status === 'processed') refunds += Number(d.amountPaise ?? 0)
      else if (d.status === 'pending') donationPending += Number(d.amountPaise ?? 0)   // approved, not yet paid
    }),
    // RD-FIN-02 · registration refunds were missing from this report. Every registrationRefunds record
    // is a refund that EXISTS at the gateway (its status only tracks RegisterDesk side effects, and
    // organizer-route records stay 'linked'), so no status filter; createdAt is the one universal date.
    reducePlatform('registrationRefunds', 'createdAt', f, [], d => {
      regRefunds += Number(d.amountPaise ?? 0); regRefundCount++
    }),
    /**
     * ═══ `paidAt` IS THE SETTLEMENT REPORTING DATE ═══════════════════════════
     * This read used to fall back to `paidAt ?? requestedAt`, which Firestore cannot express
     * in one query and which is not the right question anyway: the row reports money that
     * LEFT, and the date that money left is `paidAt`. `requestedAt` is when someone asked.
     *
     * A settlement with `status: 'paid'` and a null `paidAt` is anomalous data — the paid
     * transition writes `paidAt` in the same update that writes the status. Such a row is
     * excluded here rather than dated by its request, because substituting `requestedAt`
     * would silently place money in a period it did not move in. See RD-ANALYTICS-12-07.
     */
    reducePlatform('settlementRequests', 'paidAt', f, [['status', 'paid']], d => {
      /**
       * A null `paidAt` is excluded HERE as well as by the range, and the difference matters.
       *
       * Firestore's `orderBy` excludes documents where a field is ABSENT, but an explicit
       * `null` is a value: it is indexed, it sorts before every timestamp, and it comes back.
       * A date range hides it (null < any `from`), but an UNBOUNDED request has no range —
       * so without this line an all-time report counted the anomaly, which is exactly the
       * silent substitution this phase set out to remove. Proven by the emulator test.
       */
      if (d.paidAt == null) return
      settlements += Number(d.amountPaise ?? 0)
    }),
  ])

  return {
    gmvPaise: gmv, feesPaise: fees, gstPaise: gst,
    refundsPaise: refunds, settlementsPaise: settlements,
    transactionCount: count,
    registrationRefundsPaise: regRefunds, registrationRefundCount: regRefundCount,
    donationRefundsPendingPaise: donationPending,
    reversalGrossPaise: reversalGross,
    netGmvPaise: gmv - regRefunds - refunds,
    // Settlements now participate: previously a short settlement total could be published
    // with `truncated: false`, because only the other two reads were consulted.
    truncated: txn.truncated || refundRead.truncated || regRefundRead.truncated || settleRead.truncated,
  }
}

export async function buildAdminFinanceReport(f: ReportFilters): Promise<ReportTable> {
  const t = await computeAdminTotals(f)
  const rows: ReportRow[] = [
    { metric: 'GMV (gross captured)',                                    amount: t.gmvPaise },
    { metric: 'Platform Fees (incl. GST)',                               amount: t.feesPaise },
    { metric: 'GST Collected',                                           amount: t.gstPaise },
    { metric: 'Refunds: registrations (issued at gateway)',              amount: t.registrationRefundsPaise },
    { metric: 'Refunds: donations (processed)',                          amount: t.refundsPaise },
    { metric: 'Net GMV (after refunds)',                                 amount: t.netGmvPaise },
    { metric: 'Donation refunds pending (approved, not paid — not deducted)', amount: t.donationRefundsPendingPaise },
    { metric: 'Settlements Paid',                                        amount: t.settlementsPaise },
  ]
  return {
    id: 'admin-finance', title: 'Platform Finance Summary', truncated: t.truncated,
    columns: [
      { key: 'metric', label: 'Metric', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money', align: 'right' },
    ],
    rows,
    summary: [
      { label: 'Transactions in period', value: t.transactionCount, type: 'number' },
      { label: 'Registration refunds',   value: t.registrationRefundCount, type: 'number' },
    ],
    note: 'Aggregated from platform ledgers, refunds, and settlements. GMV counts captures by payment date; refunds are dated by when they were recorded, so a refund can fall in a later period than its sale.',
  }
}
