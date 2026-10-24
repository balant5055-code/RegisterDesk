// Phase 3.6A — PER-DONATION refund integrity, READ-ONLY and report-only (M11 + M5 of the Phase 3.5 audit).
// Nothing here writes a donation, refund record, ledger row or wallet; there is no repair.
//
// For one donation it checks, from the records the refund engine itself writes:
//   • donations.refundedAmountPaise  = Σ amount of refunds ACCOUNTED as processed (status 'processed'; a
//                                      compensated refund is 'failed' and was taken back out)
//   • donations.pendingRefundPaise   = Σ amount of OPEN attempts (submitting / unknown) + Σ amount of refunds a
//                                      RegisterDesk request still owns a reservation for (status 'pending',
//                                      initiatedBy ≠ 'webhook', reservationReleased ≠ true)
//   • associations                   — a linked attempt names an existing refund record of the same amount; no
//                                      two attempts claim one refund; attempt statuses are known
//   • ledger rows                    — each ACCOUNTED refund has its reversal row ptx_refund_{id} (gross = −amount);
//                                      a COMPENSATED refund has that row AND ptx_refundcomp_{id} cancelling it
//                                      exactly; a failed / pending refund has neither; no row is orphaned
//   • cumulative reversal            — the signed sum of reversal and compensating rows never exceeds the
//                                      original net; a fully refunded donation reverses EXACTLY the original
//                                      net (a gap within the refund count is reported as LEGACY ROUNDING
//                                      RESIDUE — pre-Phase-3.3 per-refund rounding — anything larger as a
//                                      mismatch); a partial one stays within ±k paisa of round(net × refunded /
//                                      gross) (reversalMath.proportionalReversal), k = accounted refunds
// A gateway status alone is never taken as proof of accounting: only the refund record's own status and the
// ledger rows count. Refunded, reserved, failed, compensated and unresolved amounts are kept apart.
// Anything that cannot be read (a capped query, a missing field the check needs, an unreadable value, a
// missing original row) is UNVERIFIABLE — never clean, never guessed.

import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { proportionalReversal } from '@/lib/donations/reversalMath'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'
import {
  mismatch, unverifiable, RECON_BUDGET_MS,
  type CounterMismatch, type ReconcileOptions, type ReconcileResult, type ReconcileUnverifiable,
} from '@/lib/reconciliation/types'

/** Refund records / ledger rows read per donation; more ⇒ unverifiable (never a partial verdict). */
export const DONATION_RECORDS_CAP = 200
/** Donations checked per reconciliation run (cursor-resumed; the full set is covered across runs). */
export const DONATION_RECON_PAGE = 200

export interface DonationRefundFacts {
  donationId: string
  donation: { amountPaise?: unknown; refundedAmountPaise?: unknown; pendingRefundPaise?: unknown; refundAttempts?: unknown }
  refunds: Array<{ id: string } & Record<string, unknown>>
  /** platformTransactions with parentTransactionId = ptx_{donationId} (reversal + compensating rows). */
  ledgerRows: Array<{ id: string } & Record<string, unknown>>
  parent: { exists: boolean; netSettlementPaise?: unknown } | null
  capped: { refunds: boolean; ledgerRows: boolean }
}

export interface DonationRefundAmounts {
  accountedPaise: number      // refunds accounted as processed (incl. ones with an open conflict)
  reservedPaise: number       // what the reservation should hold
  failedPaise: number         // recorded failed, never accounted
  compensatedPaise: number    // accounted, then confirmed failed and compensated
  unresolvedPaise: number     // pending (awaiting the gateway / accounting retry / needs review)
  conflictedRefunds: string[] // refunds carrying a contradictory gateway outcome (held by Phase 3.4)
  reversedNetPaise: number | null
}

export interface DonationRefundVerdict {
  status: 'clean' | 'mismatch' | 'unverifiable'
  mismatches: CounterMismatch[]
  unverifiable: ReconcileUnverifiable[]
  amounts: DonationRefundAmounts
}

const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const OPEN_ATTEMPT = new Set(['submitting', 'unknown'])
const KNOWN_ATTEMPT = new Set(['submitting', 'unknown', 'rejected', 'linked', 'resolved_none'])

