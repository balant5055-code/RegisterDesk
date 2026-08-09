// Media Credits services — SERVER-ONLY.
//
// MC-01 defined these contracts as throwing skeletons. MC-02 implemented the financial
// foundation (wallet, ledger, pricing), MC-03 the reservation lifecycle, and MC-04 the
// purchase lifecycle — which lives in ./purchaseService.ts. Only refunds still throw.
//
// ═══ THE SINGLE-WRITER RULE ══════════════════════════════════════════════════
// This file is the ONLY code permitted to write a wallet BALANCE or to append to
// `mediaCreditLedger`, and it always writes both inside ONE transaction.
//
// MC-10 · Stated precisely, because there is exactly one deliberate exception and a vaguer
// claim would hide it. `sessionService.openSession` also writes `mediaCreditWallets` — but
// only `heldCredits`, never `balance`, and it appends no ledger entry. That is correct: a
// hold moves no credits (balance is untouched, `available` falls), so there is no delta to
// record. Invariant I1 — balance == Σ ledger deltas — is unaffected, because `heldCredits`
// is a cache of open allocations (I4) rather than a ledger-derived figure.
//
// So: ONE balance writer, ONE ledger writer, both here. `heldCredits` has two, by design.
//
// This mirrors `registerAsset` being the only writer of gallery/album counters
// (features/media-studio/repositories/assetRepo.ts). That single-writer property is what
// keeps those counters correct today, and the credit balance depends on the same discipline.
//
// ═══ LAYERING ════════════════════════════════════════════════════════════════
//   utils/ledgerMath.ts   pure decisions — validation, arithmetic, overdraft
//   repositories/*        Firestore I/O only, no rules
//   services (this file)  orchestration: transaction boundaries and ordering
//
// Nothing in this file is reachable from the upload path. Media Studio behaves identically.

import { adminDb } from '@/lib/firebase/admin'
import { businessConfig } from '@/lib/config/businessConfigService'
import type {
  CreditBalanceDto, CreditLedgerEntryDto, CreditPricingDto,
  CreditLedgerReason, CreditActorKind,
  CreditReservationDoc, CreditSessionDoc, CreditWalletDoc, ServiceChargeMethod,
} from '@/features/media-credits/types'
import { WalletNotFoundError, InvalidCreditOperationError, SessionNotActiveError, CorruptSessionDataError } from '@/features/media-credits/errors'
import { opsLog } from '@/features/media-credits/utils/opsLog'
import { applyDelta, availableCredits, balancesOf } from '@/features/media-credits/utils/ledgerMath'
import { resolveSlot } from '@/features/media-credits/utils/sessionSlots'
import { withOrganizerLock } from '@/features/media-credits/utils/organizerLock'
import * as walletRepo from '@/features/media-credits/repositories/walletRepo'
import * as ledgerRepo from '@/features/media-credits/repositories/ledgerRepo'
import * as reservationRepo from '@/features/media-credits/repositories/reservationRepo'
import * as sessionRepo from '@/features/media-credits/repositories/sessionRepo'
import * as lotRepo from '@/features/media-credits/repositories/lotRepo'
import { allocateFifo } from '@/features/media-credits/utils/creditLots'
import type { Transaction } from 'firebase-admin/firestore'

/** Thrown by anything not yet implemented. Distinct type so a stray call is unmistakable. */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`Not implemented: ${method}`)
    this.name = 'NotImplementedError'
  }
}

// ─── walletService ────────────────────────────────────────────────────────────

export interface WalletService {
  getWallet(organizerUid: string): Promise<CreditWalletDoc | null>
  getBalance(organizerUid: string): Promise<CreditBalanceDto>
}

export const walletService: WalletService = {
  async getWallet(organizerUid) {
    return walletRepo.read(organizerUid)
  },

  /**
   * Balance for display.
   *
   * A workspace with no wallet reports zeros rather than throwing: "you have no credits" is
   * a normal state of a page an organizer may open, not a fault. `WalletNotFoundError` is
   * reserved for callers that genuinely require the document to exist.
   */
  async getBalance(organizerUid) {
    const wallet = await walletRepo.read(organizerUid)
    const b = balancesOf(wallet)
    return {
      balance: b.balance, held: b.heldCredits, refundHeld: b.refundHeldCredits,
      available: availableCredits(b), tier: null,
      // Read straight off the cached wallet — not summed from the ledger.
      lifetimeGranted:  b.lifetimeGranted,
      lifetimeConsumed: b.lifetimeConsumed,
    }
  },
}

