// MC-04 · Grant reconciliation — SERVER ONLY. Service only; NO scheduler.
//
// ═══ WHAT THIS EXISTS FOR ════════════════════════════════════════════════════
// Exactly one failure: Razorpay captured an organizer's money and the Firestore grant
// transaction did not commit. The purchase parks at `paid` and `completePurchase` writes a
// reconciliation record naming the debt. This module pays it.
//
// Without a drain, that record is write-only — evidence of a debt with no mechanism to
// settle it. With it, settling is a single scheduled call.
//
// ═══ WIRED IN MC-05 ══════════════════════════════════════════════════════════
// `/api/cron/media-credit-reconciliation` calls `runReconciliation`, which drains BOTH
// queues: captured-but-not-granted purchases and approved-but-not-paid refunds. MC-04 left
// the grant drain dormant; it no longer is.
//
// ═══ WHY RETRYING IS SAFE ════════════════════════════════════════════════════
// The grant is idempotent on `purchase:{purchaseId}`. A drain that runs twice, races another
// drain, or races a late client retry cannot double-grant: the second writer finds the
// ledger entry already present and no-ops. That property is what makes an unattended retry
// loop acceptable around money at all.

import { adminDb } from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import * as purchaseRepo from '@/features/media-credits/repositories/purchaseRepo'
import * as refundRepo from '@/features/media-credits/repositories/refundRepo'
import { creditInTx, getCreditPolicy } from '@/features/media-credits/services'
import { RefundSettlementDeferredError } from '@/features/media-credits/errors'
import { rejectRefund, settleApprovedRefund } from '@/features/media-credits/services/refundService'

/** Recorded as the actor on a drain-initiated grant, distinguishing it from a live purchase. */
export const RECONCILIATION_ACTOR = 'system'

export interface ReconciliationReport {
  scanned:  number
  resolved: number
  failed:   number
  /** MC-05.6A: claimed by another caller mid-pass. Working as designed, not a failure. */
  skipped:  number
  durationMs: number
}

export interface ReconciliationParams {
  limit?:    number
  budgetMs?: number
}

/**
 * Grants credits for every captured payment whose original transaction failed.
 *
 * Per-item transactions and per-item try/catch, deliberately: one poisoned record must not
 * strand the rest of the queue. A failure is counted, left `pending`, and retried next run.
 */
export async function retryPendingGrants(
  params?: ReconciliationParams,
): Promise<ReconciliationReport> {
  const startedAt = Date.now()
  const limit     = params?.limit    ?? 100
  const budgetMs  = params?.budgetMs ?? 30_000

  const report: ReconciliationReport = { scanned: 0, resolved: 0, failed: 0, skipped: 0, durationMs: 0 }

  const pending = await purchaseRepo.listPendingReconciliations(limit)
  for (const rec of pending) {
    if (Date.now() - startedAt > budgetMs) break   // yield; the next tick resumes
    report.scanned++
    try {
      await adminDb.runTransaction(async tx => {
        await creditInTx(tx, {
          organizerUid: rec.organizerUid,
          // The SAME entryId the live path would have used. This is the whole idempotency
          // story: if the original transaction actually did commit before failing to
          // respond, this finds the entry and grants nothing.
          entryId:      `purchase:${rec.purchaseId}`,
          credits:      rec.credits,
          reason:       'purchase',
          actorUid:     RECONCILIATION_ACTOR,
          actorKind:    'system',
          purchaseId:   rec.purchaseId,
        })
        purchaseRepo.markGrantedInTx(tx, rec.purchaseId, rec.gatewayPaymentId, rec.credits)
      })
      await purchaseRepo.markReconciled(rec.gatewayOrderId)
      report.resolved++
    } catch (err) {
      report.failed++
      captureFinancialError(err, {
        scope: 'media_credits.reconciliation_retry_failed', purchaseId: rec.purchaseId,
      })
    }
  }

  report.durationMs = Date.now() - startedAt
  return report
}

// ─── Refund settlement drain (MC-05) ──────────────────────────────────────────

