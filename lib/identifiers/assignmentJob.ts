// RD-EVENT-19E — Identifier assignment as a background job. Server-only.
//
// ═══ WHAT THIS IS, AND WHAT IT IS NOT ════════════════════════════════════════
// It is NOT a second allocation engine. Every identifier is still minted by
// `allocateIdentifier` — one transaction per participant, owning uniqueness,
// the lock, the counter, both registration mirrors and the history entry. This
// file only decides WHO is processed, in what order, and how the work is paced.
//
// It is also NOT a second job architecture. It is a `JobStrategy` on the platform's
// generic kernel (lib/jobs), the same one registration bulk check-in, certificate
// delivery and report exports run on — so leases, cursors, resume, cancel,
// progress and fencing all come for free and behave identically.
//
// ═══ WHY IT PAGES THE QUERY INSTEAD OF SNAPSHOTTING IDS ══════════════════════
// The registration-bulk exemplar snapshots a client-chosen set of ids into an
// `items` subcollection, because an arbitrary selection cannot be recomputed. This
// selection is a QUERY — "the roster for this pass" — so the runner's cursor maps
// straight onto a Firestore cursor. That means no snapshot writes at all (20,000
// participants used to cost 20,000 item writes before a single identifier existed),
// no 20,000-id request body, and no roster download in the browser.
//
// The consequence is stated rather than hidden: the job walks the roster as it
// stands while it runs. A registration created mid-run whose document id sorts
// BEFORE the cursor is not visited by that job — running it again picks them up,
// and because assignment is idempotent (below) re-running costs nothing.
//
// ═══ IDEMPOTENCY ════════════════════════════════════════════════════════════
// Every item is allocated with `skipIfAssigned`, so a participant who already holds
// an identifier is left untouched INSIDE the transaction. A retried chunk, a
// duplicate request, a cron tick racing the client poller and a re-run of the whole
// job are therefore all no-ops for anybody already assigned. Nobody is ever walked
// from 5001 to 5002.

import crypto        from 'crypto'
import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb }   from '@/lib/firebase/admin'
import { createJob as kernelCreateJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk } from '@/lib/jobs/runner'
import type { JobStrategy, ProcessResult } from '@/lib/jobs/runner'
import type { Job } from '@/lib/jobs/types'
import { allocateIdentifier } from './engine'
import { resolveIdentifierConfig } from './config'
import { IdentifierError } from './types'
import { ROSTER_STATUSES } from './eligibility'
import {
  resolveEventAssignmentGate, decidePoolScope, poolsServingPass,
  type DecisionReason, type PoolScopeContext,
} from './assignmentDecision'
import type { IdentifierConfig, AssignmentOrder } from './types'

export const IDENTIFIER_ASSIGNMENT_JOBS = 'identifierAssignmentJobs'

/** One page of roster per chunk. Matches the registration-bulk runner. */
const PAGE_SIZE = 100
const BUDGET_MS = 45_000
const LEASE_MS  = 60_000

/**
 * The registration status this job selects.
 *
 * ⚠️ THIS IS NOT A NEW PRODUCT DECISION. It is the rule the existing bulk flow
 * already applies: the organizer's list is built from `/bibs`, which queries
 * `status == 'confirmed'` and nothing else. RD-EVENT-19A and 19C both recorded
 * that the ENGINE would also accept `pending` and `waitlisted`, and both
 * deliberately declined to choose between the two rules. This job preserves the
 * shipped behaviour and reports the divergence rather than resolving it — see
 * `divergentStatuses` on the job document.
 */
const SELECTED_STATUS = ROSTER_STATUSES[0]   // 'confirmed'

// ─── Job document ───────────────────────────────────────────────────────────

/** identifierAssignmentJobs/{jobId} — generic Job fields + this payload. */
export interface IdentifierAssignmentJob extends Job {
  eventId:    string
  eventSlug:  string
  /** null ⇒ every pass in one job is NOT supported; see createIdentifierAssignmentJobs. */
  passId:     string | null
  passName:   string | null
  poolId:     string
  /** The identifier's configured name at the time the job was made, for the log. */
  label:      string
  /** Per-reason tallies, so a result can explain itself without re-reading anything. */
  reasons:    Partial<Record<DecisionReason | 'ASSIGNED' | 'FAILED', number>>
  /** RD-BIB-01 · the roster order this run walks, frozen at creation. */
  order:      AssignmentOrder
  /** First and last value this job actually issued. Never a guessed range. */
  firstValue: string | null
  lastValue:  string | null
}

