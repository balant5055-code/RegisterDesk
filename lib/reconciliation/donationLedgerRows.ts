// Phase 3.8 · A — ROW-DRIVEN donation refund integrity, READ-ONLY and report-only.
//
// The Phase 3.6A pass (donationRefunds.ts) starts from DONATIONS, so it cannot see a ledger row or refund
// record whose donation is missing, nor rows on a donation with no refund activity (it stops early there).
// This pass starts from the ROWS and the RECORDS instead:
//   ledger pass  — platformTransactions with status 'refunded' and sourceType 'donation', in document-id
//                  order. Each row carrying parentTransactionId must be a reversal `ptx_refund_{refundId}` or a
//                  compensating entry `ptx_refundcomp_{refundId}` whose donation and refund record exist and
//                  agree with it (amount, donation, decision). A refunded ORIGINAL row (no parent) is the full-
//                  refund flip and is checked by the Phase 3.6A pass — skipped here.
//   record pass  — donationRefunds in document-id order: each must name an existing donation.
// Same report contract as Phase 3.6A: mismatches and unverifiables, never a repair. Bounded pages with
// durable cursors (the whole set is covered across runs); a page cut short by the time budget is reported
// as unverifiable, never as clean. Queries: equality filters + document-id order (single-field indexes).

import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'
import {
  mismatch, unverifiable, RECON_BUDGET_MS,
  type CounterMismatch, type ReconcileOptions, type ReconcileResult, type ReconcileUnverifiable,
} from '@/lib/reconciliation/types'

export const LEDGER_ROW_PAGE = 300
export const REFUND_RECORD_PAGE = 300

type Doc = { id: string } & Record<string, unknown>