/**
 * Pays out every refund stuck at `approved` — credits already debited, money not yet sent.
 *
 * ═══ WHAT IT PICKS UP, AND WHAT IT DELIBERATELY DOES NOT ════════════════════
 *   • `approved`              — awaiting a payout. Claimed here, then settled.
 *   • `settling`, STALE       — a holder crashed after claiming. The claim is re-taken.
 *   • `settling`, FRESH       — SKIPPED. Someone is mid-payout right now.
 *
 * That last exclusion is load-bearing (MC-05.6A). Retrying a live claim is precisely the
 * admin-approves-while-the-cron-runs race that could issue two real refunds. The scheduler
 * only ever touches claims old enough that their holder must be gone.
 *
 * Safe to run repeatedly — the claim admits one caller, and beneath it `refundPayment` still
 * asks Razorpay whether a refund tagged with this refundId already exists and adopts it. A
 * crash between "gateway paid" and "Firestore updated" self-heals on a later tick.
 *
 * A refund whose settlement fails again returns to `approved` with `gatewayAttempts`
 * incremented, so a persistently broken one is visible rather than silently retried forever.
 */
export async function retryPendingRefunds(
  params?: ReconciliationParams,
): Promise<ReconciliationReport> {
  const startedAt = Date.now()
  const limit     = params?.limit    ?? 100
  const budgetMs  = params?.budgetMs ?? 30_000

  const report: ReconciliationReport = { scanned: 0, resolved: 0, failed: 0, skipped: 0, durationMs: 0 }

  const [awaiting, abandoned] = await Promise.all([
    refundRepo.listByStatus('approved', limit),
    refundRepo.listStaleSettling(limit),
  ])
  // Deduplicated by id: a row cannot be in both lists, but the reads are not simultaneous
  // and a refund released between them would otherwise be settled twice in one pass.
  const seen = new Set<string>()
  const queue = [...awaiting, ...abandoned].filter(r => {
    if (seen.has(r.refundId)) return false
    seen.add(r.refundId)
    return true
  })

  for (const refund of queue) {
    if (Date.now() - startedAt > budgetMs) break
    report.scanned++
    try {
      await settleApprovedRefund(refund.refundId)
      report.resolved++
    } catch (err) {
      // A refund claimed by someone else between the query and now is a SKIP, not a failure.
      // It is the claim working as designed — the other caller is paying it. Counting it as
      // a failure would raise a financial alert every time an admin approves while the cron
      // happens to be running.
      if (err instanceof RefundSettlementDeferredError && err.cause === 'settlement_in_progress') {
        report.skipped++
        continue
      }
      // Counted, never thrown — one unpayable refund must not strand the rest of the queue.
      report.failed++
      captureFinancialError(err, {
        scope: 'media_credits.refund_retry_failed', refundId: refund.refundId,
      })
    }
  }

  report.durationMs = Date.now() - startedAt
  return report
}

// ─── Orphan detection ─────────────────────────────────────────────────────────

export interface OrphanReport {
  /** Purchases parked at `paid` with NO reconciliation record naming the debt. */
  unrecordedPaidPurchases: string[]
  /** Refunds at `approved` whose payout has failed repeatedly. */
  stuckRefunds:            string[]
}

/** Attempts above which a refund is reported as stuck rather than merely retrying. */
export const STUCK_REFUND_ATTEMPTS = 5

/**
 * Finds financial records that no drain will ever pick up.
 *
 * DETECTION ONLY — it repairs nothing and mutates nothing. An orphan means an assumption
 * broke, and the right response is a human looking at it, not an automated write built on
 * the same assumption that already failed.
 */
export async function detectOrphans(limit = 100): Promise<OrphanReport> {
  const [paidPurchases, approvedRefunds] = await Promise.all([
    purchaseRepo.listByStatus('paid', limit),
    refundRepo.listByStatus('approved', limit),
  ])

  const pending = await purchaseRepo.listPendingReconciliations(limit)
  const claimed = new Set(pending.map(r => r.purchaseId))

  return {
    // A `paid` purchase is money captured without credits granted. It is only recoverable if
    // a reconciliation record exists; without one, nothing will ever retry it.
    unrecordedPaidPurchases: paidPurchases
      .filter(p => !claimed.has(p.purchaseId))
      .map(p => p.purchaseId),
    stuckRefunds: approvedRefunds
      .filter(r => r.gatewayAttempts >= STUCK_REFUND_ATTEMPTS)
      .map(r => r.refundId),
  }
}

// ─── The scheduled entry point ────────────────────────────────────────────────

export interface FullReconciliationReport {
  grants:  ReconciliationReport
  refunds: ReconciliationReport
  orphans: OrphanReport
  /** MC-12.1 · Stale requests declined automatically. Moves no money. */
  autoRejected: AutoRejectReport
  durationMs: number
}

