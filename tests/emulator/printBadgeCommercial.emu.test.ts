// RD-PRINT-BILL-P2 — Super Admin badge controls on REAL Firestore + REAL Auth-emulator tokens,
// through the real routes and the real prepaid activation. Nothing is mocked.
//
//   A. /api/admin/events/[slug]/print-badges — authorization, reason, validation, audit rows,
//      no-op, clear, unreadable override, concurrency
//   B. /api/admin/business-config (licensing) — badge settings: reason, locks, invalid change,
//      audit; an invalid stored print_badges never blocks or reverts other licensing settings
//   C. the release gate at ACTIVATION: a paid add-on order with a badge line is never activated
//   D. public exposure: the public events API never returns the override

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

// The prepaid activation module imports the Razorpay client (env-checked at load). No gateway
// call is made in this suite — any attempt throws.
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_pb2', RAZORPAY_KEY_SECRET: 'pb2',
  razorpay: {
    orders:   { create: async () => { throw new Error('no orders in this suite') }, fetchPayments: async () => ({ items: [] }) },
    payments: { fetch: async () => { throw new Error('no payment') }, refund: async () => { throw new Error('no refunds') } },
  },
}))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `pb2-${process.pid}`
const EV = `${P}-ev`
const DRAFT = `${P}-draft`
const PASSWORD = 'PrintBadgeP2Passw0rd!'
const EMAIL = { superAdmin: `${P}-super@registerdesk.test`, admin: `${P}-admin@registerdesk.test`, organizer: `${P}-org@registerdesk.test` }
type Who = keyof typeof EMAIL
type Rec = Record<string, unknown>

