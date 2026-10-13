// RD-PRINT-BILL-P3 — ID-badge purchase coupons on REAL Firestore + REAL Auth-emulator tokens,
// through the real Super Admin routes, the real licence-coupon service and the real redemption
// primitive. Nothing is mocked except the Razorpay client (imported transitively, never called).
//
//   A. authorization — Super Admin (ADMIN_UIDS) only; legacy admin:true and organizers refused
//   B. create / edit / clone / pause / resume / archive with reason + audit; free-coupon gate
//   C. ONE code namespace with licence coupons — both directions, clone, and a concurrent race
//   D. preview never consumes usage; licence checkout cannot see badge coupons
//   E. redemption: atomic, idempotent, concurrency-safe; exhaustion between validation and
//      activation refuses without ANY write (the caller's units are not applied either)
//   F. discount type/value immutable after redemption

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_p3', RAZORPAY_KEY_SECRET: 'p3',
  razorpay: { orders: { create: async () => { throw new Error('no orders') } }, payments: { fetch: async () => { throw new Error('no payments') } } },
}))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `bc${process.pid}`.toUpperCase()
const C = (s: string) => `${P}-${s}`                       // codes unique to this run
const PASSWORD = 'BadgeCouponsP3Passw0rd!'
const EMAIL = { superAdmin: `${P}-super@registerdesk.test`.toLowerCase(), admin: `${P}-admin@registerdesk.test`.toLowerCase(), organizer: `${P}-org@registerdesk.test`.toLowerCase() }
type Who = keyof typeof EMAIL
type Rec = Record<string, unknown>

