// Event + pass counter reconciliation (Phase G.5). Source of truth: registrations.
//
//   registrationCounters/{eventSlug}.totalCount       = # confirmed registrations
//   registrationCounters/{eventSlug}.checkedInCount   = # registrations checkedIn
//   registrationCounters/{eventSlug}.passCounts[pid]  = # confirmed for that pass
//
// One projected scan per event (eventSlug is globally unique → single-field auto
// index) computes all three, so reconcileEvents/reconcilePasses share the path and
// the cron's reconcileEventsAndPasses scans each event exactly once.

import { FieldValue, FieldPath, AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { mismatch, RECON_PAGE_DEFAULT, RECON_BUDGET_MS, RECON_CURSOR_FLUSH, type CounterMismatch, type ReconcileOptions, type ReconcileResult } from '@/lib/reconciliation/types'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'
import { EVENT_STATS_VERSION } from '@/lib/registrations/types'
import { getAttendanceShardSums, attendanceReconShardRef } from '@/lib/firebase/firestore/registrationCounters'

const COUNTERS = 'registrationCounters'

// Cheap aggregation helpers (no document reads) — the wallet-reconciler pattern.
async function countQ(q: FirebaseFirestore.Query): Promise<number> {
  const snap = await q.count().get()
  return snap.data().count
}
async function sumQ(q: FirebaseFirestore.Query, field: string): Promise<number> {
  const snap = await q.aggregate({ s: AggregateField.sum(field) }).get()
  return Number(snap.data().s ?? 0)
}

interface CounterData {
  totalCount?: number; checkedInCount?: number; passCounts?: Record<string, number>
  // EA-2 S1 denormalized statistics
  statsVersion?: number; revenuePaise?: number; pendingCount?: number; cancelledCount?: number; rejectedCount?: number
  // EA-2 S2 per-pass attendance
  passCheckedInCounts?: Record<string, number>
}

async function reconcileOneEvent(slug: string, scope: { events: boolean; passes: boolean }, repair: boolean): Promise<CounterMismatch[]> {
  const counterSnap = await adminDb.collection(COUNTERS).doc(slug).get()
  if (!counterSnap.exists) return []
  const c = counterSnap.data() as CounterData

  // GA-5 S3: the check-in fields are distributed across attendance shards, so compare
  // against the EFFECTIVE value (base + shards) and repair via a corrective delta to
  // the recon shard — never an absolute base write (which would double-count).
  const shardSums = await getAttendanceShardSums(slug)
  const effCheckedIn = (c.checkedInCount ?? 0) + shardSums.checkedInCount
  const effPassCI = (pid: string): number => (c.passCheckedInCounts?.[pid] ?? 0) + (shardSums.passCheckedInCounts[pid] ?? 0)
  const shardRepairs: Record<string, unknown> = {}

  // GA-7C P1-1: recompute the denormalized statistics with cheap COUNT/SUM
  // aggregation queries (no document reads, constant memory) instead of the former
  // O(attendees) projected scan that OOM'd / timed out on 50k+ events. Same wallet-
  // reconciler pattern; results are identical to the scan for real data. Also still
  // the BACKFILL path — stamping statsVersion below flips a legacy event to "trusted".
  const regsCol = adminDb.collection('registrations').where('eventSlug', '==', slug)

  // Candidate pass IDs.
  //
  // RD-PAY-P0-4: this used to be ONLY the union of passes already tracked on the
  // counter/shards, resting on "a confirmed registration always increments its pass key
  // atomically". That assumption was false while `buildCounterIncrement` emitted a dotted
  // key under `set({merge:true})` — the dot was taken literally, so `passCounts` stayed
  // `{}` and the union was EMPTY. The reconciler therefore found no passes to check and
  // silently repaired nothing, which is exactly the state a rebuild has to fix.
  //
  // The event's own configured passes are now included. That set is authoritative, tiny
  // (a handful per event) and costs ONE extra document read, so a counter whose per-pass
  // map was lost can be rebuilt from the registrations without an O(attendees) scan.
  const eventSnap = await adminDb.collection('events').doc(slug).get()
  const rawPricing = (eventSnap.data()?.pricing ?? null) as Record<string, unknown> | null
  const configuredPassIds = Array.isArray(rawPricing?.passes)
    ? (rawPricing.passes as Record<string, unknown>[]).map(p => String(p.id ?? '')).filter(Boolean)
    : []

  const passIds = [...new Set<string>([
    ...Object.keys(c.passCounts ?? {}),
    ...Object.keys(c.passCheckedInCounts ?? {}),
    ...Object.keys(shardSums.passCheckedInCounts),
    ...configuredPassIds,
  ])]

  const [total, pending, cancelled, rejected, checkedIn, revenuePaise, perPass] = await Promise.all([
    countQ(regsCol.where('status', '==', 'confirmed')),
    countQ(regsCol.where('status', '==', 'pending')),
    countQ(regsCol.where('status', '==', 'cancelled')),
    countQ(regsCol.where('status', '==', 'rejected')),
    countQ(regsCol.where('checkedIn', '==', true)),
    sumQ(regsCol.where('status', '==', 'confirmed'), 'amount'),
    // Per-pass confirmed + checked-in counts (bounded by pass count, all in parallel).
    Promise.all(passIds.map(async pid => {
      const [pc, pci] = await Promise.all([
        countQ(regsCol.where('status', '==', 'confirmed').where('passId', '==', pid)),
        countQ(regsCol.where('checkedIn', '==', true).where('passId', '==', pid)),
      ])
      return [pid, pc, pci] as const
    })),
  ])
  const passCounts: Record<string, number> = {}
  const passCheckedIn: Record<string, number> = {}
  for (const [pid, pc, pci] of perPass) { passCounts[pid] = pc; passCheckedIn[pid] = pci }

  const out: CounterMismatch[] = []
  const repairs: Record<string, unknown> = {}

  if (scope.events) {
    if ((c.totalCount ?? 0) !== total) { out.push(mismatch('event', slug, 'totalCount', total, c.totalCount ?? 0, repair)); if (repair) repairs.totalCount = total }
    // Attendance is sharded: compare effective, repair via corrective delta to the recon shard.
    if (effCheckedIn !== checkedIn) { out.push(mismatch('event', slug, 'checkedInCount', checkedIn, effCheckedIn, repair)); if (repair) shardRepairs.checkedInCount = FieldValue.increment(checkedIn - effCheckedIn) }
    if ((c.revenuePaise ?? 0) !== revenuePaise) { out.push(mismatch('event', slug, 'revenuePaise', revenuePaise, c.revenuePaise ?? 0, repair)); if (repair) repairs.revenuePaise = revenuePaise }
    if ((c.pendingCount ?? 0) !== pending) { out.push(mismatch('event', slug, 'pendingCount', pending, c.pendingCount ?? 0, repair)); if (repair) repairs.pendingCount = pending }
    if ((c.cancelledCount ?? 0) !== cancelled) { out.push(mismatch('event', slug, 'cancelledCount', cancelled, c.cancelledCount ?? 0, repair)); if (repair) repairs.cancelledCount = cancelled }
    if ((c.rejectedCount ?? 0) !== rejected) { out.push(mismatch('event', slug, 'rejectedCount', rejected, c.rejectedCount ?? 0, repair)); if (repair) repairs.rejectedCount = rejected }
    // EA-2 S2: per-pass checked-in — repaired alongside the event stats (not gated
    // on scope.passes) so statsVersion completeness always implies it is correct.
    const storedPassCI = c.passCheckedInCounts ?? {}
    for (const pid of new Set([...Object.keys(storedPassCI), ...Object.keys(shardSums.passCheckedInCounts), ...Object.keys(passCheckedIn)])) {
      const exp = passCheckedIn[pid] ?? 0, act = effPassCI(pid)
      // RD-PAY-P0-4: nested, not dotted — the repair below is a set({merge:true}), where a
      // dotted key is a literal field name and would re-create the very corruption being
      // repaired. Merged per-key, so sibling passes are untouched.
      if (exp !== act) {
        out.push(mismatch('pass', `${slug}:${pid}`, 'checkedInCount', exp, act, repair))
        if (repair) {
          const m = (shardRepairs.passCheckedInCounts ?? {}) as Record<string, unknown>
          m[pid] = FieldValue.increment(exp - act)
          shardRepairs.passCheckedInCounts = m
        }
      }
    }
    // Stamp the stats version once the aggregates are known-good — this is what
    // flips a legacy doc to "complete" so readers trust it (forces a write even
    // when every count already matched, e.g. a free event with zero revenue).
    if (repair && (c.statsVersion ?? 0) < EVENT_STATS_VERSION) repairs.statsVersion = EVENT_STATS_VERSION
  }
  if (scope.passes) {
    const stored = c.passCounts ?? {}
    for (const pid of new Set([...Object.keys(stored), ...Object.keys(passCounts)])) {
      const exp = passCounts[pid] ?? 0, act = stored[pid] ?? 0
      // RD-PAY-P0-4: nested, not dotted — same reason as passCheckedInCounts above. This
      // is THE write that rebuilds a per-pass map lost to the dotted-key bug.
      if (exp !== act) {
        out.push(mismatch('pass', `${slug}:${pid}`, 'registrationCount', exp, act, repair))
        if (repair) {
          const m = (repairs.passCounts ?? {}) as Record<string, unknown>
          m[pid] = exp
          repairs.passCounts = m
        }
      }
    }
  }

  if (repair && Object.keys(repairs).length > 0) {
    repairs.updatedAt = FieldValue.serverTimestamp()
    await adminDb.collection(COUNTERS).doc(slug).set(repairs, { merge: true })
  }
  // Attendance corrections go to the recon shard so the summed read becomes correct
  // without double-counting the hot shards (GA-5 S3).
  if (repair && Object.keys(shardRepairs).length > 0) {
    shardRepairs.updatedAt = FieldValue.serverTimestamp()
    await attendanceReconShardRef(slug).set(shardRepairs, { merge: true })
  }
  return out
}

async function run(scope: { events: boolean; passes: boolean }, opts?: ReconcileOptions): Promise<ReconcileResult> {
  const repair = opts?.repair ?? true
  const pageSize = opts?.limit ?? RECON_PAGE_DEFAULT
  const budgetMs = opts?.budgetMs ?? RECON_BUDGET_MS
  const start = Date.now()
  const entityType = scope.events && scope.passes ? 'event+pass' : scope.events ? 'event' : 'pass'
  const cursorKey = `recon:${entityType}`

  // Bounded, cursor-resumed page (ids only, ordered by document id) — replaces the
  // former full-collection scan so a single run can't overrun the function timeout.
  const after = await readCursor(cursorKey)
  let q = adminDb.collection(COUNTERS).orderBy(FieldPath.documentId()).limit(pageSize)
  if (after) q = q.startAfter(after)
  const counters = await q.select().get()

  const all: CounterMismatch[] = []
  let scanned = 0
  let lastCompletedId: string | null = null
  let budgetHit = false
  for (const doc of counters.docs) {
    // GA-7C P1-1: stop before the function timeout and persist progress, so a heavy
    // page can never leave the cursor unadvanced (which previously re-processed the
    // same page forever and starved later events).
    if (Date.now() - start > budgetMs) { budgetHit = true; break }
    scanned++
    try { all.push(...await reconcileOneEvent(doc.id, scope, repair)) }
    catch (err) { captureError(err, { scope: 'global_reconciliation', entityType: 'event', eventSlug: doc.id }) }
    lastCompletedId = doc.id
    // Incremental cursor persistence — even an unexpected kill still advances.
    // Gated on `repair`: see the cursor note below.
    if (repair && scanned % RECON_CURSOR_FLUSH === 0) await writeCursor(cursorKey, lastCompletedId)
  }

  // Advance the cursor:
  //  - budget hit mid-page  → resume AFTER the last completed entity next run
  //    (fall back to the existing cursor if nothing completed, never reset to start).
  //  - full page completed  → resume after its last id.
  //  - short page (end)     → clear the cursor to wrap to the start.
  //
  // ONLY WHEN REPAIRING. `repair: false` is the report-only mode, and it was not actually
  // read-only: these writes land in `reconciliationCursors` regardless of what
  // reconcileOneEvent does, so a dry-run mutated the shared paging state of the real
  // scheduled run — it could skip events past the cursor, or wrap it back to the start.
  // A report must not be able to change what the next repairing run covers.
  //
  // Trade-off, deliberate: a dry-run therefore never advances the cursor, so it always
  // inspects the page starting at the CURRENT cursor position and cannot page through a
  // collection larger than `pageSize` across successive calls. That is the correct
  // behaviour for an inspection — pass `limit` to widen the window instead.
  if (repair) {
    if (budgetHit) {
      await writeCursor(cursorKey, lastCompletedId ?? after)
    } else {
      const lastId = counters.docs.length ? counters.docs[counters.docs.length - 1].id : null
      await writeCursor(cursorKey, counters.size === pageSize ? lastId : null)
    }
  }

  return { entityType, scanned, mismatches: all, repaired: all.filter(m => m.repaired).length }
}

export const reconcileEvents          = (opts?: ReconcileOptions) => run({ events: true,  passes: false }, opts)
export const reconcilePasses          = (opts?: ReconcileOptions) => run({ events: false, passes: true  }, opts)
export const reconcileEventsAndPasses = (opts?: ReconcileOptions) => run({ events: true,  passes: true  }, opts)
