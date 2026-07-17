// Generic Firestore job kernel (ROE-1a).
//
// Domain-neutral job-control primitives, extracted VERBATIM from the certificate
// job system (lib/certificates/firestore.ts) and parameterized ONLY by the target
// collection name. NO strategy, NO worker loop, NO payload knowledge — those stay
// feature-specific. Existing job systems delegate here; behaviour is byte-identical.
//
// A "job" document carries: a status lifecycle, a counts/progress block, a resume
// `cursor`, a lease (`lockedUntil`), an `error` slot, and lifecycle timestamps.
// Feature-specific payload lives on the SAME document alongside these generic
// fields — a feature job type simply `extends Job` (see CertificateJob).

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import type { Job, JobStatus, LeaseReason, ChunkCommit } from './types'

// Re-export the generic job types so importers can pull types + kernel from one place.
export type { Job, JobStatus, JobCounts, LeaseReason, ChunkCommit } from './types'

const jobsCol = (collection: string) => adminDb.collection(collection)

/**
 * Creates a job in `pending` state. `seed` carries feature payload fields; `total`
 * seeds the progress denominator. The generic scaffold (status/counts/cursor/
 * timestamps/lease) is written identically for every job type.
 */
export async function createJob<T extends Job = Job>(
  collection: string,
  jobId:      string,
  seed:       Record<string, unknown>,
  total:      number,
): Promise<T> {
  const ref = jobsCol(collection).doc(jobId)
  await ref.set({
    ...seed,
    jobId,
    status:        'pending',
    counts:        { total, processed: 0, succeeded: 0, failed: 0 },
    cursor:        null,
    error:         null,
    createdAt:     FieldValue.serverTimestamp(),
    startedAt:     null,
    updatedAt:     FieldValue.serverTimestamp(),
    completedAt:   null,
    lockedUntil:   null,
  })
  return (await ref.get()).data() as T
}

export async function getJob<T extends Job = Job>(collection: string, jobId: string): Promise<T | null> {
  const snap = await jobsCol(collection).doc(jobId).get()
  return snap.exists ? (snap.data() as T) : null
}

/**
 * Non-terminal jobs across all organizers/events, for the scheduled driver.
 * `status in [pending, processing]` uses the automatic single-field index — no
 * composite index or orderBy needed.
 */
export async function listActiveJobs<T extends Job = Job>(collection: string, limitN = 25): Promise<T[]> {
  const snap = await jobsCol(collection)
    .where('status', 'in', ['pending', 'processing'])
    .limit(limitN)
    .get()
  return snap.docs.map(d => d.data() as T)
}

/**
 * Attempts to lease a job for processing. Sets it to `processing` with a lease
 * expiry; returns `proceed: false` when the job is finished/cancelled or another
 * worker holds an unexpired lease. Prevents concurrent processors.
 */
export async function leaseJob<T extends Job = Job>(
  collection: string,
  jobId:      string,
  leaseMs:    number,
): Promise<{ proceed: true; job: T } | { proceed: false; reason: LeaseReason }> {
  const ref = jobsCol(collection).doc(jobId)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { proceed: false as const, reason: 'not_found' as const }
    const job = snap.data() as T

    if (job.status === 'completed') return { proceed: false as const, reason: 'completed' as const }
    if (job.status === 'cancelled') return { proceed: false as const, reason: 'cancelled' as const }

    const now    = Date.now()
    const locked = job.lockedUntil instanceof Timestamp ? job.lockedUntil.toMillis() : 0
    if (job.status === 'processing' && locked > now) {
      return { proceed: false as const, reason: 'busy' as const }
    }

    tx.update(ref, {
      status:      'processing',
      startedAt:   job.startedAt ?? FieldValue.serverTimestamp(),
      lockedUntil: Timestamp.fromMillis(now + leaseMs),
      updatedAt:   FieldValue.serverTimestamp(),
    })
    return { proceed: true as const, job: { ...job, status: 'processing' } as T }
  })
}

/**
 * Atomically commits one page of progress: increments counts, advances the
 * cursor, and renews or clears the lease. Counts + cursor move together so an
 * interrupted page is re-processed (idempotently) without double-counting.
 * Respects cancellation requested mid-page. Returns the post-commit status.
 */
export async function commitChunk(collection: string, jobId: string, c: ChunkCommit): Promise<JobStatus> {
  const ref = jobsCol(collection).doc(jobId)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return 'failed' as const
    const job = snap.data() as Job

    const cancelled = job.status === 'cancelled'
    const status: JobStatus = cancelled ? 'cancelled' : c.finished ? 'completed' : 'processing'

    tx.update(ref, {
      'counts.processed': FieldValue.increment(c.deltaProcessed),
      'counts.succeeded': FieldValue.increment(c.deltaSucceeded),
      'counts.failed':    FieldValue.increment(c.deltaFailed),
      cursor:      c.cursor,
      error:       c.lastError ?? job.error ?? null,
      status,
      lockedUntil: cancelled || c.finished ? null : Timestamp.fromMillis(Date.now() + c.leaseMs),
      updatedAt:   FieldValue.serverTimestamp(),
      completedAt: c.finished && !cancelled ? FieldValue.serverTimestamp() : (job.completedAt ?? null),
    })
    return status
  })
}

/** Marks a job failed (systemic error — not a per-item failure). */
export async function failJob(collection: string, jobId: string, message: string): Promise<void> {
  await jobsCol(collection).doc(jobId).update({
    status:      'failed',
    error:       message.slice(0, 500),
    lockedUntil: null,
    updatedAt:   FieldValue.serverTimestamp(),
  })
}

/** Requests cancellation. No-op if already completed. Returns the resulting status. */
export async function cancelJob(collection: string, jobId: string): Promise<JobStatus | null> {
  const ref = jobsCol(collection).doc(jobId)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return null
    const job = snap.data() as Job
    if (job.status === 'completed' || job.status === 'cancelled') return job.status
    tx.update(ref, {
      status:      'cancelled',
      lockedUntil: null,
      updatedAt:   FieldValue.serverTimestamp(),
    })
    return 'cancelled' as const
  })
}
