// MC-05 · Refund lifecycle — SERVER ONLY.
//
// Owns the refund state machine. Balance mutation stays with the ledger (`debitInTx`),
// arithmetic stays with `refundMath` (pure), gateway I/O stays with `gatewayRefund`, storage
// stays with `refundRepo`.
//
// ═══ THE STATE MACHINE ═══════════════════════════════════════════════════════
//
//                        reject / cancel  ── releases the hold, moves no money ──
//   requested ─────────────────────────► rejected | cancelled      (terminal)
//       │  ▲
//       │  └─ HOLDS the credits: balance unchanged, `available` down (RD-MC-REFUND-V2-P3)
//       │
//       │ approve  ── ONE transaction: release hold + debit + ledger + lot + decision ──
//       ▼
//    approved ──── gateway payout ────► settled     (terminal; money returned)
//       ▲                                  │
//       └──── retried by the reconciler ───┘
//
// `rejected` and `cancelled` are financially identical and deliberately distinct: one is the
// platform declining, the other the organizer withdrawing. See `CreditRefundStatus`.
//
// ═══ THE SCOPE IS THE PURCHASE'S UNUSED CREDITS ══════════════════════════════
// A refund names a `purchaseId` and returns that purchase's UNSPENT credits at that
// purchase's own frozen unit price.
//
// It was whole-purchase-only until RD-MC-REFUND-V2. The reason was real: the ledger does not
// attribute consumption to a purchase — a `consume` entry carries no `purchaseId` — so
// "50 unused credits" had no defensible price. Phase 1's FIFO credit lots supplied exactly
// that missing attribution (`creditsRemaining` per purchase), Phase 2 priced against it, and
// Phase 3 reserves it so it cannot be spent while the request waits.
//
// Multiple partial refunds of one purchase are therefore normal. What prevents over-refunding
// is `creditsRemaining`, which every approval drains — NOT a rule about how many refunds a
// purchase may have. INVARIANT I7: per purchase, Σ refunded + Σ consumed ≤ credits bought.
//
// ═══ WHY THE GATEWAY CALL IS OUTSIDE THE TRANSACTION ═════════════════════════
// Firestore retries a contended transaction by re-running its body. An external payout
// inside that body could execute more than once. The debit commits first, then the money
// moves; a refund caught between the two sits at `approved` and the reconciler finishes it.
//
// Ordering is deliberate in the organizer's disfavour by design: credits are removed BEFORE
// money is returned. The reverse would let a gateway success plus a Firestore failure leave
// the organizer holding both the credits and the cash.

import { adminDb } from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import * as refundRepo from '@/features/media-credits/repositories/refundRepo'
import * as purchaseRepo from '@/features/media-credits/repositories/purchaseRepo'
import * as lotRepo from '@/features/media-credits/repositories/lotRepo'
import * as walletRepo from '@/features/media-credits/repositories/walletRepo'
import {
  availableCredits, balancesOf, type WalletBalances,
} from '@/features/media-credits/utils/ledgerMath'
import { refundDebitFor } from '@/features/media-credits/utils/creditLots'
import { opsLog } from '@/features/media-credits/utils/opsLog'
import { debitInTx, getCreditPolicy, walletService } from '@/features/media-credits/services'
import { refundPayment } from '@/features/media-credits/services/gatewayRefund'
import { refundAmountFor, refundBaseFor, serviceChargeFor } from '@/features/media-credits/utils/refundMath'
import {
  REFUND_INELIGIBLE_COPY, evaluateRefundEligibility, type RefundIneligibleReason,
} from '@/features/media-credits/utils/refundEligibility'
// MC-11 · every one of these swallows its own failures; see the module header.
import {
  notifyRefundApproved, notifyRefundPaid, notifyRefundRejected, notifyRefundRequested,
  type RefundNotice,
} from '@/features/media-credits/services/refundNotifications'
import {
  CreditsDisabledError, InsufficientCreditsError, InvalidCreditOperationError,
  RefundNotAllowedError, RefundSettlementDeferredError,
} from '@/features/media-credits/errors'
import { CREDIT_REFUND_BLOCKING_STATUSES } from '@/features/media-credits/types'
import type {
  CreditRefundDetailDto, CreditRefundDto, CreditRefundStatus, RefundQuoteDto,
} from '@/features/media-credits/types'

const toMs = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0