/** Read that insists the wallet exists. For callers where absence is a real fault. */
export async function requireWallet(organizerUid: string): Promise<CreditWalletDoc> {
  const wallet = await walletRepo.read(organizerUid)
  if (!wallet) throw new WalletNotFoundError(organizerUid)
  return wallet
}

// ─── ledgerService ────────────────────────────────────────────────────────────

/** One balance movement. `entryId` is the idempotency key and is caller-supplied. */
export interface MovementInput {
  organizerUid: string
  /** Idempotency key. A replay with the same id is a no-op, never a second charge. */
  entryId:      string
  /** Positive magnitude. Direction comes from the method called, not from the sign. */
  credits:      number
  reason:       CreditLedgerReason
  actorUid:     string
  actorKind:    CreditActorKind
  assetId?:     string | null
  purchaseId?:  string | null
  refundId?:    string | null
  eventId?:     string | null
  eventSlug?:   string | null
  /**
   * RD-MC-REFUND-V2-P3 · release this many refund-held credits BEFORE applying the delta.
   *
   * Only `approveRefund` passes it, and it passes exactly the credits its own request is
   * holding. Freeing and debiting must happen in one decision because `applyDelta` checks
   * the debit against `available`, which the hold reduces — see the comment at the point of
   * use. Absent everywhere else, which keeps every other movement byte-identical.
   */
  releaseRefundHoldCredits?: number
}

/**
 * MC-09 · A manual grant.
 *
 * This replaced a placeholder shaped `{ organizerUid, purchaseId, actorUid }` — a grant
 * against a PURCHASE, which MC-04 ended up doing directly through `creditInTx` with
 * `entryId: purchase:{id}`. Keeping the old shape would have left a second way to grant
 * purchased credits beside the one that actually runs. It had no callers.
 */
export interface GrantInput {
  organizerUid: string
  /** Caller-supplied idempotency key and document id. */
  grantId:      string
  credits:      number
  reason:       string
  note:         string
  reference?:   string | null
  actorUid:     string
}
export interface ReserveInput {
  organizerUid: string; assetId: string; eventId: string; eventSlug: string
  galleryId: string; credits: number; actorUid: string
  /** MC-06B: the session whose allocation authorises this slot. */
  sessionId: string
  /** MC-06B: position within that session. */
  slotIndex: number
}
export interface ResolveInput { organizerUid: string; assetId: string; actorUid: string }
export interface RefundInput  { organizerUid: string; refundId: string; actorUid: string }

export interface LedgerService {
  /** Adds credits. One transaction: read wallet → validate → append entry → write wallet. */
  credit(input: MovementInput): Promise<void>
  /** Removes credits. Rejects when the magnitude exceeds `available`. */
  debit(input: MovementInput): Promise<void>

  // Reserved for later sprints — see the TDD's T1–T5.
  grant(input: GrantInput): Promise<void>
  reserve(input: ReserveInput): Promise<void>
  consume(input: ResolveInput): Promise<void>
  release(input: ResolveInput): Promise<void>
  refund(input: RefundInput): Promise<void>

  listEntries(organizerUid: string, limit: number, cursor?: string | null):
    Promise<{ entries: CreditLedgerEntryDto[]; nextCursor: string | null }>
}

/**
 * THE single writer. One Firestore transaction per movement.
 *
 * Ordering is deliberate. Every read happens before every write — Firestore requires it, and
 * the new balance must be computed from the value read INSIDE the transaction. A balance
 * read outside it could be stale by the time the write lands, which is exactly how a
 * concurrent debit would overspend.
 *
 * Idempotency is by `entryId`, guarded twice: the existence check short-circuits a replay,
 * and `tx.create` then backstops it, so two transactions racing on one id cannot both append.
 * Firestore retries a contended transaction automatically, which is safe precisely because
 * of that.
 */
async function applyMovement(input: MovementInput, signedDelta: number): Promise<void> {
  // MC-05.6B: queued per organizer. Competing for one wallet document is measurably slower
  // than taking turns for it — see utils/organizerLock.ts for the numbers.
  await withOrganizerLock(input.organizerUid, () =>
    adminDb.runTransaction(async tx => {
      await applyMovementInTx(tx, input, signedDelta)
    }))
}

