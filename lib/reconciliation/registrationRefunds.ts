// Phase 3.8 · C — REGISTRATION refund reconciliation, READ-ONLY and report-only.
//
// Per payment (paymentIntents/{orderId}) it compares what the refund engine records:
//   • registrationRefunds records of the payment (gatewayOrderId) — each non-failed one must be COUNTED in
//     paymentIntents.gatewayRefundsPaise at its own amount once the gateway webhook has had time to arrive
//     (REFUND_COUNT_GRACE_MS: the organizer path records first, the refund.processed webhook counts it); a
//     failed one must not be counted; every counted id must have a record
//   • the cumulative counted amount against the charge: never above it; equal to it ⇔ gatewayRefundFullBy set
//   • the original ledger row ptx_{registrationId}: a FULL refund reverses it in place (status refunded) —
//     unless that reversal is queued in refundLedgerReconciliation (then unverifiable, not a mismatch); a row
//     reversed in place with no counted refund and no record is a reversal without a refund (disputes aside)
//   • a PARTIAL refund: the unreleased row must be held (releaseHold.refundIds includes it); a released row
//     must carry the alreadyReleased marker — and a partial refund of RELEASED money is reported as
//     `m4PartialRefundOnReleasedFunds`: the KNOWN, policy-dependent gap (no partial-registration ledger model
//     exists; the organizer still holds that money). Reported, never "fixed".
//   • the registration: refunded on a full refund; not flipped to refunded by a partial one
// Missing or contradictory evidence is unverifiable. Nothing is written; no ledger model is invented.

import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'
import {
  mismatch, unverifiable, RECON_BUDGET_MS,
  type CounterMismatch, type ReconcileOptions, type ReconcileResult, type ReconcileUnverifiable,
} from '@/lib/reconciliation/types'

/** The refund.processed webhook normally counts a refund within minutes; a day without it is a finding. */
export const REFUND_COUNT_GRACE_MS = 24 * 60 * 60 * 1000
export const REGISTRATION_RECORDS_CAP = 100
export const REGISTRATION_RECON_PAGE = 200

