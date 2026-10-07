// Communication-wallet top-up reconciliation (RD-WALLET-W2.d · S1–S2). REPORT ONLY. Server-only.
//
// Reconciles the COMMUNICATION wallet (`organizerWallets`, funded by Razorpay top-ups) against
// its own records. The revenue wallet (`organizerRevenueWallets`) is lib/reconciliation/wallets.ts.
//
//   S1 · pure classifiers — no I/O. Every finding has a reason code and a confidence:
//          confirmed    the stored records contradict each other under every current writer;
//          probable     most likely a real inconsistency, but a benign explanation exists;
//          inconclusive the evidence is incomplete (legacy history, malformed or truncated data) —
//                       NEVER reported as a loss.
//   S2 · read-only collectors — bounded pages, stateless document-id cursors (the caller passes
//        the returned cursor back; nothing is persisted), a wall-clock deadline. They READ only:
//        no Firestore write of any kind (no report docs, no cursor docs, no audit logs) and no
//        payment-provider call.
//
// ═══ WHY A WALLET'S BALANCE IS JUDGED BY ITS LEDGER CHAIN, NOT A SUM ══════════════════════════
// History shows balance changes that wrote NO ledger row: Phase-1 top-up credits (verify / webhook
// → creditWallet), the Phase-1 publish debit (events/publish → txnDeductWallet) and the Phase-2
// licence refund (creditWallet, row written separately). Nothing on a wallet records whether it
// lived through those phases, and no production cut-over date is known. So completeness is proven
// from the ledger itself: every current writer stores the running balance AFTER the row
// (`balancePaise`) in the same transaction as the balance change. Walking a wallet's rows newest →
// oldest, the history is complete only if
//   • the newest row's balance equals the stored wallet balance (else: balance_mismatch),
//   • each row's balance minus its signed amount equals the next-older row's balance (no gap),
//   • the oldest row's balance minus its signed amount is 0 (the history starts from nothing),
//   • every row is readable (known, unambiguous type; positive integer amount; 'completed';
//     integer running balance) and every row of the wallet was seen (count matches).
// Any break → inconclusive, with the reason. A balance claim is made only on an unbroken chain.
//
// Sign rule (approved): credit ⇔ txnMeta.isWalletCredit(type); 'adjustment' is AMBIGUOUS (neither);
// any other DECLARED type is a debit; an undeclared type is unknown. txnMeta and the report
// builders' pre-existing disagreement is deliberately left untouched.

import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { isWalletCredit } from '@/lib/finance/txnMeta'
import { WALLET_TXN_TYPE_LABELS, type WalletTxnType } from '@/lib/wallet/types'

// ═══ S1 · types and pure classifiers ═══════════════════════════════════════════════════════════

export type ReconConfidence = 'confirmed' | 'probable' | 'inconclusive'

export type TopupFindingCode =
  | 'topup_malformed'                  // uid / amountPaise / status unusable
  | 'topup_status_unknown'             // a status no writer produces
  | 'duplicate_credit'                 // more than one fund_added row for one top-up
  | 'ledger_without_credit'            // a fund_added row exists but the top-up is not credited
  | 'credit_without_ledger'            // credited, no fund_added row (legacy credits wrote none)
  | 'credited_without_payment_id'      // credited top-up carries no paymentId
  | 'ledger_amount_mismatch'           // row amount ≠ top-up amount
  | 'ledger_owner_mismatch'            // row organizerUid ≠ top-up uid
  | 'ledger_payment_mismatch'          // row paymentId ≠ top-up paymentId (both present)
  | 'ledger_order_mismatch'            // topup_{orderId} row names another order
  | 'ledger_reference_missing'         // row has no paymentId
  | 'ledger_status_unexpected'         // row status is not 'completed'
  | 'ledger_row_unexpected_type'       // a row tied to the order that is not fund_added
  | 'ledger_evidence_truncated'        // the order's rows could not all be read
  | 'resolved_without_credit'          // reconciliation 'resolved' but the top-up is not credited
  | 'hold_on_credited_topup'           // needs_review / exhausted on a credited top-up (stale hold)
  | 'retry_pending_on_credited_topup'  // W2.a 'pending' on a credited top-up (normally self-resolves)
  | 'reconciliation_owner_mismatch'    // reconciliation uid ≠ top-up uid
  | 'reconciliation_status_unknown'