/** PURE — the integrity verdict for one donation's refunds. */
export function evaluateDonationRefundIntegrity(f: DonationRefundFacts): DonationRefundVerdict {
  const id = f.donationId
  const out: CounterMismatch[] = []
  const unv: ReconcileUnverifiable[] = []
  const m = (field: string, expected: number, actual: number) => out.push(mismatch('donation', id, field, expected, actual, false))
  const u = (check: string, reason: string) => unv.push(unverifiable('donation', id, check, reason))
  const amounts: DonationRefundAmounts = { accountedPaise: 0, reservedPaise: 0, failedPaise: 0, compensatedPaise: 0, unresolvedPaise: 0, conflictedRefunds: [], reversedNetPaise: null }
  const verdict = (): DonationRefundVerdict => ({ status: out.length ? 'mismatch' : unv.length ? 'unverifiable' : 'clean', mismatches: out, unverifiable: unv, amounts })

  if (f.capped.refunds) u('refunds', `more_than_${DONATION_RECORDS_CAP}_records`)
  if (f.capped.ledgerRows) u('ledger_rows', `more_than_${DONATION_RECORDS_CAP}_rows`)

  // ── refund records ──
  const byId = new Map<string, { status: string; amount: number; owned: boolean; compensated: boolean }>()
  let recordsReadable = true
  for (const r of f.refunds) {
    const status = r.status, amount = r.amountPaise
    if ((status !== 'processed' && status !== 'pending' && status !== 'failed') || !isAmount(amount) || amount === 0) {
      recordsReadable = false; u(`refund:${r.id}`, 'unreadable_status_or_amount'); continue
    }
    const recovery = r.accountingRecovery as { conflict?: unknown } | undefined
    if (recovery?.conflict) amounts.conflictedRefunds.push(r.id)
    const compensated = status === 'failed' && !!r.compensation
    const owned = r.initiatedBy !== 'webhook' && r.reservationReleased !== true
    byId.set(r.id, { status, amount, owned, compensated })
    if (status === 'processed') amounts.accountedPaise += amount
    else if (compensated) amounts.compensatedPaise += amount
    else if (status === 'failed') amounts.failedPaise += amount
    else { amounts.unresolvedPaise += amount; if (owned) amounts.reservedPaise += amount }
  }

  // ── attempts ──
  const attempts = f.donation.refundAttempts
  let attemptsReadable = true
  if (attempts !== undefined && (attempts === null || typeof attempts !== 'object')) { attemptsReadable = false; u('refundAttempts', 'not_a_map') }
  const linkedBy = new Map<string, string[]>()
  if (attemptsReadable && attempts) {
    for (const [aid, raw] of Object.entries(attempts as Record<string, unknown>)) {
      const a = raw as { status?: unknown; amountPaise?: unknown; refundId?: unknown } | null
      if (!a || typeof a.status !== 'string' || !KNOWN_ATTEMPT.has(a.status) || !isAmount(a.amountPaise)) { attemptsReadable = false; u(`attempt:${aid}`, 'unreadable_status_or_amount'); continue }
      if (OPEN_ATTEMPT.has(a.status)) amounts.reservedPaise += a.amountPaise
      if (a.status === 'linked') {
        if (typeof a.refundId !== 'string' || !a.refundId) { m(`attemptLink:${aid}`, 1, 0); continue }
        linkedBy.set(a.refundId, [...(linkedBy.get(a.refundId) ?? []), aid])
        if (!f.capped.refunds) {
          const rec = byId.get(a.refundId)
          if (!rec && recordsReadable) m(`attemptLink:${aid}`, 1, 0)                    // names a refund with no record
          else if (rec && rec.amount !== a.amountPaise) m(`attemptAmount:${aid}`, a.amountPaise, rec.amount)
        }
      }
    }
  }
  for (const [rid, aids] of linkedBy) if (aids.length > 1) m(`attemptLinkDuplicate:${rid}`, 1, aids.length)

  // ── the donation's own fields ──
  const hasActivity = f.refunds.length > 0 || (attempts && typeof attempts === 'object' && Object.keys(attempts).length > 0)
  const refunded = f.donation.refundedAmountPaise, reserved = f.donation.pendingRefundPaise
  const recordsComplete = !f.capped.refunds && recordsReadable
  if (refunded === undefined) { if (hasActivity) u('refundedAmountPaise', 'field_missing') }
  else if (!isAmount(refunded)) u('refundedAmountPaise', 'not_a_number')
  else if (recordsComplete && refunded !== amounts.accountedPaise) m('refundedAmountPaise', amounts.accountedPaise, refunded)
  if (reserved === undefined) { if (hasActivity) u('pendingRefundPaise', 'field_missing') }
  else if (!isAmount(reserved)) u('pendingRefundPaise', 'not_a_number')
  else if (recordsComplete && attemptsReadable && reserved !== amounts.reservedPaise) m('pendingRefundPaise', amounts.reservedPaise, reserved)

  // ── ledger rows ──
  const rows = new Map(f.ledgerRows.map(r => [r.id, r]))
  if (!f.capped.ledgerRows && recordsComplete) {
    const known = new Set<string>()
    for (const [rid, rec] of byId) {
      const rev = rows.get(`ptx_refund_${rid}`), comp = rows.get(`ptx_refundcomp_${rid}`)
      known.add(`ptx_refund_${rid}`); known.add(`ptx_refundcomp_${rid}`)
      if (rec.status === 'processed' || rec.compensated) {
        if (!rev) { m(`reversalRow:${rid}`, 1, 0); continue }
        if (rev.grossAmountPaise !== -rec.amount) m(`reversalGross:${rid}`, -rec.amount, Number(rev.grossAmountPaise))
        if (rec.compensated) {
          if (!comp) m(`compensationRow:${rid}`, 1, 0)
          else if (comp.netSettlementPaise !== -Number(rev.netSettlementPaise)) m(`compensationNet:${rid}`, -Number(rev.netSettlementPaise), Number(comp.netSettlementPaise))
        } else if (comp) m(`unexpectedCompensationRow:${rid}`, 0, 1)
      } else {
        if (rev) m(`unexpectedReversalRow:${rid}`, 0, 1)
        if (comp) m(`unexpectedCompensationRow:${rid}`, 0, 1)
      }
    }
    for (const rowId of rows.keys()) if (!known.has(rowId)) m(`orphanLedgerRow:${rowId}`, 0, 1)
  }

  // ── cumulative reversal against the original net (signed: reversal negative, compensation positive) ──
  if (!f.capped.ledgerRows && f.ledgerRows.length + byId.size > 0) {
    const nets = f.ledgerRows.map(r => r.netSettlementPaise)
    if (nets.some(v => typeof v !== 'number' || !Number.isSafeInteger(v))) u('reversedNet', 'unreadable_ledger_row')
    else if (!f.parent?.exists) { if (f.ledgerRows.length || amounts.accountedPaise) u('reversedNet', 'original_ledger_row_missing') }
    else if (!isAmount(f.parent.netSettlementPaise) || !isAmount(f.donation.amountPaise) || f.donation.amountPaise === 0) u('reversedNet', 'original_net_or_gross_unreadable')
    else if (recordsComplete) {
      const net = f.parent.netSettlementPaise as number, gross = f.donation.amountPaise as number
      const reversed = (nets as number[]).reduce((s, v) => s - v, 0)
      amounts.reversedNetPaise = reversed
      const k = [...byId.values()].filter(r => r.status === 'processed').length
      // A gap of at most k paisa (one per accounted refund) is what pre-Phase-3.3 per-refund rounding could leave,
      // in either direction: reported as LEGACY residue. Anything larger, or a negative total, is a mismatch.
      if (reversed < 0) m('reversedNetTotal', 0, reversed)
      else if (amounts.accountedPaise >= gross) {
        const residue = net - reversed
        if (residue !== 0) m(Math.abs(residue) <= k ? 'legacyRoundingResidue' : 'reversedNetTotal', net, reversed)
      } else if (reversed > net) {
        m(reversed - net <= k ? 'legacyRoundingResidue' : 'reversedNetTotal', net, reversed)
      } else {
        const share = proportionalReversal(gross, net, amounts.accountedPaise)
        if (Math.abs(reversed - share) > k) m('reversedNetProportion', share, reversed)
      }
    }
  }
  return verdict()
}

