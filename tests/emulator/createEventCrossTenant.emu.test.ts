// RD-CE-FIX C1 — Organizer A must never reach Organizer B's live event, against REAL Firestore.
//
// ═══ THE DEFECT ═══════════════════════════════════════════════════════════════
// Drafts are written by the browser, so `eventDetails.seo.urlSlug` is attacker-controlled. The
// Create Event audit PROVED that organizer A, pointing their own draft at B's slug, could create a
// 100%-off coupon on B's event and close B's registrations. ~25 server sites turned the draft pointer
// into events/{slug} reads, writes and `eventSlug` queries with no owner check.
//
// The fix: every such site resolves the slug through lib/events/liveEventRef
// (`resolveOwnedEventSlug(s)` / `liveEventBelongsTo`), which only accepts a live document stamped
// with THIS workspace's uid and THIS draft's id. These cases drive the real route handlers; only the
// token check is replaced (the caller uid), so workspace resolution, team permissions and every
// Firestore read/write are real.

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid

const A = `xt-a-${P}`, B = `xt-b-${P}`, MGR = `xt-mgr-${P}`, GATE = `xt-gate-${P}`
const B_DRAFT = `xt-bdraft-${P}`, B_SLUG = `xt-bslug-${P}`
const A_DRAFT = `xt-adraft-${P}`, A_SLUG = `xt-aslug-${P}`
const FORGED  = `xt-forged-${P}`          // A's draft whose pointer names B's slug
const FORGED_ARCH = `xt-forged-arch-${P}` // archived variant (event DELETE path)

const h = vi.hoisted(() => ({ caller: '' }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_xt', RAZORPAY_KEY_SECRET: 'xt',
  razorpay: {
    orders:   { create: async () => { throw new Error('no orders') }, fetchPayments: async () => ({ items: [] }) },
    payments: { fetch: async () => { throw new Error('no payment') }, refund: async () => { throw new Error('no refunds') } },
  },
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.caller ? { uid: h.caller, email: `${h.caller}@rd.test` } : null),
}))

const as = (uid: string) => { h.caller = uid }
const req = (method: string, body?: unknown, url = 'http://x/api/t') => new NextRequest(url, {
  method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> })

