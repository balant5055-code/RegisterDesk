// F1 follow-up · Super Admin review of SETTLEMENT HOLDS caused by refunds. Server-only.
//
// A refund of a registration payment that RegisterDesk could not apply in full (a partial refund, one
// exceeding the charge, one after a full refund, or a contradictory one) holds that payment's settlement
// transaction: `platformTransactions/{ptx}.releaseStatus = 'held'` + `releaseHold` (lib/refunds/
// registrationRefunds.ts accumulatePaymentRefund). The release job only takes 'pending', so held funds
// stay in the organizer's pending bucket.
//
// ═══ THE OUTCOMES THIS WORKFLOW OFFERS — and only these ══════════════════════
//   record_review        — a review note (who, when, why). The hold STAYS. Always available.
//   lift_hold_no_refund  — the hold is lifted (the transaction returns to 'pending', i.e. the NORMAL
//                          T+2 release) ONLY when the evidence proves no refund money left:
//                            • every refund on the hold is recorded FAILED,
//                            • no refund record of this payment still counts as money out,
//                            • the payment's counted refunds (paymentIntents.gatewayRefundsPaise) are empty,
//                            • Razorpay (read-only refund lookup) shows no non-failed refund, and
//                            • the transaction is still 'held' and 'completed' (never 'released' / reversed).
//                          The original settlement then stands exactly as it was credited. No money moves
//                          here and no wallet changes; the hold's evidence is kept in releaseHoldHistory.
//
// ═══ DELIBERATELY NOT OFFERED ═════════════════════════════════════════════════
// Releasing a settlement whose payment WAS partially refunded — whether by debiting the organizer the
// refunded part, absorbing it as a platform loss, or "releasing anyway" — needs a business decision on
// who bears a partial refund and a partial-ledger model that does not exist. Such a hold stays held;
// `record_review` documents the case. A settlement released BEFORE the refund was seen cannot be recalled
// here either: it can only be reviewed.
//
// Every decision is ONE transaction that re-reads the hold, the refund records, the intent and the
// release state, refuses a stale screen (the hold's refund set must equal what the operator saw), and
// stages the audit row IN the transaction — an audit failure means nothing was decided. A duplicate
// submission (same requestId) is answered from the existing audit row without a second change.

