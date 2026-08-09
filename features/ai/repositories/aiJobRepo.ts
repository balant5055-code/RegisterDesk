// RD-AI-01 · AI job persistence — SERVER ONLY.
//
// The only module that writes `aiJobs`. Metadata only: no image byte, no provider raw
// response, no prompt text. Every mutation goes through the state machine
// (`queue/stateMachine.ts`) inside a transaction, so an illegal transition is impossible
// even under two concurrent dispatchers.
//
// ─── Leasing and fencing ─────────────────────────────────────────────────────
// Same discipline as `lib/jobs/kernel.ts`: claiming sets `lockedUntil`, and the millisecond
// value it was set to IS the fencing token. A worker whose lease expired mid-call cannot
// commit, because `lockedUntil` no longer matches the tag it holds. Without this, a slow
// provider call plus an overlapping cron tick would bill the same inference twice and write
// two results.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  AI_JOBS, AI_JOB_STATUSES, AI_SCHEMA_VERSION, CLAIMABLE_STATUSES,
  type AIJobDoc, type AIJobError, type AIJobStatus, type AIQueueSummary,
} from '@/features/ai/types'
import { AIError } from '@/features/ai/types/errors'
import { isDue, nextStatus } from '@/features/ai/queue/stateMachine'
import { toQueueSummary, type AIJobSeed } from '@/features/ai/utils/jobDoc'

const jobs = () => adminDb.collection(AI_JOBS)

const leaseMillis = (v: unknown): number | null =>
  v instanceof Timestamp ? v.toMillis() : null

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getJob(jobId: string): Promise<AIJobDoc | null> {
  const snap = await jobs().doc(jobId).get()
  if (!snap.exists) return null
  const doc = snap.data() as AIJobDoc
  return doc.schemaVersion === AI_SCHEMA_VERSION ? doc : null
}

/**
 * Tenant-checked read. A job belonging to another workspace reads as absent, never as
 * forbidden — that leaks nothing about what exists.
 */
export async function getOwnedJob(jobId: string, organizerUid: string): Promise<AIJobDoc | null> {
  const doc = await getJob(jobId)
  return doc && doc.organizerUid === organizerUid ? doc : null
}

/**
 * Per-status tallies for one event, using aggregate `count()` queries — no document reads,
 * so the summary costs the same whether the event has 50 photos or 500,000.
 */
export async function countByStatus(
  organizerUid: string, eventId: string,
): Promise<AIQueueSummary> {
  const base = jobs()
    .where('organizerUid', '==', organizerUid)
    .where('eventId', '==', eventId)

  const results = await Promise.all(
    AI_JOB_STATUSES.map(async status => {
      const agg = await base.where('status', '==', status).count().get()
      return [status, agg.data().count] as const
    }),
  )

  return toQueueSummary(Object.fromEntries(results))
}

// ─── Create ───────────────────────────────────────────────────────────────────

export interface CreateOutcome {
  job:     AIJobDoc
  /** False when a job for this (asset, kind) already existed and was left untouched. */
  created: boolean
}

/**
 * Creates a job, or returns the existing one.
 *
 * CREATE-ONLY, never overwrite. A completed job holds a result and a failed job holds the
 * reason it failed; silently resetting either because a batch was re-run would destroy the
 * record an organizer is looking at. Re-analysis is an explicit `requeue`.
 */
export async function createJobIfAbsent(seed: AIJobSeed): Promise<CreateOutcome> {
  const ref = jobs().doc(seed.jobId)

  const outcome = await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (snap.exists) return { created: false }

    tx.set(ref, {
      ...seed,
      lockedUntil: null,
      createdAt:   FieldValue.serverTimestamp(),
      startedAt:   null,
      completedAt: null,
      updatedAt:   FieldValue.serverTimestamp(),
    })
    return { created: true }
  })

  const job = (await ref.get()).data() as AIJobDoc
  return { job, created: outcome.created }
}

// ─── Claim ────────────────────────────────────────────────────────────────────

export interface Lease {
  job: AIJobDoc
  /** Fencing token — the `lockedUntil` millis this worker holds. */
  leaseTag: number
}

/**
 * Candidate jobs a dispatcher could take, cheapest-first.
 *
 * `status in [queued, retry]` ordered by `nextAttemptAt`: a queued job carries null, which
 * Firestore sorts before every number, so fresh work is served before work that is waiting
 * out a backoff. Due-ness and lease state are re-checked inside `claim`, because a candidate
 * can be taken by another worker between this read and that transaction.
 */
export async function listClaimable(limit = 25): Promise<AIJobDoc[]> {
  const snap = await jobs()
    .where('status', 'in', CLAIMABLE_STATUSES as string[])
    .orderBy('nextAttemptAt', 'asc')
    .limit(limit)
    .get()
  return snap.docs.map(d => d.data() as AIJobDoc)
}

/**
 * Takes a job for processing, or refuses.
 *
 * Increments `attempt` HERE rather than on failure: a worker that dies mid-call has still
 * consumed an attempt, and counting only on failure would let a job that reliably kills its
 * worker be retried forever.
 */
