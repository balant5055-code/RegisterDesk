// MC-01 · Media Credits domain model — TYPES ONLY.
//
// ═══ WHAT THIS SPRINT IS ═════════════════════════════════════════════════════
// The foundation. Shapes, collection names and service contracts, with no runtime
// behaviour: nothing here reads or writes Firestore, and no existing code path imports it.
// Media Studio behaves identically with this module present.
//
// ═══ WHY THESE SHAPES ════════════════════════════════════════════════════════
// Two invariants from the TDD drive every decision below:
//
//   1. The LEDGER is truth; the wallet is a cache.  balance ≡ Σ ledger.delta
//      A wallet field can be recomputed from the ledger. The reverse is impossible, so the
//      ledger is append-only and a correction is a new entry, never an edit.
//
//   2. A reservation is 1↔1 with a `mediaAssets` document and SHARES ITS ID.
//      That makes reservation lookup free at upload-complete and at sweep time — no query,
//      no index, no second source of truth about which upload a hold belongs to.
//
// Ownership is `organizerUid` throughout, the same key Media Studio already isolates on
// (see features/media-studio/repositories/assetRepo.ts). Credits belong to the WORKSPACE;
// licence limits stay per-event. Nothing here changes that split.

// ─── Collections ──────────────────────────────────────────────────────────────

export const MEDIA_CREDIT_WALLETS      = 'mediaCreditWallets'
export const MEDIA_CREDIT_LEDGER       = 'mediaCreditLedger'
export const MEDIA_CREDIT_RESERVATIONS = 'mediaCreditReservations'
export const MEDIA_CREDIT_PURCHASES    = 'mediaCreditPurchases'
export const MEDIA_CREDIT_REFUNDS      = 'mediaCreditRefunds'
/** MC-04. Captured payments whose grant transaction failed. */
export const MEDIA_CREDIT_RECONCILIATIONS = 'mediaCreditReconciliations'
/** MC-06A. Upload-session credit allocations (Architecture Spec v1.0 §5). */
export const MEDIA_CREDIT_SESSIONS     = 'mediaCreditSessions'
/**
 * MC-09 · Manual grant justifications. NOT a second ledger.
 *
 * The credits move through the same single writer as every other movement; this collection
 * stores WHY an admin granted them — reason, reference, note — which the ledger entry has no
 * fields for and should not grow. Exactly parallel to mediaCreditRefunds, which likewise
 * holds a workflow record beside a ledger movement it does not own.
 */
export const MEDIA_CREDIT_GRANTS       = 'mediaCreditGrants'

/** Bumped only by a migration that changes a stored shape. */
export const MEDIA_CREDIT_SCHEMA_VERSION = 1

// ─── Enums ────────────────────────────────────────────────────────────────────

/**
 * Why a ledger entry exists.
 *
 * `release` carries `delta: 0` — releasing a hold returns nothing to the balance because a
 * hold never left it. It is recorded so the ledger explains the wallet's `heldCredits`
 * history, not just its balance.
 */
export type CreditLedgerReason =
  | 'purchase'
  | 'grant'
  | 'consume'
  | 'release'
  | 'refund'
  | 'adjustment'

export const CREDIT_LEDGER_REASONS: readonly CreditLedgerReason[] =
  ['purchase', 'grant', 'consume', 'release', 'refund', 'adjustment']

/** Who caused a ledger entry. `system` is the reclamation sweep. */
export type CreditActorKind = 'organizer' | 'platform' | 'system'

/**
 * Reservation lifecycle. Both non-`held` states are TERMINAL.
 *
 * A consumed reservation is never released — that ordering is what stops a retry from
 * refunding an upload that succeeded.
 */
export type CreditReservationStatus = 'held' | 'consumed' | 'released'

export const CREDIT_RESERVATION_TERMINAL: readonly CreditReservationStatus[] =
  ['consumed', 'released']

export type CreditPurchaseStatus = 'pending' | 'paid' | 'granted' | 'failed'

