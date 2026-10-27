// RD-WAIVER-01 — the sports participation waiver, end to end on the Firestore emulator.
// Real route handlers (POST /api/registrations/submit, POST /api/registrations/create-order), the
// real createRegistration transaction, and the real paid settlement. Stubbed, as
// approvedContactAccess.emu does: the registration gate, rate limiters, fee plan, confirmation email
// and the payment PROVIDER — no gateway is ever called, and nothing here can create a real order.
//
//   F  free path: missing / non-literal / stale acceptance refused with nothing written;
//      a valid one records the server time and the wording fingerprint
//   T  the in-transaction re-check: wording changed after the route's check is refused
//   O  organizer paths (walk-in, import) record "required, not accepted" — never an acceptance
//   P  paid path: refused before any order exists; accepted → intent → settlement records it
//   N  events without a waiver and every existing registration are unchanged
//   X  the export shows the recorded status

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createHash } from 'node:crypto'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `wvr${process.pid}`
const OWNER = `${P}-owner`

const h = vi.hoisted(() => ({ seq: 0, orders: [] as string[] }))

vi.mock('@/lib/platform/pricing/resolver', async orig => ({
  ...(await orig<typeof import('@/lib/platform/pricing/resolver')>()),
  resolvePlatformPricing: async () => ({ features: { pricingEngineEnabled: false } }),
}))
vi.mock('@/lib/billing/feeEngine', async orig => ({
  ...(await orig<typeof import('@/lib/billing/feeEngine')>()),
  getFeePlanForOrganizer: async () => ({ planTier: 'starter', feeConfigId: 'plan:starter' }),
}))
vi.mock('@/lib/rateLimit/redis', () => ({ checkDistributedRateLimit: async () => ({ allowed: true, resetAt: 0 }) }))
vi.mock('@/lib/rateLimit', async orig => ({
  ...(await orig<typeof import('@/lib/rateLimit')>()),
  checkRateLimit: () => ({ allowed: true, remaining: 99, resetAt: 0 }),
}))
vi.mock('@/lib/registrations/gate', async orig => ({
  ...(await orig<typeof import('@/lib/registrations/gate')>()),
  checkRegistrationGate: async () => ({ allowed: true }),
}))
vi.mock('@/lib/registrations/sendConfirmationEmail', () => ({ sendConfirmationEmail: async () => undefined }))
vi.mock('@/lib/payments/providers', async orig => {
  const real = await orig<typeof import('@/lib/payments/providers')>()
  const adapter = {
    createOrder: async () => {
      const id = `order_${P}_${++h.seq}`
      h.orders.push(id)
      return { providerOrderId: id, checkout: { provider: 'razorpay', keyId: 'rzp_test_stub' } }
    },
    getCheckoutHandoff: async () => ({ provider: 'razorpay', keyId: 'rzp_test_stub' }),
    fetchOrderPayments: async () => [],
  }
  return { ...real, resolveActivePaymentProviderForNewOrder: async () => ({ ok: true, provider: 'razorpay' }), resolvePaymentProvider: () => adapter }
})
// Settlement's refund / monitoring side effects — never reached on the success path, stubbed so
// nothing can ever leave the machine.
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub', RAZORPAY_KEY_SECRET: 'stub',
  razorpay: { orders: { fetchPayments: async () => ({ items: [] }) }, payments: { refund: async () => { throw new Error('no refunds in this suite') } } },
}))
vi.mock('@/lib/firebase/firestore/platformTransactions', () => ({
  recordPlatformTransactionAndCredit: async () => {}, reversePlatformTransactionAndDebit: async () => {},
}))
vi.mock('@/lib/monitoring/sentry', () => ({
  captureFinancialError: () => {}, captureError: () => {}, captureWebhookError: () => {}, flushMonitoring: async () => {},
}))

const TEXT = 'I understand that running a half marathon carries a risk of injury and I participate at my own risk.'
const HASH = createHash('sha256').update(TEXT, 'utf8').digest('hex')

type Json = Record<string, unknown>