/**
 * The body of a movement, INSIDE a transaction the caller already opened.
 *
 * ═══ WHY THIS IS SEPARATE FROM `applyMovement` ═══════════════════════════════
 * MC-04 requires the purchase record, the ledger entry and the wallet update to commit in
 * ONE transaction. `applyMovement` opens its own, and Firestore has no nested transactions —
 * so a purchase could not call it. The choice was to duplicate the balance arithmetic inside
 * the purchase service or to extract it. Duplicated balance arithmetic is precisely the
 * "second counting system" this module exists to avoid.
 *
 * So the body moved here and `applyMovement` became a wrapper. There is still exactly ONE
 * piece of code in the repository that mutates a credit balance, which is the invariant that
 * matters; it can now be reached either standalone or as part of a larger transaction. This
 * is the same shape as `consumeInTx` / `releaseInTx` below.
 *
 * MUST be called before the caller's first write — it reads two documents.
 */
async function applyMovementInTx(
  tx: Transaction, input: MovementInput, signedDelta: number,
): Promise<number> {
  // ── reads ──
  // ONE read answers both halves of the replay question: whether this movement already
  // happened, and what balance it left. The caller may need the second — MC-09's grant
  // record stores it — and the wallet cannot be re-read once this transaction writes it.
  const existing = await ledgerRepo.readInTx(tx, input.entryId)
  if (existing) return existing.balanceAfter                   // replay: already applied
  const wallet = await walletRepo.readInTx(tx, input.organizerUid)

  // ── decide (pure; throws on an invalid delta or an overdraft) ──
  const current = balancesOf(wallet)

  // ═══ RD-MC-REFUND-V2-P3 · the hold is freed BEFORE the debit ═══════════════
  // Ordering is load-bearing, and it is the same ordering `settleSessionInTx` uses for
  // session holds. `applyDelta` checks a debit against `available`, which now subtracts
  // `refundHeldCredits` — and the credits being debited are precisely the ones this refund
  // is holding. Debiting first would make an approval fail its own reservation: a wallet of
  // 499 with 499 refund-held would reject a 499-credit refund.
  //
  // Passed in rather than written separately because Firestore forbids a read after a write:
  // releasing the hold in the caller's transaction would mean writing the wallet, after
  // which this function could no longer read it. One read, one decision, one write.
  const freed = input.releaseRefundHoldCredits
    ? {
        ...current,
        refundHeldCredits: Math.max(
          0, current.refundHeldCredits - Math.max(0, Math.trunc(input.releaseRefundHoldCredits)),
        ),
      }
    : current

  const next = applyDelta(freed, signedDelta, input.reason)

  // ── writes ──
  ledgerRepo.appendInTx(tx, {
    entryId:      input.entryId,
    organizerUid: input.organizerUid,
    delta:        signedDelta,
    reason:       input.reason,
    balanceAfter: next.balance,
    actorUid:     input.actorUid,
    actorKind:    input.actorKind,
    assetId:      input.assetId,
    purchaseId:   input.purchaseId,
    refundId:     input.refundId,
    eventId:      input.eventId,
    eventSlug:    input.eventSlug,
  })
  walletRepo.writeBalancesInTx(tx, input.organizerUid, next)

  // Returned so a caller that must record the resulting balance uses the SAME number the
  // ledger entry stores, rather than reading the wallet back — which Firestore forbids after
  // a write — or recomputing it, which would be a second implementation of the arithmetic.
  return next.balance
}

/**
 * T1 · Add credits, INSIDE a transaction the caller already opened.
 *
 * MC-04's purchase completion calls this so the grant cannot commit without the purchase
 * record, and the purchase record cannot commit without the grant.
 *
 * Idempotent by `entryId` — pass a deterministic one (`purchase:{purchaseId}`) and a retried
 * verification is a no-op rather than a second grant.
 *
 * MUST be called before the caller's first write in the same transaction.
 */
export async function creditInTx(tx: Transaction, input: MovementInput): Promise<number> {
  return applyMovementInTx(tx, input, Math.abs(Math.trunc(input.credits)))
}