describeEmu('RD-PRINT-BILL-P2 · Super Admin badge controls (real Auth, Firestore, routes)', () => {
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let businessConfig: typeof import('@/lib/config/businessConfigService').businessConfig
  let badgeRoute: Record<'GET' | 'POST', (r: NextRequest, c: unknown) => Promise<Response>>
  let cfgRoute: Record<'GET' | 'POST', (r: NextRequest) => Promise<Response>>
  const uid: Record<Who, string> = { superAdmin: '', admin: '', organizer: '' }
  const token: Record<Who, string> = { superAdmin: '', admin: '', organizer: '' }
  const savedAdminUids = process.env.ADMIN_UIDS
  let cfgBackup: Rec | null = null

  const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST!
  async function signIn(email: string): Promise<string> {
    const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    })
    const j = await r.json() as { idToken?: string }
    if (!j.idToken) throw new Error(`sign-in failed for ${email}`)
    return j.idToken
  }
  const req = (method: 'GET' | 'POST', who: Who | null, body?: unknown) => new NextRequest('http://x/api/t', {
    method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${token[who]}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const ctx = (slug = EV) => ({ params: Promise.resolve({ slug }) })
  const badge = async (method: 'GET' | 'POST', who: Who | null, body?: unknown, slug = EV) => {
    const res = await badgeRoute[method](req(method, who, body), ctx(slug))
    return { status: res.status, body: await res.json() as Rec }
  }
  const evDoc = async () => (await adminDb.doc(`events/${EV}`).get()).data() as Rec
  const auditRows = async () => (await adminDb.collection('adminAuditLogs').where('entityId', '==', EV).get()).docs.map(d => ({ id: d.id, ...d.data() }) as Rec)
  const historyRows = async () => (await adminDb.collection('licenseHistory').where('eventId', '==', EV).get()).docs.map(d => d.data() as Rec)
  const cfgDoc = () => adminDb.doc('system/businessConfiguration')
  const cfgVersion = async () => (((await cfgDoc().get()).data() as Rec | undefined)?._meta as Rec | undefined)?.version ?? 0
  const saveLicensing = async (patch: Rec, reason: unknown, who: Who = 'superAdmin') => {
    const res = await cfgRoute.POST(req('POST', who, { section: 'licensing', patch, reason }))
    return { status: res.status, body: await res.json() as Rec }
  }
  const getLicensing = async () => {
    businessConfig.invalidateCache()
    return businessConfig.getSection('licensing')
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const admin = await import('@/lib/firebase/admin')
    adminDb = admin.adminDb; adminAuth = admin.adminAuth
    businessConfig = (await import('@/lib/config/businessConfigService')).businessConfig
    for (const k of Object.keys(EMAIL) as Who[]) {
      const existing = await adminAuth.getUserByEmail(EMAIL[k]).catch(() => null)
      const u = existing ?? await adminAuth.createUser({ email: EMAIL[k], password: PASSWORD, emailVerified: true })
      uid[k] = u.uid
      // Both admins hold the legacy `admin: true` claim; ONLY the Super Admin is in ADMIN_UIDS.
      await adminAuth.setCustomUserClaims(u.uid, k === 'organizer' ? null : { admin: true })
    }
    process.env.ADMIN_UIDS = uid.superAdmin
    for (const k of Object.keys(EMAIL) as Who[]) token[k] = await signIn(EMAIL[k])
    await adminDb.doc(`users/${uid.organizer}`).set({ uid: uid.organizer, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    await adminDb.doc(`events/${EV}`).set({
      uid: uid.organizer, draftId: DRAFT, slug: EV, lifecycleStatus: 'published', visibility: 'public',
      eventDetails: { info: { name: 'Badge Test Event' }, seo: { urlSlug: EV } }, publishedAt: new Date(), updatedAt: new Date(),
      // the existing capacity override — must be untouched by badge controls
      commercial: { activationRatePaise: 175 },
    })
    const snap = await cfgDoc().get()
    cfgBackup = snap.exists ? snap.data() as Rec : null
    badgeRoute = await import('@/app/api/admin/events/[slug]/print-badges/route') as never
    cfgRoute = await import('@/app/api/admin/business-config/route') as never
  }, T)

  afterAll(async () => {
    if (savedAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedAdminUids
    if (cfgBackup) await cfgDoc().set(cfgBackup); else await cfgDoc().delete().catch(() => null)
    for (const d of (await adminDb.collection('adminAuditLogs').where('entityId', '==', EV).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('licenseHistory').where('eventId', '==', EV).get()).docs) await d.ref.delete()
    await adminDb.doc(`events/${EV}`).delete().catch(() => null)
    await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${DRAFT}`)).catch(() => null)
    await adminDb.doc(`licenseOrders/add_${DRAFT}_pb2`).delete().catch(() => null)
    await adminDb.doc(`users/${uid.organizer}`).delete().catch(() => null)
    for (const k of Object.keys(EMAIL) as Who[]) await adminAuth.deleteUser(uid[k]).catch(() => null)
    businessConfig?.invalidateCache()
  }, T)

  // ── A. event overrides ────────────────────────────────────────────────────────────────────────
  it('A1 · only a Super Admin (ADMIN_UIDS): organizer and legacy admin:true are refused, on GET and POST', async () => {
    for (const m of ['GET', 'POST'] as const) {
      const body = m === 'POST' ? { override: { complimentary: true }, reason: 'probe' } : undefined
      expect((await badge(m, null, body)).status).toBe(403)
      expect((await badge(m, 'organizer', body)).status).toBe(403)
      const legacy = await badge(m, 'admin', body)
      expect([legacy.status, legacy.body.code]).toEqual([403, 'SUPER_ADMIN_REQUIRED'])
    }
    expect((await evDoc()).printBadgeCommercial).toBeUndefined()
    expect(await auditRows()).toEqual([])
    const ok = await badge('GET', 'superAdmin')
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ eventOverride: null, released: { purchase: false, paidGeneration: false }, effective: { mode: 'free', reason: 'global_disabled' } })
    expect((await badge('GET', 'superAdmin', undefined, `${P}-missing`)).status).toBe(404)
  }, T)

  it('A2 · reason is 3–500 characters; invalid values refused — and NOTHING is written', async () => {
    for (const [reason, code] of [[undefined, 'REASON_REQUIRED'], ['  ', 'REASON_REQUIRED'], ['ab', 'REASON_TOO_SHORT'], ['x'.repeat(501), 'REASON_TOO_LONG']] as const) {
      const r = await badge('POST', 'superAdmin', { override: { unitPricePaise: 30 }, reason })
      expect([r.status, r.body.code], String(reason)).toEqual([400, code])
    }
    for (const override of [{ unitPricePaise: 0 }, { unitPricePaise: 1001 }, { unitPricePaise: 2.5 }, { unitPricePaise: '30' }, { enabled: 'no' }, { surprise: true }, {}]) {
      expect((await badge('POST', 'superAdmin', { override, reason: 'valid reason' })).status, JSON.stringify(override)).toBe(422)
    }
    expect((await evDoc()).printBadgeCommercial).toBeUndefined()
    expect(await auditRows()).toEqual([])
    expect(await historyRows()).toEqual([])
  }, T)

  it('A3 · set: one transaction writes the field + ONE licenseHistory + ONE adminAuditLogs row; a replay is a no-op', async () => {
    const r = await badge('POST', 'superAdmin', { override: { unitPricePaise: 35, couponsAllowed: false }, reason: 'Negotiated event rate' })
    expect(r.status).toBe(200)
    expect(r.body.eventOverride).toEqual({ unitPricePaise: 35, couponsAllowed: false })
    expect(r.body.changedFields).toEqual(['unitPricePaise', 'couponsAllowed'])
    expect((await evDoc()).printBadgeCommercial).toEqual({ unitPricePaise: 35, couponsAllowed: false })
    expect((await evDoc()).commercial).toEqual({ activationRatePaise: 175 })               // capacity override untouched
    const [audit] = await auditRows()
    expect(audit).toMatchObject({ adminUid: uid.superAdmin, action: 'print_badge_commercial.set', entityType: 'event',
      metadata: { reason: 'Negotiated event rate', before: null, after: { unitPricePaise: 35, couponsAllowed: false }, freeOrComplimentary: false } })
    const [hist] = await historyRows()
    expect(hist).toMatchObject({ action: 'print_badge_override', actorUid: uid.superAdmin, reason: 'Negotiated event rate', source: 'admin' })
    expect(audit.id).toBe(`print_badge_${hist.id}`)
    // Effective while unreleased: still FREE; the event price is reported with its source.
    const g = await badge('GET', 'superAdmin')
    expect(g.body.effective).toMatchObject({ mode: 'free', unitPricePaise: 35, couponsAllowed: false, sources: { unitPricePaise: 'event', couponsAllowed: 'event' } })
    // The SAME change again: nothing written.
    const again = await badge('POST', 'superAdmin', { override: { unitPricePaise: 35, couponsAllowed: false }, reason: 'Negotiated event rate' })
    expect(again.body.unchanged).toBe(true)
    expect(await auditRows()).toHaveLength(1)
    expect(await historyRows()).toHaveLength(1)
  }, T)

  it('A4 · complimentary / free settings are audited as such; null removes a field; clear removes the override', async () => {
    const comp = await badge('POST', 'superAdmin', { override: { complimentary: true }, reason: 'Charity partner event' })
    expect(comp.status).toBe(200)
    const compAudit = (await auditRows()).find(a => (a.metadata as Rec).after && ((a.metadata as Rec).after as Rec).complimentary === true)!
    expect(compAudit.metadata).toMatchObject({ freeOrComplimentary: true, reason: 'Charity partner event' })
    const rm = await badge('POST', 'superAdmin', { override: { unitPricePaise: null }, reason: 'Use the global price' })
    expect(rm.body.eventOverride).toEqual({ couponsAllowed: false, complimentary: true })
    const off = await badge('POST', 'superAdmin', { override: { enabled: false }, reason: 'Billing off for this event' })
    expect((off.body.eventOverride as Rec).enabled).toBe(false)
    const cleared = await badge('POST', 'superAdmin', { clear: true, reason: 'Back to platform settings' })
    expect(cleared.body).toMatchObject({ ok: true, cleared: true, eventOverride: null })
    expect((await evDoc()).printBadgeCommercial).toBeUndefined()
    expect((await auditRows()).some(a => a.action === 'print_badge_commercial.cleared')).toBe(true)
    const clearedAgain = await badge('POST', 'superAdmin', { clear: true, reason: 'Back to platform settings' })
    expect(clearedAgain.body.unchanged).toBe(true)
    expect(await auditRows()).toHaveLength(5)                 // set, complimentary, remove price, off, cleared
    expect(await historyRows()).toHaveLength(5)
  }, T)

  it('A5 · an UNREADABLE override: reported read-only, never replaced by an unconfirmed save; confirmed replace and confirmed clear are audited with the raw value', async () => {
    const RAW = { unitPricePaise: 0, evil: '<script>alert(1)</script>' }
    await adminDb.doc(`events/${EV}`).update({ printBadgeCommercial: RAW })
    const g = await badge('GET', 'superAdmin')
    // Reported, with a bounded TEXT preview of this field only (not the raw object, not the event).
    expect(g.body.overrideStatus).toMatchObject({ ok: false, rawTruncated: false })
    expect(typeof (g.body.overrideStatus as Rec).rawPreview).toBe('string')
    expect(JSON.parse((g.body.overrideStatus as Rec).rawPreview as string)).toEqual(RAW)
    expect((g.body.overrideStatus as Rec).raw).toBeUndefined()
    expect((g.body.overrideStatus as Rec).rawPreview).not.toContain('activationRatePaise')      // nothing else from the event
    expect(g.body.effective).toMatchObject({ mode: 'free', chargeable: false })
    const before = (await auditRows()).length
    // 1. An ordinary save WITHOUT confirmation is refused — nothing written, nothing audited.
    const refused = await badge('POST', 'superAdmin', { override: { couponsAllowed: true }, reason: 'Accidental save' })
    expect([refused.status, refused.body.code]).toEqual([409, 'OVERRIDE_UNREADABLE'])
    expect((await evDoc()).printBadgeCommercial).toEqual(RAW)
    expect((await auditRows()).length).toBe(before)
    // 2. A CONFIRMED replacement — the raw prior value is audited.
    const r = await badge('POST', 'superAdmin', { override: { couponsAllowed: true }, replaceUnreadable: true, reason: 'Replace corrupt override' })
    expect(r.status).toBe(200)
    expect((await evDoc()).printBadgeCommercial).toEqual({ couponsAllowed: true })
    const replaced = (await auditRows()).find(a => ((a.metadata as Rec).reason) === 'Replace corrupt override')!
    expect((replaced.metadata as Rec).before).toEqual({ unreadable: RAW })
    // 3. "Clear corrupt override" (clear: true) — the field is removed, the raw value audited as before.
    await adminDb.doc(`events/${EV}`).update({ printBadgeCommercial: RAW })
    const cleared = await badge('POST', 'superAdmin', { clear: true, reason: 'Clear corrupt override' })
    expect(cleared.status).toBe(200)
    expect((await evDoc()).printBadgeCommercial).toBeUndefined()
    const clearAudit = (await auditRows()).find(a => ((a.metadata as Rec).reason) === 'Clear corrupt override')!
    expect(clearAudit).toMatchObject({ action: 'print_badge_commercial.cleared', metadata: { before: { unreadable: RAW }, after: null } })
    expect((await historyRows()).find(h => h.reason === 'Clear corrupt override')).toMatchObject({ before: { unreadable: RAW }, after: null })
    // 4. Ordinary edits of a VALID override need no confirmation (unchanged behaviour).
    const ok = await badge('POST', 'superAdmin', { override: { couponsAllowed: true }, reason: 'Valid edit after recovery' })
    expect(ok.status).toBe(200)
    expect((await evDoc()).printBadgeCommercial).toEqual({ couponsAllowed: true })
  }, T)

  it('A6 · concurrent changes to DIFFERENT fields are both kept (transaction re-reads), each audited once', async () => {
    const before = (await auditRows()).length
    const [a, b] = await Promise.all([
      badge('POST', 'superAdmin', { override: { unitPricePaise: 40 }, reason: 'Concurrent A' }),
      badge('POST', 'superAdmin', { override: { complimentary: false }, reason: 'Concurrent B' }),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await evDoc()).printBadgeCommercial).toEqual({ couponsAllowed: true, unitPricePaise: 40, complimentary: false })
    expect((await auditRows()).length).toBe(before + 2)
  }, T)

  // ── B. global badge settings through Business Configuration ───────────────────────────────────
  it('B1 · an INVALID stored print_badges neither reverts nor blocks other licensing settings', async () => {
    const lic = await getLicensing()
    const sa = lic.serviceAllowances as Rec
    // Store an invalid print_badges directly (as a console write would) beside a custom WhatsApp price.
    await cfgDoc().set({ licensing: { serviceAllowances: { ...sa, whatsapp: { ...(sa.whatsapp as Rec), unitPricePaise: 23 }, print_badges: { unitPricePaise: -5, gstRatePercent: 150 } } } }, { merge: true })
    const read1 = await getLicensing()
    expect(((read1.serviceAllowances as Rec).whatsapp as Rec).unitPricePaise).toBe(23)          // not reverted to defaults
    // An unrelated licensing change (WhatsApp price) saves normally — no badge reason needed.
    const v0 = await cfgVersion()
    const save = await saveLicensing({ serviceAllowances: { ...(read1.serviceAllowances as Rec), whatsapp: { ...((read1.serviceAllowances as Rec).whatsapp as Rec), unitPricePaise: 24 } } }, 'x')
    expect(save.status, JSON.stringify(save.body)).toBe(200)
    expect(await cfgVersion()).toBe(Number(v0) + 1)
    expect(((await getLicensing()).serviceAllowances as Rec).whatsapp).toMatchObject({ unitPricePaise: 24 })
    expect((await adminDb.doc(`adminAuditLogs/badge_settings_v${Number(v0) + 1}`).get()).exists).toBe(false)   // not a badge change
  }, T)

  it('B2 · a badge change needs a 3–500 reason, may not be invalid, and keeps for-sale + paid generation LOCKED — nothing written on refusal', async () => {
    const lic = await getLicensing()
    const sa = lic.serviceAllowances as Rec
    const v0 = await cfgVersion()
    const pb = (patch: Rec) => ({ serviceAllowances: { ...sa, print_badges: { ...(sa.print_badges as Rec), unitPricePaise: 20, gstRatePercent: null, minQuantity: 100, maxQuantity: null, presets: [], onExhausted: 'block', enabled: false, ...patch } } })
    expect((await saveLicensing(pb({ gstRatePercent: 18 }), 'ab'))).toMatchObject({ status: 400, body: { code: 'REASON_TOO_SHORT' } })
    expect((await saveLicensing(pb({ unitPricePaise: -1 }), 'Valid reason'))).toMatchObject({ status: 400, body: { code: 'BADGE_SETTINGS_INVALID' } })
    const worded = await saveLicensing(pb({ gstRatePercent: 150 }), 'Valid reason')
    expect(worded.body.error).toBe('Not published — ID badges: GST rate must be between 0% and 100%, or left blank until the accountant confirms it.')
    expect(String(worded.body.error)).not.toContain('licensing.serviceAllowances')
    expect((await saveLicensing(pb({ gstRatePercent: 18, enabled: true }), 'Valid reason'))).toMatchObject({ status: 409, body: { code: 'BADGE_SETTINGS_LOCKED' } })
    expect((await saveLicensing({ ...pb({}), printBadgeBilling: { paidGenerationEnabled: true } }, 'Valid reason'))).toMatchObject({ status: 409, body: { code: 'BADGE_SETTINGS_LOCKED' } })
    expect(await cfgVersion()).toBe(v0)                                             // every refusal wrote nothing
    // The legacy admin cannot touch licensing at all (existing rule, unchanged).
    expect((await saveLicensing(pb({ gstRatePercent: 18 }), 'Valid reason', 'admin')).status).toBe(403)
  }, T)

  it('B3 · a VALID badge change (also repairing the stored value) commits with configuration audit + ONE admin audit row', async () => {
    const lic = await getLicensing()
    const sa = lic.serviceAllowances as Rec
    const v0 = Number(await cfgVersion())
    const res = await saveLicensing({ serviceAllowances: { ...sa, print_badges: { enabled: false, unitPricePaise: 20, gstRatePercent: 18, minQuantity: 100, maxQuantity: null, presets: [], onExhausted: 'block' } } }, 'Accountant-approved GST rate')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const v1 = v0 + 1
    expect(await cfgVersion()).toBe(v1)
    const audit = (await adminDb.doc(`adminAuditLogs/badge_settings_v${v1}`).get()).data() as Rec
    expect(audit).toMatchObject({ adminUid: uid.superAdmin, action: 'print_badge_settings.updated', entityType: 'platform_settings',
      metadata: { reason: 'Accountant-approved GST rate', configVersion: v1 } })
    expect((((audit.metadata as Rec).after as Rec).printBadges as Rec).gstRatePercent).toBe(18)
    expect((await adminDb.doc(`configurationAudit/v${v1}`).get()).exists).toBe(true)
    // Still NOT released: the catalog reports not_released; the route keeps paid generation off.
    const { getServiceCatalog } = await import('@/lib/licensing/serviceAllowanceConfig')
    businessConfig.invalidateCache()
    expect((await getServiceCatalog()).state.print_badges).toBe('not_released')
    // Clean up our own audit rows.
    await adminDb.doc(`adminAuditLogs/badge_settings_v${v1}`).delete()
  }, T)

  // ── C. release gate at activation ─────────────────────────────────────────────────────────────
  it('C · a paid add-on order carrying a (perfectly consistent) badge line is NEVER activated; no units applied', async () => {
    const { priceServiceItem } = await import('@/lib/licensing/serviceAllowances')
    const { activateAddonOrder } = await import('@/lib/licensing/draftCommerce')
    const line = priceServiceItem('print_badges', 100, { enabled: true, unitPricePaise: 20, gstRatePercent: 18, minQuantity: 100, maxQuantity: null, presets: [], onExhausted: 'block' })
    const orderId = `add_${DRAFT}_pb2`
    await adminDb.doc(`licenseOrders/${orderId}`).set({
      orderId, eventId: DRAFT, organizerUid: uid.organizer, purpose: 'addon', status: 'created', tier: 'free',
      commercialModel: 'capacity', serviceItems: [line], amountPaise: line.totalPaise, razorpayAmountPaise: line.totalPaise,
      razorpayOrderId: 'order_pb2', createdAt: new Date(), updatedAt: new Date(),
    })
    await expect(activateAddonOrder({ orderId, razorpayOrderId: 'order_pb2', razorpayPaymentId: 'pay_pb2' })).rejects.toThrow('SERVICE_NOT_RELEASED')
    expect(((await adminDb.doc(`licenseOrders/${orderId}`).get()).data() as Rec).status).toBe('created')   // not activated
    expect((await adminDb.doc(`eventServiceAllowances/${DRAFT}`).get()).exists).toBe(false)              // no units applied
  }, T)

  // ── D. public exposure ────────────────────────────────────────────────────────────────────────
  it('D · the public events API never returns the badge override (or the capacity override)', async () => {
    await adminDb.doc(`events/${EV}`).update({ printBadgeCommercial: { complimentary: true, unitPricePaise: 777 } })
    const pub = await import('@/app/api/public/events/route') as unknown as Record<'GET', (r: NextRequest) => Promise<Response>>
    const res = await pub.GET(new NextRequest('http://x/api/public/events?limit=50'))
    const text = await res.text()
    expect(text).not.toContain('printBadgeCommercial')
    expect(text).not.toContain('777')
    expect(text).not.toMatch(/"commercial"\s*:/)
  }, T)
})