describeEmu('RD-CE-FIX C1 · cross-organizer live event isolation', () => {
  let db: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  const couponIds: string[] = []
  let waitId = ''

  const liveB = async () => (await db.doc(`events/${B_SLUG}`).get()).data() ?? null
  const bCoupons = async () => (await db.collection(`events/${B_SLUG}/coupons`).get()).size

  beforeAll(async () => {
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
    const now = Timestamp.now()
    const profile = (uid: string, owner: boolean) => db.doc(`users/${uid}`).set({ uid, role: 'organizer', accountStatus: 'active', email: `${uid}@rd.test`, workspaceOwner: owner })
    await Promise.all([profile(A, true), profile(B, true), profile(MGR, false), profile(GATE, false)])
    const member = (uid: string, role: string) => db.collection('teamMembers').add({ memberUid: uid, organizerUid: A, role, status: 'active', email: `${uid}@rd.test`, eventIds: [] })
    await Promise.all([member(MGR, 'manager'), member(GATE, 'checkin_staff')])

    const published = (slug: string) => ({
      status: 'published', lifecycleStatus: 'published', publishedAt: now,
      eventType: 'conference', eventSubtype: 'tech',
      eventDetails: { info: { name: 'Cross Tenant Probe Event' }, seo: { urlSlug: slug } },
      pricing: { eventType: 'paid', passes: [{ id: 'p1', name: 'General', price: 500, quantity: 100 }] },
    })
    // B — the victim: a live event with coupons, a waitlist entry, counters and edit history.
    await db.doc(`users/${B}/eventDrafts/${B_DRAFT}`).set(published(B_SLUG))
    await db.doc(`events/${B_SLUG}`).set({ slug: B_SLUG, uid: B, draftId: B_DRAFT, status: 'published', lifecycleStatus: 'published', publishedAt: now, pricing: { passes: [{ id: 'p1' }] } })
    couponIds.push((await db.collection(`events/${B_SLUG}/coupons`).add({ code: 'BSECRET', type: 'percentage', value: 10, active: true, currentUses: 0, applicablePassIds: [] })).id)
    waitId = (await db.collection('waitlists').add({ eventSlug: B_SLUG, organizerUid: B, status: 'waiting', attendee: { name: 'Victim Person', email: 'victim@rd.test', phone: '+911234567890' }, createdAt: now })).id
    await db.doc(`registrationCounters/${B_SLUG}`).set({ totalCount: 42, confirmedCount: 42 })
    await db.doc(`events/${B_SLUG}/editHistory/rec1`).set({ createdAt: now, before: {}, after: {} })

    // A — their own live event, plus two drafts that POINT AT B's slug.
    await db.doc(`users/${A}/eventDrafts/${A_DRAFT}`).set(published(A_SLUG))
    await db.doc(`events/${A_SLUG}`).set({ slug: A_SLUG, uid: A, draftId: A_DRAFT, status: 'published', lifecycleStatus: 'published', publishedAt: now, pricing: { passes: [{ id: 'p1' }] } })
    await db.doc(`users/${A}/eventDrafts/${FORGED}`).set(published(B_SLUG))
    await db.doc(`users/${A}/eventDrafts/${FORGED_ARCH}`).set({ ...published(B_SLUG), lifecycleStatus: 'archived', archivedAt: now, status: 'unpublished' })
  }, T)

  it('lifecycle: status / cancel / archive on a forged draft never touch B', async () => {
    as(A)
    const { POST: status }  = await import('@/app/api/organizer/events/[eventId]/status/route')
    const { POST: cancel }  = await import('@/app/api/organizer/events/[eventId]/cancel/route')
    const { POST: archive } = await import('@/app/api/organizer/events/[eventId]/archive/route')
    for (const action of ['close_registrations', 'unpublish', 'complete', 'cancel']) {
      const r = await json(await status(req('POST', { action }), ctx({ eventId: FORGED })))
      expect(r.status, action).not.toBe(200)
    }
    expect((await cancel(req('POST', { cancelReason: 'x' }), ctx({ eventId: FORGED }))).status).not.toBe(200)
    expect((await archive(req('POST', {}), ctx({ eventId: FORGED }))).status).not.toBe(200)
    expect((await liveB())?.lifecycleStatus).toBe('published')
  }, T)

  it('coupons: list / create / edit / delete on a forged draft are refused', async () => {
    as(A)
    const { GET, POST } = await import('@/app/api/organizer/events/[eventId]/coupons/route')
    const { PATCH, DELETE } = await import('@/app/api/organizer/events/[eventId]/coupons/[couponId]/route')
    const list = await json(await GET(req('GET'), ctx({ eventId: FORGED })))
    expect(JSON.stringify(list.body)).not.toContain('BSECRET')
    const created = await POST(req('POST', { code: 'XTENANT100', description: 'x', type: 'percentage', value: 100, active: true, applicablePassIds: [] }), ctx({ eventId: FORGED }))
    expect(created.status).toBe(409)
    expect((await PATCH(req('PATCH', { value: 100 }), ctx({ eventId: FORGED, couponId: couponIds[0] }))).status).toBe(404)
    expect((await DELETE(req('DELETE'), ctx({ eventId: FORGED, couponId: couponIds[0] }))).status).toBe(404)
    expect(await bCoupons()).toBe(1)
  }, T)

  it('waitlist: list / settings / promote / remove on a forged draft are refused', async () => {
    as(A)
    const { GET, PATCH } = await import('@/app/api/organizer/events/[eventId]/waitlist/route')
    const { POST: promote } = await import('@/app/api/organizer/events/[eventId]/waitlist/[waitlistId]/promote/route')
    const { POST: remove }  = await import('@/app/api/organizer/events/[eventId]/waitlist/[waitlistId]/remove/route')
    const list = await json(await GET(req('GET'), ctx({ eventId: FORGED })))
    expect(JSON.stringify(list.body)).not.toContain('victim@rd.test')
    await PATCH(req('PATCH', { enabled: false }), ctx({ eventId: FORGED }))
    expect((await promote(req('POST', {}), ctx({ eventId: FORGED, waitlistId: waitId }))).status).toBe(404)
    expect((await remove(req('POST', {}), ctx({ eventId: FORGED, waitlistId: waitId }))).status).toBe(404)
    const w = (await db.doc(`waitlists/${waitId}`).get()).data()
    expect(w?.status).toBe('waiting')
    expect(Object.keys((await liveB()) ?? {})).not.toContain('waitlist')
  }, T)

  it('edit history: read and rollback on a forged draft are refused', async () => {
    as(A)
    const { GET, POST } = await import('@/app/api/organizer/events/[eventId]/edit-history/route')
    const g = await json(await GET(req('GET'), ctx({ eventId: FORGED })))
    expect(JSON.stringify(g.body)).not.toContain('rec1')
    expect((await POST(req('POST', { recordId: 'rec1' }), ctx({ eventId: FORGED }))).status).toBe(400)
  }, T)

  it('event detail, setup signals, attendance and registrations never surface B\'s counters', async () => {
    as(A)
    const { GET: detail } = await import('@/app/api/organizer/events/[eventId]/route')
    const { GET: signals } = await import('@/app/api/organizer/events/[eventId]/setup-signals/route')
    const { GET: regs } = await import('@/app/api/organizer/events/[eventId]/registrations/route')
    for (const r of [await detail(req('GET'), ctx({ eventId: FORGED })), await signals(req('GET'), ctx({ eventId: FORGED })), await regs(req('GET'), ctx({ eventId: FORGED }))]) {
      const b = JSON.stringify(await r.json().catch(() => ({})))
      expect(b).not.toContain(B_SLUG)
      expect(b).not.toMatch(/"(totalRegistrations|totalCount|confirmed)":42\b/)
    }
  }, T)

  it('edit / save-changes / republish / resubmit on a forged draft never reach B', async () => {
    as(A)
    const { PATCH: edit } = await import('@/app/api/organizer/events/[eventId]/edit/route')
    const { POST: save }  = await import('@/app/api/organizer/events/[eventId]/save-changes/route')
    const { POST: repub } = await import('@/app/api/organizer/events/[eventId]/republish/route')
    expect((await edit(req('PATCH', { info: { name: 'HIJACKED' } }), ctx({ eventId: FORGED }))).status).not.toBe(200)
    expect((await save(req('POST', {}), ctx({ eventId: FORGED }))).status).not.toBe(200)
    expect((await repub(req('POST', {}), ctx({ eventId: FORGED }))).status).not.toBe(200)
    const live = await liveB()
    expect(JSON.stringify(live)).not.toContain('HIJACKED')
  }, T)

  it('permanent delete of a forged (archived) draft never deletes B\'s event or data', async () => {
    as(A)
    const { DELETE } = await import('@/app/api/organizer/events/[eventId]/route')
    expect((await DELETE(req('DELETE'), ctx({ eventId: FORGED_ARCH }))).status).toBe(409)
    expect(await liveB()).not.toBeNull()
    expect((await db.doc(`registrationCounters/${B_SLUG}`).get()).exists).toBe(true)
  }, T)

  it('draft delete with a COPIED draft id + B\'s slug never deletes B\'s live doc', async () => {
    // Draft ids are client-chosen: A creates a draft under their OWN path with B's draft id.
    await db.doc(`users/${A}/eventDrafts/${B_DRAFT}`).set({ status: 'draft', lifecycleStatus: 'draft', eventDetails: { seo: { urlSlug: B_SLUG } } })
    as(A)
    const { DELETE } = await import('@/app/api/organizer/drafts/[draftId]/route')
    await DELETE(req('DELETE'), ctx({ draftId: B_DRAFT }))
    expect(await liveB()).not.toBeNull()
  }, T)

  it('dashboard (scoped and workspace) never adds B\'s counters', async () => {
    as(A)
    const { GET } = await import('@/app/api/organizer/dashboard/route')
    for (const url of ['http://x/api/organizer/dashboard', `http://x/api/organizer/dashboard?eventId=${FORGED}`]) {
      const r = await GET(req('GET', undefined, url))
      const b = JSON.stringify(await r.json().catch(() => ({})))
      expect(b).not.toContain('BSECRET')
      expect(b).not.toContain(B_SLUG)
    }
  }, T)

  it('legitimate access still works: A on A, a manager on A, B on B; a check-in-only member is denied', async () => {
    const { POST: coupon } = await import('@/app/api/organizer/events/[eventId]/coupons/route')
    const { POST: status } = await import('@/app/api/organizer/events/[eventId]/status/route')
    as(A)
    expect((await coupon(req('POST', { code: 'AOWN10', description: 'x', type: 'percentage', value: 10, active: true, applicablePassIds: [] }), ctx({ eventId: A_DRAFT }))).status).toBe(201)
    as(MGR)
    expect((await coupon(req('POST', { code: 'AMGR10', description: 'x', type: 'percentage', value: 10, active: true, applicablePassIds: [] }), ctx({ eventId: A_DRAFT }))).status).toBe(201)
    as(GATE)
    expect((await coupon(req('POST', { code: 'AGATE10', description: 'x', type: 'percentage', value: 10, active: true, applicablePassIds: [] }), ctx({ eventId: A_DRAFT }))).status).toBe(403)
    as(B)
    const r = await json(await status(req('POST', { action: 'close_registrations' }), ctx({ eventId: B_DRAFT })))
    expect(r.status).toBe(200)
    expect((await liveB())?.lifecycleStatus).toBe('registration_closed')
    as(A)
    const own = await json(await status(req('POST', { action: 'close_registrations' }), ctx({ eventId: A_DRAFT })))
    expect(own.status).toBe(200)
  }, T)
})