describeEmu('sports waiver — configuration, enforcement, recording, export', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let submit: (r: NextRequest) => Promise<Response>
  let createOrder: (r: NextRequest) => Promise<Response>
  let createRegistration: typeof import('@/lib/firebase/firestore/registrations')['createRegistration']
  let settleCapturedRegistration: typeof import('@/lib/payments/settleCapturedRegistration')['settleCapturedRegistration']
  let buildRegistrationExportRow: typeof import('@/lib/registrations/exportColumns')['buildRegistrationExportRow']
  const slugs: string[] = []
  let keySeq = 0

  async function seedEvent(key: string, o: { paid?: boolean; waiver?: { requireWaiver: boolean; waiverText: string } | null; eventType?: string } = {}) {
    const slug = `${P}-${key}`
    slugs.push(slug)
    const paid = o.paid === true
    const pass = { id: 'p1', name: 'Half Marathon', type: paid ? 'paid' : 'free', price: paid ? 500 : 0, earlyBirdEnabled: false,
      unlimited: false, quantity: 500, visibility: 'public', status: 'active' }
    await adminDb.doc(`events/${slug}`).set({
      uid: OWNER, draftId: `${slug}-draft`, slug, status: 'published', lifecycleStatus: 'published', totalCapacity: 500,
      eventType: o.eventType ?? 'sports', eventSubtype: 'running',
      pricing: { eventType: paid ? 'paid' : 'free', passes: [pass] },
      eventDetails: {
        info: { name: `Waiver ${key}` }, schedule: { startDate: '2099-12-31', timezone: 'Asia/Kolkata' }, seo: { urlSlug: slug },
        ...(o.waiver === null ? {} : { typeDetails: { routeMapUrl: '', ...(o.waiver ?? { requireWaiver: true, waiverText: TEXT }) } }),
      },
      registrationForm: { sections: [] }, accessControl: { type: 'open', confirmationMode: 'auto' },
    })
    return slug
  }

  const call = async (route: (r: NextRequest) => Promise<Response>, path: string, slug: string, extra: Json = {}) => {
    const n = ++keySeq
    const res = await route(new NextRequest(`http://x/api/registrations/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug, passId: 'p1', attendee: { name: 'Runner', email: `runner${n}@rd.test`, phone: `+9190000${String(n).padStart(5, '0')}` },
        formResponses: {}, idempotencyKey: `${P}key${String(n).padStart(12, '0')}`, termsAccepted: true, ...extra,
      }),
    }))
    return { status: res.status, body: await res.json().catch(() => ({})) as Json }
  }
  const regs = async (slug: string) =>
    (await adminDb.collection('registrations').where('eventSlug', '==', slug).get()).docs.map(d => ({ ...d.data(), id: d.id } as Json))
  const reg = async (id: string) => ({ ...(await adminDb.doc(`registrations/${id}`).get()).data(), id } as Json)
  const baseInput = (slug: string, email: string) => ({
    eventSlug: slug, passId: 'p1', passName: 'Half Marathon', passCapacity: 500, eventName: 'Waiver', organizerUid: OWNER,
    attendee: { name: 'Runner', email, formResponses: {} },
  })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST: submit } = await import('@/app/api/registrations/submit/route') as never)
    ;({ POST: createOrder } = await import('@/app/api/registrations/create-order/route') as never)
    ;({ createRegistration } = await import('@/lib/firebase/firestore/registrations'))
    ;({ settleCapturedRegistration } = await import('@/lib/payments/settleCapturedRegistration'))
    ;({ buildRegistrationExportRow } = await import('@/lib/registrations/exportColumns'))
  }, T)

  afterAll(async () => {
    for (const slug of slugs) {
      for (const d of (await adminDb.collection('registrations').where('eventSlug', '==', slug).get()).docs) await adminDb.recursiveDelete(d.ref).catch(() => null)
      for (const c of (await adminDb.collection('registrationClaims').where('eventSlug', '==', slug).get().catch(() => null))?.docs ?? []) await c.ref.delete().catch(() => null)
      for (const c of (await adminDb.collection('paymentAttemptClaims').where('eventSlug', '==', slug).get().catch(() => null))?.docs ?? []) await c.ref.delete().catch(() => null)
      await adminDb.recursiveDelete(adminDb.doc(`events/${slug}`)).catch(() => null)
      await adminDb.doc(`registrationCounters/${slug}`).delete().catch(() => null)
    }
    for (const o of h.orders) await adminDb.doc(`paymentIntents/${o}`).delete().catch(() => null)
  }, T)

  // ─── F · free path ───────────────────────────────────────────────────────────

  it('F1 · no acceptance, a false, or a non-literal "true" is refused and writes nothing', async () => {
    const slug = await seedEvent('f1')
    for (const extra of [{}, { waiverAccepted: false, waiverTextHash: HASH }, { waiverAccepted: 'true', waiverTextHash: HASH }, { waiverAccepted: 1, waiverTextHash: HASH }]) {
      const r = await call(submit, 'submit', slug, extra)
      expect(r.status, JSON.stringify(extra)).toBe(400)
      expect(r.body.reason).toBe('WAIVER_NOT_ACCEPTED')
    }
    expect(await regs(slug)).toHaveLength(0)
  }, T)

  it('F2 · an acceptance of other (or unstated) wording is refused — the page must be reloaded', async () => {
    const slug = await seedEvent('f2')
    for (const waiverTextHash of [undefined, createHash('sha256').update('old wording').digest('hex')]) {
      const r = await call(submit, 'submit', slug, { waiverAccepted: true, waiverTextHash })
      expect(r.status).toBe(409)
      expect(r.body.reason).toBe('WAIVER_CHANGED')
    }
    expect(await regs(slug)).toHaveLength(0)
  }, T)

  it('F3 · a valid acceptance registers and records the server time and the wording fingerprint', async () => {
    const slug = await seedEvent('f3')
    const t0 = Date.now()
    const r = await call(submit, 'submit', slug, { waiverAccepted: true, waiverTextHash: HASH, waiverAcceptedAt: '1999-01-01T00:00:00.000Z' })
    const t1 = Date.now()
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const d = await reg(String(r.body.registrationId))
    expect(d).toMatchObject({ waiverRequired: true, waiverAccepted: true, waiverTextHash: HASH })
    // the server's clock, as an ISO string — a client-supplied time is ignored
    const at = Date.parse(String(d.waiverAcceptedAt))
    expect(typeof d.waiverAcceptedAt).toBe('string')
    expect(at).toBeGreaterThanOrEqual(t0 - 1000)
    expect(at).toBeLessThanOrEqual(t1 + 1000)
  }, T)

  // ─── T · in-transaction re-check ─────────────────────────────────────────────

  it('T1 · wording changed after the route checked it is refused inside the transaction', async () => {
    const slug = await seedEvent('t1')
    await adminDb.doc(`events/${slug}`).update({ 'eventDetails.typeDetails.waiverText': `${TEXT} Updated clause.` })
    const { WaiverNotAcceptedError } = await import('@/lib/firebase/firestore/registrations')
    await expect(createRegistration({ ...baseInput(slug, 'stale@rd.test'), enforceWaiver: true, waiverAcceptance: { textHash: HASH, acceptedAt: new Date().toISOString() } }))
      .rejects.toMatchObject({ reason: 'WAIVER_CHANGED' })
    await expect(createRegistration({ ...baseInput(slug, 'none@rd.test'), enforceWaiver: true }))
      .rejects.toBeInstanceOf(WaiverNotAcceptedError)
    expect(await regs(slug)).toHaveLength(0)
  }, T)

  // ─── O · organizer paths ─────────────────────────────────────────────────────

  it('O1 · walk-in / import registrations are "required, not accepted" — never accepted on the attendee’s behalf', async () => {
    const slug = await seedEvent('o1')
    const walkin = await createRegistration({ ...baseInput(slug, 'walkin@rd.test'), registrationSource: 'walkin', paymentStatusOverride: 'not_required' })
    expect(await reg(walkin.registrationId)).toMatchObject({ waiverRequired: true, waiverAccepted: false, waiverAcceptedAt: null, waiverTextHash: HASH })
  }, T)

  // ─── P · paid path ───────────────────────────────────────────────────────────

  it('P1 · create-order refuses a missing or stale acceptance before any payment order exists', async () => {
    const slug = await seedEvent('p1', { paid: true })
    const before = h.orders.length
    const missing = await call(createOrder, 'create-order', slug)
    expect(missing.status).toBe(400)
    expect(missing.body.reason).toBe('WAIVER_NOT_ACCEPTED')
    const stale = await call(createOrder, 'create-order', slug, { waiverAccepted: true, waiverTextHash: 'x'.repeat(64) })
    expect(stale.status).toBe(409)
    expect(h.orders.length).toBe(before)
    expect((await adminDb.collection('paymentIntents').where('eventSlug', '==', slug).get()).size).toBe(0)
  }, T)

  it('P2 · an accepted paid registration carries the acceptance from checkout to the settled registration', async () => {
    const slug = await seedEvent('p2', { paid: true })
    const t0 = Date.now()
    const r = await call(createOrder, 'create-order', slug, { waiverAccepted: true, waiverTextHash: HASH })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const orderId = String(r.body.orderId)
    const intent = (await adminDb.doc(`paymentIntents/${orderId}`).get()).data() as Json
    const acc = intent.waiverAcceptance as { textHash: string; acceptedAt: string }
    expect(acc.textHash).toBe(HASH)
    expect(Date.parse(acc.acceptedAt)).toBeGreaterThanOrEqual(t0 - 1000)

    // The organizer edits the wording while the payment is in flight: the record must still say
    // what THIS attendee accepted, at the time they accepted it.
    await adminDb.doc(`events/${slug}`).update({ 'eventDetails.typeDetails.waiverText': `${TEXT} Clause added later.` })
    const res = await settleCapturedRegistration({ orderId, paymentId: `pay_${P}_1`, intent: { ...intent, provider: 'razorpay' } as never, source: 'webhook' })
    const regId = (res as { registrationId?: string }).registrationId ?? (await regs(slug))[0]?.id
    expect(regId).toBeTruthy()
    expect(await reg(String(regId))).toMatchObject({ waiverRequired: true, waiverAccepted: true, waiverAcceptedAt: acc.acceptedAt, waiverTextHash: HASH })
  }, T)

  // ─── N · unchanged behaviour ─────────────────────────────────────────────────

  it('N1 · events without a waiver register as before and record nothing, even if fields are sent', async () => {
    const plain   = await seedEvent('n1', { waiver: null })
    const nonSport = await seedEvent('n1c', { eventType: 'conference' })
    const unworded = await seedEvent('n1u', { waiver: { requireWaiver: true, waiverText: '   ' } })
    for (const slug of [plain, nonSport, unworded]) {
      const r = await call(submit, 'submit', slug, { waiverAccepted: true, waiverTextHash: HASH })
      expect(r.status, slug).toBe(200)
      const d = await reg(String(r.body.registrationId))
      for (const k of ['waiverRequired', 'waiverAccepted', 'waiverAcceptedAt', 'waiverTextHash']) expect(d, `${slug}.${k}`).not.toHaveProperty(k)
    }
  }, T)

  it('N2 · existing registrations are untouched when a waiver is switched on later', async () => {
    const slug = await seedEvent('n2', { waiver: null })
    const before = await call(submit, 'submit', slug)
    expect(before.status).toBe(200)
    await adminDb.doc(`events/${slug}`).update({ 'eventDetails.typeDetails': { requireWaiver: true, waiverText: TEXT } })
    const after = await call(submit, 'submit', slug, { waiverAccepted: true, waiverTextHash: HASH })
    expect(after.status).toBe(200)
    const old = await reg(String(before.body.registrationId))
    expect(old).not.toHaveProperty('waiverRequired')
    expect(await reg(String(after.body.registrationId))).toMatchObject({ waiverAccepted: true })
  }, T)

  // ─── X · export ──────────────────────────────────────────────────────────────

  it('X1 · the participant export shows each registration’s recorded status', async () => {
    const slug = await seedEvent('x1')
    const ok = await call(submit, 'submit', slug, { waiverAccepted: true, waiverTextHash: HASH })
    const walk = await createRegistration({ ...baseInput(slug, 'walk2@rd.test'), registrationSource: 'walkin', paymentStatusOverride: 'not_required' })
    const ctx = { eventId: `${slug}-draft`, eventSlug: slug, fieldLabels: {} }
    const accepted = await reg(String(ok.body.registrationId))
    expect(buildRegistrationExportRow(accepted, ctx)).toMatchObject({ waiverStatus: 'Accepted', waiverAcceptedAt: accepted.waiverAcceptedAt })
    expect(buildRegistrationExportRow(await reg(walk.registrationId), ctx)).toMatchObject({ waiverStatus: 'Not accepted', waiverAcceptedAt: null })
  }, T)
})
