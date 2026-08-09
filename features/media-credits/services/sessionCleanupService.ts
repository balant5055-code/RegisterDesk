// MC-06A · Session reclamation — SERVER ONLY. Service only; NO scheduler.
//
// Seals ACTIVE sessions past their expiry. Without it, a browser closed mid-upload would
// strand its allocation as `heldCredits` forever: unspendable, unrefundable, and visible to
// the organizer only as a balance that does not add up.
//
// ═══ RUNS EVEN WHEN CREDITS ARE DISABLED ═════════════════════════════════════
// Architecture Spec v1.0 §20, and it is deliberate rather than defensive. If an admin turns
// `creditsEnabled` off while sessions are open, a sweep that skipped on the flag would leave
// those holds permanently stranded — the credits were taken while the feature was on, and
// turning it off must not orphan them. This is the one place in the module that ignores the
// master switch, and it is why MC-05's reconciliation cron (which DOES skip when disabled)
// must not be the one that owns this.
//
// ═══ WIRED IN MC-06D ═════════════════════════════════════════════════════════
// `/api/cron/media-credit-sessions` calls `runSessionCleanup` on the shared 10-minute
// recovery schedule. It is a SEPARATE route from the reconciliation cron precisely because
// that one skips when credits are disabled and this one must not.

import * as sessionRepo from '@/features/media-credits/repositories/sessionRepo'
import { sealSession } from '@/features/media-credits/services/sessionService'
import { settleSealedSessions } from '@/features/media-credits/services/sessionSettlementService'
import { releaseStaleReservations } from '@/features/media-credits/services/cleanupService'
import { opsLog } from '@/features/media-credits/utils/opsLog'

/** Recorded as the actor on a sweep-initiated seal, distinguishing it from an organizer close. */
export const SESSION_SWEEP_ACTOR = 'system'

export interface SessionCleanupReport {
  scanned:  number
  sealed:   number
  /** Already sealed or settled when reached — a benign race, not a failure. */
  skipped:  number
  failed:   number
  durationMs: number
}

export interface SessionCleanupParams {
  /** Hard cap on sessions examined in one run. */
  limit?:    number
  /** Wall-clock budget; the run yields when exceeded and the next tick resumes. */
  budgetMs?: number
}

/**
 * Seals every ACTIVE session past its expiry.
 *
 * Each seal is its own transaction, deliberately: one poisoned session must not prevent the
 * rest of the batch from being reclaimed. A failure is counted and the sweep continues, and
 * because `sealSession` is idempotent the next run simply retries it.
 *
 * Time-budgeted in the same shape as the media sweep, so a large backlog degrades into more
 * runs rather than one run that never returns.
 */
export async function sealExpiredSessions(
  params?: SessionCleanupParams,
): Promise<SessionCleanupReport> {
  const startedAt = Date.now()
  const limit     = params?.limit    ?? 200
  const budgetMs  = params?.budgetMs ?? 30_000

  const report: SessionCleanupReport = {
    scanned: 0, sealed: 0, skipped: 0, failed: 0, durationMs: 0,
  }

  const expired = await sessionRepo.listExpiredActive(limit)
  for (const session of expired) {
    if (Date.now() - startedAt > budgetMs) break   // yield; the next tick resumes
    report.scanned++
    try {
      const outcome = await sealSession({
        sessionId: session.sessionId,
        reason:    'EXPIRED',
        sealedBy:  SESSION_SWEEP_ACTOR,
        // No organizerUid: the sweep is not tenant-scoped by design.
      })
      if (outcome.sealed) report.sealed++
      else report.skipped++          // an organizer closed it first — working as intended
    } catch (err) {
      // Counted, never thrown. A sweep that aborts on the first bad record leaves every
      // later one stranded — the failure mode this service exists to prevent.
      report.failed++
      console.error(
        `[media-credits/session-cleanup] seal failed for ${session.sessionId}:`, err,
      )
    }
  }

  report.durationMs = Date.now() - startedAt
  return report
}

// ─── The ordered sweep (MC-06C, Spec v1.0 §16) ────────────────────────────────

export interface SessionSweepReport {
  seal:     SessionCleanupReport
  settle:   Awaited<ReturnType<typeof settleSealedSessions>>
  reservations: Awaited<ReturnType<typeof releaseStaleReservations>>
  /**
   * MC-06D. Which stages ran out of time.
   *
   * Surfaced rather than inferred, because "settled 200 of 200" and "settled 200 and gave up"
   * are indistinguishable from the counts alone — and the second means a backlog is building.
   */
  budgetExhausted: ('seal' | 'settle' | 'reservations')[]
  durationMs: number
}

