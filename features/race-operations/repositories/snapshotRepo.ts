// RD-RACEOPS-01 Sprint 4 · Official Snapshot — SERVER ONLY.
//
// Two distinct halves, deliberately in one file so the write shape and the read shape are
// impossible to drift apart:
//
//   WRITE  — called only by the publish pipeline (organizer-authorized).
//   READ   — called only by public pages. Every public reader returns a PROJECTION that
//            physically cannot carry organizerUid / eventId / sessionId, because those
//            fields are never copied into the returned object.
//
// No public reader ever touches `raceImportSessions`.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  RACE_SNAPSHOTS, RACE_SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_ENTRIES_SUBCOLLECTION,
  snapshotId,
  type PublicRaceSummary, type PublicResultRow, type RaceSnapshotDoc,
  type SnapshotEntryDoc, type SnapshotVersionRecord,
} from '@/features/race-operations/types/snapshot'
import { PREFIX_UPPER_BOUND, bibKey, entryKey, nameKey } from '@/features/race-operations/utils/publicKeys'
// The public projections are PURE and live outside this module, so the security boundary is
// unit-testable without booting Firebase Admin.
import { toPublicRace, toPublicRow } from '@/features/race-operations/utils/publicProjection'
export { toPublicRace } from '@/features/race-operations/utils/publicProjection'
import type { StoredRaceResultDoc } from '@/features/race-operations/types/session'

const MAX_BATCH_WRITES = 500

const snapshots     = () => adminDb.collection(RACE_SNAPSHOTS)
const entriesCol    = (id: string) => snapshots().doc(id).collection(SNAPSHOT_ENTRIES_SUBCOLLECTION)


// ══════════════════════════ WRITE (publish pipeline) ══════════════════════════

export interface SnapshotSeed {
  eventSlug:    string
  eventName:    string
  eventDate:    string | null
  passId:       string
  passSlug:     string
  passName:     string
  organizerUid: string
  eventId:      string
  sessionId:    string
  publishedBy:  string
  version:      number
}

/**
 * Creates or re-opens the snapshot in `building` state.
 *
 * `building` is never publicly readable, so a partially-copied snapshot can never be
 * served — the flip to `live` happens once, transactionally, at the end.
 */
export async function beginSnapshot(seed: SnapshotSeed): Promise<RaceSnapshotDoc> {
  const id  = snapshotId(seed.eventSlug, seed.passId)
  const ref = snapshots().doc(id)
  const existing = await ref.get()
  const live = existing.exists ? existing.data() as RaceSnapshotDoc : null

  // RD-RESULTS-FIX-01 · a build NEVER disturbs the live version.
  //
  // On a REPUBLISH the live fields (`status`, `version`, `totalCount`, `finisherCount`,
  // `publishedAt`) are left exactly as they are and the new rows accumulate in the pending
  // lane, so the public keeps seeing the current results for the whole rebuild — including
  // if the organizer abandons it. Promotion happens only in the go-live transaction.
  //
  // On a FIRST publish there is nothing live to protect, so the document is seeded in
  // `building` exactly as before and the public sees nothing until go-live.
  const pending = {
    pendingVersion:       seed.version,
    pendingSessionId:     seed.sessionId,
    pendingBuiltAt:       FieldValue.serverTimestamp(),
    pendingTotalCount:    0,
    pendingFinisherCount: 0,
    // RD-RESULTS-CLOSURE-02 · a fresh build starts from the top. Resetting the cursor
    // together with the counts is what makes "begin" mean the same thing to both.
    pendingCursor:        null,
  }

  await ref.set(live?.status === 'live'
    ? {
        // Display identity is refreshed — an organizer may have renamed the pass — but the
        // version, status and counts the public reads are untouched.
        eventName: seed.eventName, eventDate: seed.eventDate,
        passSlug:  seed.passSlug,  passName:  seed.passName,
        ...pending,
      }
    : {
        ...seed,
        snapshotId:    id,
        schemaVersion: RACE_SNAPSHOT_SCHEMA_VERSION,
        status:        'building',
        builtAt:       FieldValue.serverTimestamp(),
        publishedAt:   null,
        totalCount:    0,
        finisherCount: 0,
        ...pending,
      },
  { merge: true })

  return (await ref.get()).data() as RaceSnapshotDoc
}

