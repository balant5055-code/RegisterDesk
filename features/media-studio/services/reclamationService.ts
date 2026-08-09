// RD-MEDIA-04 · Storage reclamation — SERVER ONLY.
//
// ═══ THE HOLE THIS CLOSES ═════════════════════════════════════════════════════
// Two ways bytes used to be stranded in object storage with nothing pointing at them:
//
//   1. An ABANDONED UPLOAD. `/uploads/prepare` authorized a write and returned signed PUT
//      URLs. The browser PUT some bytes, the tab closed, `/uploads/complete` never ran.
//      Nothing recorded the keys, so nothing could ever find them. Invisible and billable
//      forever.
//   2. A FAILED DELETE. `markAssetDeleted` marks the record and the caller removes objects
//      best-effort — deliberately, so a storage hiccup cannot block an organizer from
//      deleting a photo. But nothing retried.
//
// (1) is closed by `reserveAsset` writing a `pending` record before the URLs are issued.
// (2) leaves a `deleted` record that keeps its rendition paths.
//
// Both are therefore FINDABLE BY STATUS, and this sweep reclaims them.
// ══════════════════════════════════════════════════════════════════════════════
//
// It never touches a `ready` asset. It cannot: the query filters on status, and the purge
// re-checks status inside its transaction.

import {
  listReclaimable, purgeReclaimedAsset,
} from '@/features/media-studio/repositories/assetRepo'
import { removeObjects } from '@/features/media-studio/services/uploadService'
import { RECLAIM_AFTER_MS } from '@/features/media-studio/utils/bulkOps'

// PURE — kept out of this file so a test can read the grace window without booting the
// Admin SDK. See utils/bulkOps.ts for why six hours.
export { RECLAIM_AFTER_MS }

export interface ReclaimReport {
  scanned:        number
  objectsRemoved: number
  objectsFailed:  number
  recordsPurged:  number
  /** Records whose objects could not all be removed; left for the next tick. */
  deferred:       number
  durationMs:     number
}

/**
 * Reclaims one bounded batch.
 *
 * ORDER MATTERS: objects first, record second. Purging the record first would delete the
 * only thing that knows the keys — recreating exactly the invisible orphan this sweep
 * exists to prevent. A record whose objects did not all delete is left in place, so the
 * next tick tries again; the operation is idempotent because deleting a missing object
 * succeeds.
 */
export async function reclaimAbandonedObjects(params?: {
  olderThanMs?: number
  limit?:       number
  budgetMs?:    number
}): Promise<ReclaimReport> {
  const startedAt   = Date.now()
  const olderThanMs = params?.olderThanMs ?? RECLAIM_AFTER_MS
  const limit       = Math.min(Math.max(1, params?.limit ?? 200), 500)
  const budgetMs    = params?.budgetMs ?? 45_000

  const report: ReclaimReport = {
    scanned: 0, objectsRemoved: 0, objectsFailed: 0,
    recordsPurged: 0, deferred: 0, durationMs: 0,
  }

  const candidates = await listReclaimable(olderThanMs, limit)
  report.scanned = candidates.length

  for (const candidate of candidates) {
    if (Date.now() - startedAt > budgetMs) break   // yield; the next tick resumes

    const { removed, failed } = await removeObjects(candidate.paths)
    report.objectsRemoved += removed
    report.objectsFailed  += failed

    if (failed > 0) {
      report.deferred += 1
      continue
    }

    if (await purgeReclaimedAsset(candidate.assetId)) report.recordsPurged += 1
    else report.deferred += 1   // it became `ready` between the read and the purge
  }

  report.durationMs = Date.now() - startedAt
  return report
}
