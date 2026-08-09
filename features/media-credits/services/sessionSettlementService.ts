// MC-06C · Session settlement — SERVER ONLY.
//
// Completes the lifecycle: ACTIVE → SEALED → SETTLED (Architecture Spec v1.0 §6, §10).
//
// ═══ SETTLEMENT IS THE ONLY PLACE CREDITS ARE CONSUMED ═══════════════════════
// A ten-thousand-photo upload produces ONE wallet write and ONE ledger entry, both here.
// Nothing on the per-photo path touches financial state — that is the entire point of the
// session architecture, and the reason the measured contention disappears.
//
// ═══ WHY THE COUNT IS OUTSIDE THE TRANSACTION ════════════════════════════════
// Firestore forbids aggregation queries inside a transaction, so the consumed-slot count
// must be taken before the settling transaction opens. That is safe ONLY because the session
// is already SEALED: the seal barrier in `consumeInTx` means no slot can move to `consumed`
// after the seal, so the number cannot change between the count and the commit.
//
// Seal → count → settle is therefore not three steps for convenience. It is the minimum
// number of steps that makes the count provably exact.

import { adminDb } from '@/lib/firebase/admin'
import * as sessionRepo from '@/features/media-credits/repositories/sessionRepo'
import * as reservationRepo from '@/features/media-credits/repositories/reservationRepo'
import { settleSessionInTx } from '@/features/media-credits/services'
import { InvalidCreditOperationError } from '@/features/media-credits/errors'
import { opsLog } from '@/features/media-credits/utils/opsLog'
import type { CreditSessionDto } from '@/features/media-credits/types'
import { toDto } from '@/features/media-credits/services/sessionService'

/** Recorded as the actor on a settlement. Settlement is always machine-initiated. */
export const SETTLEMENT_ACTOR = 'system'

/**
 * Failed settlement attempts before a session is removed from the queue.
 *
 * MC-06E measured the failure this prevents: `listSealed` is ordered oldest-first, so a
 * session that can never settle sits at the head and consumes the batch limit on every pass,
 * starving every other organizer behind it. Quarantine is therefore not about the broken
 * session — it is about the queue.
 *
 * Five, matching `STUCK_REFUND_ATTEMPTS`: generous enough that a transient outage is retried
 * several times, small enough that a genuine poison pill is out of the way within an hour at
 * the 10-minute cadence.
 */
export const MAX_SETTLEMENT_ATTEMPTS = 5

export interface SettleResult {
  sessionId:       string
  /** Slots that actually landed. Excludes held, released and never-claimed. */
  consumedSlots:   number
  creditsConsumed: number
  creditsReleased: number
  /** Null when nothing was consumed — a zero movement writes no ledger entry. */
  entryId:         string | null
  /** False when this call found the session already settled. */
  settled:         boolean
  session:         CreditSessionDto
}

/**
 * Settles ONE sealed session.
 *
 * Idempotent by two independent guards, both read inside the transaction:
 *   1. the session's own status — two settlements serialise on that document, and the second
 *      observes SETTLED;
 *   2. the deterministic ledger entry id, which `tx.create` refuses to duplicate.
 *
 * The first is the stronger guard and the one a zero-consumption settlement relies on, since
 * that case writes no ledger entry at all.
 *
 * Throws if the session is still ACTIVE: settling an unsealed session would count a moving
 * target. The caller must seal first.
 */
