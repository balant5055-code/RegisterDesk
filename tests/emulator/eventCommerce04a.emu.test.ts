// RD-EVENT-COMMERCE-04A — configuration reliability, audit atomicity and Super Admin pricing.
//
// REAL Firestore + REAL Auth emulator tokens (the admin/super-admin distinction is exercised
// through the real `resolveAdminUid` / `resolveSuperAdminUid`, not a mock). Razorpay is an
// in-memory stub. The business-config doc is backed up and restored around the suite.
//
//   AUTH  who may view/edit global pricing and per-event terms (super admin, ordinary admin,
//         organizer, unauthenticated, forged role fields)
//   CFG   a corrupt capacity-pricing group FAILS CLOSED; a corrupt service does not disturb
//         valid capacity pricing or its sibling services; absent ⇒ approved defaults; ₹0 kept
//   AUD   config / per-event / licence-action audit rows commit atomically with the change,
//         a failed audit write fails the operation, and a retry never duplicates a row

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
const SLUG = `ec04a-live-${PID}`
const ORG  = `ec04a-org-${PID}`
const CFG_DOC = 'system/businessConfiguration'
const PASSWORD = 'Ec04aPassw0rd!'
const EMAIL = { superAdmin: `ec04a-super-${PID}@registerdesk.test`, admin: `ec04a-admin-${PID}@registerdesk.test`, organizer: `ec04a-org-${PID}@registerdesk.test` }

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_ec04a', RAZORPAY_KEY_SECRET: 'ec04a',
  razorpay: {
    orders:   { create: async () => { throw new Error('no orders in this suite') }, fetchPayments: async () => ({ items: [] }) },
    payments: { fetch: async () => { throw new Error('no payment') }, refund: async () => { throw new Error('no refunds') } },
  },
}))
// Organizer-side quote routes only need an authenticated caller; the admin routes below use
// the REAL admin resolvers with real emulator tokens.
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => ({ uid: ORG, email: null }),
}))

