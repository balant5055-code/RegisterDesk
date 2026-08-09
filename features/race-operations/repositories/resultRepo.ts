// RD-RACEOPS-01 Sprint 3 · Draft result persistence — SERVER ONLY.
//
// The ONLY module that writes raceImportSessions/{id}/results. Writes are batched and use
// DETERMINISTIC document ids (`row-{rowNumber}`), which is what makes a re-sent chunk
// idempotent: a retry after a dropped connection overwrites the identical document instead
// of creating a duplicate.
//
// Nothing here deletes.

import { adminDb } from '@/lib/firebase/admin'
import {
  RACE_IMPORT_SESSIONS, RACE_RESULTS_SUBCOLLECTION, resultDocId,
  type StoredRaceResultDoc, type StoredResultView,
} from '@/features/race-operations/types/session'
import type { NormalizedRaceResult } from '@/features/race-operations/types/results'

/** Firestore's hard limit is 500 writes per batch. */
const MAX_BATCH_WRITES = 500

const resultsCol = (sessionId: string) =>
  adminDb.collection(RACE_IMPORT_SESSIONS).doc(sessionId).collection(RACE_RESULTS_SUBCOLLECTION)

export interface PersistScope {
  sessionId:    string
  organizerUid: string
  eventSlug:    string
  passId:       string
}

/**
 * Writes one chunk of validated results as DRAFT rows.
 *
 * Ranks are written as `null` here — ranking is a separate, resumable pass. Returns how
 * many documents were written so the caller can advance `storedRows`.
 *
 * Callers MUST keep a chunk at or under MAX_BATCH_WRITES; the route enforces that before
 * calling, and this throws rather than silently truncating.
 */
export async function persistResultChunk(
  scope:   PersistScope,
  results: readonly NormalizedRaceResult[],
): Promise<number> {
  if (results.length === 0) return 0
  if (results.length > MAX_BATCH_WRITES) {
    throw new Error(`Chunk too large: ${results.length} rows exceeds the ${MAX_BATCH_WRITES}-write batch limit.`)
  }

  const batch = adminDb.batch()
  const col   = resultsCol(scope.sessionId)

  for (const r of results) {
    const doc: StoredRaceResultDoc = {
      rowNumber:       r.rowNumber,
      // Sprint 4: carried through so the public snapshot can show a Runner column and
      // support name search. Optional — many timing files carry only bibs.
      participantName: r.participantName,
      bibNumber:      r.bibNumber,
      chipTimeMs:     r.chipTimeMs,
      gunTimeMs:      r.gunTimeMs,
      chipTimeRaw:    r.chipTimeRaw,
      gunTimeRaw:     r.gunTimeRaw,
      status:         r.status,
      statusRaw:      r.statusRaw,
      // Stored but NOT ranked in Sprint 3 (Step 4) — kept so a later sprint can rank them
      // once the data source is approved, with no backfill.
      gender:         r.gender,
      category:       r.category,
      ageGroup:       r.ageGroup,
      rawRow:         { ...r.rawRow },
      sourceProvider: r.sourceProvider,
      overallRank:    null,
      passRank:       null,
      sessionId:      scope.sessionId,
      organizerUid:   scope.organizerUid,
      eventSlug:      scope.eventSlug,
      passId:         scope.passId,
    }
    // set() with a deterministic id ⇒ idempotent on retry.
    batch.set(col.doc(resultDocId(r.rowNumber)), doc)
  }

  await batch.commit()
  return results.length
}

// ─── Ranking reads / writes ───────────────────────────────────────────────────

export interface RankablePage {
  rows: Array<{ rowNumber: number; chipTimeMs: number }>
  /** Feed back as `afterChipTimeMs`/`afterRowNumber` to continue. Null ⇒ page was the last. */
  nextCursor: { chipTimeMs: number; rowNumber: number } | null
}

/**
 * One page of rankable finishers in ascending chip time.
 *
 * Ordered by (chipTimeMs, rowNumber) — the second key makes the order TOTAL, so paging is
 * gap-free and duplicate-free even when many finishers share a time. Firestore supplies the
 * sort, so the resumable walk needs no in-memory global sort.
 */