/**
 * Refund lifecycle.
 *
 *   requested ──► rejected                                  (terminal; nothing financial happened)
 *   requested ──► approved ──► settling ──► settled          (terminal; money returned)
 *                    ▲             │
 *                    └─────────────┘  gateway failed — back to the retry state
 *
 * `approved` is NOT a healthy resting state. It means the credits have been debited inside
 * the approval transaction but the gateway has not yet confirmed the money back. A refund
 * parked there is owed a payout, and the reconciler retries it. This mirrors MC-04's `paid`.
 *
 * `settling` (MC-05.6A) is the CLAIM. Exactly one caller may move a refund out of `approved`
 * into it, and only the winner may call the gateway. Without it, an admin double-click or an
 * approval racing the reconciler could both read `approved` and both issue a real refund —
 * the platform's own `failed-refunds` retry route calls that bug class "H-2 double-refund".
 *
 * `settled` is the MC-05 brief's COMPLETED. The MC-01 vocabulary is kept rather than renamed.
 */
/**
 * RD-MC-REFUND-V2-P3 · `cancelled` is the organizer withdrawing their own request.
 *
 * A separate terminal state from `rejected`, not a reuse of it. They are financially
 * identical — release the hold, move no money, write no ledger entry — but they are different
 * events: one is the platform declining, the other is the organizer changing their mind.
 * Collapsing them would make the admin queue show a decision nobody made.
 *
 * Reachable ONLY from `requested`. After approval the credits have left the wallet and a
 * gateway payout may be in flight; unwinding that is not a cancellation.
 */
export type CreditRefundStatus =
  | 'requested' | 'approved' | 'settling' | 'rejected' | 'settled' | 'cancelled'

export const CREDIT_REFUND_STATUSES: readonly CreditRefundStatus[] =
  ['requested', 'approved', 'settling', 'rejected', 'settled', 'cancelled']

/**
 * RD-MC-REFUND-V2-P3 · the statuses that HOLD credits and so block another request.
 *
 * `settled` is deliberately ABSENT. A settled partial refund leaves the rest of the purchase
 * refundable, and blocking on it would make the first partial refund the last one. What
 * stops over-refunding is `creditsRemaining`, not this list.
 *
 * `rejected` and `cancelled` are absent for the same reason: both released their hold, so
 * neither reserves anything.
 */
export const CREDIT_REFUND_BLOCKING_STATUSES: readonly CreditRefundStatus[] =
  ['requested', 'approved', 'settling']

/**
 * Upload-session lifecycle — Architecture Spec v1.0 §6. THREE states, no others.
 *
 *   ACTIVE ──► SEALED ──► SETTLED
 *
 * `SEALED` is not cosmetic. Firestore forbids aggregation queries inside a transaction, so
 * counting a session's consumed slots must happen OUTSIDE one — which means consumption has
 * to be barred first, and that bar must survive between two transactions.
 *
 * Why a caller may only ever seal and never jump to SETTLED: the count taken between the two
 * is only stable because nothing can be consumed after the seal.
 */
export type CreditSessionStatus = 'ACTIVE' | 'SEALED' | 'SETTLED'

export const CREDIT_SESSION_STATUSES: readonly CreditSessionStatus[] =
  ['ACTIVE', 'SEALED', 'SETTLED']

/**
 * WHY a session was sealed — a field, not a state.
 *
 * Both paths converge on SETTLED, so settlement has one code path and one idempotency key.
 * This follows the precedent set for reservations, where a sweep-initiated release is
 * distinguished by `actorKind` rather than by a fourth reservation state.
 */
export type CreditSessionSealReason = 'CLOSED' | 'EXPIRED'

/**
 * mediaCreditSessions/{sessionId} — Architecture Spec v1.0 §5.
 *
 * A bounded allocation of credits for one upload batch. Written exactly twice in its life
 * (open, settle) plus once to seal — NEVER per photo. That is the whole point: a per-photo
 * write to this document would reintroduce the hot-document bottleneck it exists to remove.
 */
export interface CreditSessionDoc {
  /** Caller-supplied, so `open` is idempotent by document creation. */
  sessionId:      string
  schemaVersion:  number
  organizerUid:   string
  eventId:        string
  eventSlug:      string
  galleryId:      string

