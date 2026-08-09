// RD-RACEOPS-01 Sprint 3 · Import services — SERVER ONLY.
//
// Orchestration only: routes authorize + parse input, these functions own the use case,
// repositories own Firestore. No business rule lives in a route handler.
//
// The server RE-VALIDATES every submitted record with the same pure engine the browser
// ran. Client-reported counts are never trusted — the stored validRows/warningCount/
// errorCount are the server's own.

import {
  RESULTS_MAX_ROWS, validateResults,
} from '@/features/race-operations/import'
import { rankChunk } from '@/features/race-operations/ranking/engine'
import { INITIAL_RANK_STATE, type RankState } from '@/features/race-operations/ranking/ties'
import { resolveRace } from '@/features/race-operations/repositories/eventReadRepo'
import {
  bumpStoredRows, clearRegistrationCheck, completeRanking, createSession, findPublishedSessionForRace,
  getOwnedSession, resetRanking, saveRankProgress, transitionSession,
} from '@/features/race-operations/repositories/sessionRepo'
import {
  countStoredResults, fetchRankablePage, persistResultChunk, writeRankChunk,
} from '@/features/race-operations/repositories/resultRepo'
import { nextSnapshotVersion, snapshotRef } from '@/features/race-operations/repositories/snapshotRepo'
import { checkRegistrationGate } from '@/features/race-operations/lifecycle/transitions'
import type { ColumnMapping, NormalizedRaceResult } from '@/features/race-operations/types/results'
import type { ImportSessionDoc } from '@/features/race-operations/types/session'

/** Rows accepted per append request. Under Firestore's 500-write batch limit, and small
 *  enough that a chunk's JSON stays well inside a serverless body limit. */
export const RESULT_CHUNK_SIZE = 400

/** Finishers ranked per `/rank` call. Bounded so one request cannot run long. */
export const RANK_PAGE_SIZE = 400

export type ServiceOutcome<T> =
  | { ok: true;  value: T }
  | { ok: false; status: number; error: string }

// ─── Create session ───────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  workspaceUid: string
  callerUid:    string
  eventId:      string
  passId:       string
  fileName:     string
  fileHash:     string
  provider:     string
  mapping:      ColumnMapping
  totalRows:    number
}

/**
 * Creates the immutable session. Counts recorded here are the CLIENT's parse totals for
 * `totalRows`; the validation counts start at zero and are recomputed by the server as
 * chunks land (see `appendResults`).
 */
export async function createImportSession(
  req: CreateSessionRequest,
): Promise<ServiceOutcome<ImportSessionDoc>> {
  if (req.totalRows <= 0) {
    return { ok: false, status: 422, error: 'This file contains no result rows.' }
  }
  if (req.totalRows > RESULTS_MAX_ROWS) {
    return {
      ok: false, status: 422,
      error: `This file has ${req.totalRows.toLocaleString('en-IN')} rows; the maximum is ${RESULTS_MAX_ROWS.toLocaleString('en-IN')}.`,
    }
  }

  const resolved = await resolveRace(req.workspaceUid, req.eventId, req.passId)
  if (!resolved.ok) return { ok: false, status: resolved.status, error: resolved.error }

  const session = await createSession({
    eventId:      resolved.race.eventId,
    eventSlug:    resolved.race.eventSlug,
    organizerUid: req.workspaceUid,
    passId:       resolved.race.passId,
    passName:     resolved.race.passName,
    uploadedBy:   req.callerUid,
    fileName:     req.fileName,
    fileHash:     req.fileHash,
    provider:     req.provider,
    mapping:      req.mapping,
    totalRows:    req.totalRows,
    // Server-derived; accumulated by appendResults.
    validRows:    0,
    warningCount: 0,
    errorCount:   0,
  })

  return { ok: true, value: session }
}

// ─── Append a chunk of draft results ──────────────────────────────────────────

export interface AppendResultsOutcome {
  written:     number
  storedRows:  number
  /** The server's OWN validation counts for this chunk. */
  chunkValid:   number
  chunkWarning: number
  chunkError:   number
}

