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
/**
 * RD-RACEOPS-RESULTS-04 · published checkpoints, ONE DOCUMENT PER PARTICIPANT PER VERSION.
 *
 * Deliberately not on the entry document: the public leaderboard reads entries fifty at a
 * time and shows no checkpoints, so embedding 10–30 of them would multiply the payload of
 * the most-read page in the module for data it never renders. Deliberately not one document
 * per checkpoint either: 20,000 runners × 20 points is 400,000 documents per version, and
 * nothing here ever deletes.
 *
 * The id carries the version exactly as `entries` does (`v7__10571`), so a rollback exposes
 * that version's checkpoints by construction and an abandoned build's can never be read.
 */
export const SNAPSHOT_SPLITS_SUBCOLLECTION = 'entrySplits'

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
  /**
   * RD-RACEOPS-02G · the highest version this race has EVER allocated — the allocator.
   *
   * `version` is a pointer and rollback moves it backwards; the next build used to be
   * `version + 1`, which after a rollback named a number that already had entries (an
   * abandoned lane, or a published version whose rows were then overwritten). A new build
   * is now `maxVersion + 1`, claimed in the same transaction that advances `maxVersion`,
   * and rollback never touches it. Absent on documents written before this sprint: derived
   * from the live pointer, the pending lane and `versions[]`, then established on the next
   * allocation or go-live (see `utils/snapshotVersions.ts`).
   */
  maxVersion?: number

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

  // ── RD-RACEOPS-RESULTS-04 · what the participant's own result page needs ─────
  //
  // Before this sprint these facts were collected, validated and stored on the draft import
  // and then dropped at the publish boundary, so nothing public, certificate, badge or
  // export could ever reach them (03 audit, P1-1). They are carried here — the ONE document
  // a runner result page reads — rather than fetched from the session, which is organizer-
  // private and may be cancelled.
  //
  // Every one is optional: an entry published before this sprint has none, and each public
  // surface renders an unavailable state rather than a zero.
  /** As recorded in the timing FILE. Never reconciled against registration form data. */
  gender?:     string | null
  category?:   string | null
  ageGroup?:   string | null
  /** Race distance in metres — what pace and speed are derived from. */
  distanceMeters?: number | null
  /** The distance exactly as the file wrote it, for display when it is more precise. */
  distanceRaw?: string | null

  /**
   * Position within this participant's own gender / age group, and the size of that group.
   *
   * COMPUTED BY REGISTERDESK from the published set (ranking/groups.ts) — a provider's own
   * rank column is never imported. Null when the file carried no group value for this row,
   * when the row is not a finisher, or when the column held too many distinct values to be
   * a group at all.
   */
  genderRank?:    number | null
  genderTotal?:   number | null
  ageGroupRank?:  number | null
  ageGroupTotal?: number | null
}

/**
 * RD-RACEOPS-RESULTS-04 · raceResultSnapshots/{snapshotId}/entrySplits/v{n}__{bibKey}
 *
 * One participant's published checkpoints. Read by a single document GET on the runner
 * result page — no query, no index — and written in the same batch as the entry it belongs
 * to, so entries and checkpoints are never half a version apart.
 */
export interface SnapshotSplitsDoc {
  /** Version these checkpoints belong to. Matches the id and the entry's `v`. */
  v:         number
  bibNumber: string
  bibKey:    string
  /** In course order. Empty arrays are never written — the document simply does not exist. */
  splits:    SnapshotSplitEntry[]
}

/** One published checkpoint. Pace and speed are absent: both are derived at read time. */
export interface SnapshotSplitEntry {
  sequence:         number
  splitKey:         string
  name:             string
  distanceMeters:   number | null
  segmentMeters:    number | null
  cumulativeTimeMs: number | null
  segmentTimeMs:    number | null
  /** Wall clock "HH:MM:SS", never an elapsed duration. */
  timeOfDay:        string | null
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

  // ── RD-RACEOPS-RESULTS-04 · published facts, plus what RegisterDesk derived ──
  // Null throughout for a race published before this sprint, or one whose file carried
  // no such column. A consumer renders "—", never a 0 and never an invented value.
  gender:         string | null
  category:       string | null
  ageGroup:       string | null
  distanceMeters: number | null
  distanceRaw:    string | null
  genderRank:     number | null
  genderTotal:    number | null
  ageGroupRank:   number | null
  ageGroupTotal:  number | null
  /** DERIVED from chip time and distance — never imported. Null when either is missing. */
  paceMsPerKm:    number | null
  speedKmh:       number | null
}

/**
 * RD-RACEOPS-RESULTS-04 · one checkpoint as the public sees it.
 *
 * Both readings the participant asked for — where they were, and how the leg went — with
 * pace and speed derived for each. Nothing here identifies the organizer, the session or
 * the import.
 */
export interface PublicSplitRow {
  sequence:         number
  name:             string
  distanceMeters:   number | null
  segmentMeters:    number | null
  cumulativeTimeMs: number | null
  segmentTimeMs:    number | null
  timeOfDay:        string | null
  /** Derived from (cumulativeTimeMs, distanceMeters). */
  cumulativePaceMsPerKm: number | null
  cumulativeSpeedKmh:    number | null
  /** Derived from (segmentTimeMs, segmentMeters). */
  segmentPaceMsPerKm:    number | null
  segmentSpeedKmh:       number | null
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
  /**
   * RD-RACEOPS-RESULTS-04 · this participant's checkpoints, or [] when the race published
   * none. An empty array renders NO split section at all — never an empty table.
   */
  splits: PublicSplitRow[]
}