/** RD-RESULTS-CLOSURE-02 · everything a build needs to know, from ONE read. */
export interface SnapshotBuildState {
  /** The version THIS session must build into. */
  version: number
  /** True when a pending lane already exists AND belongs to this session. */
  owns:    boolean
  /** Server-owned resume cursor. Null when this session has not copied a row yet. */
  cursor:  number | null
}

/**
 * Resolves the version and resume point for one session's build.
 *
 * ═══ RD-RESULTS-CLOSURE-02 · PENDING LANES ARE NOW OWNED ══════════════════════
 * This used to reuse `pendingVersion` for ANY caller. A build abandoned by one session
 * therefore handed its version — and its already-written entries — to the next session,
 * and nothing in this module ever deletes an entry. So:
 *
 *   import A (bibs 101,102,999) builds pending v2 → verification rejects 999 → cancelled
 *   import B (bibs 101,102) reuses v2, overwrites 101/102 → `v2__999` survives
 *   publish promotes v2 → the leaderboard serves 999, the exact runner verification
 *   rejected, while `totalCount` says 2.
 *
 * A pending lane is now reused ONLY by the session that opened it. Another session gets a
 * fresh version, so the abandoned entries stay unreachable — every public query filters
 * `v == snapshot.version`, and that version is never promoted. No deletes, no migration,
 * and no rewrite of any live race.
 */
export async function resolveBuildState(
  eventSlug: string, passId: string, sessionId: string,
): Promise<SnapshotBuildState> {
  const snap = await snapshots().doc(snapshotId(eventSlug, passId)).get()
  if (!snap.exists) return { version: 1, owns: false, cursor: null }

  const doc = snap.data() as RaceSnapshotDoc
  const pending = typeof doc.pendingVersion === 'number' && doc.pendingVersion > 0
    ? doc.pendingVersion
    : null

  if (pending !== null) {
    if (doc.pendingSessionId === sessionId) {
      // This session's own build. Resume it — that is what makes the chunked drive loop
      // idempotent rather than version-forking.
      return {
        version: pending,
        owns:    true,
        cursor:  typeof doc.pendingCursor === 'number' ? doc.pendingCursor : null,
      }
    }
    // Someone else's lane, finished or abandoned. Step past BOTH it and the live version so
    // neither this build nor a promotion can collide with entries we did not write.
    return { version: Math.max(pending, doc.version ?? 0) + 1, owns: false, cursor: null }
  }

  // No pending lane. A pre-RD-RESULTS-FIX-01 snapshot left half-built reuses its own
  // version, exactly as before; a live one moves on.
  return {
    version: doc.status === 'building' ? doc.version : doc.version + 1,
    owns:    false,
    cursor:  null,
  }
}

/**
 * The version a race's next publish will carry.
 *
 * RD-RESULTS-CLOSURE-02 · now takes the session, because a pending lane belongs to whoever
 * opened it. A session that did not build the current lane resolves to a NEW version, which
 * the go-live transaction then rejects against `pendingVersion` — the correct outcome: it
 * asks the organizer to rebuild rather than publishing another session's rows.
 */
export async function nextSnapshotVersion(
  eventSlug: string, passId: string, sessionId: string,
): Promise<number> {
  return (await resolveBuildState(eventSlug, passId, sessionId)).version
}

/**
 * Copies one chunk of stored draft rows into the snapshot.
 *
 * Entry id = normalised bib, so a re-run overwrites the same document (idempotent) and a
 * public bib lookup is a single GET. Rows carry `v`, so a superseded version's rows fall
 * out of every public query without being deleted.
 */