/** Resolves the service-charge policy from config. ONE place; never inlined by a caller. */
async function chargePolicy() {
  const m = await getCreditPolicy()
  return {
    method:     m.refundServiceChargeMethod,
    percent:    m.refundServiceChargePercent,
    fixedPaise: m.refundServiceChargeFixedPaise,
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

type RefundDoc = NonNullable<Awaited<ReturnType<typeof refundRepo.read>>>

const toDto = (r: RefundDoc): CreditRefundDto => ({
  refundId:          r.refundId,
  credits:           r.credits,
  reason:            r.reason,
  status:            r.status,
  purchaseId:        r.purchaseId,
  refundAmountPaise: r.refundAmountPaise,
  createdAtMs:       toMs(r.createdAt),
  decidedAtMs:       r.decidedAt ? toMs(r.decidedAt) : null,
})

const toDetailDto = (r: RefundDoc): CreditRefundDetailDto => ({
  ...toDto(r),
  organizerUid:              r.organizerUid,
  purchaseAmountPaise:       r.purchaseAmountPaise,
  // RD-MC-REFUND-V2-P2 · the frozen basis. Backfilled on read for refunds written before P2,
  // where the base WAS the whole purchase amount — the same value, differently named.
  refundBasePaise:           r.refundBasePaise ?? r.purchaseAmountPaise,
  creditsRemainingAtRequest: r.creditsRemainingAtRequest ?? r.credits,
  // RD-MC-REFUND-V2-P3 · pre-P3 refunds were whole-purchase, so the fallback is exact.
  purchaseCreditsAtRequest:  r.purchaseCreditsAtRequest ?? r.credits,
  serviceCharge:             r.serviceCharge,
  unitPricePaise:            r.unitPricePaise,
  creditsPerPhotoAtPurchase: r.creditsPerPhotoAtPurchase,
  currency:                  r.currency,
  refundMethod:              r.refundMethod,
  gatewayRefundId:           r.gatewayRefundId,
  decisionNote:              r.decisionNote,
  walletAtRequest:           r.walletAtRequest,
  settledAtMs:               r.settledAt ? toMs(r.settledAt) : null,
})

/**
 * One refund, tenant-checked.
 *
 * Returns null for another workspace's refund — the same answer as a nonexistent id, so the
 * endpoint cannot be used to discover real ids.
 */
export async function getRefundRequest(
  organizerUid: string, refundId: string,
): Promise<CreditRefundDetailDto | null> {
  const r = await refundRepo.read(refundId)
  if (!r || r.organizerUid !== organizerUid) return null
  return toDetailDto(r)
}

export async function listRefundRequests(
  organizerUid: string, limit: number, cursor?: string | null,
): Promise<{ refunds: CreditRefundDto[]; nextCursor: string | null }> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 100)
  const rows   = await refundRepo.listByOrganizer(organizerUid, capped, cursor)
  return {
    refunds:    rows.map(toDto),
    nextCursor: rows.length === capped ? rows[rows.length - 1].refundId : null,
  }
}

/** Admin queue. Not tenant-scoped by design — the caller must already be a platform admin. */
export async function listByStatus(
  status: CreditRefundStatus, limit: number, cursor?: string | null,
): Promise<{ refunds: CreditRefundDetailDto[]; nextCursor: string | null }> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 100)
  const rows   = await refundRepo.listByStatus(status, capped, cursor)
  return {
    refunds:    rows.map(toDetailDto),
    nextCursor: rows.length === capped ? rows[rows.length - 1].refundId : null,
  }
}

// ─── createRefundRequest ──────────────────────────────────────────────────────

export interface CreateRefundInput {
  organizerUid: string
  purchaseId:   string
  reason:       string
  requestedBy:  string
}

/**
 * Validates a refund request and records it. Moves NO money and touches NO balance.
 *
 * Every check below is server-authoritative and re-run at approval time against the live
 * wallet — this pass exists to reject early and to snapshot the terms the organizer was
 * shown, not to be the only gate.
 */