export type ReconciliationRecordFindingCode =
  | 'reconciliation_malformed'         // no usable orderId
  | 'reconciliation_without_topup'     // the top-up it refers to does not exist
  | 'reconciliation_status_unknown'

export type WalletFindingCode =
  | 'balance_mismatch'                 // unbroken ledger chain, stored balance differs
  | 'balance_unverifiable'             // chain not provable — see detail.reason

export type WalletUnverifiableReason =
  | 'wallet_malformed'                 // balancePaise missing / not an integer
  | 'ledger_type_ambiguous'            // an 'adjustment' row
  | 'ledger_type_unknown'              // an undeclared type
  | 'ledger_row_malformed'             // amount / running balance unusable
  | 'ledger_row_not_completed'
  | 'ledger_chain_gap'                 // a row's balance does not follow from the next-newer one
  | 'ledger_history_incomplete'        // the chain does not start from 0 (legacy / unledgered history)
  | 'ledger_rows_unaccounted'          // rows exist that the ordered walk did not see (e.g. no createdAt)
  | 'ledger_scan_truncated'            // the per-wallet row budget was reached
  | 'deadline_reached'

export type ReconDetail = Record<string, string | number | boolean | null>

export interface TopupReconFinding {
  scope:      'topup'
  orderId:    string
  uid:        string | null
  code:       TopupFindingCode
  confidence: ReconConfidence
  detail?:    ReconDetail
}
export interface ReconciliationRecordFinding {
  scope:      'reconciliation_record'
  recordId:   string
  orderId:    string | null
  code:       ReconciliationRecordFindingCode
  confidence: ReconConfidence
  detail?:    ReconDetail
}
export interface WalletReconFinding {
  scope:      'wallet'
  uid:        string
  code:       WalletFindingCode
  confidence: ReconConfidence
  detail?:    ReconDetail
}

export type RawDoc = Record<string, unknown>
export interface RawRow { id: string; data: RawDoc }

const isInt    = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isPosInt = (v: unknown): v is number => isInt(v) && v > 0
const str      = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// ── the sign map ───────────────────────────────────────────────────────────────────────────────
export type LedgerSign = 'credit' | 'debit' | 'ambiguous' | 'unknown'

/** Every DECLARED wallet transaction type (lib/wallet/types.ts is the declaration). */
const DECLARED_LEDGER_TYPES: ReadonlySet<string> = new Set(Object.keys(WALLET_TXN_TYPE_LABELS))
/** Approved: 'adjustment' is neither a credit nor a debit for balance reconciliation. */
export const AMBIGUOUS_LEDGER_TYPES: ReadonlySet<string> = new Set(['adjustment'])

/** credit ⇔ txnMeta.isWalletCredit; 'adjustment' ambiguous; other declared types debit; the rest unknown. */
export function ledgerSign(type: unknown): LedgerSign {
  if (typeof type !== 'string' || !DECLARED_LEDGER_TYPES.has(type)) return 'unknown'
  if (AMBIGUOUS_LEDGER_TYPES.has(type)) return 'ambiguous'
  return isWalletCredit(type as WalletTxnType) ? 'credit' : 'debit'
}

// ── per top-up ─────────────────────────────────────────────────────────────────────────────────
const KNOWN_TOPUP_STATUSES: ReadonlySet<string> = new Set(['pending', 'credited', 'needs_review', 'abandoned', 'failed'])
const KNOWN_RECON_STATUSES: ReadonlySet<string> = new Set(['pending', 'needs_review', 'exhausted', 'duplicate_payment', 'resolved', 'skipped'])

export interface TopupEvidence {
  orderId:    string
  topup:      RawDoc
  /** walletTopupReconciliation/{orderId}, if it exists. */
  recon:      RawDoc | null
  /** Ledger rows tied to the order: walletTransactions/topup_{orderId} and rows whose orderId is it. */
  ledgerRows: RawRow[]
  /** False when the order's rows could not all be read (the finding then says so). */
  ledgerEvidenceComplete: boolean
}

