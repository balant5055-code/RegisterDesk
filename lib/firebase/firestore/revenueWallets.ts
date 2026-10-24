// Organizer revenue wallet — tracks net revenue owed per organizer.
// Separate from organizerWallets (which is the existing comms billing debit wallet).

import { FieldValue }  from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import type { OrganizerRevenueWallet } from '@/lib/fees/types'
import { writeClawbackOnShortfall, logClawbackEvent } from '@/lib/clawbacks/clawbackService'
import type { ClawbackReason, ClawbackSourceType } from '@/lib/clawbacks/types'

// Returned by debitRevenueWallet so callers can detect insolvency.
export interface WalletDebitResult {
  debited: number   // total paise actually removed
  fromPending:   number
  fromAvailable: number
}

function walletsCol() {
  return adminDb.collection('organizerRevenueWallets')
}

// Pure debit plan: pendingPaise is depleted first, remainder from availablePaise.
// `totalDebited < netSettlementPaise` indicates an insolvent wallet. Shared by
// debitRevenueWallet and the atomic ledger-reversal-and-debit path so the bucket
// routing logic lives in exactly one place.
export interface WalletDebitPlan {
  fromPending:   number
  fromAvailable: number
  totalDebited:  number
}

export function computeWalletDebit(
  wallet:             Pick<OrganizerRevenueWallet, 'pendingPaise' | 'availablePaise'>,
  netSettlementPaise: number,
): WalletDebitPlan {
  const fromPending   = Math.min(wallet.pendingPaise,   netSettlementPaise)
  const remaining     = netSettlementPaise - fromPending
  const fromAvailable = Math.min(wallet.availablePaise, remaining)
  return { fromPending, fromAvailable, totalDebited: fromPending + fromAvailable }
}

// ─── Reversal of ONE ledger transaction: debit the bucket that holds ITS net ─────────────────
//
// A transaction's net is credited to pendingPaise and moved to availablePaise only by the release
// job, which flips its releaseStatus to 'released' in the same Firestore transaction. So the
// transaction's AUTHORITATIVE releaseStatus says where its net sits:
//   'pending' / 'held' → pendingPaise   (never released; a refund hold keeps it in pending)
//   'released'         → availablePaise
// Anything else (absent on a legacy / corrupt row) is unknown: callers fail closed — no debit.
// The pending-first computeWalletDebit must NOT be used for a reversal: reversing a released
// transaction from pendingPaise consumes the net of OTHER, unreleased transactions, whose release
// then fails (INSUFFICIENT) while availablePaise stays overstated.

export type WalletBucket = 'pending' | 'available'

/** The bucket holding a ledger transaction's net, from its releaseStatus; null = unknown (fail closed). */
export function walletBucketForRelease(releaseStatus: unknown): WalletBucket | null {
  if (releaseStatus === 'released') return 'available'
  if (releaseStatus === 'pending' || releaseStatus === 'held') return 'pending'
  return null
}

/**
 * Pure debit plan for reversing `netPaise` of a transaction whose net sits in `bucket`. Debits ONLY
 * that bucket (clamped at what it holds); a shortfall is reported (`totalDebited < netPaise`) for the
 * caller's existing clawback path — it is never taken from the other bucket.
 */
export function computeReversalDebit(
  wallet:   Pick<OrganizerRevenueWallet, 'pendingPaise' | 'availablePaise'>,
  netPaise: number,
  bucket:   WalletBucket,
): WalletDebitPlan {
  const held = Math.max(0, (bucket === 'pending' ? wallet.pendingPaise : wallet.availablePaise) ?? 0)
  const take = Math.min(held, Math.max(0, netPaise))
  return bucket === 'pending'
    ? { fromPending: take, fromAvailable: 0, totalDebited: take }
    : { fromPending: 0, fromAvailable: take, totalDebited: take }
}

export async function getRevenueWallet(
  organizerUid: string,
): Promise<OrganizerRevenueWallet | null> {
  const snap = await walletsCol().doc(organizerUid).get()
  if (!snap.exists) return null
  return snap.data() as OrganizerRevenueWallet
}

// The merge payload that credits a successful payment's net settlement into the
// organizer revenue wallet. Shared by creditRevenueWallet (standalone set) and
// recordPlatformTransactionAndCredit (atomic tx.set inside the ledger
// transaction), so bucket routing lives in exactly one place.
// FieldValue.increment(0) initialises absent buckets to 0 on first write without
// overwriting existing values on subsequent writes.
export function buildRevenueCreditUpdate(
  organizerUid:       string,
  grossAmountPaise:   number,
  feesTotalPaise:     number,   // platformFeeTotal + gatewayFeeEstimate
  netSettlementPaise: number,
): Record<string, unknown> {
  return {
    organizerUid,
    currency: 'INR'     as const,
    planTier: 'starter' as const,   // Phase 1: all organizers on starter tier

    lifetimeGrossPaise: FieldValue.increment(grossAmountPaise),
    lifetimeFeesPaise:  FieldValue.increment(feesTotalPaise),
    lifetimeNetPaise:   FieldValue.increment(netSettlementPaise),

    // Phase 1: all revenue accumulates in pendingPaise (T+2 release in Phase 3+)
    pendingPaise:   FieldValue.increment(netSettlementPaise),

    // These initialize to 0 on first doc creation; increment(0) is a no-op on existing fields
    availablePaise: FieldValue.increment(0),
    inTransitPaise: FieldValue.increment(0),
    settledPaise:   FieldValue.increment(0),

    updatedAt: FieldValue.serverTimestamp(),
    // lastSettlementAt omitted — absent until first settlement sets it
  }
}

