// RD-PHASE4-S2 — global pricing is Super Admin only, proved against REAL Firestore through the REAL routes.
//
//   A · every `fees` field (business-config)          → plain admin 403 SUPER_ADMIN_REQUIRED, Super Admin 200
//   B · every platform-settings key                    → plain admin 403; Super Admin 200; reason required;
//                                                        ONE transaction (settings + before/after audit)
//   C · payments.activeProvider, media-credit enablement + refund bounds, settlement fee/tax, licence coupons
//   D · the admin per-event pricing override (PATCH/DELETE)
//
// Identity is mocked at the token boundary only (the two resolvers in lib/admin/auth); every route,
// service, transaction and audit write below is production code on the emulator.

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
const SUPER = `p4s2-super-${P}`, PLAIN = `p4s2-plain-${P}`

const h = vi.hoisted(() => ({ admin: '' as string, superUid: '', plainUid: '' }))
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.admin === h.superUid ? h.admin : null),
  legacyAdminClaimOnly: async () => !!h.plainUid && h.admin === h.plainUid,
  resolveSuperAdminUid: async () => (h.admin === h.superUid ? h.superUid : null),
}))

const req = (method: string, body?: unknown) => new NextRequest('http://localhost/api/test', {
  method, headers: { 'Content-Type': 'application/json', authorization: 'Bearer t' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })

describeEmu('RD-PHASE4-S2 · global pricing is Super Admin only', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  const cleanup = new Set<string>()

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    h.superUid = SUPER; h.plainUid = PLAIN
    ;({ adminDb } = await import('@/lib/firebase/admin'))
  }, T)
  afterAll(async () => {
    await adminDb.recursiveDelete(adminDb.doc('system/businessConfiguration')).catch(() => null)
    await adminDb.doc('platformSettings/default').delete().catch(() => null)
    for (const c of ['configurationAudit', 'adminAuditLogs']) {
      for (const who of [SUPER, PLAIN]) {
        for (const f of ['updatedBy', 'adminUid']) {
          const qs = await adminDb.collection(c).where(f, '==', who).get().catch(() => null)
          for (const d of qs?.docs ?? []) await d.ref.delete().catch(() => null)
        }
      }
    }
    for (const p of cleanup) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
  }, T)
  beforeEach(() => { h.admin = '' })

  // ═══ A · fees (business-config) ═══════════════════════════════════════════════════════
  const publish = async (section: string, patch: Record<string, unknown>, reason = 'stage 2 test') => {
    const { POST } = await import('@/app/api/admin/business-config/route')
    return json(await POST(req('POST', { section, patch, reason })))
  }
  const stored = async () => (await adminDb.doc('system/businessConfiguration').get()).data() ?? {}

  const FEE_PATCHES: Array<Record<string, unknown>> = [
    { platformFeePercent: 3 }, { platformFeeEnabled: false }, { donationPlatformFee: 1 }, { gstPercent: 12 },
    { gstEnabled: false }, { gatewayFeeEnabled: false }, { gatewayFeePercent: 2.5 }, { convenienceFeeEnabled: true },
    { convenienceFeePercent: 1 }, { refundProcessingFee: 100 },
  ]

  it('A · a plain admin (`admin: true` only) is refused EVERY fees change — 403 SUPER_ADMIN_REQUIRED, nothing written', async () => {
    h.admin = PLAIN
    const before = JSON.stringify(await stored())
    for (const p of FEE_PATCHES) {
      const r = await publish('fees', p)
      expect(r.status, JSON.stringify(p)).toBe(403)
      expect(PLAIN_REFUSED, JSON.stringify(p)).toContain(r.body.code)
    }
    expect(JSON.stringify(await stored())).toBe(before)
  }, T)

  it('A · a Super Admin publishes fees; the change is audited with before/after and the reason', async () => {
    h.admin = SUPER
    const r = await publish('fees', { platformFeePercent: 3, gstPercent: 18 }, 'set the attendee platform fee')
    expect(r.status).toBe(200)
    const v = r.body.version as number
    expect(((await stored()).fees as Record<string, unknown>).platformFeePercent).toBe(3)
    const audit = (await adminDb.doc(`configurationAudit/v${v}`).get()).data()!
    expect(audit).toMatchObject({ section: 'fees', updatedBy: SUPER, reason: 'set the attendee platform fee' })
    expect((audit.after as Record<string, unknown>).platformFeePercent).toBe(3)
    // back to the default so the rest of the suite (and anything after it) sees today's precedence
    expect((await publish('fees', { platformFeePercent: null })).status).toBe(200)
  }, T)

  // ═══ C · field-level: payments / mediaStudio / settlements ════════════════════════════════
  it('C · plain admin: provider, credit enablement, refund bounds and settlement fee/tax → 403; operational settings still 200', async () => {
    h.admin = PLAIN
    const refused: Array<[string, Record<string, unknown>]> = [
      ['payments', { activeProvider: 'cashfree' }],
      ['mediaStudio', { creditsEnabled: true }],
      ['mediaStudio', { minRefundablePaise: 1_000 }],
      ['mediaStudio', { minRefundCredits: 5 }],
      ['mediaStudio', { maxRefundPerRequestPaise: 900_000 }],
      ['mediaStudio', { refundWindowDays: 3 }],
      ['settlements', { settlementFeePercent: 1 }],
      ['settlements', { settlementFeeFlatPaise: 500 }],
      ['settlements', { settlementTaxPercent: 18 }],
    ]
    for (const [section, p] of refused) {
      const r = await publish(section, p)
      expect(r.status, `${section} ${JSON.stringify(p)}`).toBe(403)
      expect(PLAIN_REFUSED).toContain(r.body.code)
    }
    // not pricing — RD-SEC-01: the claim-only admin is refused these too (two roles only); the Super
    // Admin's operational settings still save.
    expect((await publish('mediaStudio', { refundsEnabled: false })).status).toBe(403)
    expect((await publish('settlements', { holdHours: 48 })).status).toBe(403)
    h.admin = SUPER
    expect((await publish('mediaStudio', { refundsEnabled: false })).status).toBe(200)
    expect((await publish('settlements', { holdHours: 48 })).status).toBe(200)
  }, T)

  it('C · Super Admin can change the provider and the settlement fee', async () => {
    h.admin = SUPER
    // RD-PREPROD · Cashfree production is off here: selecting Cashfree is REFUSED and nothing is
    // written (it would block every new payment — there is no fallback to Razorpay).
    const refused = await publish('payments', { activeProvider: 'cashfree' })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('CASHFREE_NOT_ENABLED')
    expect(((await stored()).payments as Record<string, unknown> | undefined)?.activeProvider).not.toBe('cashfree')
    // With the Cashfree SANDBOX gate open on the emulator, the Super Admin's change saves as before.
    vi.stubEnv('CASHFREE_SANDBOX_ENABLED', 'true'); vi.stubEnv('CASHFREE_ENV', 'sandbox')
    vi.stubEnv('CASHFREE_CLIENT_ID', 'TEST_APP_ID'); vi.stubEnv('CASHFREE_CLIENT_SECRET', 'TEST_SECRET')
    try {
      expect((await publish('payments', { activeProvider: 'cashfree' })).status).toBe(200)
    } finally {
      vi.unstubAllEnvs()   // this file stubs no other variables
    }
    expect((await publish('payments', { activeProvider: 'razorpay' })).status).toBe(200)
    expect((await publish('settlements', { settlementFeePercent: 1 })).status).toBe(200)
    expect((await publish('settlements', { settlementFeePercent: 0 })).status).toBe(200)
  }, T)

  it('C · a STALE server cache cannot bypass the gate (the transaction checks the fresh document)', async () => {
    h.admin = SUPER
    expect((await publish('payments', { activeProvider: 'razorpay' })).status).toBe(200)
    const { businessConfig } = await import('@/lib/config/businessConfigService')
    expect((await businessConfig.getSection('payments')).activeProvider).toBe('razorpay')   // cache primed
    // another instance changes it (this instance's cache still says razorpay)
    await adminDb.doc('system/businessConfiguration').set({ payments: { activeProvider: 'cashfree' } }, { merge: true })
    h.admin = PLAIN
    const r = await publish('payments', { activeProvider: 'razorpay' })      // "no change" by the stale cache
    expect(r.status).toBe(403)
    expect(((await stored()).payments as Record<string, unknown>).activeProvider).toBe('cashfree')
    h.admin = SUPER
    expect((await publish('payments', { activeProvider: 'razorpay' })).status).toBe(200)
  }, T)

  // ═══ B · platform-settings ═══════════════════════════════════════════════════════════
  const ps = async (body: Record<string, unknown>) => {
    const { PATCH } = await import('@/app/api/admin/platform-settings/route')
    return json(await PATCH(req('PATCH', body)))
  }
  const psDoc = async () => (await adminDb.doc('platformSettings/default').get()).data()
  const PS_PATCHES: Array<[string, Record<string, unknown>]> = [
    ['pricing.platformFeeAmount', { pricing: { platformFeeAmount: 3 } }],
    ['pricing.platformGstPercent', { pricing: { platformGstPercent: 12 } }],
    ['gateway.gatewayPercent', { gateway: { gatewayPercent: 2.5 } }],
    ['gateway.gatewayGstPercent', { gateway: { gatewayGstPercent: 12 } }],
    ['gateway.convenienceFee', { gateway: { convenienceFee: 2 } }],
    ['commercial.platformGstEnabled', { commercial: { platformGstEnabled: false } }],
    ['commercial.gatewayGstEnabled', { commercial: { gatewayGstEnabled: true } }],
    ['features.pricingEngineEnabled', { features: { pricingEngineEnabled: true } }],
    ['licensing.tiers.starter.pricing.regularPrice', { licensing: { tiers: { starter: { pricing: { regularPrice: 5999 } } } } }],
  ]

  it('B · a plain admin is refused EVERY platform-settings key (403 SUPER_ADMIN_REQUIRED), nothing written; GET still works', async () => {
    h.admin = PLAIN
    const before = JSON.stringify((await psDoc()) ?? null)
    for (const [key, p] of [...PS_PATCHES, ['gateway.provider', { gateway: { provider: 'razorpay' } }] as [string, Record<string, unknown>],
      ['commercial.platformFeePaidBy', { commercial: { platformFeePaidBy: 'attendee' } }] as [string, Record<string, unknown>]]) {
      const r = await ps({ ...p, reason: 'plain admin attempt' })
      expect(r.status, key).toBe(403)
      expect(PLAIN_REFUSED, key).toContain(r.body.code)
    }
    expect(JSON.stringify((await psDoc()) ?? null)).toBe(before)
    const { GET } = await import('@/app/api/admin/platform-settings/route')
    // RD-SEC-01 · was "GET still works" for the claim-only admin: it reads nothing now.
    expect((await GET(req('GET'))).status).toBe(403)
    h.admin = SUPER
    expect((await GET(req('GET'))).status).toBe(200)
  }, T)

  it('B · Super Admin: a reason is required; each key saves and is audited (actor, path, before, after, reason) in the same transaction', async () => {
    h.admin = SUPER
    expect((await ps({ pricing: { platformFeeAmount: 3 } })).status).toBe(400)
    expect((await ps({ pricing: { platformFeeAmount: 3 }, reason: '  a ' })).status).toBe(400)
    for (const [key, p] of PS_PATCHES) {
      const r = await ps({ ...p, reason: `change ${key}` })
      expect(r.status, key).toBe(200)
      expect(r.body.changed, key).toEqual([key])
      const v = ((r.body.settings as Record<string, unknown>).metadata as { version: number }).version
      const a = (await adminDb.doc(`adminAuditLogs/platform_settings_v${v}`).get()).data()!
      expect(a, key).toMatchObject({ adminUid: SUPER, action: 'platform_settings.updated', entityId: 'default' })
      expect(a.createdAt, key).toBeTruthy()
      const m = a.metadata as { reason: string; fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> }
      expect(m.reason).toBe(`change ${key}`)
      expect(m.fields).toEqual([key])
      expect(m.before[key]).not.toEqual(m.after[key])
    }
    // restore the engine switch to its production default
    expect((await ps({ features: { pricingEngineEnabled: false }, reason: 'restore default' })).status).toBe(200)
  }, T)

  it('B · a no-op patch writes nothing; CONCURRENT updates of different keys both survive', async () => {
    h.admin = SUPER
    const v0 = ((await psDoc())!.metadata as { version: number }).version
    const noop = await ps({ features: { pricingEngineEnabled: false }, reason: 'no change' })
    expect(noop.status).toBe(200); expect(noop.body.changed).toEqual([])
    expect(((await psDoc())!.metadata as { version: number }).version).toBe(v0)
    const [a, b] = await Promise.all([
      ps({ pricing: { platformFeeAmount: 7 }, reason: 'concurrent a' }),
      ps({ gateway: { convenienceFee: 4 }, reason: 'concurrent b' }),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    const d = (await psDoc())!
    expect((d.pricing as Record<string, unknown>).platformFeeAmount).toBe(7)
    expect((d.gateway as Record<string, unknown>).convenienceFee).toBe(4)
    expect((d.metadata as { version: number }).version).toBe(v0 + 2)
  }, T)

  it('B · a FAILED audit write leaves the settings unchanged', async () => {
    h.admin = SUPER
    const before = JSON.stringify(await psDoc())
    const { Transaction } = await import('firebase-admin/firestore')
    const orig = Transaction.prototype.set
    const spy = vi.spyOn(Transaction.prototype, 'set').mockImplementation(function (this: unknown, ...args: unknown[]) {
      const ref = args[0] as { path?: string }
      if (ref?.path?.startsWith('adminAuditLogs/')) throw new Error('injected audit failure')
      return (orig as (...a: unknown[]) => unknown).apply(this, args) as never
    })
    try {
      await expect(ps({ pricing: { platformFeeAmount: 9 }, reason: 'should roll back' })).rejects.toThrow(/injected audit failure/)
    } finally { spy.mockRestore() }
    expect(JSON.stringify(await psDoc())).toBe(before)
  }, T)

  // ═══ D · admin per-event pricing override ═════════════════════════════════════════════
  it('D · the admin per-event pricing override: PATCH/DELETE Super Admin only; GET too (RD-CLOSE · #10)', async () => {
    const slug = `p4s2-ev-${P}`
    await adminDb.doc(`events/${slug}`).set({ uid: 'someone', slug, lifecycleStatus: 'published' }); cleanup.add(`events/${slug}`)
    const mod = await import('@/app/api/admin/events/[slug]/pricing-override/route')
    const ctx = { params: Promise.resolve({ slug }) }
    h.admin = PLAIN
    const p = await json(await mod.PATCH(req('PATCH', { convenienceFee: 1 }), ctx))
    expect([401, 403]).toContain(p.status); expect(PLAIN_REFUSED).toContain(p.body.code)   // RD-SEC-01 · refused at the admin door
    expect([401, 403]).toContain((await json(await mod.DELETE(req('DELETE'), ctx))).status)   // RD-SEC-01 · admin door
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.adminOverride).toBeUndefined()
    // RD-CLOSE · #10 — reading commercial terms / licence pricing / coupons is a FINANCIAL read: Super
    // Admin (ADMIN_UIDS) only. A legacy-claim admin is refused with SUPER_ADMIN_REQUIRED.
    expect((await mod.GET(req('GET'), ctx)).status).toBe(403)
    h.admin = ''
    expect((await mod.PATCH(req('PATCH', { convenienceFee: 1 }), ctx)).status).toBe(401)
    h.admin = SUPER
    // RD-PHASE4-S3 · Q4 — the adminOverride MONEY fields are a retired layer (410); registrationLimit is unchanged.
    const retired = await json(await mod.PATCH(req('PATCH', { convenienceFee: 1 }), ctx))
    expect(retired.status).toBe(410); expect(retired.body.code).toBe('PRICING_LAYER_RETIRED')
    // RD-PHASE4-S4 · D3 — a reason is now required (3–500 characters).
    const noReason = await json(await mod.PATCH(req('PATCH', { registrationLimit: 300 }), ctx))
    expect(noReason.status).toBe(400); expect(noReason.body.code).toBe('REASON_REQUIRED')
    expect((await mod.PATCH(req('PATCH', { registrationLimit: 300, reason: 'raise the limit' }), ctx)).status).toBe(200)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.adminOverride).toMatchObject({ registrationLimit: 300, updatedBy: SUPER })
    expect((await mod.DELETE(req('DELETE', { reason: 'clear the limit' }), ctx)).status).toBe(200)
  }, T)

  // ═══ C · licence coupons ═════════════════════════════════════════════════════════════
  it('C · licence coupon issuance and every coupon mutation are Super Admin only; GET reports the capability', async () => {
    const list = await import('@/app/api/admin/license-coupons/route')
    const one  = await import('@/app/api/admin/license-coupons/[code]/route')
    const code = `P4S2${P}`, clone = `P4S2C${P}`
    cleanup.add(`licenseCoupons/${code}`); cleanup.add(`licenseCoupons/${clone}`)
    const coupon = { code, type: 'percentage', value: 10 }
    const ctx = { params: Promise.resolve({ code }) }

    h.admin = PLAIN
    const c1 = await json(await list.POST(req('POST', { reason: 'issue', coupon })))
    expect(c1.status).toBe(403); expect(PLAIN_REFUSED).toContain(c1.body.code)
    expect((await adminDb.doc(`licenseCoupons/${code}`).get()).exists).toBe(false)
    // RD-CLOSE · #10 — reading commercial terms / licence pricing / coupons is a FINANCIAL read: Super
    // Admin (ADMIN_UIDS) only. A legacy-claim admin is refused with SUPER_ADMIN_REQUIRED.
    expect((await json(await list.GET(req('GET')))).body.code).toBe('SUPER_ADMIN_REQUIRED')

    h.admin = SUPER
    expect((await list.POST(req('POST', { reason: 'issue', coupon }))).status).toBe(201)
    expect((await json(await list.GET(req('GET')))).body.permissions).toEqual({ canEditPricing: true })
    expect((await json(await one.GET(req('GET'), ctx))).body.permissions).toEqual({ canEditPricing: true })

    h.admin = PLAIN
    for (const body of [
      { action: 'update', reason: 'x', coupon: { description: 'changed' } },
      { action: 'clone', reason: 'x', newCode: clone },
      { action: 'pause', reason: 'x' }, { action: 'resume', reason: 'x' }, { action: 'archive', reason: 'x' },
    ]) {
      const r = await json(await one.POST(req('POST', body), ctx))
      expect(r.status, body.action).toBe(403)
      expect(PLAIN_REFUSED, body.action).toContain(r.body.code)
    }
    expect((await adminDb.doc(`licenseCoupons/${clone}`).get()).exists).toBe(false)
    expect((await json(await one.GET(req('GET'), ctx))).body.code).toBe('SUPER_ADMIN_REQUIRED')   // RD-CLOSE · #10

    h.admin = SUPER
    expect((await one.POST(req('POST', { action: 'pause', reason: 'test pause' }), ctx)).status).toBe(200)
  }, T)
})
