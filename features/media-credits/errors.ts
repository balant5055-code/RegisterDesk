// MC-02 · Media Credits domain errors.
//
// Typed rather than generic so a caller can branch on the FAILURE, not on a message string.
// `InsufficientCreditsError` in particular becomes an HTTP 402 in MC-04; matching on
// `err.message` would break the moment the copy changed.

export type CreditErrorCode =
  | 'WALLET_NOT_FOUND'
  | 'INSUFFICIENT_CREDITS'
  | 'DUPLICATE_LEDGER_ENTRY'
  | 'INVALID_CREDIT_OPERATION'
  | 'CREDITS_DISABLED'
  | 'PAYMENT_VERIFICATION_FAILED'
  | 'CREDIT_GRANT_DEFERRED'
  | 'SESSION_NOT_ACTIVE'
  | 'CORRUPT_SESSION_DATA'
  | 'REFUND_NOT_ALLOWED'
  | 'REFUND_SETTLEMENT_DEFERRED'

export abstract class MediaCreditError extends Error {
  abstract readonly code: CreditErrorCode
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Read of a wallet that has never been created. Distinct from "balance is zero". */
export class WalletNotFoundError extends MediaCreditError {
  readonly code = 'WALLET_NOT_FOUND' as const
  constructor(public readonly organizerUid: string) {
    super(`No credit wallet for workspace ${organizerUid}.`)
  }
}

/** A debit larger than `available`. Carries both numbers so the caller need not re-read. */
export class InsufficientCreditsError extends MediaCreditError {
  readonly code = 'INSUFFICIENT_CREDITS' as const
  /**
   * RD-MC-REFUND-V2-P3 · `refundHeld` names WHERE the missing credits went.
   *
   * Without it an organizer with a pending refund reads "not enough credits" while their
   * balance visibly shows the credits, with nothing on screen explaining the gap — the
   * credits are reserved, not gone, and cancelling the refund returns them. Optional so
   * every existing thrower is unchanged and the sentence only grows when it has something
   * to add.
   */
  constructor(
    public readonly required: number,
    public readonly available: number,
    public readonly refundHeld: number = 0,
  ) {
    super(
      `This workspace has ${available} credit(s) available and ${required} are required.`
      + (refundHeld > 0
        ? ` ${refundHeld} credit(s) are reserved by a pending refund request —`
          + ' cancel it to make them available again.'
        : ''),
    )
  }
}

/**
 * An entry id that already exists.
 *
 * Not always a fault: the idempotency guard raises it so a caller can treat a replay as
 * success rather than as a second charge.
 */
export class DuplicateLedgerEntryError extends MediaCreditError {
  readonly code = 'DUPLICATE_LEDGER_ENTRY' as const
  constructor(public readonly entryId: string) {
    super(`Ledger entry ${entryId} already exists.`)
  }
}

/** A request that could never be valid — zero delta, non-integer, wrong sign for the reason. */
export class InvalidCreditOperationError extends MediaCreditError {
  readonly code = 'INVALID_CREDIT_OPERATION' as const
  constructor(reason: string) {
    super(`Invalid credit operation: ${reason}`)
  }
}

/**
 * MC-04. The credits feature is switched off for this deployment.
 *
 * Its own type rather than a 404, because the distinction matters to the caller: the
 * endpoint exists and the request was well-formed — the feature simply is not on.
 */
export class CreditsDisabledError extends MediaCreditError {
  readonly code = 'CREDITS_DISABLED' as const
  constructor() {
    super('Media credits are not enabled for this account.')
  }
}

/**
 * MC-04. A payment that could not be proven genuine.
 *
 * `reason` is for the SERVER LOG. It deliberately does not reach the client: telling a
 * caller whether the signature, the amount, or the capture status failed hands them a
 * differential oracle to probe the verifier with.
 */
export class PaymentVerificationError extends MediaCreditError {
  readonly code = 'PAYMENT_VERIFICATION_FAILED' as const
  constructor(public readonly reason: string) {
    super('Payment verification failed.')
  }
}

/**
 * MC-04. The payment is genuine and captured, but the grant transaction did not commit.
 *
 * NOT a failure of the purchase — the organizer's money is safe and a reconciliation record
 * names the debt. It exists so the route can answer 202 (accepted, pending) instead of an
 * error that would invite the client to pay again.
 */
export class CreditGrantDeferredError extends MediaCreditError {
  readonly code = 'CREDIT_GRANT_DEFERRED' as const
  constructor(public readonly purchaseId: string, public readonly cause: string) {
    super('Payment received. Your credits will be added shortly.')
  }
}

/**
 * MC-06B. A slot was consumed against a session that is no longer accepting work.
 *
 * Raised by the SEAL BARRIER (Spec v1.0 §6). It is the expected outcome of an upload that
 * was in flight when its session was sealed — a race, not a fault — so the caller maps it to
 * a retryable client status rather than a server error. The whole completion transaction is
 * rolled back by Firestore, so no asset is registered and no slot is consumed.
 */
export class SessionNotActiveError extends MediaCreditError {
  readonly code = 'SESSION_NOT_ACTIVE' as const
  constructor(public readonly sessionId: string, public readonly status: string) {
    super('This upload session is no longer accepting photos.')
  }
}

/**
 * MC-06E. A session document whose numbers cannot be trusted.
 *
 * MC-06D found that a non-numeric `creditsPerPhotoAtOpen` or `allocatedCredits` flowed
 * through `Math.trunc` as NaN and settled as ZERO consumption — silently under-charging
 * instead of failing. Only reachable through direct database corruption, since both fields
 * are server-written from config, but 'settle for free' is the wrong failure mode for any
 * input a human might one day edit by hand.
 *
 * Fails CLOSED: the session stays SEALED and is reported, so an operator sees it rather than
 * an organizer silently getting free storage.
 */
export class CorruptSessionDataError extends MediaCreditError {
  readonly code = 'CORRUPT_SESSION_DATA' as const
  constructor(public readonly sessionId: string, public readonly field: string) {
    super(`Session ${sessionId} has an unusable value for ${field}.`)
  }
}

/**
 * MC-05. A refund that policy will not permit.
 *
 * Covers every "no" that is not an overdraft: refunds switched off, the purchase is not
 * yours, it was never granted, the window has closed, a request is already open, it was
 * already refunded, or the net amount is below the minimum worth processing.
 *
 * One type with a machine-readable `reason` rather than seven classes — a caller branches on
 * `reason` when it wants to, and the HTTP layer maps them all to one status either way.
 */
export class RefundNotAllowedError extends MediaCreditError {
  readonly code = 'REFUND_NOT_ALLOWED' as const
  constructor(public readonly reason: string) {
    super(`This refund cannot be requested: ${reason.replace(/_/g, ' ')}.`)
  }
}

/**
 * MC-05. The credits were debited but the gateway payout has not completed.
 *
 * NOT a failed refund — the organizer's credits are gone and the money is owed, recorded on
 * a refund parked at `approved`. It exists so the route answers 202 instead of an error that
 * would invite a second approval and a second payout.
 */
export class RefundSettlementDeferredError extends MediaCreditError {
  readonly code = 'REFUND_SETTLEMENT_DEFERRED' as const
  constructor(public readonly refundId: string, public readonly cause: string) {
    super('Refund approved. The payout is being processed and will complete shortly.')
  }
}
