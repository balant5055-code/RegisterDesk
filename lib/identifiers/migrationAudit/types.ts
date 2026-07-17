// Phase H.1.5A — Migration Safety Layer: report types.
//
// Shared, SDK-free types describing the READ-ONLY dry-run migration analysis of
// the legacy Bib implementation. Safe to import from both client and server.
//
// ⚠ Nothing in this module — or anything that produces these types — may write,
//   mutate, backfill, or create Firestore documents. The analyzer is read-only.

// ─── Severity & issue taxonomy ──────────────────────────────────────────────

/**
 * How an issue affects migration:
 *  - blocking        → must be resolved before migrating (data would corrupt)
 *  - auto_repairable → the planner can fix it safely & deterministically
 *  - manual_review   → needs a human decision (e.g. classify a custom value)
 *  - info            → not a problem; surfaced for transparency
 */
export type IssueSeverity = 'blocking' | 'auto_repairable' | 'manual_review' | 'info'

export type IssueType =
  | 'duplicate_identifier'       // same value held by >1 active registration
  | 'numeric_collision'          // "0042" vs "42" resolve to the same number
  | 'non_numeric_value'          // value is not pure-numeric (unexpected today)
  | 'invalid_custom_identifier'  // malformed value that is neither numeric nor sane custom
  | 'cancelled_allocation'       // bib still set on a cancelled / rejected registration
  | 'refunded_allocation'        // bib still set on a refunded registration
  | 'orphaned_assignment'        // bib held by a terminal registration (should be released)
  | 'broken_reference'           // bibLock points at a non-existent registration
  | 'lock_conflict'              // a value is claimed by two different owners
  | 'stale_lock'                 // bibLock value disagrees with the registration's bib
  | 'missing_identifier'         // gap in the issued sequential range
  | 'invalid_category'           // dirty / inconsistent category labels
  | 'out_of_range'               // numeric value outside the issued counter range
  | 'invalid_pool'               // pool reference invalid (N/A pre-engine; reserved)

export interface IdentifierIssue {
  type:            IssueType
  severity:        IssueSeverity
  message:         string
  value:           string | null          // the bib value involved, when applicable
  registrationIds: string[]               // affected registration ids
  lockIds:         string[]               // affected bibLock doc ids
  autoRepairable:  boolean
}

// ─── Repair planner (PLAN ONLY — never executed) ────────────────────────────

export interface RepairAction {
  repairType:        string                // machine key, e.g. 'release_orphan_bib'
  title:             string                // human-readable title
  severity:          IssueSeverity
  affectedDocuments: string[]              // Firestore paths the repair WOULD touch
  exactAction:       string                // precise description of the proposed write
  estimatedImpact:   string                // what changes / who is affected
  automatic:         boolean               // true = safe to auto-apply; false = manual
}

// ─── Per-event report ───────────────────────────────────────────────────────

export type MigrationComplexity = 'trivial' | 'low' | 'medium' | 'high'

export interface CategoryVariantGroup {
  canonical: string                        // normalized key (trim+lowercase+collapse ws)
  variants:  string[]                      // distinct raw labels mapping to it
}

export interface EventMigrationReport {
  eventSlug:    string
  eventName:    string
  eventType:    string | null
  organizerUid: string | null

  // ── Core statistics (requested deliverable) ──
  totalRegistrations:   number
  assignedIdentifiers:  number             // registrations holding a bib (any status)
  freeIdentifiers:      number             // unassigned numbers within the issued range
  duplicateCount:       number             // distinct values duplicated among active regs
  orphanCount:          number             // orphaned assignments + stale/broken locks
  invalidCount:         number             // non-numeric + dirty-category + out-of-range
  cancelledAllocations: number             // bibs on cancelled/rejected/refunded regs
  checkedInAllocations: number             // bibs on checked-in regs (identifier is permanent)
  conflictCount:        number             // values with two competing owners

  // ── Categories ──
  distinctCategories: string[]
  categoryVariants:   CategoryVariantGroup[]

  // ── Sequential range (legacy bibCounters) ──
  counterNextBib: number | null
  rangeMin:       number | null
  rangeMax:       number | null
  missingInRange: number                   // count of gaps in [1, nextBib-1]

  // ── Verdicts ──
  complexity:       MigrationComplexity
  safeToMigrate:    boolean
  readinessScore:   number                 // 0..100 (integer)
  readinessReasons: string[]

  // ── Detail ──
  issues:     IdentifierIssue[]
  repairPlan: RepairAction[]
}

// ─── Global summary ─────────────────────────────────────────────────────────

export interface GlobalMigrationSummary {
  totalEvents:          number
  totalRegistrations:   number
  totalIdentifiers:     number             // total assigned bibs across all events
  totalDuplicates:      number
  totalConflicts:       number
  totalOrphans:         number
  totalInvalid:         number
  totalRepairActions:   number
  automaticRepairs:     number
  manualRepairs:        number
  eventsSafeToMigrate:  number
  eventsNeedingReview:  number
  globalReadinessScore: number             // 0..100 (1 decimal), registration-weighted
}

// ─── Top-level report envelope ──────────────────────────────────────────────

export interface MigrationAuditReport {
  generatedAt: string                      // ISO timestamp
  readOnly:    true                        // invariant marker — this run never wrote
  scope:       'platform' | 'event'
  summary:     GlobalMigrationSummary
  events:      EventMigrationReport[]
}