// ─── Creation ───────────────────────────────────────────────────────────────

export interface CreateJobInput {
  eventId:      string
  eventSlug:    string
  organizerUid: string
  createdBy:    string
  /** One scope per pass. `null` = the unrestricted scope (an event with no passes). */
  passId:       string | null
  passName:     string | null
  poolId:       string
  label:        string
  /**
   * RD-BIB-01 · the configured order, resolved by the caller from the config.
   *
   * OPTIONAL, and it defaults to `'document'` at the write below. Making it required
   * turned every existing caller into a Firestore write of `order: undefined`, which
   * the SDK rejects outright — caught by the emulator suite, not by types, because
   * callers that omit an optional-shaped field type-check fine.
   */
  order?:       AssignmentOrder
  /** Expected item count, for progress only. Unknown ⇒ 0, and progress shows counts. */
  total:        number
}

export async function createIdentifierAssignmentJob(
  input: CreateJobInput,
): Promise<IdentifierAssignmentJob> {
  const jobId = `idassign_${crypto.randomUUID()}`
  return kernelCreateJob<IdentifierAssignmentJob>(
    IDENTIFIER_ASSIGNMENT_JOBS,
    jobId,
    {
      organizerUid: input.organizerUid, createdBy: input.createdBy,
      eventId: input.eventId, eventSlug: input.eventSlug,
      passId: input.passId, passName: input.passName,
      poolId: input.poolId, label: input.label, order: input.order ?? 'document',
      reasons: {}, firstValue: null, lastValue: null,
    },
    input.total,
  )
}

// ─── Strategy ───────────────────────────────────────────────────────────────

interface AssignCtx {
  config: IdentifierConfig
  ctx:    PoolScopeContext
}

interface RosterItem {
  registrationId: string
  passId:         string | null
  /** From the page read — the engine still re-reads authoritatively. */
  hasIdentifier:  boolean
}

/**
 * Per-chunk setup. Reads the event's identifier config and lifecycle ONCE per
 * chunk, not once per participant, and fails the whole job systemically when the
 * event has become read-only mid-run.
 */
async function loadContext(job: IdentifierAssignmentJob):
  Promise<{ ok: true; ctx: AssignCtx } | { ok: false; error: string }> {
  let lifecycleStatus: string | null = null
  try {
    const snap = await adminDb.doc(`users/${job.organizerUid}/eventDrafts/${job.eventId}`).get()
    if (!snap.exists) return { ok: false, error: 'Event not found' }
    const d = snap.data() as Record<string, unknown>
    lifecycleStatus = typeof d.lifecycleStatus === 'string' ? d.lifecycleStatus : null
  } catch {
    return { ok: false, error: 'Event not found' }
  }

  // The SAME gate the routes apply. An event cancelled while a job was queued
  // stops the job rather than quietly finishing it.
  const gate = resolveEventAssignmentGate(lifecycleStatus)
  if (!gate.open) return { ok: false, error: gate.reason ?? 'EVENT_LOCKED' }

  const { config } = await resolveIdentifierConfig(job.eventSlug)
  if (config.enabled === false) return { ok: false, error: 'IDENTIFIERS_DISABLED' }

  // Pass names are only needed to spot a deleted pass; the pool scope decision
  // treats "unknown passes" as "do not condemn", which is the safe direction.
  return { ok: true, ctx: { config, ctx: { passes: [], passesKnown: false } } }
}

/**
 * One page of the roster, ordered by document id so the runner's cursor is a real
 * Firestore cursor. Only three fields are projected — no attendee PII is read.
 */
