// Organizer report builders (Phase G.1). Every builder READS existing ledger
// collections and emits a normalized ReportTable. Money values are the STORED
// paise fields — fees/GST/net are never recomputed here (single source of truth
// is the write-time ledger). Date-range + event/campaign/status filtering is done
// in memory after an indexed (organizerUid, timeField) query, so no new composite
// indexes are required.

import { adminDb } from '@/lib/firebase/admin'
import { listOrganizerRefunds } from '@/lib/refunds/registrationRefunds'
import type { Query } from 'firebase-admin/firestore'
import {
  type ReportTable, type ReportFilters, type ReportRow, type PayoutStatement,
  REPORT_ROW_CAP,
} from '@/lib/reports/types'
import { toMillis, toISO, rangeBounds, dayBoundDates } from '@/lib/reports/format'
import { readReportFromLedgerData } from '@/lib/platform/pricing'

// ═══ RD-ANALYTICS-12-01 · QUERY-SCOPED, CURSOR-PAGINATED READS ════════════════
//
// ─── WHAT WAS WRONG ───────────────────────────────────────────────────────────
// The previous `fetchCapped` read the newest REPORT_ROW_CAP rows in the WORKSPACE and the
// builders then applied `from`/`to` in memory:
//
//     .where('organizerUid','==',uid).orderBy(timeField,'desc').limit(CAP + 1)
//     … for (doc of docs) if (!inRange(d[timeField], fromMs, toMs)) continue
//
// Above CAP rows that does not return a truncated answer, it returns a WRONG one: the rows
// for the requested period were never fetched, so a report for any earlier period comes back
// empty or short while presenting as authoritative. It set `truncated: true`, which reads as
// "here is the first part of your answer" rather than "your period was never queried" — and
// `gst` and `payout-statement` are used for tax filing and organizer payouts.
//
// ─── WHAT HAPPENS NOW ─────────────────────────────────────────────────────────
// The date range is part of the QUERY, so out-of-range documents never reach a builder, and
// results are read through a keyset cursor rather than one capped page — the pattern
// app/api/organizer/events/[eventId]/registrations/export already proves.
//
// ─── WHY THIS NEEDS NO NEW INDEX ──────────────────────────────────────────────
// The range filter is on the SAME field the query already orders by, so
// (organizerUid ASC, timeField DESC) — which every one of these collections already has —
// serves it unchanged. Firestore requires an extra index only for a range on a field other
// than the ordered one. Verified against firestore.indexes.json for all six collections.
//
// ─── THE TWO BOUNDS THAT REMAIN, AND WHY THEY ARE HONEST ──────────────────────
// `maxRows`  — how many matching rows are RETAINED. Row-listing reports keep this so a
//              50,000-row period cannot be pulled into memory at once. Aggregating reports
//              (GST, payout statement) pass Infinity: they fold each page into counters and
//              retain nothing, so they are complete at any size.
// `SCAN_CAP` — how many documents are EXAMINED. It bounds the work when a filter the query
//              cannot express (see below) forces a scan of the period.
//
// Either bound being reached sets `truncated`, and it now means what it says.
//
// ─── WHAT IS STILL FILTERED IN MEMORY, AND WHY ────────────────────────────────
// `event` on transactions/refunds and `status` everywhere: pushing those into the query
// needs composite indexes that do not exist and CANNOT BE DEPLOYED in this phase (e.g.
// platformTransactions needs (organizerUid, entityId, paidAt DESC); the existing
// (organizerUid, entityId, paidAt ASC, …) index does not serve it). They are applied to a
// COMPLETE, correctly date-scoped set instead of to an arbitrary newest-CAP window, which is
// the defect this phase exists to remove. Where an index does exist the filter IS pushed
// down — see `buildBroadcastUsage` (eventSlug) and `buildDonations` (campaignSlug).

/** One Firestore page. Small enough to stay well inside a request, large enough to be few. */
const PAGE_SIZE = 1_000

/**
 * Documents EXAMINED per report before the read stops and declares itself truncated.
 *
 * Only reachable when an in-memory filter above makes the matched set much smaller than the
 * scanned set. Sized to the §10 requirement that 50,000 records behave safely.
 */
export const REPORT_SCAN_CAP = 50_000

interface ScopedRead {
  docs:      FirebaseFirestore.QueryDocumentSnapshot[]
  truncated: boolean
}

