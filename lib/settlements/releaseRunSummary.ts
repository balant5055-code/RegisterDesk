// Phase 3.10D — the MANUAL release's response and the administrator's notice. PURE (no Firestore, no server
// imports): shared by POST /api/admin/finance/release-funds and the Finance page's Release Engine tab.
//
// A run can end with eligible rows NOT started for two independent reasons (both can apply to one run):
//   • its TIME BUDGET was spent (RELEASE_RUN_BUDGET_MS): the rest of its batch was not started (exact count known);
//   • Phase 3.10E — its COUNT LIMIT was reached (min of the requested limit and maximumSettlementsPerRun): eligible
//     rows remain beyond the batch — at least one, proven by a probe row; the exact number is NOT counted.
// Rows not started are untouched — still 'pending' and eligible. Nothing here promises that they release on their
// own: the automatic release depends on the settlement auto-release setting and the scheduled cron, so the notice
// only says they remain pending and eligible and that running the release again continues.

import type { ReleaseFundsResult } from '@/lib/settlements/releaseFunds'

// Response shape is preserved for existing callers; the stop fields are present only when the run stopped early.
export interface ReleaseFundsResponse {
  releasedTransactions: number
  releasedAmountPaise:  number
  skippedTransactions:  number
  /** the run stopped starting rows because its time budget was spent */
  stoppedByBudget?:     boolean
  /** eligible rows of the run's batch NOT started (not released; still pending and eligible) */
  notStartedForBudget?: number
  /** Phase 3.10E — eligible rows remain beyond the run's count limit (at least one; not counted) */
  stoppedByRowCap?:     boolean
  /** Phase 3.10E — that count limit */
  rowCap?:              number
}

export function toReleaseFundsResponse(result: ReleaseFundsResult): ReleaseFundsResponse {
  return {
    releasedTransactions: result.processed,
    releasedAmountPaise:  result.releasedAmountPaise,
    skippedTransactions:  result.failures,
    ...(result.stoppedByBudget ? { stoppedByBudget: true, notStartedForBudget: result.notStartedForBudget ?? 0 } : {}),
    ...(result.stoppedByRowCap ? { stoppedByRowCap: true, ...(typeof result.rowCap === 'number' ? { rowCap: result.rowCap } : {}) } : {}),
  }
}

export interface ReleaseRunNotice {
  stoppedEarly:  boolean
  title:         string
  /** null for a completed run */
  remainderNote: string | null
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const AGAIN = 'run the release again to continue.'

export function releaseRunNotice(r: ReleaseFundsResponse): ReleaseRunNotice {
  const capNote = r.stoppedByRowCap
    ? `This run reached its limit${typeof r.rowCap === 'number' ? ` of ${plural(r.rowCap, 'transaction', 'transactions')}` : ''}; `
      + 'more eligible transactions remain (at least one — not counted). They were not started and NOT released'
    : null
  if (r.stoppedByBudget) {
    const n = r.notStartedForBudget ?? 0
    return {
      stoppedEarly:  true,
      title:         'Release stopped early — time limit reached',
      remainderNote: `${plural(n, 'eligible transaction was', 'eligible transactions were')} not started and NOT released. `
        + (capNote
          ? `${capNote.replace('This run reached', 'The run had also reached')}. All of them remain pending and eligible; ${AGAIN}`
          : `${n === 1 ? 'It remains' : 'They remain'} pending and eligible; ${AGAIN}`),
    }
  }
  if (capNote) {
    return { stoppedEarly: true, title: 'Release stopped early — per-run limit reached', remainderNote: `${capNote}; they remain pending and eligible — ${AGAIN}` }
  }
  return { stoppedEarly: false, title: 'Release Complete', remainderNote: null }
}