  /** Credits moved to `held` at open. Released or charged at settlement. */
  allocatedCredits: number
  /** Slot bound. A slot index must be < this. Enforced arithmetically, with no counter. */
  slotCount:        number
  /**
   * Frozen at open so an admin changing pricing mid-session cannot re-price photos the
   * organizer already uploaded. Spec v1.0 §19.
   */
  creditsPerPhotoAtOpen: number

  status:      CreditSessionStatus
  sealReason:  CreditSessionSealReason | null
  sealedBy:    string | null

  /**
   * Written ONCE, at settlement — never incremented per photo. Null until then.
   * Spec v1.0 §5: a per-photo counter here is exactly the shared write §3 P3 forbids.
   */
  consumedSlots:      number | null
  settlementEntryId:  string | null

  // ─── Poison-session protection (MC-06F) ─────────────────────────────────────
  /** Failed settlement attempts. Reset never; only ever climbs. */
  settlementAttempts: number
  /**
   * Excluded from the settlement queue after too many failures.
   *
   * A FIELD, not a fourth status — Spec §6 fixes the lifecycle at three states, and the
   * precedent is `sealReason`: information about a session, not a stage of it. A quarantined
   * session is still SEALED and still owed a resolution; it has simply stopped blocking
   * everyone else's.
   */
  quarantined:        boolean
  quarantinedAt:      unknown | null

  openedAt:   unknown
  expiresAt:  unknown
  sealedAt:   unknown | null
  settledAt:  unknown | null
}

/** Wire shape. No Firestore Timestamp crosses the boundary. */
export interface CreditSessionDto {
  sessionId:        string
  status:           CreditSessionStatus
  allocatedCredits: number
  slotCount:        number
  creditsPerPhotoAtOpen: number
  consumedSlots:    number | null
  sealReason:       CreditSessionSealReason | null
  openedAtMs:       number
  expiresAtMs:      number
  sealedAtMs:       number | null
  settledAtMs:      number | null
}

/**
 * Where a purchase's money came from, and therefore where a refund must return it.
 *
 * Only `razorpay` exists — every purchase MC-04 can create is a Razorpay order. The field is
 * stored rather than assumed so refund routing switches on recorded fact instead of an
 * implicit platform-wide truth that would be wrong the day a second source appears.
 */
export type CreditPurchaseSource = 'razorpay'

/** How a refund's service charge was computed. Snapshotted per refund. */
export type ServiceChargeMethod = 'percent' | 'fixed' | 'percent_plus_fixed'

// ─── Documents ────────────────────────────────────────────────────────────────

/**
 * mediaCreditWallets/{organizerUid} — one per workspace.
 *
 * A CACHE of the ledger, held for read cost. `available` is deliberately NOT stored: it is
 * `balance - heldCredits`, and a stored copy would be a third number able to disagree with
 * the other two.
 */
export interface CreditWalletDoc {
  organizerUid:     string
  schemaVersion:    number
  /** Credits owned. Integer; credits are not divisible. */
  balance:          number
  /** Credits locked by OPEN UPLOAD SESSIONS. Never negative. */
  heldCredits:      number
  /**
   * RD-MC-REFUND-V2-P3 · credits locked by PENDING REFUND REQUESTS. Never negative.
   *
   * ═══ WHY THIS IS NOT `heldCredits` ═══════════════════════════════════════
   * Both reduce `available` identically, so one scalar would compute the same number. They
   * are separate because they are released by different code on different timescales, and
   * conflating them makes every accounting question unanswerable:
   *
   *   · `settleSessionInTx` lowers `heldCredits` by a session's allocation. If a refund hold
   *     shared that scalar, a session-accounting bug would silently eat it, and the clamp at
   *     zero would hide the damage.
   *   · An operator looking at a stuck wallet must be able to tell "an upload never settled"
   *     from "a refund is waiting for review" — different people fix those.
   *
   * INVARIANT I5: `refundHeldCredits == Σ credits of refunds in status 'requested'`.
   *
   * Absent on wallets written before P3; `?? 0` on read, which is correct — a wallet with no
   * field has no pending refund hold.
   */
  refundHeldCredits?: number
  lifetimeGranted:  number
  lifetimeConsumed: number
  updatedAt:        unknown
}