/**
 * The full session reclamation pass, in the ONE order that is safe.
 *
 *     1. seal expired sessions
 *     2. settle sealed sessions
 *     3. reclaim stale reservations
 *
 * ═══ WHY THE ORDER IS LOAD-BEARING ═══════════════════════════════════════════
 * Spec v1.0 §16. Reclaiming reservations before settlement would release slots that
 * settlement is about to count, so an organizer's completed uploads would silently stop being
 * charged — credits created out of nothing. Settling first fixes the count, after which
 * releasing whatever is left over is harmless.
 *
 * Sealing first is what makes the count exact at all: an ACTIVE session can still gain
 * consumed slots, so counting one is sampling a moving target.
 *
 * Each stage is independently idempotent, so a pass interrupted anywhere resumes cleanly on
 * the next tick.
 */
export async function runSessionCleanup(
  params?: SessionCleanupParams,
): Promise<SessionSweepReport> {
  const startedAt = Date.now()
  const limit     = params?.limit    ?? 200
  const budgetMs  = params?.budgetMs ?? 30_000
  // Split three ways so a large backlog in one stage cannot starve the others entirely.
  const slice = Math.max(5_000, Math.floor(budgetMs / 3))

  opsLog('cleanup.started', { limit, budgetMs })
  const budgetExhausted: ('seal' | 'settle' | 'reservations')[] = []

  // A stage that consumed its whole slice stopped because it ran out of time, not because it
  // ran out of work. That distinction is the early warning that a backlog is forming.
  const seal = await sealExpiredSessions({ limit, budgetMs: slice })
  if (seal.durationMs >= slice) budgetExhausted.push('seal')
  if (seal.sealed) opsLog('cleanup.sessions_sealed', { stage: 'seal', scanned: seal.scanned, processed: seal.sealed, skipped: seal.skipped, failed: seal.failed })

  const settle = await settleSealedSessions({ limit, budgetMs: slice })
  if (settle.durationMs >= slice) budgetExhausted.push('settle')
  if (settle.settled) opsLog('cleanup.sessions_settled', { stage: 'settle', scanned: settle.scanned, processed: settle.settled, skipped: settle.skipped, failed: settle.failed })

  // Only now — after settlement has counted what it needed.
  const reservations = await releaseStaleReservations({ limit, budgetMs: slice })
  if (reservations.durationMs >= slice) budgetExhausted.push('reservations')

  for (const stage of budgetExhausted) {
    opsLog('cleanup.budget_exhausted', { stage, budgetMs: slice })
  }
  if (seal.failed || settle.failed || reservations.failed) {
    opsLog('cleanup.session_failed', {
      failed: seal.failed + settle.failed + reservations.failed,
    })
  }

  const durationMs = Date.now() - startedAt
  opsLog('cleanup.completed', {
    durationMs,
    processed: seal.sealed + settle.settled + reservations.released,
    failed:    seal.failed + settle.failed + reservations.failed,
  })

  return { seal, settle, reservations, budgetExhausted, durationMs }
}

// ─── Operational metrics (MC-06D) ─────────────────────────────────────────────

export interface SessionMetrics {
  activeSessions:   number
  sealedSessions:   number
  settledSessions:  number
  /** ACTIVE and already past expiry — the backlog awaiting the next sweep. */
  expiredActive:    number
  /** SEALED but not yet SETTLED. Credits are held and owed a resolution. */
  pendingSettlement: number
  /** MC-06F: removed from the settlement queue. Each one needs an operator. */
  quarantined:       number
}

/**
 * A point-in-time picture of the session estate.
 *
 * READ ONLY — deliberately does not run the sweep. An operator opening a status page must not
 * trigger settlement as a side effect of looking; the scheduler owns execution.
 *
 * `expiredActive` and `pendingSettlement` are the two numbers worth alerting on: both should
 * hover near zero, and either climbing steadily means the scheduler has stopped.
 */
export async function sessionMetrics(): Promise<SessionMetrics> {
  const [activeSessions, sealedSessions, settledSessions, expiredActive, quarantined] =
    await Promise.all([
      sessionRepo.countByStatus('ACTIVE'),
      sessionRepo.countByStatus('SEALED'),
      sessionRepo.countByStatus('SETTLED'),
      sessionRepo.countExpiredActive(),
      sessionRepo.countQuarantined(),
    ])
  return {
    activeSessions, sealedSessions, settledSessions, expiredActive, quarantined,
    // Quarantined sessions are SEALED but no longer queued, so they are not 'pending'.
    pendingSettlement: Math.max(0, sealedSessions - quarantined),
  }
}
