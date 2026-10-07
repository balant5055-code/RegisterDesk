// RD-EVENT-COMMERCE-04 — Super Admin licensing & pricing alignment.
//
// REAL handlers against REAL Firestore (emulator). Razorpay is an in-memory stub — `.env.local`
// holds LIVE keys, so no request leaves the process. The business-config doc is backed up and
// restored around the suite.
//
//   CFG   Super Admin config: auth, server validation, fail-safe on malformed stored values,
//         updated rates reach the NEXT quote, historical orders are untouched
//   ADM   admin licence actions cannot undercut a capacity event (sold floor, no free
//         "unlimited", no hand-marked gateway payment) and reissue never re-reads history
//   AUD   per-event commercial overrides reach the platform audit log

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

const UID   = `ec04-org-${process.pid}`
const SLUG  = `ec04-live-${process.pid}`
const ADMIN = `ec04-admin-${process.pid}`
const CFG_DOC = 'system/businessConfiguration'

const h = vi.hoisted(() => ({ admin: true as boolean }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_ec04', RAZORPAY_KEY_SECRET: 'ec04',
  razorpay: {
    orders:   { create: async () => { throw new Error('no orders in this suite') }, fetchPayments: async () => ({ items: [] }) },
    payments: { fetch: async () => { throw new Error('no payment') }, refund: async () => { throw new Error('no refunds') } },
  },
}))
vi.mock('@/lib/admin/auth', async orig => ({
  ...(await orig<typeof import('@/lib/admin/auth')>()),
  resolveAdminUid: async () => (h.admin ? ADMIN : null),
  // RD-EVENT-COMMERCE-04A — pricing writes need the Super Admin mechanism; this suite's admin is
  // one (the ordinary-admin / organizer / forged cases are in eventCommerce04a.emu.test.ts).
  resolveSuperAdminUid: async () => (h.admin ? ADMIN : null),
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => ({ uid: UID, email: null }),
}))

const req = (method: 'GET' | 'POST', body?: unknown) => new NextRequest('http://x/api/t', {
  method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })

