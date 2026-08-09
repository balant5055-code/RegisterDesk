// RD-MEDIA-04 · Bulk-operation and reclamation constants.
//
// PURE. No firebase-admin import — deliberately.
//
// The same discipline as `features/ai/utils/jobDoc.ts`: importing the job strategy or the
// reclamation service boots the Admin SDK, and a contract a route and a cron both depend on
// has to be testable directly. Everything here is the part with no I/O.

// RD-MS-HOTFIX-01 · from ../types, NOT from the upload service. This file is imported by a
// client component, and a value import into a service drags the storage stack — and
// lib/env — into the browser bundle.
import { UPLOAD_URL_TTL_SECONDS, type MediaBulkAction } from '@/features/media-studio/types'

/**
 * ONE job per (gallery, album, action).
 *
 * Deterministic, so double-clicking "Delete all" resumes the existing batch instead of
 * starting a second one racing the first. It is also what lets the progress endpoint read
 * every job for a scope BY ID — no query, so no index and no scan.
 *
 * `all` rather than an empty segment for a gallery-wide job: an empty segment would make
 * `gal_1____delete` and leave the id ambiguous if album ids ever admitted an empty string.
 */
export function bulkJobId(
  galleryId: string, albumId: string | null, action: MediaBulkAction,
): string {
  return `${galleryId}__${albumId ?? 'all'}__${action}`
}

/**
 * How long a reservation or a deleted record is left alone before its objects are reclaimed.
 *
 * Must comfortably exceed the slowest realistic upload of one photo's renditions. The signed
 * PUT URLs expire after `UPLOAD_URL_TTL_SECONDS`, so past that window an unfinished
 * reservation can never complete — six hours is generously beyond it and leaves room for a
 * client that retried near the edge.
 *
 * Erring long is the safe direction: sweeping too early would delete a photo someone is
 * still uploading; sweeping too late costs a few hours of storage on bytes nobody wants.
 */
export const RECLAIM_AFTER_MS = 6 * 60 * 60 * 1000

/** Re-exported so the relationship above is checkable from one place. */
export { UPLOAD_URL_TTL_SECONDS }

// ─── MS-FINAL-02 · Presenting a bulk job ──────────────────────────────────────

/** The job fields the UI reads. Structural, so a serialized job satisfies it as-is. */
export interface BulkJobView {
  status: string
  counts: { total: number; processed: number; succeeded: number; failed: number }
}

/**
 * Whether a job is still doing work.
 *
 * Drives the refresh: the browser asks for progress only while this is true, so a finished
 * batch stops costing requests instead of being polled forever.
 */
export function isJobActive(job: BulkJobView | null | undefined): boolean {
  return job?.status === 'pending' || job?.status === 'processing'
}

/**
 * Percent complete, 0–100.
 *
 * A job whose total is 0 — an empty gallery — reports 100 rather than dividing by zero: there
 * was nothing to do, so it is as done as it will ever be. Clamped because `processed` can
 * briefly exceed `total` when a delete drains a gallery that grew after the count was taken.
 */
export function jobPercent(job: BulkJobView | null | undefined): number {
  if (!job) return 0
  const { total, processed } = job.counts
  if (!Number.isFinite(total) || total <= 0) return 100
  return Math.max(0, Math.min(100, Math.round((processed / total) * 100)))
}

/** Items not yet attempted. Never negative, for the same reason as above. */
export function jobRemaining(job: BulkJobView | null | undefined): number {
  if (!job) return 0
  return Math.max(0, job.counts.total - job.counts.processed)
}

export type BulkJobTone = 'info' | 'success' | 'warning' | 'error' | 'neutral'

export interface BulkJobSummary {
  tone:  BulkJobTone
  title: string
  detail: string
}

const ACTION_VERB: Readonly<Record<string, { doing: string; done: string }>> = {
  delete:     { doing: 'Deleting',           done: 'Deleted' },
  move:       { doing: 'Moving',             done: 'Moved' },
  visibility: { doing: 'Updating visibility', done: 'Updated visibility for' },
}

/**
 * One sentence describing where a bulk job has got to.
 *
 * Pure, and kept out of the component so the wording for "finished with failures" — the case
 * that actually needs care — is provable by test. A job that succeeded partially must not
 * read as a clean success, and must not read as a total failure either.
 */
export function summariseBulkJob(
  action: string, job: BulkJobView | null | undefined,
): BulkJobSummary | null {
  if (!job) return null
  const verb = ACTION_VERB[action] ?? { doing: 'Processing', done: 'Processed' }
  const { total, processed, succeeded, failed } = job.counts

  if (job.status === 'pending') {
    return { tone: 'info', title: `${verb.doing} queued`, detail: `${total} photos are waiting to start.` }
  }
  if (job.status === 'processing') {
    return {
      tone: 'info',
      title: `${verb.doing} ${processed} of ${total}`,
      detail: failed > 0
        ? `${jobRemaining({ status: job.status, counts: job.counts })} remaining · ${failed} failed so far.`
        : `${jobRemaining({ status: job.status, counts: job.counts })} remaining.`,
    }
  }
  if (job.status === 'cancelled') {
    return { tone: 'neutral', title: 'Cancelled', detail: `${succeeded} photos were already processed and were left as they are.` }
  }
  if (job.status === 'completed') {
    // Partial success is its own tone. Reporting "done" over a batch that lost photos, or
    // "failed" over one that mostly worked, are both lies an operator would act on.
    return failed > 0
      ? {
          tone: 'warning',
          title: `${verb.done} ${succeeded} of ${total}`,
          detail: `${failed} could not be processed. Run it again to retry just those.`,
        }
      : { tone: 'success', title: `${verb.done} ${succeeded} photos`, detail: 'Nothing left to do.' }
  }
  return { tone: 'error', title: 'Stopped', detail: 'This batch stopped before finishing. Run it again to resume.' }
}
