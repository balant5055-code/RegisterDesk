// MC-03 · Reservation cleanup — SERVER ONLY. No scheduler; this is the service only.
//
// Releases holds whose upload never finished. Without it, a browser closed mid-upload would
// strand credits as `heldCredits` forever: unspendable, unrefundable, and invisible to the
// organizer as anything but a balance that will not add up.
//
// ═══ WHY IT REUSES THE MEDIA WINDOW ══════════════════════════════════════════
// `RECLAIM_AFTER_MS` (6 h) is the same cutoff the storage reclamation sweep already uses for
// abandoned `pending` assets. A credit hold and the asset it belongs to share an id and a
// fate, so giving them two different expiry clocks could release the credits for an upload
// the storage sweep still considers live. One window, one truth.
//
// ═══ NO FOURTH STATE ═════════════════════════════════════════════════════════
// An expired hold becomes `released`, not `expired` (MC-03 Decision 2). The distinction that
// matters — swept versus failed — is carried on the LEDGER entry via `actorKind: 'system'`,
// so the reservation lifecycle stays three states wide.

import { RECLAIM_AFTER_MS } from '@/features/media-studio/utils/bulkOps'
import { ledgerService, reservationService } from '@/features/media-credits/services'

export { RECLAIM_AFTER_MS }

/** The uid recorded as the actor for a sweep-initiated release. */
export const SYSTEM_ACTOR = 'system'

export interface CleanupReport {
  scanned:  number
  released: number
  failed:   number
  durationMs: number
}

export interface CleanupParams {
  /** Defaults to the shared 6-hour media reclamation window. */
  olderThanMs?: number
  /** Hard cap on reservations examined in one run. */
  limit?: number
  /** Wall-clock budget; the run yields when exceeded and the next tick resumes. */
  budgetMs?: number
}

/**
 * Releases stale holds.
 *
 * Each release is its own transaction, deliberately: one poisoned reservation must not
 * prevent the rest of the batch from being cleaned. A failure is counted and the sweep
 * continues, and because `releaseInTx` is idempotent the next run simply retries it.
 *
 * Time-budgeted in the same shape as the media sweep, so a large backlog degrades into more
 * runs rather than one run that never returns.
 */
export async function releaseStaleReservations(
  params?: CleanupParams,
): Promise<CleanupReport> {
  const startedAt   = Date.now()
  const olderThanMs = params?.olderThanMs ?? RECLAIM_AFTER_MS
  const limit       = params?.limit ?? 200
  const budgetMs    = params?.budgetMs ?? 30_000

  const report: CleanupReport = { scanned: 0, released: 0, failed: 0, durationMs: 0 }

  const stale = await reservationService.listStale(olderThanMs, limit)
  for (const reservation of stale) {
    if (Date.now() - startedAt > budgetMs) break   // yield; the next tick resumes
    report.scanned++
    try {
      await ledgerService.release({
        organizerUid: reservation.organizerUid,
        assetId:      reservation.reservationId,
        actorUid:     SYSTEM_ACTOR,
      })
      report.released++
    } catch (err) {
      // Counted, never thrown. A sweep that aborts on the first bad record leaves every
      // later one stranded — the failure mode this service exists to prevent.
      report.failed++
      console.error(
        `[media-credits/cleanup] release failed for ${reservation.reservationId}:`, err,
      )
    }
  }

  report.durationMs = Date.now() - startedAt
  return report
}
