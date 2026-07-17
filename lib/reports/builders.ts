// Organizer report builders (Phase G.1). Every builder READS existing ledger
// collections and emits a normalized ReportTable. Money values are the STORED
// paise fields — fees/GST/net are never recomputed here (single source of truth
// is the write-time ledger). Date-range + event/campaign/status filtering is done
// in memory after an indexed (organizerUid, timeField) query, so no new composite
// indexes are required.

import { adminDb } from '@/lib/firebase/admin'
import type { Query } from 'firebase-admin/firestore'
import {
  type ReportTable, type ReportFilters, type ReportRow, type PayoutStatement,
  REPORT_ROW_CAP,
} from '@/lib/reports/types'
import { toMillis, toISO, rangeBounds } from '@/lib/reports/format'

// ─── Shared fetch: indexed (organizerUid, timeField) query, capped ─────────────
async function fetchCapped(
  collection: string, uid: string, timeField: string,
): Promise<{ docs: FirebaseFirestore.QueryDocumentSnapshot[]; truncated: boolean }> {
  const q: Query = adminDb.collection(collection)
    .where('organizerUid', '==', uid)
    .orderBy(timeField, 'desc')
    .limit(REPORT_ROW_CAP + 1)
  const snap = await q.get()
  const truncated = snap.docs.length > REPORT_ROW_CAP
  return { docs: truncated ? snap.docs.slice(0, REPORT_ROW_CAP) : snap.docs, truncated }
}

function inRange(v: unknown, fromMs: number, toMs: number): boolean {
  const ms = toMillis(v)
  if (ms === 0) return fromMs === 0   // undated rows included only when no lower bound
  return ms >= fromMs && ms <= toMs
}

const sum = (rows: ReportRow[], key: string): number =>
  rows.reduce((s, r) => s + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0)

// ═══ Transactions ════════════════════════════════════════════════════════════
export async function buildTransactions(uid: string, f: ReportFilters): Promise<ReportTable> {
  const { fromMs, toMs } = rangeBounds(f.from, f.to)
  const { docs, truncated } = await fetchCapped('platformTransactions', uid, 'paidAt')
  const rows: ReportRow[] = []
  for (const doc of docs) {
    const d = doc.data()
    if (!inRange(d.paidAt, fromMs, toMs)) continue
    if (f.event && d.entityId !== f.event) continue
    if (f.campaign && d.entityId !== f.campaign) continue
    if (f.status && d.status !== f.status) continue
    rows.push({
      paidAt:    toISO(d.paidAt),
      type:      String(d.type ?? ''),
      category:  String(d.category ?? ''),
      entity:    String(d.entityId ?? ''),
      payer:     String(d.payerName ?? ''),
      gross:     Number(d.grossAmountPaise ?? 0),
      fee:       Number(d.platformFeeTotalPaise ?? 0),
      gst:       Number(d.platformFeeGstPaise ?? 0),
      gateway:   Number(d.gatewayFeeEstimatePaise ?? 0),
      net:       Number(d.netSettlementPaise ?? 0),
      status:    String(d.status ?? ''),
    })
  }
  return {
    id: 'transactions', title: 'Transactions', truncated,
    columns: [
      { key: 'paidAt', label: 'Date', type: 'date' },
      { key: 'type', label: 'Type', type: 'text' },
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'entity', label: 'Event / Campaign', type: 'text' },
      { key: 'payer', label: 'Payer', type: 'text' },
      { key: 'gross', label: 'Gross', type: 'money', align: 'right' },
      { key: 'fee', label: 'Platform Fee', type: 'money', align: 'right' },
      { key: 'gst', label: 'GST', type: 'money', align: 'right' },
      { key: 'gateway', label: 'Gateway Fee', type: 'money', align: 'right' },
      { key: 'net', label: 'Net', type: 'money', align: 'right' },
      { key: 'status', label: 'Status', type: 'text' },
    ],
    rows,
    summary: [
      { label: 'Gross Total', value: sum(rows, 'gross'), type: 'money' },
      { label: 'Platform Fees', value: sum(rows, 'fee'), type: 'money' },
      { label: 'GST', value: sum(rows, 'gst'), type: 'money' },
      { label: 'Net Settlement', value: sum(rows, 'net'), type: 'money' },
      { label: 'Transactions', value: rows.length, type: 'number' },
    ],
  }
}