import { FieldValue, FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { stageAdminAudit } from '@/lib/admin/audit'
import { REGISTRATION_REFUNDS_COLLECTION } from '@/lib/refunds/registrationRefunds'
import { evaluateAttemptEvidence } from '@/lib/donations/refundAttemptEvidence'

const DONATION_REFUNDS_COLLECTION = 'donationRefunds'
/** A donation settlement (its refunds are donationRefunds records, not registration refunds). */
const isDonationPtx = (ptx: Record<string, unknown>): boolean => ptx.sourceType === 'donation'
/** A donation's refunds that counted as money out: the processed gross on the donation (a missing donation reads as unknown → not liftable). */
const donationCountedOf = (donation: Record<string, unknown> | undefined): number => {
  if (!donation) return -1
  const v = donation.refundedAmountPaise
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
import { classifyGatewayRefunds } from '@/lib/licensing/licenceRefundHold'
import type { RegistrationRefundDocument } from '@/lib/refunds/types'
import { evaluateLift, reviewsClosedByLift, attemptLiftState, type RefundHoldOutcome } from './refundHoldRules'
import { REFUND_HOLD_MIN_RELEASE_AGE_MS } from '@/lib/licensing/licenceRefundHold'
export { REFUND_HOLD_OUTCOMES, isRefundHoldOutcome, evaluateLift, type RefundHoldOutcome } from './refundHoldRules'

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const PTX_ID_RE = /^ptx_[A-Za-z0-9_-]{1,200}$/

export interface RefundHoldRefundView {
  refundId: string; amountPaise: number | null; status: string | null
  reviewRequired: string | null; reviewReasons: string[]; createdAt: string | null
}
export interface RefundHoldView {
  ptxId: string; registrationId: string | null; organizerUid: string | null; eventSlug: string | null
  orderId: string | null; paymentId: string | null
  chargedPaise: number | null; netSettlementPaise: number | null
  ledgerStatus: string | null; releaseStatus: string | null
  hold: { refundIds: string[]; heldAt: string | null; alreadyReleased: boolean; attemptIds?: string[] }
  refunds: RefundHoldRefundView[]
  /** Counted refunds of the payment (paise) — the intent's own record. */
  countedRefundsPaise: number
  reviews: Array<{ requestId: string; by: string | null; at: string | null; reason: string | null }>
  /** Whether `lift_hold_no_refund` is possible on RegisterDesk's own records (the gateway is checked on submit). */
  liftable: { ok: boolean; why: string | null }
}

const iso = (v: unknown): string | null => v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const sortedIds = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []).slice().sort()
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

const countedOf = (intent: Record<string, unknown> | undefined): number => {
  const m = intent?.gatewayRefundsPaise
  if (!m || typeof m !== 'object') return 0
  return Object.values(m as Record<string, unknown>).reduce<number>((s, v) => s + (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0), 0)
}

async function buildView(ptxId: string, ptx: Record<string, unknown>): Promise<RefundHoldView> {
  const hold = (ptx.releaseHold ?? {}) as { refundIds?: unknown; heldAt?: unknown; alreadyReleased?: unknown }
  const holdRefundIds = sortedIds(hold.refundIds)
  const paymentId = str(ptx.gatewayPaymentId)
  const orderId = str(ptx.gatewayOrderId)
  // Phase 2.1 — a DONATION settlement's refunds live in donationRefunds (by donationId) and its counted
  // refunds on the donation itself; a registration's in registrationRefunds + the payment intent.
  const donationId = isDonationPtx(ptx) ? str(ptx.sourceId) : null
  const col = donationId ? DONATION_REFUNDS_COLLECTION : REGISTRATION_REFUNDS_COLLECTION
  const [intentSnap, payRefunds, held, donationSnap] = await Promise.all([
    !donationId && orderId ? adminDb.doc(`paymentIntents/${orderId}`).get() : Promise.resolve(null),
    donationId ? adminDb.collection(col).where('donationId', '==', donationId).limit(50).get()
      : paymentId ? adminDb.collection(col).where('gatewayPaymentId', '==', paymentId).limit(50).get() : Promise.resolve(null),
    holdRefundIds.length ? adminDb.getAll(...holdRefundIds.map(id => adminDb.doc(`${col}/${id}`))) : Promise.resolve([]),
    donationId ? adminDb.doc(`donations/${donationId}`).get() : Promise.resolve(null),
  ])
  const intent = intentSnap?.exists ? intentSnap.data() as Record<string, unknown> : undefined
  const donation = donationSnap?.exists ? donationSnap.data() as Record<string, unknown> : undefined
  const records = new Map<string, RegistrationRefundDocument>()
  for (const d of payRefunds?.docs ?? []) records.set(d.id, d.data() as RegistrationRefundDocument)
  for (const d of held) if (d.exists) records.set(d.id, d.data() as RegistrationRefundDocument)
  const reviewsMap = (ptx.releaseHoldReviews ?? {}) as Record<string, { by?: unknown; at?: unknown; reason?: unknown }>
  const holdAttemptIds = sortedIds((hold as { attemptIds?: unknown }).attemptIds)
  const attempts = (donation?.refundAttempts ?? {}) as Record<string, { status?: unknown; startedAt?: unknown; amountPaise?: unknown } | undefined>
  const attemptState = attemptLiftState(holdAttemptIds, attempts, Date.now(), REFUND_HOLD_MIN_RELEASE_AGE_MS)
  const lift = evaluateLift({
    ledgerStatus: ptx.status, releaseStatus: ptx.releaseStatus, alreadyReleased: hold.alreadyReleased === true,
    holdRefundIds, paymentRefunds: [...records.entries()].map(([id, r]) => ({ id, status: r.status })),
    countedRefundsPaise: donationId ? donationCountedOf(donation) : countedOf(intent),
    holdAttemptIds, attemptBlock: attemptState.block,
    manualRefundHold: !!(ptx as { manualRefundHold?: unknown }).manualRefundHold,
  })
  return {
    ptxId, registrationId: str(ptx.sourceId), organizerUid: str(ptx.organizerUid), eventSlug: str(ptx.entityId),
    orderId, paymentId, chargedPaise: num(donationId ? donation?.amountPaise : intent?.amount), netSettlementPaise: num(ptx.netSettlementPaise),
    ledgerStatus: str(ptx.status), releaseStatus: str(ptx.releaseStatus),
    hold: { refundIds: holdRefundIds, heldAt: iso(hold.heldAt), alreadyReleased: hold.alreadyReleased === true, ...(holdAttemptIds.length ? { attemptIds: holdAttemptIds } : {}) },
    refunds: [...records.entries()].map(([id, r]) => ({
      refundId: id, amountPaise: num(r.amountPaise), status: str(r.status),
      reviewRequired: str(r.reviewRequired), reviewReasons: Array.isArray(r.reviewReasons) ? r.reviewReasons.map(String) : [],
      createdAt: iso(r.createdAt),
    })).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')),
    countedRefundsPaise: donationId ? donationCountedOf(donation) : countedOf(intent),
    reviews: Object.entries(reviewsMap).map(([requestId, r]) => ({ requestId, by: str(r.by), at: iso(r.at), reason: str(r.reason) }))
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')),
    liftable: lift.ok ? { ok: true, why: null } : { ok: false, why: lift.why },
  }
}

/** Every settlement transaction carrying a refund hold (held now, or flagged after release). Bounded. */
/**
 * One page of held settlements. Phase 3.3 — ordered by document id (equality + __name__: served by the
 * automatic single-field index, no composite index) with a cursor (the last id of the previous page), so
 * paging is stable: no hold is skipped or shown twice while the set is unchanged. `truncated` ⇔ more pages
 * remain (`nextCursor`). Ordering by heldAt would need a composite index (not deployed — see the Phase 3.3
 * report); document-id order is used until it is.
 */
export async function listRefundHolds(limit = 100, cursor: string | null = null): Promise<{ items: RefundHoldView[]; truncated: boolean; nextCursor: string | null }> {
  const cap = Math.min(Math.max(limit, 1), 200)
  let q = adminDb.collection('platformTransactions').where('releaseHold.reason', '==', 'refund_review').orderBy(FieldPath.documentId())
  if (cursor) {
    if (!PTX_ID_RE.test(cursor)) throw new Error('INVALID_CURSOR')
    q = q.startAfter(cursor)
  }
  const snap = await q.limit(cap + 1).get()
  const docs = snap.docs.slice(0, cap)
  const more = snap.size > cap
  return {
    items: await Promise.all(docs.map(d => buildView(d.id, d.data() as Record<string, unknown>))),
    truncated: more, nextCursor: more ? docs[docs.length - 1].id : null,
  }
}

export async function getRefundHold(ptxId: string): Promise<RefundHoldView | null> {
  if (!PTX_ID_RE.test(ptxId)) return null
  const s = await adminDb.doc(`platformTransactions/${ptxId}`).get()
  if (!s.exists || !(s.data() as { releaseHold?: unknown }).releaseHold) return null
  return buildView(ptxId, s.data() as Record<string, unknown>)
}

export type ResolveRefundHoldResult =
  | { ok: true; outcome: RefundHoldOutcome; duplicate: boolean; releaseStatus: string }
  | { ok: false; status: number; code: string; error: string; why?: string }

/**
 * Apply ONE explicit Super Admin decision. Validation of the caller (Super Admin), the reason and the
 * confirmation happens in the route; this re-validates the identifiers and does the transactional work.
 */
export async function resolveRefundHold(input: {
  ptxId: string; outcome: RefundHoldOutcome; reason: string; adminUid: string
  /** The hold's refund ids as the operator saw them — a stale screen is refused. */
  expectedRefundIds: string[]
  /** Idempotency key for this submission (a duplicate click / retry returns the first result). */
  requestId: string
}): Promise<ResolveRefundHoldResult> {
  if (!PTX_ID_RE.test(input.ptxId)) return { ok: false, status: 400, code: 'INVALID_ID', error: 'Invalid settlement transaction id.' }
  if (!REQUEST_ID_RE.test(input.requestId)) return { ok: false, status: 400, code: 'INVALID_REQUEST_ID', error: 'A requestId (8–64 characters) is required.' }
  const expected = sortedIds(input.expectedRefundIds)
  const ptxRef = adminDb.doc(`platformTransactions/${input.ptxId}`)
  const auditId = `settlement_hold_${input.ptxId}_${input.requestId}`.slice(0, 1400)
  const auditRef = adminDb.collection('adminAuditLogs').doc(auditId)

  // Gateway evidence (read-only refund lookup) for a lift — gathered OUTSIDE the transaction (a
  // retried transaction must never call out), required to show NO non-failed refund. Anything else —
  // a refund, a partial refund, an unreadable answer — refuses the lift.
  let gatewayEvidence: { refundsAtGateway: 'none' } | null = null
  // Phase 3.3 — the open donation refund attempts THIS lookup proved created no refund (evaluateAttemptEvidence
  // 'none'). Only these may be concluded resolved_none in the transaction below.
  const attemptsVerifiedNone = new Set<string>()
  if (input.outcome === 'lift_hold_no_refund') {
    const pre = await ptxRef.get()
    const preData = pre.exists ? pre.data() as Record<string, unknown> : null
    const paymentId = preData ? str(preData.gatewayPaymentId) : null
    if (!pre.exists || !paymentId) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Settlement transaction not found.' }
    let outcome: ReturnType<typeof classifyGatewayRefunds>
    let lookup: unknown = null
    try {
      const { razorpay } = await import('@/lib/razorpay/client')
      lookup = await razorpay.payments.fetchMultipleRefund(paymentId)
      outcome = classifyGatewayRefunds(lookup, 1)
    } catch { outcome = { kind: 'unknown' } }
    if (outcome.kind === 'unknown') return { ok: false, status: 503, code: 'GATEWAY_UNVERIFIED', error: 'Razorpay could not confirm the refunds of this payment. Nothing was changed; try again later.' }
    if (outcome.kind !== 'none') return { ok: false, status: 409, code: 'REFUND_FOUND_AT_GATEWAY', error: 'Razorpay shows a refund of this payment — money left. The hold stays; record a review instead.', why: 'refund_at_gateway' }
    // Phase 3.3 — "no non-failed refund" is NOT "no refund": a FAILED refund created by an open attempt
    // must be linked to it (the attempt then concludes as that failed refund), never recorded as
    // resolved_none. Each open attempt on the hold is checked with the attempt-evidence evaluator; any
    // linked / contradictory / inconclusive answer refuses the lift (nothing changes).
    const donationId = preData && isDonationPtx(preData) ? str(preData.sourceId) : null
    const preAttemptIds = sortedIds(((preData?.releaseHold ?? null) as { attemptIds?: unknown } | null)?.attemptIds)
    if (donationId && preAttemptIds.length) {
      const [dPre, recordedSnap] = await Promise.all([
        adminDb.doc(`donations/${donationId}`).get(),
        adminDb.collection(DONATION_REFUNDS_COLLECTION).where('donationId', '==', donationId).limit(200).get(),
      ])
      const preAttempts = ((dPre.data() ?? {}).refundAttempts ?? {}) as Record<string, { status?: unknown } | undefined>
      const recorded = new Set(recordedSnap.docs.map(d => d.id))
      for (const id of preAttemptIds) {
        const st = preAttempts[id]?.status
        if (st !== 'submitting' && st !== 'unknown') continue   // concluded attempts are judged in the transaction
        const ev = evaluateAttemptEvidence(lookup, id, recorded)
        if (ev.kind === 'linked') {
          return { ok: false, status: 409, code: 'ATTEMPT_REFUND_AT_GATEWAY', why: 'attempt_refund_found',
            error: `Razorpay shows refund ${ev.refundId} (${ev.status}) created by refund attempt ${id}. It must be linked to that attempt, not recorded as "no refund". The hold stays.` }
        }
        if (ev.kind !== 'none') {
          return { ok: false, status: 409, code: 'ATTEMPT_EVIDENCE_UNCLEAR', why: `attempt_evidence_${ev.kind}`,
            error: `Razorpay's refunds of this payment do not prove that refund attempt ${id} created no refund (${ev.why}). The hold stays.` }
        }
        attemptsVerifiedNone.add(id)
      }
    }
    gatewayEvidence = { refundsAtGateway: 'none' }
  }

  return adminDb.runTransaction<ResolveRefundHoldResult>(async tx => {
    const [ptxSnap, prior] = await Promise.all([tx.get(ptxRef), tx.get(auditRef)])
    // Duplicate submission (same requestId): answered from the first decision; nothing changes again.
    if (prior.exists) {
      const p = prior.data() as { metadata?: { outcome?: unknown; releaseStatusAfter?: unknown } }
      if (p.metadata?.outcome !== input.outcome) return { ok: false, status: 409, code: 'REQUEST_ID_REUSED', error: 'This requestId was already used for a different decision.' }
      return { ok: true, outcome: input.outcome, duplicate: true, releaseStatus: String(p.metadata?.releaseStatusAfter ?? '') }
    }
    if (!ptxSnap.exists) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Settlement transaction not found.' }
    const ptx = ptxSnap.data() as Record<string, unknown>
    const hold = ptx.releaseHold as { refundIds?: unknown; heldAt?: unknown; alreadyReleased?: unknown; reason?: unknown } | undefined
    if (!hold) return { ok: false, status: 409, code: 'NO_HOLD', error: 'This settlement has no refund hold (it was already resolved).' }
    const current = sortedIds(hold.refundIds)
    // Stale screen / new refund evidence arrived during review → the operator must look again.
    if (!sameSet(current, expected)) {
      return { ok: false, status: 409, code: 'STALE_HOLD', error: 'The refunds on this hold changed since it was loaded. Reload and review again.' }
    }
    const paymentId = str(ptx.gatewayPaymentId)
    const orderId = str(ptx.gatewayOrderId)
    const donationId = isDonationPtx(ptx) ? str(ptx.sourceId) : null
    const col = donationId ? DONATION_REFUNDS_COLLECTION : REGISTRATION_REFUNDS_COLLECTION
    const donationSnap = donationId ? await tx.get(adminDb.doc(`donations/${donationId}`)) : null
    const [payRefundsSnap, intentSnap] = await Promise.all([
      donationId ? tx.get(adminDb.collection(col).where('donationId', '==', donationId).limit(50))
        : paymentId ? tx.get(adminDb.collection(col).where('gatewayPaymentId', '==', paymentId).limit(50)) : Promise.resolve(null),
      orderId ? tx.get(adminDb.doc(`paymentIntents/${orderId}`)) : Promise.resolve(null),
    ])
    const heldSnaps = current.length ? await Promise.all(current.map(id => tx.get(adminDb.doc(`${col}/${id}`)))) : []
    const statuses = new Map<string, unknown>()
    const recordsById = new Map<string, Record<string, unknown>>()
    for (const d of payRefundsSnap?.docs ?? []) { statuses.set(d.id, (d.data() as { status?: unknown }).status); recordsById.set(d.id, d.data()) }
    for (const d of heldSnaps) if (d.exists) { statuses.set(d.id, (d.data() as { status?: unknown }).status); recordsById.set(d.id, d.data()!) }
    const counted = donationId
      ? donationCountedOf(donationSnap?.exists ? donationSnap.data() as Record<string, unknown> : undefined)
      : countedOf(intentSnap?.exists && !donationId ? intentSnap.data() as Record<string, unknown> : undefined)
    const before = { releaseStatus: ptx.releaseStatus ?? null, ledgerStatus: ptx.status ?? null, refundIds: current, alreadyReleased: hold.alreadyReleased === true }
    const now = FieldValue.serverTimestamp()
    const correlation = { eventId: str(ptx.entityId) ?? undefined, organizerUid: str(ptx.organizerUid) ?? undefined, registrationId: str(ptx.sourceId) ?? undefined, orderId: orderId ?? undefined, paymentId: paymentId ?? undefined }

    if (input.outcome === 'record_review') {
      tx.set(ptxRef, { releaseHoldReviews: { [input.requestId]: { by: input.adminUid, at: now, reason: input.reason } }, updatedAt: now }, { merge: true })
      stageAdminAudit(tx, {
        adminUid: input.adminUid, actorRole: 'super_admin', action: 'settlement.refund_hold_reviewed',
        entityType: 'settlement', entityId: input.ptxId, reason: input.reason,
        changedFields: ['releaseHoldReviews'], before, after: before,
        metadata: { outcome: input.outcome, releaseStatusAfter: ptx.releaseStatus ?? null, refundStatuses: Object.fromEntries(statuses), countedRefundsPaise: counted },
        correlation,
      }, auditId)
      return { ok: true, outcome: input.outcome, duplicate: false, releaseStatus: String(ptx.releaseStatus ?? '') }
    }

    // lift_hold_no_refund — every condition re-checked on THIS transaction's reads.
    // Phase 2.2 — gateway refund attempts with no known refund id (donations): open ones are concluded
    // "no refund" only under PD-2 (≥ REFUND_HOLD_MIN_RELEASE_AGE_MS old; the gateway check above showed no
    // live refund on the payment), in THIS transaction, with their reservation freed and the evidence kept.
    const holdAttemptIds = sortedIds((hold as { attemptIds?: unknown }).attemptIds)
    const donationData = donationSnap?.exists ? donationSnap.data() as Record<string, unknown> : undefined
    const attempts = (donationData?.refundAttempts ?? {}) as Record<string, { status?: unknown; startedAt?: unknown; amountPaise?: unknown } | undefined>
    const attemptState = attemptLiftState(holdAttemptIds, attempts, Date.now(), REFUND_HOLD_MIN_RELEASE_AGE_MS)
    const lift = evaluateLift({
      ledgerStatus: ptx.status, releaseStatus: ptx.releaseStatus, alreadyReleased: hold.alreadyReleased === true,
      holdRefundIds: current, paymentRefunds: [...statuses.entries()].map(([id, status]) => ({ id, status })),
      countedRefundsPaise: counted,
      holdAttemptIds, attemptBlock: attemptState.block,
      manualRefundHold: !!(ptx as { manualRefundHold?: unknown }).manualRefundHold,
    })
    // Phase 3.3 (verification) — a donation refund the gateway reported CONTRADICTORY outcomes for keeps the
    // hold: the lift never settles a contradiction (the owner decision is reported, not invented).
    const conflicted = donationId ? [...recordsById.entries()].filter(([, r]) => !!(r.accountingRecovery as { conflict?: unknown } | undefined)?.conflict).map(([id]) => id) : []
    if (conflicted.length) {
      return { ok: false, status: 409, code: 'HOLD_NOT_LIFTABLE', why: 'refund_outcome_conflict',
        error: `Razorpay reported contradictory outcomes for refund ${conflicted.join(', ')}. The hold stays until that is decided; record a review instead.` }
    }
    // Phase 3.3 — an attempt concluded here must have been proven refund-free by the lookup above
    // (the hold or the attempt changed in between ⇒ the operator reloads).
    if (attemptState.open.some(id => !attemptsVerifiedNone.has(id))) {
      return { ok: false, status: 409, code: 'STALE_HOLD', error: 'The refund attempts on this hold changed since the gateway check. Reload and review again.' }
    }
    if (!lift.ok) {
      return { ok: false, status: 409, code: 'HOLD_NOT_LIFTABLE', why: lift.why,
        error: 'This hold cannot be lifted: RegisterDesk\'s records do not prove that no refund money left. It stays held; record a review instead.' }
    }
    // The reviews this evidence resolves are closed in the SAME transaction (reasons and details kept);
    // a contradiction the lift does not explain stays open and is named in the audit row.
    const reviews = donationId ? { close: [] as string[], keepOpen: [] as string[] } : reviewsClosedByLift([...recordsById.entries()].map(([id, r]) => ({ id, status: r.status, reviewOpen: r.reviewOpen, reviewRequired: r.reviewRequired, reviewReasons: r.reviewReasons })))
    for (const id of reviews.close) {
      const r = recordsById.get(id)!
      tx.set(adminDb.doc(`${REGISTRATION_REFUNDS_COLLECTION}/${id}`), {
        reviewOpen: false,
        reviewClosed: {
          at: now, by: input.adminUid, reason: input.reason,
          closedReasons: Array.isArray(r.reviewReasons) ? r.reviewReasons : [r.reviewRequired],
          evidence: { outcome: input.outcome, requestId: input.requestId, ptxId: input.ptxId, countedRefundsPaise: counted, ...gatewayEvidence },
        },
      }, { merge: true })
    }
    if (donationId && attemptState.open.length) {
      const freed = attemptState.open.reduce((sum, id) => sum + (typeof attempts[id]?.amountPaise === 'number' ? attempts[id]!.amountPaise as number : 0), 0)
      const pendingNow = typeof donationData?.pendingRefundPaise === 'number' ? donationData.pendingRefundPaise : 0
      const stillOpen = Object.entries(attempts).some(([id, a]) => !attemptState.open.includes(id) && (a?.status === 'submitting' || a?.status === 'unknown'))
      tx.update(adminDb.doc(`donations/${donationId}`), {
        ...Object.fromEntries(attemptState.open.flatMap(id => [
          [`refundAttempts.${id}.status`, 'resolved_none'],
          [`refundAttempts.${id}.resolvedAt`, now],
          [`refundAttempts.${id}.resolvedBy`, input.adminUid],
          [`refundAttempts.${id}.evidence`, { requestId: input.requestId, ...gatewayEvidence, minAgeMs: REFUND_HOLD_MIN_RELEASE_AGE_MS }],
        ])),
        pendingRefundPaise: FieldValue.increment(-Math.min(freed, pendingNow)),
        hasOpenRefundAttempt: stillOpen,
        updatedAt: now,
      })
    }
    tx.set(ptxRef, {
      releaseStatus: 'pending',
      releaseHold: FieldValue.delete(),
      // The hold's evidence is never erased: it moves to the history with the decision.
      releaseHoldHistory: { [input.requestId]: {
        hold: { reason: hold.reason ?? 'refund_review', refundIds: current, heldAt: hold.heldAt ?? null, ...(holdAttemptIds.length ? { attemptIds: holdAttemptIds } : {}) },
        outcome: input.outcome, by: input.adminUid, at: now, reason: input.reason,
        evidence: { refundStatuses: Object.fromEntries(statuses), countedRefundsPaise: counted, ...gatewayEvidence },
      } },
      updatedAt: now,
    }, { merge: true })
    stageAdminAudit(tx, {
      adminUid: input.adminUid, actorRole: 'super_admin', action: 'settlement.refund_hold_lifted',
      entityType: 'settlement', entityId: input.ptxId, reason: input.reason,
      changedFields: ['releaseStatus', 'releaseHold', 'releaseHoldHistory'],
      before, after: { ...before, releaseStatus: 'pending' },
      metadata: { outcome: input.outcome, releaseStatusAfter: 'pending', refundStatuses: Object.fromEntries(statuses), countedRefundsPaise: counted, ...gatewayEvidence, reviewsClosed: reviews.close, reviewsLeftOpen: reviews.keepOpen, ...(holdAttemptIds.length ? { attemptIds: holdAttemptIds, attemptsResolvedNone: attemptState.open } : {}) },
      correlation,
    }, auditId)
    return { ok: true, outcome: input.outcome, duplicate: false, releaseStatus: 'pending' }
  })
}
