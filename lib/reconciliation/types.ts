// Global counter reconciliation — shared types (Phase G.5). Server-only.
//
// Every reconciler verifies a STORED derived counter against its source of truth
// and (for non-financial entities) repairs it. Financial entities (wallets) are
// verified and REPORTED ONLY — never auto-repaired.

export type ReconcileEntityType = 'event' | 'pass' | 'campaign' | 'session' | 'wallet'

export interface CounterMismatch {
  entityType: ReconcileEntityType
  entityId:   string     // eventSlug | `${eventSlug}:${passId}` | campaignSlug | sessionId | organizerUid
  field:      string     // the counter field, e.g. 'totalCount', 'totalRaisedPaise'
  expected:   number     // value derived from source of truth
  actual:     number     // value currently stored
  repaired:   boolean    // whether this run wrote the corrected value
}

export interface ReconcileResult {
  entityType: string
  scanned:    number
  mismatches: CounterMismatch[]
  repaired:   number
}

export interface ReconcileOptions {
  repair?:   boolean     // default true for event/pass/campaign/session; ignored for wallet
  limit?:    number      // max entities to process this run (cost guard)
  budgetMs?: number      // wall-clock budget for the run; stops early + persists cursor
}

export const REPORTS_COLLECTION = 'reconciliationReports'

// Default bounded page size per reconciler run. A run processes at most this many
// entities (resuming from a durable cursor), so a daily cron can never overrun its
// function timeout at scale; the full set is covered across successive ticks. An
// explicit `opts.limit` overrides this.
export const RECON_PAGE_DEFAULT = 500

// GA-7C P1-1: wall-clock budget per reconciler run. A run stops processing new
// entities once this elapses and persists its resume cursor at the last COMPLETED
// entity, so a large page can never run into the function timeout with the cursor
// unadvanced (which previously re-processed the same heavy page forever). Sits
// comfortably under the reconciler crons' maxDuration=300.
export const RECON_BUDGET_MS = 240_000

// Persist the resume cursor every N entities within a run (belt-and-suspenders on
// top of the budget stop: even an unexpected kill still advances progress).
export const RECON_CURSOR_FLUSH = 25

// Auto-repair is allowed only for non-financial entities. Financial integrity:
// wallet/settlement/platformTransaction values are NEVER written by reconciliation.
export const REPAIRABLE: ReadonlySet<ReconcileEntityType> = new Set(['event', 'pass', 'campaign', 'session'])

export function mismatch(
  entityType: ReconcileEntityType, entityId: string, field: string,
  expected: number, actual: number, repaired: boolean,
): CounterMismatch {
  return { entityType, entityId, field, expected, actual, repaired }
}