export async function settleSession(sessionId: string): Promise<SettleResult> {
  const preRead = await sessionRepo.read(sessionId)
  if (!preRead) throw new InvalidCreditOperationError(`unknown session ${sessionId}`)

  // Fast-path replay. The in-transaction check below is still the authority; this only
  // avoids an aggregation query and a transaction for an obvious repeat.
  if (preRead.status === 'SETTLED') {
    return alreadySettled(preRead)
  }
  if (preRead.status !== 'SEALED') {
    throw new InvalidCreditOperationError(
      `session ${sessionId} must be SEALED before settlement (is ${preRead.status})`,
    )
  }

  // ── The count (outside any transaction; stable because the session is sealed) ──
  const consumedSlots = await reservationRepo.countConsumedBySession(sessionId)

  // ── THE transaction ──
  const outcome = await adminDb.runTransaction(async tx => {
    // ── reads ──
    const session = await sessionRepo.readInTx(tx, sessionId)
    if (!session) throw new InvalidCreditOperationError(`unknown session ${sessionId}`)

    // Re-checked inside the transaction: a concurrent settlement may have committed between
    // the pre-read and here, and this is the guard that makes that a no-op rather than a
    // second debit.
    if (session.status === 'SETTLED') return null
    if (session.status !== 'SEALED') {
      throw new InvalidCreditOperationError(
        `session ${sessionId} must be SEALED before settlement (is ${session.status})`,
      )
    }

    const movement = await settleSessionInTx(tx, {
      session, consumedSlots, actorUid: SETTLEMENT_ACTOR,
    })

    // ── writes ──
    sessionRepo.markSettledInTx(tx, sessionId, consumedSlots, movement.entryId)
    return movement
  })

  if (outcome === null) {
    // Lost the race. The winner's result is the truth.
    const settled = await sessionRepo.read(sessionId)
    return alreadySettled(settled!)
  }

  const settled = await sessionRepo.read(sessionId)
  return {
    sessionId,
    consumedSlots,
    creditsConsumed: outcome.creditsConsumed,
    creditsReleased: Math.max(0, preRead.allocatedCredits - outcome.creditsConsumed),
    entryId:  outcome.entryId,
    settled:  true,
    session:  toDto(settled!),
  }
}

function alreadySettled(session: Parameters<typeof toDto>[0]): SettleResult {
  const consumedSlots   = session.consumedSlots ?? 0
  const creditsConsumed = consumedSlots * session.creditsPerPhotoAtOpen
  return {
    sessionId:       session.sessionId,
    consumedSlots,
    creditsConsumed,
    creditsReleased: Math.max(0, session.allocatedCredits - creditsConsumed),
    entryId:         session.settlementEntryId,
    settled:         false,        // this call did not do the settling
    session:         toDto(session),
  }
}

export interface SettlementSweepReport {
  scanned:  number
  settled:  number
  /** Already settled when reached — a benign race, not a failure. */
  skipped:  number
  failed:   number
  /** MC-06F: removed from the queue this pass after repeated failures. */
  quarantined: number
  creditsConsumed: number
  creditsReleased: number
  durationMs: number
}

export interface SettlementSweepParams {
  limit?:    number
  budgetMs?: number
}

/**
 * Settles every sealed session awaiting one.
 *
 * Per-session transactions and per-session try/catch: one poisoned session must not strand
 * the credits of every other organizer behind it. A failure is counted and retried on the
 * next pass, which is safe because settlement is idempotent.
 */
export async function settleSealedSessions(
  params?: SettlementSweepParams,
): Promise<SettlementSweepReport> {
  const startedAt = Date.now()
  const limit     = params?.limit    ?? 200
  const budgetMs  = params?.budgetMs ?? 30_000

  const report: SettlementSweepReport = {
    scanned: 0, settled: 0, skipped: 0, failed: 0, quarantined: 0,
    creditsConsumed: 0, creditsReleased: 0, durationMs: 0,
  }

  const sealed = await sessionRepo.listSealed(limit)
  for (const session of sealed) {
    if (Date.now() - startedAt > budgetMs) break   // yield; the next tick resumes
    report.scanned++
    try {
      const result = await settleSession(session.sessionId)
      if (result.settled) {
        report.settled++
        report.creditsConsumed += result.creditsConsumed
        report.creditsReleased += result.creditsReleased
      } else {
        report.skipped++
      }
    } catch (err) {
      report.failed++
      // ── MC-06F: poison-session protection ──
      // Count the failure and, past the threshold, take the session OUT of the queue so it
      // stops blocking everyone behind it. The session stays SEALED and still owed a
      // resolution — quarantine defers it to an operator, it does not resolve it.
      const attempts = (session.settlementAttempts ?? 0) + 1
      const quarantine = attempts >= MAX_SETTLEMENT_ATTEMPTS
      if (quarantine) {
        report.quarantined++
        opsLog('session.quarantined', {
          sessionId: session.sessionId,
          reason: err instanceof Error ? err.message.slice(0, 200) : 'settlement_failed',
        })
      }
      await sessionRepo.recordSettlementFailure(session.sessionId, attempts, quarantine)
        .catch(recErr => {
          // If even the bookkeeping fails the session simply retries next pass — the counter
          // not advancing is safer than losing the failure entirely.
          console.error(`[media-credits/settlement] attempt bookkeeping failed for ${session.sessionId}:`, recErr)
        })
      console.error(
        `[media-credits/settlement] failed for ${session.sessionId} (attempt ${attempts}):`, err,
      )
    }
  }

  report.durationMs = Date.now() - startedAt
  return report
}
