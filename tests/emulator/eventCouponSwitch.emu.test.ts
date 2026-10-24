// RD-COUPON-SWITCH-01 · the Super Admin per-event coupon switch, on REAL Firestore (private emulator):
// the shared validator every coupon path uses, the Super Admin route, and the organizer list route.
//
//   • event switch OFF ⇒ every code for that event is refused; ON again ⇒ accepted (config untouched)
//   • platform flag OFF ⇒ refused everywhere (it used to be enforced only by the preview route)
//   • the route: Super Admin only, reason required, idempotent, audited in the same transaction
//   • the organizer's coupon list reports the switch so the tab can say why codes do not apply
//   • the organizer cannot CREATE a coupon while the event switch is off (existing coupons kept)

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const SLUG = `ecs-ev-${P}`, OTHER = `ecs-other-${P}`, UID = `ecs-org-${P}`, SUPER = `ecs-super-${P}`

const h = vi.hoisted(() => ({ who: '', platformCoupons: true, superUid: '' }))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.who && h.who === h.superUid ? h.who : null),
  resolveSuperAdminUid: async () => (h.who && h.who === h.superUid ? h.who : null),
  legacyAdminClaimOnly: async () => false,
}))
vi.mock('@/lib/config/resolveFeatureFlags', async orig => {
  const real = await orig<typeof import('@/lib/config/resolveFeatureFlags')>()
  return { ...real, getFeatureFlags: async () => ({ ...(await real.getFeatureFlags()), coupons: h.platformCoupons }) }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['coupons', 'registrations'], isOwner: true }),
}))

