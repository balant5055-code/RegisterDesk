// RD-DASHBOARD-02 · Organizer daily rollups — the Admin-SDK half. SERVER ONLY.
//
// The pure rules live in lib/dashboard/dailyStats.ts. This file only knows how to
// write them transactionally and read them back.

import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  DAILY_STATS_COLLECTION, ALL_EVENTS, dailyStatsDocId, dayKey, buildSeries,
  deltaFor, isNoOpDelta,
  type DailyStatsPoint, type LifecycleInput,
} from '@/lib/dashboard/dailyStats'

/**
 * Coverage marker, one per organizer: `organizerDailyStats/{uid}_meta`.
 *
 * Shares the collection deliberately. A separate collection would need its own rule
 * and its own read; the `_meta` suffix cannot collide with a day id because a day is
 * always `YYYY-MM-DD`.
 */
export function coverageDocId(organizerUid: string): string {
  return `${organizerUid}__meta`
}

export interface CoverageDoc {
  organizerUid: string
  /** Earliest day the rollups can be trusted for. */
  since:        string | null
  /** Set by the backfill when it completes for this organizer. */
  backfilledAt: unknown | null
}

/**
 * Stages the rollup increment for a registration lifecycle change INSIDE an existing
 * transaction.
 *
 * ═══ WHY IT TAKES THE CALLER'S TRANSACTION ═══════════════════════════════════
 * It writes in the SAME transaction that updates `registrationCounters`. That is the
 * whole consistency story: the rollup cannot drift from the counting SSOT, because
 * either both writes land or neither does. A separate write — even a reliable one —
 * would introduce a window where the trend and the totals disagree, and no amount of
 * retry logic closes that window.
 *
 * `txn.set(..., {merge:true})` with `FieldValue.increment` is safe under contention:
 * Firestore applies increments atomically, and the transaction already serialises the
 * counter update, so two concurrent registrations for the same organizer on the same
 * day cannot lose an increment.
 *
 * NOTE — this stages a WRITE only. Firestore requires all reads before writes inside
 * a transaction, and this performs none, so it is safe to call at any point.
 */
export function stageDailyStatsIncrement(
  txn: Transaction,
  organizerUid: string,
  /**
   * The event this change belongs to (the eventDraft id). Null writes only the
   * workspace row — better than attributing the change to the wrong event.
   */
  eventId: string | null,
  /** The day this change is ATTRIBUTED to — see the attribution rule in dailyStats.ts. */
  attributedTo: Date | number,
  input: LifecycleInput,
): void {
  if (!organizerUid) return
  const delta = deltaFor(input)
  if (isNoOpDelta(delta)) return

  const day = dayKey(attributedTo)

  // BOTH scopes, in the SAME transaction. The workspace row is not derived from the
  // event rows at read time — that would need a query over an unknown set of events —
  // so it is maintained alongside them and the two can never disagree.
  const scopes = eventId ? [ALL_EVENTS, eventId] : [ALL_EVENTS]
  for (const scope of scopes) {
    const ref = adminDb.collection(DAILY_STATS_COLLECTION).doc(dailyStatsDocId(organizerUid, scope, day))
    txn.set(ref, {
      organizerUid,
      eventId:      scope,
      day,
      confirmed:    FieldValue.increment(delta.confirmed),
      cancelled:    FieldValue.increment(delta.cancelled),
      revenuePaise: FieldValue.increment(delta.revenuePaise),
      checkedIn:    FieldValue.increment(delta.checkedIn),
      updatedAt:    FieldValue.serverTimestamp(),
    }, { merge: true })
  }

  // DELIBERATELY does not touch the coverage marker.
  //
  // `since` is a FLOOR — the earliest day the rollups can be trusted for — so it may
  // only ever move backwards. Writing it here would need a read to compare against
  // the existing value, and Firestore forbids a read after a write inside a
  // transaction. A blind `set` would be worse than useless: a registration created
  // today would stamp `since = today` and erase a backfill that had already proved
  // coverage back to last year, making the UI disclose a gap that does not exist.
  //
  // Coverage is therefore owned by exactly two writers: the backfill script, and the
  // ROLLUP_EPOCH fallback below. Both are monotonic by construction.
}

/**
 * Non-transactional variant for paths that are not already inside a transaction.
 *
 * Used by the backfill only. Live registration paths MUST use the transactional
 * version — see the consistency note above.
 */
