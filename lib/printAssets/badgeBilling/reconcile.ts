// RD-PRINT-BILL-P5 · ID-badge generation billing — READ-ONLY reconciliation for one event. Server-only.
//
// Writes nothing. Every invariant the billing path maintains is re-checked from the stored records:
//   LEDGER_USAGE_MISMATCH       ledger print_badges.consumed ≠ Σ print_badges usage records
//   ROUND_RESERVATION_MISMATCH  an OPEN round's usage record ≠ its reservation
//   ROUND_SETTLEMENT_MISMATCH   a SETTLED round: usage ≠ claimed, or claimed ≠ claims recorded for it
//   ROUND_OVERCLAIMED           claimed > reserved (must be impossible)
//   UNSETTLED_ENDED_JOB         an open round whose job has ended (the sweep has not settled it yet)
//   STALE_ROUND                 an open round older than 24 h
//   ORPHAN_USAGE                a generation usage record with no round
//   CLAIMS_WITHOUT_ROUND        unit claims on the event ≠ Σ rounds' claimed
//   RENDERED_WITHOUT_CLAIM      a billed job's rendered card whose attendee holds no claim
// Reads are bounded; `truncated` says a bound was hit (the result is then a lower bound).

import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { ledgerRef, ledgerLine, ALLOWANCE_USAGE_SUBCOLLECTION, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { PRINT_BADGE_CLAIMS, PRINT_BADGE_ROUNDS, STALE_ROUND_MS, settleableJobStatus, billingOf } from './decisions'
import { BILLED_JOBS_COLLECTION, claimedRegistrationIds } from './store'

const MAX_ROUNDS = 500
const MAX_USAGE  = 2000
const MAX_ITEMS_PER_JOB = 5000

export type BadgeReconProblemCode =
  | 'LEDGER_USAGE_MISMATCH' | 'ROUND_RESERVATION_MISMATCH' | 'ROUND_SETTLEMENT_MISMATCH' | 'ROUND_OVERCLAIMED'
  | 'UNSETTLED_ENDED_JOB' | 'STALE_ROUND' | 'ORPHAN_USAGE' | 'CLAIMS_WITHOUT_ROUND' | 'RENDERED_WITHOUT_CLAIM'

export interface BadgeReconProblem { code: BadgeReconProblemCode; detail: string; roundId?: string; jobId?: string }

export interface BadgeRoundRecon {
  roundId: string; jobId: string; round: number; status: 'reserved' | 'settled'
  reserved: number; claimed: number; usage: number; claimsRecorded: number | null
}

export interface BadgeUsageReconciliation {
  draftId:           string
  ok:                boolean
  ledgerConsumed:    number
  usageTotal:        number
  roundClaimedTotal: number
  unitClaims:        number | null
  rounds:            BadgeRoundRecon[]
  problems:          BadgeReconProblem[]
  truncated:         boolean
}

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)
const ms = (v: unknown) => (v && typeof (v as { toMillis?: unknown }).toMillis === 'function' ? (v as { toMillis(): number }).toMillis() : null)

async function countOrNull(q: FirebaseFirestore.Query): Promise<number | null> {
  try { return (await q.count().get()).data().count } catch { return null }
}

