// RD-RACEOPS-01 Sprint 3 · Import services — SERVER ONLY.
//
// Orchestration only: routes authorize + parse input, these functions own the use case,
// repositories own Firestore. No business rule lives in a route handler.
//
// The server RE-VALIDATES every submitted record with the same pure engine the browser
// ran. Client-reported counts are never trusted — the stored validRows/warningCount/
// errorCount are the server's own.

import {
  RESULTS_MAX_ROWS, sanitizeSplits, validateResults,
} from '@/features/race-operations/import'
import { rankChunk } from '@/features/race-operations/ranking/engine'
import { INITIAL_RANK_STATE, type RankState } from '@/features/race-operations/ranking/ties'
import {
  INITIAL_GROUP_STATES, groupTotalsFrom, rankGroupChunk,
  type GroupRankStates, type RankDimension,
} from '@/features/race-operations/ranking/groups'
import { resolveRace } from '@/features/race-operations/repositories/eventReadRepo'
import {
  clearRegistrationCheck, completeRanking, createSession, findPublishedSessionForRace,
  resetRanking, saveRankProgress, setStoredRows, transitionSession,
} from '@/features/race-operations/repositories/sessionRepo'
import { requireEligibleSession } from '@/features/race-operations/services/eventGate'
import {
  countStoredResults, fetchRankablePage, findStoredRowsByBib, persistResultChunk, writeRankChunk,
} from '@/features/race-operations/repositories/resultRepo'
import { nextSnapshotVersion, resetPendingSnapshot, snapshotRef } from '@/features/race-operations/repositories/snapshotRepo'
import { bibKey } from '@/features/race-operations/utils/publicKeys'
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

