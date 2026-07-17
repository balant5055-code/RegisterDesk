// Settlement-hold reconciliation after a refund reduces an organizer's
// available revenue balance below the amount reserved for open settlement
// requests. Server-only.
//
// Background: a settlement request places a hold on the wallet's inTransitPaise
// (NOT availablePaise). A refund reversal debits availablePaise; the wallet
// invariant fix clamps inTransitPaise back to <= availablePaise so freeBalance
// can never go negative. But that clamp leaves the underlying pending/approved
// settlement REQUESTS unbacked. This module rejects the now-unbacked requests
// and rebuilds inTransitPaise from exactly the surviving holds, so the field
// stays consistent with the request set.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { logAdminAction } from '@/lib/admin/audit'
import type { OrganizerRevenueWallet }     from '@/lib/fees/types'
import type { SettlementRequestDoc }       from './types'

const AUTO_REJECT_NOTE =
  'Auto-rejected: available balance fell below the reserved amount after a refund.'

interface RejectedHold { id: string; amountPaise: number }

function requestedAtMillis(d: SettlementRequestDoc): number {
  const t = d.requestedAt as { toMillis?: () => number } | null
  return t && typeof t.toMillis === 'function' ? t.toMillis() : 0
}

/**
 * Recomputes settlement holds for an organizer against the wallet's CURRENT
 * availablePaise. Open `reserved` requests (pending/approved) are kept in
 * priority order — approved first, then oldest — while their cumulative amount
 * fits within availablePaise; any that no longer fit are marked `rejected`.
 * `inTransitPaise` is then SET to the sum of surviving holds (always
 * <= availablePaise), keeping the field authoritative and idempotent.
 *
 * Runs in a single transaction (reads wallet + open requests before any write),
 * so it is consistent under concurrency with admin approve/reject/paid (which
 * also write the wallet doc) — a conflicting change forces a retry. Best-effort
 * by contract: the wallet invariant is already guaranteed by the caller's clamp,
 * so a failure here leaves the system safe (just an unbacked request that the
 * paid-time guard will refuse), never inconsistent.
 *
 * Returns the rejected requests so the caller can emit audit entries.
 */
export async function reconcileSettlementHoldsAfterRefund(
  organizerUid: string,
): Promise<{ organizerUid: string; rejected: RejectedHold[] }> {
  const walletRef = adminDb.doc(`organizerRevenueWallets/${organizerUid}`)

  const rejected = await adminDb.runTransaction<RejectedHold[]>(async tx => {
    // ── reads (all before writes) ──
    const walletSnap = await tx.get(walletRef)
    if (!walletSnap.exists) return []
    const available = (walletSnap.data() as OrganizerRevenueWallet).availablePaise

    const reqSnap = await tx.get(
      adminDb.collection('settlementRequests')
        .where('organizerUid', '==', organizerUid)
        .where('status', 'in', ['pending', 'approved']),
    )

    // Only `reserved` requests contribute to inTransitPaise; legacy pre-fix
    // requests never placed a hold and are left untouched.
    const holds = reqSnap.docs
      .map(d => ({ ref: d.ref, id: d.id, data: d.data() as SettlementRequestDoc }))
      .filter(x => x.data.reserved === true)
      .sort((a, b) => {
        const pa = a.data.status === 'approved' ? 0 : 1
        const pb = b.data.status === 'approved' ? 0 : 1
        if (pa !== pb) return pa - pb                       // approved before pending
        return requestedAtMillis(a.data) - requestedAtMillis(b.data)  // then oldest first
      })

    // ── decide survivors vs. rejects, greedily filling availablePaise ──
    let keptTotal = 0
    const rejects: RejectedHold[] = []
    for (const h of holds) {
      if (keptTotal + h.data.amountPaise <= available) {
        keptTotal += h.data.amountPaise
      } else {
        rejects.push({ id: h.id, amountPaise: h.data.amountPaise })
        tx.update(h.ref, {
          status:    'rejected',
          adminNote: AUTO_REJECT_NOTE,
          updatedAt: FieldValue.serverTimestamp(),
        })
      }
    }

    // ── inTransitPaise becomes exactly the sum of surviving holds (<= available) ──
    tx.update(walletRef, {
      inTransitPaise: keptTotal,
      updatedAt:      FieldValue.serverTimestamp(),
    })

    return rejects
  })

  // Audit each auto-rejection (fire-and-forget, matching the codebase pattern).
  for (const r of rejected) {
    void logAdminAction({
      adminUid:   'system',
      action:     'settlement.rejected',
      entityType: 'settlement',
      entityId:   r.id,
      metadata:   { organizerUid, amountPaise: r.amountPaise, reason: 'refund_insufficient_funds', auto: true },
    }).catch(err => captureFinancialError(err, { scope: 'reconcileSettlementHolds.audit_failed', settlementId: r.id }))
  }

  return { organizerUid, rejected }
}
