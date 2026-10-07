// RD-EVENT-COMMERCE-04B — financial permissions & refund safety.
//
// REAL Firestore + REAL Auth-emulator tokens: the Super-Admin / admin distinction runs through
// the real resolveAdminUid / resolveSuperAdminUid. Razorpay is an in-memory stub that COUNTS
// refund calls — no request leaves the process, and the refund tests assert the count is 0.
//
//   PERM  communication / certificate / media / licence pricing: Super Admin only (field-level),
//         non-price settings keep admin access, a stale cache cannot hide a price revert,
//         unauthenticated / organizer / forged-role requests change nothing
//   REF   licence remainders become manual-refund HOLDS (no gateway call, one hold under races)
//   AUD   licence price override + its audit rows commit together; platform settings too

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// RD-SEC-01 · two roles only. A legacy-claim caller is no longer a "plain admin": routes refuse it
// at the admin door like any non-admin (bare 403/401) or, behind requireSuperAdmin, with
// SUPER_ADMIN_REQUIRED. Either way it must be an AUTHORIZATION refusal — never a validation code
// (REASON_REQUIRED etc.), which would mean it got past the door.
const PLAIN_REFUSED: ReadonlyArray<string | undefined> = ['SUPER_ADMIN_REQUIRED', undefined]


const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const PID = process.pid
const SLUG = `ec04b-live-${PID}`
const CFG_DOC = 'system/businessConfiguration'
const PS_DOC  = 'platformSettings/default'
const PASSWORD = 'Ec04bPassw0rd!'
const EMAIL = { superAdmin: `ec04b-super-${PID}@registerdesk.test`, admin: `ec04b-admin-${PID}@registerdesk.test`, organizer: `ec04b-org-${PID}@registerdesk.test` }

const gw = vi.hoisted(() => ({ refundCalls: 0 }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_ec04b', RAZORPAY_KEY_SECRET: 'ec04b',
  razorpay: {
    orders:   { create: async () => { throw new Error('no orders in this suite') }, fetchPayments: async () => ({ items: [] }) },
    payments: {
      fetch:  async () => { throw new Error('no payment') },
      refund: async () => { gw.refundCalls++; return { id: `rfnd_ec04b_${gw.refundCalls}` } },
      // RD-PHASE4-S1 · C4 — the retry route checks the gateway for an existing refund first (fail closed).
      fetchMultipleRefund: async () => ({ entity: 'collection', count: 0, items: [] }),
    },
  },
}))

