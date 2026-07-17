// Server-only: Firebase Admin SDK.

import { FieldValue }  from 'firebase-admin/firestore'
import type { Transaction, DocumentReference } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { EVENT_STATS_VERSION, type RegistrationCounter } from '@/lib/registrations/types'

const col = () => adminDb.collection('registrationCounters')

// ─── Distributed ATTENDANCE (check-in) counter (GA-5 S3) ──────────────────────
//
// ONLY the check-in / attendance fields (checkedInCount, passCheckedInCounts) are
// sharded — they are the genuine mass-burst write path (gate scanning) and, unlike
// totalCount/passCounts, are NEVER read inside a transaction to gate capacity, so
// distributing their writes cannot cause overselling. totalCount/passCounts/revenue
// stay on the single base doc BY DESIGN: the registration transaction reads them to
// enforce capacity, and that single serialization point is what prevents overselling.
//
// Model (backward-compatible, migration-free): the base doc keeps holding any legacy
// check-in counts; NEW gate check-ins increment one of N deterministic shard docs
// under `registrationCounters/{slug}/attendanceShards/{k}`, plus a `recon` shard for
// reconciliation corrections. Every read SUMS base + shards, so old events (no shards)
// and new events (base=0, shards accumulate) both read correctly with no migration.

export const ATTENDANCE_COUNTER_SHARDS = 10

const attendanceShardsCol = (eventSlug: string) =>
  col().doc(eventSlug).collection('attendanceShards')

// Deterministic, well-distributed shard index from the registration id — so a
// check-in and its later undo target the SAME shard (per-shard stays non-negative).
function attendanceShardIndex(registrationId: string): number {
  let h = 0
  for (let i = 0; i < registrationId.length; i++) h = (h * 31 + registrationId.charCodeAt(i)) | 0
  return Math.abs(h) % ATTENDANCE_COUNTER_SHARDS
}

/** The deterministic attendance shard doc for a registration's check-in delta. */
export function attendanceShardRef(eventSlug: string, registrationId: string): DocumentReference {
  return attendanceShardsCol(eventSlug).doc(String(attendanceShardIndex(registrationId)))
}

/** A dedicated shard for RECONCILIATION corrections (kept out of the hot numeric
 *  shard range). Summed by getAttendanceShardSums like any other shard. */
export function attendanceReconShardRef(eventSlug: string): DocumentReference {
  return attendanceShardsCol(eventSlug).doc('recon')
}

interface AttendanceShardData { checkedInCount?: number; passCheckedInCounts?: Record<string, number> }

/** Sums the check-in fields across all attendance shards for an event. */
export async function getAttendanceShardSums(
  eventSlug: string,
): Promise<{ checkedInCount: number; passCheckedInCounts: Record<string, number> }> {
  const snap = await attendanceShardsCol(eventSlug).get()
  let checkedInCount = 0
  const passCheckedInCounts: Record<string, number> = {}
  for (const s of snap.docs) {
    const d = s.data() as AttendanceShardData
    checkedInCount += d.checkedInCount ?? 0
    for (const [pid, n] of Object.entries(d.passCheckedInCounts ?? {})) {
      passCheckedInCounts[pid] = (passCheckedInCounts[pid] ?? 0) + (n ?? 0)
    }
  }
  return { checkedInCount, passCheckedInCounts }
}

