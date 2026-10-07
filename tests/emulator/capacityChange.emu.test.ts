// RD-CAPACITY-01 — capacity changes against REAL Firestore.
//
// ═══ WHY THIS SUITE EXISTS ═══════════════════════════════════════════════════
// The pure engine's arithmetic is proved in tests/unit/capacityPricing.test.ts, and the
// routes' server-authority is proved in tests/unit/capacityActivation.test.ts. Neither can
// prove the property that decides whether this migration is safe to ship:
//
//   that two concurrent capacity increases cannot both apply,
//   and that a paid change applies EXACTLY once however many times it is confirmed.
//
// Those are transaction properties. They depend on Firestore's own contention and retry
// behaviour, so reading the source cannot establish them and a mocked database would
// establish them by construction — which is to say, not at all. Everything below therefore
// runs the real transactions against the emulator.
//
// Razorpay is never called: the gateway's role ends at "a payment was verified", and every
// test here starts from that point by invoking the apply transaction the confirm route
// invokes after verification. The verification itself is pinned by the contract suite.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

describeEmu('RD-CAPACITY-01 · capacity changes on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let createCapacityChangeOrder: typeof import('@/lib/licensing/capacityChange').createCapacityChangeOrder
  let applyCapacityChange:       typeof import('@/lib/licensing/capacityChange').applyCapacityChange
  let applyFreeCapacityChange:   typeof import('@/lib/licensing/capacityChange').applyFreeCapacityChange
  let loadCapacityChangeContext: typeof import('@/lib/licensing/capacityChange').loadCapacityChangeContext

  const UID   = `cap-owner-${process.pid}`
  const OTHER = `cap-other-${process.pid}`
  const EVENT = `cap-event-${process.pid}`

  const eventRef   = () => adminDb.doc(`events/${EVENT}`)
  const licenceRef = () => adminDb.doc(`eventLicenses/${EVENT}`)
  const capacity   = async () => (await eventRef().get()).data()?.totalCapacity as number | null | undefined
  const orders     = async () => (await adminDb.collection('licenseOrders').where('eventId', '==', EVENT).get()).docs
  const history    = async () => (await adminDb.collection('licenseHistory').where('eventId', '==', EVENT).get()).docs

  /** Put the event back to a known, activated-at-500 state. */
  async function seed(totalCapacity: number | null = 500, extra: Record<string, unknown> = {}) {
    await eventRef().set({
      uid: UID, draftId: EVENT, totalCapacity,
      eventDetails: { info: { name: 'Capacity Test Run' } },
      pricing: { eventType: 'paid' },
      ...extra,
    })
    await licenceRef().set({
      eventId: EVENT, organizerUid: UID, tier: 'free', status: 'active', version: 2,
      amountPaise: 60_000, orderId: `lic_${EVENT}`, commercialModel: 'capacity', capacity: totalCapacity,
    })
  }

  async function wipe() {
    for (const d of await orders())  await d.ref.delete()
    for (const d of await history()) await d.ref.delete()
    await eventRef().delete().catch(() => null)
    await licenceRef().delete().catch(() => null)
    await adminDb.doc(`organizerWallets/${UID}`).delete().catch(() => null)
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ createCapacityChangeOrder, applyCapacityChange, applyFreeCapacityChange, loadCapacityChangeContext } =
      await import('@/lib/licensing/capacityChange'))
  }, T)

  afterAll(wipe, T)
  beforeEach(async () => { await wipe(); await seed(500) }, T)

  // ═══ 1 · ownership, before any money ════════════════════════════════════════

  it('refuses a caller who does not own the event', async () => {
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: OTHER, newCapacity: 1_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('FORBIDDEN')
    expect(await orders()).toHaveLength(0)
    expect(await capacity()).toBe(500)
  }, T)

  it('refuses a missing event', async () => {
    const r = await createCapacityChangeOrder({ eventId: 'no-such-event', organizerUid: UID, newCapacity: 1_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('EVENT_NOT_FOUND')
  }, T)

  it('refuses an uncapped event, which has no delta to price', async () => {
    await seed(null)
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('UNLIMITED_CAPACITY')
  }, T)

  // ═══ 2 · the priced order ═══════════════════════════════════════════════════

  it('prices 500 → 1,000 at ₹885 and records every input on the order', async () => {
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.message)

    expect(r.result.quote.totalPaise).toBe(88_500)          // ₹750 + ₹135 GST
    expect(r.result.orderId).toBe(`cap_${EVENT}_1`)
    expect(r.result.razorpayAmountPaise).toBe(88_500)       // RD-LICENSE-PAYMENT-01: always the whole total via Razorpay

    const doc = (await adminDb.doc(`licenseOrders/cap_${EVENT}_1`).get()).data()!
    expect(doc.purpose).toBe('capacity_increase')
    expect(doc.commercialModel).toBe('capacity')
    expect(doc.status).toBe('created')
    expect(doc.amountPaise).toBe(88_500)
    expect(doc.razorpayAmountPaise).toBe(88_500)
    expect(doc.capacityChange).toMatchObject({
      operation: 'increase', previousCapacity: 500, capacity: 1_000,
      chargeableCapacity: 500, basePaise: 75_000, gstPaise: 13_500, totalPaise: 88_500,
      freeCapacity: 100, activationRatePaise: 150, gstRatePercent: 18,
    })
    // the terms are copied onto the order, so the amount stays explicable for ever
    expect(doc.capacityChange.terms).toEqual(DEFAULT_COMMERCIAL_TERMS)
    // …and nothing has moved yet
    expect(await capacity()).toBe(500)
  }, T)

  it('does NOT touch the event capacity when only the order is created', async () => {
    await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 2_000 })
    expect(await capacity()).toBe(500)
    expect(await history()).toHaveLength(0)
  }, T)

  it('claims a fresh sequence number for each successive change', async () => {
    const a = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    const b = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 2_000 })
    if (!a.ok || !b.ok) throw new Error('order creation failed')
    expect(a.result.orderId).toBe(`cap_${EVENT}_1`)
    expect(b.result.orderId).toBe(`cap_${EVENT}_2`)
    // Two DISTINCT payable orders exist, so neither can overwrite the other.
    expect((await orders()).map(d => d.id).sort()).toEqual([`cap_${EVENT}_1`, `cap_${EVENT}_2`])
  }, T)

  it('rejects an invalid capacity without writing anything', async () => {
    for (const bad of [Number.NaN, 0, -1, 437.5, '1000', true, 200_001, Number.POSITIVE_INFINITY]) {
      const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: bad })
      expect(r.ok, `accepted ${String(bad)}`).toBe(false)
    }
    expect(await orders()).toHaveLength(0)
    expect(await capacity()).toBe(500)
  }, T)

  // ═══ 3 · applying a paid change ═════════════════════════════════════════════

  it('moves the enforced capacity, the licence record, the order and the history together', async () => {
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    if (!r.ok) throw new Error(r.message)

    const applied = await applyCapacityChange({
      eventId: EVENT, organizerUid: UID, orderId: r.result.orderId,
      razorpayOrderId: 'order_test_1', razorpayPaymentId: 'pay_test_1',
    })
    expect(applied.kind).toBe('ok')
    expect(applied.newCapacity).toBe(1_000)

    // totalCapacity is the single ENFORCED value — it is what the gate reads.
    expect(await capacity()).toBe(1_000)
    const lic = (await licenceRef().get()).data()!
    expect(lic.capacity).toBe(1_000)
    const order = (await adminDb.doc(`licenseOrders/${r.result.orderId}`).get()).data()!
    expect(order.status).toBe('paid')
    expect(order.razorpayPaymentId).toBe('pay_test_1')
    expect(order.paidAt).toBeTruthy()
    // …and the amount on the paid order is unchanged from what was quoted
    expect(order.amountPaise).toBe(88_500)

    const h = await history()
    expect(h).toHaveLength(1)
    expect(h[0].data().action).toBe('capacity_increased')
    expect(h[0].data().after).toMatchObject({ previousCapacity: 500, capacity: 1_000, totalPaise: 88_500 })
  }, T)

  it('leaves the legacy capacityPlan alone — totalCapacity is the value that binds', async () => {
    await seed(500, { capacityPlan: 'pack_500' })
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 437 })
    if (!r.ok) throw new Error(r.message)
    await applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: r.result.orderId, razorpayOrderId: null, razorpayPaymentId: 'p' })
    expect(await capacity()).toBe(437)
    // The stale plan is not rewritten; it is only ever a fallback for documents with no
    // totalCapacity, and this one plainly has one.
    expect((await eventRef().get()).data()!.capacityPlan).toBe('pack_500')
  }, T)

  // ═══ 4 · REPLAY — the property that stops a double charge ═══════════════════

  it('applies exactly once however many times it is confirmed', async () => {
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    if (!r.ok) throw new Error(r.message)
    const call = () => applyCapacityChange({
      eventId: EVENT, organizerUid: UID, orderId: r.result.orderId,
      razorpayOrderId: 'order_x', razorpayPaymentId: 'pay_x',
    })

    expect((await call()).kind).toBe('ok')
    for (let i = 0; i < 4; i++) expect((await call()).kind).toBe('already')

    expect(await capacity()).toBe(1_000)
    // One history row, not five — the audit trail is not inflated by replays either.
    expect(await history()).toHaveLength(1)
  }, T)

  it('is idempotent under a SIMULTANEOUS confirm and webhook replay', async () => {
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    if (!r.ok) throw new Error(r.message)
    const call = () => applyCapacityChange({
      eventId: EVENT, organizerUid: UID, orderId: r.result.orderId,
      razorpayOrderId: 'order_y', razorpayPaymentId: 'pay_y',
    })
    const results = await Promise.all([call(), call(), call()])
    // Exactly one applied; the rest short-circuited. Firestore serialises them on the order doc.
    expect(results.filter(x => x.kind === 'ok')).toHaveLength(1)
    expect(results.filter(x => x.kind === 'already')).toHaveLength(2)
    expect(await capacity()).toBe(1_000)
    expect(await history()).toHaveLength(1)
  }, T)

  // ═══ 5 · CONCURRENCY — two increases from the same starting capacity ════════

  it('two concurrent increases cannot both be priced from the same stale capacity', async () => {
    // Both callers ask to go to 1,000 from 500 at the same moment. The sequence number is
    // claimed inside the order transaction, so they contend on the licence document and
    // receive DIFFERENT order ids — neither silently overwrites the other's payable order.
    const [a, b] = await Promise.all([
      createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 }),
      createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 }),
    ])
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) throw new Error('order creation failed')
    expect(a.result.orderId).not.toBe(b.result.orderId)

    // Both are paid. Only ONE may apply: the second was priced against a capacity of 500
    // that no longer exists, so applying it would hand over 500 more slots for nothing.
    const first  = await applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: a.result.orderId, razorpayOrderId: null, razorpayPaymentId: 'p1' })
    const second = await applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: b.result.orderId, razorpayOrderId: null, razorpayPaymentId: 'p2' })

    expect(first.kind).toBe('ok')
    expect(second.kind).toBe('stale')
    expect(await capacity()).toBe(1_000)          // NOT 1,500 and NOT 2,000
    expect(await history()).toHaveLength(1)
  }, T)

  it('two SIMULTANEOUS applies of different orders land at one capacity, never a sum', async () => {
    const [a, b] = await Promise.all([
      createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 }),
      createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 800 }),
    ])
    if (!a.ok || !b.ok) throw new Error('order creation failed')

    const [ra, rb] = await Promise.all([
      applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: a.result.orderId, razorpayOrderId: null, razorpayPaymentId: 'pa' }),
      applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: b.result.orderId, razorpayOrderId: null, razorpayPaymentId: 'pb' }),
    ])
    const kinds = [ra.kind, rb.kind].sort()
    expect(kinds).toEqual(['ok', 'stale'])
    // Whichever won, the capacity is that order's target — never 1,800, never 1,300.
    expect([800, 1_000]).toContain(await capacity())
    expect(await history()).toHaveLength(1)
  }, T)

  it('a stale order can never be applied later either', async () => {
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    if (!r.ok) throw new Error(r.message)
    // Something else moves the capacity in the meantime (an admin, another change).
    await eventRef().set({ totalCapacity: 700 }, { merge: true })

    const applied = await applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: r.result.orderId, razorpayOrderId: null, razorpayPaymentId: 'p' })
    expect(applied.kind).toBe('stale')
    expect(await capacity()).toBe(700)            // untouched
    const order = (await adminDb.doc(`licenseOrders/${r.result.orderId}`).get()).data()!
    // RD-F1 — NOT paid, and now TERMINAL: marked failed in the same transaction that found it stale
    // (it used to stay 'created', which let it apply later once the capacity came back).
    expect(order).toMatchObject({ status: 'failed', failReason: 'capacity_stale' })
    expect(await history()).toHaveLength(0)
    // …and restoring the capacity it was priced against does NOT make it usable again.
    await eventRef().set({ totalCapacity: 500 }, { merge: true })
    const again = await applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: r.result.orderId, razorpayOrderId: null, razorpayPaymentId: 'p' })
    expect(again.kind).toBe('ineligible')
    expect(await capacity()).toBe(500)
    expect(await history()).toHaveLength(0)
  }, T)

  // ═══ RD-F1 · only a `created` order without a refund hold may grant capacity ══════════════
  it('F1 · failed (superseded / held), refunded or unknown-status orders are refused and NOTHING is written', async () => {
    for (const bad of [
      { status: 'failed', failReason: 'superseded' },
      { status: 'failed', failReason: 'capacity_stale', manualRefundHoldId: 'license_hold_x' },
      { status: 'created', manualRefundHoldId: 'license_hold_y' },                   // held but not yet marked
      { status: 'refunded' },
      { status: 'cancelled' }, { status: 'expired' }, { status: 'weird' },
    ]) {
      await wipe(); await seed(500)
      const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
      if (!r.ok) throw new Error(r.message)
      const ref = adminDb.doc(`licenseOrders/${r.result.orderId}`)
      await ref.set(bad, { merge: true })
      const before = JSON.stringify((await ref.get()).data())
      const applied = await applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: r.result.orderId, razorpayOrderId: 'order_f1', razorpayPaymentId: 'pay_f1' })
      expect(applied.kind, JSON.stringify(bad)).toBe('ineligible')
      expect(await capacity()).toBe(500)                                            // capacity at the priced value: still refused
      expect(JSON.stringify((await ref.get()).data())).toBe(before)                 // order untouched
      expect((await licenceRef().get()).data()!.capacity).toBe(500)
      expect(await history()).toHaveLength(0)
    }
  }, T)

  it('F1 · concurrent confirmations: a held order is refused by every caller; a valid order applies exactly once', async () => {
    const held = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    if (!held.ok) throw new Error(held.message)
    await adminDb.doc(`licenseOrders/${held.result.orderId}`).set({ status: 'failed', failReason: 'capacity_stale', manualRefundHoldId: 'h' }, { merge: true })
    const heldCall = () => applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: held.result.orderId, razorpayOrderId: 'o', razorpayPaymentId: 'p' })
    const hr = await Promise.all([heldCall(), heldCall(), heldCall(), heldCall()])
    expect(hr.every(x => x.kind === 'ineligible')).toBe(true)
    expect(await capacity()).toBe(500)

    const ok = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 800 })
    if (!ok.ok) throw new Error(ok.message)
    const call = () => applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: ok.result.orderId, razorpayOrderId: 'o2', razorpayPaymentId: 'p2' })
    const r = await Promise.all([call(), call(), call()])
    expect(r.filter(x => x.kind === 'ok')).toHaveLength(1)
    expect(r.filter(x => x.kind === 'already')).toHaveLength(2)
    expect(await capacity()).toBe(800)
    expect(await history()).toHaveLength(1)
  }, T)

  // ═══ 6 · DECREASE — a charge, never a refund ════════════════════════════════

  it('charges 1% of the removed capacity value plus GST, and refunds nothing', async () => {
    await seed(1_000)
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 500 })
    if (!r.ok) throw new Error(r.message)

    expect(r.result.quote.kind).toBe('decrease')
    expect(r.result.quote.totalPaise).toBe(885)            // ₹7.50 + ₹1.35 GST
    const doc = (await adminDb.doc(`licenseOrders/${r.result.orderId}`).get()).data()!
    expect(doc.purpose).toBe('capacity_decrease')
    expect(doc.capacityChange).toMatchObject({
      operation: 'decrease', previousCapacity: 1_000, capacity: 500,
      removedCapacityValuePaise: 75_000, decreaseFeePercent: 1,
      basePaise: 750, gstPaise: 135, totalPaise: 885,
    })
    // Positive amount — a decrease is billed, not credited.
    expect(doc.amountPaise).toBeGreaterThan(0)

    const applied = await applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: r.result.orderId, razorpayOrderId: null, razorpayPaymentId: 'p' })
    expect(applied.kind).toBe('ok')
    expect(await capacity()).toBe(500)
    const h = await history()
    expect(h[0].data().action).toBe('capacity_decreased')
  }, T)

  it('never alters the original activation order when capacity is reduced', async () => {
    await seed(1_000)
    // The activation order, exactly as a real activation would have left it.
    await adminDb.doc(`licenseOrders/lic_${EVENT}`).set({
      orderId: `lic_${EVENT}`, eventId: EVENT, organizerUid: UID, tier: 'free',
      purpose: 'purchase', status: 'paid', amountPaise: 135_000, currency: 'INR',
      commercialModel: 'capacity',
      capacityChange: { operation: 'activation', capacity: 1_000, previousCapacity: null, basePaise: 135_000, gstPaise: 24_300, totalPaise: 159_300 },
    })
    const before = JSON.stringify((await adminDb.doc(`licenseOrders/lic_${EVENT}`).get()).data())

    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 500 })
    if (!r.ok) throw new Error(r.message)
    await applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: r.result.orderId, razorpayOrderId: null, razorpayPaymentId: 'p' })

    // Byte-for-byte unchanged: no refund, no amount rewrite, no status change.
    expect(JSON.stringify((await adminDb.doc(`licenseOrders/lic_${EVENT}`).get()).data())).toBe(before)
  }, T)

  // ═══ 7 · free and no-op changes ════════════════════════════════════════════

  it('an unchanged capacity creates no order and charges nothing', async () => {
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 500 })
    if (!r.ok) throw new Error(r.message)
    expect(r.result.quote.kind).toBe('unchanged')
    expect(r.result.orderId).toBe('')
    expect(r.result.quote.paymentRequired).toBe(false)
    expect(await orders()).toHaveLength(0)

    expect(await applyFreeCapacityChange({ eventId: EVENT, organizerUid: UID, snapshot: {
      ...r.result.snapshot,
    } })).toBe('already')
    expect(await capacity()).toBe(500)
  }, T)

  it('a change that stays inside the free allowance applies with no order and no payment', async () => {
    await seed(80)
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 100 })
    if (!r.ok) throw new Error(r.message)
    expect(r.result.quote.totalPaise).toBe(0)
    expect(r.result.orderId).toBe('')

    expect(await applyFreeCapacityChange({ eventId: EVENT, organizerUid: UID, snapshot: r.result.snapshot })).toBe('ok')
    expect(await capacity()).toBe(100)
    expect(await orders()).toHaveLength(0)
    expect((await history())[0].data().note).toContain('no charge')
  }, T)

  it('the free path refuses to apply a change that actually costs money', async () => {
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    if (!r.ok) throw new Error(r.message)
    // A caller that tried to route a ₹885 change through the no-charge path is refused —
    // this is the one place where "free" and "paid" could be confused, so it is closed.
    expect(await applyFreeCapacityChange({ eventId: EVENT, organizerUid: UID, snapshot: r.result.snapshot })).toBe('stale')
    expect(await capacity()).toBe(500)
  }, T)

  // ═══ 7b · buying capacity re-arms the threshold warnings ═══════════════════

  it('clears the alert high-water mark in the same write as the new capacity', async () => {
    // The worst failure mode in the notification design is SILENCE: an event that hit 100%,
    // bought more capacity, and is then never warned again as it refills — so registrations
    // start being refused with no notice at all. The stored state is capacity-stamped, so the
    // sweep would reset it anyway, but clearing it here makes the event eligible immediately.
    await eventRef().set({ capacityAlert: { lastNotified: 100, capacity: 500 } }, { merge: true })
    expect((await eventRef().get()).data()!.capacityAlert).toBeTruthy()

    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    if (!r.ok) throw new Error(r.message)
    expect((await applyCapacityChange({
      eventId: EVENT, organizerUid: UID, orderId: r.result.orderId,
      razorpayOrderId: null, razorpayPaymentId: 'p',
    })).kind).toBe('ok')

    const after = (await eventRef().get()).data()!
    expect(after.totalCapacity).toBe(1_000)
    expect(after.capacityAlert).toBeUndefined()      // gone, atomically with the capacity
  }, T)

  it('clears it on the FREE path too', async () => {
    await seed(80)
    await eventRef().set({ capacityAlert: { lastNotified: 100, capacity: 80 } }, { merge: true })
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 100 })
    if (!r.ok) throw new Error(r.message)
    expect(await applyFreeCapacityChange({ eventId: EVENT, organizerUid: UID, snapshot: r.result.snapshot })).toBe('ok')
    const after = (await eventRef().get()).data()!
    expect(after.totalCapacity).toBe(100)
    expect(after.capacityAlert).toBeUndefined()
  }, T)

  // ═══ 8 · grandfathering a pre-migration event ══════════════════════════════

  it('measures a LEGACY event from its enforced capacity, without rewriting its licence', async () => {
    // A pre-migration event: no totalCapacity at all, only the old bucket field, and a
    // licence with no capacity recorded. It must still be changeable.
    await eventRef().set({
      uid: UID, draftId: EVENT, capacityPlan: 'pack_1000',
      pricing: { eventType: 'paid' }, eventDetails: { info: { name: 'Legacy Run' } },
    })
    await licenceRef().set({ eventId: EVENT, organizerUid: UID, tier: 'growth', status: 'active', version: 1, amountPaise: 99_900 })

    const ctx = await loadCapacityChangeContext(EVENT, UID)
    expect(ctx.ok).toBe(true)
    if (!ctx.ok) throw new Error(ctx.message)
    expect(ctx.ctx.currentCapacity).toBe(1_000)      // derived from the legacy bucket

    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_500 })
    if (!r.ok) throw new Error(r.message)
    expect(r.result.quote.chargeableCapacity).toBe(500)
    expect(r.result.quote.totalPaise).toBe(88_500)

    await applyCapacityChange({ eventId: EVENT, organizerUid: UID, orderId: r.result.orderId, razorpayOrderId: null, razorpayPaymentId: 'p' })
    expect(await capacity()).toBe(1_500)
    // The historical V1 licence keeps its tier and version — nothing destructive happened.
    const lic = (await licenceRef().get()).data()!
    expect(lic.tier).toBe('growth')
    expect(lic.version).toBe(1)
    expect(lic.capacity).toBe(1_500)
  }, T)

  // ═══ 9 · a per-event override prices that event ════════════════════════════

  it('uses the EVENT’s own commercial terms when it has them', async () => {
    await seed(500, { commercial: { activationRatePaise: 50 } })
    const r = await createCapacityChangeOrder({ eventId: EVENT, organizerUid: UID, newCapacity: 1_000 })
    if (!r.ok) throw new Error(r.message)
    // 500 slots × ₹0.50 = ₹250, GST ₹45 → ₹295
    expect(r.result.quote.activationRatePaise).toBe(50)
    expect(r.result.quote.basePaise).toBe(25_000)
    expect(r.result.quote.gstPaise).toBe(4_500)
    expect(r.result.quote.totalPaise).toBe(29_500)
    // The other five terms are inherited, not reset to code defaults.
    expect(r.result.quote.terms.freeRegistrationCapacity).toBe(DEFAULT_COMMERCIAL_TERMS.freeRegistrationCapacity)
    expect(r.result.quote.terms.gstRatePercent).toBe(DEFAULT_COMMERCIAL_TERMS.gstRatePercent)
  }, T)
})
