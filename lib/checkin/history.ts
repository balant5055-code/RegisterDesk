// RD-CHECKIN-2.0 — the append-only check-in history.
//
// ═══ THE TWO DEFECTS THIS CLOSES ═════════════════════════════════════════════
//
// 1. THE SCAN PATH WROTE NOTHING. `writeAuditEntry` was called on walk-in and on
//    undo, but NOT on the QR / manual / lookup check-in itself — the single most
//    common operation at an event had no record beyond three fields on the
//    registration. "Who admitted this person, and when" was answerable only while
//    those fields survived.
//
// 2. UNDO ERASED THEM. `uncheckInRegistration` deleted `checkedInAt`,
//    `checkedInBy` and `checkedInSource`. Combined with (1), an undo removed the
//    only evidence a check-in had ever happened. A disputed admission was
//    unreconstructable — not merely inconvenient to reconstruct.
//
// ═══ CURRENT STATE vs HISTORY ════════════════════════════════════════════════
// The registration keeps CURRENT STATE — `checkedIn` and, while it is true, the
// three fields describing that admission. That is what every existing reader,
// counter and export consumes, and it is deliberately unchanged: a `checkedInAt`
// left behind on a not-checked-in registration would make those readers lie.
//
// HISTORY lives here, in an append-only subcollection. Nothing in this module
// updates or deletes an entry, and no caller is given a way to. An undo APPENDS a
// compensating `CHECK_IN_UNDO` rather than removing the `CHECK_IN`, so a
// check-in → undo → check-in sequence reads back as three entries in order.
//
// ═══ WHY A SUBCOLLECTION ═════════════════════════════════════════════════════
// `registrations/{id}/checkinHistory` is scoped to the participant it describes, is
// read with the registration and needs no composite index to order. Deleting a
// registration takes its history with it, which matches how every other
// registration-scoped record in this codebase behaves.
//
// The event-wide "recent check-ins" view is NOT built from this — it reads the
// registrations themselves through an index that already exists. Building it from a
// collection-group query here would have required a new index for a view that has a
// perfectly good one already.
//
// ═══ NEVER RECORDED ══════════════════════════════════════════════════════════
// No password, no token, no credential of any kind reaches this module. The
// metadata a caller may attach is narrowed by the interface below rather than being
// an open record, so a future caller cannot widen it by accident.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'

export const CHECKIN_HISTORY_SUBCOLLECTION = 'checkinHistory'

export type CheckinHistoryAction = 'CHECK_IN' | 'CHECK_IN_UNDO'

/**
 * How the admission was performed. Free-form strings were what the old
 * `checkedInSource` accepted; this narrows them to the set the product actually
 * produces so the history is groupable.
 */
export type CheckinMethod = 'qr' | 'manual' | 'lookup' | 'walkin' | 'operations' | 'bulk' | 'unknown'

const METHODS: CheckinMethod[] = ['qr', 'manual', 'lookup', 'walkin', 'operations', 'bulk', 'unknown']

/** Coerces a caller-supplied source string to a known method. Never throws. */
export function toCheckinMethod(raw: unknown): CheckinMethod {
  if (typeof raw !== 'string') return 'unknown'
  const v = raw.trim().toLowerCase()
  return (METHODS as string[]).includes(v) ? v as CheckinMethod : 'unknown'
}

export interface CheckinHistoryEntry {
  id:             string
  action:         CheckinHistoryAction
  registrationId: string
  eventSlug:      string
  organizerUid:   string
  /** The human who performed it — the operator's uid, never the workspace's. */
  operatorUid:    string
  /** The workspace the action belongs to. Distinct from the operator on team accounts. */
  workspaceUid:   string
  method:         CheckinMethod
  occurredAt:     unknown
  /** Identifier held or assigned at the moment of the action, when there was one. */
  identifierValue: string | null
  /** Short operator-supplied or system reason, e.g. 'gate correction'. */
  reason:         string | null
}

export interface AppendCheckinHistoryInput {
  registrationId: string
  action:         CheckinHistoryAction
  eventSlug:      string
  organizerUid:   string
  operatorUid:    string
  workspaceUid:   string
  method:         CheckinMethod
  identifierValue?: string | null
  reason?:        string | null
}

/**
 * Appends one immutable entry.
 *
 * `.add()` only — there is no update path and no delete path in this module, which
 * is what makes "append-only" a property of the code rather than a convention.
 *
 * Awaited by its callers rather than fired and forgotten: this is the evidence, and
 * a check-in whose record silently failed to write is exactly the situation the
 * history exists to prevent. Callers still tolerate a failure (the admission has
 * already happened and must not be rolled back for a logging error) — but they log
 * it loudly instead of dropping it.
 */