describeEmu('RD-EVENT-COMMERCE-04B · financial permissions & refund safety', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let cfgBackup: Record<string, unknown> | null = null
  let psBackup:  Record<string, unknown> | null = null
  const uid: Record<keyof typeof EMAIL, string> = { superAdmin: '', admin: '', organizer: '' }
  const token: Record<keyof typeof EMAIL, string> = { superAdmin: '', admin: '', organizer: '' }
  const savedAdminUids = process.env.ADMIN_UIDS

  const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
  async function signIn(email: string): Promise<string> {
    const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    })
    const j = await r.json() as { idToken?: string }
    if (!j.idToken) throw new Error(`sign-in failed for ${email}`)
    return j.idToken
  }
  const req = (method: 'GET' | 'POST' | 'PATCH', who: keyof typeof EMAIL | null, body?: unknown, extra: Record<string, string> = {}) =>
    new NextRequest('http://x/api/t', {
      method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${token[who]}` } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
  const cfg = async () => (await import('@/lib/config/businessConfigService')).businessConfig
  const stored = async (path: string) => (await adminDb.doc(CFG_DOC).get()).get(path)

  async function restore() {
    if (cfgBackup) await adminDb.doc(CFG_DOC).set(cfgBackup); else await adminDb.doc(CFG_DOC).delete().catch(() => null)
    if (psBackup)  await adminDb.doc(PS_DOC).set(psBackup);   else await adminDb.doc(PS_DOC).delete().catch(() => null)
    ;(await cfg()).invalidateCache()
  }
  async function wipe() {
    for (const d of (await adminDb.collection('licenseHistory').where('eventId', '==', SLUG).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('adminAuditLogs').where('entityId', '==', SLUG).get()).docs) await d.ref.delete()
    for (const p of [`events/${SLUG}`, `eventLicenses/${SLUG}`, `licenseOrders/lic_${SLUG}`, `licenseOrders/cap_${SLUG}_1`,
                     `failedRefunds/license_hold_lic_${SLUG}`, `failedRefunds/license_hold_cap_${SLUG}_1`]) await adminDb.doc(p).delete().catch(() => null)
    gw.refundCalls = 0
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    const c = await adminDb.doc(CFG_DOC).get(); cfgBackup = c.exists ? c.data() as Record<string, unknown> : null
    const p = await adminDb.doc(PS_DOC).get();  psBackup  = p.exists ? p.data() as Record<string, unknown> : null
    for (const k of Object.keys(EMAIL) as Array<keyof typeof EMAIL>) {
      const u = (await adminAuth.getUserByEmail(EMAIL[k]).catch(() => null)) ?? await adminAuth.createUser({ email: EMAIL[k], password: PASSWORD, emailVerified: true })
      uid[k] = u.uid
      await adminAuth.setCustomUserClaims(u.uid, k === 'organizer' ? null : { admin: true })
    }
    process.env.ADMIN_UIDS = uid.superAdmin
    for (const k of Object.keys(EMAIL) as Array<keyof typeof EMAIL>) token[k] = await signIn(EMAIL[k])
  }, T)
  afterAll(async () => {
    await wipe(); await restore()
    for (const c of [`${CFG_DOC}/history`, 'configurationAudit']) {
      for (const u of Object.values(uid)) for (const d of (await adminDb.collection(c).where('updatedBy', '==', u).get()).docs) await d.ref.delete()
    }
    for (const d of (await adminDb.collection('adminAuditLogs').where('entityType', '==', 'platform_settings').get()).docs) {
      if (Object.values(uid).includes(d.get('adminUid'))) await d.ref.delete()
    }
    for (const k of Object.keys(EMAIL) as Array<keyof typeof EMAIL>) await adminAuth.deleteUser(uid[k]).catch(() => null)
    if (savedAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedAdminUids
  }, T)
  beforeEach(async () => { await wipe(); await restore() }, T)
  afterEach(() => { vi.restoreAllMocks() })

  const publish = async (who: keyof typeof EMAIL | null, section: string, patch: unknown, extra?: Record<string, string>, bodyExtra: Record<string, unknown> = {}) => {
    const { POST } = await import('@/app/api/admin/business-config/route')
    return json(await POST(req('POST', who, { section, patch, reason: '04B test', ...bodyExtra }, extra)))
  }

  // ═══ PERM ══════════════════════════════════════════════════════════════════════
  it('PERM · communication RATES (incl. certificate pricing): Super Admin only; nothing written on refusal', async () => {
    const cur = (await (await cfg()).getSection('communication'))
    const wa  = cur.whatsapp.pricePaise
    for (const [who, extra, bodyExtra] of [
      ['admin', {}, {}],
      ['organizer', {}, {}],
      [null, {}, {}],
      ['admin', { 'x-admin-role': 'super_admin' }, { role: 'super_admin', isSuperAdmin: true, canEditPricing: true }],
    ] as const) {
      const r = await publish(who, 'communication', { whatsapp: { pricePaise: wa + 7 } }, extra, bodyExtra)
      expect(r.status, String(who)).toBe(403)
    }
    const cert = await publish('admin', 'communication', { certificates: { pricePaise: cur.certificates.pricePaise + 1 } })
    expect(cert.status).toBe(403)   // RD-SEC-01 · refused at the admin door (no per-field list)
    expect(await stored('communication.whatsapp.pricePaise')).not.toBe(wa + 7)

    expect((await publish('superAdmin', 'communication', { whatsapp: { pricePaise: wa + 7 } })).status).toBe(200)
    expect(await stored('communication.whatsapp.pricePaise')).toBe(wa + 7)
  }, T)

  // RD-SEC-01 · was "non-price communication settings keep ordinary-admin access": there is no
  // ordinary (claim-only) admin any more — it is refused; the Super Admin's non-price save still works.
  it('PERM · non-price communication settings: claim-only admin refused, Super Admin allowed', async () => {
    const cur = (await (await cfg()).getSection('communication'))
    const r = await publish('admin', 'communication', { whatsapp: { dailyLimit: cur.whatsapp.dailyLimit + 5 } })
    expect(r.status).toBe(403)
    expect(await stored('communication.whatsapp.dailyLimit')).not.toBe(cur.whatsapp.dailyLimit + 5)
    // Re-sending the SAME price alongside is not a price change.
    const again = await publish('superAdmin', 'communication', { whatsapp: { pricePaise: cur.whatsapp.pricePaise, hourlyLimit: cur.whatsapp.hourlyLimit + 1 } })
    expect(again.status).toBe(200)
  }, T)

  it('PERM · a STALE cache cannot turn a price revert into "no change" (checked on the fresh doc)', async () => {
    const svc = await cfg()
    const cur = await svc.getSection('communication')           // this instance caches price P
    // Another instance's Super Admin raises it — written straight to Firestore, cache untouched.
    await adminDb.doc(CFG_DOC).set({ communication: { whatsapp: { pricePaise: cur.whatsapp.pricePaise + 11 } } }, { merge: true })
    // An ordinary admin re-sends the OLD value this instance still believes is current.
    const r = await publish('admin', 'communication', { whatsapp: { pricePaise: cur.whatsapp.pricePaise, dailyLimit: 1 } })
    expect(r.status).toBe(403)
    expect(await stored('communication.whatsapp.pricePaise')).toBe(cur.whatsapp.pricePaise + 11)
  }, T)

  it('PERM · RD-EVENT-COMMERCE-05A · a NULL price cannot sneak past the gate (it would revert the rate to its default)', async () => {
    const cur = (await (await cfg()).getSection('communication'))
    expect((await publish('superAdmin', 'communication', { whatsapp: { pricePaise: cur.whatsapp.pricePaise + 13 } })).status).toBe(200)
    const r = await publish('admin', 'communication', { whatsapp: { pricePaise: null } })
    expect(r.status).toBe(403)   // RD-SEC-01 · refused at the admin door (no per-field list)
    expect(await stored('communication.whatsapp.pricePaise')).toBe(cur.whatsapp.pricePaise + 13)
  }, T)

  it('PERM · media / extra-photo pricing: Super Admin only', async () => {
    const cur = await (await cfg()).getSection('mediaStudio')
    const a = await publish('admin', 'mediaStudio', { creditUnitPricePaise: cur.creditUnitPricePaise + 50 })
    expect(a.status).toBe(403)   // RD-SEC-01 · refused at the admin door (no per-field list)
    expect((await publish('superAdmin', 'mediaStudio', { creditUnitPricePaise: cur.creditUnitPricePaise + 50 })).status).toBe(200)
  }, T)

  it('PERM · GET reports canEditPricing from the verified token only', async () => {
    const { GET } = await import('@/app/api/admin/business-config/route')
    // RD-SEC-01 · a claim-only caller (forged role header or not) reads nothing at all.
    expect((await GET(req('GET', 'admin'))).status).toBe(403)
    expect((await GET(req('GET', 'admin', undefined, { 'x-admin-role': 'super_admin' }))).status).toBe(403)
    expect((await json(await GET(req('GET', 'superAdmin')))).body.permissions).toEqual({ canEditPricing: true })
  }, T)

  // RD-PHASE4-S2 — every platform-settings key (tier prices AND the pricing-engine switch) is now
  // Super Admin only, needs a reason, and is audited in the same TRANSACTION.
  it('PERM · platform licence TIER prices and the engine toggle: Super Admin only (with a reason), audited in the same transaction', async () => {
    const { PATCH } = await import('@/app/api/admin/platform-settings/route')
    const tierPatch = { licensing: { tiers: { starter: { pricing: { offerPrice: 1 } } } }, reason: 'tier price test' }
    expect((await PATCH(req('PATCH', 'admin', tierPatch))).status).toBe(403)
    expect((await PATCH(req('PATCH', null, tierPatch))).status).toBe(403)
    const plain = await json(await PATCH(req('PATCH', 'admin', { features: { pricingEngineEnabled: true }, reason: 'plain admin toggle' })))
    expect(plain.status).toBe(403)
    expect(PLAIN_REFUSED).toContain(plain.body.code)
    const t = await json(await PATCH(req('PATCH', 'superAdmin', { features: { pricingEngineEnabled: true }, reason: 'super admin toggle' })))
    expect(t.status).toBe(200)
    const v = (t.body.settings as { metadata: { version: number } }).metadata.version
    const audit = await adminDb.doc(`adminAuditLogs/platform_settings_v${v}`).get()
    expect(audit.exists).toBe(true)
    expect(audit.data()).toMatchObject({ adminUid: uid.superAdmin, action: 'platform_settings.updated' })
    expect((audit.data()!.metadata as { reason: string }).reason).toBe('super admin toggle')
    expect((await PATCH(req('PATCH', 'superAdmin', { features: { pricingEngineEnabled: false }, reason: 'restore default' }))).status).toBe(200)
  }, T)

  it('PERM · licence price override: Super Admin only; other licence mutations are Super Admin only too (RD-PHASE4-S4)', async () => {
    await adminDb.doc(`events/${SLUG}`).set({ uid: uid.organizer, lifecycleStatus: 'published' })
    await adminDb.doc(`eventLicenses/${SLUG}`).set({ eventId: SLUG, organizerUid: uid.organizer, tier: 'professional', status: 'active', version: 2, orderId: null })
    const { GET, POST } = await import('@/app/api/admin/licenses/[eventId]/route')
    const ctx = () => ({ params: Promise.resolve({ eventId: SLUG }) })
    const price = { action: 'overridePrice', pricePaise: 100, reason: 'test' }
    const a = await json(await POST(req('POST', 'admin', price), ctx()))
    expect(a.status).toBe(403); expect(PLAIN_REFUSED).toContain(a.body.code)
    expect((await POST(req('POST', 'admin', { ...price, role: 'super_admin' }, { 'x-admin-role': 'super_admin' }), ctx())).status).toBe(403)
    expect((await adminDb.doc(`eventLicenses/${SLUG}`).get()).get('admin.pricePaiseOverride')).toBeUndefined()
    // RD-CLOSE · #10 — reading commercial terms / licence pricing / coupons is a FINANCIAL read: Super
    // Admin (ADMIN_UIDS) only. A legacy-claim admin is refused with SUPER_ADMIN_REQUIRED.
    expect((await json(await GET(req('GET', 'admin'), ctx()))).body.code).toBe('SUPER_ADMIN_REQUIRED')
    expect((await POST(req('POST', 'superAdmin', price), ctx())).status).toBe(200)
    expect((await adminDb.doc(`eventLicenses/${SLUG}`).get()).get('admin.pricePaiseOverride')).toBe(100)
    // RD-PHASE4-S4 · D1 — every licence mutation (not just pricing) now needs a Super Admin.
    expect((await POST(req('POST', 'admin', { action: 'suspend', reason: 'plain admin refused' }), ctx())).status).toBe(403)
    expect((await POST(req('POST', 'superAdmin', { action: 'suspend', reason: 'super admin allowed' }), ctx())).status).toBe(200)
  }, T)

  // ═══ REF ═══════════════════════════════════════════════════════════════════════
  it('REF · a coupon-exhausted licence remainder is HELD for a manual decision — no gateway refund, one hold under racing callers', async () => {
    const { holdExhaustedCouponRemainder } = await import('@/lib/licensing/finalizeLicensePurchase')
    const input = { eventId: SLUG, orderId: 'order_ec04b', paymentId: 'pay_ec04b', remainderPaise: 59_649, persisted: null }
    await Promise.all([holdExhaustedCouponRemainder(input), holdExhaustedCouponRemainder(input), holdExhaustedCouponRemainder(input)])
    expect(gw.refundCalls).toBe(0)
    const hold = await adminDb.doc(`failedRefunds/license_hold_lic_${SLUG}`).get()
    expect(hold.data()).toMatchObject({ kind: 'license_remainder_hold', status: 'open', paymentId: 'pay_ec04b', amountPaise: 59_649, reason: 'coupon_exhausted' })
    expect((await adminDb.doc(`licenseOrders/lic_${SLUG}`).get()).data()).toMatchObject({ status: 'failed', failReason: 'coupon_exhausted', manualRefundHoldId: `license_hold_lic_${SLUG}` })
    // An order already refunded under the OLD behaviour gets no second hold.
    await adminDb.doc(`failedRefunds/license_hold_lic_${SLUG}`).delete()
    await holdExhaustedCouponRemainder({ ...input, persisted: { couponExhaustedRefundId: 'rfnd_old' } as never })
    expect((await adminDb.doc(`failedRefunds/license_hold_lic_${SLUG}`).get()).exists).toBe(false)
    expect(gw.refundCalls).toBe(0)
  }, T)

  it('REF · a stale capacity-change remainder is HELD, never refunded automatically', async () => {
    const { holdStaleCapacityRemainder } = await import('@/lib/licensing/capacityChange')
    const input = { orderId: `cap_${SLUG}_1`, eventId: SLUG, paymentId: 'pay_ec04b_cap', remainderPaise: 28_851 }
    await Promise.all([holdStaleCapacityRemainder(input), holdStaleCapacityRemainder(input)])
    expect(gw.refundCalls).toBe(0)
    expect((await adminDb.doc(`failedRefunds/license_hold_cap_${SLUG}_1`).get()).data()).toMatchObject({ status: 'open', reason: 'capacity_stale', amountPaise: 28_851 })
  }, T)

  it('REF · the hold is refunded only by an explicit Super Admin action (ordinary admin refused)', async () => {
    const { holdExhaustedCouponRemainder } = await import('@/lib/licensing/finalizeLicensePurchase')
    await holdExhaustedCouponRemainder({ eventId: SLUG, orderId: 'order_ec04b', paymentId: 'pay_ec04b', remainderPaise: 1_000, persisted: null })
    const { POST } = await import('@/app/api/admin/failed-refunds/[id]/retry/route')
    const ctx = () => ({ params: Promise.resolve({ id: `license_hold_lic_${SLUG}` }) })
    expect((await POST(req('POST', 'admin', { reason: 'refund the held remainder' }), ctx())).status).toBe(403)
    expect(gw.refundCalls).toBe(0)
    // RD-PHASE4-S4 · D3 — a Super Admin retry needs a reason.
    expect((await POST(req('POST', 'superAdmin'), ctx())).status).toBe(400)
    expect(gw.refundCalls).toBe(0)
    expect((await POST(req('POST', 'superAdmin', { reason: 'refund the held remainder' }), ctx())).status).toBe(200)
    expect(gw.refundCalls).toBe(1)
  }, T)

  // ═══ AUD ═══════════════════════════════════════════════════════════════════════
  it('AUD · a licence price override and its audit rows commit together; a failed audit leaves the price unchanged', async () => {
    await adminDb.doc(`eventLicenses/${SLUG}`).set({ eventId: SLUG, organizerUid: uid.organizer, tier: 'professional', status: 'active', version: 2, orderId: null })
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    // RD-PHASE4-S4 · F8 — the audit rows are now staged in the action's TRANSACTION (not a batch):
    // fail the audit-row create inside it and nothing may commit.
    const { Transaction } = await import('firebase-admin/firestore')
    const realCreate = Transaction.prototype.create
    vi.spyOn(Transaction.prototype, 'create').mockImplementation(function (this: InstanceType<typeof Transaction>, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
      if (ref.path.startsWith('adminAuditLogs/')) throw new Error('injected audit failure')
      return realCreate.call(this, ref, data)
    } as never)
    await expect(applyLicenseAction(SLUG, { action: 'overridePrice', pricePaise: 5, reason: 'x' } as never, uid.superAdmin)).rejects.toThrow(/injected audit failure/)
    vi.restoreAllMocks()
    expect((await adminDb.doc(`eventLicenses/${SLUG}`).get()).get('admin')).toBeUndefined()
    expect((await adminDb.collection('licenseHistory').where('eventId', '==', SLUG).get()).size).toBe(0)

    await applyLicenseAction(SLUG, { action: 'overridePrice', pricePaise: 5, reason: 'x' } as never, uid.superAdmin)
    const hist = (await adminDb.collection('licenseHistory').where('eventId', '==', SLUG).get()).docs
    expect(hist).toHaveLength(1)
    expect((await adminDb.doc(`adminAuditLogs/license_${hist[0].id}`).get()).exists).toBe(true)
    expect((await adminDb.doc(`eventLicenses/${SLUG}`).get()).get('admin.pricePaiseOverride')).toBe(5)
  }, T)
})