export async function createRefundRequest(
  input: CreateRefundInput,
): Promise<CreditRefundDetailDto> {
  const policy = await getCreditPolicy()
  if (!policy.creditsEnabled) throw new CreditsDisabledError()
  if (!policy.refundsEnabled) throw new RefundNotAllowedError('refunds_disabled')

  const reason = input.reason.trim()
  // MC-11 · mandatory-ness is now policy. The 3-character floor stays whenever a reason IS
  // required — a one-letter reason explains nothing to whoever reviews it.
  if (policy.refundReasonRequired && reason.length < 3) {
    throw new InvalidCreditOperationError('a refund reason is required')
  }

  // ── Ownership ──
  const purchase = await purchaseRepo.read(input.purchaseId)
  if (!purchase || purchase.organizerUid !== input.organizerUid) {
    // Same answer for "not yours" and "does not exist".
    throw new RefundNotAllowedError('purchase_not_found')
  }

  const blocking = await refundRepo.findBlockingForPurchase(input.purchaseId)
  const wallet   = await walletService.getBalance(input.organizerUid)

  // ── RD-MC-REFUND-V2-P2 · how much of THIS purchase is unused ──────────────
  // The lot, never the wallet. A balance pools every purchase and every grant together and so
  // cannot say which credits belong to this purchase; the lot is the only thing that can.
  const remaining = (await lotRepo.readRemainingForPurchases([purchase.purchaseId]))
    .get(purchase.purchaseId) ?? 0

  // ── Money — computed BEFORE eligibility, because two thresholds are money-shaped ──
  // Priced at the PURCHASE's own unit price, so a wallet holding 500 credits bought at ₹1 and
  // 500 bought at ₹2 refunds each at what was actually paid for it.
  const refundBasePaise   = refundBaseFor(remaining, purchase.unitPricePaise)
  const charge            = serviceChargeFor(refundBasePaise, await chargePolicy())
  const refundAmountPaise = refundAmountFor(refundBasePaise, charge)

  // ── MC-11 · ONE rule set, shared with the organizer's dashboard ──
  // These checks used to live inline here. They now live in `evaluateRefundEligibility` so
  // the button the organizer sees and the guard that runs are the same rules — a dashboard
  // offering a refund the server then refuses is worse than no button at all.
  const verdict = evaluateRefundEligibility({
    refundsEnabled:           policy.refundsEnabled,
    refundWindowDays:         policy.refundWindowDays,
    minRefundablePaise:       policy.minRefundablePaise,
    minRefundCredits:         policy.minRefundCredits,
    maxRefundPerRequestPaise: policy.maxRefundPerRequestPaise,
    purchaseStatus:           purchase.status,
    creditsRemaining:         remaining,
    grantedAtMs:              purchase.grantedAt ? toMs(purchase.grantedAt) : 0,
    availableCredits:         wallet.available,
    blockingRefundStatus:     blocking?.status ?? null,
    // RD-MC-REFUND-V2-P3 · read only when it can change the answer. A purchase with credits
    // left is refundable regardless of its refund history, so the query is skipped entirely
    // on the common path.
    hasSettledRefund:         remaining > 0
      ? false
      : await refundRepo.hasSettledRefund(purchase.purchaseId),
    refundAmountPaise,
    nowMs:                    Date.now(),
  })
  if (!verdict.eligible) {
    // `credits_held` keeps its own error type: it is the only refusal that carries numbers a
    // caller may want (needed vs available), and MC-05's callers already distinguish it.
    //
    // P2 note: `no_unused_credits` deliberately does NOT use it. Nothing is short there —
    // there is simply nothing to refund, and reporting it as an insufficiency would tell the
    // organizer to top up when topping up would not help.
    if (verdict.reason === 'credits_held') {
      throw new InsufficientCreditsError(remaining, wallet.available)
    }
    throw new RefundNotAllowedError(verdict.reason)
  }

  // ══ RD-MC-REFUND-V2-P3 · THE transaction: the request and its hold, together ══
  //
  // Everything above is a pre-check that fails fast and produces the frozen terms. This is
  // the guard. The request document and the wallet hold commit together or not at all — a
  // request without its hold reserves nothing, and a hold without its request is credits
  // locked by a document that does not exist. Neither could be repaired by a later sweep,
  // because nothing would know it had happened.
  //
  // No second transaction and no second ledger: a hold moves no credits, so there is nothing
  // to record. Identical in shape to `openSession`, which holds for an upload the same way.
  const refundId = refundRepo.newRefundId()
  const doc = await adminDb.runTransaction(async tx => {
    // ── reads · every one before the first write ────────────────────────────
    // Re-checked INSIDE the transaction: two simultaneous requests for one purchase would
    // both pass the pre-check above and both place a hold. This is what makes that
    // impossible rather than unlikely.
    const raced = await refundRepo.findBlockingForPurchaseInTx(tx, purchase.purchaseId)
    if (raced) throw new RefundNotAllowedError('request_already_open')

    const balances = balancesOf(await walletRepo.readInTx(tx, input.organizerUid))

    // The lot, re-read. A settlement between the pre-check and here would have drained it,
    // and holding credits the lot no longer has would quote one number and reserve another.
    const liveLot = await lotRepo.readPurchaseLotInTx(tx, purchase.purchaseId)
    if ((liveLot?.remaining ?? 0) !== remaining) {
      throw new RefundNotAllowedError('credits_spent_since_quote')
    }
    // Recorded so a rejection or cancellation can put the lot back exactly where it was.
    const lotSeqAtRequest = liveLot?.seq ?? null

    // The wallet must actually be able to reserve it. `availableCredits` already subtracts
    // both holds, so this refuses a second refund that would double-spend the first one's
    // reservation just as it refuses one competing with an open upload.
    const spendable = availableCredits(balances)
    if (remaining > spendable) throw new InsufficientCreditsError(remaining, spendable)

    // ── writes ──
    const created = refundRepo.createRequestedInTx(tx, {
      refundId,
      organizerUid: input.organizerUid,
      // RD-MC-REFUND-V2-P2 · the UNUSED credits, not the whole purchase.
      credits:      remaining,
      purchaseId:   purchase.purchaseId,
      reason,
      requestedBy:  input.requestedBy,

      purchaseAmountPaise:       purchase.amountPaise,   // context: what they paid in full
      refundBasePaise,                                   // the basis: unused × unit price
      creditsRemainingAtRequest: remaining,              // the evidence approval re-checks
      purchaseCreditsAtRequest:  purchase.credits,      // so Used is renderable
      lotSeqAtRequest,                                  // so a release can put the lot back
      refundAmountPaise,
      serviceCharge:             charge,
      unitPricePaise:            purchase.unitPricePaise,
      creditsPerPhotoAtPurchase: purchase.creditsPerPhotoAtPurchase,
      currency:                  purchase.currency,

      // Routing comes from the PURCHASE, never the request body. The gateway result fields
      // (refund id, response, error, attempts) are owned by the repository and initialised
      // there — a caller must not be able to pre-set a refund id.
      refundMethod:     purchase.source,
      gatewayPaymentId: purchase.gatewayPaymentId,

      // The wallet as it stood BEFORE this hold, which is what the organizer was shown.
      walletAtRequest: {
        balance: balances.balance, held: balances.heldCredits, available: spendable,
      },
    })

    // THE hold, in two halves that must both be true.
    //
    // 1. The WALLET hold. Balance untouched, `refundHeldCredits` up by the refunded credits,
    //    so `available` falls and neither an upload nor a second refund can be funded by
    //    them. INVARIANT I5: this is the only place it rises, by exactly `credits`.
    walletRepo.writeBalancesInTx(tx, input.organizerUid, {
      ...balances,
      refundHeldCredits: balances.refundHeldCredits + remaining,
    })
    // 2. The LOT reservation. The wallet hold stops an overdraft but says nothing about
    //    WHICH credits are spoken for — FIFO would still drain this lot first and the
    //    reserved credits would be gone. Taking it out of the open-lot query is what makes
    //    "they cannot disappear because of later uploads" true rather than merely likely.
    lotRepo.reserveLotInTx(tx, purchase.purchaseId)

    return created
  })

  // Fire and forget. A refund request that was accepted must not fail because an email did.
  void notifyRefundRequested({
    organizerUid: doc.organizerUid, credits: doc.credits,
    refundAmountPaise: doc.refundAmountPaise, purchaseId: doc.purchaseId,
  })

  return toDetailDto(doc)
}

