// RD-RACEOPS-01 Sprint 3 · Import Session + stored result documents.
//
// SDK-FREE. Firestore Timestamps are typed `unknown` — the same convention as every
// existing document type in this codebase (lib/registrations/types.ts,
// lib/certificates/types.ts) — so this file stays importable from client, server and test.
//
// Schema documented in docs/RD-RACEOPS-FIRESTORE.md BEFORE implementation, per the brief.

import type { ColumnMapping, NormalizedRaceResult } from './results'

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
export interface StoredRaceResultDoc extends Omit<NormalizedRaceResult, 'rawRow'> {
  rawRow: Record<string, string>

  /** null for every non-finisher, always. */
  overallRank: number | null
  passRank:    number | null

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
