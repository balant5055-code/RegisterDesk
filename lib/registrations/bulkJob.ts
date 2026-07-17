// Bulk check-in / bulk restore on the generic job runner (OE-1). Server-only.
//
// Replaces the synchronous 200-row `/registrations/bulk` path for check_in/restore
// with a background job: selected registrations are snapshotted into an `items`
// subcollection (like Registration Import) and processed in leased, cursor-paged
// chunks with progress/resume/cancel. Each item REUSES the canonical transactional
// services — checkInRegistration() and restoreRegistration() — so nothing is
// duplicated and both are idempotent + capacity-safe by construction:
//   • check-in: re-processing an already-checked-in row returns `already_checked_in`
//     with no counter change (no duplicate check-ins).
//   • restore:  restoreRegistration re-checks capacity INSIDE its transaction each
//     time (no TOCTOU), and a re-processed already-restored row throws
//     NotCancelledError → treated as success (the snapshot guaranteed it was
//     cancelled), with no double counter increment (no over-capacity restores).

import crypto            from 'crypto'
import { FieldPath }     from 'firebase-admin/firestore'
import { adminDb }       from '@/lib/firebase/admin'
import { createJob as kernelCreateJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk }   from '@/lib/jobs/runner'
import type { JobStrategy, ProcessResult } from '@/lib/jobs/runner'
import type { Job }      from '@/lib/jobs/types'
import {
  checkInRegistration, restoreRegistration, writeAuditEntry, NotCancelledError,
} from '@/lib/firebase/firestore/registrations'
import { notifyBulkComplete } from '@/lib/notifications/inbox/notify'

export const REGISTRATION_BULK_JOBS = 'registrationBulkJobs'

// Bound the snapshot; the runner handles arbitrarily many across chunks/cron ticks.
export const BULK_JOB_MAX_ITEMS = 20_000

const BULK_PAGE_SIZE = 100
const BULK_BUDGET_MS = 45_000
const BULK_LEASE_MS  = 60_000

export type BulkJobKind = 'check_in' | 'restore'

// registrationBulkJobs/{jobId} — generic control fields (Job) + payload.
export interface RegistrationBulkJob extends Job {
  kind:      BulkJobKind
  eventId:   string
  eventSlug: string
}

// registrationBulkJobs/{jobId}/items/{seq} — a registration to process. Only the id
// is stored; the transactional services re-read the live registration.
interface BulkJobItem { registrationId: string }

// ─── Job creation (snapshot selected registrations) ───────────────────────────
export async function createRegistrationBulkJob(
  kind: BulkJobKind,
  meta: { eventId: string; eventSlug: string; organizerUid: string; createdBy: string },
  registrationIds: string[],
): Promise<RegistrationBulkJob> {
  const jobId = `bulk_${crypto.randomUUID()}`

  const job = await kernelCreateJob<RegistrationBulkJob>(
    REGISTRATION_BULK_JOBS,
    jobId,
    { organizerUid: meta.organizerUid, createdBy: meta.createdBy, kind, eventId: meta.eventId, eventSlug: meta.eventSlug },
    registrationIds.length,
  )

  const col = adminDb.collection(REGISTRATION_BULK_JOBS).doc(jobId).collection('items')
  for (let i = 0; i < registrationIds.length; i += 400) {
    const batch = adminDb.batch()
    for (let j = i; j < Math.min(i + 400, registrationIds.length); j++) {
      batch.set(col.doc(`r${String(j).padStart(7, '0')}`), { registrationId: registrationIds[j] } satisfies BulkJobItem)
    }
    await batch.commit()
  }

  return job
}

// ─── Shared strategy pieces ────────────────────────────────────────────────────

// No per-chunk state is needed: the transactional services do their own fresh reads
// (capacity/counters) inside each item's transaction.
type BulkCtx = Record<string, never>

async function loadContext(): Promise<{ ok: true; ctx: BulkCtx }> {
  return { ok: true, ctx: {} }
}

async function fetchPage(job: RegistrationBulkJob, _ctx: BulkCtx, cursor: string | null, limit: number) {
  let q = adminDb.collection(REGISTRATION_BULK_JOBS).doc(job.jobId).collection('items')
    .orderBy(FieldPath.documentId())
  if (cursor) q = q.startAfter(cursor)
  q = q.limit(limit)
  const snap = await q.get()
  return {
    items:      snap.docs.map(d => d.data() as BulkJobItem),
    nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor,
    hasMore:    snap.size === limit,
  }
}

// ─── BulkCheckInStrategy ───────────────────────────────────────────────────────
export function bulkCheckInStrategy(): JobStrategy<RegistrationBulkJob, BulkCtx, BulkJobItem> {
  return {
    loadContext,
    fetchPage,
    async processItem(item, job) {
      try {
        const r = await checkInRegistration(item.registrationId, job.organizerUid, {
          byUid: job.createdBy ?? job.organizerUid, workspaceUid: job.organizerUid, source: 'bulk',
        })
        if (r.status === 'checked_in') {
          void writeAuditEntry(item.registrationId, 'checked_in', job.createdBy ?? job.organizerUid, 'organizer', job.organizerUid)
        }
        return { ok: true }   // checked_in OR already_checked_in
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'check-in failed' }
      }
    },
    onComplete: (job) => notifyBulkOnComplete(job, 'Check-in'),
  }
}

// ─── BulkRestoreStrategy (reuses the transactional restoreRegistration) ────────
export function bulkRestoreStrategy(): JobStrategy<RegistrationBulkJob, BulkCtx, BulkJobItem> {
  return {
    loadContext,
    fetchPage,
    async processItem(item, job) {
      try {
        await restoreRegistration(item.registrationId, job.organizerUid)   // capacity + sessions, atomically
        void writeAuditEntry(item.registrationId, 'restored', job.createdBy ?? job.organizerUid, 'organizer', job.organizerUid)
        return { ok: true }
      } catch (err) {
        // Already restored (snapshot guaranteed it was cancelled) → idempotent success.
        if (err instanceof NotCancelledError) return { ok: true }
        return { ok: false, error: err instanceof Error ? err.message : 'restore failed' }
      }
    },
    onComplete: (job) => notifyBulkOnComplete(job, 'Restore'),
  }
}

// EA-4 S3: one grouped Notification-Center entry when a bulk job finishes.
function notifyBulkOnComplete(job: RegistrationBulkJob, action: string): void {
  const j = job as unknown as { organizerUid?: string; eventId?: string | null; eventSlug?: string | null }
  if (!j.organizerUid) return
  void notifyBulkComplete({
    workspaceUid: j.organizerUid, jobId: job.jobId, action,
    eventId: j.eventId ?? j.eventSlug ?? null,
    succeeded: job.counts.succeeded, failed: job.counts.failed,
  })
}

// ─── Public entry point ─────────────────────────────────────────────────────────

/** Advances one chunk of a bulk job (dispatched by kind). Safe to call repeatedly —
 *  resumes from the persisted cursor. */
export async function processRegistrationBulkChunk(jobId: string): Promise<ProcessResult> {
  const job = await getJob<RegistrationBulkJob>(REGISTRATION_BULK_JOBS, jobId)
  const strategy = job?.kind === 'restore' ? bulkRestoreStrategy() : bulkCheckInStrategy()
  return runJobChunk(jobId, strategy, {
    collection: REGISTRATION_BULK_JOBS,
    pageSize:   BULK_PAGE_SIZE,
    budgetMs:   BULK_BUDGET_MS,
    leaseMs:    BULK_LEASE_MS,
  })
}
