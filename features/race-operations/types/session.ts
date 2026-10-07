// RD-RACEOPS-01 Sprint 3 · Import Session + stored result documents.
//
// SDK-FREE. Firestore Timestamps are typed `unknown` — the same convention as every
// existing document type in this codebase (lib/registrations/types.ts,
// lib/certificates/types.ts) — so this file stays importable from client, server and test.
//
// Schema documented in docs/RD-RACEOPS-FIRESTORE.md BEFORE implementation, per the brief.

import type { ColumnMapping, NormalizedRaceResult, NormalizedRaceSplit } from './results'
import type { GroupRankStates, GroupTotals, RankDimension } from '@/features/race-operations/ranking/groups'

export const RACE_IMPORT_SESSIONS = 'raceImportSessions'
export const RACE_RESULTS_SUBCOLLECTION = 'results'

/** Bump when the stored shape changes. A reader seeing an unknown version must refuse to
 *  interpret the document rather than guess at it. */
export const RACE_SESSION_SCHEMA_VERSION = 1

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * `draft` → `published` | `cancelled`. Both targets are terminal in Sprint 3:
 * unpublish is deliberately out of scope (see RD-RACEOPS-FIRESTORE.md §6).
 */
/** RD-RESULTS-FIX-01 · counts from the start-list cross-check. */
export interface RegistrationCheckCounts {
  matched:       number
  unknownRunner: number
  wrongRace:     number
  missingResult: number
  checkedAt:     unknown
}

export type ImportSessionStatus = 'draft' | 'published' | 'cancelled'

export const IMPORT_SESSION_STATUS_LABEL: Readonly<Record<ImportSessionStatus, string>> = {
  draft:     'Draft',
  published: 'Published',
  cancelled: 'Cancelled',
}

// ─── Session document ─────────────────────────────────────────────────────────

/**
 * Resumes the ranking walk.
 *
 * `lastChipTimeMs` + `lastRowNumber` together form the Firestore page cursor — the pair is
 * a TOTAL order, so paging stays gap-free even when many finishers share a time.
 * `lastRank` + `processed` carry the tie state, so a tie straddling a page boundary still
 * resolves to one shared rank.
 */
export interface RankCursor {
  lastChipTimeMs: number
  lastRowNumber:  number
  lastRank:       number
  processed:      number
  /**
   * RD-RACEOPS-RESULTS-04 · per-group tie state for the gender and age-group ranks, carried
   * with the overall cursor because they are assigned in the SAME walk (see ranking/groups.ts).
   * Absent on a cursor written before this sprint — an in-flight ranking simply continues
   * without group ranks, which is what those rows already had.
   */
  groups?:        GroupRankStates
  /** Dimensions abandoned because the column held too many distinct values to be a group. */
  abandoned?:     RankDimension[]
}

/** raceImportSessions/{sessionId} */
export interface ImportSessionDoc {
  sessionId:     string
  schemaVersion: number

  // ── Scope (immutable) ──
  eventId:      string        // users/{uid}/eventDrafts/{eventId}
  eventSlug:    string        // events/{slug}
  organizerUid: string        // tenant isolation key — the workspace owner
  passId:       string        // the race; a session is one (event, pass)
  passName:     string

  // ── Provenance (immutable) ──
  uploadedBy: string
  uploadedAt: unknown         // Firestore Timestamp
  fileName:   string
  fileHash:   string          // client-computed SHA-256; provenance, NOT a security control
  provider:   string
  mapping:    ColumnMapping

  // ── Counts (server-derived; totals immutable, storedRows grows) ──
  totalRows:    number
  validRows:    number
  warningCount: number
  errorCount:   number
  storedRows:   number

  // ── Lifecycle (each written at most once) ──
  status:       ImportSessionStatus

  // ── RD-RESULTS-FIX-01 · start-list verification ─────────────────────────
  /**
   * Result of the registration cross-check, or null when it has not been run.
   *
   * Publishing REQUIRES this to be present and non-blocking, exactly as it already
   * requires `rankedAt`. Stored rather than recomputed because publish is a later request
   * and re-deriving it would mean re-reading the roster and every stored row.
   */
  registrationCheck?: RegistrationCheckCounts | null