// Atomic credit on successful payment. Safe for concurrent calls — Firestore
// increment is atomic. Prefer recordPlatformTransactionAndCredit for the
// payment path: it makes the ledger write + credit atomic AND idempotent.
export async function creditRevenueWallet(
  organizerUid:       string,
  grossAmountPaise:   number,
  feesTotalPaise:     number,   // platformFeeTotal + gatewayFeeEstimate
  netSettlementPaise: number,
): Promise<void> {
  await walletsCol().doc(organizerUid).set(
    buildRevenueCreditUpdate(organizerUid, grossAmountPaise, feesTotalPaise, netSettlementPaise) as unknown as OrganizerRevenueWallet,
    { merge: true },
  )
  // Phase 3 (Option C) — clawback debt is recovered at RELEASE (lib/settlements/releaseFunds.ts), never here.
}

// Debit on refund. Atomically routes the debit across both balance buckets:
// pendingPaise is depleted first; any remainder comes from availablePaise.
// Returns the amounts debited from each bucket.
// Throws 'WALLET_NOT_FOUND' if the wallet doc does not exist.
// Throws 'WALLET_INSOLVENT' if pendingPaise + availablePaise < netSettlementPaise —
//   the wallet is not silently under-debited in this case.
// When `clawback` context is supplied, an insolvent debit is CLAMPED (debits what
// is available) and the shortfall is persisted as a durable clawback in the same
// transaction — no money loss is left in logs. Without the context the legacy
// throw-on-insolvency contract is preserved.
export interface DebitClawbackContext {
  transactionId: string
  sourceType:    ClawbackSourceType
  sourceId:      string
  reason:        ClawbackReason
}

export async function debitRevenueWallet(
  organizerUid:       string,
  netSettlementPaise: number,
  clawback?:          DebitClawbackContext,
): Promise<WalletDebitResult> {
  const ref = walletsCol().doc(organizerUid)
  let clawbackInfo: { clawbackId: string; outstandingPaise: number } | null = null

  const result = await adminDb.runTransaction(async tx => {
    clawbackInfo = null
    const snap = await tx.get(ref)
    if (!snap.exists) throw new Error('WALLET_NOT_FOUND')

    const wallet = snap.data() as OrganizerRevenueWallet

    const { fromPending, fromAvailable, totalDebited } = computeWalletDebit(wallet, netSettlementPaise)

    if (totalDebited < netSettlementPaise) {
      if (!clawback) {
        captureFinancialError('WALLET_INSOLVENT', {
          scope: 'debitRevenueWallet.insolvent',
          organizerUid, needed: netSettlementPaise,
          pending: wallet.pendingPaise, available: wallet.availablePaise, debited: totalDebited,
        })
        throw new Error('WALLET_INSOLVENT')
      }
      // Clamp + record the shortfall as a recoverable clawback (atomic).
      clawbackInfo = writeClawbackOnShortfall(tx, {
        transactionId:       clawback.transactionId,
        organizerUid,
        sourceType:          clawback.sourceType,
        sourceId:            clawback.sourceId,
        reversalAmountPaise: netSettlementPaise,
        debitedPaise:        totalDebited,
        reason:              clawback.reason,
      })
    }

    const newAvailable = wallet.availablePaise - fromAvailable
    // INVARIANT: inTransitPaise must never exceed availablePaise (mirrors
    // reversePlatformTransactionAndDebit) so freeBalance can never go negative.
    const newInTransit = Math.min(wallet.inTransitPaise ?? 0, newAvailable)

    tx.update(ref, {
      pendingPaise:   wallet.pendingPaise - fromPending,
      availablePaise: newAvailable,
      inTransitPaise: newInTransit,
      updatedAt:      FieldValue.serverTimestamp(),
    })

    return { debited: totalDebited, fromPending, fromAvailable }
  })

  if (clawbackInfo) {
    const info = clawbackInfo as { clawbackId: string; outstandingPaise: number }
    // RD-PHASE4-S4 — awaited (never throws; a failed write is recorded for reconciliation).
    await logClawbackEvent('system', 'clawback.created', info.clawbackId, {
      transactionId: clawback?.transactionId, outstandingPaise: info.outstandingPaise,
    })
  }
  return result
}
