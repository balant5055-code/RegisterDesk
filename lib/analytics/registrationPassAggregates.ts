// RD-DASHBOARD-03 · per-pass and waitlisted registration counts. Server-only, READ-ONLY.
//
// ═══ WHY count() AND NOT A SCAN ══════════════════════════════════════════════
// Every query here is a count() aggregate: Firestore answers from the index and transfers
// ZERO documents, so an event with 50,000 cancellations costs the same as one with 3. The
// alternative — reading cancelled registrations and grouping `passId` in memory — is correct
// but scales with cancellations, which is exactly the "thousands of documents" this avoids.
//
// ═══ WHY NOT A COUNTER FIELD ═════════════════════════════════════════════════
// `registrationCounters.passCounts` tracks CONFIRMED only, and no per-pass cancelled field
// exists. Adding one would be O(1) to read but would report zero for every cancellation that
// already happened until a backfill ran — wrong data presented confidently. Aggregating is
// correct for historical rows on the first render, with no migration.
//
// ═══ THE COST IS BOUNDED BY THE CALLER ═══════════════════════════════════════
// Cancelled-by-pass costs one aggregate per (event, pass), so it grows as events × passes.
// The caller passes a budget and this module stops when it is spent, reporting `complete:
// false` rather than returning a partial map that would read as "these passes had no
// cancellations". A partial truth presented as a whole truth is the failure mode here.

import { adminDb } from '@/lib/firebase/admin'

/** Bounded parallelism — enough to hide latency, not enough to burst the connection pool. */
const CONCURRENCY = 8

export interface CancelledByPassResult {
  /** passId → cancelled count. Only populated when `complete` is true. */
  counts:   Record<string, number>
  /** False ⇒ the budget ran out or a read failed; the caller must NOT treat this as zeros. */
  complete: boolean
}

/**
 * Cancelled registrations for one event, split by pass.
 *
 * Requires the composite index (organizerUid, eventSlug, status, passId) — four equality
 * filters. `passIds` comes from the event's configured passes, so a pass that was deleted
 * after someone cancelled is not queried; that residue surfaces as Unattributed upstream,
 * which is the honest outcome rather than a silently missing count.
 */
export async function aggregateCancelledByPass(
  organizerUid: string,
  eventSlug:    string,
  passIds:      string[],
  budget:       { remaining: number },
): Promise<CancelledByPassResult> {
  if (passIds.length === 0) return { counts: {}, complete: true }
  if (passIds.length > budget.remaining) return { counts: {}, complete: false }
  budget.remaining -= passIds.length

  const base = adminDb.collection('registrations')
    .where('organizerUid', '==', organizerUid)
    .where('eventSlug',    '==', eventSlug)
    .where('status',       '==', 'cancelled')

  const counts: Record<string, number> = {}
  let complete = true

  for (let i = 0; i < passIds.length; i += CONCURRENCY) {
    const chunk = passIds.slice(i, i + CONCURRENCY)
    const rows  = await Promise.all(chunk.map(pid =>
      base.where('passId', '==', pid).count().get()
        .then(s => ({ pid, n: s.data().count }))
        // One unreadable pass invalidates the WHOLE event's split: a map missing one pass
        // would under-report the total and quietly break reconciliation.
        .catch(() => { complete = false; return null })))
    for (const r of rows) if (r && r.n > 0) counts[r.pid] = r.n
  }

  return complete ? { counts, complete: true } : { counts: {}, complete: false }
}

/**
 * Waitlisted registrations for one event.
 *
 * `registrationCounters` has pendingCount / cancelledCount / rejectedCount but NO
 * waitlistedCount, so the counter path reported waitlisted as 0 for every event whose stats
 * were current — a confident zero that could never be non-zero. One aggregate on the existing
 * (organizerUid, eventSlug, status) index fills the gap with no schema change.
 *
 * Returns null on failure so the caller can flag it instead of reporting zero.
 */
export async function aggregateWaitlistedCount(
  organizerUid: string,
  eventSlug:    string,
): Promise<number | null> {
  return adminDb.collection('registrations')
    .where('organizerUid', '==', organizerUid)
    .where('eventSlug',    '==', eventSlug)
    .where('status',       '==', 'waitlisted')
    .count().get()
    .then(s => s.data().count)
    .catch(() => null)
}