export interface LedgerRowFacts {
  row: Doc
  /** The donation the row's parent names (null = not found). */
  donation: Doc | null
  /** The refund record the row id names (null = not found). */
  refund: Doc | null
  /** For a compensating row: the reversal row it cancels (null = not found). */
  reversal: Doc | null
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const hasRefundActivity = (d: Doc) =>
  (isInt(d.refundedAmountPaise) && d.refundedAmountPaise !== 0) || (isInt(d.pendingRefundPaise) && d.pendingRefundPaise !== 0)
  || (!!d.refundAttempts && typeof d.refundAttempts === 'object' && Object.keys(d.refundAttempts as object).length > 0)

/** Parses a donation reversal / compensating row id. */
export function parseDonationRowId(id: string): { kind: 'reversal' | 'compensation'; refundId: string } | null {
  if (id.startsWith('ptx_refundcomp_') && id.length > 'ptx_refundcomp_'.length) return { kind: 'compensation', refundId: id.slice('ptx_refundcomp_'.length) }
  if (id.startsWith('ptx_refund_') && id.length > 'ptx_refund_'.length) return { kind: 'reversal', refundId: id.slice('ptx_refund_'.length) }
  return null
}

/** PURE — the verdict for ONE donation-linked ledger row. Entity = the donation the row names. */
export function evaluateLedgerRow(f: LedgerRowFacts): { mismatches: CounterMismatch[]; unverifiable: ReconcileUnverifiable[] } {
  const out: CounterMismatch[] = [], unv: ReconcileUnverifiable[] = []
  const r = f.row
  const parent = r.parentTransactionId
  if (typeof parent !== 'string' || !parent.startsWith('ptx_') || parent.length <= 4) {
    unv.push(unverifiable('donation', `row:${r.id}`, `ledgerRow:${r.id}`, 'parent_unreadable'))
    return { mismatches: out, unverifiable: unv }
  }
  const donationId = parent.slice(4)
  const m = (field: string, expected: number, actual: number) => out.push(mismatch('donation', donationId, field, expected, actual, false))
  const u = (check: string, reason: string) => unv.push(unverifiable('donation', donationId, check, reason))
  const shape = parseDonationRowId(r.id)
  if (!shape) { u(`ledgerRow:${r.id}`, 'unknown_row_shape'); return { mismatches: out, unverifiable: unv } }
  if (!f.donation) m(`ledgerRowDonationMissing:${r.id}`, 1, 0)
  if (typeof r.refundId === 'string' && r.refundId !== shape.refundId) m(`ledgerRowRefundIdMismatch:${r.id}`, 1, 0)
  if (!f.refund) {
    // the donation exists but shows no refund activity at all: a row on an inactive donation
    m(f.donation && !hasRefundActivity(f.donation) ? `ledgerRowOnInactiveDonation:${r.id}` : `ledgerRowRefundMissing:${r.id}`, 1, 0)
    return { mismatches: out, unverifiable: unv }
  }
  const rec = f.refund
  if (rec.donationId !== donationId) m(`ledgerRowRefundDonation:${r.id}`, 1, 0)
  if (!isInt(rec.amountPaise) || rec.amountPaise <= 0) { u(`refund:${rec.id}`, 'amount_unreadable'); return { mismatches: out, unverifiable: unv } }
  const compensated = rec.status === 'failed' && !!rec.compensation
  if (shape.kind === 'reversal') {
    if (!isInt(r.grossAmountPaise) || !isInt(r.netSettlementPaise)) u(`ledgerRow:${r.id}`, 'amounts_unreadable')
    else if (r.grossAmountPaise !== -rec.amountPaise) m(`ledgerRowAmount:${r.id}`, -rec.amountPaise, r.grossAmountPaise)
    // a reversal exists only for a refund ACCOUNTED as processed (or accounted, then compensated)
    if (rec.status !== 'processed' && !compensated) m(`ledgerRowRefundNotAccounted:${r.id}`, 1, 0)
  } else {
    if (r.compensatesTransactionId !== `ptx_refund_${shape.refundId}`) m(`compensationTarget:${r.id}`, 1, 0)
    if (!compensated) m(`compensationWithoutDecision:${r.id}`, 1, 0)
    if (!f.reversal) m(`compensationReversalMissing:${r.id}`, 1, 0)
    else if (!isInt(r.netSettlementPaise) || !isInt(f.reversal.netSettlementPaise)) u(`ledgerRow:${r.id}`, 'amounts_unreadable')
    else if (r.netSettlementPaise !== -f.reversal.netSettlementPaise) m(`compensationNet:${r.id}`, -(f.reversal.netSettlementPaise as number), r.netSettlementPaise)
  }
  return { mismatches: out, unverifiable: unv }
}

/** PURE — a refund record must name an existing donation. */
export function evaluateRefundRecordLink(rec: Doc, donationExists: boolean | null): { mismatches: CounterMismatch[]; unverifiable: ReconcileUnverifiable[] } {
  if (typeof rec.donationId !== 'string' || !rec.donationId) return { mismatches: [], unverifiable: [unverifiable('donation', `refund:${rec.id}`, `refundRecord:${rec.id}`, 'donation_id_unreadable')] }
  if (donationExists === false) return { mismatches: [mismatch('donation', rec.donationId, `refundRecordDonationMissing:${rec.id}`, 1, 0, false)], unverifiable: [] }
  return { mismatches: [], unverifiable: [] }
}

async function getMany(paths: string[]): Promise<Map<string, Doc | null>> {
  const unique = [...new Set(paths)]
  const out = new Map<string, Doc | null>()
  for (let i = 0; i < unique.length; i += 100) {
    const refs = unique.slice(i, i + 100).map(p => adminDb.doc(p))
    if (!refs.length) continue
    const snaps = await adminDb.getAll(...refs)
    for (const s of snaps) out.set(s.ref.path, s.exists ? { id: s.id, ...s.data() } : null)
  }
  return out
}

interface PageRun { scanned: number; mismatches: CounterMismatch[]; unverifiable: ReconcileUnverifiable[] }

/** One bounded page of a collection in id order, resuming from a durable cursor; budget stops are explicit. */
async function pageRun(
  cursorKey: string, query: FirebaseFirestore.Query, pageSize: number, budgetMs: number, entityHint: string,
  handle: (docs: FirebaseFirestore.QueryDocumentSnapshot[], out: PageRun, deadline: number) => Promise<string | null>,
): Promise<PageRun> {
  const out: PageRun = { scanned: 0, mismatches: [], unverifiable: [] }
  const after = await readCursor(cursorKey)
  let q = query.orderBy(FieldPath.documentId())
  if (after) q = q.startAfter(after)
  const page = await q.limit(pageSize).get()
  if (page.empty) { await writeCursor(cursorKey, null); return out }   // end of the collection: wrap
  const deadline = Date.now() + budgetMs
  const before = out.unverifiable.length
  const lastDone = await handle(page.docs, out, deadline)
  const readFailed = lastDone === null && out.unverifiable.length > before
  const finished = lastDone !== null && lastDone === page.docs[page.docs.length - 1].id
  // a page cut short is NEVER a clean result: the unchecked remainder is reported as unverifiable
  if (!finished && !readFailed) out.unverifiable.push(unverifiable('donation', entityHint, `scan:${cursorKey}`, `budget_exhausted_after:${lastDone ?? after ?? 'start'}`))
  await writeCursor(cursorKey, finished ? (page.size === pageSize ? lastDone : null) : (lastDone ?? after))
  return out
}

/** The ledger pass (read-only). */
export async function reconcileDonationLedgerRows(opts?: ReconcileOptions): Promise<ReconcileResult> {
  const budgetMs = opts?.budgetMs ?? RECON_BUDGET_MS
  const r = await pageRun('recon:donation-ledger-rows',
    adminDb.collection('platformTransactions').where('status', '==', 'refunded').where('sourceType', '==', 'donation'),
    opts?.limit ?? LEDGER_ROW_PAGE, budgetMs, 'ledger-rows',
    async (docs, out, deadline) => {
      const rows = docs.map(d => ({ id: d.id, ...d.data() }) as Doc).filter(x => typeof x.parentTransactionId === 'string' || parseDonationRowId(x.id))
      const paths: string[] = []
      for (const x of rows) {
        const parent = typeof x.parentTransactionId === 'string' ? x.parentTransactionId : ''
        if (parent.startsWith('ptx_')) paths.push(`donations/${parent.slice(4)}`)
        const shape = parseDonationRowId(x.id)
        if (shape) {
          paths.push(`donationRefunds/${shape.refundId}`)
          if (shape.kind === 'compensation') paths.push(`platformTransactions/ptx_refund_${shape.refundId}`)
        }
      }
      let got: Map<string, Doc | null>
      try { got = await getMany(paths) } catch (err) {
        captureError(err, { scope: 'global_reconciliation', entityType: 'donation', pass: 'ledger_rows' })
        out.unverifiable.push(unverifiable('donation', 'ledger-rows', 'ledger_rows_page', `read_failed:${err instanceof Error ? err.message.slice(0, 100) : 'unknown'}`))
        return null
      }
      let last: string | null = null
      for (const d of docs) {
        if (Date.now() > deadline) break
        out.scanned++
        const x = rows.find(y => y.id === d.id)
        if (x) {
          const parent = String(x.parentTransactionId ?? '')
          const shape = parseDonationRowId(x.id)
          const v = evaluateLedgerRow({
            row: x,
            donation: parent.startsWith('ptx_') ? got.get(`donations/${parent.slice(4)}`) ?? null : null,
            refund: shape ? got.get(`donationRefunds/${shape.refundId}`) ?? null : null,
            reversal: shape?.kind === 'compensation' ? got.get(`platformTransactions/ptx_refund_${shape.refundId}`) ?? null : null,
          })
          out.mismatches.push(...v.mismatches); out.unverifiable.push(...v.unverifiable)
        }
        last = d.id
      }
      return last
    })
  return { entityType: 'donation', scanned: r.scanned, mismatches: r.mismatches, unverifiable: r.unverifiable, repaired: 0 }
}

/** The refund-record pass (read-only). */
export async function reconcileDonationRefundRecords(opts?: ReconcileOptions): Promise<ReconcileResult> {
  const budgetMs = opts?.budgetMs ?? RECON_BUDGET_MS
  const r = await pageRun('recon:donation-refund-records', adminDb.collection('donationRefunds'), opts?.limit ?? REFUND_RECORD_PAGE, budgetMs, 'refund-records',
    async (docs, out, deadline) => {
      const recs = docs.map(d => ({ id: d.id, ...d.data() }) as Doc)
      let got: Map<string, Doc | null>
      try { got = await getMany(recs.filter(x => typeof x.donationId === 'string' && x.donationId).map(x => `donations/${x.donationId}`)) } catch (err) {
        captureError(err, { scope: 'global_reconciliation', entityType: 'donation', pass: 'refund_records' })
        out.unverifiable.push(unverifiable('donation', 'refund-records', 'refund_records_page', `read_failed:${err instanceof Error ? err.message.slice(0, 100) : 'unknown'}`))
        return null
      }
      let last: string | null = null
      for (const rec of recs) {
        if (Date.now() > deadline) break
        out.scanned++
        const exists = typeof rec.donationId === 'string' && rec.donationId ? (got.get(`donations/${rec.donationId}`) ?? null) !== null : null
        const v = evaluateRefundRecordLink(rec, exists)
        out.mismatches.push(...v.mismatches); out.unverifiable.push(...v.unverifiable)
        last = rec.id
      }
      return last
    })
  return { entityType: 'donation', scanned: r.scanned, mismatches: r.mismatches, unverifiable: r.unverifiable, repaired: 0 }
}