/** Pure. All findings for ONE top-up order (empty ⇒ consistent). */
export function classifyTopup(e: TopupEvidence): TopupReconFinding[] {
  const out: TopupReconFinding[] = []
  const uid = str(e.topup.uid)
  const add = (code: TopupFindingCode, confidence: ReconConfidence, detail?: ReconDetail) =>
    out.push({ scope: 'topup', orderId: e.orderId, uid, code, confidence, ...(detail ? { detail } : {}) })

  const amount = e.topup.amountPaise
  const status = e.topup.status
  if (!uid || !isPosInt(amount) || typeof status !== 'string') {
    add('topup_malformed', 'inconclusive', {
      hasUid: uid !== null, amountValid: isPosInt(amount), status: typeof status === 'string' ? status : null,
    })
    return out
  }
  if (!KNOWN_TOPUP_STATUSES.has(status)) {
    add('topup_status_unknown', 'inconclusive', { status })
    return out
  }

  const rows    = dedupeRows(e.ledgerRows)
  const credits = rows.filter(r => r.data.type === 'fund_added')
  const others  = rows.filter(r => r.data.type !== 'fund_added')
  if (!e.ledgerEvidenceComplete) add('ledger_evidence_truncated', 'inconclusive')
  if (others.length > 0) add('ledger_row_unexpected_type', 'inconclusive', { rows: others.length, rowIds: others.map(r => r.id).join(',') })
  if (credits.length > 1) add('duplicate_credit', 'confirmed', { rows: credits.length, rowIds: credits.map(r => r.id).join(',') })

  const reconStatus = e.recon ? e.recon.status : undefined
  if (status === 'credited') {
    const paymentId = str(e.topup.paymentId)
    if (!paymentId) add('credited_without_payment_id', 'inconclusive')
    // Legacy credits (Phase 1 verify / webhook) wrote no ledger row — never a confirmed loss.
    if (credits.length === 0 && e.ledgerEvidenceComplete) add('credit_without_ledger', 'inconclusive')
    for (const r of credits) {
      if (r.data.organizerUid !== uid) add('ledger_owner_mismatch', 'confirmed', { rowId: r.id })
      if (r.data.amountPaise !== amount) {
        add('ledger_amount_mismatch', 'confirmed', { rowId: r.id, expectedPaise: amount, ledgerPaise: isInt(r.data.amountPaise) ? r.data.amountPaise : null })
      }
      if (r.data.orderId !== undefined && r.data.orderId !== e.orderId) add('ledger_order_mismatch', 'confirmed', { rowId: r.id })
      const rowPayment = str(r.data.paymentId)
      if (!rowPayment) add('ledger_reference_missing', 'inconclusive', { rowId: r.id })
      else if (paymentId && rowPayment !== paymentId) {
        add('ledger_payment_mismatch', 'confirmed', { rowId: r.id, topupPaymentId: paymentId, ledgerPaymentId: rowPayment })
      }
      if (r.data.status !== 'completed') add('ledger_status_unexpected', 'inconclusive', { rowId: r.id, status: str(r.data.status) })
    }
    if (reconStatus === 'needs_review' || reconStatus === 'exhausted') add('hold_on_credited_topup', 'confirmed', { reconciliationStatus: reconStatus })
    if (reconStatus === 'pending') add('retry_pending_on_credited_topup', 'probable')
  } else {
    // The credit transaction writes the row and the 'credited' status together.
    if (credits.length > 0) add('ledger_without_credit', 'confirmed', { rows: credits.length, topupStatus: status })
    if (reconStatus === 'resolved') add('resolved_without_credit', 'confirmed', { topupStatus: status })
  }

  if (e.recon) {
    const reconUid = str(e.recon.uid)
    if (reconUid && reconUid !== uid) add('reconciliation_owner_mismatch', 'confirmed')
    if (typeof reconStatus !== 'string' || !KNOWN_RECON_STATUSES.has(reconStatus)) {
      add('reconciliation_status_unknown', 'inconclusive', { status: typeof reconStatus === 'string' ? reconStatus : null })
    }
  }
  return out
}

function dedupeRows(rows: RawRow[]): RawRow[] {
  const seen = new Set<string>()
  return rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)))
}

