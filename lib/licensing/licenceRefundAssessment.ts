// RD-SA-COMMERCE-P1 · what a Super Admin licence refund would do — PURE, no I/O.
//
// The licence refund returns the ACTIVATION order's full charged amount (the only refund amount the
// existing policy defines for this action). This module does not invent a partial-refund formula.
// It works out, from records that already exist, what that full refund would take back and whether
// it can be done safely:
//
//   capacity  — the activation order's own pricing snapshot says how many seats it CHARGED for
//               (`capacityChange.chargeableCapacity`). A refund returns that money, so those seats
//               come off the event's capacity — but never below the registrations already taken.
//   services  — the order's prepaid units still unused are retired (the existing rule, unchanged);
//               units already consumed cannot be taken back.
//
// When the full refund would return money for something already used — paid seats now holding
// registrations, or prepaid units already consumed — or when the records cannot say what the
// refund would take back, the refund is NOT executed: it needs a Super Admin decision (the policy
// has no amount for a partial refund). Those cases are returned as `conflicts`.

export interface RefundServiceLine { purchased: number; consumed: number; carriedOut: number; refunded: number }

export interface LicenceRefundAssessmentInput {
  /** `eventLicenses/{slug}` — only `commercialModel` is read. */
  licence:          { commercialModel?: unknown }
  /** The activation order (`licenseOrders/lic_*`), or null when the licence has none. */
  order:            Record<string, unknown> | null
  orderId:          string | null
  organizerUid:     string
  /** `events/{slug}.totalCapacity` — null ⇒ uncapped (or no event). */
  eventCapacity:    number | null
  /** Registrations already taken (registrationCounters.totalCount). */
  sold:             number
  /** The allowance ledger, when one exists for the order's draft. */
  ledger: {
    organizerUid?:  unknown
    appliedOrders?: Record<string, unknown>
    refundedOrders?: Record<string, unknown>
    lines:          Record<string, RefundServiceLine>
  } | null
  /** Historical wallet-paid licence portion (walletTransactions/license_<draftId>), else 0. */
  walletChargePaise: number
}

export type LicenceRefundConflictCode =
  | 'SEATS_IN_USE'
  | 'SERVICE_UNITS_CONSUMED'
  | 'ACTIVATION_RECORD_MISSING'
  | 'UNCAPPED_EVENT'
  | 'LEGACY_LICENCE_IN_USE'

export interface LicenceRefundConflict { code: LicenceRefundConflictCode; message: string }