describeEmu('RD-EVENT-COMMERCE-04 · admin licensing & pricing alignment', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let cfgBackup: Record<string, unknown> | null = null

  async function seedLive(opts: { capacity?: number; sold?: number; licence?: Record<string, unknown> } = {}) {
    await adminDb.doc(`events/${SLUG}`).set({ uid: UID, draftId: 'EC04Draft', totalCapacity: opts.capacity ?? 600, lifecycleStatus: 'published' })
    await adminDb.doc(`registrationCounters/${SLUG}`).set({ eventSlug: SLUG, totalCount: opts.sold ?? 0 })
    await adminDb.doc(`eventLicenses/${SLUG}`).set(opts.licence ?? {
      eventId: SLUG, organizerUid: UID, tier: 'free', status: 'active', version: 2,
      orderId: `lic_ec04_${process.pid}`, commercialModel: 'capacity', capacity: opts.capacity ?? 600,
    })
  }
  async function wipe() {
    for (const c of ['licenseHistory', 'adminAuditLogs']) {
      for (const d of (await adminDb.collection(c).where(c === 'adminAuditLogs' ? 'entityId' : 'eventId', '==', SLUG).get()).docs) await d.ref.delete()
    }
    for (const p of [`events/${SLUG}`, `eventLicenses/${SLUG}`, `registrationCounters/${SLUG}`, `licenseOrders/lic_ec04_${process.pid}`]) {
      await adminDb.doc(p).delete().catch(() => null)
    }
    h.admin = true
  }
  async function resetConfig() {
    if (cfgBackup) await adminDb.doc(CFG_DOC).set(cfgBackup)
    else await adminDb.doc(CFG_DOC).delete().catch(() => null)
    const { businessConfig } = await import('@/lib/config/businessConfigService')
    businessConfig.invalidateCache()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    const snap = await adminDb.doc(CFG_DOC).get()
    cfgBackup = snap.exists ? snap.data() as Record<string, unknown> : null
  }, T)
  afterAll(async () => { await wipe(); await resetConfig() }, T)
  beforeEach(async () => { await wipe(); await resetConfig() }, T)

  // ═══ CFG · Super Admin configuration ═══════════════════════════════════════════
  it('CFG · a non-admin can neither read nor change the business configuration (403)', async () => {
    h.admin = false
    const { GET, POST } = await import('@/app/api/admin/business-config/route')
    expect((await GET(req('GET'))).status).toBe(403)
    const r = await POST(req('POST', { section: 'licensing', patch: { commercial: { activationRatePaise: 1 } }, reason: 'x' }))
    expect(r.status).toBe(403)
  }, T)

  it('CFG · invalid / negative / malformed / out-of-range commercial values are refused and nothing is stored', async () => {
    const { POST } = await import('@/app/api/admin/business-config/route')
    const { businessConfig } = await import('@/lib/config/businessConfigService')
    const before = (await businessConfig.getSection('licensing')).commercial
    const bad: Array<Record<string, unknown>> = [
      { activationRatePaise: -150 }, { activationRatePaise: 1.5 }, { activationRatePaise: '150' },
      { gstRatePercent: 150 }, { gstRatePercent: -1 }, { freeRegistrationCapacity: -1 },
      { maximumEventCapacity: 0 }, { maximumEventCapacity: 50, freeRegistrationCapacity: 100 },
    ]
    for (const c of bad) {
      const r = await json(await POST(req('POST', { section: 'licensing', patch: { commercial: { ...before, ...c } }, reason: 'negative test' })))
      expect(r.status, JSON.stringify(c)).toBe(400)
    }
    businessConfig.invalidateCache()
    expect((await businessConfig.getSection('licensing')).commercial).toEqual(before)
    // A reason is mandatory.
    expect((await POST(req('POST', { section: 'licensing', patch: { commercial: before }, reason: '' }))).status).toBe(400)
  }, T)

  it('CFG · an authorised GST change is audited and reaches the NEXT quote; the approved defaults price 437 at ₹596.49', async () => {
    const { POST } = await import('@/app/api/admin/business-config/route')
    const { POST: quote } = await import('@/app/api/licensing/checkout/quote/route')
    const { businessConfig } = await import('@/lib/config/businessConfigService')
    // Approved contract: 100 free · ₹1.50 · 18% GST ⇒ 337 × 150 = 50,550 + 9,099 = 59,649.
    const q0 = await json(await quote(req('POST', { capacity: 437, services: {} })))
    expect(q0.status).toBe(200)
    expect((q0.body.capacity as { quote: { totalPaise: number } }).quote.totalPaise).toBe(59_649)

    const cur = (await businessConfig.getSection('licensing')).commercial
    const r = await json(await POST(req('POST', { section: 'licensing', patch: { commercial: { ...cur, gstRatePercent: 12 } }, reason: 'GST rate change test' })))
    expect(r.status).toBe(200)
    // Versioned history row written with who + why.
    const hist = await adminDb.collection(`${CFG_DOC}/history`).where('version', '==', r.body.version).get()
    expect(hist.docs[0]?.get('updatedBy')).toBe(ADMIN)
    expect(hist.docs[0]?.get('reason')).toBe('GST rate change test')

    const q1 = await json(await quote(req('POST', { capacity: 437, services: {} })))
    // 50,550 + 12% (6,066) = 56,616.
    expect((q1.body.capacity as { quote: { totalPaise: number; gstRatePercent: number } }).quote).toMatchObject({ totalPaise: 56_616, gstRatePercent: 12 })
  }, T)

  it('CFG · a config change never rewrites a paid order (its terms are a VALUE snapshot)', async () => {
    const { POST } = await import('@/app/api/admin/business-config/route')
    const { businessConfig } = await import('@/lib/config/businessConfigService')
    const orderId = `lic_ec04_${process.pid}`
    const snapshot = { operation: 'activation', capacity: 437, totalPaise: 59_649, terms: { activationRatePaise: 150, gstRatePercent: 18 } }
    await adminDb.doc(`licenseOrders/${orderId}`).set({ orderId, status: 'paid', amountPaise: 59_649, razorpayAmountPaise: 59_649, capacityChange: snapshot })
    const cur = (await businessConfig.getSection('licensing')).commercial
    expect((await POST(req('POST', { section: 'licensing', patch: { commercial: { ...cur, activationRatePaise: 300 } }, reason: 'rate change' }))).status).toBe(200)
    const after = (await adminDb.doc(`licenseOrders/${orderId}`).get()).data()!
    expect(after).toMatchObject({ status: 'paid', amountPaise: 59_649, razorpayAmountPaise: 59_649, capacityChange: snapshot })
  }, T)

  it('CFG · malformed service-allowance values written OUTSIDE the admin API can never make a service sellable', async () => {
    const { getServiceAllowancesConfig } = await import('@/lib/licensing/serviceAllowanceConfig')
    const { serviceAvailability } = await import('@/lib/licensing/serviceAllowances')
    const { businessConfig } = await import('@/lib/config/businessConfigService')
    const bogus = { enabled: true, unitPricePaise: -45, gstRatePercent: 18, minQuantity: 1, maxQuantity: 1000, presets: [], onExhausted: 'block' }
    await adminDb.doc(CFG_DOC).set({ licensing: { serviceAllowances: { whatsapp: bogus, certificates: { ...bogus, unitPricePaise: '200' }, media: { ...bogus, unitPricePaise: 0 } } } }, { merge: true })
    businessConfig.invalidateCache()
    const cfg = await getServiceAllowancesConfig()
    for (const k of ['whatsapp', 'certificates', 'media'] as const) expect(serviceAvailability(cfg[k]).purchasable, k).toBe(false)
    // And through the real quote route: a quantity for it is refused, nothing is priced.
    const { POST: quote } = await import('@/app/api/licensing/checkout/quote/route')
    const q = await json(await quote(req('POST', { capacity: 100, services: { whatsapp: 500 } })))
    expect((q.body.services as Record<string, { ok: boolean }>).whatsapp.ok).toBe(false)
  }, T)

  // ═══ ADM · admin licence actions ═══════════════════════════════════════════════
  it('ADM · overrideLimit can NEVER go below registrations already taken (409, capacity unchanged)', async () => {
    await seedLive({ capacity: 600, sold: 450 })
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    await expect(applyLicenseAction(SLUG, { action: 'overrideLimit', limitKey: 'maxRegistrations', limitValue: 449, reason: 'test' } as never, ADMIN))
      .rejects.toMatchObject({ status: 409 })
    expect((await adminDb.doc(`events/${SLUG}`).get()).get('totalCapacity')).toBe(600)
    // At or above sold is an authorised admin override and applies.
    await applyLicenseAction(SLUG, { action: 'overrideLimit', limitKey: 'maxRegistrations', limitValue: 450, reason: 'comp to sold' } as never, ADMIN)
    expect((await adminDb.doc(`events/${SLUG}`).get()).get('totalCapacity')).toBe(450)
    // The PURCHASED figure on the licence is not rewritten by an admin override.
    expect((await adminDb.doc(`eventLicenses/${SLUG}`).get()).get('capacity')).toBe(600)
  }, T)

  it('ADM · a capacity licence cannot be made UNLIMITED (purchased capacity is never given away)', async () => {
    await seedLive({ capacity: 600, sold: 10 })
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    await expect(applyLicenseAction(SLUG, { action: 'overrideLimit', limitKey: 'maxRegistrations', limitValue: null, reason: 'test' } as never, ADMIN))
      .rejects.toMatchObject({ status: 409 })
    expect((await adminDb.doc(`events/${SLUG}`).get()).get('totalCapacity')).toBe(600)
  }, T)

  it('ADM · "mark paid" is refused on a capacity licence and the gateway order stays unpaid', async () => {
    await seedLive({ capacity: 600 })
    const orderId = `lic_ec04_${process.pid}`
    await adminDb.doc(`licenseOrders/${orderId}`).set({ orderId, status: 'created', amountPaise: 59_649 })
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    await expect(applyLicenseAction(SLUG, { action: 'markPaymentReceived', reason: 'test' } as never, ADMIN)).rejects.toMatchObject({ status: 409 })
    expect((await adminDb.doc(`licenseOrders/${orderId}`).get()).get('status')).toBe('created')
  }, T)

  it('ADM · a historical TIER licence keeps the manual "mark paid" path (legacy behaviour preserved)', async () => {
    await seedLive({ licence: { eventId: SLUG, organizerUid: UID, tier: 'professional', status: 'pending', version: 2, orderId: null } })
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    await applyLicenseAction(SLUG, { action: 'markPaymentReceived', reason: 'offline payment' } as never, ADMIN)
    expect((await adminDb.doc(`eventLicenses/${SLUG}`).get()).get('status')).toBe('active')
  }, T)

  it('ADM · reissue keeps a historical licence at its STORED version (never re-read under another catalog)', async () => {
    await seedLive({ capacity: 250, licence: { eventId: SLUG, organizerUid: UID, tier: 'growth', status: 'suspended', version: 1, orderId: null } })
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    await applyLicenseAction(SLUG, { action: 'reissue', reason: 'support recovery' } as never, ADMIN)
    const lic = (await adminDb.doc(`eventLicenses/${SLUG}`).get()).data()!
    expect(lic).toMatchObject({ tier: 'growth', version: 1, status: 'active' })
  }, T)

  it('ADM · the detail payload flags a capacity licence so the tier actions are not offered', async () => {
    await seedLive({ capacity: 600 })
    const { getLicenseDetail } = await import('@/lib/admin/licenseAdminService')
    expect((await getLicenseDetail(SLUG))?.capacityModel).toBe(true)
    await adminDb.doc(`eventLicenses/${SLUG}`).set({ eventId: SLUG, organizerUid: UID, tier: 'professional', status: 'active', version: 2 })
    expect((await getLicenseDetail(SLUG))?.capacityModel).toBe(false)
  }, T)

  // ═══ AUD · per-event commercial override audit ═════════════════════════════════
  it('AUD · a per-event commercial override lands in licenseHistory AND the platform audit log', async () => {
    await seedLive({ capacity: 600 })
    const { POST } = await import('@/app/api/admin/events/[slug]/commercial/route')
    const ctx = { params: Promise.resolve({ slug: SLUG }) }
    const r = await POST(req('POST', { terms: { activationRatePaise: 120 }, reason: 'negotiated rate' }), ctx)
    expect(r.status).toBe(200)
    const logs = await adminDb.collection('adminAuditLogs').where('entityId', '==', SLUG).get()
    const set = logs.docs.map(d => d.data()).find(d => d.action === 'commercial_terms.set')
    expect(set).toMatchObject({ adminUid: ADMIN, entityType: 'event', metadata: { reason: 'negotiated rate', after: { activationRatePaise: 120 } } })
    const hist = await adminDb.collection('licenseHistory').where('eventId', '==', SLUG).get()
    expect(hist.docs.some(d => d.get('action') === 'commercial_terms_override')).toBe(true)
    // A non-admin is refused.
    h.admin = false
    expect((await POST(req('POST', { terms: { activationRatePaise: 1 }, reason: 'x' }), ctx)).status).toBe(403)
  }, T)
})