/** READ-ONLY — the facts for one donation (bounded reads; equality filters only — single-field indexes). */
export async function readDonationRefundFacts(donationId: string, donation: DonationRefundFacts['donation']): Promise<DonationRefundFacts> {
  const refundSnap = await adminDb.collection('donationRefunds').where('donationId', '==', donationId).limit(DONATION_RECORDS_CAP + 1).get()
  const attempts = donation.refundAttempts && typeof donation.refundAttempts === 'object' ? Object.keys(donation.refundAttempts as object).length : 0
  const active = refundSnap.size > 0 || attempts > 0 || (donation.refundedAmountPaise ?? 0) !== 0 || (donation.pendingRefundPaise ?? 0) !== 0
  if (!active) return { donationId, donation, refunds: [], ledgerRows: [], parent: null, capped: { refunds: false, ledgerRows: false } }
  const [rowSnap, parentSnap] = await Promise.all([
    adminDb.collection('platformTransactions').where('parentTransactionId', '==', `ptx_${donationId}`).limit(DONATION_RECORDS_CAP + 1).get(),
    adminDb.doc(`platformTransactions/ptx_${donationId}`).get(),
  ])
  return {
    donationId, donation,
    refunds: refundSnap.docs.slice(0, DONATION_RECORDS_CAP).map(d => ({ id: d.id, ...d.data() })),
    ledgerRows: rowSnap.docs.slice(0, DONATION_RECORDS_CAP).map(d => ({ id: d.id, ...d.data() })),
    parent: { exists: parentSnap.exists, netSettlementPaise: parentSnap.get('netSettlementPaise') },
    capped: { refunds: refundSnap.size > DONATION_RECORDS_CAP, ledgerRows: rowSnap.size > DONATION_RECORDS_CAP },
  }
}

