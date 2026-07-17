// Admin (platform-wide) report builder. Aggregates the SAME stored ledger fields
// the organizer reports use — no separate financial math. Revenue comes entirely
// from one-time transaction fees on the Event License model (no subscriptions/MRR).

import { adminDb } from '@/lib/firebase/admin'
import type { ReportTable, ReportFilters, ReportRow } from '@/lib/reports/types'
import { toMillis, rangeBounds } from '@/lib/reports/format'

const ADMIN_CAP = 10000

export interface AdminFinanceTotals {
  gmvPaise: number; feesPaise: number; gstPaise: number
  refundsPaise: number; settlementsPaise: number
  transactionCount: number; truncated: boolean
}

export async function computeAdminTotals(f: ReportFilters): Promise<AdminFinanceTotals> {
  const { fromMs, toMs } = rangeBounds(f.from, f.to)
  const inRange = (v: unknown) => { const ms = toMillis(v); return ms === 0 ? fromMs === 0 : ms >= fromMs && ms <= toMs }

  const [txnSnap, refundSnap, settleSnap] = await Promise.all([
    adminDb.collection('platformTransactions').orderBy('paidAt', 'desc').limit(ADMIN_CAP + 1).get(),
    adminDb.collection('donationRefunds').orderBy('createdAt', 'desc').limit(ADMIN_CAP + 1).get(),
    adminDb.collection('settlementRequests').where('status', '==', 'paid').limit(ADMIN_CAP).get(),
  ])

  const truncated = txnSnap.docs.length > ADMIN_CAP || refundSnap.docs.length > ADMIN_CAP

  let gmv = 0, fees = 0, gst = 0, count = 0
  for (const doc of txnSnap.docs.slice(0, ADMIN_CAP)) {
    const d = doc.data()
    if (!inRange(d.paidAt)) continue
    gmv  += Number(d.grossAmountPaise ?? 0)
    fees += Number(d.platformFeeTotalPaise ?? 0)
    gst  += Number(d.platformFeeGstPaise ?? 0)
    count++
  }

  let refunds = 0
  for (const doc of refundSnap.docs.slice(0, ADMIN_CAP)) {
    const d = doc.data()
    if (!inRange(d.createdAt)) continue
    if (d.status === 'processed') refunds += Number(d.amountPaise ?? 0)
  }

  let settlements = 0
  for (const doc of settleSnap.docs) {
    const d = doc.data()
    if (!inRange(d.paidAt ?? d.requestedAt)) continue
    settlements += Number(d.amountPaise ?? 0)
  }

  return {
    gmvPaise: gmv, feesPaise: fees, gstPaise: gst,
    refundsPaise: refunds, settlementsPaise: settlements,
    transactionCount: count, truncated,
  }
}

export async function buildAdminFinanceReport(f: ReportFilters): Promise<ReportTable> {
  const t = await computeAdminTotals(f)
  const rows: ReportRow[] = [
    { metric: 'GMV (Gross Merchandise Value)', amount: t.gmvPaise },
    { metric: 'Platform Fees (incl. GST)',     amount: t.feesPaise },
    { metric: 'GST Collected',                 amount: t.gstPaise },
    { metric: 'Refunds (processed)',           amount: t.refundsPaise },
    { metric: 'Settlements Paid',              amount: t.settlementsPaise },
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
    ],
    note: 'Aggregated from platform ledgers, refunds, and settlements.',
  }
}