export async function appendCheckinHistory(input: AppendCheckinHistoryInput): Promise<void> {
  await adminDb
    .collection('registrations')
    .doc(input.registrationId)
    .collection(CHECKIN_HISTORY_SUBCOLLECTION)
    .add({
      action:         input.action,
      registrationId: input.registrationId,
      eventSlug:      input.eventSlug,
      organizerUid:   input.organizerUid,
      operatorUid:    input.operatorUid,
      workspaceUid:   input.workspaceUid,
      method:         input.method,
      identifierValue: input.identifierValue ?? null,
      reason:          input.reason ?? null,
      occurredAt:      FieldValue.serverTimestamp(),
    })
}

/** Append, but never let a logging failure surface as a failed check-in. */
export function appendCheckinHistorySafe(input: AppendCheckinHistoryInput): Promise<void> {
  return appendCheckinHistory(input).catch(err => {
    console.error('[checkin/history] append failed', {
      registrationId: input.registrationId, action: input.action, err,
    })
  })
}

/** Upper bound on a single participant's timeline read. */
export const MAX_HISTORY_ENTRIES = 50

/**
 * One participant's timeline, oldest first.
 *
 * Ordered by `occurredAt` on a subcollection — a single-field order, served by the
 * automatic index, so this needs no composite index. Bounded, because a
 * pathological registration should not be able to make an operator's screen slow.
 */
export async function getCheckinHistory(
  registrationId: string,
  limit = MAX_HISTORY_ENTRIES,
): Promise<CheckinHistoryEntry[]> {
  const snap = await adminDb
    .collection('registrations')
    .doc(registrationId)
    .collection(CHECKIN_HISTORY_SUBCOLLECTION)
    .orderBy('occurredAt', 'asc')
    .limit(limit)
    .get()

  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<CheckinHistoryEntry, 'id'>) }))
}

// ─── Event-wide feed (RD-CHECKIN-04) ─────────────────────────────────────────

/** One page of the event feed. Default is a shift's worth; the cap is the ceiling. */
export const EVENT_HISTORY_PAGE     = 50
export const EVENT_HISTORY_MAX_PAGE = 200

export interface EventHistoryPage {
  entries: CheckinHistoryEntry[]
  /** ISO timestamp to pass back as `before` for the next (older) page, or null. */
  nextBefore: string | null
}

/**
 * Everything that happened at ONE event's gate, newest first.
 *
 * ═══ WHY THIS IS NOT THE PER-PARTICIPANT READER ══════════════════════════════
 * `getCheckinHistory` reads a single registration's subcollection, which is a
 * single-field order served by the automatic index. An EVENT-wide view spans every
 * participant's subcollection, so it is a COLLECTION GROUP query — a different
 * query, not a second implementation of the same one. Both live here so history
 * reading has exactly one home.
 *
 * ═══ THE INDEX THIS NEEDS ════════════════════════════════════════════════════
 *     checkinHistory (COLLECTION_GROUP): eventSlug ASC, occurredAt DESC
 * Declared in firestore.indexes.json and NOT deployed. Until it is, this throws
 * FAILED_PRECONDITION, which the route reports honestly rather than rendering as
 * "nothing happened" — the one answer this surface must never give by accident.
 *
 * ═══ PAGING ══════════════════════════════════════════════════════════════════
 * `before` is a timestamp cursor: the caller passes the oldest `occurredAt` it has
 * and receives the page before it. Deliberately not a document cursor — a
 * collection-group document cannot be re-fetched from an id alone across a request
 * boundary. The tradeoff is stated rather than hidden: two entries sharing an
 * identical server timestamp at a page boundary could place one on neither page.
 * `occurredAt` is a server timestamp with sub-millisecond resolution, so this
 * requires two writes in the same instant; the per-participant timeline is
 * complete regardless and is the authoritative view for a disputed admission.
 */
export async function getEventCheckinHistory(
  eventSlug: string,
  opts: { limit?: number; before?: Date | null } = {},
): Promise<EventHistoryPage> {
  const limit = Math.min(Math.max(opts.limit ?? EVENT_HISTORY_PAGE, 1), EVENT_HISTORY_MAX_PAGE)

  let q = adminDb
    .collectionGroup(CHECKIN_HISTORY_SUBCOLLECTION)
    .where('eventSlug', '==', eventSlug)
    .orderBy('occurredAt', 'desc')

  if (opts.before) q = q.startAfter(opts.before)

  // One extra row decides whether an older page exists, without a second query.
  const snap = await q.limit(limit + 1).get()
  const docs = snap.docs.slice(0, limit)

  const entries = docs.map(d => ({ id: d.id, ...(d.data() as Omit<CheckinHistoryEntry, 'id'>) }))
  const last    = entries[entries.length - 1]
  const lastAt  = (last?.occurredAt as { toDate?: () => Date } | undefined)?.toDate?.() ?? null

  return {
    entries,
    nextBefore: snap.docs.length > limit && lastAt ? lastAt.toISOString() : null,
  }
}