/**
 * T5 · Remove credits, INSIDE a transaction the caller already opened.
 *
 * MC-05's refund approval calls this so the debit, the ledger entry and the refund decision
 * commit together. The overdraft guard still applies — `applyDelta` throws
 * `InsufficientCreditsError` if the magnitude exceeds `available`, which is what stops a
 * refund approved after the organizer has spent the credits.
 *
 * MUST be called before the caller's first write in the same transaction.
 */
export async function debitInTx(tx: Transaction, input: MovementInput): Promise<void> {
  await applyMovementInTx(tx, input, -Math.abs(Math.trunc(input.credits)))
}

/**
 * MC-06C · Settle a sealed session, INSIDE a transaction the caller already opened.
 *
 * THE only place credits are consumed. Every other financial write in this module belongs to
 * a purchase, a refund or a grant; the entire upload path — thousands of photos — collapses
 * into this one movement (Spec v1.0 §8, §10).
 *
 * Lives here, beside `creditInTx` and `debitInTx`, because the single-writer rule holds: the
 * wallet is written in exactly one file. `sessionSettlementService` owns the counting and the
 * orchestration; the balance arithmetic stays here.
 *
 * ═══ THE HOLD IS FREED BEFORE THE DEBIT ══════════════════════════════════════
 * Ordering is load-bearing. `applyDelta` checks a debit against `available` (balance − held),
 * and the credits being consumed are precisely the ones this session is holding. Debiting
 * first would make a session's own allocation look unaffordable — a wallet of 300 with 300
 * held would reject a 300-credit settlement. The MC-03 consume path used this same ordering
 * for the same reason.
 *
 * ═══ A ZERO-CONSUMPTION SESSION WRITES NO LEDGER ENTRY ═══════════════════════
 * `consume` requires a strictly negative delta (utils/ledgerMath), and a session that
 * uploaded nothing moves no balance. Rather than inventing a zero-delta consume, no entry is
 * written: the ledger records balance movements, and there was none. Invariant I1
 * (balance == Σ deltas) is untouched, and the hold still returns because `held` is a cache of
 * open allocations (I4), not a ledger-derived figure.
 *
 * MUST be called before the caller's first write — it reads the wallet.
 */
/**
 * Refuses a stored number that cannot be settled on.
 *
 * Deliberately strict — finite, integer, non-negative. Anything else means the document was
 * written by something other than this module, and guessing what it meant is how a
 * corruption becomes a silent under-charge.
 */
function assertSettleable(sessionId: string, field: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)
      || !Number.isInteger(value) || value < 0) {
    // Logged with the field NAME, never its value — the value could be anything.
    opsLog('session.corrupt', { sessionId, field })
    throw new CorruptSessionDataError(sessionId, field)
  }
}