/** RD-RACEOPS-02C · the message for a refused chunk names the bibs, so the organizer can fix the file. */
export function duplicateBibMessage(bibs: readonly string[]): string {
  const shown = bibs.slice(0, 10).join(', ')
  const more  = bibs.length > 10 ? ` and ${bibs.length - 10} more` : ''
  return `Duplicate bib${bibs.length === 1 ? '' : 's'} in this import: ${shown}${more}. Each bib may appear once per race.`
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

  // RD-RACEOPS-02B · owned AND the event still admits Race Operations.
  const gated = await requireEligibleSession(sessionId, workspaceUid)
  if (!gated.ok) return gated
  const session = gated.session
  if (session.status !== 'draft') {
    return { ok: false, status: 409, error: `Cannot add rows to a ${session.status} import.` }
  }

  // ── Server-side re-validation. The browser's result is a convenience, never the
  //    authority: only rows the SERVER considers usable are persisted.
  const validation = validateResults(results)

  // ═══ RD-RACEOPS-02C · BIB UNIQUENESS IS A SESSION INVARIANT ═══════════════════
  // A bib appears once per race. Within the chunk, validation already names duplicates;
  // across chunks — the case a crafted client or a re-sliced file can produce — the
  // session's stored rows are asked by bib (bounded by the chunk, see
  // `findStoredRowsByBib`). A stored row with the SAME row number is the same row being
  // retried and is allowed; any other row holding the bib is a duplicate. The whole chunk
  // is refused, nothing is written, and the message names the bibs.
  const inChunk = validation.rows
    .filter(r => r.issues.some(i => i.code === 'DUPLICATE_BIB'))
    .map(r => r.result.bibNumber ?? '')
  if (inChunk.length > 0) {
    return { ok: false, status: 409, error: duplicateBibMessage([...new Set(inChunk)]) }
  }
  const usable = validation.rows.filter(r => r.usable).map(r => r.result)
  const stored = await findStoredRowsByBib(sessionId, usable.map(r => bibKey(r.bibNumber ?? '')))
  const acrossChunks = usable
    .filter(r => { const at = stored.get(bibKey(r.bibNumber ?? '')); return at !== undefined && at !== r.rowNumber })
    .map(r => r.bibNumber ?? '')
  if (acrossChunks.length > 0) {
    return { ok: false, status: 409, error: duplicateBibMessage([...new Set(acrossChunks)]) }
  }

  // RD-RACEOPS-RESULTS-04 · checkpoints pass the server's own gate before they are stored:
  // unique by `splitKey`, timed, bounded and resequenced (see `sanitizeSplits`). The browser
  // already refused these cases and told the organizer about them; this is the layer that
  // holds when the request did not come from the browser.
  const sanitized = usable.map(r => (r.splits?.length ? { ...r, splits: sanitizeSplits(r.splits) } : r))

  await persistResultChunk(
    { sessionId, organizerUid: session.organizerUid, eventSlug: session.eventSlug, passId: session.passId },
    sanitized,
  )

  // `storedRows` is the aggregate's answer, not an increment: a retried chunk overwrites
  // the same documents and the count stays put (P-B), so publish's completeness check
  // compares like with like.
  const storedRows = usable.length > 0 ? await countStoredResults(sessionId) : session.storedRows
  const written = Math.max(0, storedRows - session.storedRows)
  if (usable.length > 0) {
    await setStoredRows(sessionId, storedRows)
    // Rows changed ⇒ any completed ranking is now stale. Clearing rankedAt makes publish
    // impossible until ranking is re-run, which is the safe direction.
    if (session.rankedAt !== null) await resetRanking(sessionId)
    // RD-RESULTS-FIX-01 · rows changed, so any earlier start-list check describes a file
    // that no longer exists. Cleared for the same reason ranking is: a stale pass is worse
    // than none, because publish would trust it.
    if (session.registrationCheck) await clearRegistrationCheck(sessionId)
    // RD-RACEOPS-02C · and a pending public snapshot built from the old rows is stale too:
    // its copied entries carry ranks that will change. Reset so the next build starts from
    // the top; until it completes, publish is refused by the completeness check.
    await resetPendingSnapshot(session.eventSlug, session.passId, sessionId)
  }

  return {
    ok: true,
    value: {
      written,
      storedRows,
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

  const gated = await requireEligibleSession(sessionId, workspaceUid)
  if (!gated.ok) return gated
  const session = gated.session
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

  // RD-RACEOPS-RESULTS-04 · the gender / age-group lanes resume from the same cursor. A
  // session ranked before this sprint has no `groups` on its cursor and simply starts its
  // group lanes empty — the rows it already wrote carry no group rank, which is correct for
  // a file whose groups were never counted.
  const groupStates: GroupRankStates = cursor?.groups ?? INITIAL_GROUP_STATES
  const alreadyAbandoned: RankDimension[] = cursor?.abandoned ?? []

  // (chipTimeMs, rowNumber) is the total order Firestore pages on.
  const after = cursor
    ? { chipTimeMs: cursor.lastChipTimeMs, rowNumber: cursor.lastRowNumber }
    : null

  const page = await fetchRankablePage(sessionId, RANK_PAGE_SIZE, after)

  // No rankable rows left — either the session has no finishers at all, or the previous
  // call consumed the last of them.
  if (page.rows.length === 0) {
    // Nothing left to rank: whatever the lanes already counted IS the final group size.
    await completeRanking(sessionId, state.processed, {
      groups:    groupTotalsFrom(groupStates),
      abandoned: alreadyAbandoned,
    })
    return { ok: true, value: { processed: state.processed, done: true } }
  }

  const { assignments, state: nextState } = rankChunk(page.rows, state)

  // ═══ RD-RACEOPS-RESULTS-04 · group ranks, same rows, same order ══════════════
  // The page is already in ascending chip time — the only order any of these ranks depend
  // on — so every dimension is assigned from ONE walk. No second query, no extra index, and
  // a tie inside a group resolves through the same `nextRank` rule as the overall tie.
  const groups = rankGroupChunk(page.rows, groupStates)
  const abandoned = [...new Set([...alreadyAbandoned, ...groups.abandoned])]
  const groupRankByRow = new Map(groups.assignments.map(a => [a.rowNumber, a]))

  await writeRankChunk(sessionId, assignments.map(a => {
    const g = groupRankByRow.get(a.rowNumber)
    return {
      ...a,
      // A dimension abandoned mid-walk must not leave half the field ranked: every row
      // written from here on carries null, and `completeRanking` records that the dimension
      // has no ranking at all.
      genderRank:   abandoned.includes('gender')   ? null : g?.genderRank   ?? null,
      ageGroupRank: abandoned.includes('ageGroup') ? null : g?.ageGroupRank ?? null,
    }
  }))

  if (page.nextCursor === null) {
    await completeRanking(sessionId, nextState.processed, {
      groups:    groupTotalsFrom(groups.states),
      abandoned,
    })
    return { ok: true, value: { processed: nextState.processed, done: true } }
  }

  await saveRankProgress(sessionId, {
    lastChipTimeMs: page.nextCursor.chipTimeMs,
    lastRowNumber:  page.nextCursor.rowNumber,
    lastRank:       nextState.lastRank,
    groups:         groups.states,
    abandoned,
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

  // RD-RACEOPS-02B · the event's capability is re-checked at the moment of publishing, not
  // only when the session was created.
  const gated = await requireEligibleSession(sessionId, workspaceUid)
  if (!gated.ok) return gated
  const session = gated.session

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
  // RD-RACEOPS-02B · same gate as every other session operation; the transaction below
  // still proves ownership itself.
  const gated = await requireEligibleSession(params.sessionId, params.workspaceUid)
  if (!gated.ok) return gated
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