export interface LicenceRefundAssessment {
  gatewayRefundPaise: number
  walletCreditPaise:  number
  totalRefundPaise:   number
  /** Seats the activation order charged for; null when the order's snapshot cannot say. */
  paidSeats:          number | null
  sold:               number
  capacityBefore:     number | null
  capacityAfter:      number | null
  capacityChange:     boolean
  services:           Array<{ service: string; bought: number; retirable: number; consumed: number }>
  conflicts:          LicenceRefundConflict[]
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

export function assessLicenceRefund(input: LicenceRefundAssessmentInput): LicenceRefundAssessment {
  const o = input.order
  const sold = Math.max(0, Math.floor(input.sold))
  const orderStatus = o?.status
  const gatewayRefundPaise =
    o && typeof o.razorpayPaymentId === 'string' && o.razorpayPaymentId && orderStatus !== 'refunded' && orderStatus !== 'refunding'
      ? int(o.amountPaise) : 0
  const walletCreditPaise = int(input.walletChargePaise)
  const totalRefundPaise = gatewayRefundPaise + walletCreditPaise
  const movesMoney = totalRefundPaise > 0
  const conflicts: LicenceRefundConflict[] = []

  // ── Capacity ──
  const capacityModel = input.licence.commercialModel === 'capacity'
  const snap = o?.capacityChange as { operation?: unknown; chargeableCapacity?: unknown } | undefined
  const paidSeats = capacityModel && o?.commercialModel === 'capacity' && snap?.operation === 'activation'
    && typeof snap.chargeableCapacity === 'number' && Number.isInteger(snap.chargeableCapacity) && snap.chargeableCapacity >= 0
    ? snap.chargeableCapacity : null
  const capacityBefore = typeof input.eventCapacity === 'number' && Number.isFinite(input.eventCapacity) ? input.eventCapacity : null

  let capacityAfter = capacityBefore
  if (paidSeats !== null && paidSeats > 0 && capacityBefore !== null) {
    const target = Math.max(0, capacityBefore - paidSeats)
    capacityAfter = Math.max(sold, target)          // never below registrations already taken
    if (movesMoney && sold > target) {
      conflicts.push({ code: 'SEATS_IN_USE', message: `${sold.toLocaleString('en-IN')} registrations are taken, but removing the ${paidSeats.toLocaleString('en-IN')} refunded seats leaves ${target.toLocaleString('en-IN')}. Some refunded seats are already in use.` })
    }
  }
  // When the refunded seats cannot be worked out, capacity is left unchanged (the refunded licence
  // blocks new registrations anyway). That is only a conflict once registrations exist — they may be
  // sitting in the seats whose money this refund returns.
  if (movesMoney && capacityModel && sold > 0) {
    if (paidSeats === null && o) conflicts.push({ code: 'ACTIVATION_RECORD_MISSING', message: `The activation order has no capacity pricing record, so it cannot be told whether the ${sold.toLocaleString('en-IN')} registrations already taken use the seats this refund pays back.` })
    if (paidSeats !== null && paidSeats > 0 && capacityBefore === null) conflicts.push({ code: 'UNCAPPED_EVENT', message: `The event has no capacity limit and ${sold.toLocaleString('en-IN')} registrations are taken, so the refunded seats cannot be separated from the ones in use.` })
  }
  if (movesMoney && !capacityModel && sold > 0) {
    conflicts.push({ code: 'LEGACY_LICENCE_IN_USE', message: `This is a tier-priced licence with ${sold.toLocaleString('en-IN')} registrations already taken; a full refund would return money for capacity already used.` })
  }

  // ── Prepaid service units on the activation order (the existing retire-unused rule) ──
  const items = Array.isArray(o?.serviceItems) ? o!.serviceItems as Array<{ service?: unknown; quantity?: unknown }> : []
  const ledger = input.ledger
  const ledgerApplies = !!(ledger && input.orderId && ledger.appliedOrders?.[input.orderId]
    && !ledger.refundedOrders?.[input.orderId] && ledger.organizerUid === input.organizerUid)
  const services: LicenceRefundAssessment['services'] = []
  const kinds = [...new Set(items.map(i => i.service).filter((s): s is string => typeof s === 'string'))]
  for (const k of kinds) {
    const bought = items.filter(i => i.service === k).reduce((a, i) => a + int(i.quantity), 0)
    if (bought === 0) continue
    let retirable = 0
    if (ledgerApplies) {
      const l = ledger!.lines[k] ?? { purchased: 0, consumed: 0, carriedOut: 0, refunded: 0 }
      retirable = Math.min(bought, Math.max(0, l.purchased - l.consumed - l.carriedOut - l.refunded))
    }
    const consumed = ledgerApplies ? bought - retirable : 0
    services.push({ service: k, bought, retirable, consumed })
    if (movesMoney && consumed > 0) {
      conflicts.push({ code: 'SERVICE_UNITS_CONSUMED', message: `${consumed.toLocaleString('en-IN')} of the ${bought.toLocaleString('en-IN')} prepaid ${k} units on this order are already used and cannot be taken back.` })
    }
  }

  return {
    gatewayRefundPaise, walletCreditPaise, totalRefundPaise, paidSeats, sold,
    capacityBefore, capacityAfter,
    capacityChange: capacityBefore !== null && capacityAfter !== null && capacityAfter < capacityBefore,
    services, conflicts,
  }
}