/** The query every read below starts from: workspace + optional equalities + date range. */
function scopedQuery(
  collection: string, uid: string, timeField: string, f: ReportFilters,
  equalities: ReadonlyArray<readonly [string, string]> = [],
): Query {
  let q: Query = adminDb.collection(collection).where('organizerUid', '==', uid)
  for (const [field, value] of equalities) q = q.where(field, '==', value)

  // Same UTC day bounds as before — dayBoundDates derives them from rangeBounds itself, so
  // this phase cannot have changed what a day means.
  const { fromDate, toDate } = dayBoundDates(f.from, f.to)
  if (fromDate) q = q.where(timeField, '>=', fromDate)
  if (toDate)   q = q.where(timeField, '<=', toDate)

  return q.orderBy(timeField, 'desc')
}

/**
 * Walk a scoped query through a keyset cursor, newest first.
 *
 * `keep` decides what is retained, so a caller that only aggregates retains nothing. Ordering
 * is deterministic and `startAfter` takes the last SNAPSHOT of the previous page, so no
 * document can be skipped or seen twice, and a short page ends the walk.
 */
async function walkScoped(
  base: Query,
  maxRows: number,
  onDoc: (doc: FirebaseFirestore.QueryDocumentSnapshot) => 'kept' | 'skipped',
): Promise<{ kept: number; truncated: boolean }> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined
  let scanned = 0
  let kept    = 0

  for (;;) {
    const page = await (cursor ? base.startAfter(cursor) : base).limit(PAGE_SIZE).get()
    if (page.empty) return { kept, truncated: false }

    for (const doc of page.docs) {
      scanned++
      if (onDoc(doc) === 'kept') {
        kept++
        if (kept >= maxRows) return { kept, truncated: true }
      }
      if (scanned >= REPORT_SCAN_CAP) return { kept, truncated: true }
    }

    // A short page is the end of the result set — never issue another round trip for it.
    if (page.size < PAGE_SIZE) return { kept, truncated: false }
    cursor = page.docs[page.docs.length - 1]
  }
}

/**
 * Collect the rows a row-listing report needs, date-scoped and cursor-paged.
 *
 * Replaces `fetchCapped`. The returned documents are exactly the ones inside the requested
 * period; `truncated` is true only when a real bound was reached.
 */
async function fetchScoped(
  collection: string, uid: string, timeField: string, f: ReportFilters,
  equalities: ReadonlyArray<readonly [string, string]> = [],
): Promise<ScopedRead> {
  const docs: FirebaseFirestore.QueryDocumentSnapshot[] = []
  const { truncated } = await walkScoped(
    scopedQuery(collection, uid, timeField, f, equalities),
    REPORT_ROW_CAP,
    doc => { docs.push(doc); return 'kept' },
  )
  return { docs, truncated }
}

/**
 * Fold every matching document into the caller's accumulator without retaining any of them.
 *
 * This is what lets GST and the payout statement be COMPLETE rather than capped: they emit
 * per-month buckets and running totals, so the number of source documents never bounds them.
 */
