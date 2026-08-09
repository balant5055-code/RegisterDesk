// RD-MEDIA-05 · Media maintenance — SERVER ONLY.
//
// ═══ ONE IMPLEMENTATION, TWO TRIGGERS ═════════════════════════════════════════
// The maintenance pipeline — drive open bulk jobs, then reclaim stranded objects — used to
// live INSIDE `/api/cron/media-jobs`. That made it unrunnable by anything but a scheduler,
// and on a deployment with no cron it never ran at all.
//
// It now lives here. The cron route and the manual Maintenance page both call
// `runMediaMaintenance` and neither contains a line of the logic. A future scheduler needs
// no change to this file: it is already the thing a scheduler would call.
// ══════════════════════════════════════════════════════════════════════════════
//
// ─── Scope: PLATFORM-WIDE, and it has to be ──────────────────────────────────
// Neither half is tenant-scoped, by construction:
//   • `listActiveJobs(MEDIA_JOBS)` reads the queue across every workspace.
//   • `listReclaimable` queries by (status, updatedAt) — the index has no organizer field.
// Scoping either per organizer would mean a new index and a tenant-iterating driver, which
// is a backend redesign. So the OPERATION stays platform-wide and the ROUTES that expose it
// are platform-admin only. See docs/RD-MEDIA-05-maintenance.md.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { listActiveJobs } from '@/lib/jobs/kernel'
import { MEDIA_JOBS } from '@/features/media-studio/types'
import { runBulkChunk, type MediaBulkJob } from '@/features/media-studio/jobs/bulkAssetJob'
import {
  reclaimAbandonedObjects, type ReclaimReport,
} from '@/features/media-studio/services/reclamationService'
import { countByStatus } from '@/features/media-studio/repositories/assetRepo'
import { isStorageReady } from '@/features/media-studio/services/uploadService'

/**
 * Where the last run is recorded.
 *
 * `platformSettings` is an EXISTING server-only collection with an existing deny rule, and
 * this is a single document read by id — so no new collection, no new rule, and no index.
 */
const MAINTENANCE_DOC = 'mediaMaintenance'
const settingsDoc = () => adminDb.collection('platformSettings').doc(MAINTENANCE_DOC)

/** Defaults sized for a 60-second serverless budget. A manual run may raise them. */
export const DEFAULT_BULK_BUDGET_MS    = 35_000
export const DEFAULT_RECLAIM_BUDGET_MS = 15_000
export const DEFAULT_MAX_BULK_JOBS     = 5
export const DEFAULT_RECLAIM_LIMIT     = 200

export type MaintenanceTrigger = 'cron' | 'manual'

/** Why a run did nothing. Absent when it ran normally. */
export type MaintenanceSkipReason = 'storage_not_configured'

export interface MaintenanceRun {
  trigger: MaintenanceTrigger
  /** ISO. Stamped by the server, never by a caller. */
  ranAt:   string
  /** Wall-clock of the whole pipeline. */
  durationMs: number

  bulk: {
    /** Open batches found. */
    scanned:  number
    /** Batches advanced by at least one chunk this run. */
    advanced: number
    /** Batches whose chunk threw. They keep their cursor and resume next run. */
    failed:   number
  }

  reclaim: ReclaimReport

  /** Set when the pipeline could not run. */
  reason?: MaintenanceSkipReason
  /** Who asked. Null for a scheduler. */
  ranBy?: string | null
}

const emptyReclaim = (): ReclaimReport => ({
  scanned: 0, objectsRemoved: 0, objectsFailed: 0,
  recordsPurged: 0, deferred: 0, durationMs: 0,
})

/**
 * Runs the maintenance pipeline once.
 *
 * TOTAL: it never throws. A failure in either half is counted and reported, because the
 * caller is either a cron tick (which must not 500 on one bad batch) or a person watching a
 * page (who needs to be told what happened, not shown a stack trace).
 *
 * Order matters: bulk work FIRST, reclamation second. A bulk delete marks records and
 * removes objects best-effort, so running reclamation afterwards picks up anything that
 * half just failed to remove — in the same run rather than the next one.
 */
