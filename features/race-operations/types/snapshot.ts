// RD-RACEOPS-01 Sprint 4 · Official Result Snapshot — THE public read model.
//
// SDK-FREE.
//
// ─── Why a separate collection ───────────────────────────────────────────────
// Public pages MUST NOT read `raceImportSessions` or its draft `results`. Those are
// organizer-owned, tenant-scoped, contain rows regardless of publish state, carry the
// operator's raw file rows, and are indexed for organizer queries. The snapshot is a
// physically separate, publish-only, publicly-shaped projection:
//
//   • it contains ONLY rows from a session that reached `published`
//   • it carries ONLY fields safe to show a stranger — no organizerUid, no eventId,
//     no sessionId, no rawRow, no gender/category/ageGroup
//   • it is keyed and indexed for the three public queries (leaderboard, bib lookup,
//     name prefix search) and for nothing else
//
// ─── Versioning without deletes ──────────────────────────────────────────────
// Re-publishing a race bumps `version` on the snapshot doc and writes new entries
// carrying that version. Public queries always filter `v == snapshot.version`, so rows
// from a superseded version become invisible WITHOUT a mass delete — which keeps the
// publish path bounded and leaves the old rows available for forensics.

import type { RaceResultStatus } from './results'

export const RACE_SNAPSHOTS = 'raceResultSnapshots'
export const SNAPSHOT_ENTRIES_SUBCOLLECTION = 'entries'

export const RACE_SNAPSHOT_SCHEMA_VERSION = 1

/**
 * `building` — entries are being written; NEVER readable publicly.
 * `live`     — the current official results for this race.
 * `superseded` — replaced by a newer version (kept for provenance).
 */
export type SnapshotStatus = 'building' | 'live' | 'superseded'

/**
 * RD-RESULTS-FIX-01 · One published version of a race, for history and rollback.
 *
 * Written when a version goes live and never mutated afterwards. Rollback re-points the
 * snapshot's `version` at one of these; it does not rewrite anything, because the entries
 * for every version still exist (see `entryKey`).
 */
export interface SnapshotVersionRecord {
  version:       number
  /** The import session this version came from — the provenance link for history. */
  sessionId:     string
  publishedBy:   string
  /** ISO 8601. A plain string, so the array is safe to send to a client unchanged. */
  publishedAt:   string
  totalCount:    number
  finisherCount: number
  /** Set when a LATER action pointed the race back at this version. */
  restoredAt?:   string | null
  restoredBy?:   string | null
}

/** Deterministic snapshot id. One snapshot per (event, race) — the CURRENT official one. */
export function snapshotId(eventSlug: string, passId: string): string {
  return `${eventSlug}__${passId}`
}

/** raceResultSnapshots/{eventSlug}__{passId} */
export interface RaceSnapshotDoc {
  snapshotId:    string
  schemaVersion: number

  // ── Public identity ──
  eventSlug: string
  eventName: string
  passId:    string
  passSlug:  string
  passName:  string
  /** Event start date (ISO yyyy-mm-dd) if known — used for display + JSON-LD. */
  eventDate: string | null

  // ── Version ──
  /** The version the public is served. Never changed by a build — only by go-live. */
  version: number
  status:  SnapshotStatus

  // ── RD-RESULTS-FIX-01 · the PENDING build lane ─────────────────────────────
  //
  // ═══ WHY A SEPARATE LANE ═════════════════════════════════════════════════
  // `beginSnapshot` used to write `status: 'building'` and zero the counts onto THIS
  // document, which is keyed per race and is the one the public reads. On a first publish
  // that was harmless — nothing was live yet. The moment republishing became possible it
  // would have been severe: starting a rebuild would flip a live race to `building`, and
  // because every public query filters `status == 'live'`, the results would vanish from
  // the site the instant an organizer began re-importing — and stay gone if the build was
  // abandoned half way.
  //
  // The live fields above are therefore never touched while a build runs. The build
  // accumulates here, and go-live promotes this lane in one transaction.
  /** Version currently being built, or null when no build is in flight. */
  pendingVersion?:       number | null
  pendingSessionId?:     string | null
  pendingBuiltAt?:       unknown | null
  pendingTotalCount?:    number
  pendingFinisherCount?: number
  /**
   * RD-RESULTS-CLOSURE-02 · the build's own resume cursor — the last row number copied.
   *
   * The ranking pass has always persisted its cursor on the session; the snapshot build
   * took its cursor from the request body instead, so a replayed chunk re-copied a page and
   * `bumpSnapshotCounts` incremented the totals a second time. The server owns it now, and
   * a replay simply reads the same cursor and copies the next page.
   *
   * Absent on snapshots built before this sprint; treated as "start from the beginning",
   * which is what those builds already did.
   */
  pendingCursor?:        number | null

  // ── RD-RESULTS-FIX-01 · published version history ──────────────────────────
  /**
   * Every version that has ever gone live, oldest first. Append-only.
   *
   * Bounded by how many times a race is published — a handful, not a scale concern — so it
   * lives on the document rather than in a subcollection that every history read would
   * have to page.
   */
  versions?: SnapshotVersionRecord[]

  // ── Provenance. Organizer-only: NEVER included in a public projection. ──
  organizerUid: string
  eventId:      string
  sessionId:    string
  publishedBy:  string

  publishedAt: unknown | null   // Firestore Timestamp — set when it goes live
  builtAt:     unknown          // Firestore Timestamp

  // ── Counts ──
  totalCount:    number
  finisherCount: number
}

/**
 * raceResultSnapshots/{snapshotId}/entries/{bibKey}
 *
 * `bibKey` is the normalised bib, so a public bib lookup is a single document GET —
 * O(1), no query, no scan. Bibs are unique within a published race because
 * DUPLICATE_BIB is a validation ERROR, so an errored row is never stored.
 */
export interface SnapshotEntryDoc {
  /** Version this row belongs to. Public queries filter on it. */
  v: number

  bibNumber:   string
  bibKey:      string
  /** Name as it appeared in the timing file; null when the file had no name column. */
  name:        string | null
  /** Lower-cased name for prefix search; '' when there is no name. */
  nameLower:   string

  chipTimeMs:  number | null
  gunTimeMs:   number | null
  status:      RaceResultStatus
  overallRank: number | null
  passRank:    number | null
}

// ─── Public projections (what actually reaches a browser) ─────────────────────

/** One leaderboard row. Deliberately minimal. */
export interface PublicResultRow {
  bibNumber:   string
  name:        string | null
  chipTimeMs:  number | null
  gunTimeMs:   number | null
  status:      RaceResultStatus
  overallRank: number | null
}

/** A race's public header. Carries NO organizer identifiers. */
export interface PublicRaceSummary {
  eventSlug:     string
  eventName:     string
  passSlug:      string
  passName:      string
  eventDate:     string | null
  publishedAt:   string | null   // ISO
  totalCount:    number
  finisherCount: number
}

/** The runner result page payload. */
export interface PublicRunnerResult {
  race:   PublicRaceSummary
  result: PublicResultRow
}
