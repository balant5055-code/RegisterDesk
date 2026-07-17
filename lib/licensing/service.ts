// Event License Service — the single public API for Event License operations.
//
// Phase D3.2 introduced the class with placeholder lifecycle methods. Phase D4.2
// implements the PURCHASE business logic (validation + upgrade pricing + purchase
// preparation). These purchase methods are PURE: they perform no Firestore reads
// or writes, call no payment provider, create no orders/history, and mutate no
// event. Current license/event state is supplied by the caller via a
// LicensePreparationContext, so the service never reads the database itself.
//
// The lifecycle methods (createLicense, activateLicense, …) that actually mutate
// state remain placeholders until later phases.

import {
  EVENT_LICENSE_TIERS,
  getEventLicenseDefinition,
  isEventLicenseTier,
  type EventLicenseTier,
  type LicenseVersion,
} from './eventLicense'
import type {
  EventLicenseDoc,
  LicenseOrderDoc,
  LicenseHistoryDoc,
} from './schema'
import type { LicenseRepositories } from './repository'
import type {
  PurchaseLicenseRequest,
  PurchaseLicenseResponse,
  LicenseUpgradeRequest,
  LicenseUpgradeResponse,
  PurchaseValidationResult,
  PurchaseReceipt,
  PurchaseCheckout,
  PurchaseMethod,
  PurchaseFailureReason,
} from './purchase'

// ─── Operation inputs ───────────────────────────────────────────────────────────

export interface CreateLicenseInput {
  eventId:      string
  organizerUid: string
  tier:         EventLicenseTier
  version?:     LicenseVersion   // defaults to CURRENT_LICENSE_VERSION in the impl
}

export interface ActivateLicenseInput {
  eventId:  string
  orderId?: string | null
}

export interface CancelLicenseInput {
  eventId: string
  reason?: string
}

export interface ArchiveLicenseInput {
  eventId: string
}

/**
 * Current state the caller must supply for the PURE purchase/upgrade methods.
 * The caller (a later phase) performs the Firestore reads and passes the result
 * here so the service itself stays read-free.
 */
export interface LicensePreparationContext {
  eventExists: boolean
  currentTier: EventLicenseTier | null   // null = event has no license yet
  // Effective (config-resolved) price for the requested tier. When supplied it is
  // authoritative; when omitted the service falls back to the eventLicense.ts code
  // default, so existing callers keep working unchanged.
  pricePaise?: number
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Central Event License Service. Constructed with the repository set (dependency
 * injection). Purchase/upgrade methods are pure; lifecycle methods are D4.3+.
 */
export class EventLicenseService {
  constructor(private readonly repos: LicenseRepositories) {}

  // ─── Purchase flow (D4.2 — pure, no I/O) ──────────────────────────────────────

  /**
   * Validate an initial license purchase against the supplied context. Fails when
   * the tier is invalid, the event is missing, or the event is already licensed.
   */
  validatePurchase(
    request: PurchaseLicenseRequest,
    context: LicensePreparationContext,
  ): PurchaseValidationResult {
    const errors: string[] = []
    let failureReason: PurchaseFailureReason | undefined

    if (!isEventLicenseTier(request.tier)) {
      errors.push(`Invalid license tier: ${String(request.tier)}`)
      failureReason = failureReason ?? 'invalid_tier'
    }
    if (!context.eventExists) {
      errors.push(`Event '${request.eventId}' not found`)
      failureReason = failureReason ?? 'event_not_found'
    }
    if (context.currentTier !== null) {
      errors.push(`Event '${request.eventId}' already has a '${context.currentTier}' license`)
      failureReason = failureReason ?? 'already_licensed'
    }

    return { valid: errors.length === 0, errors, failureReason }
  }