export async function settleSessionInTx(
  tx: Transaction,
  input: {
    session:       CreditSessionDoc
    consumedSlots: number
    actorUid:      string
  },
): Promise<{ creditsConsumed: number; entryId: string | null; balanceAfter: number }> {
  const { session, consumedSlots } = input

  // ── MC-06E: fail closed on corrupt stored numbers ──────────────────────────
  // Without this, a non-numeric field becomes NaN, `creditsConsumed > 0` is false, and the
  // session settles as ZERO consumption — free storage, silently. Both fields are
  // server-written from config so this is unreachable through the API, but "charge nothing"
  // is the wrong way to fail for any value a human could one day edit by hand.
  assertSettleable(session.sessionId, 'creditsPerPhotoAtOpen', session.creditsPerPhotoAtOpen)
  assertSettleable(session.sessionId, 'allocatedCredits',      session.allocatedCredits)
  assertSettleable(session.sessionId, 'consumedSlots',         consumedSlots)

  const creditsConsumed = Math.max(0, Math.trunc(consumedSlots))
    * Math.max(0, Math.trunc(session.creditsPerPhotoAtOpen))

  // ── reads ──
  // EVERY read happens here, before the first write. Firestore forbids a read after a write
  // in one transaction, and the lot query below is the newest thing that could violate it.
  const wallet  = await walletRepo.readInTx(tx, session.organizerUid)
  const current = balancesOf(wallet)

  // RD-MC-REFUND-V2-P1 · which batches this consumption came out of. Read only when there is
  // something to attribute — a zero-consumption settlement should not join the contention on
  // the organizer's lot documents. Sparse `lotSeq` keeps this bounded to OPEN lots, so an
  // organizer with a thousand drained purchases still reads none of them.
  const openLots = creditsConsumed > 0
    ? await lotRepo.readOpenLotsInTx(tx, session.organizerUid)
    : []

  // ── decide ──
  // Release the whole allocation from `held`, then charge what was actually used.
  const freed = {
    ...current,
    heldCredits: Math.max(0, current.heldCredits - session.allocatedCredits),
  }
  const next = creditsConsumed > 0
    ? applyDelta(freed, -creditsConsumed, 'consume')
    : freed

  // Attribution is decided here and applied below, so the pure allocator sees the same inputs
  // a test can hand it. It cannot throw: a shortfall comes back as `unattributed` rather than
  // aborting a settlement that has already released the hold correctly.
  const { debits, unattributed } = allocateFifo(openLots, creditsConsumed)
  if (unattributed > 0) {
    // The wallet covered this consumption but no lot did — the lots and the balance have
    // drifted apart. Recorded, never repaired here: inventing a lot would erase the evidence,
    // and refusing to settle would strand an upload that has already happened.
    opsLog('lots.unattributed', {
      sessionId: session.sessionId, organizerUid: session.organizerUid,
      creditsConsumed, unattributed, openLots: openLots.length,
    })
  }

  // ── writes ──
  let entryId: string | null = null
  if (creditsConsumed > 0) {
    entryId = `session-settle:${session.sessionId}`
    ledgerRepo.appendInTx(tx, {
      entryId,                                   // deterministic ⇒ replay-safe
      organizerUid:  session.organizerUid,
      delta:         -creditsConsumed,
      reason:        'consume',
      balanceAfter:  next.balance,
      actorUid:      input.actorUid,
      actorKind:     'system',
      assetId:       null,
      reservationId: null,
      eventId:       session.eventId,
      eventSlug:     session.eventSlug,
    })
  }
  // Same transaction as the balance write, deliberately. If lots could be debited separately
  // then a crash between the two would leave the sum permanently wrong — which is precisely
  // the drift this feature exists to detect, so it must not be able to create it.
  lotRepo.applyDebitsInTx(tx, debits)

  // `applyDelta` already advanced `lifetimeConsumed` for the negative delta, so `next` is
  // written as-is. Recomputing it here would be a second place that owns the same figure.
  walletRepo.writeBalancesInTx(tx, session.organizerUid, next)

  return { creditsConsumed, entryId, balanceAfter: next.balance }
}

/**
 * T3 · Consume a hold, INSIDE a transaction the caller already opened.
 *
 * This is the function that makes MC-03's central guarantee possible. `uploads/complete`
 * passes it to `registerAsset`'s `beforeCommit` hook, so the debit, the ledger entry, the
 * reservation transition and the asset record all commit together — or none of them do.
 * Two separate transactions would leave a window where an organizer is charged for a photo
 * that was never registered.
 *
 * MUST be called before the caller issues any write in the same transaction: Firestore
 * requires every read to precede every write, and this reads two documents.
 *
 * Idempotent: an already-`consumed` reservation is a no-op, so a retried completion cannot
 * charge twice. A `released` reservation throws — those credits were already returned.
 */
export async function consumeInTx(tx: Transaction, input: ResolveInput): Promise<void> {
  // ── reads ──
  const reservation = await reservationRepo.readInTx(tx, input.assetId)
  if (!reservation) {
    throw new InvalidCreditOperationError(`no reservation for asset ${input.assetId}`)
  }
  if (reservation.status === 'consumed') return                     // replay
  if (reservation.status === 'released') {
    throw new InvalidCreditOperationError(
      `reservation ${input.assetId} was released and cannot be consumed`,
    )
  }
  if (reservation.organizerUid !== input.organizerUid) {
    throw new InvalidCreditOperationError(`reservation ${input.assetId} belongs to another workspace`)
  }

  // ── THE SEAL BARRIER (Spec v1.0 §6) ────────────────────────────────────────
  // Reading the session INSIDE the caller's transaction is what makes settlement exact.
  // Because this transaction read the session document, a seal committing before it commits
  // causes Firestore to abort it — so no slot can be consumed between the seal and the count
  // that settlement takes. Moving this read outside a transaction silently destroys the
  // guarantee while leaving every test that does not race a seal still passing.
  const session = await sessionRepo.readInTx(tx, reservation.sessionId)
  if (!session) {
    throw new InvalidCreditOperationError(`no session ${reservation.sessionId} for this slot`)
  }
  if (session.organizerUid !== input.organizerUid) {
    throw new InvalidCreditOperationError('session belongs to another workspace')
  }
  if (session.status !== 'ACTIVE') {
    throw new SessionNotActiveError(reservation.sessionId, session.status)
  }

  // ── writes ──
  // NO wallet write and NO ledger entry. The credits were already held at session open, and
  // the balance moves once, at settlement (Spec §8, §9). This is the removal that takes the
  // wallet off the per-photo path — the whole point of the session architecture.
  reservationRepo.resolveInTx(tx, input.assetId, 'consumed')
}