export async function fetchRankablePage(
  sessionId: string,
  pageSize:  number,
  after?:    { chipTimeMs: number; rowNumber: number } | null,
): Promise<RankablePage> {
  let q = resultsCol(sessionId)
    .where('status', '==', 'finished')
    .orderBy('chipTimeMs', 'asc')
    .orderBy('rowNumber', 'asc')
    .limit(pageSize)

  if (after) q = q.startAfter(after.chipTimeMs, after.rowNumber)

  const snap = await q.get()
  const rows = snap.docs
    .map(d => d.data() as StoredRaceResultDoc)
    // Defensive: a finisher with no usable time is not rankable. Validation flags such a
    // row as an error, so it should not be here — the engine does not assume that.
    .filter(r => typeof r.chipTimeMs === 'number' && r.chipTimeMs > 0)
    .map(r => ({ rowNumber: r.rowNumber, chipTimeMs: r.chipTimeMs as number }))

  const last = rows.length > 0 ? rows[rows.length - 1] : null
  return {
    rows,
    // A short page means the collection is exhausted.
    nextCursor: snap.size === pageSize && last ? { chipTimeMs: last.chipTimeMs, rowNumber: last.rowNumber } : null,
  }
}

/** Writes computed ranks back. Both ranks are set together so a row is never half-ranked. */
export async function writeRankChunk(
  sessionId:   string,
  assignments: ReadonlyArray<{ rowNumber: number; rank: number }>,
): Promise<void> {
  if (assignments.length === 0) return
  if (assignments.length > MAX_BATCH_WRITES) {
    throw new Error(`Rank chunk too large: ${assignments.length} exceeds ${MAX_BATCH_WRITES}.`)
  }

  const batch = adminDb.batch()
  const col   = resultsCol(sessionId)
  for (const a of assignments) {
    // Sprint 3: a session is one (event, pass), so pass rank IS the session rank. Both are
    // written from the same sequence — see ranking/engine.ts and the note in
    // RD-RACEOPS-IMPORT-LIFECYCLE.md §Ranking.
    batch.update(col.doc(resultDocId(a.rowNumber)), { overallRank: a.rank, passRank: a.rank })
  }
  await batch.commit()
}

// ─── Review reads ─────────────────────────────────────────────────────────────

export interface ResultPage {
  rows:       StoredResultView[]
  nextCursor: number | null    // last rowNumber returned
}

/** A page of stored rows in FILE order, for the organizer's review screen. */
export async function fetchResultPage(
  sessionId: string,
  pageSize:  number,
  afterRowNumber?: number | null,
): Promise<ResultPage> {
  let q = resultsCol(sessionId).orderBy('rowNumber', 'asc').limit(pageSize)
  if (typeof afterRowNumber === 'number') q = q.startAfter(afterRowNumber)

  const snap = await q.get()
  const rows: StoredResultView[] = snap.docs.map(d => {
    const r = d.data() as StoredRaceResultDoc
    return {
      rowNumber:   r.rowNumber,
      bibNumber:   r.bibNumber,
      chipTimeMs:  r.chipTimeMs,
      gunTimeMs:   r.gunTimeMs,
      chipTimeRaw: r.chipTimeRaw,
      status:      r.status,
      overallRank: r.overallRank,
      passRank:    r.passRank,
    }
  })

  return {
    rows,
    nextCursor: snap.size === pageSize && rows.length > 0 ? rows[rows.length - 1].rowNumber : null,
  }
}

export interface StoredRowPage {
  rows:       StoredRaceResultDoc[]
  nextCursor: number | null
}

/**
 * A page of FULL stored documents in file order — the snapshot builder's source.
 *
 * Distinct from `fetchResultPage`, which returns the trimmed organizer VIEW. The snapshot
 * needs fields the view omits (participantName, passRank), so it reads the documents.
 */
export async function fetchStoredRowPage(
  sessionId: string,
  pageSize:  number,
  afterRowNumber?: number | null,
): Promise<StoredRowPage> {
  let q = resultsCol(sessionId).orderBy('rowNumber', 'asc').limit(pageSize)
  if (typeof afterRowNumber === 'number') q = q.startAfter(afterRowNumber)

  const snap = await q.get()
  const rows = snap.docs.map(d => d.data() as StoredRaceResultDoc)

  return {
    rows,
    nextCursor: snap.size === pageSize && rows.length > 0
      ? rows[rows.length - 1].rowNumber
      : null,
  }
}

/** Authoritative stored-row count. Uses an aggregate query — no document reads. */
export async function countStoredResults(sessionId: string): Promise<number> {
  const agg = await resultsCol(sessionId).count().get()
  return agg.data().count
}
