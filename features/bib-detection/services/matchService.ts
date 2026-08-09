// RD-BIB-01 · Matching against the Official Snapshot — SERVER ONLY.
//
// ═══ THE SECURITY INVARIANT ═══════════════════════════════════════════════════
// A photo is matched against PUBLISHED results and nothing else.
//
// `raceImportSessions` and its draft `results` are not imported by this file, or by anything
// this file imports. A link therefore CANNOT be produced from an unpublished import — not by
// policy, but because the code has no way to reach one. `listLiveRacesForEvent` returns only
// `status === 'live'` snapshots, and `fetchByBib` additionally refuses any row whose `v` is
// not the snapshot's current version, so a superseded result cannot match either.
//
// This is the same construction the finisher-badge service uses, for the same reason.
// ══════════════════════════════════════════════════════════════════════════════
//
// ─── Bibs are unique per RACE, not per EVENT ─────────────────────────────────
// `DUPLICATE_BIB` is a validation error WITHIN one published race. A 5K and a 10K in the
// same event may both have a runner wearing 101, and a photograph is taken of an event, not
// of a race. So a detected bib can legitimately resolve to more than one runner. The
// pipeline records every candidate and links to none of them — attaching a stranger's
// photograph to a runner is a worse failure than leaving it unlinked.

import {
  fetchByBib, listLiveRacesForEvent,
} from '@/features/race-operations/repositories/snapshotRepo'
import { snapshotId } from '@/features/race-operations/types/snapshot'
import type { BibDetection, BibMatchCandidate } from '@/features/bib-detection/types'
import {
  decideMatches, type DetectionWithCandidates, type MatchDecision,
} from '@/features/bib-detection/matching/matcher'

/**
 * Every live race in an event, resolved once per photo.
 *
 * Bounded by `listLiveRacesForEvent`'s own limit of 50. In practice an event has one to
 * four races, and the lookup cost below is races × distinct bibs — which is why the payload
 * parser deduplicates bibs before this is ever called.
 */
export interface LiveRace {
  snapshotId: string
  passId:     string
  passSlug:   string
  passName:   string
  version:    number
}

export async function loadLiveRaces(eventSlug: string): Promise<LiveRace[]> {
  const snapshots = await listLiveRacesForEvent(eventSlug)
  return snapshots.map(s => ({
    snapshotId: snapshotId(s.eventSlug, s.passId),
    passId:     s.passId,
    passSlug:   s.passSlug,
    passName:   s.passName,
    version:    s.version,
  }))
}

/**
 * Which published runners each detected bib could be.
 *
 * An EXACT match on the normalised bib key, and only that. There is no fuzzy matching, no
 * edit distance and no "close enough": a bib is an identifier, and 1O1 is not 101.
 */
export async function resolveCandidates(
  races: readonly LiveRace[],
  detections: readonly BibDetection[],
): Promise<Map<string, BibMatchCandidate[]>> {
  const byBib = new Map<string, BibMatchCandidate[]>()
  for (const d of detections) byBib.set(d.bibKey, [])

  if (races.length === 0 || detections.length === 0) return byBib

  const lookups = races.flatMap(race =>
    detections.map(async detection => {
      // `fetchByBib` normalises the bib itself and refuses a row from a superseded version.
      const row = await fetchByBib(race.snapshotId, race.version, detection.bibNumber)
      if (!row) return null
      return {
        bibKey: detection.bibKey,
        candidate: {
          passId:   race.passId,
          passSlug: race.passSlug,
          passName: race.passName,
          snapshotVersion: race.version,
        } satisfies BibMatchCandidate,
      }
    }),
  )

  for (const hit of await Promise.all(lookups)) {
    if (!hit) continue
    byBib.get(hit.bibKey)?.push(hit.candidate)
  }

  return byBib
}

/** Resolves candidates and applies the (pure) decision rules. */
export async function matchDetections(
  eventSlug: string, detections: readonly BibDetection[],
): Promise<MatchDecision[]> {
  if (detections.length === 0) return []

  const races  = await loadLiveRaces(eventSlug)
  const byBib  = await resolveCandidates(races, detections)

  const inputs: DetectionWithCandidates[] = detections.map(detection => ({
    detection,
    candidates: byBib.get(detection.bibKey) ?? [],
  }))

  return decideMatches(inputs)
}