async function fetchPage(
  job: IdentifierAssignmentJob, _ctx: AssignCtx, cursor: string | null, limit: number,
) {
  let q = adminDb.collection('registrations')
    .where('organizerUid', '==', job.organizerUid)
    .where('eventSlug', '==', job.eventSlug)
    .where('status', '==', SELECTED_STATUS)
  if (job.passId) q = q.where('passId', '==', job.passId)

  // RD-BIB-01 · the order the organizer chose, captured on the JOB at creation so a
  // config edit mid-run cannot re-order a sequence that is already half-issued.
  //
  // Both orders end in the document id, which is what makes the cursor a real
  // Firestore cursor rather than an offset: `registeredAt` is a server timestamp and
  // two people can share one, so ordering on it alone would drop or repeat a row at
  // a page boundary — and repeating a row in an allocation job means walking somebody
  // onto a second number.
  if (job.order === 'registration') {
    q = q.orderBy('registeredAt', 'asc').orderBy(FieldPath.documentId(), 'asc')
    if (cursor) {
      const at = decodeCursor(cursor)
      if (at) q = q.startAfter(Timestamp.fromMillis(at.millis), at.id)
    }
  } else {
    q = q.orderBy(FieldPath.documentId())
    if (cursor) q = q.startAfter(cursor)
  }

  const snap = await q.select('passId', 'identifier', 'registeredAt').limit(limit).get()
  const last = snap.docs[snap.docs.length - 1]
  return {
    items: snap.docs.map(d => {
      const data = d.data() as { passId?: unknown; identifier?: { value?: unknown } | null }
      return {
        registrationId: d.id,
        passId: typeof data.passId === 'string' ? data.passId : null,
        hasIdentifier: typeof data.identifier?.value === 'string' && data.identifier.value.length > 0,
      } satisfies RosterItem
    }),
    nextCursor: last
      ? (job.order === 'registration' ? encodeCursor(last) : last.id)
      : cursor,
    hasMore: snap.size === limit,
  }
}

/** `"<millis>|<docId>"` — the composite cursor registration order needs. */
function encodeCursor(doc: FirebaseFirestore.QueryDocumentSnapshot): string {
  const ts = doc.get('registeredAt') as { toMillis?: () => number } | undefined
  const millis = typeof ts?.toMillis === 'function' ? ts.toMillis() : 0
  return `${millis}|${doc.id}`
}

function decodeCursor(raw: string): { millis: number; id: string } | null {
  const at = raw.indexOf('|')
  if (at < 0) return null                       // a document-order cursor; caller ignores it
  const millis = Number(raw.slice(0, at))
  const id = raw.slice(at + 1)
  return Number.isFinite(millis) && id ? { millis, id } : null
}

type Reason = DecisionReason | 'ASSIGNED' | 'FAILED'

/**
 * Records why one item ended the way it did.
 *
 * ATOMIC AND AWAITED, deliberately. The first version fired these off without
 * waiting and used a read-modify-write transaction; both were wrong. Unawaited,
 * the result panel could be read before the tallies landed, so a finished run
 * reported fewer reasons than it had actually processed — a counter that
 * disagrees with reality, which is precisely what this workspace must never do.
 * Read-modify-write also made every item contend on one document.
 *
 * `FieldValue.increment` on a dotted path needs no read and cannot lose a
 * concurrent update. `update()` (not `set(..., {merge:true})`) is required for the
 * dot to mean a path rather than a literal key.
 *
 * A failure here is swallowed: a lost tally must never fail an assignment that
 * really happened. The kernel's own `counts` remain the authority for totals.
 */
async function tally(
  jobId: string, reason: Reason, value?: string, isFirst?: boolean,
): Promise<void> {
  try {
    const patch: Record<string, unknown> = { [`reasons.${reason}`]: FieldValue.increment(1) }
    if (reason === 'ASSIGNED' && value) {
      // The range this run ACTUALLY issued — two real endpoints, never a span.
      patch.lastValue = value
      if (isFirst) patch.firstValue = value
    }
    await adminDb.collection(IDENTIFIER_ASSIGNMENT_JOBS).doc(jobId).update(patch)
  } catch { /* never fail an assignment that succeeded */ }
}