export async function appendResults(params: {
  sessionId:    string
  workspaceUid: string
  results:      readonly NormalizedRaceResult[],
}): Promise<ServiceOutcome<AppendResultsOutcome>> {
  const { sessionId, workspaceUid, results } = params

  if (results.length === 0) {
    return { ok: false, status: 422, error: 'This request contained no rows.' }
  }
  if (results.length > RESULT_CHUNK_SIZE) {
    return { ok: false, status: 413, error: `Send at most ${RESULT_CHUNK_SIZE} rows per request.` }
  }

  const session = await getOwnedSession(sessionId, workspaceUid)
  if (!session) return { ok: false, status: 404, error: 'Import session not found' }
  if (session.status !== 'draft') {
    return { ok: false, status: 409, error: `Cannot add rows to a ${session.status} import.` }
  }

  // ── Server-side re-validation. The browser's result is a convenience, never the
  //    authority: only rows the SERVER considers usable are persisted.
  const validation = validateResults(results)
  const usable = validation.rows.filter(r => r.usable).map(r => r.result)

  const written = await persistResultChunk(
    { sessionId, organizerUid: session.organizerUid, eventSlug: session.eventSlug, passId: session.passId },
    usable,
  )

  if (written > 0) {
    await bumpStoredRows(sessionId, written)
    // Rows changed ⇒ any completed ranking is now stale. Clearing rankedAt makes publish
    // impossible until ranking is re-run, which is the safe direction.
    if (session.rankedAt !== null) await resetRanking(sessionId)
    // RD-RESULTS-FIX-01 · rows changed, so any earlier start-list check describes a file
    // that no longer exists. Cleared for the same reason ranking is: a stale pass is worse
    // than none, because publish would trust it.
    if (session.registrationCheck) await clearRegistrationCheck(sessionId)
  }

  return {
    ok: true,
    value: {
      written,
      storedRows:   session.storedRows + written,
      chunkValid:   validation.summary.validRows,
      chunkWarning: validation.summary.warningCount,
      chunkError:   validation.summary.errorCount,
    },
  }
}

// ─── Ranking (resumable) ──────────────────────────────────────────────────────

export interface RankProgress {
  processed: number
  done:      boolean
}

/**
 * Ranks ONE page of finishers and persists both the ranks and the resume cursor.
 *
 * Call repeatedly until `done` — the same drive-loop convention the registration importer
 * uses (`.../import/[jobId]/process`). Ties spanning a page boundary stay correct because
 * the cursor carries the last time and last rank.
 */
export async function rankSessionChunk(params: {
  sessionId:    string
  workspaceUid: string
}): Promise<ServiceOutcome<RankProgress>> {
  const { sessionId, workspaceUid } = params

  const session = await getOwnedSession(sessionId, workspaceUid)
  if (!session) return { ok: false, status: 404, error: 'Import session not found' }
  if (session.status !== 'draft') {
    return { ok: false, status: 409, error: `Cannot rank a ${session.status} import.` }
  }
  if (session.storedRows === 0) {
    return { ok: false, status: 422, error: 'There are no stored results to rank.' }
  }

  // ═══ RD-RESULTS-CLOSURE-02 · the start-list gate, enforced HERE ═════════════
  // Verification now runs immediately after storing, before this pass. Ranking is an
  // expensive write over every finisher, and ranks computed across a row set containing
  // bibs that belong to nobody are wrong for everyone below them — so the order is
  // enforced by the server, not merely driven by the browser's commit hook.
  const gate = checkRegistrationGate(session.registrationCheck)
  if (!gate.ok) return { ok: false, status: gate.status, error: gate.reason }

  if (session.rankedAt !== null) {
    // Already complete — idempotent success rather than an error, so a duplicate call from
    // a retried drive-loop is harmless.
    return { ok: true, value: { processed: session.rankedRows, done: true } }
  }

  const cursor = session.rankCursor
  const state: RankState = cursor
    ? { lastTimeMs: cursor.lastChipTimeMs, lastRank: cursor.lastRank, processed: cursor.processed }
    : INITIAL_RANK_STATE

  // (chipTimeMs, rowNumber) is the total order Firestore pages on.
  const after = cursor
    ? { chipTimeMs: cursor.lastChipTimeMs, rowNumber: cursor.lastRowNumber }
    : null

  const page = await fetchRankablePage(sessionId, RANK_PAGE_SIZE, after)

  // No rankable rows left — either the session has no finishers at all, or the previous
  // call consumed the last of them.
  if (page.rows.length === 0) {
    await completeRanking(sessionId, state.processed)
    return { ok: true, value: { processed: state.processed, done: true } }
  }

  const { assignments, state: nextState } = rankChunk(page.rows, state)
  await writeRankChunk(sessionId, assignments)

  if (page.nextCursor === null) {
    await completeRanking(sessionId, nextState.processed)
    return { ok: true, value: { processed: nextState.processed, done: true } }
  }

  await saveRankProgress(sessionId, {
    lastChipTimeMs: page.nextCursor.chipTimeMs,
    lastRowNumber:  page.nextCursor.rowNumber,
    lastRank:       nextState.lastRank,
    processed:      nextState.processed,
  })

  return { ok: true, value: { processed: nextState.processed, done: false } }
}