/** Folds attendance shard sums into a base counter object (pure). */
export function foldAttendanceShards(
  base: RegistrationCounter,
  shards: { checkedInCount: number; passCheckedInCounts: Record<string, number> },
): RegistrationCounter {
  if (shards.checkedInCount === 0 && Object.keys(shards.passCheckedInCounts).length === 0) return base
  const passCI: Record<string, number> = { ...(base.passCheckedInCounts ?? {}) }
  for (const [pid, n] of Object.entries(shards.passCheckedInCounts)) passCI[pid] = (passCI[pid] ?? 0) + n
  return { ...base, checkedInCount: (base.checkedInCount ?? 0) + shards.checkedInCount, passCheckedInCounts: passCI }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Returns the live registration counter for an event — with the distributed
 * attendance shards folded in, so `checkedInCount` / `passCheckedInCounts` reflect
 * every gate check-in. Returns null (not 0) when the event has no counter at all
 * (callers treat null as all-zero). Backward-compatible: an event with no shards
 * reads exactly as before.
 */
export async function getRegistrationCounter(
  eventSlug: string,
): Promise<RegistrationCounter | null> {
  const baseRef = col().doc(eventSlug)
  const [snap, shards] = await Promise.all([baseRef.get(), getAttendanceShardSums(eventSlug)])
  if (!snap.exists) {
    // No base doc: only surface a value if shards somehow exist (defensive).
    if (shards.checkedInCount === 0 && Object.keys(shards.passCheckedInCounts).length === 0) return null
    return foldAttendanceShards({ eventSlug } as RegistrationCounter, shards)
  }
  return foldAttendanceShards(snap.data() as RegistrationCounter, shards)
}

/**
 * EA-2 S1 — read the per-event statistics doc together with a `complete` flag
 * indicating whether its denormalized aggregates (revenuePaise, status counts)
 * are trustworthy (i.e. the doc has been backfilled to the current stats
 * version). When `complete` is false, callers MUST fall back to a
 * source-of-truth computation rather than trusting the aggregate fields; the
 * always-maintained fields (totalCount, passCounts, checkedInCount) remain
 * reliable regardless.
 */
export async function getEventStats(
  eventSlug: string,
): Promise<{ counter: RegistrationCounter | null; complete: boolean }> {
  const counter = await getRegistrationCounter(eventSlug)
  const complete = !!counter && (counter.statsVersion ?? 0) >= EVENT_STATS_VERSION
  return { counter, complete }
}

// ─── Writes (used inside registration transaction) ────────────────────────────

/**
 * Returns a plain object suitable for use inside a Firestore transaction or
 * batch write to atomically confirm a registration: increments the total count,
 * the pass-specific count and (EA-2 S1) the denormalized confirmed revenue.
 *
 * NOTE: this deliberately does NOT stamp `statsVersion`. Only publish-time init
 * and reconciliation (which recompute from full history) may mark a doc
 * complete — an increment on a not-yet-backfilled legacy doc must never flip it
 * to "complete", or its partial revenue would be wrongly trusted.
 *
 * Usage inside a transaction:
 *   txn.set(counterRef, buildCounterIncrement(eventSlug, passId, { amountPaise }), { merge: true })
 */
export function buildCounterIncrement(
  eventSlug: string,
  passId:    string,
  opts?:     { amountPaise?: number; checkedIn?: boolean },
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    eventSlug,
    totalCount:                FieldValue.increment(1),
    [`passCounts.${passId}`]:  FieldValue.increment(1),
    updatedAt:                 FieldValue.serverTimestamp(),
  }
  // Confirmed revenue — refund-stable (a refund keeps status 'confirmed' and
  // does not change `amount`). Only written when there is revenue to add.
  if (opts?.amountPaise && opts.amountPaise > 0) {
    update.revenuePaise = FieldValue.increment(opts.amountPaise)
  }
  // Walk-in / check-in-on-create: count the check-in — event-level and per-pass —
  // in the same atomic write.
  if (opts?.checkedIn) {
    update.checkedInCount = FieldValue.increment(1)
    update[`passCheckedInCounts.${passId}`] = FieldValue.increment(1)
  }
  return update
}

/**
 * EA-2 S2 — the atomic attendance delta shared by every check-in / undo write
 * path (the canonical check-in transaction, the scanner, and both undo routes).
 * Centralising the shape here keeps the event-level and per-pass checked-in
 * counters in lockstep without introducing a new write path. `dir` is +1 for a
 * check-in and -1 for an undo. Callers guard against undo-below-zero via the
 * registration's own `checkedIn` flag (idempotent), exactly as before.
 */
export function buildCheckinDelta(passId: string, dir: 1 | -1): Record<string, unknown> {
  return {
    checkedInCount:                     FieldValue.increment(dir),
    [`passCheckedInCounts.${passId}`]:  FieldValue.increment(dir),
    updatedAt:                          FieldValue.serverTimestamp(),
  }
}

/**
 * GA-5 S3 — applies an attendance (check-in) delta inside the caller's transaction,
 * routed to the registration's DETERMINISTIC shard so mass gate scanning spreads
 * writes across ATTENDANCE_COUNTER_SHARDS docs instead of contending one. Same
 * transaction semantics (blind, exactly-once-per-commit, idempotent) as before; the
 * only change is the write TARGET. Check-in / undo of the same registration hit the
 * same shard. Replaces the previous `txn.set(baseCounterRef, buildCheckinDelta(...))`.
 */
export function writeCheckinDelta(
  txn: Transaction, eventSlug: string, registrationId: string, passId: string, dir: 1 | -1,
): void {
  txn.set(attendanceShardRef(eventSlug, registrationId), buildCheckinDelta(passId, dir), { merge: true })
}

/**
 * Ensures a zero-valued, fully-backfilled counter document exists for an event.
 * Called once during publish — idempotent via set+merge. A brand-new event has
 * no registrations, so its zero statistics are trivially COMPLETE: we stamp
 * `statsVersion` here so every subsequent increment keeps the doc current
 * without reconciliation ever needing to backfill it. Pre-creating the document
 * also avoids a missing-document edge case during the first registration.
 */
export async function ensureCounterExists(eventSlug: string): Promise<void> {
  await col().doc(eventSlug).set(
    {
      eventSlug,
      totalCount:          0,
      passCounts:          {},
      checkedInCount:      0,
      passCheckedInCounts: {},
      revenuePaise:        0,
      pendingCount:        0,
      cancelledCount:      0,
      rejectedCount:       0,
      statsVersion:        EVENT_STATS_VERSION,
      updatedAt:           FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
}

/**
 * Decrement helper — used when a confirmed registration is cancelled.
 * Never decrements below 0 via max(0, current - 1) enforced by the caller.
 */
export function buildCounterDecrement(passId: string): Record<string, unknown> {
  return {
    totalCount:                FieldValue.increment(-1),
    [`passCounts.${passId}`]:  FieldValue.increment(-1),
    updatedAt:                 FieldValue.serverTimestamp(),
  }
}