export function identifierAssignStrategy(): JobStrategy<IdentifierAssignmentJob, AssignCtx, RosterItem> {
  // Per-chunk memory of whether this run has recorded its first issued value.
  let seenFirst = false

  return {
    loadContext,
    fetchPage,

    async processItem(item, job, ctx) {
      // Already holds one → nothing to do. Read from the page projection so the
      // common re-run case costs no transaction at all; the engine re-checks
      // authoritatively inside the transaction for anyone who slipped through.
      if (item.hasIdentifier) {
        await tally(job.jobId, 'ALREADY_ASSIGNED')
        return { ok: true, skipped: true }
      }

      // The pass↔pool rule, from the 19C decision model. A participant on another
      // pass is never given this pool's numbers — the whole point of pass scoping.
      const pool = ctx.config.pools.find(p => p.poolId === job.poolId) ?? null
      const scope = decidePoolScope(pool, item.passId, ctx.ctx)
      if (!scope.eligible) {
        await tally(job.jobId, scope.reason ?? 'POOL_MISSING')
        return { ok: true, skipped: true }
      }

      try {
        const r = await allocateIdentifier({
          eventSlug:      job.eventSlug,
          registrationId: item.registrationId,
          actor:          job.createdBy || job.organizerUid,
          source:         'bulk',
          poolId:         job.poolId,
          passId:         item.passId,
          reason:         `job ${job.jobId}`,
          // THE idempotency guarantee — see AllocateInput.skipIfAssigned.
          skipIfAssigned: true,
        })
        if (r.alreadyAssigned) {
          await tally(job.jobId, 'ALREADY_ASSIGNED')
          return { ok: true, skipped: true }
        }
        const isFirst = !seenFirst && !job.firstValue
        seenFirst = true
        await tally(job.jobId, 'ASSIGNED', r.value, isFirst)
        return { ok: true }
      } catch (err) {
        // The engine's own vocabulary is preserved, so a result can explain itself.
        const reason = err instanceof IdentifierError ? err.code : 'FAILED'
        await tally(job.jobId, reason as Reason)
        return { ok: false, error: reason }
      }
    },
  }
}

/**
 * Advances ONE chunk. Safe to call repeatedly and from several drivers at once —
 * the kernel's lease means the second caller is told `busy` and does nothing.
 */
export async function processIdentifierAssignmentChunk(jobId: string): Promise<ProcessResult> {
  return runJobChunk(jobId, identifierAssignStrategy(), {
    collection: IDENTIFIER_ASSIGNMENT_JOBS,
    pageSize:   PAGE_SIZE,
    budgetMs:   BUDGET_MS,
    leaseMs:    LEASE_MS,
    // RD-EVENT-19G · this job is driven by a CLIENT CHAIN while the organizer
    // watches, so a chunk that yields on its time budget must hand the lease over
    // rather than renew it. Without this the next call in the chain sees a live
    // 60s lease, is told it is busy, and does nothing — a 5,000-row run stalled at 500
    // and only resumed on the next cron tick. Same reason the broadcast and
    // certificate runners set it. Safety is unchanged: the page is already
    // committed when the lease clears, and fencing is checked first.
    releaseLeaseOnHandoff: true,
  })
}

export const getIdentifierAssignmentJob = (jobId: string) =>
  getJob<IdentifierAssignmentJob>(IDENTIFIER_ASSIGNMENT_JOBS, jobId)

// ─── Scope planning (shared by the route and the UI contract) ────────────────

export interface PlannedScope {
  passId:   string | null
  passName: string | null
  poolId:   string | null
  /** Set when this scope cannot run at all. */
  blocked:  DecisionReason | null
}

/**
 * Turns a selection into the scopes a run would create — ONE JOB PER SCOPE.
 *
 * ALL PASSES is emphatically not "one job over everybody": each pass gets its own
 * job, bound to its own pool, so a participant can only ever be issued a number
 * from the pool their pass owns. A pass with no pool is reported as blocked and
 * is NOT quietly folded into somebody else's pool.
 *
 * When several pools serve one pass, the FIRST in configuration order is used —
 * the same pool `resolvePool` would pick — and the rest are left for a later run
 * once it is exhausted.
 */
export function planScopes(
  config: IdentifierConfig,
  passes: Array<{ id: string; name: string }>,
  selection: { kind: 'all_passes' } | { kind: 'pass'; passIds: string[] },
): PlannedScope[] {
  const wanted = selection.kind === 'all_passes'
    ? passes.map(p => p.id)
    : [...new Set(selection.passIds)]

  if (wanted.length === 0) {
    // An event with no passes still has one unrestricted scope to assign into.
    const pool = config.pools.find(p => !p.passIds?.length && p.matchRule?.by !== 'pass')
    return [{
      passId: null, passName: null,
      poolId: pool?.poolId ?? null,
      blocked: pool ? null : 'POOL_MISSING',
    }]
  }

  return wanted.map(passId => {
    const serving = poolsServingPass(config, passId)
    const name = passes.find(p => p.id === passId)?.name ?? null
    return {
      passId, passName: name,
      poolId: serving[0]?.poolId ?? null,
      blocked: serving.length === 0 ? 'POOL_MISSING' : null,
    }
  })
}
