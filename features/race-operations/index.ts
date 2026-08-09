// RD-RACEOPS-01 · Race Operations — the module's PUBLIC surface.
//
// Route files under app/(dashboard)/dashboard/race-operations/** import from HERE
// and nowhere deeper. Everything else in features/race-operations/ is internal.
//
// Isolation contract (Phase 0, approved):
//   • Nothing outside this module imports from inside it, except the route files.
//   • This module never writes to an existing collection and owns no schema yet.
//   • This module adds no API route: it reads GET /api/organizer/events and
//     GET /api/organizer/workspace, both of which already existed.
//   • Permissions reuse the existing team matrix — owner + admin, mirroring the
//     server's requireAdmin(). No new permission is introduced.
//   • The existing certificate module is LINKED to, never wrapped or modified.

// ── Access ──────────────────────────────────────────────────────────────────
export { RaceOpsAccessGate } from './components/RaceOpsAccessGate'
export { canAccessRaceOperations, isRaceOpsRole } from './utils/access'
export type { RaceOpsAccessInput } from './utils/access'

// ── Feature slices ──────────────────────────────────────────────────────────
export { PublishResultsFlow } from './publish-results'
export { HistoryPanel }       from './history'

// ── Hub ─────────────────────────────────────────────────────────────────────
export { RaceOpsOverview } from './components/RaceOpsOverview'

// ── Domain types ────────────────────────────────────────────────────────────
export type {
  RaceOpsAccess,
  RaceOpsEventSelection,
  RaceOpsRaceSelection,
  RaceOpsStageKey,
  RaceOpsStageState,
  // Sprint 2 — the canonical result model every parser converges on.
  NormalizedRaceResult,
  RaceResultStatus,
  ResultField,
  ColumnMapping,
  ParsedTable,
} from './types'
export { RACE_OPS_ROLES, RACE_OPS_STAGE_ORDER, RACE_OPS_ELIGIBLE_LIFECYCLE } from './types'
export { RESULT_FIELDS, RACE_RESULT_STATUS_LABEL } from './types'

// ── Pure helpers (unit-testable; no SDK, no I/O) ────────────────────────────
export { resolveRaceOpsEligibility } from './utils/eligibility'
export type { RaceOpsEligibility }   from './utils/eligibility'

// ── Sprint 2 · result import pipeline (internal surface re-exported for tests
//    and any future route file; the UI consumes it through the flow component) ──
export {
  resolveParser, RESULT_PARSERS,
  autoMapColumns, applyMapping, missingRequiredFields,
  validateResults, parseRaceTime, formatRaceTime,
  buildValidationReportCsv, validationReportFilename,
} from './import'
export type {
  ResultParser, ParseOutcome,
  ValidationResult, ValidationIssue, ValidatedRow, ValidationSummary,
} from './import'

// ── Sprint 3 · session lifecycle + ranking (pure; server pieces stay internal) ──
export { decideTransition, isLiveStatus, isTerminalStatus } from './lifecycle/transitions'
export type { SessionAction, SessionSnapshot, TransitionDecision } from './lifecycle/transitions'
export { rankResults, rankChunk, isRankable } from './ranking/engine'
export type { RankAssignment, ChunkRow, RankChunkResult } from './ranking/engine'
export { nextRank, INITIAL_RANK_STATE } from './ranking/ties'
export type { RankState } from './ranking/ties'
export type {
  ImportSessionStatus, ImportSessionView, StoredResultView, RankCursor,
} from './types/session'
export { IMPORT_SESSION_STATUS_LABEL, RACE_IMPORT_SESSIONS } from './types/session'