/**
 * Everything the scheduler runs, in one call.
 *
 * Grants before refunds, deliberately: a grant owes an organizer credits they have already
 * paid for, so it is the more urgent debt, and it should not be starved by a long refund
 * queue when the time budget runs out. Each drain gets its own share of the budget.
 *
 * Idempotent end to end — running it twice concurrently grants nothing twice and pays
 * nothing twice.
 */
export async function runReconciliation(
  params?: ReconciliationParams,
): Promise<FullReconciliationReport> {
  const startedAt = Date.now()
  const limit     = params?.limit    ?? 100
  const budgetMs  = params?.budgetMs ?? 30_000
  const half      = Math.floor(budgetMs / 2)

  const grants  = await retryPendingGrants({ limit, budgetMs: half })
  const refunds = await retryPendingRefunds({
    limit,
    // Whatever the grant drain did not use, floored so a slow grant pass cannot leave the
    // refund pass with a negative budget that would skip it entirely.
    budgetMs: Math.max(5_000, budgetMs - (Date.now() - startedAt)),
  })
  const orphans = await detectOrphans(limit)
  // MC-12.1 · Moves no money — see autoRejectStaleRefunds. Runs last so a slow sweep can
  // never delay the two passes that DO settle money.
  const autoRejected = await autoRejectStaleRefunds({ limit })

  return { grants, refunds, orphans, autoRejected, durationMs: Date.now() - startedAt }
}

// ─── MC-12.1 · Auto-rejecting stale refund requests ───────────────────────────

export interface AutoRejectReport {
  /** False when `refundAutoRejectDays` is 0 — the feature is off and nothing was scanned. */
  enabled:   boolean
  scanned:   number
  rejected:  number
  failed:    number
  thresholdDays: number
}

/**
 * The note recorded against an automatic rejection.
 *
 * Fixed wording, because the audit trail must make it unmistakable that no human decided
 * this. An admin reading `decisionNote` months later needs to know whether to go looking for
 * whoever pressed the button.
 */
export const AUTO_REJECT_NOTE =
  'Automatically declined: this request was not reviewed within the configured window.'

/**
 * Rejects `requested` refunds older than `refundAutoRejectDays`.
 *
 * ═══ WHY THIS IS SAFE TO AUTOMATE ════════════════════════════════════════════
 * Rejection is the ONE refund transition that moves no money: `rejectRefund` touches no
 * wallet and no ledger, and its own header says so. The organizer keeps their credits. So an
 * automatic rejection cannot cost anybody anything — which is exactly why the reverse,
 * automatic APPROVAL, is not offered at any price.
 *
 * ═══ REUSE, NOT A SECOND PATH ════════════════════════════════════════════════
 * It calls `refundService.rejectRefund` — the same function the admin's Reject button calls,
 * with the same transaction and the same replay guard. The only difference is the actor.
 */
export async function autoRejectStaleRefunds(
  params?: { limit?: number },
): Promise<AutoRejectReport> {
  const policy = await getCreditPolicy()
  const thresholdDays = policy.refundAutoRejectDays

  // 0 disables it. Reported rather than silently skipped, so an operator reading the cron's
  // output can tell "switched off" from "found nothing".
  if (!Number.isFinite(thresholdDays) || thresholdDays <= 0) {
    return { enabled: false, scanned: 0, rejected: 0, failed: 0, thresholdDays: 0 }
  }

  const limit  = params?.limit ?? 100
  const cutoff = Date.now() - thresholdDays * 86_400_000

  const pending = await refundRepo.listByStatus('requested', limit)
  const stale   = pending.filter(r => {
    const created = r.createdAt && typeof r.createdAt === 'object' && 'toMillis' in r.createdAt
      ? (r.createdAt as { toMillis(): number }).toMillis()
      : 0
    // A refund with no readable timestamp is left alone. Guessing its age and rejecting it
    // would be worse than leaving it for a human.
    return created > 0 && created < cutoff
  })

  let rejected = 0, failed = 0
  for (const r of stale) {
    try {
      // Same state machine, same guards. A refund an admin decided a moment ago is already
      // out of `requested` and this is a no-op.
      await rejectRefund({
        refundId: r.refundId,
        adminUid: RECONCILIATION_ACTOR,
        note:     AUTO_REJECT_NOTE,
      })
      rejected++
    } catch (err) {
      // One bad record must not stop the sweep. The next tick retries it.
      failed++
      console.error('[media-credits/auto-reject] failed:', r.refundId, err)
    }
  }

  return { enabled: true, scanned: pending.length, rejected, failed, thresholdDays }
}