// ── per reconciliation record ──────────────────────────────────────────────────────────────────
/** Pure. A walletTopupReconciliation record ({orderId}, dup_*, mismatch_*) checked against its top-up's existence. */
export function classifyReconciliationRecord(
  r: { id: string; data: RawDoc; topupExists: boolean | null },
): ReconciliationRecordFinding[] {
  const orderId = str(r.data.orderId)
  const out: ReconciliationRecordFinding[] = []
  const add = (code: ReconciliationRecordFindingCode, confidence: ReconConfidence, detail?: ReconDetail) =>
    out.push({ scope: 'reconciliation_record', recordId: r.id, orderId, code, confidence, ...(detail ? { detail } : {}) })
  if (!orderId) { add('reconciliation_malformed', 'inconclusive'); return out }
  // Organizer deletion retains walletTopups, so a missing top-up is not explained by cleanup —
  // but a manual data change could be, hence 'probable'.
  if (r.topupExists === false) add('reconciliation_without_topup', 'probable', { status: str(r.data.status) })
  const status = r.data.status
  if (typeof status !== 'string' || !KNOWN_RECON_STATUSES.has(status)) {
    add('reconciliation_status_unknown', 'inconclusive', { status: typeof status === 'string' ? status : null })
  }
  return out
}

// ── per wallet: the ledger chain ───────────────────────────────────────────────────────────────
export interface WalletChainState {
  uid:           string
  walletBalance: number | null
  rows:          number
  /** The running balance the next-OLDER row must show (null before the first row). */
  expectedOlder: number | null
  /** The newest row's running balance (what the ledger says the wallet holds). */
  ledgerBalance: number | null
  broken:        WalletUnverifiableReason | null
  brokenAtRow:   string | null
}

/** Pure. Starts a newest → oldest walk of one wallet's ledger. */
export function startWalletChain(uid: string, walletDoc: RawDoc | null): WalletChainState {
  const bal = walletDoc ? walletDoc.balancePaise : 0          // no wallet doc ⇒ balance 0 (getWalletBalance)
  const ok = isInt(bal)
  return {
    uid, walletBalance: ok ? bal : null, rows: 0, expectedOlder: null, ledgerBalance: null,
    broken: ok ? null : 'wallet_malformed', brokenAtRow: null,
  }
}

/** Pure. Folds ONE row (rows must arrive newest → oldest). A broken chain stays broken. */
export function stepWalletChain(s: WalletChainState, row: RawRow): WalletChainState {
  if (s.broken) return s
  const n = { ...s, rows: s.rows + 1 }
  const breakAt = (reason: WalletUnverifiableReason): WalletChainState => ({ ...n, broken: reason, brokenAtRow: row.id })
  const sign = ledgerSign(row.data.type)
  if (sign === 'ambiguous') return breakAt('ledger_type_ambiguous')
  if (sign === 'unknown')   return breakAt('ledger_type_unknown')
  if (!isPosInt(row.data.amountPaise) || !isInt(row.data.balancePaise)) return breakAt('ledger_row_malformed')
  if (row.data.status !== 'completed') return breakAt('ledger_row_not_completed')
  const after = row.data.balancePaise
  if (s.expectedOlder === null) n.ledgerBalance = after                // the newest row
  else if (after !== s.expectedOlder) return breakAt('ledger_chain_gap')
  n.expectedOlder = after - (sign === 'credit' ? row.data.amountPaise : -row.data.amountPaise)
  return n
}

/**
 * Pure. The verdict once the walk ends. `allRowsSeen` = the walk reached the oldest row;
 * `totalRows` = how many rows the wallet has (count), to catch rows the ordered walk cannot see.
 */
