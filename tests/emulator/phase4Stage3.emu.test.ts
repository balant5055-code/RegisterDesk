// RD-PHASE4-S3 — event-specific pricing & inheritance, proved against REAL Firestore through the REAL
// routes: the Super Admin commercial write (transaction, merged validation, per-term clear, audit), the
// event attendee percentage reaching the checkout snapshot, the Q3 read-failure refusal, organizer-pays
// (Q1) and the retired override layers (Q4).
//
// Stubbed: identity at the token boundary (admin resolvers, verifyCaller), the pricing-engine switch,
// the rate limiter, the registration gate and the payment gateway adapter. The fee RESOLUTION is real
// (resolveFeeConfig + Business Configuration code defaults: 0.5% RegisterDesk platform fee (RD-FEE-02), no fixed/min (RD-FEE-01), 18% GST).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// RD-SEC-01 · two roles only. A legacy-claim caller is no longer a "plain admin": routes refuse it
// at the admin door like any non-admin (bare 403/401) or, behind requireSuperAdmin, with
// SUPER_ADMIN_REQUIRED. Either way it must be an AUTHORIZATION refusal — never a validation code
// (REASON_REQUIRED etc.), which would mean it got past the door.
const PLAIN_REFUSED: ReadonlyArray<string | undefined> = ['SUPER_ADMIN_REQUIRED', undefined]


const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const OWNER = `p4s3-owner-${P}`, SUPER = `p4s3-super-${P}`, PLAIN = `p4s3-plain-${P}`
const SLUG  = `p4s3-ev-${P}`, DRAFT = `p4s3Draft${P}`

const h = vi.hoisted(() => ({
  engine: false, who: '', admin: '', superUid: '', plainUid: '', seq: 0,
  orders: [] as Array<{ id: string; amountPaise: number }>,
}))
vi.mock('@/lib/platform/pricing/resolver', async orig => ({
  ...(await orig<typeof import('@/lib/platform/pricing/resolver')>()),
  resolvePlatformPricing: async () => ({ features: { pricingEngineEnabled: h.engine } }),
}))
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.admin === h.superUid ? h.admin : null),
  legacyAdminClaimOnly: async () => !!h.plainUid && h.admin === h.plainUid,
  resolveSuperAdminUid: async () => (h.admin === h.superUid ? h.superUid : null),
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))
vi.mock('@/lib/rateLimit/redis', () => ({ checkDistributedRateLimit: async () => ({ allowed: true, resetAt: 0 }) }))
vi.mock('@/lib/registrations/gate', () => ({ checkRegistrationGate: async () => ({ allowed: true }) }))
vi.mock('@/lib/payments/providers', async orig => {
  const real = await orig<typeof import('@/lib/payments/providers')>()
  const adapter = {
    createOrder: async ({ amountPaise }: { amountPaise: number }) => {
      const id = `order_p4s3_${P}_${++h.seq}`
      h.orders.push({ id, amountPaise })
      return { providerOrderId: id, checkout: { provider: 'razorpay', keyId: 'rzp_test_stub' } }
    },
    getCheckoutHandoff: async () => ({ provider: 'razorpay', keyId: 'rzp_test_stub' }),
    fetchOrderPayments: async () => [],
  }
  return { ...real, resolveActivePaymentProviderForNewOrder: async () => ({ ok: true, provider: 'razorpay' }), resolvePaymentProvider: () => adapter }
})

const PASS = { id: 'pass_std', name: 'Standard', type: 'paid', price: 500, earlyBirdEnabled: false, unlimited: false, quantity: 500,
  visibility: 'public', status: 'active', advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] } }
const req = (body: unknown, method = 'POST') => new NextRequest('http://localhost/api/t', {
  method, headers: { 'Content-Type': 'application/json', authorization: 'Bearer t' }, body: JSON.stringify(body),
})
const orderReq = (key: string, email = 'a@example.test', slug = SLUG) => req({
  slug, passId: PASS.id, attendee: { name: 'Attendee', email }, formResponses: {}, idempotencyKey: key, termsAccepted: true,
})
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })

describeEmu('RD-PHASE4-S3 · event-specific pricing & inheritance', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  const slugs = new Set<string>([SLUG])

  async function seedEvent(slug = SLUG, extra: Record<string, unknown> = {}) {
    slugs.add(slug)
    await adminDb.doc(`events/${slug}`).set({
      uid: OWNER, draftId: slug === SLUG ? DRAFT : `${slug}-d`, slug, status: 'published', lifecycleStatus: 'published', totalCapacity: 500,
      eventType: 'sports',
      pricing: { eventType: 'paid', feeModel: 'organizer_absorbs', passes: [PASS], advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] } },
      eventDetails: { info: { name: 'Stage 3 Event' }, schedule: { startDate: '2099-12-31', timezone: 'Asia/Kolkata' }, seo: { urlSlug: slug } },
      registrationForm: { sections: [] }, accessControl: { type: 'open' }, ...extra,
    })
  }
  const intentOf = async (orderId: string) => (await adminDb.doc(`paymentIntents/${orderId}`).get()).data()!
  const commercial = async (body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/admin/events/[slug]/commercial/route')
    return json(await POST(req(body), { params: Promise.resolve({ slug: SLUG }) }))
  }
  const createOrder = async (r: NextRequest) => (await import('@/app/api/registrations/create-order/route')).POST(r)

  async function wipe() {
    for (const s of slugs) await adminDb.recursiveDelete(adminDb.doc(`events/${s}`)).catch(() => null)
    for (const o of h.orders) await adminDb.doc(`paymentIntents/${o.id}`).delete().catch(() => null)
    for (const s of slugs) {
      const claims = await adminDb.collection('paymentAttemptClaims').where('eventSlug', '==', s).get().catch(() => null)
      for (const c of claims?.docs ?? []) await c.ref.delete().catch(() => null)
    }
    for (const c of ['licenseHistory']) {
      const qs = await adminDb.collection(c).where('eventId', '==', SLUG).get().catch(() => null)
      for (const d of qs?.docs ?? []) await d.ref.delete().catch(() => null)
    }
    const audits = await adminDb.collection('adminAuditLogs').where('entityId', '==', SLUG).get().catch(() => null)
    for (const d of audits?.docs ?? []) await d.ref.delete().catch(() => null)
    h.orders.length = 0
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    h.superUid = SUPER; h.plainUid = PLAIN
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    await adminDb.doc(`users/${OWNER}`).set({ uid: OWNER, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })
  }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${OWNER}`).delete().catch(() => null); await adminDb.doc(`users/${OWNER}/eventDrafts/${DRAFT}`).delete().catch(() => null) }, T)
  beforeEach(async () => { h.engine = false; h.who = ''; h.admin = ''; await wipe(); await seedEvent() }, T)

  // ═══ Step 6/8 · the Super Admin commercial write ═══════════════════════════════════════
  it('plain admin 403; Super Admin sets ONE term; it is audited (actor, reason, changed, persisted before/after) atomically', async () => {
    h.admin = PLAIN
    const p = await commercial({ terms: { attendeeTransactionFeePercent: 1.5 }, reason: 'negotiated' })
    expect(p.status).toBe(403); expect(PLAIN_REFUSED).toContain(p.body.code)
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.commercial).toBeUndefined()
    h.admin = SUPER
    expect((await commercial({ terms: { attendeeTransactionFeePercent: 1.5 } })).status).toBe(400)   // reason required
    const ok = await commercial({ terms: { attendeeTransactionFeePercent: 1.5 }, reason: 'negotiated rate' })
    expect(ok.status).toBe(200)
    expect(ok.body.changedFields).toEqual(['attendeeTransactionFeePercent'])
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.commercial).toEqual({ attendeeTransactionFeePercent: 1.5 })
    const audit = (await adminDb.collection('adminAuditLogs').where('entityId', '==', SLUG).get()).docs.map(d => d.data())
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ adminUid: SUPER, action: 'commercial_terms.set' })
    expect(audit[0].metadata).toMatchObject({ reason: 'negotiated rate', before: null, after: { attendeeTransactionFeePercent: 1.5 }, changedFields: ['attendeeTransactionFeePercent'] })
    expect(audit[0].createdAt).toBeTruthy()
    const hist = (await adminDb.collection('licenseHistory').where('eventId', '==', SLUG).get()).docs.map(d => d.data())
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ actorUid: SUPER, reason: 'negotiated rate', before: null, after: { attendeeTransactionFeePercent: 1.5 } })
    // same change again → no-op, no second audit row
    expect((await commercial({ terms: { attendeeTransactionFeePercent: 1.5 }, reason: 'retry' })).body.unchanged).toBe(true)
    expect((await adminDb.collection('adminAuditLogs').where('entityId', '==', SLUG).get()).size).toBe(1)
  }, T)

  it('partial overrides MERGE; one term is cleared with null (inherits); an invalid MERGED result is refused, nothing stored', async () => {
    h.admin = SUPER
    expect((await commercial({ terms: { attendeeTransactionFeePercent: 1.5 }, reason: 'a' })).status).toBe(200)
    expect((await commercial({ terms: { maximumEventCapacity: 1000 }, reason: 'b' })).status).toBe(200)
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.commercial).toEqual({ attendeeTransactionFeePercent: 1.5, maximumEventCapacity: 1000 })
    // free capacity above the event's own maximum: valid alone, invalid MERGED → refused
    const bad = await commercial({ terms: { freeRegistrationCapacity: 5000 }, reason: 'c' })
    expect(bad.status).toBe(422)
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.commercial).toEqual({ attendeeTransactionFeePercent: 1.5, maximumEventCapacity: 1000 })
    expect((await commercial({ terms: { attendeeTransactionFeePercent: 'x' }, reason: 'd' })).status).toBe(422)
    // clear ONE term
    const clr = await commercial({ terms: { attendeeTransactionFeePercent: null }, reason: 'back to global' })
    expect(clr.status).toBe(200)
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.commercial).toEqual({ maximumEventCapacity: 1000 })
    const last = (await adminDb.collection('adminAuditLogs').where('entityId', '==', SLUG).get()).docs.map(d => d.data())
      .find(a => (a.metadata as { reason: string }).reason === 'back to global')!
    expect(last.metadata).toMatchObject({ before: { attendeeTransactionFeePercent: 1.5, maximumEventCapacity: 1000 }, after: { maximumEventCapacity: 1000 }, changedFields: ['attendeeTransactionFeePercent'] })
    // clearing the last term removes the override entirely
    expect((await commercial({ terms: { maximumEventCapacity: null }, reason: 'e' })).status).toBe(200)
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.commercial).toBeUndefined()
  }, T)

  it('CONCURRENT changes of different terms both survive; a FAILED audit write commits nothing', async () => {
    h.admin = SUPER
    const [a, b] = await Promise.all([
      commercial({ terms: { attendeeTransactionFeePercent: 2 }, reason: 'x' }),
      commercial({ terms: { capacityDecreaseFeePercent: 3 }, reason: 'y' }),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.commercial).toEqual({ attendeeTransactionFeePercent: 2, capacityDecreaseFeePercent: 3 })
    const { Transaction } = await import('firebase-admin/firestore')
    const orig = Transaction.prototype.set
    const spy = vi.spyOn(Transaction.prototype, 'set').mockImplementation(function (this: unknown, ...args: unknown[]) {
      if ((args[0] as { path?: string })?.path?.startsWith('adminAuditLogs/')) throw new Error('injected audit failure')
      return (orig as (...x: unknown[]) => unknown).apply(this, args) as never
    })
    try {
      await expect(commercial({ terms: { attendeeTransactionFeePercent: 9 }, reason: 'z' })).rejects.toThrow(/injected audit failure/)
    } finally { spy.mockRestore() }
    expect((await adminDb.doc(`events/${SLUG}`).get()).data()!.commercial).toEqual({ attendeeTransactionFeePercent: 2, capacityDecreaseFeePercent: 3 })
  }, T)

  // ═══ Step 4/5 · the event percentage reaches the checkout snapshot ═══════════════════════
  it('no override → global 0.5% (source global); an event 1.5% → new checkouts 1.5% (source event); the charge is the ticket', async () => {
    expect((await createOrder(orderReq('p4s3KeyAAAAAAAAAA1'))).status).toBe(200)
    const g = await intentOf(h.orders[0].id)
    expect(g.amount).toBe(50_000)
    expect(g.feeInputs).toMatchObject({ attendeeFeeSource: 'global' })
    // RD-FEE-01 — the active ticket fee is the percentage + GST only: no fixed part, no minimum.
    expect(g.feeInputs.feeConfig).toMatchObject({ platformFeePercentBps: 50, platformFeeFixedPaise: 0, platformFeeMinPaise: 0, gstRatePercent: 18 })
    h.admin = SUPER
    expect((await commercial({ terms: { attendeeTransactionFeePercent: 1.5 }, reason: 'event rate' })).status).toBe(200)
    expect((await createOrder(orderReq('p4s3KeyAAAAAAAAAA2', 'b@example.test'))).status).toBe(200)
    const e = await intentOf(h.orders[1].id)
    expect(e.amount).toBe(50_000)
    expect(e.feeInputs).toMatchObject({ attendeeFeeSource: 'event' })
    expect(e.feeInputs.feeConfig).toMatchObject({ platformFeePercentBps: 150, platformFeeFixedPaise: 0, platformFeeMinPaise: 0, gstRatePercent: 18, gatewayFeePercentBps: g.feeInputs.feeConfig.gatewayFeePercentBps })
    // the earlier checkout keeps ITS terms: retry reuses it untouched; settlement uses the snapshot
    expect((await createOrder(orderReq('p4s3KeyAAAAAAAAAA1'))).status).toBe(200)
    expect(h.orders).toHaveLength(2)
    expect((await intentOf(h.orders[0].id)).feeInputs).toEqual(g.feeInputs)
    const { buildRegistrationLedgerAndCredit } = await import('@/lib/payments/registrationLedger')
    const led = await buildRegistrationLedgerAndCredit({ registrationId: 'r1', organizerUid: OWNER, eventSlug: SLUG, attendeeName: 'A', attendeeEmail: 'a@example.test',
      grossAmountPaise: g.amount, paymentId: 'p', orderId: g.orderId, feeInputs: g.feeInputs })
    expect(led.ledger.platformFeeBasePaise).toBe(250)                       // 0.5% of ₹500 — the checkout terms, not 1.5% (no ₹5 fixed part)
  }, T)

  it('engine ON: fee-preview and create-order resolve the SAME event terms; a legacy stored attendee_pays is NOT charged', async () => {
    h.engine = true
    await adminDb.doc(`events/${SLUG}`).update({ 'pricing.feeModel': 'attendee_pays', commercial: { attendeeTransactionFeePercent: 1.5 } })
    const { POST: preview } = await import('@/app/api/registrations/fee-preview/route')
    const pv = await json(await preview(req({ slug: SLUG, passId: PASS.id })))
    expect(pv.status).toBe(200)
    expect(pv.body.amountPaise).toBe(50_000)                                // organizer-pays: the ticket only
    const r = await createOrder(orderReq('p4s3KeyAAAAAAAAAA3'))
    expect(r.status).toBe(200)
    const i = await intentOf(h.orders[0].id)
    expect(i.amount).toBe(50_000)
    expect(i.financials.feeModel).toBe('organizer_pays')
    expect(i.financials).toEqual(pv.body.financials)                       // preview == order
    expect(i.feeInputs).toBeUndefined()
  }, T)

  it('Q3: the event pricing read FAILS → 503 PRICING_UNAVAILABLE, no gateway order, no intent (never priced from global)', async () => {
    const { DocumentReference } = await import('firebase-admin/firestore')
    const orig = DocumentReference.prototype.get
    const spy = vi.spyOn(DocumentReference.prototype, 'get').mockImplementation(function (this: { path: string }, ...args: unknown[]) {
      if (this.path === `events/${SLUG}` && (new Error().stack ?? '').includes('resolveEventFeeConfig')) {
        return Promise.reject(new Error('simulated Firestore outage (pricing read)'))
      }
      return (orig as (...x: unknown[]) => Promise<unknown>).apply(this, args) as never
    })
    let r: { status: number; body: Record<string, unknown> }
    try { r = await json(await createOrder(orderReq('p4s3KeyAAAAAAAAAA4'))) } finally { spy.mockRestore() }
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ code: 'PRICING_UNAVAILABLE' })
    expect(JSON.stringify(r.body)).not.toMatch(/firestore|outage|stack/i)
    expect(h.orders).toHaveLength(0)
    // and a healthy read right after works (a successfully read event with no override inherits)
    expect((await createOrder(orderReq('p4s3KeyAAAAAAAAAA4'))).status).toBe(200)
  }, T)

  it('every event type shares the same pricing: the event percentage reaches the snapshot for each', async () => {
    h.admin = SUPER
    for (const et of ['sports', 'conference', 'workshop', 'corporate', 'rotary', 'expo', 'awareness']) {
      const slug = `${SLUG}-${et}`
      await seedEvent(slug, { eventType: et, commercial: { attendeeTransactionFeePercent: 1.5 } })
      const res = await createOrder(orderReq(`p4s3Key${et.padEnd(11, 'X')}`, `${et}@example.test`, slug))
      expect(res.status, et).toBe(200)
      const i = await intentOf(h.orders[h.orders.length - 1].id)
      expect(i.amount, et).toBe(50_000)
      expect(i.feeInputs.feeConfig.platformFeePercentBps, et).toBe(150)
      expect(i.feeInputs.attendeeFeeSource, et).toBe('event')
    }
  }, T)

  // ═══ Q1 / Q4 · organizer paths ═══════════════════════════════════════════════════════
  it('organizer PATCH /edit feeModel → 403 PRICING_NOT_ORGANIZER_EDITABLE; nothing written', async () => {
    await adminDb.doc(`users/${OWNER}/eventDrafts/${DRAFT}`).set({ uid: OWNER, status: 'published', lifecycleStatus: 'published',
      pricing: { eventType: 'paid', feeModel: 'organizer_absorbs', passes: [PASS] }, eventDetails: { seo: { urlSlug: SLUG } } })
    const { PATCH } = await import('@/app/api/organizer/events/[eventId]/edit/route')
    h.who = OWNER
    for (const v of ['attendee_pays', 'organizer_absorbs']) {
      const r = await json(await PATCH(req({ feeModel: v }, 'PATCH'), { params: Promise.resolve({ eventId: DRAFT }) }))
      expect(r.status, v).toBe(403)
      expect(r.body.code, v).toBe('PRICING_NOT_ORGANIZER_EDITABLE')
    }
    expect(((await adminDb.doc(`events/${SLUG}`).get()).data()!.pricing as { feeModel: string }).feeModel).toBe('organizer_absorbs')
  }, T)

  it('legacy override routes: organizer convenienceFee 403; admin money fields 410; neither reaches the checkout', async () => {
    await adminDb.doc(`events/${SLUG}`).update({ adminOverride: { platformFeeAmount: 99 }, organizerOverride: { convenienceFee: 40 } })
    const org = await import('@/app/api/organizer/events/[eventId]/pricing-override/route')
    h.who = OWNER
    const o = await json(await org.PATCH(req({ convenienceFee: 10 }, 'PATCH'), { params: Promise.resolve({ eventId: DRAFT }) }))
    expect(o.status).toBe(403); expect(o.body.code).toBe('PRICING_NOT_ORGANIZER_EDITABLE')
    const adm = await import('@/app/api/admin/events/[slug]/pricing-override/route')
    h.admin = SUPER
    const a = await json(await adm.PATCH(req({ platformFeeAmount: 5 }, 'PATCH'), { params: Promise.resolve({ slug: SLUG }) }))
    expect(a.status).toBe(410); expect(a.body.code).toBe('PRICING_LAYER_RETIRED')
    expect((await adm.PATCH(req({ registrationLimit: 300, reason: 'raise the limit' }, 'PATCH'), { params: Promise.resolve({ slug: SLUG }) })).status).toBe(200)   // unchanged behaviour (RD-PHASE4-S4: + reason)
    // stored legacy values are not deleted — and do not affect pricing
    const ev = (await adminDb.doc(`events/${SLUG}`).get()).data()!
    expect(ev.organizerOverride).toMatchObject({ convenienceFee: 40 })
    expect((ev.adminOverride as Record<string, unknown>).platformFeeAmount).toBe(99)
    expect((await createOrder(orderReq('p4s3KeyAAAAAAAAAA5'))).status).toBe(200)
    const i = await intentOf(h.orders[0].id)
    expect(i.amount).toBe(50_000)
    expect(i.feeInputs.feeConfig.platformFeePercentBps).toBe(50)            // the global default 0.5% (RD-FEE-02)
  }, T)
})