// ─── Publish / cancel ─────────────────────────────────────────────────────────

export async function publishSession(params: {
  sessionId:    string
  workspaceUid: string
  callerUid:    string
}): Promise<ServiceOutcome<ImportSessionDoc>> {
  const { sessionId, workspaceUid, callerUid } = params

  const session = await getOwnedSession(sessionId, workspaceUid)
  if (!session) return { ok: false, status: 404, error: 'Import session not found' }

  // Resolved OUTSIDE the transaction — Firestore transactions cannot run queries.
  const other = await findPublishedSessionForRace(
    workspaceUid, session.eventId, session.passId, sessionId,
  )

  // Reconcile storedRows against the authoritative document count before allowing a
  // publish, so a session whose counter drifted (interrupted chunk) cannot slip through.
  const actual = await countStoredResults(sessionId)
  if (actual !== session.storedRows) {
    return {
      ok: false, status: 409,
      error: `This import is incomplete — ${actual.toLocaleString('en-IN')} of ${session.storedRows.toLocaleString('en-IN')} rows were stored. Re-run the import or cancel it.`,
    }
  }

  // Sprint 4: the Official Snapshot must already be built, and goes live in the SAME
  // transaction as the session's status flip.
  //
  // RD-RESULTS-CLOSURE-02 · resolved for THIS session. A session that did not open the
  // current pending lane resolves to a new version, which the go-live transaction then
  // rejects against `pendingVersion` — so a session can never promote another session's
  // rows. Publish behaviour for the normal path is unchanged.
  const version = await nextSnapshotVersion(session.eventSlug, session.passId, sessionId)

  const outcome = await transitionSession({
    sessionId, organizerUid: workspaceUid, actorUid: callerUid,
    action: 'publish',
    racePublishedElsewhere: other !== null,
    goLiveSnapshot: { ref: snapshotRef(session.eventSlug, session.passId), version },
  })

  return outcome.ok
    ? { ok: true, value: outcome.session }
    : { ok: false, status: outcome.status, error: outcome.error }
}

export async function cancelSession(params: {
  sessionId:    string
  workspaceUid: string
  callerUid:    string
  reason?:      string
}): Promise<ServiceOutcome<ImportSessionDoc>> {
  const outcome = await transitionSession({
    sessionId:    params.sessionId,
    organizerUid: params.workspaceUid,
    actorUid:     params.callerUid,
    action:       'cancel',
    racePublishedElsewhere: false,   // irrelevant to cancel
    reason:       params.reason,
  })

  return outcome.ok
    ? { ok: true, value: outcome.session }
    : { ok: false, status: outcome.status, error: outcome.error }
}