type Doc = { id: string } & Record<string, unknown>
export interface RegistrationRefundFacts {
  orderId: string
  intent: Doc | null
  records: Doc[]
  recordsCapped: boolean
  ptx: Doc | null
  registration: Doc | null
  reversalQueued: boolean
  nowMs: number
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const ms = (v: unknown) => { const t = (v as { toMillis?: () => number } | null | undefined)?.toMillis?.(); return typeof t === 'number' ? t : null }

/** PURE — the verdict for one payment's refunds. Entity = the registration (or `order:{id}` when unknown). */
export function evaluateRegistrationRefunds(f: RegistrationRefundFacts): { mismatches: CounterMismatch[]; unverifiable: ReconcileUnverifiable[] } {
  const regId = typeof f.intent?.registrationId === 'string' && f.intent.registrationId ? f.intent.registrationId : null
  const entity = regId ?? `order:${f.orderId}`
  const out: CounterMismatch[] = [], unv: ReconcileUnverifiable[] = []
  const m = (field: string, expected: number, actual: number) => out.push(mismatch('registration', entity, field, expected, actual, false))
  const u = (check: string, reason: string) => unv.push(unverifiable('registration', entity, check, reason))
  const done = () => ({ mismatches: out, unverifiable: unv })

  if (!f.intent) { u('intent', 'not_found'); return done() }
  if (f.recordsCapped) { u('refund_records', `more_than_${REGISTRATION_RECORDS_CAP}`); return done() }
  const charged = f.intent.amount
  if (!isInt(charged) || charged <= 0) { u('intent.amount', 'unreadable'); return done() }
  const countedRaw = f.intent.gatewayRefundsPaise
  if (countedRaw !== undefined && (countedRaw === null || typeof countedRaw !== 'object')) { u('gatewayRefundsPaise', 'not_a_map'); return done() }
  const counted = new Map<string, number>()
  for (const [id, v] of Object.entries((countedRaw ?? {}) as Record<string, unknown>)) {
    if (!isInt(v) || v <= 0) { u(`counted:${id}`, 'unreadable'); return done() }
    counted.set(id, v)
  }

  // ── records ↔ counted ──
  const byId = new Map(f.records.map(r => [r.id, r]))
  for (const r of f.records) {
    if (!isInt(r.amountPaise) || r.amountPaise <= 0 || typeof r.status !== 'string') { u(`refund:${r.id}`, 'unreadable'); continue }
    if (r.status === 'failed') { if (counted.has(r.id)) m(`failedRefundCounted:${r.id}`, 0, counted.get(r.id)!); continue }
    const c = counted.get(r.id)
    if (c === undefined) {
      const created = ms(r.createdAt)
      if (created !== null && f.nowMs - created >= REFUND_COUNT_GRACE_MS) m(`refundNotCounted:${r.id}`, r.amountPaise, 0)
      else u(`refund:${r.id}`, created === null ? 'created_at_unreadable' : 'awaiting_gateway_webhook')
    } else if (c !== r.amountPaise) m(`refundAmount:${r.id}`, r.amountPaise, c)
  }
  for (const id of counted.keys()) if (!byId.has(id)) m(`countedWithoutRecord:${id}`, 1, 0)

  // ── cumulative ──
  const total = [...counted.values()].reduce((s, v) => s + v, 0)
  const fullBy = typeof f.intent.gatewayRefundFullBy === 'string' && f.intent.gatewayRefundFullBy ? f.intent.gatewayRefundFullBy : null
  if (total > charged) m('cumulativeExceedsCharge', charged, total)
  if (total === charged && (!fullBy || !counted.has(fullBy))) m('fullRefundMarkerMissing', 1, 0)
  if (total < charged && fullBy) m('fullRefundMarkerStale', 0, 1)

  // ── ledger + registration ──
  const ptx = f.ptx
  const reg = f.registration
  const reversed = ptx?.status === 'refunded' || ptx?.status === 'disputed'
  if (total >= charged && total > 0) {
    if (!ptx) u('ledger', regId ? 'ledger_row_missing' : 'registration_unknown')
    else if (!reversed) { if (f.reversalQueued) u('ledger', 'ledger_reversal_queued'); else m('missingLedgerReversal', isInt(ptx.netSettlementPaise) ? ptx.netSettlementPaise : 0, 0) }
    if (reg && reg.paymentStatus !== 'refunded') m('registrationNotRefunded', 1, 0)
  } else if (total > 0) {
    if (!ptx) u('ledger', regId ? 'ledger_row_missing' : 'registration_unknown')
    else if (!reversed) {
      const hold = (ptx.releaseHold ?? null) as { refundIds?: unknown; alreadyReleased?: unknown } | null
      const holdIds = Array.isArray(hold?.refundIds) ? hold!.refundIds as unknown[] : []
      const partialIds = [...counted.keys()]
      if (ptx.releaseStatus === 'released') {
        if (hold?.alreadyReleased !== true) m('partialRefundMarkerMissing', 1, 0)
        // the KNOWN policy-dependent gap (M4): money refunded from a settlement already released to the organizer
        m('m4PartialRefundOnReleasedFunds', 0, total)
      } else if (ptx.releaseStatus !== 'held' || partialIds.some(id => !holdIds.includes(id))) m('partialRefundNotHeld', 1, 0)
    }
    if (reg && reg.paymentStatus === 'refunded') m('registrationRefundedOnPartial', 0, 1)
  } else if (ptx?.status === 'refunded' && f.records.every(r => r.status === 'failed')) {
    m('reversalWithoutRefund', 0, isInt(ptx.netSettlementPaise) ? ptx.netSettlementPaise : 1)
  }
  return done()
}

/** READ-ONLY — the facts for one payment. */
export async function readRegistrationRefundFacts(orderId: string, nowMs = Date.now()): Promise<RegistrationRefundFacts> {
  const intentSnap = await adminDb.doc(`paymentIntents/${orderId}`).get()
  const intent = intentSnap.exists ? { id: intentSnap.id, ...intentSnap.data() } as Doc : null
  const recSnap = await adminDb.collection('registrationRefunds').where('gatewayOrderId', '==', orderId).limit(REGISTRATION_RECORDS_CAP + 1).get()
  const regId = typeof intent?.registrationId === 'string' && intent.registrationId ? intent.registrationId : null
  const [ptxSnap, regSnap, queueSnap] = regId
    ? await Promise.all([
      adminDb.doc(`platformTransactions/ptx_${regId}`).get(), adminDb.doc(`registrations/${regId}`).get(), adminDb.doc(`refundLedgerReconciliation/${regId}`).get(),
    ])
    : [null, null, null]
  const queued = !!queueSnap?.exists && (queueSnap.get('status') === 'pending' || queueSnap.get('status') === 'needs_review')
  return {
    orderId, intent,
    records: recSnap.docs.slice(0, REGISTRATION_RECORDS_CAP).map(d => ({ id: d.id, ...d.data() })),
    recordsCapped: recSnap.size > REGISTRATION_RECORDS_CAP,
    ptx: ptxSnap?.exists ? { id: ptxSnap.id, ...ptxSnap.data() } : null,
    registration: regSnap?.exists ? { id: regSnap.id, ...regSnap.data() } : null,
    reversalQueued: queued, nowMs,
  }
}

/**
 * The global run's registration pass: one bounded, cursor-resumed page of registrationRefunds (id order),
 * each DISTINCT payment evaluated once per run; then one page of registration ledger rows reversed in place
 * (status 'refunded', sourceType 'registration') whose payment has no refund record (reversal without a refund).
 */
export async function reconcileRegistrationRefunds(opts?: ReconcileOptions): Promise<ReconcileResult> {
  const pageSize = opts?.limit ?? REGISTRATION_RECON_PAGE
  const deadline = Date.now() + (opts?.budgetMs ?? RECON_BUDGET_MS)
  const mismatches: CounterMismatch[] = []
  const unv: ReconcileUnverifiable[] = []
  const seen = new Set<string>()
  let scanned = 0
  const evaluate = async (orderId: string) => {
    if (seen.has(orderId)) return
    seen.add(orderId)
    try {
      const v = evaluateRegistrationRefunds(await readRegistrationRefundFacts(orderId))
      mismatches.push(...v.mismatches); unv.push(...v.unverifiable)
    } catch (err) {
      unv.push(unverifiable('registration', `order:${orderId}`, 'check', `failed:${err instanceof Error ? err.message.slice(0, 100) : 'unknown'}`))
      captureError(err, { scope: 'global_reconciliation', entityType: 'registration', orderId })
    }
  }
  const pass = async (cursorKey: string, query: FirebaseFirestore.Query, toOrder: (d: FirebaseFirestore.QueryDocumentSnapshot) => Promise<string | null>, hint: string) => {
    const after = await readCursor(cursorKey)
    let q = query.orderBy(FieldPath.documentId())
    if (after) q = q.startAfter(after)
    const page = await q.limit(pageSize).get()
    if (page.empty) { await writeCursor(cursorKey, null); return }
    let last: string | null = null
    for (const d of page.docs) {
      if (Date.now() > deadline) break
      scanned++
      const orderId = await toOrder(d)
      if (orderId) await evaluate(orderId)
      else unv.push(unverifiable('registration', hint === 'records' ? `refund:${d.id}` : `row:${d.id}`, hint, 'order_unknown'))
      last = d.id
    }
    const finished = last === page.docs[page.docs.length - 1].id
    if (!finished) unv.push(unverifiable('registration', hint, `scan:${cursorKey}`, `budget_exhausted_after:${last ?? after ?? 'start'}`))
    await writeCursor(cursorKey, finished ? (page.size === pageSize ? last : null) : (last ?? after))
  }
  await pass('recon:registration-refund-records', adminDb.collection('registrationRefunds'),
    async d => (typeof d.get('gatewayOrderId') === 'string' && d.get('gatewayOrderId')) ? d.get('gatewayOrderId') as string : null, 'records')
  await pass('recon:registration-reversed-rows',
    adminDb.collection('platformTransactions').where('status', '==', 'refunded').where('sourceType', '==', 'registration'),
    async d => {
      const order = d.get('gatewayOrderId')
      if (typeof order === 'string' && order) return order
      const regId = d.get('sourceId')
      if (typeof regId !== 'string' || !regId) return null
      const intents = await adminDb.collection('paymentIntents').where('registrationId', '==', regId).limit(1).get()
      return intents.empty ? null : intents.docs[0].id
    }, 'rows')
  return { entityType: 'registration', scanned, mismatches, unverifiable: unv, repaired: 0 }
}