/** mediaCreditLedger/{entryId} — APPEND-ONLY. Never updated, never deleted. */
export interface CreditLedgerEntryDoc {
  entryId:       string
  schemaVersion: number
  organizerUid:  string
  /** Signed. Negative for consumption and refund; zero for a release. */
  delta:         number
  reason:        CreditLedgerReason
  /** Wallet balance immediately after this entry — an audit snapshot, not a source. */
  balanceAfter:  number

  assetId:       string | null
  reservationId: string | null
  purchaseId:    string | null
  refundId:      string | null
  eventId:       string | null
  eventSlug:     string | null

  actorUid:      string
  actorKind:     CreditActorKind
  createdAt:     unknown
}

/**
 * mediaCreditReservations/{assetId} — the document id IS the assetId.
 *
 * Sharing the id is what makes this free to look up from the upload path, and makes a
 * duplicate hold for one asset unrepresentable rather than merely unlikely.
 */
export interface CreditReservationDoc {
  reservationId: string          // === assetId
  schemaVersion: number
  organizerUid:  string
  eventId:       string
  eventSlug:     string
  galleryId:     string
  /**
   * Credits this slot will cost at settlement, copied from the session's
   * `creditsPerPhotoAtOpen`. Recorded for audit — it no longer drives any wallet write,
   * because a slot is already paid for by the session's hold (Spec v1.0 §8).
   */
  credits:       number

  // ─── Session linkage (MC-06B, Spec v1.0 §11) ────────────────────────────────
  /** The session whose allocation authorises this slot. */
  sessionId:     string
  /** Position within the session. `assetId === deriveAssetId(sessionId, slotIndex)`. */
  slotIndex:     number

  status:        CreditReservationStatus
  createdAt:     unknown
  resolvedAt:    unknown | null
}

/** mediaCreditPurchases/{purchaseId} */
export interface CreditPurchaseDoc {
  purchaseId:      string
  schemaVersion:   number
  organizerUid:    string
  credits:         number
  amountPaise:     number
  unitPricePaise:  number
  currency:        'INR'
  /**
   * `pending` → `granted` is the whole happy path, and both transitions the organizer's
   * money can take are terminal from there.
   *
   * `paid` is NOT a stage of a healthy purchase — under MC-04 the grant is atomic, so a
   * purchase is never observably "paid but not granted" when things work. It exists for the
   * one case that must never be silent: Razorpay captured the money and the Firestore
   * transaction then failed. The purchase parks at `paid` with a reconciliation record
   * naming the debt, rather than being marked `failed` and losing it.
   */
  status:          CreditPurchaseStatus
  gatewayOrderId:   string | null
  gatewayPaymentId: string | null
  /** The tier the price was quoted at, retained so a later tier change cannot rewrite history. */
  tierAtPurchase:  string | null

  // ─── Pricing snapshot (MC-04) ───────────────────────────────────────────────
  // `unitPricePaise` above already froze what a credit COST. This freezes what a credit was
  // WORTH: change `creditsPerPhoto` from 1 to 2 tomorrow and every historical purchase would
  // otherwise appear to have bought half as many photos as the organizer was actually sold.
  // Price and value are independent config keys, so a snapshot of one is not a snapshot of
  // the other.
  creditsPerPhotoAtPurchase: number

  /** MC-05. Determines refund routing. Recorded, never inferred. */
  source:          CreditPurchaseSource

  createdAt:       unknown
  updatedAt:       unknown
  /** Set once, when the grant transaction commits. Never rewritten. */
  grantedAt:       unknown | null
  /** Populated only on a `failed` purchase, for support to read without a log dive. */
  failureReason:   string | null

  // ─── RD-MC-REFUND-V2-P1 · credit lot ────────────────────────────────────────
  /**
   * Credits from this batch that are still unspent.
   *
   * The wallet remains the single pooled balance; this records WHERE that balance came
   * from, which the ledger cannot — a `consume` entry names no purchase and never
   * could, because a session spends the wallet rather than a batch.
   *
   * Absent on documents written before this sprint; `?? credits` on read is the
   * backfill, so no migration job is required.
   */
  creditsRemaining?: number
  /**
   * FIFO ordering key, present ONLY while `creditsRemaining > 0`.
   *
   * Sparse deliberately: Firestore omits documents missing an ordered field, so a drained
   * lot leaves the open-lot query altogether. Without it every settlement would page
   * through every purchase the organizer has ever made, inside a transaction.
   */
  lotSeq?:           number | null
}