export function finishWalletChain(
  s: WalletChainState, walk: { allRowsSeen: boolean; totalRows: number | null; deadlineReached?: boolean },
): { verdict: 'verified' | 'mismatch' | 'inconclusive'; finding: WalletReconFinding | null } {
  const base = { rows: s.rows, walletBalancePaise: s.walletBalance, ledgerBalancePaise: s.ledgerBalance }
  const unverifiable = (reason: WalletUnverifiableReason, extra: ReconDetail = {}) => ({
    verdict: 'inconclusive' as const,
    finding: { scope: 'wallet' as const, uid: s.uid, code: 'balance_unverifiable' as const, confidence: 'inconclusive' as const,
      detail: { reason, ...base, ...(s.brokenAtRow ? { atRowId: s.brokenAtRow } : {}), ...extra } },
  })
  if (s.broken) return unverifiable(s.broken)
  if (walk.deadlineReached) return unverifiable('deadline_reached')
  if (!walk.allRowsSeen) return unverifiable('ledger_scan_truncated')
  if (walk.totalRows !== null && walk.totalRows !== s.rows) return unverifiable('ledger_rows_unaccounted', { totalRows: walk.totalRows })
  // The history must start from nothing: the balance before the oldest row is 0 (no rows ⇒ the
  // wallet itself must be 0). Otherwise part of the history is unledgered (legacy) — unprovable.
  const start = s.rows === 0 ? s.walletBalance : s.expectedOlder
  if (start !== 0) return unverifiable('ledger_history_incomplete', { balanceBeforeOldestPaise: start })
  if (s.rows > 0 && s.ledgerBalance !== s.walletBalance) {
    return {
      verdict: 'mismatch',
      finding: { scope: 'wallet', uid: s.uid, code: 'balance_mismatch', confidence: 'confirmed',
        detail: { ...base, deltaPaise: (s.walletBalance ?? 0) - (s.ledgerBalance ?? 0) } },
    }
  }
  return { verdict: 'verified', finding: null }
}

// ═══ S2 · read-only collectors ═════════════════════════════════════════════════════════════════
//
// Every collector: one bounded page ordered by document id, starting AFTER `cursor` (the caller's —
// nothing is stored), stopping before a new entity once `deadlineAtMs` passes. `nextCursor` is the
// last entity fully processed (null once the collection end was reached with nothing deferred).

export interface ReconPageOptions {
  cursor?:      string | null
  limit?:       number
  deadlineAtMs?: number
}

export interface ReconPageMeta {
  scanned:     number
  /** Entities on this page not processed (deadline) — the cursor stops before them. */
  deferred:    number
  nextCursor:  string | null
  /** True only when the collection end was reached and nothing was deferred. */
  complete:    boolean
  /** Some entity's evidence could not be fully read (see its findings). */
  truncated:   boolean
}

export const TOPUP_PAGE_DEFAULT  = 200
export const TOPUP_PAGE_MAX      = 500
export const WALLET_PAGE_DEFAULT = 25
export const WALLET_PAGE_MAX     = 100
export const LEDGER_ROWS_PER_WALLET_DEFAULT = 2_000
export const LEDGER_ROWS_PER_WALLET_MAX     = 10_000
/** Ledger rows read per `orderId in [...]` chunk before the chunk's evidence counts as truncated. */
const LEDGER_ROWS_PER_ORDER_CHUNK = 300
const IN_CHUNK = 30
const WALK_PAGE = 200

const clamp = (v: number | undefined, dflt: number, max: number) =>
  Math.max(1, Math.min(max, Math.floor(typeof v === 'number' && Number.isFinite(v) ? v : dflt)))

async function pageByDocId(collection: string, cursor: string | null | undefined, limitN: number) {
  let q = adminDb.collection(collection).orderBy(FieldPath.documentId()).limit(limitN) as FirebaseFirestore.Query
  if (cursor) q = q.startAfter(cursor)
  return q.get()
}

/** Page bookkeeping: `processed` entities of `docs` were fully handled, in order. */
function metaFor(docs: FirebaseFirestore.QueryDocumentSnapshot[], processed: number, limitN: number, cursor: string | null | undefined, truncated: boolean): ReconPageMeta {
  const deferred = docs.length - processed
  const endReached = docs.length < limitN
  const nextCursor = processed > 0 ? docs[processed - 1].id : (cursor ?? null)
  return {
    scanned: processed, deferred,
    nextCursor: endReached && deferred === 0 ? null : nextCursor,
    complete: endReached && deferred === 0,
    truncated,
  }
}

// ── top-ups ────────────────────────────────────────────────────────────────────────────────────
export interface TopupReconPage extends ReconPageMeta { findings: TopupReconFinding[] }

