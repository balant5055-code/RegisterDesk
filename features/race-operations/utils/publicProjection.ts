// RD-RACEOPS-01 Sprint 4 · Public projections — THE security boundary.
//
// PURE. No SDK, no I/O — deliberately, so the boundary that keeps organizer data off
// public pages is unit-testable on its own rather than only through Firestore.
//
// Every public payload is constructed FIELD BY FIELD here. Nothing is spread, so a field
// added to the internal document can never leak into a public response by accident: it has
// to be added to a projection explicitly, in this file, where the omission is the point.

import type {
  PublicRaceSummary, PublicResultRow, RaceSnapshotDoc, SnapshotEntryDoc,
} from '@/features/race-operations/types/snapshot'

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
 */
export function toPublicRow(e: SnapshotEntryDoc): PublicResultRow {
  return {
    bibNumber:   e.bibNumber,
    name:        e.name,
    chipTimeMs:  e.chipTimeMs,
    gunTimeMs:   e.gunTimeMs,
    status:      e.status,
    overallRank: e.overallRank,
  }
}