  /**
   * Validate a license upgrade. Enforces upgrade-only: the target must be a valid
   * tier, strictly higher than the current tier (no same-tier, no downgrade), and
   * the event must already hold a license.
   */
  validateUpgrade(
    request: LicenseUpgradeRequest,
    context: LicensePreparationContext,
  ): PurchaseValidationResult {
    const errors: string[] = []
    let failureReason: PurchaseFailureReason | undefined

    if (!isEventLicenseTier(request.toTier)) {
      errors.push(`Invalid target tier: ${String(request.toTier)}`)
      failureReason = failureReason ?? 'invalid_tier'
    }
    if (!context.eventExists) {
      errors.push(`Event '${request.eventId}' not found`)
      failureReason = failureReason ?? 'event_not_found'
    }

    const current = context.currentTier
    if (current === null) {
      errors.push(`Event '${request.eventId}' has no license to upgrade`)
      failureReason = failureReason ?? 'unknown'
    } else if (isEventLicenseTier(request.toTier)) {
      if (request.toTier === current) {
        errors.push(`Event '${request.eventId}' is already on the '${current}' tier`)
        failureReason = failureReason ?? 'already_licensed'
      } else if (this.tierRank(request.toTier) < this.tierRank(current)) {
        errors.push(`Downgrade from '${current}' to '${request.toTier}' is not allowed`)
        failureReason = failureReason ?? 'downgrade_not_allowed'
      }
    }

    return { valid: errors.length === 0, errors, failureReason }
  }

  /**
   * Pay-the-difference upgrade price in paise: max(0, price(to) − price(from)).
   * For an upgrade to Enterprise (contact-sales, price 0) this yields 0 — the
   * caller treats a contact-sales target as custom pricing.
   */
  calculateUpgradePrice(fromTier: EventLicenseTier, toTier: EventLicenseTier): number {
    const fromPaise = getEventLicenseDefinition(fromTier).licensePricePaise
    const toPaise   = getEventLicenseDefinition(toTier).licensePricePaise
    return Math.max(0, toPaise - fromPaise)
  }

  /**
   * Validate and PREPARE an initial purchase. Returns a prepared response (with an
   * in-memory receipt and, for paid Razorpay purchases, a checkout descriptor). It
   * does NOT create an order, charge, or persist anything — orderId is left blank
   * for the order-creation phase (D4.3).
   */
  purchaseLicense(
    request: PurchaseLicenseRequest,
    context: LicensePreparationContext,
  ): PurchaseLicenseResponse {
    const validation = this.validatePurchase(request, context)
    if (!validation.valid) {
      return {
        ok: false, status: 'failed',
        failureReason: validation.failureReason ?? 'unknown',
        message: validation.errors.join('; '),
      }
    }

    const amountPaise = context.pricePaise ?? getEventLicenseDefinition(request.tier).licensePricePaise
    const receipt     = this.buildReceipt(request.eventId, request.organizerUid, request.tier, amountPaise, request.method)
    const checkout    = this.buildCheckout(request.method, amountPaise)

    return checkout
      ? { ok: true, status: 'created', receipt, checkout }
      : { ok: true, status: 'created', receipt }
  }

  /**
   * Validate and PREPARE an upgrade. Returns the from/to tiers, the
   * pay-the-difference amount, an in-memory receipt, and (for paid Razorpay
   * upgrades) a checkout descriptor. Persists nothing and charges nothing.
   */
  upgradeLicense(
    request: LicenseUpgradeRequest,
    context: LicensePreparationContext,
  ): LicenseUpgradeResponse {
    const validation = this.validateUpgrade(request, context)
    if (!validation.valid) {
      return {
        ok: false, status: 'failed',
        failureReason: validation.failureReason ?? 'unknown',
        message: validation.errors.join('; '),
      }
    }

    // validateUpgrade guarantees a non-null current tier when valid; re-checked
    // here to narrow the type.
    const fromTier = context.currentTier
    if (fromTier === null) {
      return { ok: false, status: 'failed', failureReason: 'unknown', message: 'No existing license to upgrade' }
    }
    const toTier               = request.toTier
    const priceDifferencePaise = this.calculateUpgradePrice(fromTier, toTier)
    const receipt              = this.buildReceipt(request.eventId, request.organizerUid, toTier, priceDifferencePaise, request.method)
    const checkout             = this.buildCheckout(request.method, priceDifferencePaise)

    return checkout
      ? { ok: true, status: 'created', fromTier, toTier, priceDifferencePaise, receipt, checkout }
      : { ok: true, status: 'created', fromTier, toTier, priceDifferencePaise, receipt }
  }