/** What a refund would return, without writing anything. Used to show terms before asking. */
export async function quoteRefund(
  organizerUid: string, purchaseId: string,
): Promise<RefundQuoteDto | null> {
  const purchase = await purchaseRepo.read(purchaseId)
  if (!purchase || purchase.organizerUid !== organizerUid) return null

  // RD-MC-REFUND-V2-P2 · quoted on the same basis the request will use, by the same
  // functions. A quote that priced the whole purchase while the request priced the unused
  // part would be a promise the next screen breaks.
  const remaining = (await lotRepo.readRemainingForPurchases([purchaseId])).get(purchaseId) ?? 0
  const refundBasePaise = refundBaseFor(remaining, purchase.unitPricePaise)
  const charge = serviceChargeFor(refundBasePaise, await chargePolicy())
  return {
    purchaseId,
    credits:             remaining,
    purchaseAmountPaise: purchase.amountPaise,
    serviceCharge:       charge,
    refundAmountPaise:   refundAmountFor(refundBasePaise, charge),
  }
}

// ─── RD-MC-REFUND-V2-P3 · releasing the hold ─────────────────────────────────

/**
 * Frees a pending refund's hold, INSIDE the caller's transaction.
 *
 * ONE definition, three callers: approval (which then debits the freed credits), rejection,
 * and cancellation. Written once because "never double release" is a property of this
 * arithmetic, and three copies of it would be three chances to clamp differently.
 *
 * Returns the balances AFTER the release, so a caller that needs to debit can pass them
 * straight into `applyDelta` rather than re-reading — which Firestore would refuse anyway,
 * the wallet having just been written.
 *
 * ═══ WHY EVERY CALLER GUARDS ON `requested` FIRST ════════════════════════════
 * This function clamps at zero, so releasing twice cannot drive the hold negative. But a
 * clamp is damage control, not correctness: the second release would still lower a hold
 * belonging to a DIFFERENT pending refund. What actually prevents that is the status check
 * every caller makes before reaching here — a refund leaves `requested` in the same
 * transaction that releases it, so there is no second time.
 */
function releaseRefundHold(
  balances: WalletBalances, credits: number,
): WalletBalances {
  return {
    ...balances,
    refundHeldCredits: Math.max(0, balances.refundHeldCredits - Math.max(0, Math.trunc(credits))),
  }
}

// ─── Admin decisions ──────────────────────────────────────────────────────────

export interface DecideInput {
  refundId:  string
  adminUid:  string
  note?:     string | null
}

/**
 * Rejects a request. Moves NO money and writes NO ledger entry — that is the point of the
 * state. It does release the hold, which is not a movement: the balance never changed.
 *
 * RD-MC-REFUND-V2-P3 · the release lives in the SAME transaction as the status change. If it
 * did not, a crash between them would strand the credits as `refundHeldCredits` against a
 * refund nobody will ever decide again — unspendable, unrefundable, and invisible.
 *
 * Transactional anyway, because the read-then-write on status must not race a concurrent
 * approval; without it both decisions could land and the last write would win silently.
 */