/**
 * mediaCreditReconciliations/{gatewayOrderId} — the debt ledger for captured-but-not-granted.
 *
 * Written ONLY when a verified payment could not be turned into credits. Keyed by order id
 * so a retried verify overwrites rather than duplicating the claim.
 *
 * This collection existing is the difference between "we owe this organizer credits and here
 * is the record" and a support ticket with no evidence.
 */
export interface CreditReconciliationDoc {
  gatewayOrderId:   string
  schemaVersion:    number
  organizerUid:     string
  purchaseId:       string
  gatewayPaymentId: string
  credits:          number
  amountPaise:      number
  /** `pending` until a drain grants the credits, then `resolved`. */
  status:           'pending' | 'resolved'
  attempts:         number
  lastError:        string
  createdAt:        unknown
  updatedAt:        unknown
  resolvedAt:       unknown | null
}

/** mediaCreditRefunds/{refundId} */
/**
 * What the service charge was, at the moment the request was made.
 *
 * Snapshotted rather than referenced. A refund approved next month must settle on the terms
 * the organizer was shown when they asked, not on whatever the config says at approval time —
 * otherwise an admin changing the percentage silently re-prices every queued request.
 */
export interface ServiceChargeSnapshot {
  method:      ServiceChargeMethod
  percent:     number
  fixedPaise:  number
  /** The computed charge. Stored so no reader ever re-derives it. */
  amountPaise: number
}

/**
 * What the wallet looked like when the refund was requested.
 *
 * Evidence, not a control: approval re-reads the live wallet inside the transaction and
 * re-validates. This exists so a rejected or disputed request can be explained months later
 * without reconstructing history from the ledger.
 */
export interface WalletSnapshot {
  balance:   number
  held:      number
  available: number
}

export interface CreditRefundDoc {
  refundId:      string
  schemaVersion: number
  organizerUid:  string
  /**
   * Credits to remove from the wallet.
   *
   * RD-MC-REFUND-V2-P2: this is the purchase's UNUSED credits, not all of them. Equal to
   * `creditsRemainingAtRequest` at the moment the request is written; kept separate because
   * this one is the instruction to the wallet and that one is the evidence it was based on.
   */
  credits:       number
  /**
   * The purchase being refunded. NOT nullable in MC-05.
   *
   * A refund is scoped to exactly one purchase because that is the only scope whose value is
   * knowable — the purchase's own frozen `unitPricePaise` prices it, so two purchases made at
   * different prices can never contaminate each other.
   *
   * RD-MC-REFUND-V2-P2 · MC-05 required that purchase to be WHOLLY unused, because the ledger
   * could not attribute consumption to a lot and "50 loose credits" therefore had no
   * defensible price. Phase 1's FIFO lots removed that limitation: `creditsRemaining` says
   * exactly how many of THIS purchase's credits are unspent.
   */
  purchaseId:    string
  reason:        string
  status:        CreditRefundStatus
  requestedBy:   string
  decidedBy:     string | null
  decisionNote:  string | null