describeEmu('RD-PRINT-BILL-P3 · badge coupons (real Auth, Firestore, routes)', () => {
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let businessConfig: typeof import('@/lib/config/businessConfigService').businessConfig
  let list: Record<'GET' | 'POST', (r: NextRequest) => Promise<Response>>
  let one: Record<'GET' | 'POST', (r: NextRequest, c: unknown) => Promise<Response>>
  const uid: Record<Who, string> = { superAdmin: '', admin: '', organizer: '' }
  const token: Record<Who, string> = { superAdmin: '', admin: '', organizer: '' }
  const savedAdminUids = process.env.ADMIN_UIDS
  let cfgBackup: Rec | null = null
  const madeCodes = new Set<string>(), madeLicence = new Set<string>()

  async function signIn(email: string): Promise<string> {
    const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    })
    const j = await r.json() as { idToken?: string }
    if (!j.idToken) throw new Error(`sign-in failed for ${email}`)
    return j.idToken
  }
  const req = (method: 'GET' | 'POST', who: Who | null, body?: unknown, url = 'http://x/api/admin/badge-coupons') => new NextRequest(url, {
    method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${token[who]}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const create = async (coupon: Rec, reason: unknown = 'Launch promo', who: Who = 'superAdmin') => {
    const res = await list.POST(req('POST', who, { reason, coupon }))
    const body = await res.json() as Rec
    if (res.status === 201) madeCodes.add(String((body.coupon as Rec).code))
    return { status: res.status, body }
  }
  const act = async (code: string, body: Rec, who: Who = 'superAdmin') => {
    const res = await one.POST(req('POST', who, body, `http://x/api/admin/badge-coupons/${code}`), { params: Promise.resolve({ code }) })
    const out = await res.json() as Rec
    if (res.status === 201 && (out.coupon as Rec | undefined)?.code) madeCodes.add(String((out.coupon as Rec).code))
    return { status: res.status, body: out }
  }
  const doc = async (code: string) => (await adminDb.doc(`badgeCoupons/${code}`).get()).data() as Rec | undefined
  const audits = async (code: string) => (await adminDb.collection('adminAuditLogs').where('entityId', '==', code).get()).docs.map(d => d.data() as Rec)
  const setAllowFree = async (on: boolean) => {
    await adminDb.doc('system/businessConfiguration').set({ licensing: { printBadgeBilling: { paidGenerationEnabled: false, allowFreeCoupons: on } } }, { merge: true })
    businessConfig.invalidateCache()
  }
  const PCT = { type: 'percentage', value: 20, enabled: true }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const admin = await import('@/lib/firebase/admin')
    adminDb = admin.adminDb; adminAuth = admin.adminAuth
    businessConfig = (await import('@/lib/config/businessConfigService')).businessConfig
    for (const k of Object.keys(EMAIL) as Who[]) {
      const u = await adminAuth.getUserByEmail(EMAIL[k]).catch(() => null) ?? await adminAuth.createUser({ email: EMAIL[k], password: PASSWORD, emailVerified: true })
      uid[k] = u.uid
      await adminAuth.setCustomUserClaims(u.uid, k === 'organizer' ? null : { admin: true })
    }
    process.env.ADMIN_UIDS = uid.superAdmin
    for (const k of Object.keys(EMAIL) as Who[]) token[k] = await signIn(EMAIL[k])
    const snap = await adminDb.doc('system/businessConfiguration').get()
    cfgBackup = snap.exists ? snap.data() as Rec : null
    await setAllowFree(false)
    list = await import('@/app/api/admin/badge-coupons/route') as never
    one = await import('@/app/api/admin/badge-coupons/[code]/route') as never
  }, T)

  afterAll(async () => {
    if (savedAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedAdminUids
    if (cfgBackup) await adminDb.doc('system/businessConfiguration').set(cfgBackup); else await adminDb.doc('system/businessConfiguration').delete().catch(() => null)
    businessConfig?.invalidateCache()
    for (const c of madeCodes) {
      await adminDb.recursiveDelete(adminDb.doc(`badgeCoupons/${c}`)).catch(() => null)
      for (const d of (await adminDb.collection('adminAuditLogs').where('entityId', '==', c).get()).docs) await d.ref.delete()
    }
    for (const c of madeLicence) {
      await adminDb.doc(`licenseCoupons/${c}`).delete().catch(() => null)
      for (const d of (await adminDb.collection('adminAuditLogs').where('entityId', '==', c).get()).docs) await d.ref.delete()
    }
    for (const d of (await adminDb.collection('qaUnits').where('p', '==', P).get()).docs) await d.ref.delete()
    for (const k of Object.keys(EMAIL) as Who[]) await adminAuth.deleteUser(uid[k]).catch(() => null)
  }, T)

  // ── A ────────────────────────────────────────────────────────────────────────────────────────
  it('A · Super Admin only — legacy admin:true and organizers are refused everywhere; nothing written', async () => {
    for (const who of [null, 'organizer', 'admin'] as const) {
      const g = await list.GET(req('GET', who))
      expect(g.status, String(who)).toBe(403)
      const c = await create({ code: C('AUTH'), ...PCT }, 'Probe reason', (who ?? 'organizer') as Who)
      expect(c.status).toBe(403)
      if (who === 'admin') expect(c.body.code).toBe('SUPER_ADMIN_REQUIRED')
      expect((await act(C('AUTH'), { action: 'pause', reason: 'Probe reason' }, (who ?? 'organizer') as Who)).status).toBe(403)
      expect((await act(C('AUTH'), { action: 'preview', organizerUid: 'x', eventId: 'y', purchasePaise: 100 }, (who ?? 'organizer') as Who)).status).toBe(403)
    }
    expect(await doc(C('AUTH'))).toBeUndefined()
    const ok = await list.GET(req('GET', 'superAdmin'))
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as Rec).policy).toEqual({ allowFreeCoupons: false })
  }, T)

  // ── B ────────────────────────────────────────────────────────────────────────────────────────
  it('B1 · create: normalized code, reason 3–500, strict input, one audit row', async () => {
    expect((await create({ code: C('R'), ...PCT }, 'ab')).body.code).toBe('REASON_TOO_SHORT')
    expect((await create({ code: C('R'), ...PCT }, 'x'.repeat(501))).body.code).toBe('REASON_TOO_LONG')
    expect((await create({ code: C('BAD'), type: 'percentage', value: 150 })).status).toBe(400)
    expect((await create({ code: C('BAD'), ...PCT, currentUses: 99 })).body.code).toBe('UNKNOWN_FIELD')
    expect((await create({ code: 'x y', ...PCT })).body.code).toBe('INVALID_CODE')
    expect(await doc(C('BAD'))).toBeUndefined()
    const made = await create({ code: `  ${C('main').toLowerCase()} `, ...PCT, maxDiscountPaise: 500, usageLimit: 10, perOrganizerLimit: 2 }, 'Spring promo for badges')
    expect(made.status).toBe(201)
    const d = await doc(C('MAIN'))
    expect(d).toMatchObject({ code: C('MAIN'), scope: 'print_badges', type: 'percentage', value: 20, maxDiscountPaise: 500, currentUses: 0, version: 1, enabled: true })
    const [a] = await audits(C('MAIN'))
    expect(a).toMatchObject({ adminUid: uid.superAdmin, action: 'badge_coupon.created', entityType: 'badge_coupon', reason: 'Spring promo for badges' })
    expect((await create({ code: C('MAIN'), ...PCT })).status).toBe(409)
  }, T)

  it('B2 · free coupons only while the global switch allows them', async () => {
    expect((await create({ code: C('FREE'), type: 'free', value: 0, enabled: true })).status).toBe(400)
    expect((await create({ code: C('HUNDRED'), type: 'percentage', value: 100, enabled: true })).status).toBe(400)
    expect((await create({ code: C('CAPPED100'), type: 'percentage', value: 100, maxDiscountPaise: 300, enabled: true })).status).toBe(201)   // not free-shaped
    await setAllowFree(true)
    expect((await create({ code: C('FREE'), type: 'free', value: 0, enabled: true }, 'Complimentary partner coupon')).status).toBe(201)
    const [a] = await audits(C('FREE'))
    expect((a.metadata as Rec).freeShape).toBe(true)
    await setAllowFree(false)
    // With free coupons switched off again, an existing free coupon is refused at validation (preview).
    const p = await act(C('FREE'), { action: 'preview', organizerUid: uid.organizer, eventId: 'any-event', purchasePaise: 2000 })
    expect(p.body.preview).toMatchObject({ ok: false, failure: 'free_not_allowed' })
  }, T)

  it('B3 · edit (audited, versioned), no-op writes nothing, pause/resume/archive, clone', async () => {
    const before = (await audits(C('MAIN'))).length
    const e = await act(C('MAIN'), { action: 'update', reason: 'Extend to more organizers', coupon: { perOrganizerLimit: 3, description: 'Spring' } })
    expect(e.status).toBe(200)
    expect(await doc(C('MAIN'))).toMatchObject({ perOrganizerLimit: 3, description: 'Spring', version: 2 })
    const upd = (await audits(C('MAIN'))).find(x => x.action === 'badge_coupon.updated')!
    expect(upd).toMatchObject({ changedFields: expect.arrayContaining(['perOrganizerLimit', 'description']) })
    const noop = await act(C('MAIN'), { action: 'update', reason: 'Same values again', coupon: { perOrganizerLimit: 3 } })
    expect(noop.status).toBe(200)
    expect((await audits(C('MAIN'))).length).toBe(before + 1)
    expect((await act(C('MAIN'), { action: 'update', reason: 'Change code', coupon: { code: C('OTHER') } })).body.code).toBe('CODE_IMMUTABLE')
    expect((await act(C('MAIN'), { action: 'pause', reason: 'Paused for review' })).status).toBe(200)
    expect((await doc(C('MAIN')))!.paused).toBe(true)
    expect((await act(C('MAIN'), { action: 'resume', reason: 'Review complete' })).status).toBe(200)
    // Clone: a fresh DRAFT, no usage.
    const cl = await act(C('MAIN'), { action: 'clone', newCode: C('CLONE'), reason: 'Copy for autumn' })
    expect(cl.status).toBe(201)
    expect(await doc(C('CLONE'))).toMatchObject({ enabled: false, currentUses: 0, version: 1, type: 'percentage', value: 20 })
    // Archive: kept, never resumable or editable.
    expect((await act(C('CLONE'), { action: 'archive', reason: 'Not needed' })).status).toBe(200)
    expect(await doc(C('CLONE'))).toMatchObject({ archived: true, paused: true })
    expect((await act(C('CLONE'), { action: 'resume', reason: 'Try resume' })).body.code).toBe('ARCHIVED')
    expect((await act(C('CLONE'), { action: 'update', reason: 'Try edit', coupon: { description: 'x' } })).body.code).toBe('ARCHIVED')
    const acts = (await audits(C('CLONE'))).map(x => x.action).sort()
    expect(acts).toEqual(['badge_coupon.archived', 'badge_coupon.cloned'])
  }, T)

  // ── C ────────────────────────────────────────────────────────────────────────────────────────
  it('C · one code namespace with licence coupons — both directions, clone, and a concurrent race', async () => {
    const { createCoupon, cloneCoupon } = await import('@/lib/admin/licenseCouponService')
    // licence first → badge refused
    await createCoupon({ code: C('SHARED'), type: 'percentage', value: 10 }, uid.superAdmin, 'Licence promo'); madeLicence.add(C('SHARED'))
    const b = await create({ code: C('SHARED'), ...PCT })
    expect([b.status, b.body.code]).toEqual([409, 'CODE_TAKEN'])
    // badge first → licence refused (create AND clone)
    await expect(createCoupon({ code: C('MAIN'), type: 'percentage', value: 10 }, uid.superAdmin, 'Licence promo')).rejects.toThrow(/ID badge coupon/)
    await expect(cloneCoupon(C('SHARED'), C('MAIN'), uid.superAdmin, 'Licence clone')).rejects.toThrow(/ID badge coupon/)
    // badge clone into a licence code → refused
    expect((await act(C('MAIN'), { action: 'clone', newCode: C('SHARED'), reason: 'Clone collision' })).body.code).toBe('CODE_TAKEN')
    // Licence coupons behave exactly as before for their own codes.
    await createCoupon({ code: C('LICONLY'), type: 'fixed', value: 500 }, uid.superAdmin, 'Licence promo'); madeLicence.add(C('LICONLY'))
    expect((await adminDb.doc(`licenseCoupons/${C('LICONLY')}`).get()).data()).toMatchObject({ type: 'fixed', value: 500, currentUses: 0 })
    // Race: the same code created on both sides at once — exactly one wins.
    for (let i = 0; i < 3; i++) {
      const code = C(`RACE${i}`)
      const [lic, bad] = await Promise.allSettled([
        createCoupon({ code, type: 'percentage', value: 5 }, uid.superAdmin, 'Race licence'),
        create({ code, ...PCT }, 'Race badge'),
      ])
      madeLicence.add(code)
      const licOk = lic.status === 'fulfilled'
      const badOk = bad.status === 'fulfilled' && bad.value.status === 201
      expect(licOk !== badOk, `race ${i}: exactly one side created the code`).toBe(true)
      const both = [(await adminDb.doc(`licenseCoupons/${code}`).get()).exists, (await adminDb.doc(`badgeCoupons/${code}`).get()).exists]
      expect(both.filter(Boolean)).toHaveLength(1)
    }
  }, T)

  // ── D ────────────────────────────────────────────────────────────────────────────────────────
  it('D · preview never consumes usage; licence checkout cannot see a badge coupon (and vice versa)', async () => {
    const before = await doc(C('MAIN'))
    for (let i = 0; i < 3; i++) {
      const p = await act(C('MAIN'), { action: 'preview', organizerUid: uid.organizer, eventId: 'any-event', purchasePaise: 2000 })
      expect(p.body.preview).toMatchObject({ ok: true, discountPaise: 400, finalPricePaise: 1600 })
    }
    const after = await doc(C('MAIN'))
    expect(after!.currentUses).toBe(before!.currentUses)
    expect((await adminDb.collection(`badgeCoupons/${C('MAIN')}/redemptions`).get()).size).toBe(0)
    expect((await adminDb.doc(`badgeCoupons/${C('MAIN')}/organizerRedemptions/${uid.organizer}`).get()).exists).toBe(false)
    // Licence checkout's lookup never finds a badge code; the badge preview never finds a licence code.
    const { getLicenseCoupon, validateLicenseCoupon } = await import('@/lib/licensing/coupons')
    expect(await getLicenseCoupon(C('MAIN'))).toBeNull()
    expect(validateLicenseCoupon(null, { tier: 'free', eventType: null, pricePaise: 10000, organizerRedemptions: 0, couponsEnabled: true, maxPercentageDiscount: 100, maxFixedDiscountPaise: 0, allowFreeLicense: false } as never, Date.now()))
      .toMatchObject({ ok: false, failure: 'not_found' })
    const lp = await act(C('LICONLY'), { action: 'preview', organizerUid: uid.organizer, eventId: 'any-event', purchasePaise: 2000 })
    expect(lp.body.preview).toMatchObject({ ok: false, failure: 'not_found' })
  }, T)

  // ── E ────────────────────────────────────────────────────────────────────────────────────────
  const redeem = async (code: string, orderId: string, organizerUid: string, opts: { purchasePaise?: number; allowFree?: boolean; marker?: boolean } = {}) => {
    const { txnReadBadgeCouponRedemption, txnRedeemBadgeCoupon } = await import('@/lib/licensing/badgeCoupons/redeem')
    // Simulates the future activation: the caller's own write (units) happens only if redemption succeeded.
    return adminDb.runTransaction(async tx => {
      const read = await txnReadBadgeCouponRedemption(tx, code, organizerUid, orderId)
      const r = txnRedeemBadgeCoupon(tx, read, {
        orderId, organizerUid, eventId: 'any-event', purchasePaise: opts.purchasePaise ?? 2000,
        eventCouponsAllowed: true, allowFreeCoupons: opts.allowFree ?? false, nowMs: Date.now(),
      })
      if (r.ok && opts.marker) tx.set(adminDb.collection('qaUnits').doc(orderId), { p: P, units: 100 })
      return r
    })
  }

  it('E1 · redemption writes counter + record atomically; a replay of the same order never double-counts', async () => {
    const code = C('RED')
    expect((await create({ code, ...PCT, usageLimit: 5 }, 'Redemption test')).status).toBe(201)
    const r1 = await redeem(code, `${P}-o1`, uid.organizer)
    expect(r1).toMatchObject({ ok: true, already: false, discountPaise: 400, finalPricePaise: 1600 })
    const r2 = await redeem(code, `${P}-o1`, uid.organizer)
    expect(r2).toMatchObject({ ok: true, already: true, discountPaise: 400 })
    expect((await doc(code))!.currentUses).toBe(1)
    expect(((await adminDb.doc(`badgeCoupons/${code}/organizerRedemptions/${uid.organizer}`).get()).data() as Rec).count).toBe(1)
    expect((await adminDb.doc(`badgeCoupons/${code}/redemptions/${P}-o1`).get()).data()).toMatchObject({
      orderId: `${P}-o1`, organizerUid: uid.organizer, discountPaise: 400, finalPricePaise: 1600, snapshot: { code, type: 'percentage', value: 20, version: 1 },
    })
  }, T)

  it('E2 · concurrency: never exceeds the total limit nor the per-organizer limit', async () => {
    const code = C('CONC')
    expect((await create({ code, ...PCT, usageLimit: 3 }, 'Concurrency test')).status).toBe(201)
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => redeem(code, `${P}-c${i}`, `org-${i}`).catch(e => ({ ok: false, failure: String(e) }))))
    expect(results.filter(r => r.ok)).toHaveLength(3)
    // Every refusal is the LIMIT (not a transaction error that merely happened to stop at 3).
    expect(results.filter(r => !r.ok).map(r => (r as { failure: string }).failure)).toEqual(Array(5).fill('usage_limit_reached'))
    expect((await doc(code))!.currentUses).toBe(3)
    expect((await adminDb.collection(`badgeCoupons/${code}/redemptions`).get()).size).toBe(3)
    const per = C('PERORG')
    expect((await create({ code: per, ...PCT, perOrganizerLimit: 2 }, 'Per-organizer test')).status).toBe(201)
    const same = await Promise.all(Array.from({ length: 5 }, (_, i) => redeem(per, `${P}-p${i}`, uid.organizer).catch(e => ({ ok: false, failure: String(e) }))))
    expect(same.filter(r => r.ok)).toHaveLength(2)
    expect(same.filter(r => !r.ok).map(r => (r as { failure: string }).failure)).toEqual(Array(3).fill('per_organizer_limit_reached'))
    expect(((await adminDb.doc(`badgeCoupons/${per}/organizerRedemptions/${uid.organizer}`).get()).data() as Rec).count).toBe(2)
  }, T)

  it('E3 · exhausted between validation and activation → refused with NO writes (no units applied either)', async () => {
    const code = C('EXH')
    expect((await create({ code, ...PCT, usageLimit: 1 }, 'Exhaustion test')).status).toBe(201)
    const preview = await act(code, { action: 'preview', organizerUid: uid.organizer, eventId: 'any-event', purchasePaise: 2000 })
    expect(preview.body.preview).toMatchObject({ ok: true })
    // Someone else redeems the last use in between.
    expect(await redeem(code, `${P}-x1`, 'org-other', { marker: true })).toMatchObject({ ok: true })
    const late = await redeem(code, `${P}-x2`, uid.organizer, { marker: true })
    expect(late).toMatchObject({ ok: false, failure: 'usage_limit_reached' })
    expect((await doc(code))!.currentUses).toBe(1)
    expect((await adminDb.doc(`badgeCoupons/${code}/redemptions/${P}-x2`).get()).exists).toBe(false)
    expect((await adminDb.doc(`badgeCoupons/${code}/organizerRedemptions/${uid.organizer}`).get()).exists).toBe(false)
    expect((await adminDb.doc(`qaUnits/${P}-x2`).get()).exists).toBe(false)          // the caller's activation did not happen
    expect((await adminDb.doc(`qaUnits/${P}-x1`).get()).exists).toBe(true)
  }, T)

  it('E4 · a 100% / free coupon redeems only while free coupons are allowed (no payment is implemented)', async () => {
    const code = C('FREE')                                                                    // created in B2
    expect(await redeem(code, `${P}-f1`, uid.organizer, { allowFree: false })).toMatchObject({ ok: false, failure: 'free_not_allowed' })
    expect(await redeem(code, `${P}-f2`, uid.organizer, { allowFree: true })).toMatchObject({ ok: true, discountPaise: 2000, finalPricePaise: 0 })
    expect((await doc(code))!.currentUses).toBe(1)
  }, T)

  // ── F ────────────────────────────────────────────────────────────────────────────────────────
  it('F · after a redemption the discount type/value are frozen; other fields stay editable', async () => {
    const code = C('RED')                                                                     // redeemed once in E1
    const v = await act(code, { action: 'update', reason: 'Raise the discount', coupon: { value: 30 } })
    expect([v.status, v.body.code]).toEqual([409, 'DISCOUNT_IMMUTABLE'])
    const t = await act(code, { action: 'update', reason: 'Switch to fixed', coupon: { type: 'fixed', value: 100 } })
    expect(t.body.code).toBe('DISCOUNT_IMMUTABLE')
    expect(await doc(code)).toMatchObject({ type: 'percentage', value: 20 })
    const ok = await act(code, { action: 'update', reason: 'Extend the expiry', coupon: { expiresAt: '2030-01-01T00:00:00.000Z' } })
    expect(ok.status).toBe(200)
    // An un-redeemed coupon's discount CAN still change.
    expect((await act(C('MAIN'), { action: 'update', reason: 'Adjust discount', coupon: { value: 25 } })).status).toBe(200)
  }, T)

  // ── G · RD-PRINT-BILL-P3.2 hardening ─────────────────────────────────────────────────────────
  it('G1 · dates: explicit-time-zone ISO accepted and stored as UTC; permissive formats refused (create and update)', async () => {
    const code = C('DATES')
    const ok = await create({ code, ...PCT, activatesAt: '2026-11-01T09:00:00+05:30', expiresAt: '2026-12-31T23:59:59-08:00' }, 'Date normalization')
    expect(ok.status).toBe(201)
    expect(await doc(code)).toMatchObject({ activatesAt: '2026-11-01T03:30:00.000Z', expiresAt: '2027-01-01T07:59:59.000Z' })
    for (const bad of ['2026-11-01', 'Nov 1 2026', '1', '2026-11-01T09:00:00', '', '2026-02-30T00:00:00Z']) {
      const r = await create({ code: C('BADDATE'), ...PCT, expiresAt: bad }, 'Date refusal')
      expect(r.status, bad).toBe(400)
      const u = await act(code, { action: 'update', reason: 'Date refusal', coupon: { expiresAt: bad } })
      expect(u.status, bad).toBe(400)
    }
    expect(await doc(C('BADDATE'))).toBeUndefined()
    const upd = await act(code, { action: 'update', reason: 'New expiry', coupon: { expiresAt: '2027-03-01T00:00:00+05:30' } })
    expect(upd.status).toBe(200)
    expect((await doc(code))!.expiresAt).toBe('2027-02-28T18:30:00.000Z')
    expect((await act(code, { action: 'update', reason: 'Clear the expiry', coupon: { expiresAt: null } })).status).toBe(200)
    expect((await doc(code))!.expiresAt).toBeNull()
  }, T)

  it('G2 · corrupt STORED dates or restrictions: listed as invalid, refused cleanly — never 500, never applied', async () => {
    for (const [suffix, corrupt] of [['CDATE', { expiresAt: 'garbage' }], ['CRESTR', { restrictions: { eventIds: 'ev-1' } }], ['CRESTR2', { restrictions: null }]] as const) {
      const code = C(suffix)
      expect((await create({ code, ...PCT }, 'Corruption fixture')).status).toBe(201)
      await adminDb.doc(`badgeCoupons/${code}`).update(corrupt as Rec)                    // as a console write would
      const p = await act(code, { action: 'preview', organizerUid: uid.organizer, eventId: 'any-event', purchasePaise: 2000 })
      expect(p.status, suffix).toBe(200)
      expect(p.body.preview, suffix).toMatchObject({ ok: false, failure: 'invalid_configuration' })
      const listed = ((await (await list.GET(req('GET', 'superAdmin'))).json()) as { coupons: Rec[] }).coupons.find(c => c.code === code)
      expect(listed?.lifecycle, suffix).toBe('invalid')
      const detail = await one.GET(req('GET', 'superAdmin', undefined, `http://x/api/admin/badge-coupons/${code}`), { params: Promise.resolve({ code }) })
      expect(detail.status, suffix).toBe(200)
    }
    // An edit that does not fix the corrupt restriction is refused with a clear message (not discarded).
    const fix = await act(C('CRESTR'), { action: 'update', reason: 'Try a description edit', coupon: { description: 'x' } })
    expect([fix.status, String(fix.body.error)]).toEqual([400, 'The event restriction must be a list of up to 200 valid event ids.'])
    const repaired = await act(C('CRESTR'), { action: 'update', reason: 'Repair the restriction', coupon: { eventIds: [], organizerUids: [] } })
    expect(repaired.status).toBe(200)
    expect((await act(C('CRESTR'), { action: 'preview', organizerUid: uid.organizer, eventId: 'any-event', purchasePaise: 2000 })).body.preview).toMatchObject({ ok: true })
  }, T)

  it('G3 · an unreadable organizer counter ⇒ usage_unverified, and NOTHING is written (no record, counter, uses or units)', async () => {
    const code = C('BADCOUNT')
    expect((await create({ code, ...PCT }, 'Counter fixture')).status).toBe(201)
    await adminDb.doc(`badgeCoupons/${code}/organizerRedemptions/${uid.organizer}`).set({ count: 'two' })
    const r = await redeem(code, `${P}-u1`, uid.organizer, { marker: true })
    expect(r).toMatchObject({ ok: false, failure: 'usage_unverified' })
    expect((await doc(code))!.currentUses).toBe(0)
    expect((await adminDb.doc(`badgeCoupons/${code}/redemptions/${P}-u1`).get()).exists).toBe(false)
    expect(((await adminDb.doc(`badgeCoupons/${code}/organizerRedemptions/${uid.organizer}`).get()).data() as Rec).count).toBe('two')
    expect((await adminDb.doc(`qaUnits/${P}-u1`).get()).exists).toBe(false)
    const p = await act(code, { action: 'preview', organizerUid: uid.organizer, eventId: 'any-event', purchasePaise: 2000 })
    expect(p.body.preview).toMatchObject({ ok: false, failure: 'usage_unverified' })
  }, T)

  it('G4 · an invalid route code is a 404 — never a 500, never a path error', async () => {
    for (const bad of ['bad/code', 'ab', 'has space', '%2F', 'a'.repeat(41), '../licenseCoupons/X']) {
      const g = await one.GET(req('GET', 'superAdmin', undefined, 'http://x/api/admin/badge-coupons/x'), { params: Promise.resolve({ code: bad }) })
      expect([g.status, ((await g.json()) as Rec).error], bad).toEqual([404, 'Coupon not found'])
      for (const body of [{ action: 'pause', reason: 'Probe reason' }, { action: 'preview', organizerUid: 'o', eventId: 'e', purchasePaise: 100 }]) {
        const pr = await one.POST(req('POST', 'superAdmin', body, 'http://x/api/admin/badge-coupons/x'), { params: Promise.resolve({ code: bad }) })
        expect(pr.status, `${bad} ${body.action}`).toBe(404)
      }
    }
  }, T)

  it('G5 · archiving an already-paused coupon audits changedFields = [archived] only', async () => {
    const code = C('PAUSEARCH')
    expect((await create({ code, ...PCT }, 'Audit fixture')).status).toBe(201)
    expect((await act(code, { action: 'pause', reason: 'Pause first' })).status).toBe(200)
    expect((await act(code, { action: 'archive', reason: 'Then archive' })).status).toBe(200)
    const rows = await audits(code)
    expect(rows.find(r => r.action === 'badge_coupon.paused')).toMatchObject({ changedFields: ['paused'] })
    expect(rows.find(r => r.action === 'badge_coupon.archived')).toMatchObject({ changedFields: ['archived'], before: { paused: true, archived: false }, after: { paused: true, archived: true } })
  }, T)

  it('G6 · the clone audit records the source and the clone’s resulting definition (no notes)', async () => {
    const src = C('SRC'), dst = C('DST')
    expect((await create({ code: src, ...PCT, maxDiscountPaise: 700, usageLimit: 9, internalNotes: 'secret-ish note', campaign: 'autumn' }, 'Clone source')).status).toBe(201)
    expect((await act(src, { action: 'clone', newCode: dst, reason: 'Clone for winter' })).status).toBe(201)
    const row = (await audits(dst)).find(r => r.action === 'badge_coupon.cloned')!
    expect(row).toMatchObject({
      before: { source: src, sourceVersion: 1 },
      after: { code: dst, type: 'percentage', value: 20, maxDiscountPaise: 700, usageLimit: 9, campaign: 'autumn', enabled: false, currentUses: 0, version: 1 },
    })
    expect(JSON.stringify(row)).not.toContain('secret-ish note')
  }, T)

})