export async function rejectRefund(input: DecideInput): Promise<void> {
  // MC-11 · The transaction RETURNS the notice rather than assigning an outer variable.
  // Same effect, and it keeps the value provably tied to the branch that committed —
  // a captured `let` would also defeat narrowing, since TypeScript cannot see that a
  // callback ran.
  const notified = await adminDb.runTransaction<RefundNotice | null>(async tx => {
    // ── reads · both before the first write ──
    const refund = await refundRepo.readInTx(tx, input.refundId)
    if (!refund) throw new InvalidCreditOperationError(`unknown refund ${input.refundId}`)
    if (refund.status === 'rejected') return null                   // replay
    if (refund.status !== 'requested') {
      throw new RefundNotAllowedError(`cannot reject a ${refund.status} refund`)
    }
    // Only a `requested` refund reaches here, so its hold is live and is released exactly
    // once — the status change below is what makes a second pass impossible.
    const balances = balancesOf(await walletRepo.readInTx(tx, refund.organizerUid))

    // ── writes ──
    refundRepo.decideInTx(tx, input.refundId, 'rejected', input.adminUid, input.note ?? null)
    walletRepo.writeBalancesInTx(
      tx, refund.organizerUid, releaseRefundHold(balances, refund.credits),
    )
    // Both halves of the hold come off together. Releasing only the wallet would leave the
    // lot invisible to FIFO forever — credits the organizer owns and can see but can never
    // spend on a photo.
    lotRepo.restoreLotInTx(tx, refund.purchaseId, refund.lotSeqAtRequest)
    return {
      organizerUid: refund.organizerUid, credits: refund.credits,
      refundAmountPaise: refund.refundAmountPaise, purchaseId: refund.purchaseId,
    }
  })

  // Outside the transaction: a send inside one would re-run on every Firestore retry.
  // Null on a replay, so a double-click does not email the organizer twice.
  if (notified) void notifyRefundRejected({ ...notified, note: input.note ?? null })
}

// ─── RD-MC-REFUND-V2-P3 · the organizer withdrawing their own request ────────

export interface CancelInput {
  organizerUid: string
  refundId:     string
  /** Who clicked. May differ from the workspace owner on a team account. */
  actorUid:     string
}

/**
 * Cancels a pending request. Financially identical to a rejection: releases the hold, moves
 * no money, writes no ledger entry.
 *
 * ═══ WHY THIS IS NOT `rejectRefund` WITH A DIFFERENT ACTOR ═══════════════════
 * The arithmetic is shared — both call `releaseRefundHold`, which exists so there is one
 * definition of it. What differs is meaning and authority: a rejection is the platform
 * declining and carries an admin's decision note into an audit trail admins read; a
 * cancellation is the organizer changing their mind. Recording one as the other would show a
 * decision in the admin queue that nobody made.
 *
 * Tenant-checked HERE, not only at the route: an organizer must not be able to cancel another
 * workspace's refund by guessing an id. Unknown and not-yours give the same answer.
 *
 * Only from `requested`. After approval the credits have left the wallet and a gateway payout
 * may be in flight — unwinding that is not a cancellation, and the refund machinery already
 * owns it.
 */
export async function cancelRefund(input: CancelInput): Promise<void> {
  const cancelled = await adminDb.runTransaction<boolean>(async tx => {
    // ── reads · both before the first write ──
    const refund = await refundRepo.readInTx(tx, input.refundId)
    // Same answer for "no such refund" and "not yours", so this cannot be used to discover
    // real ids belonging to other workspaces.
    if (!refund || refund.organizerUid !== input.organizerUid) {
      throw new InvalidCreditOperationError(`unknown refund ${input.refundId}`)
    }
    if (refund.status === 'cancelled') return false                 // replay
    if (refund.status !== 'requested') {
      throw new RefundNotAllowedError(`cannot cancel a ${refund.status} refund`)
    }
    const balances = balancesOf(await walletRepo.readInTx(tx, refund.organizerUid))

    // ── writes ──
    // `decidedBy` is the ORGANIZER here. That is the record wanted: whoever ended the
    // request is named on it, whichever side they were on.
    refundRepo.decideInTx(tx, input.refundId, 'cancelled', input.actorUid, null)
    walletRepo.writeBalancesInTx(
      tx, refund.organizerUid, releaseRefundHold(balances, refund.credits),
    )
    // Identical to rejection, by the same two calls. That is the whole meaning of
    // "cancellation behaves exactly like rejection" — not a comment saying so, but the same
    // two writes in the same order.
    lotRepo.restoreLotInTx(tx, refund.purchaseId, refund.lotSeqAtRequest)
    return true
  })

  // No notification. The organizer performed this action themselves and is looking at the
  // result; emailing them about their own click is noise, not confirmation.
  void cancelled
}

export interface ApproveResult {
  refundId:        string
  refundAmountPaise: number
  gatewayRefundId: string | null
  settled:         boolean
}

/**
 * Approves a request: debits the credits atomically, then returns the money.
 *
 * THE transaction covers the refund decision, the ledger entry and the wallet balance. If
 * any part fails nothing commits and the request stays `requested`.
 *
 * The payout follows OUTSIDE that transaction. A failure there leaves the refund `approved` —
 * credits gone, money not yet sent — and throws `RefundSettlementDeferredError` so the caller
 * answers 202 rather than an error that would invite a second approval. The reconciler
 * finishes it.
 */
