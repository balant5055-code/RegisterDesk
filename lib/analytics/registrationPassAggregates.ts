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
import { AggregateField } from 'firebase-admin/firestore'

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

// ─── Per-pass ticket VALUE ────────────────────────────────────────────────────

/**
 * RD-DASH-05 · what each pass sold, and what cancelled out of it.
 *
 * ═══ THIS IS REGISTRATION ANALYTICS, NOT FINANCE ═════════════════════════════
 * Both figures sum `registrations.amount` — the ticket value carried on the registration
 * itself. They are deliberately NOT gateway or platform figures: no Razorpay fee, no tax, no
 * platform fee, no GST, no settlement, and above all no REFUND amount. "Cancelled value" is
 * the ticket value of cancelled registrations for a pass, which answers "what did this pass
 * lose"; a gateway refund answers "what money went back", and the two routinely differ — a
 * cancellation may never have been refunded, and a refund can leave its registration
 * standing. Finance owns that question and has its own ledger for it.
 *
 * ═══ NULL IS NOT ZERO ════════════════════════════════════════════════════════
 * The sum needs a composite index that carries `amount`; until one is deployed the query
 * fails FAILED_PRECONDITION. That returns `complete: false` and an EMPTY map, never zeros —
 * "this pass sold nothing" and "we could not measure what this pass sold" are different
 * statements, and only one of them is true today.
 */
export interface ValueByPassResult {
  /** passId → { confirmed value, cancelled value } in paise. Populated only when complete. */
  values:   Record<string, { salesPaise: number; cancelledPaise: number }>
  /** False ⇒ budget spent, or the index is missing. The caller must not render zeros. */
  complete: boolean
}

/**
 * Ticket value for one event, split by pass and by outcome.
 *
 * Costs TWO sum() aggregates per pass (confirmed, cancelled), so it draws on the same caller
 * budget the cancelled-count split uses and stops the moment that budget cannot cover the
 * whole event. A partial map would under-report a pass and break the reconciliation the
 * panel's footer asserts.
 */
export async function aggregateValueByPass(
  organizerUid: string,
  eventSlug:    string,
  passIds:      string[],
  budget:       { remaining: number },
): Promise<ValueByPassResult> {
  if (passIds.length === 0) return { values: {}, complete: true }
  // Two aggregates per pass — the budget is charged for what this actually costs.
  const cost = passIds.length * 2
  if (cost > budget.remaining) return { values: {}, complete: false }
  budget.remaining -= cost

  const base = adminDb.collection('registrations')
    .where('organizerUid', '==', organizerUid)
    .where('eventSlug',    '==', eventSlug)

  const sumFor = (passId: string, status: string) => base
    .where('passId', '==', passId)
    .where('status', '==', status)
    .aggregate({ amount: AggregateField.sum('amount') })
    .get()
    .then(s => {
      const v = s.data().amount
      return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0
    })

  const values: Record<string, { salesPaise: number; cancelledPaise: number }> = {}
  let complete = true

  for (let i = 0; i < passIds.length; i += CONCURRENCY) {
    const chunk = passIds.slice(i, i + CONCURRENCY)
    const rows = await Promise.all(chunk.map(pid =>
      Promise.all([sumFor(pid, 'confirmed'), sumFor(pid, 'cancelled')])
        .then(([salesPaise, cancelledPaise]) => ({ pid, salesPaise, cancelledPaise }))
        // One unreadable pass invalidates the WHOLE event's split, exactly as the count
        // version does: a map missing one pass would under-report the total and quietly
        // break the reconciliation the card prints at its foot.
        .catch(() => { complete = false; return null })))
    for (const r of rows) if (r) values[r.pid] = { salesPaise: r.salesPaise, cancelledPaise: r.cancelledPaise }
  }

  return complete ? { values, complete: true } : { values: {}, complete: false }
}
