// RD-RACEOPS-01 Sprint 4 · Public read service — SERVER ONLY.
//
// THE only module a public page may call. Every function here reads the Official Snapshot
// and nothing else: `raceImportSessions` and its draft `results` are never imported into
// this file, so a public page physically cannot reach them.
//
// Every return value is a projection built field-by-field in snapshotRepo, so no
// organizerUid / eventId / sessionId can leak into a server-rendered payload.

import {
  fetchByBib, fetchLeaderboardPage, getLiveSnapshot, listLiveRacesForEvent,
  listRecentResultEvents, searchByNamePrefix,
} from '@/features/race-operations/repositories/snapshotRepo'
import { toPublicRace } from '@/features/race-operations/utils/publicProjection'
import { isPlausibleBib } from '@/features/race-operations/utils/publicKeys'
import type {
  PublicRaceSummary, PublicResultRow, PublicRunnerResult,
} from '@/features/race-operations/types/snapshot'

/** Leaderboard rows per page. Small enough to render instantly on a phone. */
export const LEADERBOARD_PAGE_SIZE = 50

/** Cap on search results — a search is a lookup, not a second leaderboard. */
export const SEARCH_RESULT_LIMIT = 20

// ─── Landing ──────────────────────────────────────────────────────────────────

/** Races with published results, newest first. */
export async function getRecentResults(limit = 24): Promise<PublicRaceSummary[]> {
  return listRecentResultEvents(limit)
}

/** Groups live races by event, for the landing page and the event page. */
export interface PublicEventResults {
  eventSlug: string
  eventName: string
  eventDate: string | null
  races:     PublicRaceSummary[]
}

export async function getEventResults(eventSlug: string): Promise<PublicEventResults | null> {
  const snapshots = await listLiveRacesForEvent(eventSlug)
  if (snapshots.length === 0) return null

  const races = snapshots
    .map(toPublicRace)
    .sort((a, b) => a.passName.localeCompare(b.passName))

  return {
    eventSlug,
    eventName: races[0].eventName,
    eventDate: races[0].eventDate,
    races,
  }
}

/** Groups a flat race list by event — used by the landing page. */
export function groupRacesByEvent(races: readonly PublicRaceSummary[]): PublicEventResults[] {
  const byEvent = new Map<string, PublicEventResults>()
  for (const race of races) {
    const existing = byEvent.get(race.eventSlug)
    if (existing) existing.races.push(race)
    else byEvent.set(race.eventSlug, {
      eventSlug: race.eventSlug,
      eventName: race.eventName,
      eventDate: race.eventDate,
      races:     [race],
    })
  }
  return [...byEvent.values()]
}

// ─── Race ─────────────────────────────────────────────────────────────────────

export interface PublicLeaderboard {
  race:       PublicRaceSummary
  rows:       PublicResultRow[]
  nextCursor: number | null
}

export async function getLeaderboard(
  eventSlug: string, passSlugParam: string, afterRank?: number | null,
): Promise<PublicLeaderboard | null> {
  const snapshot = await getLiveSnapshot(eventSlug, passSlugParam)
  if (!snapshot) return null

  const page = await fetchLeaderboardPage(
    snapshot.snapshotId, snapshot.version, LEADERBOARD_PAGE_SIZE, afterRank,
  )

  return { race: toPublicRace(snapshot), rows: page.rows, nextCursor: page.nextCursor }
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface PublicSearchOutcome {
  race:    PublicRaceSummary
  rows:    PublicResultRow[]
  /** Which strategy answered — so the UI can explain a miss honestly. */
  matched: 'bib' | 'name' | 'none'
}

/**
 * Bib first (a single document GET, O(1)), then a name PREFIX query.
 *
 * A query that looks like a bib is tried as one even if it is also a plausible name
 * fragment, because an exact bib hit is unambiguous and instant.
 */
export async function searchRace(
  eventSlug: string, passSlugParam: string, query: string,
): Promise<PublicSearchOutcome | null> {
  const snapshot = await getLiveSnapshot(eventSlug, passSlugParam)
  if (!snapshot) return null

  const race = toPublicRace(snapshot)
  const q = query.trim()
  if (q === '') return { race, rows: [], matched: 'none' }

  if (isPlausibleBib(q)) {
    const hit = await fetchByBib(snapshot.snapshotId, snapshot.version, q)
    if (hit) return { race, rows: [hit], matched: 'bib' }
  }

  const byName = await searchByNamePrefix(
    snapshot.snapshotId, snapshot.version, q, SEARCH_RESULT_LIMIT,
  )
  return { race, rows: byName, matched: byName.length > 0 ? 'name' : 'none' }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function getRunnerResult(
  eventSlug: string, passSlugParam: string, bib: string,
): Promise<PublicRunnerResult | null> {
  if (!isPlausibleBib(bib)) return null

  const snapshot = await getLiveSnapshot(eventSlug, passSlugParam)
  if (!snapshot) return null

  const result = await fetchByBib(snapshot.snapshotId, snapshot.version, bib)
  if (!result) return null

  return { race: toPublicRace(snapshot), result }
}