/** S2 · one page of walletTopups, each checked against its reconciliation record and ledger rows. Reads only. */
export async function reconcileTopupsPage(opts: ReconPageOptions = {}): Promise<TopupReconPage> {
  const limitN = clamp(opts.limit, TOPUP_PAGE_DEFAULT, TOPUP_PAGE_MAX)
  const deadline = opts.deadlineAtMs ?? Infinity
  const page = await pageByDocId('walletTopups', opts.cursor, limitN)
  const docs = page.docs
  if (docs.length === 0 || Date.now() >= deadline) {
    return { findings: [], ...metaFor(docs, 0, limitN, opts.cursor, false) }
  }
  const ids = docs.map(d => d.id)

  // Evidence for the whole page, in bounded batches (reads only).
  const [recons, topupRows] = await Promise.all([
    adminDb.getAll(...ids.map(id => adminDb.collection('walletTopupReconciliation').doc(id))),
    adminDb.getAll(...ids.map(id => adminDb.collection('walletTransactions').doc(`topup_${id}`))),
  ])
  const rowsByOrder = new Map<string, RawRow[]>(ids.map(id => [id, []]))
  topupRows.forEach((s, i) => { if (s.exists) rowsByOrder.get(ids[i])!.push({ id: s.id, data: s.data() as RawDoc }) })
  const truncatedOrders = new Set<string>()
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK)
    const snap = await adminDb.collection('walletTransactions').where('orderId', 'in', chunk).limit(LEDGER_ROWS_PER_ORDER_CHUNK).get()
    for (const d of snap.docs) {
      const oid = (d.data() as RawDoc).orderId
      if (typeof oid === 'string' && rowsByOrder.has(oid)) rowsByOrder.get(oid)!.push({ id: d.id, data: d.data() as RawDoc })
    }
    if (snap.size >= LEDGER_ROWS_PER_ORDER_CHUNK) for (const id of chunk) truncatedOrders.add(id)
  }

  const findings: TopupReconFinding[] = []
  let processed = 0
  for (let i = 0; i < docs.length; i++) {
    if (Date.now() >= deadline) break
    findings.push(...classifyTopup({
      orderId: ids[i], topup: docs[i].data() as RawDoc,
      recon: recons[i].exists ? recons[i].data() as RawDoc : null,
      ledgerRows: rowsByOrder.get(ids[i])!,
      ledgerEvidenceComplete: !truncatedOrders.has(ids[i]),
    }))
    processed++
  }
  return { findings, ...metaFor(docs, processed, limitN, opts.cursor, truncatedOrders.size > 0) }
}

// ── reconciliation records ─────────────────────────────────────────────────────────────────────
export interface ReconciliationRecordPage extends ReconPageMeta { findings: ReconciliationRecordFinding[] }

/** S2 · one page of walletTopupReconciliation records, each checked for its top-up. Reads only. */
export async function reconcileTopupRecordsPage(opts: ReconPageOptions = {}): Promise<ReconciliationRecordPage> {
  const limitN = clamp(opts.limit, TOPUP_PAGE_DEFAULT, TOPUP_PAGE_MAX)
  const deadline = opts.deadlineAtMs ?? Infinity
  const page = await pageByDocId('walletTopupReconciliation', opts.cursor, limitN)
  const docs = page.docs
  if (docs.length === 0 || Date.now() >= deadline) {
    return { findings: [], ...metaFor(docs, 0, limitN, opts.cursor, false) }
  }
  const orderIds = docs.map(d => str((d.data() as RawDoc).orderId))
  const wanted = [...new Set(orderIds.filter((x): x is string => x !== null))]
  const exists = new Map<string, boolean>()
  if (wanted.length > 0) {
    const snaps = await adminDb.getAll(...wanted.map(id => adminDb.collection('walletTopups').doc(id)))
    snaps.forEach((s, i) => exists.set(wanted[i], s.exists))
  }
  const findings: ReconciliationRecordFinding[] = []
  let processed = 0
  for (let i = 0; i < docs.length; i++) {
    if (Date.now() >= deadline) break
    const oid = orderIds[i]
    findings.push(...classifyReconciliationRecord({ id: docs[i].id, data: docs[i].data() as RawDoc, topupExists: oid ? exists.get(oid) ?? null : null }))
    processed++
  }
  return { findings, ...metaFor(docs, processed, limitN, opts.cursor, false) }
}

