// RD-EVENT-COMMERCE-05 — pay-as-you-go licensing & services, END TO END on real Firestore:
// Super Admin configures prices through the REAL business-config route (real Auth-emulator
// tokens) → the organizer's quote reflects them → purchase creates ONE Razorpay order → a
// signature-verified confirm grants the allowance exactly once → consumption → exhausted →
// buy more → purchase history. Plus: every not-for-sale reason is reported specifically, and the
// retired tier actions are refused.
//
// Razorpay is an in-memory stub (no request leaves the process; refunds are COUNTED and must stay
// 0). The prices below are TEST-ONLY values written by the test's own Super Admin — none is a
// production price.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
// RD-EVENT-COMMERCE-05F — requests carry the Publish Agreement, as the wizard's always do.
import { withPublishAgreement } from '../helpers/publishAgreement'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const PID = process.pid
const SECRET = 'rd_commerce_05_secret'
const ORG = `c05-org-${PID}`
const CFG_DOC = 'system/businessConfiguration'
const PASSWORD = 'C05Passw0rd!'
const EMAIL = { superAdmin: `c05-super-${PID}@registerdesk.test`, admin: `c05-admin-${PID}@registerdesk.test` }

const h = vi.hoisted(() => ({
  seq: 0, refunds: 0,
  orders:   [] as Array<{ id: string; amount: number }>,
  payments: new Map<string, Record<string, unknown>>(),
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_c05', RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number }) => { const x = { id: `order_c05_${++h.seq}`, amount: o.amount }; h.orders.push(x); return x },
      fetchPayments: async () => ({ items: [] }),
    },
    payments: {
      fetch:  async (id: string) => { const p = h.payments.get(id); if (!p) throw new Error('payment not found'); return p },
      refund: async () => { h.refunds++; return { id: `rfnd_c05_${h.refunds}` } },
    },
  },
}))
vi.mock('@/lib/team/access', async orig => ({ ...(await orig<typeof import('@/lib/team/access')>()), verifyCaller: async () => ({ uid: ORG, email: null }) }))
vi.mock('@/lib/team/workspace', async orig => {
  const ctx = { callerUid: ORG, workspaceUid: ORG, role: 'owner', permissions: [], isOwner: true, eventIds: [], isStaffCredential: false }
  return { ...(await orig<typeof import('@/lib/team/workspace')>()), resolveWorkspaceUid: async () => ctx, authorizeWorkspace: async () => ({ ...ctx, ok: true, status: 200, error: '' }) }
})
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))

// TEST-ONLY prices, set through the real route by this suite's Super Admin.
const WA   = { enabled: true, unitPricePaise: 45,  gstRatePercent: 18, minQuantity: 100, maxQuantity: 50_000, presets: [500, 1_000], onExhausted: 'block' }
const CERT = { enabled: true, unitPricePaise: 200, gstRatePercent: 18, minQuantity: 10,  maxQuantity: 10_000, presets: [100],       onExhausted: 'wallet_payg' }

const sign = (o: string, p: string) => crypto.createHmac('sha256', SECRET).update(`${o}|${p}`).digest('hex')

