// RD-PRINT-P8 (W6) · Badge-round RECOVERY — the dedicated cron's walk (app/api/cron/badge-rounds-reconcile).
// Server-only.
//
// Why a separate walk: the inline sweep in print-generation runs only when that cron has budget left
// and restarts from the first open round every time, so under load (or with more open rounds of live
// jobs than one pass reaches) rounds behind them could hold reserved units indefinitely. This walk has
// its own schedule, its own budget and a persisted cursor.
//
//   finds ........ printBadgeRounds where status == 'reserved', in document-id order (equality +
//                  __name__ — the automatic single-field index), ROUND_PAGE (100) per page, at most
//                  MAX_PAGES pages and BUDGET_MS per run; no new round is started after the deadline.
//   settles ...... ONLY through settlePrintBadgeRound — transactional and idempotent: a running job
//                  answers 'active' and is left alone (never force-settled, however old: a stuck job is
//                  revived or failed by the print lease machinery, then settled here), a settled round
//                  answers 'already', a deleted job's round is settled as an orphan.
//   cursor ....... system/printBadgeRoundSweep { cursor, version }, committed by compare-and-set after
//                  EACH round handled. A run whose version is stale stops at once without writing.
//                  The cursor only ever advances over rounds that were handled: after a failure the run
//                  goes on settling what it can but stops checkpointing, so the next run starts again AT
//                  the failed round. At the end of the open rounds it wraps to the beginning.
// Errors are reported by type only; nothing here grants, charges or refunds anything.

import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { PRINT_BADGE_ROUNDS, STALE_ROUND_MS } from './decisions'
import { settlePrintBadgeRound } from './store'

export const ROUND_RECOVERY_STATE_PATH = 'system/printBadgeRoundSweep'
export const ROUND_PAGE = 100
export const ROUND_MAX_PAGES = 5
export const ROUND_BUDGET_MS = 40_000

export interface RoundRecoveryReport {
  scanned: number; settled: number; already: number; active: number; notBilled: number; errors: number
  /** Open rounds older than STALE_ROUND_MS whose job is still running (left alone; surfaced for alerts). */
  staleActive: number
  /** The cursor this run left committed (null ⇒ the next run starts from the beginning). */
  cursor: string | null
  wrapped: boolean
  stoppedBy: 'deadline' | 'pages' | 'stale' | null
}

interface WalkState { cursor: string | null; version: number }

const stateRef = () => adminDb.doc(ROUND_RECOVERY_STATE_PATH)
const readState = (data: unknown): WalkState => {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  return {
    cursor: typeof d.cursor === 'string' ? d.cursor : null,
    version: typeof d.version === 'number' && Number.isInteger(d.version) && d.version >= 0 ? d.version : 0,
  }
}

export async function readRoundRecoveryState(): Promise<WalkState> {
  const snap = await stateRef().get()
  return readState(snap.exists ? snap.data() : undefined)
}

/** Compare-and-set: commit `cursor` ONLY if the stored version is still `expectedVersion`. */
export async function commitRoundRecoveryCursor(expectedVersion: number, cursor: string | null): Promise<number | null> {
  return adminDb.runTransaction(async txn => {
    const snap = await txn.get(stateRef())
    if (readState(snap.exists ? snap.data() : undefined).version !== expectedVersion) return null
    const version = expectedVersion + 1
    txn.set(stateRef(), { cursor, version, updatedAt: FieldValue.serverTimestamp() })
    return version
  })
}

const tsMs = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : null

export async function recoverBadgeRounds(opts: {
  budgetMs?: number; page?: number; maxPages?: number; clock?: () => number
  /** Test seam: the settlement call (defaults to the real, transactional one). */
  settle?: typeof settlePrintBadgeRound
} = {}): Promise<RoundRecoveryReport> {
  const clock = opts.clock ?? Date.now
  const deadline = clock() + (opts.budgetMs ?? ROUND_BUDGET_MS)
  const pageSize = Math.max(1, Math.min(opts.page ?? ROUND_PAGE, ROUND_PAGE))
  const maxPages = Math.max(1, opts.maxPages ?? ROUND_MAX_PAGES)
  const settle = opts.settle ?? settlePrintBadgeRound
  const r: RoundRecoveryReport = { scanned: 0, settled: 0, already: 0, active: 0, notBilled: 0, errors: 0, staleActive: 0, cursor: null, wrapped: false, stoppedBy: null }

  const start = await readRoundRecoveryState()
  let version = start.version
  let committed = start.cursor
  let position = start.cursor          // where the next page starts (may run ahead of `committed` after a failure)
  let failed = false                   // once true, nothing more is checkpointed this run

  for (let pages = 0; ; pages++) {
    if (pages >= maxPages) { r.stoppedBy = 'pages'; break }
    if (clock() >= deadline) { r.stoppedBy = 'deadline'; break }
    let q = adminDb.collection(PRINT_BADGE_ROUNDS).where('status', '==', 'reserved').orderBy(FieldPath.documentId())
    if (position) q = q.startAfter(position)
    const snap = await q.limit(pageSize).get()           // a failed read throws: nothing more is processed or saved
    for (const d of snap.docs) {
      if (clock() >= deadline) { r.stoppedBy = 'deadline'; break }
      r.scanned++
      position = d.id
      let handled = true
      try {
        const jobId = d.get('jobId'), round = d.get('round')
        if (typeof jobId !== 'string' || !jobId || !Number.isInteger(round)) throw new Error('ROUND_MALFORMED')
        const out = await settle(jobId, 'recovery_sweep', round as number)
        if (out.kind === 'settled') r.settled++
        else if (out.kind === 'already') r.already++
        else if (out.kind === 'active') {
          r.active++
          const created = tsMs(d.get('createdAt'))
          if (created !== null && clock() - created > STALE_ROUND_MS) r.staleActive++
        } else r.notBilled++                              // not_billed / no_round: nothing to settle
      } catch (err) {
        handled = false
        r.errors++
        console.error('[badge-rounds-reconcile] round left for the next run', { type: err instanceof Error ? err.name : typeof err })
      }
      if (!handled) failed = true
      if (!failed) {
        const v = await commitRoundRecoveryCursor(version, d.id)
        if (v === null) { r.stoppedBy = 'stale'; r.cursor = committed; return r }
        version = v; committed = d.id
      }
    }
    if (r.stoppedBy === 'deadline') break
    if (snap.size < pageSize) {
      // The end of the open rounds: wrap to the beginning — unless a round failed, which the next run retries first.
      if (!failed && committed !== null) {
        const v = await commitRoundRecoveryCursor(version, null)
        if (v === null) { r.stoppedBy = 'stale'; r.cursor = committed; return r }
        version = v; committed = null
      }
      r.wrapped = !failed
      break
    }
  }
  r.cursor = committed
  return r
}
