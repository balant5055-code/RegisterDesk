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


import { getOwnedSession } from '@/features/race-operations/repositories/sessionRepo'
import { fetchStoredRowPage } from '@/features/race-operations/repositories/resultRepo'
import {
  advanceSnapshotProgress, beginSnapshot, resolveBuildState, writeSnapshotChunk,
} from '@/features/race-operations/repositories/snapshotRepo'
import { checkRegistrationGate } from '@/features/race-operations/lifecycle/transitions'
import { resolveRace } from '@/features/race-operations/repositories/eventReadRepo'
import { passSlug } from '@/features/race-operations/utils/publicKeys'
import { snapshotId } from '@/features/race-operations/types/snapshot'
import type { ServiceOutcome } from './importService'

/** Rows copied per build call. Under the 500-write batch limit. */
export const SNAPSHOT_CHUNK_SIZE = 400

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

  const session = await getOwnedSession(sessionId, workspaceUid)
  if (!session) return { ok: false, status: 404, error: 'Import session not found' }
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
  void afterRowNumber
  const state = await resolveBuildState(session.eventSlug, session.passId, sessionId)
  const version = state.version

  // Opened once per build, not once per chunk: `beginSnapshot` resets the counts and the
  // cursor, so calling it on a resume would restart the build and double-count.
  if (!state.owns) {
    await beginSnapshot({
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
      version,
    })
  }

  const page = await fetchStoredRowPage(sessionId, SNAPSHOT_CHUNK_SIZE, state.cursor)
  if (page.rows.length === 0) {
    return { ok: true, value: { copied: 0, done: true, version, nextCursor: null } }
  }

  const { written, finishers } = await writeSnapshotChunk(id, version, page.rows)

  // The last row copied — `page.nextCursor` is null on the final page, so fall back to the
  // page's own last row number. Persisting it means a replay resumes AFTER this page.
  const copiedThrough = page.nextCursor ?? page.rows[page.rows.length - 1].rowNumber
  await advanceSnapshotProgress(id, copiedThrough, written, finishers)

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