export async function writeSnapshotChunk(
  id:      string,
  version: number,
  rows:    readonly StoredRaceResultDoc[],
): Promise<{ written: number; finishers: number }> {
  if (rows.length === 0) return { written: 0, finishers: 0 }
  if (rows.length > MAX_BATCH_WRITES) {
    throw new Error(`Snapshot chunk too large: ${rows.length} exceeds ${MAX_BATCH_WRITES}.`)
  }

  const batch = adminDb.batch()
  const col   = entriesCol(id)
  let finishers = 0

  for (const r of rows) {
    // A row with no bib cannot be addressed publicly. Validation already rejects it, so
    // this is belt-and-braces rather than an expected path.
    if (!r.bibNumber) continue

    const key = bibKey(r.bibNumber)
    const name = r.participantName ?? null

    const entry: SnapshotEntryDoc = {
      v:           version,
      bibNumber:   r.bibNumber,
      bibKey:      key,
      name,
      nameLower:   name ? nameKey(name) : '',
      chipTimeMs:  r.chipTimeMs,
      gunTimeMs:   r.gunTimeMs,
      status:      r.status,
      overallRank: r.overallRank,
      passRank:    r.passRank,
    }
    if (r.status === 'finished') finishers++

    // RD-RESULTS-FIX-01 · versioned id. A republish no longer overwrites the version it
    // replaces, which is what makes rollback possible at all.
    batch.set(col.doc(entryKey(version, r.bibNumber)), entry)
  }

  await batch.commit()
  return { written: rows.length, finishers }
}

/**
 * Records one copied chunk on the PENDING lane: the counts AND the resume cursor, together.
 *
 * RD-RESULTS-FIX-01 · the counts live on the pending lane, not the live one, so a rebuild
 * cannot make the public header climb while the rows behind it are still the old version's.
 *
 * RD-RESULTS-CLOSURE-02 · the cursor moves in the SAME write as the increments. That is what
 * makes a replay harmless: `resolveBuildState` reads this cursor back, so a re-sent chunk
 * copies the NEXT page instead of re-copying the last one and inflating `pendingTotalCount`.
 * Previously the cursor came from the request body, so the client could rewind it — by
 * accident on a retry, or deliberately.
 */
export async function advanceSnapshotProgress(
  id: string, cursor: number | null, deltaTotal: number, deltaFinishers: number,
): Promise<void> {
  await snapshots().doc(id).update({
    pendingTotalCount:    FieldValue.increment(deltaTotal),
    pendingFinisherCount: FieldValue.increment(deltaFinishers),
    pendingCursor:        cursor,
  })
}

/**
 * Flips `building` → `live` inside the caller's transaction.
 *
 * Exposed as a transaction participant (rather than doing its own write) so the session's
 * draft→published flip and the snapshot's building→live flip commit TOGETHER. There is no
 * window in which one is true and the other is not.
 */
export function snapshotRef(eventSlug: string, passId: string) {
  return snapshots().doc(snapshotId(eventSlug, passId))
}

// RD-RESULTS-FIX-01 · `SNAPSHOT_GO_LIVE_PATCH` was removed. It had no callers — the
// go-live patch is built inside the transaction in sessionRepo, because promotion now has
// to move the version and the counts together and append the history record, which a
// constant cannot express.

// ─── RD-RESULTS-FIX-01 · Rollback ─────────────────────────────────────────────

export type RollbackOutcome =
  | { ok: true;  version: number; previousVersion: number }
  | { ok: false; status: number; error: string }

/**
 * Re-points a race at a version it published earlier.
 *
 * ═══ WHY THIS IS SAFE, AND WHY IT WAS NOT BEFORE ═════════════════════════════
 * Nothing is rebuilt and no entry is written. Every version's rows still exist — that is
 * what `entryKey` bought — so restoring one is a single field change on the snapshot
 * document, and every public query picks it up on the next read because they all filter
 * `v == snapshot.version`.
 *
 * Before this sprint a republish overwrote the previous version's entries, so there was
 * nothing to roll back TO; the operation could not have been offered honestly.
 *
 * The target must be a version this race actually published — taken from `versions`, never
 * from the caller's arithmetic — so a typo cannot point a race at a version that was never
 * live, which would render an empty leaderboard for a race that has results.
 */