// ═══ Settlements ═════════════════════════════════════════════════════════════
export async function buildSettlements(uid: string, f: ReportFilters): Promise<ReportTable> {
  const { fromMs, toMs } = rangeBounds(f.from, f.to)
  const { docs, truncated } = await fetchCapped('settlementRequests', uid, 'requestedAt')
  const rows: ReportRow[] = []
  for (const doc of docs) {
    const d = doc.data()
    if (!inRange(d.requestedAt, fromMs, toMs)) continue
    if (f.status && d.status !== f.status) continue
    rows.push({
      requestedAt: toISO(d.requestedAt),
      amount:      Number(d.amountPaise ?? 0),
      status:      String(d.status ?? ''),
      approvedAt:  toISO(d.approvedAt),
      paidAt:      toISO(d.paidAt),
      utr:         String(d.utrNumber ?? ''),
      bankRef:     String(d.bankReference ?? ''),
    })
  }
  const paid = rows.filter(r => r.status === 'paid')
  return {
    id: 'settlements', title: 'Settlements', truncated,
    columns: [
      { key: 'requestedAt', label: 'Requested', type: 'date' },
      { key: 'amount', label: 'Amount', type: 'money', align: 'right' },
      { key: 'status', label: 'Status', type: 'text' },
      { key: 'approvedAt', label: 'Approved', type: 'date' },
      { key: 'paidAt', label: 'Paid', type: 'date' },
      { key: 'utr', label: 'UTR', type: 'text' },
      { key: 'bankRef', label: 'Bank Reference', type: 'text' },
    ],
    rows,
    summary: [
      { label: 'Total Requested', value: sum(rows, 'amount'), type: 'money' },
      { label: 'Total Paid', value: sum(paid, 'amount'), type: 'money' },
      { label: 'Requests', value: rows.length, type: 'number' },
    ],
  }
}