async function reduceScoped(
  collection: string, uid: string, timeField: string, f: ReportFilters,
  onDoc: (data: FirebaseFirestore.DocumentData) => void,
): Promise<{ truncated: boolean }> {
  const { truncated } = await walkScoped(
    scopedQuery(collection, uid, timeField, f),
    Number.POSITIVE_INFINITY,
    doc => { onDoc(doc.data()); return 'kept' },
  )
  return { truncated }
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
  // The date range is now enforced by the query; `event`/`campaign`/`status` still are not,
  // for want of a deployable index — see the header note.
  const { docs, truncated } = await fetchScoped('platformTransactions', uid, 'paidAt', f)
  const rows: ReportRow[] = []
  for (const doc of docs) {
    const d = doc.data()
    if (f.event && d.entityId !== f.event) continue
    if (f.campaign && d.entityId !== f.campaign) continue
    if (f.status && d.status !== f.status) continue
    const fig = readReportFromLedgerData(d)   // RD-PRICING-02F: snapshot-first (== ledger)
    rows.push({
      paidAt:    toISO(d.paidAt),
      type:      String(d.type ?? ''),
      category:  String(d.category ?? ''),
      entity:    String(d.entityId ?? ''),
      payer:     String(d.payerName ?? ''),
      gross:     fig.grossAmountPaise,
      fee:       fig.platformFeeTotalPaise,
      gst:       fig.platformFeeGstPaise,
      gateway:   fig.gatewayFeeEstimatePaise,
      net:       fig.netSettlementPaise,
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
  const { docs, truncated } = await fetchScoped('settlementRequests', uid, 'requestedAt', f)
  const rows: ReportRow[] = []
  for (const doc of docs) {
    const d = doc.data()
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
  const { docs, truncated } = await fetchScoped('walletTransactions', uid, 'createdAt', f)
  const rows: ReportRow[] = []
  for (const doc of docs) {
    const d = doc.data()
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
  // `campaignSlug` IS pushed into the query: firestore.indexes.json already carries
  // (organizerUid ASC, campaignSlug ASC, createdAt DESC), so no new index is needed and a
  // single campaign's donations are never diluted by the rest of the workspace.
  const { docs, truncated } = await fetchScoped(
    'donations', uid, 'createdAt', f,
    f.campaign ? [['campaignSlug', f.campaign]] : [],
  )

  interface Raw { receiptId: string; receiptNumber: string; date: string | null; donor: string; campaign: string; amount: number; refunded: number; status: string }
  const raw: Raw[] = []
  for (const doc of docs) {
    const d = doc.data()
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
/**
 * Every refund this organizer issued, from BOTH ledgers.
 *
 * ═══ WHY TWO SOURCES ═════════════════════════════════════════════════════════
 * This report predates registration refunds and read `donationRefunds` alone, so a
 * report titled "Refunds" showed nothing for an event that had refunded real money.
 * Registration refunds now come from the same canonical reader the finance dashboard
 * uses, which is what keeps the two surfaces from disagreeing.
 *
 * ═══ UNATTRIBUTED REFUNDS ARE SHOWN, NOT INVENTED ════════════════════════════
 * A refund that never resolved to a registration still moved money and still appears,
 * with its Registration column blank and its attribution stated. No registration id is
 * manufactured to fill the gap.
 */
export async function buildRefunds(uid: string, f: ReportFilters): Promise<ReportTable> {
  // `listOrganizerRefunds` is the canonical registration-refund reader and is deliberately
  // left exactly as it was — this phase changes retrieval scope, not financial sources. Its
  // own `complete` flag still contributes to `truncated` below.
  const { fromMs, toMs } = rangeBounds(f.from, f.to)
  const [donation, registration] = await Promise.all([
    fetchScoped('donationRefunds', uid, 'createdAt', f),
    listOrganizerRefunds(uid, { eventSlug: f.event ?? null }),
  ])

  const rows: ReportRow[] = []

  for (const doc of donation.docs) {
    const d = doc.data()
    if (f.event) continue                       // a donation refund belongs to no event
    if (f.campaign && d.campaignSlug !== f.campaign) continue
    if (f.status && d.status !== f.status) continue
    rows.push({
      source:      'Donation',
      createdAt:   toISO(d.createdAt),
      refundId:    String(d.refundId ?? doc.id ?? ''),
      paymentId:   String(d.razorpayPaymentId ?? ''),
      reference:   String(d.donationId ?? ''),
      entity:      String(d.campaignSlug ?? ''),
      amount:      Number(d.amountPaise ?? 0),
      status:      String(d.status ?? ''),
      attribution: 'Donation',
    })
  }

  for (const r of registration.records) {
    if (!inRange(r.createdAt, fromMs, toMs)) continue
    if (f.campaign) continue                    // a registration refund belongs to no campaign
    if (f.status && r.status !== f.status) continue
    rows.push({
      source:      'Registration',
      createdAt:   toISO(r.createdAt),
      refundId:    String(r.razorpayRefundId || r.id || ''),
      paymentId:   String(r.gatewayPaymentId ?? ''),
      reference:   String(r.registrationId ?? ''),
      entity:      String(r.eventSlug ?? ''),
      amount:      Number(r.amountPaise ?? 0),
      status:      String(r.status),
      // Stated, never guessed: an unlinked refund says so rather than borrowing an id.
      // RD-REFUND-MANUAL-01 — returned outside the gateway; the transfer reference is the evidence.
      attribution: r.origin === 'manual' ? `Manual refund (outside the gateway) · ref ${String(r.metadata?.reference ?? '')}`
        : r.registrationId ? 'Linked to registration'
        : r.organizerUid ? 'No registration linked'
        : 'Unattributed — matched via payment intent',
    })
  }

  rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))

  const processed = rows.filter(r => r.status === 'processed')
  const regRows   = rows.filter(r => r.source === 'Registration')
  const donRows   = rows.filter(r => r.source === 'Donation')
  return {
    id: 'refunds', title: 'Refunds', truncated: donation.truncated || !registration.complete,
    columns: [
      { key: 'createdAt', label: 'Date', type: 'date' },
      { key: 'source', label: 'Source', type: 'text' },
      { key: 'refundId', label: 'Refund ID', type: 'text' },
      { key: 'paymentId', label: 'Payment ID', type: 'text' },
      { key: 'reference', label: 'Registration / Donation', type: 'text' },
      { key: 'entity', label: 'Event / Campaign', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money', align: 'right' },
      { key: 'status', label: 'Status', type: 'text' },
      { key: 'attribution', label: 'Attribution', type: 'text' },
    ],
    rows,
    summary: [
      { label: 'Total Refunded (processed)', value: sum(processed, 'amount'), type: 'money' },
      { label: 'Registration Refunds', value: sum(regRows, 'amount'), type: 'money' },
      { label: 'Donation Refunds', value: sum(donRows, 'amount'), type: 'money' },
      { label: 'Refunds', value: rows.length, type: 'number' },
    ],
  }
}

// ═══ Broadcast Usage ═════════════════════════════════════════════════════════
export async function buildBroadcastUsage(uid: string, f: ReportFilters): Promise<ReportTable> {
  // `eventSlug` IS pushed into the query: firestore.indexes.json already carries
  // (organizerUid ASC, eventSlug ASC, createdAt DESC).
  const { docs, truncated } = await fetchScoped(
    'broadcastCampaigns', uid, 'createdAt', f,
    f.event ? [['eventSlug', f.event]] : [],
  )
  const rows: ReportRow[] = []
  for (const doc of docs) {
    const d = doc.data()
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
  // AGGREGATION, not a row list: each transaction folds into a per-month bucket and is then
  // discarded, so this report retains a handful of buckets no matter how many transactions
  // the period holds. It is therefore COMPLETE at any scale rather than capped — which
  // matters more here than anywhere else, because a short GST summary is a filing error.
  const buckets = new Map<string, { taxable: number; gst: number; count: number }>()
  const { truncated } = await reduceScoped('platformTransactions', uid, 'paidAt', f, d => {
    if (f.status && d.status !== f.status) return
    const iso = toISO(d.paidAt)
    const month = iso ? iso.slice(0, 7) : 'undated'
    const b = buckets.get(month) ?? { taxable: 0, gst: 0, count: 0 }
    const fig = readReportFromLedgerData(d)   // RD-PRICING-02F: snapshot-first (== ledger)
    b.taxable += fig.platformFeeBasePaise
    b.gst     += fig.platformFeeGstPaise
    b.count   += 1
    buckets.set(month, b)
  })
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

  let gross = 0, feesBase = 0, gst = 0, count = 0
  let gatewayResolved = 0, gatewayActual = 0, gatewayEstimate = 0, gatewayTax = 0, actualRows = 0
  // The payable is READ, not derived. See PayoutStatement.netSettlementPaise.
  let net = 0

  // Three pure aggregations — every source is folded into counters and discarded, so the
  // statement covers the WHOLE period at any transaction volume. Each fee term is still the
  // stored ledger value resolved by readReportFromLedgerData; nothing is recomputed here.
  let donationRefunds = 0
  // Settlement reference/date: most recent PAID settlement within the period.
  let settlementReference: string | null = null
  let settlementDate: string | null = null
  let bestMs = 0

  const [txn, refundsSnap, settleSnap, userSnap] = await Promise.all([
    reduceScoped('platformTransactions', uid, 'paidAt', f, d => {
      const fig = readReportFromLedgerData(d)   // RD-PRICING-02F: snapshot-first (== ledger)
      // RD-REFUND-MANUAL-01 — a manual registration refund's reversal row is a REFUND (listed in refundsPaise via
      // the canonical refund read), not a sale: it reduces the payable, never gross — exactly as a gateway refund
      // leaves gross untouched.
      if (typeof d.parentTransactionId === 'string' && d.parentTransactionId && d.refundMethod === 'manual') { net += fig.netSettlementPaise; return }
      gross    += fig.grossAmountPaise
      feesBase += fig.platformFeeBasePaise
      gst      += fig.platformFeeGstPaise
      net      += fig.netSettlementPaise
      gatewayEstimate += fig.gatewayFeeEstimatePaise
      gatewayResolved += fig.gatewayFeePaise        // actual ?? estimate, per transaction
      if (fig.gatewayFeeActualPaise !== null) {
        actualRows++
        gatewayActual += fig.gatewayFeeActualPaise
        gatewayTax    += fig.gatewayTaxPaise ?? 0
      }
      count++
    }),
    reduceScoped('donationRefunds', uid, 'createdAt', f, d => {
      if (d.status === 'processed') donationRefunds += Number(d.amountPaise ?? 0)
    }),
    reduceScoped('settlementRequests', uid, 'requestedAt', f, d => {
      if (d.status !== 'paid') return
      // `paidAt` may fall outside a period the REQUEST fell inside, so this one boundary
      // stays in memory — the query scopes on requestedAt, which is what it orders by.
      if (!inRange(d.paidAt ?? d.requestedAt, fromMs, toMs)) return
      const ms = toMillis(d.paidAt ?? d.requestedAt)
      if (ms >= bestMs) {
        bestMs = ms
        settlementReference = String(d.utrNumber ?? d.bankReference ?? '') || null
        settlementDate = toISO(d.paidAt)
      }
    }),
    adminDb.doc(`users/${uid}`).get(),
  ])

  // `mixed` is a real state, not a hedge: reconciled rows and unreconciled ones coexist
  // while actual fees arrive on new payments. Rounding it to either neighbour would
  // relabel estimated money as settled, or discard facts already held.
  const gatewayFeeBasis: 'actual' | 'estimated' | 'mixed' =
    count === 0 || actualRows === 0 ? 'estimated' : actualRows === count ? 'actual' : 'mixed'

  // Registration refunds come from the SAME canonical reader the finance dashboard uses,
  // so a refund can never be visible on one surface and missing from the other. It
  // includes refunds that carry no organizer attribution of their own — real money out,
  // which a strict organizerUid filter would silently drop.
  const regRefundRead = await listOrganizerRefunds(uid)
  let registrationRefunds = 0, registrationRefundCount = 0
  for (const r of regRefundRead.records) {
    if (!inRange(r.createdAt, fromMs, toMs)) continue
    registrationRefunds += Number(r.amountPaise ?? 0)
    registrationRefundCount++
  }
  const refunds = donationRefunds + registrationRefunds

  const platformFeeTotal = feesBase + gst          // RegisterDesk only — no gateway term
  const totalFees        = platformFeeTotal + gatewayResolved
  const u = userSnap.data() as { name?: string; organizationName?: string; email?: string } | undefined

  // GA-8 P1-2: if ANY source was bounded, the totals are computed from a partial set —
  // disclose it rather than presenting an authoritative-but-incomplete figure.
  //
  // RD-ANALYTICS-12-01: the three ledger reads now aggregate without retaining rows, so they
  // report `truncated` only if the SCAN cap was reached — not merely because the period held
  // more than REPORT_ROW_CAP transactions. `regRefundRead.complete` is unchanged.
  const truncated = txn.truncated || refundsSnap.truncated || settleSnap.truncated || !regRefundRead.complete

  return {
    organizerName:       u?.organizationName || u?.name || u?.email || 'Organizer',
    period:              { from: f.from ?? null, to: f.to ?? null },
    settlementReference, settlementDate,
    grossRevenuePaise:        gross,
    platformFeeBasePaise:     feesBase,
    platformFeeGstPaise:      gst,
    platformFeeTotalPaise:    platformFeeTotal,
    gatewayFeePaise:          gatewayResolved,
    gatewayFeeActualPaise:    actualRows > 0 ? gatewayActual : null,
    gatewayFeeEstimatePaise:  gatewayEstimate,
    gatewayTaxPaise:          actualRows > 0 ? gatewayTax : null,
    gatewayFeeBasis,
    totalFeesPaise:           totalFees,
    refundsPaise:             refunds,
    registrationRefundsPaise: registrationRefunds,
    donationRefundsPaise:     donationRefunds,
    refundCount:              registrationRefundCount,
    netSettlementPaise:       net,
    transactionCount:         count,
    truncated,
  }
}