/** One donation's verdict (read-only). A donation with no refund activity is clean without further reads. */
export async function verifyDonationRefunds(donationId: string): Promise<DonationRefundVerdict> {
  const snap = await adminDb.doc(`donations/${donationId}`).get()
  if (!snap.exists) {
    return { status: 'unverifiable', mismatches: [], unverifiable: [unverifiable('donation', donationId, 'donation', 'not_found')],
      amounts: { accountedPaise: 0, reservedPaise: 0, failedPaise: 0, compensatedPaise: 0, unresolvedPaise: 0, conflictedRefunds: [], reversedNetPaise: null } }
  }
  return evaluateDonationRefundIntegrity(await readDonationRefundFacts(donationId, snap.data() as DonationRefundFacts['donation']))
}

/**
 * The global reconciler's donation pass: one bounded, cursor-resumed page of donations in id order (each
 * costs one refund-record query; donations with refund activity two more reads). Report-only.
 */
export async function reconcileDonationRefunds(opts?: ReconcileOptions): Promise<ReconcileResult> {
  const pageSize = opts?.limit ?? DONATION_RECON_PAGE
  const budgetMs = opts?.budgetMs ?? RECON_BUDGET_MS
  const started = Date.now()
  const cursorKey = 'recon:donation-refunds'
  const after = await readCursor(cursorKey)
  let q = adminDb.collection('donations').orderBy(FieldPath.documentId()).limit(pageSize)
  if (after) q = q.startAfter(after)
  const page = await q.get()
  const mismatches: CounterMismatch[] = []
  const unv: ReconcileUnverifiable[] = []
  let scanned = 0, lastDone: string | null = null
  for (const doc of page.docs) {
    if (Date.now() - started > budgetMs) break
    scanned++
    try {
      const v = evaluateDonationRefundIntegrity(await readDonationRefundFacts(doc.id, doc.data() as DonationRefundFacts['donation']))
      mismatches.push(...v.mismatches); unv.push(...v.unverifiable)
    } catch (err) {
      unv.push(unverifiable('donation', doc.id, 'check', `failed:${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`))
      captureError(err, { scope: 'global_reconciliation', entityType: 'donation', donationId: doc.id })
    }
    lastDone = doc.id
  }
  const finishedPage = scanned === page.size
  // Phase 3.9 — a budget stop leaves part of the page UNCHECKED: reported as unverifiable, never as clean
  if (!finishedPage) unv.push(unverifiable('donation', 'donations', `scan:${cursorKey}`, `budget_exhausted_after:${lastDone ?? after ?? 'start'}`))
  // a full page resumes after its last id; a short page wraps; a budget stop resumes after the last DONE id
  await writeCursor(cursorKey, finishedPage ? (page.size === pageSize ? lastDone : null) : (lastDone ?? after))
  return { entityType: 'donation', scanned, mismatches, unverifiable: unv, repaired: 0 }
}