/**
 * T4 · Release a hold, INSIDE a caller's transaction.
 *
 * Returns credits to `available` by lowering `heldCredits`; the balance never moved, so the
 * ledger entry carries `delta: 0`. Recorded anyway so the ledger explains the hold history.
 *
 * A CONSUMED reservation is never released — that ordering is what stops a retry from
 * refunding an upload that succeeded.
 */
export async function releaseInTx(tx: Transaction, input: ResolveInput): Promise<void> {
  const reservation = await reservationRepo.readInTx(tx, input.assetId)
  if (!reservation) return                          // nothing held; releasing is a no-op
  if (reservation.status !== 'held') return         // consumed or already released

  // NO wallet write and NO ledger entry (Spec §9: `release` is "reserved; not used on the
  // session path"). A released slot is simply one that settlement will not count — the
  // credits return to the organizer when the session settles its unused remainder, not here.
  reservationRepo.resolveInTx(tx, input.assetId, 'released')
}

export const ledgerService: LedgerService = {
  async credit(input) { await applyMovement(input, Math.abs(input.credits)) },
  async debit(input)  { await applyMovement(input, -Math.abs(input.credits)) },

  /**
   * MC-09 · Manual grant. Delegates — it does NOT write the wallet a second way.
   *
   * The implementation lives in `grantService` because a grant is a workflow (validation,
   * a justification record, an audit action) around a movement, not a movement of its own.
   * The movement itself is `creditInTx`, immediately above. This method exists so
   * `LedgerService` has no unimplemented member and so a caller reaching for the obvious
   * name lands on the real path rather than a placeholder.
   *
   * Imported lazily: grantService imports `creditInTx` from this module, and a top-level
   * import here would close that cycle.
   */
  async grant(input) {
    const { createGrant } = await import('@/features/media-credits/services/grantService')
    await createGrant(input)
  },

  /**
   * Refunds are a state machine — request, decide, pay out, reconcile — and `refundService`
   * owns it end to end, debiting through `debitInTx`. Routing a refund through here would be
   * a second entry point to that machine, so this stays deliberately unimplemented rather
   * than becoming a thin alias that invites callers to bypass the workflow.
   */
  async refund() { throw new NotImplementedError('ledgerService.refund — use refundService') },

  /**
   * T2 · Claim one slot of a session's allocation. One transaction.
   *
   * ═══ NO WALLET, NO LEDGER, NO BALANCE CHECK ════════════════════════════════
   * MC-06B removed all three (Spec v1.0 §8, §11). The credits this slot needs were already
   * proven and held when the session opened, so re-checking the balance here would be both
   * redundant and the single most expensive thing on the upload path: reading the wallet in a
   * transaction that then writes it is what produced the measured livelock (3.14 photos/s
   * across four instances, p95 15–19s).
   *
   * What remains is a create on a document only this slot owns. Two instances uploading for
   * one organizer now write nothing in common.
   *
   * ═══ THE BOUND IS ENFORCED HERE, NOT ONLY IN THE ROUTE (MC-06F) ════════════
   * `resolveSlot` in `uploads/prepare` bounds the index arithmetically, but MC-06E found that
   * a caller reaching this service directly could claim past a session's allocation — the
   * "no overspending" guarantee rested on caller discipline rather than on the service
   * boundary. It no longer does.
   *
   * The cost is one session READ per claim. That is affordable precisely because a session
   * document is never written per photo (Spec §3 P4): concurrent transactions conflict only
   * when one WRITES a document another READ, so this read contends with nothing. It also
   * mirrors what `consumeInTx` already does, so both ends of a slot's life check the same
   * document the same way.
   */
  async reserve(input) {
    await adminDb.runTransaction(async tx => {
      // ── reads ──
      const existing = await reservationRepo.readInTx(tx, input.assetId)
      if (existing) {
        // Replay of a prepare that already succeeded. `held` is a no-op; a terminal record
        // means this assetId is spent and must never be re-held.
        if (existing.status === 'held') return
        throw new InvalidCreditOperationError(
          `reservation ${input.assetId} is already ${existing.status}`,
        )
      }

      // ── MC-06F: the slot must be inside a live session that belongs to this caller ──
      const session = await sessionRepo.readInTx(tx, input.sessionId)
      if (!session) {
        throw new InvalidCreditOperationError(`no session ${input.sessionId} for this slot`)
      }
      if (session.organizerUid !== input.organizerUid) {
        throw new InvalidCreditOperationError('session belongs to another workspace')
      }
      if (session.status !== 'ACTIVE') {
        throw new SessionNotActiveError(input.sessionId, session.status)
      }

      // The bound itself. `resolveSlot` returns a verdict rather than throwing, so the
      // reasons are mapped here — the service owes its caller a typed refusal.
      const slot = resolveSlot(input.sessionId, input.slotIndex, session.slotCount)
      if (!slot.ok) {
        throw new InvalidCreditOperationError(
          `slot ${input.slotIndex} is ${slot.reason} for session ${input.sessionId}`,
        )
      }
      // The assetId must BE the slot's derived id. Without this a caller could pair a valid
      // index with an arbitrary assetId and claim a slot the bound never checked.
      if (slot.assetId !== input.assetId) {
        throw new InvalidCreditOperationError(
          `assetId does not match slot ${input.slotIndex} of session ${input.sessionId}`,
        )
      }

      // ── writes ──
      reservationRepo.createInTx(tx, {
        assetId:      input.assetId,
        organizerUid: input.organizerUid,
        eventId:      input.eventId,
        eventSlug:    input.eventSlug,
        galleryId:    input.galleryId,
        credits:      input.credits,
        sessionId:    input.sessionId,
        slotIndex:    input.slotIndex,
      })
    })
  },

  /**
   * T3 · Standalone consume. Prefer `consumeInTx` so the transition rides the asset write.
   *
   * No longer queued per organizer: with the wallet off this path it writes only documents
   * this slot owns, so there is nothing left to serialise.
   */
  async consume(input) {
    await adminDb.runTransaction(async tx => { await consumeInTx(tx, input) })
  },

  /** T4 · Release a slot. One transaction; touches no shared document. */
  async release(input) {
    await adminDb.runTransaction(async tx => { await releaseInTx(tx, input) })
  },

  async listEntries(organizerUid, limit, cursor) {
    const docs = await ledgerRepo.listByOrganizer(organizerUid, limit, cursor ?? null)
    const entries: CreditLedgerEntryDto[] = docs.map(d => ({
      entryId:      d.entryId,
      delta:        d.delta,
      reason:       d.reason,
      balanceAfter: d.balanceAfter,
      assetId:      d.assetId,
      eventSlug:    d.eventSlug,
      // Firestore Timestamp → ms. No Timestamp crosses a service boundary.
      createdAtMs:  (d.createdAt as { toMillis?: () => number } | null)?.toMillis?.() ?? 0,
    }))
    return {
      entries,
      nextCursor: entries.length === limit ? entries[entries.length - 1].entryId : null,
    }
  },
}