  // ─── Money (MC-05) ──────────────────────────────────────────────────────────
  /**
   * The purchase's original amount, copied from its snapshot. Never recomputed.
   *
   * RD-MC-REFUND-V2-P2 · CONTEXT, not the basis. What the organizer paid in full — shown so a
   * partial refund explains itself ("₹499 of the ₹500 you paid"). The figure the money is
   * calculated on is `refundBasePaise`.
   */
  purchaseAmountPaise: number
  /**
   * RD-MC-REFUND-V2-P2 · `creditsRemainingAtRequest × unitPricePaise`, frozen.
   *
   * THE base. `serviceCharge` is computed on this and `refundAmountPaise` is this minus that
   * charge — so the three numbers are one calculation, recorded once, and approval can pay
   * out without recomputing anything.
   *
   * Equals `purchaseAmountPaise` exactly when the purchase is wholly unused, because
   * `pricePack` multiplies without rounding. Absent on refunds written before P2, where the
   * base WAS the purchase amount — `?? purchaseAmountPaise` on read.
   */
  refundBasePaise?:    number
  /**
   * RD-MC-REFUND-V2-P2 · what the lot held when the organizer was quoted.
   *
   * Not a duplicate of `credits`, which is the instruction to the wallet. This is the evidence
   * the quote rested on, and approval compares it against the LIVE lot: if the organizer spent
   * credits while the request sat in the queue, the two disagree and the approval is refused
   * rather than paying out against a lot that can no longer cover it.
   */
  creditsRemainingAtRequest?: number
  /**
   * RD-MC-REFUND-V2-P3 · how many credits the purchase bought in total.
   *
   * Snapshot, like `purchaseAmountPaise` beside it. Stored rather than derived because the
   * alternative is dividing `purchaseAmountPaise` by `unitPricePaise` on a screen that
   * approves money — arithmetically exact today, and a silent lie the moment a purchase is
   * ever priced any other way.
   *
   * Lets the admin see `Purchased − Used = Remaining` and check that Held matches what is
   * about to be debited. Absent before P3; `?? credits` on read, which is what those refunds
   * were — whole-purchase.
   */
  purchaseCreditsAtRequest?: number
  /**
   * RD-MC-REFUND-V2-P3 · the purchase lot's FIFO ordering key, removed when this request was
   * made and put back if it is rejected or cancelled.
   *
   * Requesting a refund takes the lot out of the open-lot query so uploads cannot consume the
   * credits it reserves. Restoring the ORIGINAL key returns it to its true place in the
   * queue; a fresh timestamp would send it to the back and change which credits a later
   * refund is entitled to.
   *
   * Null when the lot had no key to remove. Absent on refunds written before P3 — those never
   * reserved a lot, so there is nothing to restore.
   */
  lotSeqAtRequest?: number | null
  /** `refundBasePaise - serviceCharge.amountPaise`. What actually goes back. */
  refundAmountPaise:   number
  serviceCharge:       ServiceChargeSnapshot
  /** Pricing the purchase was made at, carried forward so the refund explains itself. */
  unitPricePaise:            number
  creditsPerPhotoAtPurchase: number
  currency:                  'INR'

  // ─── Routing + gateway references (MC-05) ───────────────────────────────────
  /** Where the money goes back to. Derived from the PURCHASE, never from the client. */
  refundMethod:      CreditPurchaseSource
  /** The purchase's payment, needed to issue the gateway refund. */
  gatewayPaymentId:  string | null
  /** Razorpay's refund id, once created. The idempotency anchor for retries. */
  gatewayRefundId:   string | null
  /** Trimmed gateway response, for support and dispute evidence. */
  gatewayResponse:   Record<string, unknown> | null
  /** Last gateway error, when a settlement attempt failed. Cleared on success. */
  gatewayError:      string | null
  gatewayAttempts:   number
  /**
   * MC-05.6A. When the current `settling` claim was taken; null whenever not claimed.
   *
   * Its own field rather than `updatedAt`, which moves for unrelated reasons — staleness of
   * a claim must be answerable from one value that means exactly one thing. A claim older
   * than the stale window is assumed abandoned (the holder crashed) and may be re-taken.
   */
  settlingSince:     unknown | null

  walletAtRequest:   WalletSnapshot

  createdAt:     unknown
  updatedAt:     unknown
  decidedAt:     unknown | null
  settledAt:     unknown | null
}

// ─── DTOs (wire shapes; no Firestore Timestamp crosses the boundary) ──────────

export interface CreditBalanceDto {
  balance:   number
  /** Locked by open upload sessions. */
  held:      number
  /** RD-MC-REFUND-V2-P3 · locked by pending refund requests. */
  refundHeld: number
  /**
   * Derived: `balance − held − refundHeld`. The only number an upload gate may consult.
   *
   * Both holds subtract, so an organizer with a pending refund sees their spendable figure
   * fall the moment they ask — which is the point. `balance` is unchanged until an admin
   * approves, and the two numbers together are what let the dashboard explain the gap.
   */
  available: number
  tier:      string | null