export async function rollbackSnapshot(params: {
  eventSlug:    string
  passId:       string
  organizerUid: string
  toVersion:    number
  actorUid:     string
}): Promise<RollbackOutcome> {
  const ref = snapshots().doc(snapshotId(params.eventSlug, params.passId))

  return adminDb.runTransaction<RollbackOutcome>(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false, status: 404, error: 'These results have not been published.' }

    const doc = snap.data() as RaceSnapshotDoc
    // Tenant isolation, re-checked here as well as at the route: this repository is the
    // authority on the document, and a caller that forgot would otherwise reach it.
    if (doc.organizerUid !== params.organizerUid) {
      return { ok: false, status: 404, error: 'These results have not been published.' }
    }
    if (doc.status !== 'live') {
      return { ok: false, status: 409, error: 'These results are not currently published.' }
    }
    if (doc.version === params.toVersion) {
      return { ok: false, status: 409, error: 'That version is already the published one.' }
    }

    const target = (doc.versions ?? []).find(v => v.version === params.toVersion)
    if (!target) {
      return { ok: false, status: 404, error: 'That version was never published for this race.' }
    }

    const restoredAt = new Date().toISOString()
    tx.update(ref, {
      version:       target.version,
      totalCount:    target.totalCount,
      finisherCount: target.finisherCount,
      sessionId:     target.sessionId,
      // The history keeps every record it had and gains the fact that this one was
      // restored — a rollback is an event in the race's history, not an erasure of one.
      versions: (doc.versions ?? []).map(v =>
        v.version === target.version
          ? { ...v, restoredAt, restoredBy: params.actorUid }
          : v),
    })

    return { ok: true, version: target.version, previousVersion: doc.version }
  })
}

/** Every published version of a race, newest first. Organizer-facing; never public. */
export async function listSnapshotVersions(
  eventSlug: string, passId: string, organizerUid: string,
): Promise<SnapshotVersionRecord[]> {
  const snap = await snapshots().doc(snapshotId(eventSlug, passId)).get()
  if (!snap.exists) return []
  const doc = snap.data() as RaceSnapshotDoc
  if (doc.organizerUid !== organizerUid) return []
  return [...(doc.versions ?? [])].sort((a, b) => b.version - a.version)
}

// ══════════════════════════ READ (public pages) ═══════════════════════════════
//
// Every function below returns a projection. None accepts an organizer identifier, and
// none can be reached without `status === 'live'`.

/** The live snapshot for a race, or null. Only `live` is ever returned. */
export async function getLiveSnapshot(
  eventSlug: string, passSlug: string,
): Promise<RaceSnapshotDoc | null> {
  const snap = await snapshots()
    .where('eventSlug', '==', eventSlug)
    .where('passSlug', '==', passSlug)
    .where('status', '==', 'live')
    .limit(1)
    .get()

  if (snap.empty) return null
  const doc = snap.docs[0].data() as RaceSnapshotDoc
  return doc.schemaVersion === RACE_SNAPSHOT_SCHEMA_VERSION ? doc : null
}

/**
 * The live snapshot for a race addressed by passId rather than passSlug.
 *
 * Used by the certificate integration, which knows a registration's `passId` but not the
 * public slug. Same `live`-only guarantee as `getLiveSnapshot`.
 */
export async function getLiveSnapshotByPass(
  eventSlug: string, passId: string,
): Promise<RaceSnapshotDoc | null> {
  const snap = await snapshots().doc(snapshotId(eventSlug, passId)).get()
  if (!snap.exists) return null
  const doc = snap.data() as RaceSnapshotDoc
  if (doc.status !== 'live') return null
  return doc.schemaVersion === RACE_SNAPSHOT_SCHEMA_VERSION ? doc : null
}

