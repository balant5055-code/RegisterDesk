// GET /api/admin/media-credits/reconciliation
//
// What the reconciler would find right now. ADMIN ONLY, READ ONLY.
//
// This deliberately does NOT run the drains. An admin opening a status page must not
// silently trigger payouts as a side effect of looking — the scheduler owns execution, and
// `POST /api/cron/media-credit-reconciliation` is the single place it happens.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import * as purchaseRepo from '@/features/media-credits/repositories/purchaseRepo'
import * as refundRepo from '@/features/media-credits/repositories/refundRepo'
import { detectOrphans, STUCK_REFUND_ATTEMPTS } from '@/features/media-credits/services/reconciliation'
import { sessionMetrics } from '@/features/media-credits/services/sessionCleanupService'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const [pendingGrants, approvedRefunds, orphans, sessions] = await Promise.all([
    purchaseRepo.listPendingReconciliations(100),
    refundRepo.listByStatus('approved', 100),
    detectOrphans(100),
    // MC-06D: the session estate, surfaced alongside the other reclamation queues so one
    // page answers 'is anything owed and is the scheduler keeping up'.
    sessionMetrics(),
  ])

  return NextResponse.json({
    // Captured payments whose credits have not been granted. Each is a debt to an organizer.
    pendingGrants: {
      count: pendingGrants.length,
      items: pendingGrants.map(r => ({
        purchaseId: r.purchaseId, organizerUid: r.organizerUid,
        credits: r.credits, attempts: r.attempts, lastError: r.lastError,
      })),
    },
    // Refunds whose credits are gone but whose payout has not completed.
    pendingRefundPayouts: {
      count: approvedRefunds.length,
      items: approvedRefunds.map(r => ({
        refundId: r.refundId, organizerUid: r.organizerUid,
        refundAmountPaise: r.refundAmountPaise,
        attempts: r.gatewayAttempts, lastError: r.gatewayError,
      })),
    },
    // Records no drain will pick up. A non-empty list means an assumption broke.
    orphans,
    // Upload sessions. `expiredActive` and `pendingSettlement` should both sit near zero;
    // either climbing steadily means the session scheduler has stopped running.
    sessions,
    stuckAfterAttempts: STUCK_REFUND_ATTEMPTS,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