describeEmu('RD-EVENT-COMMERCE-05 · pay-as-you-go licensing & services end to end', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let cfgBackup: Record<string, unknown> | null = null
  const uid: Record<keyof typeof EMAIL, string> = { superAdmin: '', admin: '' }
  const token: Record<keyof typeof EMAIL, string> = { superAdmin: '', admin: '' }
  const savedAdminUids = process.env.ADMIN_UIDS
  const drafts = new Set<string>()
  const DRAFT = `C05Draft${PID}`

  const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
  const signIn = async (email: string) => {
    const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }) })
    const j = await r.json() as { idToken?: string }; if (!j.idToken) throw new Error('sign-in failed'); return j.idToken
  }
  const req = (method: 'GET' | 'POST', body?: unknown, bearer = 'org', url = 'http://x/api/t') => new NextRequest(url, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
  const cfg = async () => (await import('@/lib/config/businessConfigService')).businessConfig

  async function configureServices(who: keyof typeof EMAIL, serviceAllowances: Record<string, unknown>) {
    const { POST } = await import('@/app/api/admin/business-config/route')
    const cur = await (await cfg()).getSection('licensing')
    return json(await POST(req('POST', { section: 'licensing', patch: { ...cur, serviceAllowances: { ...cur.serviceAllowances, ...serviceAllowances } }, reason: 'C05 test pricing' }, token[who])))
  }
  const quote = async (capacity: number, services: Record<string, number>) => {
    const { POST } = await import('@/app/api/licensing/checkout/quote/route')
    return json(await POST(req('POST', { eventId: DRAFT, capacity, services })))
  }
  async function payLatest(eventId: string, orderId?: string) {
    const order = h.orders[h.orders.length - 1]
    const paymentId = `pay_c05_${++h.seq}`
    h.payments.set(paymentId, { id: paymentId, order_id: order.id, amount: order.amount, currency: 'INR', status: 'captured' })
    const { POST } = await import('@/app/api/licensing/checkout/confirm/route')
    const body = { eventId, ...(orderId ? { orderId } : {}), razorpay_order_id: order.id, razorpay_payment_id: paymentId, razorpay_signature: sign(order.id, paymentId) }
    return { first: await json(await POST(req('POST', body))), replay: await json(await POST(req('POST', body))) }
  }
  const ledger = async () => (await adminDb.doc(`eventServiceAllowances/${DRAFT}`).get()).data() as Record<string, { purchased: number; consumed: number }> | undefined

  function draftDoc() {
    return { id: DRAFT, uid: ORG, status: 'draft', lifecycleStatus: 'draft', currentStep: 6, eventType: 'conference', eventSubtype: 'tech',
      campaignType: 'event_only', visibility: 'public', pricing: { eventType: 'paid', whatsappEnabled: true, certEnabled: true, passes: [] },
      eventDetails: { info: { name: 'C05' }, seo: { urlSlug: '' } }, registrationCapacity: 437, licenseTier: 'free' }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    const c = await adminDb.doc(CFG_DOC).get(); cfgBackup = c.exists ? c.data() as Record<string, unknown> : null
    for (const k of Object.keys(EMAIL) as Array<keyof typeof EMAIL>) {
      const u = (await adminAuth.getUserByEmail(EMAIL[k]).catch(() => null)) ?? await adminAuth.createUser({ email: EMAIL[k], password: PASSWORD, emailVerified: true })
      uid[k] = u.uid; await adminAuth.setCustomUserClaims(u.uid, { admin: true })
    }
    process.env.ADMIN_UIDS = uid.superAdmin
    for (const k of Object.keys(EMAIL) as Array<keyof typeof EMAIL>) token[k] = await signIn(EMAIL[k])
  }, T)
  async function wipe() {
    for (const d of [DRAFT, ...drafts]) {
      await adminDb.doc(`users/${ORG}/eventDrafts/${d}`).delete().catch(() => null)
      await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${d}`)).catch(() => null)
      for (const o of (await adminDb.collection('licenseOrders').where('eventId', '==', d).get()).docs) await o.ref.delete()
    }
    h.orders.length = 0; h.payments.clear(); h.refunds = 0
  }
  async function restoreConfig() {
    if (cfgBackup) await adminDb.doc(CFG_DOC).set(cfgBackup); else await adminDb.doc(CFG_DOC).delete().catch(() => null)
    ;(await cfg()).invalidateCache()
  }
  beforeEach(async () => { await wipe(); await restoreConfig(); await adminDb.doc(`users/${ORG}/eventDrafts/${DRAFT}`).set(draftDoc()) }, T)
  afterAll(async () => {
    await wipe(); await restoreConfig()
    for (const c of [`${CFG_DOC}/history`, 'configurationAudit']) for (const u of Object.values(uid)) for (const d of (await adminDb.collection(c).where('updatedBy', '==', u).get()).docs) await d.ref.delete()
    for (const k of Object.keys(EMAIL) as Array<keyof typeof EMAIL>) await adminAuth.deleteUser(uid[k]).catch(() => null)
    if (savedAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedAdminUids
  }, T)

  it('RD-EVENT-COMMERCE-05A · nothing stored ⇒ the APPROVED defaults are on sale: quote → order → verified grant (once)', async () => {
    const q = await quote(437, { whatsapp: 1_000, certificates: 100 })
    const cat = q.body.catalog as Record<string, { purchasable: boolean; state: string; unitPricePaise: number; gstRatePercent: number; maxQuantity: number | null }>
    expect(cat.whatsapp).toMatchObject({ purchasable: true, state: 'available', unitPricePaise: 20, gstRatePercent: 18, maxQuantity: null })
    expect(cat.certificates).toMatchObject({ purchasable: true, state: 'available', unitPricePaise: 190, gstRatePercent: 18 })
    // Capacity 437 ₹596.49 + 1,000 × ₹0.20 (₹200 + ₹36) + 100 × ₹1.90 (₹190 + ₹34.20) = ₹1,052.69.
    const total = (q.body.totals as { totalPaise: number }).totalPaise
    expect(total).toBe(59_649 + 23_600 + 22_420)

    const purchase = withPublishAgreement((await import('@/app/api/licensing/purchase/route')).POST)
    const p = await json(await purchase(req('POST', { eventId: DRAFT, capacity: 437, services: { whatsapp: 1_000, certificates: 100 }, expectedTotalPaise: total })))
    expect(p.status).toBe(200)
    expect(h.orders).toHaveLength(1); expect(h.orders[0].amount).toBe(total)      // server-authoritative amount
    expect(await ledger()).toBeUndefined()                                      // nothing before payment
    const { first, replay } = await payLatest(DRAFT)
    expect(first.status).toBe(200); expect(replay.status).toBe(200)
    expect(await ledger()).toMatchObject({ whatsapp: { purchased: 1_000 }, certificates: { purchased: 100 } })   // once
    expect(h.refunds).toBe(0)
    // No wallet was touched by the purchase.
    expect((await adminDb.doc(`organizerWallets/${ORG}`).get()).exists).toBe(false)
  }, T)

  it('RD-EVENT-COMMERCE-05A · a Super Admin price edit is reflected; the ordinary admin cannot change it', async () => {
    expect((await configureServices('admin', { whatsapp: { ...WA, unitPricePaise: 25 } })).status).toBe(403)
    expect(((await quote(437, {})).body.catalog as Record<string, { unitPricePaise: number }>).whatsapp.unitPricePaise).toBe(20)
    expect((await configureServices('superAdmin', { whatsapp: { ...WA, unitPricePaise: 25, maxQuantity: null } })).status).toBe(200)
    expect(((await quote(437, {})).body.catalog as Record<string, { unitPricePaise: number }>).whatsapp.unitPricePaise).toBe(25)
  }, T)

  it('only a Super Admin can put a service on sale; an incomplete "for sale" is refused with the reason', async () => {
    expect((await configureServices('admin', { whatsapp: WA })).status).toBe(403)
    const incomplete = await configureServices('superAdmin', { whatsapp: { ...WA, unitPricePaise: null } })
    expect(incomplete.status).toBe(400); expect(incomplete.body.code).toBe('SERVICE_NOT_READY')
    const badPreset = await configureServices('superAdmin', { whatsapp: { ...WA, presets: [50] } })
    expect(badPreset.status).toBe(400)
    const ok = await configureServices('superAdmin', { whatsapp: WA, certificates: CERT })
    expect(ok.status).toBe(200)
    const cat = (await quote(437, {})).body.catalog as Record<string, { purchasable: boolean; state: string; unitPricePaise: number; presets: number[] }>
    expect(cat.whatsapp).toMatchObject({ purchasable: true, state: 'available', unitPricePaise: 45, presets: [500, 1_000] })
    expect(cat.certificates).toMatchObject({ purchasable: true, state: 'available', unitPricePaise: 200 })
  }, T)

  it('paused and corrupt states are reported specifically — and neither is sellable', async () => {
    expect((await configureServices('superAdmin', { whatsapp: { ...WA, enabled: false }, certificates: CERT })).status).toBe(200)
    // A corrupt stored entry (written outside the API) — resolved per service.
    await adminDb.doc(CFG_DOC).set({ licensing: { serviceAllowances: { certificates: { ...CERT, unitPricePaise: -1 } } } }, { merge: true })
    ;(await cfg()).invalidateCache()
    const q = await quote(437, { whatsapp: 500, certificates: 100 })
    const cat = q.body.catalog as Record<string, { state: string }>
    expect(cat.whatsapp.state).toBe('disabled'); expect(cat.certificates.state).toBe('invalid')
    const svc = q.body.services as Record<string, { ok: boolean; error: string }>
    expect(svc.whatsapp).toMatchObject({ ok: false }); expect(svc.whatsapp.error).toMatch(/paused sales/)
    expect(svc.certificates.error).toMatch(/correcting their pricing/)
  }, T)

  it('quote → ONE order → nothing granted before payment → verified confirm grants exactly once → consume → exhausted → buy more → history', async () => {
    expect((await configureServices('superAdmin', { whatsapp: WA, certificates: CERT })).status).toBe(200)
    // Quote: capacity 437 (₹596.49) + 500 WhatsApp (₹265.50) + 100 certificates (₹236) = ₹1,097.99.
    const q = await quote(437, { whatsapp: 500, certificates: 100 })
    const total = (q.body.totals as { totalPaise: number }).totalPaise
    expect(total).toBe(59_649 + 26_550 + 23_600)

    const purchase = withPublishAgreement((await import('@/app/api/licensing/purchase/route')).POST)
    // A tampered displayed total is refused before any order.
    expect((await json(await purchase(req('POST', { eventId: DRAFT, capacity: 437, services: { whatsapp: 500, certificates: 100 }, expectedTotalPaise: 1 }))))).toMatchObject({ status: 409 })
    expect(h.orders).toHaveLength(0)
    const p = await json(await purchase(req('POST', { eventId: DRAFT, capacity: 437, services: { whatsapp: 500, certificates: 100 }, expectedTotalPaise: total })))
    expect(p.status).toBe(200)
    expect(h.orders).toHaveLength(1); expect(h.orders[0].amount).toBe(total)
    expect(await ledger()).toBeUndefined()                              // nothing before payment

    const { first, replay } = await payLatest(DRAFT)
    expect(first.status).toBe(200); expect(replay.status).toBe(200)   // replay is idempotent
    const granted = (await ledger())!
    expect(granted).toMatchObject({ whatsapp: { purchased: 500 }, certificates: { purchased: 100 } })
    expect(granted.whatsapp.consumed ?? 0).toBe(0); expect(granted.certificates.consumed ?? 0).toBe(0)   // absent until used

    // Consume every WhatsApp unit (idempotent per unit key), then the next is refused.
    const { reserveServiceUnits } = await import('@/lib/licensing/serviceAllowanceLedger')
    // Sequential: this test is about the purchase → grant → exhaust → buy-more FLOW. Concurrency
    // safety is proved in serviceAllowances.emu.test.ts; here even 20 simultaneous transactions on
    // ONE ledger doc hit emulator "Transaction lock timeout" (the documented per-event contention
    // limit — reported, to be load-tested on real Firestore).
    for (let i = 0; i < 500; i++) await reserveServiceUnits({ draftId: DRAFT, service: 'whatsapp', unitKey: `u${i}`, source: 'test' })
    // Idempotent per unit key: a replay takes nothing.
    expect(await reserveServiceUnits({ draftId: DRAFT, service: 'whatsapp', unitKey: 'u0', source: 'test' })).toEqual({ mode: 'allowance', already: true })
    expect(await reserveServiceUnits({ draftId: DRAFT, service: 'whatsapp', unitKey: 'u500', source: 'test' })).toEqual({ mode: 'exhausted', policy: 'block' })
    expect((await ledger())!.whatsapp).toMatchObject({ purchased: 500, consumed: 500 })

    // Buy MORE (draft: the total selection rises to 1,500) → an add-on for the DIFFERENCE only.
    const more = await quote(437, { whatsapp: 1_500, certificates: 100 })
    const payable = more.body.payable as { kind: string; totalPaise: number }
    expect(payable.kind).toBe('addon'); expect(payable.totalPaise).toBe(1_000 * 45 + Math.round(1_000 * 45 * 0.18))
    expect((await json(await purchase(req('POST', { eventId: DRAFT, capacity: 437, services: { whatsapp: 1_500, certificates: 100 }, expectedTotalPaise: payable.totalPaise })))).status).toBe(200)
    const addonOrderId = (await adminDb.collection('licenseOrders').where('eventId', '==', DRAFT).where('purpose', '==', 'addon').get()).docs[0].id
    expect((await payLatest(DRAFT, addonOrderId)).first.status).toBe(200)
    expect((await ledger())!.whatsapp).toMatchObject({ purchased: 1_500, consumed: 500 })   // history kept, +1,000

    // History (activation-status): both paid orders, newest first, from the orders' own snapshots.
    const { GET } = await import('@/app/api/licensing/activation-status/route')
    const st = await json(await GET(req('GET', undefined, 'org', `http://x/api/licensing/activation-status?eventId=${DRAFT}`)))
    const purchases = st.body.purchases as Array<{ kind: string; totalPaise: number; services: Array<{ service: string; quantity: number }> }>
    expect(purchases.map(x => x.kind).sort()).toEqual(['activation', 'addon'])
    expect(purchases.find(x => x.kind === 'addon')!.services).toEqual([{ service: 'whatsapp', quantity: 1_000 }])

    expect(h.refunds).toBe(0)                                           // no refund path anywhere
  }, T)

  it('tier grant / upgrade / downgrade are retired for EVERY licence (410); legacy tier rows read as legacy', async () => {
    const SLUG = `c05-legacy-${PID}`
    await adminDb.doc(`eventLicenses/${SLUG}`).set({ eventId: SLUG, organizerUid: ORG, tier: 'professional', status: 'active', version: 2, orderId: null, createdAt: new Date() })
    const { applyLicenseAction, getLicenseDetail } = await import('@/lib/admin/licenseAdminService')
    for (const action of ['grant', 'upgrade', 'downgrade']) {
      await expect(applyLicenseAction(SLUG, { action, reason: 't', tier: 'business' } as never, uid.admin)).rejects.toMatchObject({ status: 410 })
    }
    const d = await getLicenseDetail(SLUG)
    expect(d?.row.tierName).toMatch(/\(legacy tier\)$/)
    expect((await adminDb.doc(`eventLicenses/${SLUG}`).get()).get('tier')).toBe('professional')   // untouched
    await adminDb.doc(`eventLicenses/${SLUG}`).delete()
    for (const x of (await adminDb.collection('licenseHistory').where('eventId', '==', SLUG).get()).docs) await x.ref.delete()
  }, T)
})