// ── wallets ────────────────────────────────────────────────────────────────────────────────────
export interface WalletReconPage extends ReconPageMeta {
  findings: WalletReconFinding[]
  verified: number
  mismatched: number
  inconclusive: number
}

/**
 * S2 · one page of organizerWallets, each judged by its own ledger chain (newest → oldest, using the
 * existing walletTransactions (organizerUid ASC, createdAt DESC) index), at most `ledgerRowsPerWallet`
 * rows per wallet, streamed — the rows are never held in memory. Reads only.
 */
export async function reconcileCommunicationWalletsPage(
  opts: ReconPageOptions & { ledgerRowsPerWallet?: number } = {},
): Promise<WalletReconPage> {
  const limitN = clamp(opts.limit, WALLET_PAGE_DEFAULT, WALLET_PAGE_MAX)
  const rowBudget = clamp(opts.ledgerRowsPerWallet, LEDGER_ROWS_PER_WALLET_DEFAULT, LEDGER_ROWS_PER_WALLET_MAX)
  const deadline = opts.deadlineAtMs ?? Infinity
  const page = await pageByDocId('organizerWallets', opts.cursor, limitN)
  const docs = page.docs
  const findings: WalletReconFinding[] = []
  let verified = 0, mismatched = 0, inconclusive = 0, processed = 0, truncated = false

  for (const doc of docs) {
    if (Date.now() >= deadline) break
    const v = await reconcileCommunicationWallet(doc.id, doc.data() as RawDoc, { ledgerRowsPerWallet: rowBudget, deadlineAtMs: deadline })
    // Deadline mid-walk: this wallet is DEFERRED (not counted, cursor stays before it), never half-judged.
    if (v.verdict === 'deferred') break
    if (v.finding) findings.push(v.finding)
    if (v.verdict === 'verified') verified++
    else if (v.verdict === 'mismatch') mismatched++
    else inconclusive++
    if (v.finding?.detail?.reason === 'ledger_scan_truncated') truncated = true
    processed++
  }
  return { findings, verified, mismatched, inconclusive, ...metaFor(docs, processed, limitN, opts.cursor, truncated) }
}

/**
 * S2 · ONE communication wallet judged by its ledger chain (newest → oldest, streamed, at most
 * `ledgerRowsPerWallet` rows). Reads only. 'deferred' = the deadline passed mid-walk: no verdict.
 * (RD-WALLET-W2.e reuses this for the Super Admin organizer view.)
 */
export async function reconcileCommunicationWallet(
  uid: string, walletDoc: RawDoc | null, opts: { ledgerRowsPerWallet?: number; deadlineAtMs?: number } = {},
): Promise<{ verdict: 'verified' | 'mismatch' | 'inconclusive' | 'deferred'; finding: WalletReconFinding | null; rowsRead: number }> {
  const rowBudget = clamp(opts.ledgerRowsPerWallet, LEDGER_ROWS_PER_WALLET_DEFAULT, LEDGER_ROWS_PER_WALLET_MAX)
  const deadline = opts.deadlineAtMs ?? Infinity
  let state = startWalletChain(uid, walletDoc)
  let allRowsSeen = false
  let read = 0
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null
  const base = adminDb.collection('walletTransactions').where('organizerUid', '==', uid).orderBy('createdAt', 'desc')
  while (!state.broken) {
    if (Date.now() >= deadline) return { verdict: 'deferred', finding: null, rowsRead: read }
    const n = Math.min(WALK_PAGE, rowBudget - read)
    if (n <= 0) break                                                        // budget reached
    let q = base.limit(n)
    if (last) q = q.startAfter(last)
    const snap = await q.get()
    for (const r of snap.docs) state = stepWalletChain(state, { id: r.id, data: r.data() as RawDoc })
    read += snap.size
    if (snap.size < n) { allRowsSeen = true; break }
    last = snap.docs[snap.docs.length - 1]
  }
  const totalRows = state.broken || !allRowsSeen ? null
    : (await adminDb.collection('walletTransactions').where('organizerUid', '==', uid).count().get()).data().count
  return { ...finishWalletChain(state, { allRowsSeen, totalRows }), rowsRead: read }
}