export async function runMediaMaintenance(params?: {
  trigger?:          MaintenanceTrigger
  ranBy?:            string | null
  bulkBudgetMs?:     number
  reclaimBudgetMs?:  number
  maxBulkJobs?:      number
  reclaimLimit?:     number
}): Promise<MaintenanceRun> {
  const trigger = params?.trigger ?? 'manual'
  const ranBy   = params?.ranBy ?? null
  const started = Date.now()

  const bulkBudgetMs    = params?.bulkBudgetMs    ?? DEFAULT_BULK_BUDGET_MS
  const reclaimBudgetMs = params?.reclaimBudgetMs ?? DEFAULT_RECLAIM_BUDGET_MS
  const maxBulkJobs     = params?.maxBulkJobs     ?? DEFAULT_MAX_BULK_JOBS
  const reclaimLimit    = params?.reclaimLimit    ?? DEFAULT_RECLAIM_LIMIT

  // Both halves need object storage: a bulk delete would mark records deleted while their
  // bytes stayed, and reclamation could not delete anything at all.
  if (!isStorageReady()) {
    const run: MaintenanceRun = {
      trigger, ranBy,
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      bulk: { scanned: 0, advanced: 0, failed: 0 },
      reclaim: emptyReclaim(),
      reason: 'storage_not_configured',
    }
    await recordRun(run)
    return run
  }

  // ── 1. Drive open bulk batches ─────────────────────────────────────────────
  const bulk = { scanned: 0, advanced: 0, failed: 0 }
  try {
    const jobs = await listActiveJobs<MediaBulkJob>(MEDIA_JOBS, maxBulkJobs)
    bulk.scanned = jobs.length

    for (const job of jobs) {
      if (Date.now() - started > bulkBudgetMs) break   // yield; the next run resumes
      try {
        await runBulkChunk(job.jobId, bulkBudgetMs - (Date.now() - started))
        bulk.advanced += 1
      } catch (err) {
        // One batch's failure must not stop the driver. The job keeps its cursor.
        console.error('[media-maintenance] bulk error:', { jobId: job.jobId, err })
        bulk.failed += 1
      }
    }
  } catch (err) {
    console.error('[media-maintenance] bulk scan failed:', err)
  }

  // ── 2. Reclaim stranded objects ────────────────────────────────────────────
  let reclaim: ReclaimReport
  try {
    reclaim = await reclaimAbandonedObjects({
      limit:    reclaimLimit,
      // Whatever is left of the tick, never below a floor — a run that reached its bulk
      // budget should still reclaim something rather than nothing.
      budgetMs: Math.max(2_000, reclaimBudgetMs - Math.max(0, Date.now() - started - bulkBudgetMs)),
    })
  } catch (err) {
    console.error('[media-maintenance] reclamation failed:', err)
    reclaim = emptyReclaim()
  }

  const run: MaintenanceRun = {
    trigger, ranBy,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    bulk, reclaim,
  }

  await recordRun(run)
  return run
}

/**
 * Records the run, best-effort.
 *
 * A failure to write the audit line must never fail the maintenance that already happened —
 * the work is done, and reporting it as failed would invite someone to run it again.
 */
async function recordRun(run: MaintenanceRun): Promise<void> {
  try {
    await settingsDoc().set({
      lastRun: run,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
  } catch (err) {
    console.error('[media-maintenance] could not record the run:', err)
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface MaintenanceStatus {
  /** The previous run, or null when maintenance has never been executed. */
  lastRun: MaintenanceRun | null
  /** Uploads authorized but never finished — each holding objects nothing points at. */
  pendingReservations: number
  /** Records marked deleted whose object removal may not have succeeded. */
  failedDeletions: number
  /** Open bulk batches waiting for a run to advance them. */
  pendingBulkJobs: number
  /** False when the deployment has no object storage — maintenance cannot do anything. */
  storageReady: boolean
}

/**
 * What maintenance would find right now.
 *
 * Aggregate `count()` for the asset tallies — no document reads, so the panel costs the same
 * on an empty platform as on a full one. The bulk count is bounded by the same page size a
 * run uses, so "5" means "at least 5", which is what the page says.
 */
export async function getMaintenanceStatus(): Promise<MaintenanceStatus> {
  const [lastRun, pendingReservations, failedDeletions, jobs] = await Promise.all([
    readLastRun(),
    countByStatus('pending'),
    countByStatus('deleted'),
    listActiveJobs<MediaBulkJob>(MEDIA_JOBS, DEFAULT_MAX_BULK_JOBS).catch(() => []),
  ])

  return {
    lastRun,
    pendingReservations,
    failedDeletions,
    pendingBulkJobs: jobs.length,
    storageReady: isStorageReady(),
  }
}

async function readLastRun(): Promise<MaintenanceRun | null> {
  try {
    const snap = await settingsDoc().get()
    if (!snap.exists) return null
    const raw = snap.get('lastRun') as MaintenanceRun | undefined
    return raw && typeof raw.ranAt === 'string' ? raw : null
  } catch {
    // A missing document or a read failure is "never run", not an error worth failing the
    // whole panel over — the counts below are the useful part.
    return null
  }
}