// ─── pricingService ───────────────────────────────────────────────────────────

/** An immutable read of the credit policy currently in force. */
export interface CreditPolicySnapshot {
  creditsEnabled:       boolean
  creditsPerPhoto:      number
  creditUnitPricePaise: number
  refundsEnabled:       boolean
  refundWindowDays:     number
  minCreditPurchase:    number
  // MC-05 — refund service charge. Admin-only, like every other pricing key.
  refundServiceChargeMethod:     ServiceChargeMethod
  refundServiceChargePercent:    number
  refundServiceChargeFixedPaise: number
  minRefundablePaise:            number
  // MC-11 — refund admission thresholds. These bound WHICH requests are accepted; none of
  // them changes how a refund amount is computed.
  minRefundCredits:              number
  maxRefundPerRequestPaise:      number
  refundAutoRejectDays:          number
  refundReasonRequired:          boolean
  refundNoteRequired:            boolean
}

/**
 * The credit policy from `businessConfig.mediaStudio`.
 *
 * Credits are GLOBAL-only (MC-01 Decision 1), so this reads the section directly and does
 * NOT call `resolveMediaConfig`. That resolver merges `OVERRIDABLE_KEYS`, which deliberately
 * excludes pricing so an organizer cannot set their own price. Tier-level pricing remains an
 * open MC-03 decision.
 *
 * Frozen so a caller cannot mutate a shared snapshot.
 */