  // ─── Lifetime totals (MC-07) ────────────────────────────────────────────────
  // Already maintained on the wallet document by `applyDelta` — surfaced here rather than
  // recomputed. A dashboard summing the ledger to get these would be a SECOND place a
  // financial figure is derived, which is exactly what the wallet cache exists to prevent.
  /** Every credit ever added, by purchase or grant. Never decreases. */
  lifetimeGranted:  number
  /** Every credit ever spent. Never decreases. */
  lifetimeConsumed: number
}

export interface CreditLedgerEntryDto {
  entryId:      string
  delta:        number
  reason:       CreditLedgerReason
  balanceAfter: number
  assetId:      string | null
  eventSlug:    string | null
  createdAtMs:  number
}

export interface CreditPricingDto {
  creditsPerPhoto: number
  unitPricePaise:  number
  tier:            string | null
  /** Which config layer won, straight from the existing resolver's provenance. */
  source:          'event' | 'plan' | 'global'
}

export interface CreditPurchaseDto {
  purchaseId:   string
  credits:      number
  amountPaise:  number
  status:       CreditPurchaseStatus
  createdAtMs:  number
  /**
   * MC-11 · When the credits actually landed. Null until granted.
   *
   * The refund window runs from the GRANT, not the purchase — the organizer's clock starts
   * when they can spend, not when they clicked buy — so an eligibility check over a page of
   * purchases needs this on the list DTO rather than only on the detail one.
   */
  grantedAtMs:  number | null
  /**
   * RD-MC-REFUND-V2-P2 · the price these credits were bought at, frozen at purchase.
   *
   * On the list DTO for the same reason `grantedAtMs` is: a partial refund is priced at
   * `creditsRemaining × unitPricePaise`, and pricing a page of purchases must use each one's
   * OWN price. A wallet-wide rate would refund ₹2 credits at ₹1.
   */
  unitPricePaise: number
}

/**
 * A single purchase, for the detail endpoint.
 *
 * Deliberately NOT `CreditPurchaseDoc`: the stored document is an internal shape and
 * returning it wholesale is how gateway internals leak into a client payload one field at a
 * time. Every field here was chosen.
 */
export interface CreditPurchaseDetailDto extends CreditPurchaseDto {
  unitPricePaise:            number
  creditsPerPhotoAtPurchase: number
  currency:                  'INR'
  tierAtPurchase:            string | null
  /** Shown on a receipt and needed for a support conversation. Safe to expose. */
  gatewayOrderId:            string | null
  gatewayPaymentId:          string | null
  grantedAtMs:               number | null
  failureReason:             string | null
}

/** What `createPurchaseIntent` hands the browser. The client computes NOTHING. */
export interface CreditPurchaseIntentDto {
  purchaseId:      string
  gatewayOrderId:  string
  /** Server-computed. Sent for display only — the charge is whatever the order says. */
  amountPaise:     number
  credits:         number
  currency:        'INR'
  /** Publishable key id. Not a secret; Razorpay Checkout requires it client-side. */
  keyId:           string
}

export interface CreditRefundDto {
  refundId:     string
  credits:      number
  reason:       string
  status:       CreditRefundStatus
  purchaseId:   string
  /** What the organizer gets back, net of the service charge. */
  refundAmountPaise: number
  createdAtMs:  number
  decidedAtMs:  number | null
}

/**
 * One refund in full.
 *
 * Deliberately not `CreditRefundDoc`: `gatewayResponse` holds raw gateway payload and
 * `decisionNote` may carry internal wording. Every field below was chosen for the organizer.
 */