export async function approveRefund(input: DecideInput): Promise<ApproveResult> {
  const policy = await getCreditPolicy()
  if (!policy.creditsEnabled) throw new CreditsDisabledError()

  // ── Phase 1: the atomic debit ──────────────────────────────────────────────
  const refund = await adminDb.runTransaction(async tx => {
    const r = await refundRepo.readInTx(tx, input.refundId)
    if (!r) throw new InvalidCreditOperationError(`unknown refund ${input.refundId}`)
    // Replay: the credits are already debited. `settling` is included because a double-click
    // lands here — the second click must fall through to the claim, which answers
    // "in progress", rather than erroring at an admin who pressed a button twice.
    if (r.status === 'approved' || r.status === 'settling' || r.status === 'settled') return r
    if (r.status !== 'requested') {
      throw new RefundNotAllowedError(`cannot approve a ${r.status} refund`)
    }

    // RD-MC-REFUND-V2-P1 · read the refunded purchase's lot BEFORE any write — `debitInTx`
    // writes, and Firestore forbids a read after a write in one transaction.
    //
    // A refund returns credits to the gateway rather than spending them, so the lot they came
    // from must shrink by the same amount the wallet does. Skipping this would leave a lot
    // claiming credits the organizer no longer has.
    const lot = await lotRepo.readPurchaseLotInTx(tx, r.purchaseId)

    // ── RD-MC-REFUND-V2-P2 · the lot must still cover what was quoted ────────
    // A partial refund is priced on what the lot held at REQUEST time. If the organizer kept
    // uploading while the request sat in the queue, FIFO has since drained that lot and it can
    // no longer cover the payout.
    //
    // Approving anyway would debit the wallet by the frozen credits while the lot could only
    // give up what it still has — the difference is permanent drift between Σ lots and the
    // balance, with no error anywhere to show for it. The wallet check below would NOT catch
    // it: the organizer may have spent from a different lot entirely and still have the
    // credits available.
    //
    // Refused, never re-priced. The money values are frozen terms the organizer agreed to;
    // silently paying a smaller amount would settle a refund they never asked for. They can
    // request again for what actually remains.
    const quoted = r.creditsRemainingAtRequest ?? r.credits
    if ((lot?.remaining ?? 0) < quoted) {
      opsLog('lots.refund_stale', {
        refundId: r.refundId, purchaseId: r.purchaseId, organizerUid: r.organizerUid,
        quoted, lotRemaining: lot?.remaining ?? 0,
      })
      throw new RefundNotAllowedError('credits_spent_since_request')
    }

    const lotDebit = refundDebitFor(lot, r.credits)

    // Re-validated against the LIVE wallet, not the request-time snapshot. The organizer may
    // have spent the credits while the request sat in the queue; `debitInTx` throws
    // InsufficientCreditsError and the whole approval rolls back.
    //
    // RD-MC-REFUND-V2-P3 · the hold is released in this same call, before the debit is
    // checked. Only a `requested` refund gets here (the replay branch above returns early),
    // so the release happens exactly once — and it happens in the ONE transaction that also
    // writes the balance, the ledger entry and the lot. Nothing is split.
    await debitInTx(tx, {
      organizerUid: r.organizerUid,
      entryId:      `refund:${r.refundId}`,     // deterministic ⇒ replay-safe
      credits:      r.credits,
      reason:       'refund',
      actorUid:     input.adminUid,
      actorKind:    'platform',
      refundId:     r.refundId,
      purchaseId:   r.purchaseId,
      releaseRefundHoldCredits: r.credits,
    })
    // Same transaction as the wallet debit. The two numbers can only disagree if the lot held
    // less than the refund — eligibility is supposed to make that unreachable, so it is worth
    // a record rather than a silent cap. The refund still proceeds: the money is owed either
    // way, and the balance is the figure that has to stay right.
    if (!lotDebit || lotDebit.credits < r.credits) {
      opsLog('lots.refund_shortfall', {
        refundId: r.refundId, purchaseId: r.purchaseId, organizerUid: r.organizerUid,
        creditsRefunded: r.credits, lotDebited: lotDebit?.credits ?? 0,
        lotRemaining: lot?.remaining ?? null,
      })
    }
    if (lotDebit) lotRepo.applyDebitsInTx(tx, [lotDebit])

    refundRepo.decideInTx(tx, r.refundId, 'approved', input.adminUid, input.note ?? null)
    return r
  })

  // Only when THIS call did the approving. A replay re-enters with a refund that is already
  // `approved` and returns it unchanged from the transaction, so the organizer is not
  // emailed twice for one decision.
  if (refund.status === 'requested') {
    void notifyRefundApproved({
      organizerUid: refund.organizerUid, credits: refund.credits,
      refundAmountPaise: refund.refundAmountPaise, purchaseId: refund.purchaseId,
    })
  }

  if (refund.status === 'settled') {
    return {
      refundId: refund.refundId, refundAmountPaise: refund.refundAmountPaise,
      gatewayRefundId: refund.gatewayRefundId, settled: true,
    }
  }

  // ── Phase 2: the payout ────────────────────────────────────────────────────
  return settleApprovedRefund(refund.refundId)
}