export async function applyDailyStatsIncrement(
  organizerUid: string,
  eventId: string,
  attributedTo: Date | number,
  input: LifecycleInput,
): Promise<void> {
  const delta = deltaFor(input)
  if (!organizerUid || isNoOpDelta(delta)) return
  const day = dayKey(attributedTo)
  await adminDb.collection(DAILY_STATS_COLLECTION).doc(dailyStatsDocId(organizerUid, eventId, day)).set({
    organizerUid, eventId, day,
    confirmed:    FieldValue.increment(delta.confirmed),
    cancelled:    FieldValue.increment(delta.cancelled),
    revenuePaise: FieldValue.increment(delta.revenuePaise),
    checkedIn:    FieldValue.increment(delta.checkedIn),
    updatedAt:    FieldValue.serverTimestamp(),
  }, { merge: true })
}

/**
 * Lowers the coverage floor for an organizer, never raises it.
 *
 * Read-then-write rather than a blind set: `since` is a floor, and a live registration
 * writing today must not overwrite a backfill that already proved coverage back to
 * last year.
 */
export async function lowerCoverageFloor(organizerUid: string, day: string): Promise<void> {
  const ref = adminDb.collection(DAILY_STATS_COLLECTION).doc(coverageDocId(organizerUid))
  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    const current = snap.exists ? (snap.data() as CoverageDoc).since : null
    if (current && current <= day) return
    txn.set(ref, { organizerUid, since: day }, { merge: true })
  })
}

export async function markBackfilled(organizerUid: string, since: string): Promise<void> {
  await adminDb.collection(DAILY_STATS_COLLECTION).doc(coverageDocId(organizerUid)).set({
    organizerUid, since, backfilledAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

/**
 * The day the rollup write path went live.
 *
 * Until an organizer has been backfilled, this is the honest floor: rollups exist
 * from here forward and NOT before, so a 90-day chart on a workspace deployed last
 * week must say so rather than draw 83 zero days.
 *
 * Set to the deploy date of RD-DASHBOARD-02. It is a constant rather than a lookup
 * because "when did we start counting?" is a property of the code, not of the data.
 */
export const ROLLUP_EPOCH = '2026-08-23'

/**
 * Earliest day this organizer's rollups can be trusted.
 *
 * Backfilled organizers get their real earliest day from the meta document. Everyone
 * else falls back to ROLLUP_EPOCH. A failed read returns the epoch too — the
 * conservative direction, since it makes the UI disclose MORE uncertainty rather than
 * claim history it cannot prove.
 */
export async function readCoverage(organizerUid: string): Promise<string> {
  try {
    const snap = await adminDb.collection(DAILY_STATS_COLLECTION).doc(coverageDocId(organizerUid)).get()
    if (!snap.exists) return ROLLUP_EPOCH
    const since = (snap.data() as CoverageDoc).since
    return typeof since === 'string' && since ? since : ROLLUP_EPOCH
  } catch { return ROLLUP_EPOCH }
}

/**
 * Reads a day range for one organizer.
 *
 * ONE `getAll` of deterministic ids: no query, no index, no cursor, and the read
 * count is exactly the number of days requested (90 for the widest range) regardless
 * of how many registrations those days contain. That bound is the entire point of the
 * collection.
 *
 * Throws on failure rather than returning zeros — the caller must be able to tell
 * "no activity" from "could not read", and a silent empty series makes that
 * impossible.
 */
export async function readDailyStats(
  organizerUid: string,
  /** ALL_EVENTS for the workspace series, or an event draft id for one event. */
  eventId: string,
  days: string[],
): Promise<DailyStatsPoint[]> {
  if (days.length === 0) return []
  const refs = days.map(d => adminDb.collection(DAILY_STATS_COLLECTION).doc(dailyStatsDocId(organizerUid, eventId, d)))
  const snaps = await adminDb.getAll(...refs)

  const byDay = new Map<string, DailyStatsPoint>()
  snaps.forEach(snap => {
    if (!snap.exists) return
    const d = snap.data() as Record<string, unknown>
    const day = typeof d.day === 'string' ? d.day : null
    if (!day) return
    byDay.set(day, {
      date:         day,
      confirmed:    num(d.confirmed),
      cancelled:    num(d.cancelled),
      revenuePaise: num(d.revenuePaise),
      checkedIn:    num(d.checkedIn),
    })
  })

  return buildSeries(days, byDay)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Convert a Firestore Timestamp / Date / millis to a Date, or null. */
export function toDate(v: unknown): Date | null {
  if (!v) return null
  if (v instanceof Date) return v
  if (v instanceof Timestamp) return v.toDate()
  if (typeof v === 'number') return new Date(v)
  if (typeof (v as { toDate?: () => Date }).toDate === 'function') {
    try { return (v as { toDate: () => Date }).toDate() } catch { return null }
  }
  return null
}
