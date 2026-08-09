// RD-RACEOPS-01 Sprint 3 · Import Session persistence — SERVER ONLY.
//
// The ONLY module that writes raceImportSessions. Every mutation is either a single-doc
// create, a bounded field update, or a transaction — never a blind overwrite of the doc.
//
// Schema: docs/RD-RACEOPS-FIRESTORE.md

import crypto from 'crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  RACE_IMPORT_SESSIONS, RACE_SESSION_SCHEMA_VERSION,
  type ImportSessionDoc, type ImportSessionStatus, type ImportSessionView, type RankCursor,
  type RegistrationCheckCounts,
} from '@/features/race-operations/types/session'
import type { SnapshotVersionRecord } from '@/features/race-operations/types/snapshot'
import type { ColumnMapping } from '@/features/race-operations/types/results'
import { decideTransition, type SessionAction } from '@/features/race-operations/lifecycle/transitions'

const col = () => adminDb.collection(RACE_IMPORT_SESSIONS)

/** Random id. Deliberately NOT derived from the file: re-uploading the same file must
 *  create a NEW session, never collide with (or overwrite) the earlier one. */
function newSessionId(): string {
  return `ris_${crypto.randomBytes(12).toString('hex')}`
}

function toIso(v: unknown): string | null {
  if (!v) return null
  if (typeof v === 'object' && v !== null && 'toDate' in v) {
    return (v as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

/** Serialised view — no Firestore Timestamp ever crosses the wire. */
export function serializeSession(s: ImportSessionDoc): ImportSessionView {
  return {
    sessionId:    s.sessionId,
    eventId:      s.eventId,
    passId:       s.passId,
    passName:     s.passName,
    fileName:     s.fileName,
    fileHash:     s.fileHash,
    provider:     s.provider,
    status:       s.status,
    totalRows:    s.totalRows,
    validRows:    s.validRows,
    warningCount: s.warningCount,
    errorCount:   s.errorCount,
    storedRows:   s.storedRows,
    rankedRows:   s.rankedRows,
    uploadedBy:   s.uploadedBy,
    uploadedAt:   toIso(s.uploadedAt),
    rankedAt:     toIso(s.rankedAt),
    publishedAt:  toIso(s.publishedAt),
    publishedBy:  s.publishedBy,
    cancelledAt:  toIso(s.cancelledAt),
    cancelReason: s.cancelReason,
  }
}

// ─── Create ───────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  eventId:      string
  eventSlug:    string
  organizerUid: string
  passId:       string
  passName:     string
  uploadedBy:   string
  fileName:     string
  fileHash:     string
  provider:     string
  mapping:      ColumnMapping
  totalRows:    number
  validRows:    number
  warningCount: number
  errorCount:   number
}

export async function createSession(input: CreateSessionInput): Promise<ImportSessionDoc> {
  const sessionId = newSessionId()
  const ref = col().doc(sessionId)

  // `create` (not `set`) so a session can never overwrite an existing document — the
  // immutability requirement enforced at the storage layer, not just by convention.
  await ref.create({
    ...input,
    sessionId,
    schemaVersion: RACE_SESSION_SCHEMA_VERSION,
    uploadedAt:    FieldValue.serverTimestamp(),
    storedRows:    0,
    status:        'draft' satisfies ImportSessionStatus,
    rankedRows:    0,
    rankCursor:    null,
    rankedAt:      null,
    publishedAt:   null,
    publishedBy:   null,
    cancelledAt:   null,
    cancelledBy:   null,
    cancelReason:  null,
  })

  return (await ref.get()).data() as ImportSessionDoc
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Loads a session and enforces tenant isolation in the same call, so no caller can forget
 * to. A session belonging to another workspace is reported as absent, never as forbidden —
 * that leaks nothing about what exists.
 */
export async function getOwnedSession(
  sessionId:    string,
  organizerUid: string,
): Promise<ImportSessionDoc | null> {
  const snap = await col().doc(sessionId).get()
  if (!snap.exists) return null
  const doc = snap.data() as ImportSessionDoc
  if (doc.organizerUid !== organizerUid) return null
  if (doc.schemaVersion !== RACE_SESSION_SCHEMA_VERSION) return null
  return doc
}

export async function listSessionsForEvent(
  organizerUid: string,
  eventId:      string,
  limit         = 25,
): Promise<ImportSessionDoc[]> {
  const snap = await col()
    .where('organizerUid', '==', organizerUid)
    .where('eventId', '==', eventId)
    .orderBy('uploadedAt', 'desc')
    .limit(limit)
    .get()
  return snap.docs.map(d => d.data() as ImportSessionDoc)
}

/** The duplicate-publish guard: is a DIFFERENT session already published for this race? */
export async function findPublishedSessionForRace(
  organizerUid: string,
  eventId:      string,
  passId:       string,
  excludeSessionId?: string,
): Promise<ImportSessionDoc | null> {
  const snap = await col()
    .where('organizerUid', '==', organizerUid)
    .where('eventId', '==', eventId)
    .where('passId', '==', passId)
    .where('status', '==', 'published')
    .limit(2)   // 2 so an excluded self-match still leaves a candidate visible
    .get()

  for (const d of snap.docs) {
    const doc = d.data() as ImportSessionDoc
    if (doc.sessionId !== excludeSessionId) return doc
  }
  return null
}

// ─── Progress updates ─────────────────────────────────────────────────────────

/** Advances `storedRows` by the number of rows a chunk actually wrote. */
export async function bumpStoredRows(sessionId: string, delta: number): Promise<void> {
  if (delta === 0) return
  await col().doc(sessionId).update({ storedRows: FieldValue.increment(delta) })
}

/** Persists the resumable rank cursor mid-walk. */
export async function saveRankProgress(
  sessionId: string,
  cursor:    RankCursor,
): Promise<void> {
  await col().doc(sessionId).update({ rankCursor: cursor, rankedRows: cursor.processed })
}

/** Marks the ranking pass complete. `rankedAt` is the precondition for publishing. */
export async function completeRanking(sessionId: string, rankedRows: number): Promise<void> {
  await col().doc(sessionId).update({
    rankCursor: null,
    rankedRows,
    rankedAt:   FieldValue.serverTimestamp(),
  })
}

/** Clears rank state so a re-rank starts from the beginning (e.g. after more rows land). */
export async function resetRanking(sessionId: string): Promise<void> {
  await col().doc(sessionId).update({ rankCursor: null, rankedRows: 0, rankedAt: null })
}

// ─── Lifecycle transition (transactional) ─────────────────────────────────────

export type TransitionOutcome =
  | { ok: true;  session: ImportSessionDoc }
  | { ok: false; status: number; error: string }

/**
 * Applies `publish` or `cancel` inside a transaction.
 *
 * The status is RE-READ inside the transaction and re-checked through the same pure
 * `decideTransition` guard the route already ran, so two concurrent publishes cannot both
 * win — the loser sees 409. The pre-flight check in the route exists only to fail fast
 * with a good message; this is the authority.
 */
export async function transitionSession(params: {
  sessionId:    string
  organizerUid: string
  actorUid:     string
  action:       SessionAction
  /** Resolved OUTSIDE the transaction — Firestore transactions cannot run queries. */
  racePublishedElsewhere: boolean
  reason?:      string
  /**
   * Sprint 4: on publish, the race's Official Snapshot flips `building` → `live` in the
   * SAME transaction. There is therefore no instant at which the session reads published
   * while the snapshot is still building (or vice versa), so a public page can never
   * observe a half-live race.
   */
  goLiveSnapshot?: {
    ref:     FirebaseFirestore.DocumentReference
    version: number
  }
}): Promise<TransitionOutcome> {
  const { sessionId, organizerUid, actorUid, action, racePublishedElsewhere, reason, goLiveSnapshot } = params
  const ref = col().doc(sessionId)

  return adminDb.runTransaction<TransitionOutcome>(async tx => {
    // Firestore requires every read before any write in a transaction.
    const snapshotSnap = goLiveSnapshot ? await tx.get(goLiveSnapshot.ref) : null

    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false, status: 404, error: 'Import session not found' }

    const doc = snap.data() as ImportSessionDoc
    if (doc.organizerUid !== organizerUid) {
      return { ok: false, status: 404, error: 'Import session not found' }
    }

    const decision = decideTransition(action, {
      status:     doc.status,
      storedRows: doc.storedRows,
      ranked:     doc.rankedAt !== null,
      racePublishedElsewhere,
      // RD-RESULTS-FIX-01 · read INSIDE the transaction, like every other precondition, so
      // a check cleared by a concurrent row change cannot be raced past.
      registrationCheck: doc.registrationCheck
        ? {
            unknownRunner: doc.registrationCheck.unknownRunner,
            wrongRace:     doc.registrationCheck.wrongRace,
          }
        : null,
    })
    if (!decision.allowed) {
      return { ok: false, status: decision.status, error: decision.reason }
    }

    const patch: Record<string, unknown> = { status: decision.next }
    if (action === 'publish') {
      patch.publishedAt = FieldValue.serverTimestamp()
      patch.publishedBy = actorUid

      // Snapshot go-live, same transaction. Refuse rather than publish a session whose
      // snapshot was never built — that would leave the public page empty for a race the
      // organizer believes is live.
      if (goLiveSnapshot) {
        if (!snapshotSnap?.exists) {
          return { ok: false, status: 422, error: 'The public snapshot has not been built yet.' }
        }
        // RD-RESULTS-FIX-01 · the build now accumulates in the PENDING lane, so the
        // version being published is `pendingVersion`, not `version` (which still names
        // the live one during a republish).
        const snapDoc = snapshotSnap.data() as {
          version?: number; status?: string
          pendingVersion?: number | null
          pendingTotalCount?: number; pendingFinisherCount?: number
          versions?: SnapshotVersionRecord[]
        }
        if (snapDoc.pendingVersion !== goLiveSnapshot.version) {
          return {
            ok: false, status: 409,
            error: 'The public snapshot changed while publishing. Rebuild it and try again.',
          }
        }

        const publishedAtIso = new Date().toISOString()
        const record: SnapshotVersionRecord = {
          version:       goLiveSnapshot.version,
          sessionId,
          publishedBy:   actorUid,
          publishedAt:   publishedAtIso,
          totalCount:    snapDoc.pendingTotalCount ?? 0,
          finisherCount: snapDoc.pendingFinisherCount ?? 0,
        }

        // ═══ PROMOTION ═══════════════════════════════════════════════════════
        // The pending lane becomes the live one, the counts move WITH the version they
        // describe, and the lane is cleared so a later `nextSnapshotVersion` does not
        // mistake a finished build for one still in flight. Appending to `versions` here —
        // in the same transaction as the session flip — is what makes history and rollback
        // a record of what actually happened rather than a reconstruction.
        tx.update(goLiveSnapshot.ref, {
          status:        'live',
          version:       goLiveSnapshot.version,
          totalCount:    record.totalCount,
          finisherCount: record.finisherCount,
          publishedAt:   FieldValue.serverTimestamp(),
          publishedBy:   actorUid,
          sessionId,
          versions:      [...(snapDoc.versions ?? []), record],
          pendingVersion:       null,
          pendingSessionId:     null,
          pendingTotalCount:    0,
          pendingFinisherCount: 0,
          // RD-RESULTS-CLOSURE-02 · the build's cursor is part of the lane, so it is
          // cleared with it. Leaving it behind would let the next build resume from a
          // finished one's position and copy nothing.
          pendingCursor:        null,
        })
      }
    } else {
      patch.cancelledAt  = FieldValue.serverTimestamp()
      patch.cancelledBy  = actorUid
      patch.cancelReason = reason ?? null
    }

    tx.update(ref, patch)
    return { ok: true, session: { ...doc, ...patch } as ImportSessionDoc }
  })
}

/**
 * RD-RESULTS-FIX-01 · Records the start-list cross-check on the session.
 *
 * Written by `verifySessionRegistrations` and read by the publish guard. Stored on the
 * session rather than in a new collection because it is a property of THIS import, dies
 * with it, and the publish transaction already reads this document.
 */
export async function saveRegistrationCheck(
  sessionId: string,
  counts: Omit<RegistrationCheckCounts, 'checkedAt'>,
): Promise<void> {
  await col().doc(sessionId).update({
    registrationCheck: { ...counts, checkedAt: FieldValue.serverTimestamp() },
  })
}

/**
 * Clears the check so a changed import must be re-verified before it can publish.
 *
 * Called wherever rows change. A stale pass is worse than none: it would report a file that
 * no longer exists as verified, and publish would trust it.
 */
export async function clearRegistrationCheck(sessionId: string): Promise<void> {
  await col().doc(sessionId).update({ registrationCheck: null })
}