// ═══ Wallet Ledger ═══════════════════════════════════════════════════════════
export async function buildWalletLedger(uid: string, f: ReportFilters): Promise<ReportTable> {
  const { fromMs, toMs } = rangeBounds(f.from, f.to)
  const { docs, truncated } = await fetchCapped('walletTransactions', uid, 'createdAt')
  const rows: ReportRow[] = []
  for (const doc of docs) {
    const d = doc.data()
    if (!inRange(d.createdAt, fromMs, toMs)) continue
    if (f.status && d.status !== f.status) continue
    rows.push({
      createdAt:   toISO(d.createdAt),
      type:        String(d.type ?? ''),
      description: String(d.description ?? ''),
      refType:     String(d.referenceType ?? ''),
      amount:      Number(d.amountPaise ?? 0),
      balance:     Number(d.balancePaise ?? 0),
      status:      String(d.status ?? ''),
    })
  }
  const CREDIT_TYPES = new Set(['fund_added', 'refund', 'adjustment'])
  const credits = rows.filter(r => typeof r.type === 'string' && CREDIT_TYPES.has(r.type))
  const debits  = rows.filter(r => typeof r.type === 'string' && !CREDIT_TYPES.has(r.type))
  return {
    id: 'wallet-ledger', title: 'Wallet Ledger', truncated,
    columns: [
      { key: 'createdAt', label: 'Date', type: 'date' },
      { key: 'type', label: 'Type', type: 'text' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'refType', label: 'Source', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money', align: 'right' },
      { key: 'balance', label: 'Balance After', type: 'money', align: 'right' },
      { key: 'status', label: 'Status', type: 'text' },
    ],
    rows,
    summary: [
      { label: 'Credited (funds/refunds/adj.)', value: sum(credits, 'amount'), type: 'money' },
      { label: 'Debited (charges)', value: sum(debits, 'amount'), type: 'money' },
      { label: 'Entries', value: rows.length, type: 'number' },
    ],
  }
}

// ═══ Donations (PAN joined from receipts) ════════════════════════════════════
export async function buildDonations(uid: string, f: ReportFilters): Promise<ReportTable> {
  const { fromMs, toMs } = rangeBounds(f.from, f.to)
  const { docs, truncated } = await fetchCapped('donations', uid, 'createdAt')

  interface Raw { receiptId: string; receiptNumber: string; date: string | null; donor: string; campaign: string; amount: number; refunded: number; status: string }
  const raw: Raw[] = []
  for (const doc of docs) {
    const d = doc.data()
    if (!inRange(d.createdAt, fromMs, toMs)) continue
    if (f.campaign && d.campaignSlug !== f.campaign) continue
    if (f.status && d.status !== f.status) continue
    raw.push({
      receiptId:     String(d.receiptId ?? ''),
      receiptNumber: String(d.receiptNumber ?? ''),
      date:          toISO(d.paidAt ?? d.createdAt),
      donor:         d.isAnonymous ? 'Anonymous' : String(d.donorName ?? ''),
      campaign:      String(d.campaignSlug ?? ''),
      amount:        Number(d.amountPaise ?? 0),
      refunded:      Number(d.refundedAmountPaise ?? 0),
      status:        String(d.status ?? ''),
    })
  }

  // PAN comes from donationReceipts.donorPan — batch fetch by receiptId.
  const panById = new Map<string, string>()
  const ids = [...new Set(raw.map(r => r.receiptId).filter(Boolean))]
  for (let i = 0; i < ids.length; i += 300) {
    const refs = ids.slice(i, i + 300).map(id => adminDb.collection('donationReceipts').doc(id))
    const snaps = await adminDb.getAll(...refs)
    for (const s of snaps) {
      if (s.exists) { const pan = (s.data() as { donorPan?: string }).donorPan; if (pan) panById.set(s.id, pan) }
    }
  }

  const rows: ReportRow[] = raw.map(r => ({
    receiptNumber: r.receiptNumber || '—',
    date: r.date, donor: r.donor,
    pan: panById.get(r.receiptId) ?? '—',
    campaign: r.campaign, amount: r.amount, refunded: r.refunded, status: r.status,
  }))

  return {
    id: 'donations', title: 'Donations', truncated,
    columns: [
      { key: 'receiptNumber', label: 'Receipt #', type: 'text' },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'donor', label: 'Donor', type: 'text' },
      { key: 'pan', label: 'PAN', type: 'text' },
      { key: 'campaign', label: 'Campaign', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money', align: 'right' },
      { key: 'refunded', label: 'Refunded', type: 'money', align: 'right' },
      { key: 'status', label: 'Status', type: 'text' },
    ],
    rows,
    summary: [
      { label: 'Total Donated', value: sum(rows, 'amount'), type: 'money' },
      { label: 'Total Refunded', value: sum(rows, 'refunded'), type: 'money' },
      { label: 'Donations', value: rows.length, type: 'number' },
    ],
  }
}

// ═══ Refunds ═════════════════════════════════════════════════════════════════
export async function buildRefunds(uid: string, f: ReportFilters): Promise<ReportTable> {
  const { fromMs, toMs } = rangeBounds(f.from, f.to)
  const { docs, truncated } = await fetchCapped('donationRefunds', uid, 'createdAt')
  const rows: ReportRow[] = []
  for (const doc of docs) {
    const d = doc.data()
    if (!inRange(d.createdAt, fromMs, toMs)) continue
    if (f.campaign && d.campaignSlug !== f.campaign) continue
    if (f.status && d.status !== f.status) continue
    rows.push({
      createdAt:   toISO(d.createdAt),
      donationId:  String(d.donationId ?? ''),
      campaign:    String(d.campaignSlug ?? ''),
      amount:      Number(d.amountPaise ?? 0),
      reason:      String(d.reason ?? ''),
      status:      String(d.status ?? ''),
      processedAt: toISO(d.processedAt),
    })
  }
  const processed = rows.filter(r => r.status === 'processed')
  return {
    id: 'refunds', title: 'Refunds', truncated,
    columns: [
      { key: 'createdAt', label: 'Date', type: 'date' },
      { key: 'donationId', label: 'Donation ID', type: 'text' },
      { key: 'campaign', label: 'Campaign', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money', align: 'right' },
      { key: 'reason', label: 'Reason', type: 'text' },
      { key: 'status', label: 'Status', type: 'text' },
      { key: 'processedAt', label: 'Processed', type: 'date' },
    ],
    rows,
    summary: [
      { label: 'Total Refunded (processed)', value: sum(processed, 'amount'), type: 'money' },
      { label: 'Refunds', value: rows.length, type: 'number' },
    ],
  }
}

// ═══ Broadcast Usage ═════════════════════════════════════════════════════════
export async function buildBroadcastUsage(uid: string, f: ReportFilters): Promise<ReportTable> {
  const { fromMs, toMs } = rangeBounds(f.from, f.to)
  const { docs, truncated } = await fetchCapped('broadcastCampaigns', uid, 'createdAt')
  const rows: ReportRow[] = []
  for (const doc of docs) {
    const d = doc.data()
    if (!inRange(d.createdAt, fromMs, toMs)) continue
    if (f.event && d.eventSlug !== f.event) continue
    if (f.status && d.status !== f.status) continue
    rows.push({
      createdAt:   toISO(d.createdAt),
      event:       String(d.eventName ?? d.eventSlug ?? ''),
      channel:     String(d.channel ?? ''),
      audience:    String(d.audience ?? ''),
      recipients:  Number(d.recipientCount ?? 0),
      delivered:   Number(d.successCount ?? 0),
      failed:      Number(d.failCount ?? 0),
      cost:        Number(d.actualCostPaise ?? 0),
      status:      String(d.status ?? ''),
    })
  }
  return {
    id: 'broadcast-usage', title: 'Broadcast Usage', truncated,
    columns: [
      { key: 'createdAt', label: 'Date', type: 'date' },
      { key: 'event', label: 'Event', type: 'text' },
      { key: 'channel', label: 'Channel', type: 'text' },
      { key: 'audience', label: 'Audience', type: 'text' },
      { key: 'recipients', label: 'Recipients', type: 'number', align: 'right' },
      { key: 'delivered', label: 'Delivered', type: 'number', align: 'right' },
      { key: 'failed', label: 'Failed', type: 'number', align: 'right' },
      { key: 'cost', label: 'Cost', type: 'money', align: 'right' },
      { key: 'status', label: 'Status', type: 'text' },
    ],
    rows,
    summary: [
      { label: 'Total Recipients', value: sum(rows, 'recipients'), type: 'number' },
      { label: 'Total Delivered', value: sum(rows, 'delivered'), type: 'number' },
      { label: 'Total Cost', value: sum(rows, 'cost'), type: 'money' },
      { label: 'Campaigns', value: rows.length, type: 'number' },
    ],
  }
}

// ═══ GST Report (monthly aggregation of stored fee fields) ════════════════════
export async function buildGst(uid: string, f: ReportFilters): Promise<ReportTable> {
  const { fromMs, toMs } = rangeBounds(f.from, f.to)
  const { docs, truncated } = await fetchCapped('platformTransactions', uid, 'paidAt')
  const buckets = new Map<string, { taxable: number; gst: number; count: number }>()
  for (const doc of docs) {
    const d = doc.data()
    if (!inRange(d.paidAt, fromMs, toMs)) continue
    if (f.status && d.status !== f.status) continue
    const iso = toISO(d.paidAt)
    const month = iso ? iso.slice(0, 7) : 'undated'
    const b = buckets.get(month) ?? { taxable: 0, gst: 0, count: 0 }
    b.taxable += Number(d.platformFeeBasePaise ?? 0)
    b.gst     += Number(d.platformFeeGstPaise ?? 0)
    b.count   += 1
    buckets.set(month, b)
  }
  const rows: ReportRow[] = [...buckets.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, b]) => ({
    month, taxable: b.taxable, gst: b.gst, invoices: b.count,
  }))
  return {
    id: 'gst', title: 'GST Summary', truncated,
    columns: [
      { key: 'month', label: 'Month', type: 'text' },
      { key: 'taxable', label: 'Taxable Value', type: 'money', align: 'right' },
      { key: 'gst', label: 'GST Amount', type: 'money', align: 'right' },
      { key: 'invoices', label: 'Invoice Count', type: 'number', align: 'right' },
    ],
    rows,
    summary: [
      { label: 'Total Taxable Value', value: sum(rows, 'taxable'), type: 'money' },
      { label: 'Total GST', value: sum(rows, 'gst'), type: 'money' },
      { label: 'Total Invoices', value: sum(rows, 'invoices'), type: 'number' },
    ],
  }
}