/** Every live race for an event. */
export async function listLiveRacesForEvent(eventSlug: string): Promise<RaceSnapshotDoc[]> {
  const snap = await snapshots()
    .where('eventSlug', '==', eventSlug)
    .where('status', '==', 'live')
    .limit(50)
    .get()
  return snap.docs
    .map(d => d.data() as RaceSnapshotDoc)
    .filter(d => d.schemaVersion === RACE_SNAPSHOT_SCHEMA_VERSION)
}

/** Events that have at least one live race — the landing page's list. */
export async function listRecentResultEvents(limit = 24): Promise<PublicRaceSummary[]> {
  const snap = await snapshots()
    .where('status', '==', 'live')
    .orderBy('publishedAt', 'desc')
    .limit(limit)
    .get()
  return snap.docs.map(d => toPublicRace(d.data() as RaceSnapshotDoc))
}

export interface LeaderboardPage {
  rows:       PublicResultRow[]
  nextCursor: number | null   // last overallRank returned
}

/**
 * One page of the leaderboard, ordered by overall rank.
 *
 * Cursor-paginated on `overallRank`, never offset — so page N costs the same as page 1 and
 * nothing scans the whole collection. Non-finishers have a null rank and are excluded here;
 * they are reachable by direct bib lookup.
 */
export async function fetchLeaderboardPage(
  id: string, version: number, pageSize: number, afterRank?: number | null,
): Promise<LeaderboardPage> {
  let q = entriesCol(id)
    .where('v', '==', version)
    .orderBy('overallRank', 'asc')
    .limit(pageSize)

  if (typeof afterRank === 'number') q = q.startAfter(afterRank)

  const snap = await q.get()
  const rows = snap.docs
    .map(d => d.data() as SnapshotEntryDoc)
    .filter(e => e.overallRank !== null)
    .map(toPublicRow)

  const last = rows.length > 0 ? rows[rows.length - 1].overallRank : null
  return { rows, nextCursor: snap.size === pageSize ? last : null }
}

/** Bib lookup — a single document GET. O(1), no query, no scan. */
export async function fetchByBib(
  id: string, version: number, bib: string,
): Promise<PublicResultRow | null> {
  // RD-RESULTS-FIX-01 · versioned id first.
  const versioned = await entriesCol(id).doc(entryKey(version, bib)).get()
  if (versioned.exists) {
    const entry = versioned.data() as SnapshotEntryDoc
    return entry.v === version ? toPublicRow(entry) : null
  }

  // ═══ Compatibility read for races published BEFORE this sprint ═════════════
  // Their entries were written under the bare bib id. The leaderboard and name search
  // reach them unchanged (both filter on the stamped `v`), and only this O(1) GET needs
  // to know the id changed shape. Deliberately a fallback rather than a migration: those
  // documents are correct and live, and rewriting a published race's entries to change an
  // id would be a mass write against the one collection the public reads.
  const legacy = await entriesCol(id).doc(bibKey(bib)).get()
  if (!legacy.exists) return null
  const entry = legacy.data() as SnapshotEntryDoc
  // A row from a superseded version must not surface.
  if (entry.v !== version) return null
  return toPublicRow(entry)
}

/**
 * Name PREFIX search — an indexed range query.
 *
 * Firestore cannot do substring matching, so this finds names that START WITH the query.
 * The UI states that plainly rather than implying full-text search.
 */
export async function searchByNamePrefix(
  id: string, version: number, query: string, limit = 20,
): Promise<PublicResultRow[]> {
  const q = nameKey(query)
  if (q === '') return []

  const snap = await entriesCol(id)
    .where('v', '==', version)
    .orderBy('nameLower', 'asc')
    .startAt(q)
    .endAt(q + PREFIX_UPPER_BOUND)
    .limit(limit)
    .get()

  return snap.docs.map(d => toPublicRow(d.data() as SnapshotEntryDoc))
}