export interface CreditRefundDetailDto extends CreditRefundDto {
  /**
   * MC-11 · Who requested it. Needed by the admin queue, which triages across workspaces.
   *
   * On the DETAIL shape only, not the base DTO: an organizer listing their own refunds
   * learns nothing from being told their own uid, and the admin console cannot name a row
   * without it.
   */
  organizerUid:              string
  /** What the purchase cost in full. CONTEXT for a partial refund, not its basis. */
  purchaseAmountPaise:       number
  /**
   * RD-MC-REFUND-V2-P2 · the frozen basis: unused credits × this purchase's unit price.
   *
   * Always present on the DTO even though the document field is optional — refunds written
   * before P2 backfill to `purchaseAmountPaise`, which is what their base was.
   */
  refundBasePaise:           number
  /** RD-MC-REFUND-V2-P2 · unused credits when the terms were quoted. */
  creditsRemainingAtRequest: number
  /** RD-MC-REFUND-V2-P3 · credits the purchase bought in total. `Used` is this minus the above. */
  purchaseCreditsAtRequest:  number
  serviceCharge:             ServiceChargeSnapshot
  unitPricePaise:            number
  creditsPerPhotoAtPurchase: number
  currency:                  'INR'
  refundMethod:              CreditPurchaseSource
  /** Safe to show — it appears on the organizer's card statement. */
  gatewayRefundId:           string | null
  decisionNote:              string | null
  walletAtRequest:           WalletSnapshot
  settledAtMs:               number | null
}

/** What a refund would cost and return, computed before anything is written. */
export interface RefundQuoteDto {
  purchaseId:          string
  /** RD-MC-REFUND-V2-P2 · the UNUSED credits this quote covers, not the purchase size. */
  credits:             number
  purchaseAmountPaise: number
  serviceCharge:       ServiceChargeSnapshot
  refundAmountPaise:   number
}

// ─── MC-09 · Manual grants ────────────────────────────────────────────────────

/**
 * Why an admin granted credits.
 *
 * A closed set rather than free text so grants can be counted and filtered. The free-text
 * justification lives in `note`, which is required precisely because the category alone
 * never explains a specific grant.
 */
export type CreditGrantReason =
  | 'goodwill'
  | 'compensation'
  | 'promotional'
  | 'migration'
  | 'correction'
  | 'support'

export const CREDIT_GRANT_REASONS: readonly CreditGrantReason[] =
  ['goodwill', 'compensation', 'promotional', 'migration', 'correction', 'support']

/**
 * mediaCreditGrants/{grantId} — the justification for a manual grant.
 *
 * The document id IS the idempotency key: it is supplied by the caller and the ledger entry
 * is `grant:{grantId}`, so the grant record and the balance movement share one identity and
 * cannot diverge. Written with `tx.create` inside the same transaction as the credit, so a
 * grant with no ledger entry — or a ledger entry with no justification — is unrepresentable.
 *
 * APPEND-ONLY. A grant is never edited or reversed here; reversing one is a `debit` with
 * reason `adjustment`, which leaves both movements visible in the ledger.
 */
export interface CreditGrantDoc {
  grantId:       string
  schemaVersion: number
  organizerUid:  string
  /** Positive. The magnitude added to the wallet. */
  credits:       number
  reason:        CreditGrantReason
  /** Required free text. The category never explains a specific grant on its own. */
  note:          string
  /** Optional external pointer — a ticket, an invoice, an email thread. */
  reference:     string | null
  /** The admin who granted. Never the organizer. */
  actorUid:      string
  /** The ledger entry this grant created. Always `grant:{grantId}`. */
  entryId:       string
  /** Wallet balance immediately after. An audit snapshot, not a source. */
  balanceAfter:  number
  createdAt:     unknown

  // ─── RD-MC-REFUND-V2-P1 · credit lot ────────────────────────────────────────
  /**
   * Credits from this batch that are still unspent.
   *
   * The wallet remains the single pooled balance; this records WHERE that balance came
   * from, which the ledger cannot — a `consume` entry names no purchase and never
   * could, because a session spends the wallet rather than a batch.
   *
   * Absent on documents written before this sprint; `?? credits` on read is the
   * backfill, so no migration job is required.
   */
  creditsRemaining?: number
  /**
   * FIFO ordering key, present ONLY while `creditsRemaining > 0`.
   *
   * Sparse deliberately: Firestore omits documents missing an ordered field, so a drained
   * lot leaves the open-lot query altogether. Without it every settlement would page
   * through every purchase the organizer has ever made, inside a transaction.
   */
  lotSeq?:           number | null
}

/** One grant, as the admin console reads it. */
export interface CreditGrantDto {
  grantId:      string
  organizerUid: string
  credits:      number
  reason:       CreditGrantReason
  note:         string
  reference:    string | null
  actorUid:     string
  entryId:      string
  balanceAfter: number
  createdAtMs:  number
}