export async function getCreditPolicy(): Promise<Readonly<CreditPolicySnapshot>> {
  const m = await businessConfig.getSection('mediaStudio')
  return Object.freeze({
    creditsEnabled:       m.creditsEnabled,
    creditsPerPhoto:      m.creditsPerPhoto,
    creditUnitPricePaise: m.creditUnitPricePaise,
    refundsEnabled:       m.refundsEnabled,
    refundWindowDays:     m.refundWindowDays,
    minCreditPurchase:    m.minCreditPurchase,
    refundServiceChargeMethod:     m.refundServiceChargeMethod,
    refundServiceChargePercent:    m.refundServiceChargePercent,
    refundServiceChargeFixedPaise: m.refundServiceChargeFixedPaise,
    minRefundablePaise:            m.minRefundablePaise,
    // MC-11
    minRefundCredits:              m.minRefundCredits,
    maxRefundPerRequestPaise:      m.maxRefundPerRequestPaise,
    refundAutoRejectDays:          m.refundAutoRejectDays,
    refundReasonRequired:          m.refundReasonRequired,
    refundNoteRequired:            m.refundNoteRequired,
  })
}

export interface PricingService {
  creditsForPhotos(photoCount: number, creditsPerPhoto: number): number
  quote(credits: number, unitPricePaise: number): { credits: number; amountPaise: number }
  describe(eventId: string | null): Promise<CreditPricingDto>
}

/** PURE except for `describe`, which reads config. No payment integration in MC-02. */
export const pricingService: PricingService = {
  creditsForPhotos(photoCount, creditsPerPhoto) {
    return Math.max(0, Math.trunc(photoCount)) * Math.max(0, Math.trunc(creditsPerPhoto))
  },
  quote(credits, unitPricePaise) {
    const c = Math.max(0, Math.trunc(credits))
    return { credits: c, amountPaise: c * Math.max(0, Math.trunc(unitPricePaise)) }
  },
  /** MC-02 returns the GLOBAL policy. `eventId` is accepted for the MC-03 tier decision. */
  async describe() {
    const p = await getCreditPolicy()
    return {
      creditsPerPhoto: p.creditsPerPhoto,
      unitPricePaise:  p.creditUnitPricePaise,
      tier:            null,
      source:          'global',
    }
  },
}

// ─── Not in MC-02 scope ───────────────────────────────────────────────────────

export interface ReservationService {
  get(assetId: string): Promise<CreditReservationDoc | null>
  listStale(olderThanMs: number, limit: number): Promise<CreditReservationDoc[]>
}

export const reservationService: ReservationService = {
  async get(assetId) { return reservationRepo.read(assetId) },
  async listStale(olderThanMs, limit) { return reservationRepo.listStaleHeld(olderThanMs, limit) },
}

// ─── purchaseService (MC-04) ──────────────────────────────────────────────────
//
// Implemented in ./purchaseService.ts, NOT here. That module imports `creditInTx` from this
// one; re-exporting it from here would close an import cycle for no benefit. Consumers
// import it directly, the same way cleanupService is consumed.
//
// The MC-01 stub that lived here (`createOrder` / `confirm` / `list`) is gone: it never had a
// call site, and leaving a throwing placeholder beside a working implementation is how a
// caller ends up wired to the wrong one.

// ─── refundService (MC-05) ────────────────────────────────────────────────────
//
// Implemented in ./refundService.ts, NOT here — it imports `debitInTx` from this module and
// re-exporting it would close an import cycle. Consumers import it directly, as they do
// purchaseService and cleanupService.
//
// The MC-01 stub that lived here is gone. Its signature took a loose `credits` quantity,
// which MC-05 established is unpriceable: the ledger does not attribute consumption to a
// purchase lot, so a refund is scoped to one whole purchase instead.
