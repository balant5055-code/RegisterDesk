// RD-SA-COMMERCE-P1 — the licence refund assessment and the licence registration block (pure).
import { describe, it, expect } from 'vitest'
import { assessLicenceRefund, type LicenceRefundAssessmentInput } from '@/lib/licensing/licenceRefundAssessment'
import { licenceRegistrationBlock } from '@/lib/licensing/licenceRegistrationBlock'

const ORDER_ID = 'lic_d1'
const activation = (o: Partial<Record<string, unknown>> = {}) => ({
  status: 'paid', razorpayPaymentId: 'pay_1', amountPaise: 17_700, commercialModel: 'capacity',
  capacityChange: { operation: 'activation', capacity: 250, previousCapacity: null, freeCapacity: 100, chargeableCapacity: 150 },
  ...o,
})
const base = (o: Partial<LicenceRefundAssessmentInput> = {}): LicenceRefundAssessmentInput => ({
  licence: { commercialModel: 'capacity' }, order: activation(), orderId: ORDER_ID, organizerUid: 'org1',
  eventCapacity: 250, sold: 0, ledger: null, walletChargePaise: 0, ...o,
})

describe('assessLicenceRefund · capacity floor', () => {
  it('removes exactly the seats the activation order charged for', () => {
    const a = assessLicenceRefund(base({ sold: 40 }))
    expect(a).toMatchObject({ paidSeats: 150, capacityBefore: 250, capacityAfter: 100, capacityChange: true, gatewayRefundPaise: 17_700, totalRefundPaise: 17_700 })
    expect(a.conflicts).toEqual([])
  })
  it('sold exactly at the floor is fine; one more is SEATS_IN_USE and capacity never drops below sold', () => {
    expect(assessLicenceRefund(base({ sold: 100 })).conflicts).toEqual([])
    const a = assessLicenceRefund(base({ sold: 101 }))
    expect(a.capacityAfter).toBe(101)
    expect(a.conflicts.map(c => c.code)).toEqual(['SEATS_IN_USE'])
  })
  it('later paid increases stay: only the activation seats come off an event that grew since', () => {
    const a = assessLicenceRefund(base({ eventCapacity: 400, sold: 200 }))
    expect(a.capacityAfter).toBe(250)
    expect(a.conflicts).toEqual([])
  })
  it('no money to return ⇒ no conflict, the floor still applies', () => {
    const a = assessLicenceRefund(base({ order: activation({ razorpayPaymentId: null }), sold: 180 }))
    expect(a.totalRefundPaise).toBe(0)
    expect(a.conflicts).toEqual([])
    expect(a.capacityAfter).toBe(180)
  })
})

describe('assessLicenceRefund · records that cannot say', () => {
  it('capacity licence without a snapshot: unchanged capacity; a conflict only once registrations exist', () => {
    const noSnap = activation({ capacityChange: undefined })
    expect(assessLicenceRefund(base({ order: noSnap, sold: 0 })).conflicts).toEqual([])
    expect(assessLicenceRefund(base({ order: noSnap, sold: 0 })).capacityChange).toBe(false)
    expect(assessLicenceRefund(base({ order: noSnap, sold: 3 })).conflicts.map(c => c.code)).toEqual(['ACTIVATION_RECORD_MISSING'])
  })
  it('uncapped event with paid seats: conflict only once registrations exist', () => {
    expect(assessLicenceRefund(base({ eventCapacity: null, sold: 0 })).conflicts).toEqual([])
    expect(assessLicenceRefund(base({ eventCapacity: null, sold: 1 })).conflicts.map(c => c.code)).toEqual(['UNCAPPED_EVENT'])
  })
  it('legacy tier licence with registrations and money to return is a conflict', () => {
    const a = assessLicenceRefund(base({ licence: {}, order: { status: 'paid', razorpayPaymentId: 'p', amountPaise: 999 }, sold: 5 }))
    expect(a.conflicts.map(c => c.code)).toEqual(['LEGACY_LICENCE_IN_USE'])
    expect(a.capacityChange).toBe(false)
  })
  it('already refunded / refunding orders refund nothing at the gateway', () => {
    expect(assessLicenceRefund(base({ order: activation({ status: 'refunding' }) })).gatewayRefundPaise).toBe(0)
    expect(assessLicenceRefund(base({ order: activation({ status: 'refunded' }) })).gatewayRefundPaise).toBe(0)
  })
  it('a historical wallet-paid portion is part of the refund total', () => {
    expect(assessLicenceRefund(base({ walletChargePaise: 2_000 })).totalRefundPaise).toBe(19_700)
  })
})

describe('assessLicenceRefund · prepaid service units (the existing retire-unused rule)', () => {
  const withUnits = (consumed: number, o: Partial<LicenceRefundAssessmentInput> = {}) => base({
    order: activation({ serviceItems: [{ service: 'whatsapp', quantity: 100 }] }),
    ledger: { organizerUid: 'org1', appliedOrders: { [ORDER_ID]: true }, lines: { whatsapp: { purchased: 100, consumed, carriedOut: 0, refunded: 0 } } },
    ...o,
  })
  it('all unused ⇒ all retirable, no conflict', () => {
    const a = assessLicenceRefund(withUnits(0))
    expect(a.services).toEqual([{ service: 'whatsapp', bought: 100, retirable: 100, consumed: 0 }])
    expect(a.conflicts).toEqual([])
  })
  it('some used ⇒ SERVICE_UNITS_CONSUMED (the policy has no partial amount)', () => {
    const a = assessLicenceRefund(withUnits(30))
    expect(a.services[0]).toMatchObject({ retirable: 70, consumed: 30 })
    expect(a.conflicts.map(c => c.code)).toEqual(['SERVICE_UNITS_CONSUMED'])
  })
  it('a ledger owned by someone else, or not applied, is never counted as consumption', () => {
    expect(assessLicenceRefund(withUnits(30, { organizerUid: 'other' })).conflicts).toEqual([])
    const notApplied = withUnits(30); notApplied.ledger!.appliedOrders = {}
    expect(assessLicenceRefund(notApplied).services[0]).toMatchObject({ retirable: 0, consumed: 0 })
  })
})

describe('licenceRegistrationBlock', () => {
  it('no licence document, or an active one, never blocks', () => {
    expect(licenceRegistrationBlock(undefined)).toBeNull()
    expect(licenceRegistrationBlock({})).toBeNull()
    expect(licenceRegistrationBlock({ admin: { lifecycle: 'active' } })).toBeNull()
  })
  it('suspended / cancelled / refund in progress / refunded block', () => {
    expect(licenceRegistrationBlock({ admin: { lifecycle: 'suspended' } })).toBe('suspended')
    expect(licenceRegistrationBlock({ admin: { lifecycle: 'cancelled' } })).toBe('cancelled')
    expect(licenceRegistrationBlock({ refundHold: { at: 1 }, admin: { lifecycle: 'active' } })).toBe('refund_in_progress')
    expect(licenceRegistrationBlock({ refundedAt: 1, admin: { lifecycle: 'active' } })).toBe('refunded')
  })
  it('a refunded licence unblocks only once its entitlement is explicitly restored (and is active)', () => {
    expect(licenceRegistrationBlock({ refundedAt: 1, entitlementRestoredAt: 2, admin: { lifecycle: 'active' } })).toBeNull()
    expect(licenceRegistrationBlock({ refundedAt: 1, entitlementRestoredAt: 2, admin: { lifecycle: 'cancelled' } })).toBe('cancelled')
  })
})
