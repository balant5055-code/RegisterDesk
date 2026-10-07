// RD-RACEOPS-01 Sprint 4 · Public projections — THE security boundary.
//
// PURE. No SDK, no I/O — deliberately, so the boundary that keeps organizer data off
// public pages is unit-testable on its own rather than only through Firestore.
//
// Every public payload is constructed FIELD BY FIELD here. Nothing is spread, so a field
// added to the internal document can never leak into a public response by accident: it has
// to be added to a projection explicitly, in this file, where the omission is the point.

import type {
  PublicRaceSummary, PublicResultRow, PublicSplitRow, RaceSnapshotDoc, SnapshotEntryDoc,
  SnapshotSplitEntry,
} from '@/features/race-operations/types/snapshot'
import { paceMsPerKm, speedKmh } from '@/features/race-operations/utils/performance'

/** Firestore Timestamp → ISO, without importing the SDK. */
function toIso(v: unknown): string | null {
  if (!v) return null
  if (typeof v === 'object' && v !== null && 'toDate' in v) {
    return (v as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

/**
 * Race header for a public page.
 *
 * DROPS, by construction: organizerUid, eventId, sessionId, publishedBy, version, status,
 * schemaVersion, builtAt, snapshotId.
 */
export function toPublicRace(s: RaceSnapshotDoc): PublicRaceSummary {
  return {
    eventSlug:     s.eventSlug,
    eventName:     s.eventName,
    passSlug:      s.passSlug,
    passName:      s.passName,
    eventDate:     s.eventDate,
    publishedAt:   toIso(s.publishedAt),
    totalCount:    s.totalCount,
    finisherCount: s.finisherCount,
  }
}

/**
 * One public result row.
 *
 * DROPS: the version key `v`, `bibKey`, `nameLower` and `passRank` — internal mechanics a
 * participant has no use for.
 *
 * RD-RACEOPS-RESULTS-04 · the enriched facts are listed one at a time here, like everything
 * else in this file, so a field added to the stored entry cannot reach the public by
 * accident. `rawRow` is NOT among them and never will be: it is the organizer's original
 * spreadsheet row, which can hold anything at all.
 *
 * Pace and speed are DERIVED here rather than read — nothing stores them (see
 * utils/performance.ts), and an entry with no distance simply has none.
 */
export function toPublicRow(e: SnapshotEntryDoc): PublicResultRow {
  const distanceMeters = typeof e.distanceMeters === 'number' ? e.distanceMeters : null
  return {
    bibNumber:   e.bibNumber,
    name:        e.name,
    chipTimeMs:  e.chipTimeMs,
    gunTimeMs:   e.gunTimeMs,
    status:      e.status,
    overallRank: e.overallRank,

    gender:         e.gender   ?? null,
    category:       e.category ?? null,
    ageGroup:       e.ageGroup ?? null,
    distanceMeters,
    distanceRaw:    e.distanceRaw ?? null,
    genderRank:     e.genderRank    ?? null,
    genderTotal:    e.genderTotal   ?? null,
    ageGroupRank:   e.ageGroupRank  ?? null,
    ageGroupTotal:  e.ageGroupTotal ?? null,
    paceMsPerKm:    paceMsPerKm(e.chipTimeMs, distanceMeters),
    speedKmh:       speedKmh(e.chipTimeMs, distanceMeters),
  }
}

/**
 * RD-RACEOPS-RESULTS-04 · published checkpoints → public checkpoints.
 *
 * Ordered by `sequence` (the order the participant ran them) and given their four derived
 * numbers: cumulative pace/speed answer "how was the race going here", segment pace/speed
 * answer "how was this leg". Each is null unless BOTH its time and its distance are known —
 * a checkpoint with no distance shows its times and nothing else, which is the truth.
 *
 * DROPS `splitKey` — an internal identity, not something a participant reads.
 */
export function toPublicSplits(splits: readonly SnapshotSplitEntry[]): PublicSplitRow[] {
  return [...splits]
    .sort((a, b) => a.sequence - b.sequence)
    .map(s => ({
      sequence:         s.sequence,
      name:             s.name,
      distanceMeters:   s.distanceMeters   ?? null,
      segmentMeters:    s.segmentMeters    ?? null,
      cumulativeTimeMs: s.cumulativeTimeMs ?? null,
      segmentTimeMs:    s.segmentTimeMs    ?? null,
      timeOfDay:        s.timeOfDay        ?? null,
      cumulativePaceMsPerKm: paceMsPerKm(s.cumulativeTimeMs, s.distanceMeters),
      cumulativeSpeedKmh:    speedKmh(s.cumulativeTimeMs, s.distanceMeters),
      segmentPaceMsPerKm:    paceMsPerKm(s.segmentTimeMs, s.segmentMeters),
      segmentSpeedKmh:       speedKmh(s.segmentTimeMs, s.segmentMeters),
    }))
}