  /**
   * RD-RACEOPS-RESULTS-04 · how many finishers each gender / age group ended up with —
   * the denominators a published result shows ("4 / 56").
   *
   * Written once, when the ranking pass completes, because a group's size is only known
   * after the last member has been counted. The snapshot build copies them onto each entry
   * so a public read needs no second document.
   */
  rankGroups?:  GroupTotals | null
  /** Dimensions that could not be ranked (too many distinct values). Reported, never guessed. */
  rankAbandoned?: RankDimension[] | null
  rankedRows:   number
  rankCursor:   RankCursor | null
  rankedAt:     unknown | null
  publishedAt:  unknown | null
  publishedBy:  string | null
  cancelledAt:  unknown | null
  cancelledBy:  string | null
  cancelReason: string | null
}

// ─── Stored result document ───────────────────────────────────────────────────

/**
 * raceImportSessions/{sessionId}/results/{row-N}
 *
 * The canonical model plus ranks and denormalised scope keys. `rowNumber` drives the
 * deterministic doc id, which is what makes a re-sent chunk idempotent.
 */
export interface StoredRaceResultDoc extends Omit<NormalizedRaceResult, 'rawRow' | 'splits'> {
  rawRow: Record<string, string>

  /**
   * RD-RACEOPS-RESULTS-04 · this participant's checkpoints, in course order.
   *
   * Embedded on the DRAFT row (not a subcollection) because a row is written once, read
   * once by the snapshot build, and then never queried by split — so a nested array is one
   * write instead of two and one read instead of a page. Bounded by
   * `MAX_SPLITS_PER_RESULT`, which keeps the document far inside Firestore's 1 MiB limit.
   *
   * The PUBLISHED copy is a separate document per participant — see
   * types/snapshot.ts `SnapshotSplitsDoc` — because the public leaderboard reads entries by
   * the page and must not carry 30 checkpoints it never shows.
   */
  splits?: NormalizedRaceSplit[]

  /**
   * RD-RACEOPS-02C · the bib in comparison form (`bibKey()`), stored so the session's
   * bib-uniqueness invariant is a bounded equality query rather than a scan. Rows written
   * before this field existed carry none; a draft is short-lived, and a new session always
   * writes it.
   */
  bibKey: string

  /** null for every non-finisher, always. */
  overallRank: number | null
  passRank:    number | null

  /**
   * RD-RACEOPS-RESULTS-04 · position within this participant's own gender / age group,
   * computed by RegisterDesk in the same pass as `overallRank` (ranking/groups.ts).
   *
   * Null when the file carried no such value for this row, when the row is not a finisher,
   * or when the dimension was abandoned as not-a-group. A provider's own rank column is
   * never imported into these fields.
   */
  genderRank:   number | null
  ageGroupRank: number | null
  /** Normalised comparison keys, stored so the snapshot build needs no re-normalisation. */
  genderKey:    string
  ageGroupKey:  string

  // Denormalised scope — keeps a future collection-group read tenant-safe with no
  // parent lookup.
  sessionId:    string
  organizerUid: string
  eventSlug:    string
  passId:       string
}

/** Deterministic document id. Row numbers are unique within a file by construction. */
export function resultDocId(rowNumber: number): string {
  return `row-${rowNumber}`
}

// ─── Client-facing views (serialised — no Timestamps cross the wire) ──────────

export interface ImportSessionView {
  sessionId:    string
  eventId:      string
  passId:       string
  passName:     string
  fileName:     string
  fileHash:     string
  provider:     string
  status:       ImportSessionStatus
  totalRows:    number
  validRows:    number
  warningCount: number
  errorCount:   number
  storedRows:   number
  rankedRows:   number
  uploadedBy:   string
  uploadedAt:   string | null      // ISO
  rankedAt:     string | null
  publishedAt:  string | null
  publishedBy:  string | null
  cancelledAt:  string | null
  cancelReason: string | null
}

export interface StoredResultView {
  rowNumber:   number
  bibNumber:   string | null
  chipTimeMs:  number | null
  gunTimeMs:   number | null
  chipTimeRaw: string | null
  status:      string
  overallRank: number | null
  passRank:    number | null
}