  // ─── Pure helpers ─────────────────────────────────────────────────────────────

  /** Ordinal rank of a tier along Starter → Growth → Professional → Enterprise. */
  private tierRank(tier: EventLicenseTier): number {
    return EVENT_LICENSE_TIERS.indexOf(tier)
  }

  /** Build an in-memory (not-yet-persisted) purchase receipt. */
  private buildReceipt(
    eventId: string,
    organizerUid: string,
    tier: EventLicenseTier,
    amountPaise: number,
    method: PurchaseMethod,
  ): PurchaseReceipt {
    return {
      orderId:           '',            // assigned when the order is created (D4.3)
      eventId,
      organizerUid,
      tier,
      amountPaise,
      currency:          'INR',
      method,
      status:            'created',
      razorpayOrderId:   null,
      razorpayPaymentId: null,
      issuedAt:          new Date().toISOString(),
    }
  }

  /** A checkout descriptor is only needed for a paid self-serve (Razorpay) charge. */
  private buildCheckout(method: PurchaseMethod, amountPaise: number): PurchaseCheckout | null {
    if (method !== 'razorpay' || amountPaise <= 0) return null
    return { provider: 'razorpay', razorpayOrderId: null, amountPaise, currency: 'INR', keyId: null }
  }

  // ─── Lifecycle placeholders (implemented in D4.3+) ──────────────────────────────

  /** Create the (pending, or free-active) license for an event. */
  createLicense(input: CreateLicenseInput): Promise<EventLicenseDoc> {
    return this.notImplemented('createLicense', [input])
  }

  /** Read the license attached to an event, or null if none exists. */
  getLicense(eventId: string): Promise<EventLicenseDoc | null> {
    return this.notImplemented('getLicense', [eventId])
  }

  /** Activate a pending license (e.g. after its order is captured). */
  activateLicense(input: ActivateLicenseInput): Promise<EventLicenseDoc> {
    return this.notImplemented('activateLicense', [input])
  }

  /** Cancel an event's license. */
  cancelLicense(input: CancelLicenseInput): Promise<EventLicenseDoc> {
    return this.notImplemented('cancelLicense', [input])
  }

  /** Archive an event's license (frees a Starter active-event slot). */
  archiveLicense(input: ArchiveLicenseInput): Promise<EventLicenseDoc> {
    return this.notImplemented('archiveLicense', [input])
  }

  /** List the immutable history for an event's license, most recent first. */
  getLicenseHistory(eventId: string): Promise<LicenseHistoryDoc[]> {
    return this.notImplemented('getLicenseHistory', [eventId])
  }

  /** Read a license order by id, or null if none exists. */
  getLicenseOrder(orderId: string): Promise<LicenseOrderDoc | null> {
    return this.notImplemented('getLicenseOrder', [orderId])
  }

  /**
   * Placeholder for lifecycle methods still pending. References the injected
   * repositories and the call arguments so the wiring is exercised.
   */
  private notImplemented(method: string, args: readonly unknown[]): never {
    const wired = this.repos != null
    throw new Error(
      `EventLicenseService.${method}() is not implemented yet (arrives in D4.3+). ` +
      `(${args.length} argument(s); repositories wired: ${wired})`,
    )
  }
}

/** Factory for the Event License Service. Constructing it has no side effects. */
export function createEventLicenseService(repos: LicenseRepositories): EventLicenseService {
  return new EventLicenseService(repos)
}
