// RD-RACEOPS-01 Sprint 4 · Snapshot build + go-live — SERVER ONLY.
//
// The publish path now has two phases, in this order:
//
//   1. BUILD   (repeatable, chunked, session still `draft`)
//      Copies published-quality rows into raceResultSnapshots/{key}/entries, in
//      `building` state — invisible to every public reader.
//
//   2. GO LIVE (single transaction)
//      Flips the session draft→published AND the snapshot building→live together, so
//      there is no window where one is true and the other is not.
//
// Building BEFORE the status flip is deliberate: it means a public page can never observe
// a half-copied race.


import { requireEligibleSession } from '@/features/race-operations/services/eventGate'
import { fetchStoredRowPage } from '@/features/race-operations/repositories/resultRepo'
import {
  advanceSnapshotProgress, openSnapshotBuild, writeSnapshotChunk,
} from '@/features/race-operations/repositories/snapshotRepo'
import { checkRegistrationGate } from '@/features/race-operations/lifecycle/transitions'
import { resolveRace } from '@/features/race-operations/repositories/eventReadRepo'
import { passSlug } from '@/features/race-operations/utils/publicKeys'
import { snapshotId } from '@/features/race-operations/types/snapshot'
import type { ServiceOutcome } from './importService'

/**
 * Rows copied per build call.
 *
 * RD-RACEOPS-RESULTS-04 · halved from 400. A row can now cost TWO writes — its leaderboard
 * entry and, when it has checkpoints, its splits document — and both must land in the SAME
 * batch so a published version can never hold a result without its splits. 200 rows is
 * therefore at most 400 writes, inside Firestore's 500-write limit with room to spare;
 * `writeSnapshotChunk` throws rather than commit an invalid batch if the two ever drift.
 */
export const SNAPSHOT_CHUNK_SIZE = 200

export interface SnapshotBuildProgress {
  copied:  number
  done:    boolean
  version: number
}

/**
 * Copies ONE page of stored rows into the snapshot. Call repeatedly until `done` — the
 * same drive-loop convention used for ranking.
 *
 * Resumable via `afterRowNumber`: rows are copied in file order, and the caller threads
 * the last row number back in. Re-copying a page is harmless because entry ids are the
 * normalised bib.
 */
export async function buildSnapshotChunk(params: {
  sessionId:       string
  workspaceUid:    string
  afterRowNumber?: number | null
}): Promise<ServiceOutcome<SnapshotBuildProgress & { nextCursor: number | null }>> {
  const { sessionId, workspaceUid, afterRowNumber } = params

  const gated = await requireEligibleSession(sessionId, workspaceUid)
  if (!gated.ok) return gated
  const session = gated.session
  if (session.status !== 'draft') {
    return { ok: false, status: 409, error: `Cannot build a snapshot from a ${session.status} import.` }
  }

  // ═══ RD-RESULTS-CLOSURE-02 · the start-list gate, enforced HERE ═════════════
  // The snapshot is the public read model. Building one from rows that have not been
  // proven to belong to this race is what left rejected entries lying in the entries
  // subcollection at all. Same pure gate the publish transition uses.
  const gate = checkRegistrationGate(session.registrationCheck)
  if (!gate.ok) return { ok: false, status: gate.status, error: gate.reason }

  if (session.rankedAt === null) {
    return { ok: false, status: 422, error: 'Results must finish ranking before a snapshot can be built.' }
  }

  // Public identity for the race. Read once per call; cheap and keeps the snapshot's
  // display fields honest even if the organizer renamed the pass mid-flow.
  const resolved = await resolveRace(workspaceUid, session.eventId, session.passId)
  if (!resolved.ok) return { ok: false, status: resolved.status, error: resolved.error }

  const id = snapshotId(session.eventSlug, session.passId)

  // ═══ RD-RESULTS-CLOSURE-02 · progress is server-owned ═══════════════════════
  // The version, whether this session already owns the pending lane, and where its build
  // got to all come from ONE read of the snapshot document. `afterRowNumber` from the
  // request body is deliberately ignored — it is accepted only so the existing client
  // contract keeps compiling, and a replayed chunk must not be able to rewind the build.
  //
  // RD-RACEOPS-02G · that read and the claim of a NEW lane are one transaction, so the
  // version is allocated exactly once per race however many builds race for it, and never
  // from the rolled-back live pointer. A resume writes nothing (the lane is already this
  // session's); a fresh open resets the counts and the cursor with the claim.
  void afterRowNumber
  const opened = await openSnapshotBuild({
    eventSlug:    session.eventSlug,
    eventName:    resolved.race.eventName,
    eventDate:    resolved.race.eventDate,
    passId:       session.passId,
    passSlug:     passSlug(resolved.race.passName, session.passId),
    passName:     resolved.race.passName,
    organizerUid: session.organizerUid,
    eventId:      session.eventId,
    sessionId:    session.sessionId,
    publishedBy:  session.uploadedBy,
  })
  if (!opened.ok) return { ok: false, status: opened.status, error: opened.error }
  const state = opened.state
  const version = state.version

  const page = await fetchStoredRowPage(sessionId, SNAPSHOT_CHUNK_SIZE, state.cursor)
  if (page.rows.length === 0) {
    return { ok: true, value: { copied: 0, done: true, version, nextCursor: null } }
  }

  // RD-RACEOPS-RESULTS-04 · the group sizes computed by the ranking pass travel with the
  // rows, so each entry's "4 / 56" denominator is written beside the rank it belongs to.
  const { written, finishers } = await writeSnapshotChunk(id, version, page.rows, session.rankGroups ?? null)

  // The last row copied — `page.nextCursor` is null on the final page, so fall back to the
  // page's own last row number. Persisting it means a replay resumes AFTER this page.
  const copiedThrough = page.nextCursor ?? page.rows[page.rows.length - 1].rowNumber
  const credited = await advanceSnapshotProgress(id, sessionId, version, copiedThrough, written, finishers)
  if (!credited) {
    // Another session claimed this race's lane while this chunk was copying. The rows
    // just written carry a version that will never be promoted; the organizer rebuilds.
    return { ok: false, status: 409, error: 'Another import took over the public snapshot for this race. Rebuild it and try again.' }
  }

  return {
    ok: true,
    value: {
      copied:     written,
      done:       page.nextCursor === null,
      version,
      nextCursor: page.nextCursor,
    },
  }
}

// RD-RESULTS-FIX-01 · `supersedePreviousSnapshot` was removed. It had ZERO callers and its
// premise no longer holds: there is one snapshot document per race, so a republish moves
// that document`s version rather than superseding a separate one. Version history and
// rollback live in snapshotRepo (`rollbackSnapshot`, `listSnapshotVersions`).