// ═══ Payout Statement (aggregate for PDF) ════════════════════════════════════
export async function buildPayoutStatement(uid: string, f: ReportFilters): Promise<PayoutStatement> {
  const { fromMs, toMs } = rangeBounds(f.from, f.to)

  const [txn, refundsSnap, settleSnap, userSnap] = await Promise.all([
    fetchCapped('platformTransactions', uid, 'paidAt'),
    fetchCapped('donationRefunds', uid, 'createdAt'),
    fetchCapped('settlementRequests', uid, 'requestedAt'),
    adminDb.doc(`users/${uid}`).get(),
  ])

  let gross = 0, feesBase = 0, gst = 0, gateway = 0, count = 0
  for (const doc of txn.docs) {
    const d = doc.data()
    if (!inRange(d.paidAt, fromMs, toMs)) continue
    gross    += Number(d.grossAmountPaise ?? 0)
    feesBase += Number(d.platformFeeBasePaise ?? 0)
    gst      += Number(d.platformFeeGstPaise ?? 0)
    gateway  += Number(d.gatewayFeeEstimatePaise ?? 0)
    count++
  }

  let refunds = 0
  for (const doc of refundsSnap.docs) {
    const d = doc.data()
    if (!inRange(d.createdAt, fromMs, toMs)) continue
    if (d.status === 'processed') refunds += Number(d.amountPaise ?? 0)
  }

  // Settlement reference/date: most recent PAID settlement within the period.
  let settlementReference: string | null = null
  let settlementDate: string | null = null
  let bestMs = 0
  for (const doc of settleSnap.docs) {
    const d = doc.data()
    if (d.status !== 'paid') continue
    if (!inRange(d.paidAt ?? d.requestedAt, fromMs, toMs)) continue
    const ms = toMillis(d.paidAt ?? d.requestedAt)
    if (ms >= bestMs) {
      bestMs = ms
      settlementReference = String(d.utrNumber ?? d.bankReference ?? '') || null
      settlementDate = toISO(d.paidAt)
    }
  }

  const platformFees = feesBase + gateway  // all fees ex-GST
  const net = gross - platformFees - gst - refunds
  const u = userSnap.data() as { name?: string; organizationName?: string; email?: string } | undefined

  // GA-8 P1-2: if ANY source hit the row cap, the totals are computed from a partial
  // set — disclose it rather than presenting an authoritative-but-incomplete figure.
  const truncated = txn.truncated || refundsSnap.truncated || settleSnap.truncated

  return {
    organizerName:       u?.organizationName || u?.name || u?.email || 'Organizer',
    period:              { from: f.from ?? null, to: f.to ?? null },
    settlementReference, settlementDate,
    grossRevenuePaise:   gross,
    platformFeesPaise:   platformFees,
    gstPaise:            gst,
    refundsPaise:        refunds,
    netSettlementPaise:  net,
    transactionCount:    count,
    truncated,
  }
}