/**
 * Executes the payout for an already-`approved` refund and marks it settled.
 *
 * Separate and idempotent so BOTH the approval path and the reconciler can call it. Safe to
 * run repeatedly: `refundPayment` adopts an existing gateway refund rather than creating a
 * second one.
 */
export async function settleApprovedRefund(refundId: string): Promise<ApproveResult> {
  // ── THE CLAIM (MC-05.6A) ───────────────────────────────────────────────────
  // Nothing above this line may touch the gateway, and nothing below it runs for more than
  // one caller. Previously this function read the refund, checked `status === 'approved'`
  // and called Razorpay — a check-then-act with no lock, so an admin double-click or an
  // approval racing the scheduler could both pass the check and both issue a real refund.
  const claim = await refundRepo.claimForSettlement(refundId)

  if (!claim.claimed) {
    if (claim.reason === 'already_settled') {
      // Idempotent success: the money is out, and saying so is the honest answer.
      return {
        refundId,
        refundAmountPaise: claim.refund!.refundAmountPaise,
        gatewayRefundId:   claim.refund!.gatewayRefundId,
        settled:           true,
      }
    }
    if (claim.reason === 'in_progress') {
      // Another caller holds the claim. Deferred, NOT an error — the payout is happening,
      // and reporting a failure here is what would tempt a caller to try again.
      throw new RefundSettlementDeferredError(refundId, 'settlement_in_progress')
    }
    if (!claim.refund) throw new InvalidCreditOperationError(`unknown refund ${refundId}`)
    throw new RefundNotAllowedError(`cannot settle a ${claim.refund.status} refund`)
  }

  const refund = claim.refund

  // Routing switch. Only `razorpay` is reachable today — every purchase MC-04 creates is a
  // Razorpay order — but the decision is made on the RECORDED source, so adding a second
  // source later is a new case here rather than a rewrite of the caller.
  if (refund.refundMethod !== 'razorpay') {
    // The claim is held and this refund can never settle; hand it back so the record does
    // not sit `settling` until the TTL expires.
    await refundRepo.releaseClaim(refundId, `unsupported refund method ${refund.refundMethod}`)
      .catch(() => { /* the TTL is the backstop */ })
    throw new InvalidCreditOperationError(`unsupported refund method ${refund.refundMethod}`)
  }

  try {
    const out = await refundPayment({
      refundId,
      paymentId:   refund.gatewayPaymentId ?? '',
      amountPaise: refund.refundAmountPaise,
    })
    await refundRepo.markSettled(refundId, out.gatewayRefundId, out.response)
    // The money has actually left. Fire and forget — see refundNotifications' header.
    void notifyRefundPaid({
      organizerUid: refund.organizerUid, credits: refund.credits,
      refundAmountPaise: refund.refundAmountPaise, purchaseId: refund.purchaseId,
      gatewayRefundId: out.gatewayRefundId,
    })
    return {
      refundId, refundAmountPaise: refund.refundAmountPaise,
      gatewayRefundId: out.gatewayRefundId, settled: true,
    }
  } catch (err) {
    const cause = err instanceof Error ? err.message : 'gateway_refund_failed'
    captureFinancialError(err, { scope: 'media_credits.refund_settle_failed', refundId })
    // Hand the claim back so the reconciler retries immediately rather than waiting out the
    // TTL. `releaseClaim` also increments the attempt counter — this is the only path a
    // failed gateway attempt takes.
    await refundRepo.releaseClaim(refundId, cause).catch(() => { /* logged above */ })
    throw new RefundSettlementDeferredError(refundId, cause)
  }
}

/** Named per the MC-05 brief. */
export const refundService = {
  createRefundRequest,
  getRefundRequest,
  listRefundRequests,
  listByStatus,
  quoteRefund,
  approveRefund,
  rejectRefund,
  /** RD-MC-REFUND-V2-P3 · the organizer's own withdrawal. Releases the hold, moves no money. */
  cancelRefund,
  settleApprovedRefund,
}

// ─── MC-11 · Refund eligibility for a page of purchases ───────────────────────

export interface PurchaseRefundView {
  purchaseId:   string
  eligible:     boolean
  /** Null when eligible. */
  reason:       RefundIneligibleReason | null
  /** One sentence for the organizer. Null when eligible. */
  explanation:  string | null
  /** Everything money-shaped, computed HERE. The client renders these and derives nothing. */
  purchaseAmountPaise: number
  /** RD-MC-REFUND-V2-P2 · `creditsRemaining × unitPricePaise`. What the charge is taken from. */
  refundBasePaise:     number
  serviceChargePaise:  number
  refundAmountPaise:   number
  /** Credits this purchase bought. */
  credits:      number
  /** RD-MC-REFUND-V2-P2 · of those, how many are still unspent. The refund scope. */
  creditsRemaining: number
  /** RD-MC-REFUND-V2-P2 · and how many are gone. `credits - creditsRemaining`, sent so the
   *  dashboard renders a figure rather than subtracting one itself. */
  creditsUsed:      number
  /** The workspace's currently unused credits, for context on the row. */
  availableCredits: number
  /** The status of an existing refund against this purchase, when there is one. */
  refundStatus: string | null
  /** RD-MC-REFUND-V2-P3 · credits this purchase's pending refund is holding. 0 when none. */
  heldCredits: number
}