export async function claim(
  jobId: string, leaseMs: number, now: number = Date.now(),
): Promise<Lease | null> {
  const ref = jobs().doc(jobId)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return null
    const job = snap.data() as AIJobDoc

    if (!isDue({
      status:        job.status,
      nextAttemptAt: job.nextAttemptAt,
      lockedUntilMs: leaseMillis(job.lockedUntil),
      now,
    })) return null

    const status = nextStatus(job.status, 'claim')
    if (status === null) return null

    const leaseTag = now + leaseMs
    const attempt  = job.attempt + 1

    tx.update(ref, {
      status,
      attempt,
      nextAttemptAt: null,
      lockedUntil:   Timestamp.fromMillis(leaseTag),
      startedAt:     job.startedAt ?? FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    })

    return {
      job: { ...job, status, attempt, nextAttemptAt: null },
      leaseTag,
    }
  })
}

// ─── Settle ───────────────────────────────────────────────────────────────────

/** True when the commit landed; false when this worker was fenced out. */
export type SettleOutcome = { committed: boolean; status: AIJobStatus }

/** Rejects a commit from a worker that no longer holds the lease. */
function fenced(job: AIJobDoc, expectedLeaseTag: number): boolean {
  return leaseMillis(job.lockedUntil) !== expectedLeaseTag
}

export async function markCompleted(params: {
  jobId:    string
  leaseTag: number
  resultId: string
  providerId:      string
  providerVersion: string | null
  durationMs:      number
}): Promise<SettleOutcome> {
  const ref = jobs().doc(params.jobId)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { committed: false, status: 'failed' as AIJobStatus }
    const job = snap.data() as AIJobDoc

    if (fenced(job, params.leaseTag)) return { committed: false, status: job.status }

    const status = nextStatus(job.status, 'succeed')
    if (status === null) return { committed: false, status: job.status }

    tx.update(ref, {
      status,
      resultId:        params.resultId,
      providerId:      params.providerId,
      providerVersion: params.providerVersion,
      durationMs:      params.durationMs,
      error:           null,
      lockedUntil:     null,
      completedAt:     FieldValue.serverTimestamp(),
      updatedAt:       FieldValue.serverTimestamp(),
    })
    return { committed: true, status }
  })
}

/**
 * Records a failed attempt as either a scheduled retry or a final failure.
 *
 * The caller decides which via `decideFailureAction` — the policy stays in the pure state
 * machine, and this function only persists the decision.
 */
export async function markFailure(params: {
  jobId:    string
  leaseTag: number
  action:   'scheduleRetry' | 'fail'
  error:    AIJobError
  /** Required when the action is `scheduleRetry`. */
  nextAttemptAt?: number | null
  providerId:      string | null
  providerVersion: string | null
  durationMs:      number
}): Promise<SettleOutcome> {
  const ref = jobs().doc(params.jobId)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { committed: false, status: 'failed' as AIJobStatus }
    const job = snap.data() as AIJobDoc

    if (fenced(job, params.leaseTag)) return { committed: false, status: job.status }

    const status = nextStatus(job.status, params.action)
    if (status === null) return { committed: false, status: job.status }

    tx.update(ref, {
      status,
      error:           params.error,
      nextAttemptAt:   params.action === 'scheduleRetry' ? (params.nextAttemptAt ?? null) : null,
      providerId:      params.providerId,
      providerVersion: params.providerVersion,
      durationMs:      params.durationMs,
      lockedUntil:     null,
      // A retry is not finished, so completedAt stays null until the job truly settles.
      completedAt:     params.action === 'fail' ? FieldValue.serverTimestamp() : null,
      updatedAt:       FieldValue.serverTimestamp(),
    })
    return { committed: true, status }
  })
}

// ─── Organizer-initiated transitions ──────────────────────────────────────────

/**
 * Cancels a job. Tenant-checked, and idempotent for an already-cancelled job.
 *
 * A RUNNING job is cancelled optimistically: the in-flight provider call is not abortable
 * from here, so the dispatcher discovers the cancellation when its commit is refused by the
 * state machine. The result of that call is discarded rather than stored.
 */
export async function cancelJob(jobId: string, organizerUid: string): Promise<AIJobStatus> {
  const ref = jobs().doc(jobId)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new AIError('NOT_FOUND', 'Job not found.')
    const job = snap.data() as AIJobDoc
    if (job.organizerUid !== organizerUid) throw new AIError('NOT_FOUND', 'Job not found.')

    if (job.status === 'cancelled') return 'cancelled' as AIJobStatus

    const status = nextStatus(job.status, 'cancel')
    if (status === null) {
      throw new AIError('INVALID_STATE', `A ${job.status} job cannot be cancelled.`)
    }

    tx.update(ref, {
      status,
      nextAttemptAt: null,
      lockedUntil:   null,
      completedAt:   FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    })
    return status
  })
}

/**
 * Puts a failed job back in line, resetting its attempt budget.
 *
 * Only from `failed`, and only by a human: the pipeline never resurrects a job it gave up
 * on, or a permanently-broken image would burn quota forever.
 */
export async function requeueJob(jobId: string, organizerUid: string): Promise<AIJobStatus> {
  const ref = jobs().doc(jobId)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new AIError('NOT_FOUND', 'Job not found.')
    const job = snap.data() as AIJobDoc
    if (job.organizerUid !== organizerUid) throw new AIError('NOT_FOUND', 'Job not found.')

    const status = nextStatus(job.status, 'requeue')
    if (status === null) {
      throw new AIError('INVALID_STATE', `Only a failed job can be requeued; this one is ${job.status}.`)
    }

    tx.update(ref, {
      status,
      attempt:       0,
      nextAttemptAt: null,
      error:         null,
      lockedUntil:   null,
      completedAt:   null,
      updatedAt:     FieldValue.serverTimestamp(),
    })
    return status
  })
}