describeEmu('RD-EVENT-COMMERCE-04A · config reliability, audit atomicity, Super Admin pricing', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let cfgBackup: Record<string, unknown> | null = null
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
  const req = (method: 'GET' | 'POST', who: keyof typeof EMAIL | null, body?: unknown, extraHeaders: Record<string, string> = {}) =>
    new NextRequest('http://x/api/t', {
      method,
      headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${token[who]}` } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
  const cfg = async () => (await import('@/lib/config/businessConfigService')).businessConfig

  async function writeStoredLicensing(licensing: Record<string, unknown>) {
    await adminDb.doc(CFG_DOC).set({ licensing }, { merge: false })
    ;(await cfg()).invalidateCache()
  }
  async function restoreConfig() {
    if (cfgBackup) await adminDb.doc(CFG_DOC).set(cfgBackup)
    else await adminDb.doc(CFG_DOC).delete().catch(() => null)
    ;(await cfg()).invalidateCache()
  }
  async function seedLive() {
    await adminDb.doc(`events/${SLUG}`).set({ uid: ORG, draftId: 'EC04ADraft', totalCapacity: 600, lifecycleStatus: 'published' })
    await adminDb.doc(`registrationCounters/${SLUG}`).set({ eventSlug: SLUG, totalCount: 10 })
    await adminDb.doc(`eventLicenses/${SLUG}`).set({ eventId: SLUG, organizerUid: ORG, tier: 'professional', status: 'active', version: 2, orderId: null })
  }
  async function wipe() {
    for (const c of ['licenseHistory']) for (const d of (await adminDb.collection(c).where('eventId', '==', SLUG).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('adminAuditLogs').where('entityId', '==', SLUG).get()).docs) await d.ref.delete()
    for (const p of [`events/${SLUG}`, `eventLicenses/${SLUG}`, `registrationCounters/${SLUG}`]) await adminDb.doc(p).delete().catch(() => null)
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    const snap = await adminDb.doc(CFG_DOC).get()
    cfgBackup = snap.exists ? snap.data() as Record<string, unknown> : null
    for (const k of Object.keys(EMAIL) as Array<keyof typeof EMAIL>) {
      const existing = await adminAuth.getUserByEmail(EMAIL[k]).catch(() => null)
      const u = existing ?? await adminAuth.createUser({ email: EMAIL[k], password: PASSWORD, emailVerified: true })
      uid[k] = u.uid
      // Both admins hold the `admin: true` claim; only the SUPER admin is also in ADMIN_UIDS.
      await adminAuth.setCustomUserClaims(u.uid, k === 'organizer' ? null : { admin: true })
    }
    process.env.ADMIN_UIDS = uid.superAdmin
    for (const k of Object.keys(EMAIL) as Array<keyof typeof EMAIL>) token[k] = await signIn(EMAIL[k])
  }, T)
  afterAll(async () => {
    await wipe(); await restoreConfig()
    // Rows this suite's publishes appended (history is keyed by version; audit by v{version}).
    for (const c of [`${CFG_DOC}/history`, 'configurationAudit']) {
      for (const u of Object.values(uid)) for (const d of (await adminDb.collection(c).where('updatedBy', '==', u).get()).docs) await d.ref.delete()
    }
    for (const k of Object.keys(EMAIL) as Array<keyof typeof EMAIL>) await adminAuth.deleteUser(uid[k]).catch(() => null)
    if (savedAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedAdminUids
  }, T)
  beforeEach(async () => { await wipe(); await restoreConfig() }, T)
  afterEach(() => { vi.restoreAllMocks() })

  // ═══ AUTH ══════════════════════════════════════════════════════════════════════
  it('AUTH · global pricing: only the Super Admin may publish; admin/organizer/anonymous/forged are refused', async () => {
    const { POST } = await import('@/app/api/admin/business-config/route')
    const current = (await (await cfg()).getSection('licensing')).commercial
    const patch = { section: 'licensing', patch: { commercial: { ...current, gstRatePercent: 12 } }, reason: 'auth matrix' }

    const admin = await json(await POST(req('POST', 'admin', patch)))
    expect(admin.status).toBe(403); expect(PLAIN_REFUSED).toContain(admin.body.code)
    expect((await POST(req('POST', 'organizer', patch))).status).toBe(403)
    expect((await POST(req('POST', null, patch))).status).toBe(403)
    // A browser-supplied role or identity grants nothing: the decision is the verified token.
    const forged = await POST(req('POST', 'admin', { ...patch, role: 'super_admin', isSuperAdmin: true, adminUid: uid.superAdmin },
      { 'x-admin-role': 'super_admin', 'x-user-id': uid.superAdmin }))
    expect(forged.status).toBe(403)
    ;(await cfg()).invalidateCache()
    expect((await (await cfg()).getSection('licensing')).commercial.gstRatePercent).toBe(current.gstRatePercent)

    expect((await POST(req('POST', 'superAdmin', patch))).status).toBe(200)
    ;(await cfg()).invalidateCache()
    expect((await (await cfg()).getSection('licensing')).commercial.gstRatePercent).toBe(12)
  }, T)

  // RD-SEC-01 · was "non-pricing sections keep ordinary-admin access": the claim-only admin tier is
  // gone (two roles) — refused; the Super Admin keeps non-pricing access.
  it('AUTH · non-pricing sections: claim-only admin refused, Super Admin allowed', async () => {
    const { POST } = await import('@/app/api/admin/business-config/route')
    expect((await POST(req('POST', 'admin', { section: 'branding', patch: {}, reason: 'access unchanged' }))).status).toBe(403)
    expect((await POST(req('POST', 'superAdmin', { section: 'branding', patch: {}, reason: 'access unchanged' }))).status).toBe(200)
  }, T)

  // RD-SEC-01 · was "any admin can read the config": only the Super Admin reads it now.
  it('AUTH · viewing: only the Super Admin reads the config; the server reports who may edit pricing', async () => {
    const { GET } = await import('@/app/api/admin/business-config/route')
    const a = await json(await GET(req('GET', 'admin')))
    expect(a.status).toBe(403); expect(a.body).not.toHaveProperty('config')
    const s = await json(await GET(req('GET', 'superAdmin')))
    expect(s.body.permissions).toEqual({ canEditPricing: true })
    expect((await GET(req('GET', 'organizer'))).status).toBe(403)
    expect((await GET(req('GET', null))).status).toBe(403)
  }, T)

  it('AUTH · per-event commercial terms: Super Admin only; GET tells the UI', async () => {
    await seedLive()
    const { GET, POST } = await import('@/app/api/admin/events/[slug]/commercial/route')
    const ctx = () => ({ params: Promise.resolve({ slug: SLUG }) })
    const body = { terms: { activationRatePaise: 120 }, reason: 'negotiated' }
    const a = await json(await POST(req('POST', 'admin', body), ctx()))
    expect(a.status).toBe(403); expect(PLAIN_REFUSED).toContain(a.body.code)
    expect((await POST(req('POST', 'organizer', body), ctx())).status).toBe(403)
    expect((await POST(req('POST', null, body), ctx())).status).toBe(403)
    expect((await POST(req('POST', 'admin', { ...body, role: 'super_admin' }, { 'x-admin-role': 'super_admin' }), ctx())).status).toBe(403)
    expect((await adminDb.doc(`events/${SLUG}`).get()).get('commercial')).toBeUndefined()
    // RD-CLOSE · #10 — reading commercial terms / licence pricing / coupons is a FINANCIAL read: Super
    // Admin (ADMIN_UIDS) only. A legacy-claim admin is refused with SUPER_ADMIN_REQUIRED.
    const plainGet = await json(await GET(req('GET', 'admin'), ctx()))
    expect(plainGet.status).toBe(403); expect(PLAIN_REFUSED).toContain(plainGet.body.code)
    expect((await json(await GET(req('GET', 'superAdmin'), ctx()))).body.canEdit).toBe(true)
    expect((await POST(req('POST', 'superAdmin', body), ctx())).status).toBe(200)
    expect((await adminDb.doc(`events/${SLUG}`).get()).get('commercial')).toEqual({ activationRatePaise: 120 })
  }, T)

  // RD-SEC-01 · was "addNote stays admin": the claim-only admin can no longer add notes either.
  it('AUTH · licence admin actions: every action is Super Admin only (RD-PHASE4-S4 · D1 + RD-SEC-01)', async () => {
    await seedLive()
    const { POST } = await import('@/app/api/admin/licenses/[eventId]/route')
    const ctx = () => ({ params: Promise.resolve({ eventId: SLUG }) })
    const plain = await json(await POST(req('POST', 'admin', { action: 'overrideFeatures', features: {}, reason: 'access check' }), ctx()))
    expect(plain.status).toBe(403); expect(PLAIN_REFUSED).toContain(plain.body.code)
    // RD-LEGACY-01 — feature switches are retired: even a Super Admin gets 410 (nothing written).
    expect((await POST(req('POST', 'superAdmin', { action: 'overrideFeatures', features: {}, reason: 'access check' }), ctx())).status).toBe(410)
    expect((await POST(req('POST', 'admin', { action: 'addNote', note: 'a plain note' }), ctx())).status).toBe(403)
    expect((await POST(req('POST', 'superAdmin', { action: 'addNote', note: 'a super note' }), ctx())).status).toBe(200)
    expect((await POST(req('POST', 'organizer', { action: 'addNote', note: 'x' }), ctx())).status).toBe(403)
  }, T)

  // ═══ CFG · fail closed / isolation ═════════════════════════════════════════════
  const quoteCapacity = async (capacity: number, services: Record<string, number> = {}) => {
    const { POST } = await import('@/app/api/licensing/checkout/quote/route')
    return json(await POST(req('POST', 'organizer', { capacity, services })))
  }
  const CERT = { enabled: true, unitPricePaise: 200, gstRatePercent: 18, minQuantity: 10, maxQuantity: 10_000, presets: [], onExhausted: 'wallet_payg' }

  it('CFG · a corrupt capacity-pricing value FAILS CLOSED — no quote, no activation price — and is not repaired', async () => {
    for (const corrupt of [{ activationRatePaise: '300' }, { activationRatePaise: null }, { gstRatePercent: 150 }, { freeRegistrationCapacity: -5 }, { maximumEventCapacity: 50 }]) {
      await writeStoredLicensing({ commercial: corrupt, serviceAllowances: { certificates: CERT } })
      const q = await quoteCapacity(437, { certificates: 100 })
      expect((q.body.capacity as { ok: boolean; code?: string }), JSON.stringify(corrupt)).toMatchObject({ ok: false, code: 'INVALID_TERMS' })
      // The activation-quote route refuses too (422) — never ₹-anything, never the defaults.
      const { POST: aq } = await import('@/app/api/licensing/capacity/activation-quote/route')
      expect((await aq(req('POST', 'organizer', { capacity: 437 }))).status).toBe(422)
      // A valid SERVICE is unaffected by the broken capacity group.
      expect((q.body.services as Record<string, { ok: boolean }>).certificates.ok).toBe(true)
      // Nothing was rewritten.
      expect((await adminDb.doc(CFG_DOC).get()).get('licensing.commercial')).toEqual(corrupt)
    }
    // The admin console is TOLD, instead of being shown defaults as if they were stored.
    const { GET } = await import('@/app/api/admin/business-config/route')
    const g = await json(await GET(req('GET', 'superAdmin')))
    expect((g.body.commercialIntegrity as { ok: boolean }).ok).toBe(false)
  }, T)

  it('CFG · a corrupt WhatsApp setting changes NEITHER valid capacity pricing NOR a valid sibling service', async () => {
    await writeStoredLicensing({
      commercial: { activationRatePaise: 300 },                                   // valid, non-default
      serviceAllowances: { whatsapp: { ...CERT, unitPricePaise: -45 }, certificates: CERT },
    })
    const q = await quoteCapacity(437, { certificates: 100 })
    // 337 × 300 = 101,100 + 18% (18,198) = 119,298 — the STORED rate, not the default 150.
    expect((q.body.capacity as { quote: { totalPaise: number } }).quote.totalPaise).toBe(119_298)
    expect((q.body.services as Record<string, { ok: boolean }>).certificates.ok).toBe(true)
    const w = await quoteCapacity(437, { whatsapp: 500 })
    expect((w.body.services as Record<string, { ok: boolean; code?: string }>).whatsapp).toMatchObject({ ok: false, code: 'NOT_PURCHASABLE' })
    // …and an invalid NON-pricing group (coupons) no longer drags capacity pricing to defaults.
    await writeStoredLicensing({ commercial: { activationRatePaise: 300 }, coupons: { enabled: 'yes' } })
    expect(((await quoteCapacity(437)).body.capacity as { quote: { totalPaise: number } }).quote.totalPaise).toBe(119_298)
  }, T)

  it('CFG · never configured ⇒ the approved defaults; an explicit ₹0 promotion is honoured', async () => {
    await writeStoredLicensing({})
    expect(((await quoteCapacity(437)).body.capacity as { quote: { totalPaise: number } }).quote.totalPaise).toBe(59_649)
    await writeStoredLicensing({ commercial: { activationRatePaise: 0 } })
    const z = (await quoteCapacity(437)).body.capacity as { quote: { totalPaise: number; paymentRequired: boolean } }
    expect(z.quote).toMatchObject({ totalPaise: 0, paymentRequired: false })
  }, T)

  it('CFG · an unconfigured service stays unavailable', async () => {
    await writeStoredLicensing({ serviceAllowances: { certificates: { ...CERT, unitPricePaise: null } } })
    const q = await quoteCapacity(100, { certificates: 100 })
    expect((q.body.services as Record<string, { ok: boolean; code?: string }>).certificates).toMatchObject({ ok: false, code: 'NOT_PURCHASABLE' })
  }, T)

  // ═══ AUD ═══════════════════════════════════════════════════════════════════════
  it('AUD · a config publish writes exactly ONE audit row, keyed by version, in the same transaction', async () => {
    const svc = await cfg()
    const cur = (await svc.getSection('licensing')).commercial
    const r = await svc.updateSection('licensing', { commercial: { ...cur, gstRatePercent: 17 } }, { updatedBy: uid.superAdmin, reason: 'audit check' })
    const audit = await adminDb.doc(`configurationAudit/v${r.version}`).get()
    expect(audit.exists).toBe(true)
    expect(audit.data()).toMatchObject({ section: 'licensing', version: r.version, updatedBy: uid.superAdmin, reason: 'audit check' })
    await adminDb.doc(`configurationAudit/v${r.version}`).delete()
  }, T)

  it('AUD · if the config audit row cannot be written, the change does NOT commit and the call fails', async () => {
    const svc = await cfg()
    const before = await adminDb.doc(CFG_DOC).get()
    const beforeVersion = (before.get('_meta.version') as number | undefined) ?? 0
    const histCountBefore = (await adminDb.collection(`${CFG_DOC}/history`).where('reason', '==', 'should fail').get()).size
    const real = adminDb.collection.bind(adminDb)
    vi.spyOn(adminDb, 'collection').mockImplementation(((name: string) => {
      if (name === 'configurationAudit') throw new Error('injected audit failure')
      return real(name)
    }) as typeof adminDb.collection)
    const cur = (await svc.getSection('licensing')).commercial
    await expect(svc.updateSection('licensing', { commercial: { ...cur, gstRatePercent: 16 } }, { updatedBy: uid.superAdmin, reason: 'should fail' })).rejects.toThrow(/injected audit failure/)
    vi.restoreAllMocks()
    const after = await adminDb.doc(CFG_DOC).get()
    expect((after.get('_meta.version') as number | undefined) ?? 0).toBe(beforeVersion)
    expect(after.get('licensing.commercial.gstRatePercent')).not.toBe(16)
    expect((await adminDb.collection(`${CFG_DOC}/history`).where('reason', '==', 'should fail').get()).size).toBe(histCountBefore)
    expect((await adminDb.collection('configurationAudit').where('reason', '==', 'should fail').get()).size).toBe(0)
  }, T)

  it('AUD · per-event override: change + history + platform audit are atomic, and a retry adds nothing', async () => {
    await seedLive()
    const { POST } = await import('@/app/api/admin/events/[slug]/commercial/route')
    const ctx = () => ({ params: Promise.resolve({ slug: SLUG }) })
    const body = { terms: { activationRatePaise: 130 }, reason: 'retry check' }
    expect((await POST(req('POST', 'superAdmin', body), ctx())).status).toBe(200)
    const retry = await json(await POST(req('POST', 'superAdmin', body), ctx()))
    expect(retry.body.unchanged).toBe(true)
    const hist  = (await adminDb.collection('licenseHistory').where('eventId', '==', SLUG).get()).docs
    const audit = (await adminDb.collection('adminAuditLogs').where('entityId', '==', SLUG).get()).docs
    expect(hist).toHaveLength(1); expect(audit).toHaveLength(1)
    expect(audit[0].id).toBe(`commercial_${hist[0].id}`)
    // Injected failure: NOTHING lands — not the override, not a history row, not an audit row.
    // RD-PHASE4-S3 — the write is now ONE TRANSACTION (fresh read + change + both audit rows), so the
    // failure is injected into the transaction's audit write rather than a batch commit.
    const { Transaction } = await import('firebase-admin/firestore')
    const realSet = Transaction.prototype.set
    vi.spyOn(Transaction.prototype, 'set').mockImplementation(function (this: unknown, ...args: unknown[]) {
      if ((args[0] as { path?: string })?.path?.startsWith('adminAuditLogs/')) throw new Error('injected audit failure')
      return (realSet as (...x: unknown[]) => unknown).apply(this, args) as never
    })
    await expect(POST(req('POST', 'superAdmin', { terms: { activationRatePaise: 140 }, reason: 'fails' }), ctx())).rejects.toThrow(/injected audit failure/)
    vi.restoreAllMocks()
    expect((await adminDb.doc(`events/${SLUG}`).get()).get('commercial')).toEqual({ activationRatePaise: 130 })
    expect((await adminDb.collection('licenseHistory').where('eventId', '==', SLUG).get()).docs).toHaveLength(1)
  }, T)

  it('AUD · licence actions: history + platform audit commit together; a failed audit fails the action', async () => {
    await seedLive()
    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    await applyLicenseAction(SLUG, { action: 'addNote', note: 'first' } as never, uid.admin)
    const hist  = (await adminDb.collection('licenseHistory').where('eventId', '==', SLUG).get()).docs
    const audit = (await adminDb.collection('adminAuditLogs').where('entityId', '==', SLUG).get()).docs
    expect(hist).toHaveLength(1); expect(audit).toHaveLength(1)
    expect(audit[0].id).toBe(`license_${hist[0].id}`)
    expect(audit[0].data()).toMatchObject({ adminUid: uid.admin, entityType: 'license', metadata: { note: 'first', licenseHistoryId: hist[0].id } })

    // RD-PHASE4-S4 · F8 — the audit rows are now staged in the action's TRANSACTION (not a batch):
    // fail the audit-row create inside it and nothing may commit.
    const { Transaction } = await import('firebase-admin/firestore')
    const realCreate = Transaction.prototype.create
    vi.spyOn(Transaction.prototype, 'create').mockImplementation(function (this: InstanceType<typeof Transaction>, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
      if (ref.path.startsWith('adminAuditLogs/')) throw new Error('injected audit failure')
      return realCreate.call(this, ref, data)
    } as never)
    await expect(applyLicenseAction(SLUG, { action: 'addNote', note: 'second' } as never, uid.admin)).rejects.toThrow(/injected audit failure/)
    vi.restoreAllMocks()
    expect((await adminDb.collection('licenseHistory').where('eventId', '==', SLUG).get()).docs).toHaveLength(1)
    expect((await adminDb.collection('adminAuditLogs').where('entityId', '==', SLUG).get()).docs).toHaveLength(1)
  }, T)
})