/**
 * Eligibility and pricing for several purchases at once.
 *
 * ONE wallet read and ONE refund page for the whole set, rather than a lookup per purchase —
 * a dashboard showing 25 rows would otherwise fire 25 round trips to answer one question.
 *
 * Every figure it returns is computed server-side by `refundMath`. That is the point: the
 * organizer's dashboard must never multiply a percentage by an amount, because then the
 * number on screen and the number charged would come from two different implementations.
 */
export async function refundViewsForPurchases(
  organizerUid: string,
  purchases: readonly {
    purchaseId: string; status: string; credits: number; amountPaise: number
    grantedAtMs: number
    /** RD-MC-REFUND-V2-P2 · this purchase's own frozen price. Never a wallet-wide rate. */
    unitPricePaise: number
  }[],
): Promise<PurchaseRefundView[]> {
  const policy = await getCreditPolicy()
  const [wallet, charge] = await Promise.all([
    walletService.getBalance(organizerUid),
    chargePolicy(),
  ])

  // One page, then two lookup maps — a query per row would be N round trips to answer one
  // question. The SAME page answers both, so P3's settled-refund check costs no extra read.
  const existing = await refundRepo.listByOrganizer(organizerUid, 200)
  /** The ACTIVE refund against a purchase, if any. Ordered newest-first by the query. */
  const activeByPurchase  = new Map<string, string>()
  /** Whether a purchase has ever been refunded to completion. */
  const settledByPurchase = new Set<string>()
  for (const r of existing) {
    if (r.status === 'settled') { settledByPurchase.add(r.purchaseId); continue }
    // RD-MC-REFUND-V2-P3 · only an ACTIVE refund blocks. `rejected` and `cancelled` released
    // their hold and leave the purchase refundable, so neither is recorded here — and
    // `settled` moved to the set above, because it no longer blocks either.
    if (!CREDIT_REFUND_BLOCKING_STATUSES.includes(r.status)) continue
    if (!activeByPurchase.has(r.purchaseId)) activeByPurchase.set(r.purchaseId, r.status)
  }

  // RD-MC-REFUND-V2-P2 · every lot on the page in ONE read, not one per row.
  const remainingByPurchase = await lotRepo.readRemainingForPurchases(
    purchases.map(p => p.purchaseId),
  )

  const nowMs = Date.now()
  return purchases.map(p => {
    const creditsRemaining  = remainingByPurchase.get(p.purchaseId) ?? 0
    const refundBasePaise   = refundBaseFor(creditsRemaining, p.unitPricePaise)
    const serviceCharge     = serviceChargeFor(refundBasePaise, charge)
    const refundAmountPaise = refundAmountFor(refundBasePaise, serviceCharge)
    // RD-MC-REFUND-V2-P3 · the map holds ONLY active refunds now, so no post-filter is
    // needed here — the "is a rejected one blocking?" question is answered once, where the
    // map is built, rather than re-decided per row.
    const blocking = activeByPurchase.get(p.purchaseId) ?? null

    const verdict = evaluateRefundEligibility({
      refundsEnabled:           policy.refundsEnabled,
      refundWindowDays:         policy.refundWindowDays,
      minRefundablePaise:       policy.minRefundablePaise,
      minRefundCredits:         policy.minRefundCredits,
      maxRefundPerRequestPaise: policy.maxRefundPerRequestPaise,
      purchaseStatus:           p.status,
      creditsRemaining,
      grantedAtMs:              p.grantedAtMs,
      availableCredits:         wallet.available,
      blockingRefundStatus:     blocking,
      hasSettledRefund:         settledByPurchase.has(p.purchaseId),
      refundAmountPaise,
      nowMs,
    })

    return {
      purchaseId:  p.purchaseId,
      eligible:    verdict.eligible,
      reason:      verdict.eligible ? null : verdict.reason,
      explanation: verdict.eligible ? null : REFUND_INELIGIBLE_COPY[verdict.reason],
      purchaseAmountPaise: p.amountPaise,
      refundBasePaise,
      serviceChargePaise:  serviceCharge.amountPaise,
      refundAmountPaise,
      credits:          p.credits,
      creditsRemaining,
      creditsUsed:      Math.max(0, p.credits - creditsRemaining),
      availableCredits: wallet.available,
      /**
       * RD-MC-REFUND-V2-P3 · the ACTIVE refund's status, or `settled` when there is none but
       * the purchase has been refunded before. The row needs something to render, and an
       * active request is the more urgent fact when both are true.
       */
      refundStatus: blocking ?? (settledByPurchase.has(p.purchaseId) ? 'settled' : null),
      /** Credits this refund is holding right now — 0 unless a request is pending. */
      heldCredits:  blocking === 'requested' ? creditsRemaining : 0,
    }
  })
}