describeEmu('RD-COUPON-SWITCH-01 · per-event coupon switch', () => {
  let db: import('firebase-admin/firestore').Firestore
  let validate: typeof import('@/lib/coupons/validate').validateCoupon
  let adminRoute: typeof import('@/app/api/admin/events/[slug]/coupons/route')
  let listGET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let createPOST: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>

  const call = async (method: 'GET' | 'POST', body?: unknown, slug = SLUG) => {
    const req = new NextRequest(`http://localhost/api/admin/events/${slug}/coupons`, {
      method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const res = await (method === 'GET' ? adminRoute.GET : adminRoute.POST)(req, { params: Promise.resolve({ slug }) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const create = async (code: string) => {
    const res = await createPOST(new NextRequest(`http://localhost/api/organizer/events/${SLUG}/coupons`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, description: 'Switch test code', type: 'percentage', value: 5, active: true, validFrom: null, validUntil: null, maxUses: null, applicablePassIds: [] }),
    }), { params: Promise.resolve({ eventId: SLUG }) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const couponCount = async () => (await db.collection(`events/${SLUG}/coupons`).get()).size
  const valid = async (slug = SLUG) => validate(slug, 'save10', 'p1', 1000)
  const audits = async (action: string) => (await db.collection('adminAuditLogs').where('entityId', '==', SLUG).where('action', '==', action).get()).size

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    h.superUid = SUPER
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ validateCoupon: validate } = await import('@/lib/coupons/validate'))
    adminRoute = await import('@/app/api/admin/events/[slug]/coupons/route')
    ;({ GET: listGET, POST: createPOST } = await import('@/app/api/organizer/events/[eventId]/coupons/route') as never)
    for (const s of [SLUG, OTHER]) {
      await db.doc(`events/${s}`).set({ slug: s, uid: UID, draftId: s, lifecycleStatus: 'published' })
      await db.doc(`events/${s}/coupons/c1`).set({ code: 'SAVE10', type: 'percentage', value: 10, active: true, currentUses: 0, maxUses: null, applicablePassIds: [], validFrom: null, validUntil: null, createdAt: new Date() })
    }
    await db.doc(`users/${UID}/eventDrafts/${SLUG}`).set({ eventDetails: { seo: { urlSlug: SLUG }, info: { name: 'ECS' } }, status: 'published', lifecycleStatus: 'published' })
  }, T)
  beforeEach(async () => { h.who = SUPER; h.platformCoupons = true })
  afterAll(async () => {
    for (const s of [SLUG, OTHER]) { await db.recursiveDelete(db.doc(`events/${s}`)).catch(() => null); await db.doc(`eventAdminControls/${s}`).delete().catch(() => null) }
    await db.doc(`users/${UID}/eventDrafts/${SLUG}`).delete().catch(() => null)
    for (const d of (await db.collection('adminAuditLogs').where('entityId', '==', SLUG).get()).docs) await d.ref.delete()
  }, T)

  it('a valid code is accepted while both switches are on', async () => {
    expect(await valid()).toMatchObject({ valid: true, discountPaise: 100 })
  })

  it('only a Super Admin may read or change the switch; a reason is required', async () => {
    h.who = UID
    expect((await call('GET')).status).toBe(403)
    expect((await call('POST', { enabled: false, reason: 'abuse reported' })).status).toBe(403)
    h.who = ''
    expect((await call('POST', { enabled: false, reason: 'abuse reported' })).status).toBe(403)
    h.who = SUPER
    expect((await call('POST', { enabled: false })).status).toBe(400)
    expect((await call('POST', { enabled: 'no', reason: 'abuse reported' })).status).toBe(400)
    expect((await call('POST', { enabled: false, reason: 'x' }, `ecs-missing-${P}`)).status).toBe(400)   // reason too short
    expect((await call('POST', { enabled: false, reason: 'abuse reported' }, `ecs-missing-${P}`)).status).toBe(404)
    expect(await valid()).toMatchObject({ valid: true })                    // nothing changed
  })

  it('switched OFF ⇒ this event refuses every code (other events unaffected); idempotent; audited once', async () => {
    const off = await call('POST', { enabled: false, reason: 'coupon abuse reported' })
    expect(off).toMatchObject({ status: 200, body: { couponsDisabled: true, changed: true, reason: 'coupon abuse reported' } })
    expect(await valid()).toEqual({ valid: false, error: 'Coupons are not available for this event.' })
    expect(await valid(OTHER)).toMatchObject({ valid: true })
    // the organizer's coupon configuration is untouched
    expect((await db.doc(`events/${SLUG}/coupons/c1`).get()).data()).toMatchObject({ active: true, code: 'SAVE10' })
    // repeated: no change, no second audit row
    expect((await call('POST', { enabled: false, reason: 'coupon abuse reported again' })).body).toMatchObject({ couponsDisabled: true, changed: false })
    expect(await audits('event.coupons_disabled')).toBe(1)
    // the organizer list says why codes will not apply
    const list = await listGET(new NextRequest(`http://localhost/api/organizer/events/${SLUG}/coupons`), { params: Promise.resolve({ eventId: SLUG }) })
    expect(await list.json()).toMatchObject({ couponsEnabled: true, couponsDisabledForEvent: true })
    // …and refuses a NEW coupon; nothing is written, the existing coupon is untouched
    const before = await couponCount()
    expect(await create('BLOCKED5')).toEqual({ status: 403, body: { error: 'Coupons are not available for this event.', code: 'COUPONS_DISABLED_FOR_EVENT' } })
    expect(await couponCount()).toBe(before)
    expect((await db.doc(`events/${SLUG}/coupons/c1`).get()).data()).toMatchObject({ active: true, code: 'SAVE10', currentUses: 0 })
  })

  it('switched back ON ⇒ codes work again, audited', async () => {
    expect((await call('POST', { enabled: true, reason: 'issue resolved' })).body).toMatchObject({ couponsDisabled: false, changed: true })
    expect(await valid()).toMatchObject({ valid: true, discountPaise: 100 })
    expect(await audits('event.coupons_enabled')).toBe(1)
    // coupon management works again: the organizer can create, and the new code applies
    expect(await create('AFTER5')).toMatchObject({ status: 201, body: { coupon: { code: 'AFTER5' } } })
    expect(await validate(SLUG, 'after5', 'p1', 1000)).toMatchObject({ valid: true, discountPaise: 50 })
  })

  it('the PLATFORM flag off refuses codes everywhere (no longer only in the preview route)', async () => {
    h.platformCoupons = false
    expect(await valid()).toEqual({ valid: false, error: 'Coupons are not available right now.' })
    expect(await valid(OTHER)).toEqual({ valid: false, error: 'Coupons are not available right now.' })
    expect((await call('GET')).body).toMatchObject({ platformCouponsEnabled: false })
  })
})