export async function reconcilePrintBadgeUsage(draftId: string, nowMs = Date.now()): Promise<BadgeUsageReconciliation> {
  const problems: BadgeReconProblem[] = []
  let truncated = false

  const [ledgerSnap, usageSnap, roundSnap] = await Promise.all([
    ledgerRef(draftId).get(),
    ledgerRef(draftId).collection(ALLOWANCE_USAGE_SUBCOLLECTION).where('service', '==', 'print_badges').limit(MAX_USAGE).get(),
    adminDb.collection(PRINT_BADGE_ROUNDS).where('eventId', '==', draftId).limit(MAX_ROUNDS).get(),
  ])
  if (usageSnap.size >= MAX_USAGE || roundSnap.size >= MAX_ROUNDS) truncated = true

  const ledgerConsumed = ledgerLine(ledgerSnap.exists ? ledgerSnap.data() as ServiceLedgerDoc : undefined, 'print_badges').consumed
  const usage = new Map(usageSnap.docs.map(d => [d.id, int(d.get('quantity'))]))
  const usageTotal = [...usage.values()].reduce((a, b) => a + b, 0)
  if (!truncated && usageTotal !== ledgerConsumed) {
    problems.push({ code: 'LEDGER_USAGE_MISMATCH', detail: `ledger consumed ${ledgerConsumed} ≠ usage records ${usageTotal}` })
  }

  const rounds: BadgeRoundRecon[] = []
  const roundIds = new Set<string>()
  for (const d of roundSnap.docs) {
    const r: BadgeRoundRecon = {
      roundId: d.id, jobId: String(d.get('jobId')), round: int(d.get('round')),
      status: d.get('status') === 'settled' ? 'settled' : 'reserved',
      reserved: int(d.get('reserved')), claimed: int(d.get('claimed')),
      usage: usage.get(String(d.get('unitKey') ?? d.id)) ?? 0, claimsRecorded: null,
    }
    roundIds.add(String(d.get('unitKey') ?? d.id))
    if (r.claimed > r.reserved) problems.push({ code: 'ROUND_OVERCLAIMED', detail: `claimed ${r.claimed} > reserved ${r.reserved}`, roundId: r.roundId, jobId: r.jobId })
    if (r.status === 'reserved') {
      if (r.usage !== r.reserved) problems.push({ code: 'ROUND_RESERVATION_MISMATCH', detail: `usage ${r.usage} ≠ reserved ${r.reserved}`, roundId: r.roundId, jobId: r.jobId })
      const created = ms(d.get('createdAt'))
      if (created !== null && nowMs - created > STALE_ROUND_MS) problems.push({ code: 'STALE_ROUND', detail: 'open for more than 24 hours', roundId: r.roundId, jobId: r.jobId })
    } else {
      r.claimsRecorded = await countOrNull(adminDb.collection(PRINT_BADGE_CLAIMS).where('roundId', '==', r.roundId))
      if (r.usage !== r.claimed || (r.claimsRecorded !== null && r.claimsRecorded !== r.claimed)) {
        problems.push({ code: 'ROUND_SETTLEMENT_MISMATCH', detail: `usage ${r.usage}, claimed ${r.claimed}, claims recorded ${r.claimsRecorded ?? 'unknown'}`, roundId: r.roundId, jobId: r.jobId })
      }
    }
    rounds.push(r)
  }

  for (const [key, q] of usage) {
    if (key.startsWith('pgen_') && !roundIds.has(key)) problems.push({ code: 'ORPHAN_USAGE', detail: `usage record ${key} (${q}) has no round` })
  }

  const roundClaimedTotal = rounds.reduce((a, r) => a + r.claimed, 0)
  const unitClaims = await countOrNull(adminDb.collection(PRINT_BADGE_CLAIMS).where('eventId', '==', draftId).where('mode', '==', 'units'))
  if (!truncated && unitClaims !== null && unitClaims !== roundClaimedTotal) {
    problems.push({ code: 'CLAIMS_WITHOUT_ROUND', detail: `unit claims ${unitClaims} ≠ rounds' claimed ${roundClaimedTotal}` })
  }

  // Per billed job: has it ended with its round open, and does every rendered card have a claim?
  const jobIds = [...new Set(rounds.map(r => r.jobId))]
  for (const jobId of jobIds) {
    const jSnap = await adminDb.collection(BILLED_JOBS_COLLECTION).doc(jobId).get()
    if (!jSnap.exists) continue
    const job = jSnap.data() as Record<string, unknown>
    const billing = billingOf(job)
    const open = rounds.find(r => r.jobId === jobId && r.status === 'reserved')
    if (open && settleableJobStatus(job.status)) {
      problems.push({ code: 'UNSETTLED_ENDED_JOB', detail: `job is ${String(job.status)} but run ${open.round} is not settled`, roundId: open.roundId, jobId })
    }
    if (!billing) continue
    const items = await adminDb.collection(BILLED_JOBS_COLLECTION).doc(jobId).collection('items')
      .where('rendered', '==', true).orderBy(FieldPath.documentId()).limit(MAX_ITEMS_PER_JOB).get()
    if (items.size >= MAX_ITEMS_PER_JOB) truncated = true
    const ids = items.docs.map(d => d.id)
    const claimed = await claimedRegistrationIds(draftId, ids)
    const missing = ids.filter(id => !claimed.has(id)).length
    if (missing > 0) problems.push({ code: 'RENDERED_WITHOUT_CLAIM', detail: `${missing} rendered card(s) without a billing claim`, jobId })
  }

  return { draftId, ok: problems.length === 0, ledgerConsumed, usageTotal, roundClaimedTotal, unitClaims, rounds, problems, truncated }
}
