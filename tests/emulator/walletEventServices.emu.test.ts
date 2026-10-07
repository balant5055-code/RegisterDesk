// Event-wise Wallet (2026-10-02) on REAL Firestore (private emulator), through the REAL routes:
// capacity refunds (approval lowers the enforced capacity), photo refunds measured from the base
// limit recorded on the purchase line, per-line valuation across orders at different prices,
// "refund all", and purchase notifications sent exactly once + the Super Admin feed.
// Identity is stubbed at the token boundary only; the email engine is stubbed to COUNT sends
// (nothing leaves the machine); the Razorpay client throws if touched.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `wevs${process.pid}`

const h = vi.hoisted(() => ({ who: '', superUid: '', plainUid: '', sends: [] as Array<{ type: string; to: string }> }))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.who && h.who === h.superUid ? h.who : null),
  legacyAdminClaimOnly: async () => !!h.who && h.who === h.plainUid,
  resolveSuperAdminUid: async () => (h.who && h.who === h.superUid ? h.superUid : null),
}))
vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      isAvailable: () => true,
      send: async (type: string, payload: { to: string }) => { h.sends.push({ type, to: payload.to }); return { success: true } },
    },
  }
})
vi.mock('@/lib/razorpay/client', () => new Proxy({}, {
  get(_t, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined
    throw new Error(`payment provider touched: ${String(key)}`)
  },
}))

type Body = Record<string, unknown>

describeEmu('Event-wise Wallet · capacity, photos, valuation, refund-all, notifications (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  const cleanup: string[] = []
  const ledgers: string[] = []
  // RD-CE-FIX M2 — production shape: publish and every lifecycle transition mirror the lifecycle and
  // closure stamps onto the SERVER-written live event, and the Wallet now reads them THERE (the draft
  // is client-written). So a seeded non-draft event also gets its live document, as publish makes it.
  const LIFE_KEYS = ['lifecycleStatus', 'completedAt', 'cancelledAt', 'archivedAt', 'restoredAt']
  const mirrorLive = async (path: string, data: Record<string, unknown>) => {
    const m = /^users\/([^/]+)\/eventDrafts\/([^/]+)$/.exec(path)
    if (!m || typeof data.lifecycleStatus !== 'string' || data.lifecycleStatus === 'draft') return
    const seo = ((data.eventDetails as Record<string, unknown> | undefined)?.seo as Record<string, unknown> | undefined) ?? {}
    const slug = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : m[2]
    if (slug === m[2] && !seo.urlSlug) await adminDb.doc(path).set({ eventDetails: { seo: { urlSlug: slug } } }, { merge: true })
    await adminDb.doc(`events/${slug}`).set({ uid: m[1], draftId: m[2], ...Object.fromEntries(LIFE_KEYS.filter(k => k in data).map(k => [k, data[k]])) }, { merge: true })
    cleanup.push(`events/${slug}`)
  }
  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); cleanup.push(path); await mirrorLive(path, data) }
  // 2026-10-06 — the refund window is 24 HOURS from closure: closures here are hours old.
  const closedAgo = (hours: number) => FS.Timestamp.fromMillis(Date.now() - hours * 3_600_000)
  const ts = (n: number) => FS.Timestamp.fromMillis(Date.UTC(2026, 8, 1) + n * 60_000)

  const U = `${P}_org`, SUPER = `${P}_super`, PLAIN = `${P}_plain`
  const [CAP, CAPC, PH, PHOLD, VAL, ALL, DST] = ['CAP', 'CAPC', 'PH', 'PHOLD', 'VAL', 'ALL', 'DST'].map(x => `${P}_${x}`)
  const slugCap = `${P}-cap`, slugCapc = `${P}-capc`
  const draft = (name: string, lifecycleStatus: string, extra: Record<string, unknown> = {}) => ({
    eventDetails: { info: { name } }, status: 'published', lifecycleStatus, updatedAt: ts(1), ...extra,
  })
  const item = (service: string, quantity: number, totalPaise: number, extra: Record<string, unknown> = {}) => ({
    service, quantity, unitPricePaise: 1, basePaise: quantity, gstRatePercent: 18, gstPaise: totalPaise - quantity, totalPaise, onExhausted: 'block', ...extra,
  })
  const ledger = async (draftId: string, lines: Record<string, unknown>, usage: Record<string, number> = {}) => {
    await adminDb.doc(`eventServiceAllowances/${draftId}`).set({ draftId, organizerUid: U, ...lines })
    ledgers.push(draftId)
    for (const [service, quantity] of Object.entries(usage)) {
      await adminDb.doc(`eventServiceAllowances/${draftId}/usage/seed_${service}`).set({ service, quantity, source: 'seed', createdAt: ts(1) })
    }
  }
  const capSnap = (operation: string, capacity: number, previousCapacity: number | null, totalPaise: number) => ({
    operation, capacity, previousCapacity, freeCapacity: 100, activationRatePaise: 150, chargeableCapacity: capacity - (previousCapacity ?? 100),
    basePaise: Math.round(totalPaise / 1.18), gstRatePercent: 18, gstPaise: totalPaise - Math.round(totalPaise / 1.18), totalPaise, terms: {},
  })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    h.superUid = SUPER; h.plainUid = PLAIN
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    await put(`users/${U}`, { uid: U, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true, email: `${P}@example.test`, name: 'Org' })

    // CAP — a completed capacity-model event: 300 activated (200 paid) + increase to 500 (200 more), 150 sold.
    await put(`users/${U}/eventDrafts/${CAP}`, draft('Capacity Run', 'completed', { completedAt: closedAgo(3), eventDetails: { info: { name: 'Capacity Run' }, seo: { urlSlug: slugCap } } }))
    await put(`events/${slugCap}`, { uid: U, draftId: CAP, totalCapacity: 500, lifecycleStatus: 'completed', completedAt: closedAgo(3) })
    await put(`eventLicenses/${slugCap}`, { organizerUid: U, eventId: slugCap, commercialModel: 'capacity', capacity: 500, status: 'active' })
    await put(`registrationCounters/${slugCap}`, { totalCount: 150 })
    await put(`licenseOrders/lic_${CAP}`, { orderId: `lic_${CAP}`, eventId: CAP, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 35_400, commercialModel: 'capacity', capacityChange: capSnap('activation', 300, null, 35_400), createdAt: ts(1), paidAt: ts(1) })
    await put(`licenseOrders/cap_${slugCap}_1`, { orderId: `cap_${slugCap}_1`, eventId: slugCap, organizerUid: U, purpose: 'capacity_increase', status: 'paid', amountPaise: 35_400, capacityChange: capSnap('increase', 500, 300, 35_400), createdAt: ts(2), paidAt: ts(2) })

    // CAPC — capacity activation bought with a COUPON (₹54 off the activation fee): 200 paid units, collected ₹300.
    await put(`users/${U}/eventDrafts/${CAPC}`, draft('Coupon Capacity', 'completed', { completedAt: closedAgo(3), eventDetails: { info: { name: 'Coupon Capacity' }, seo: { urlSlug: slugCapc } } }))
    await put(`events/${slugCapc}`, { uid: U, draftId: CAPC, totalCapacity: 300, lifecycleStatus: 'completed', completedAt: closedAgo(3) })
    await put(`eventLicenses/${slugCapc}`, { organizerUid: U, eventId: slugCapc, commercialModel: 'capacity', capacity: 300, status: 'active' })
    await put(`registrationCounters/${slugCapc}`, { totalCount: 0 })
    await put(`licenseOrders/lic_${CAPC}`, { orderId: `lic_${CAPC}`, eventId: CAPC, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 30_000, couponCode: 'SAVE', discountPaise: 5_400, commercialModel: 'capacity', capacityChange: capSnap('activation', 300, null, 35_400), createdAt: ts(1), paidAt: ts(1) })

    // PH — photos (RD-PHOTO-01: no free base): 50 paid units, 20 photos stored ⇒ 20 used, 30 unused.
    await put(`users/${U}/eventDrafts/${PH}`, draft('Photo Walk', 'completed', { completedAt: closedAgo(3) }))
    await ledger(PH, { media: { purchased: 50, consumed: 0, onExhausted: 'block' } })
    await put(`licenseOrders/lic_${PH}`, { orderId: `lic_${PH}`, eventId: PH, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 11_800, serviceItems: [item('media', 50, 11_800, { baseCapAtPurchase: 100 })], createdAt: ts(1), paidAt: ts(1) })
    for (let i = 0; i < 20; i++) cleanup.push(`mediaAssets/${P}_m${i}`)
    const batch = adminDb.batch()
    for (let i = 0; i < 20; i++) batch.set(adminDb.doc(`mediaAssets/${P}_m${i}`), { organizerUid: U, eventId: PH, status: 'ready' })
    await batch.commit()
    // PHOLD — photos bought before the base limit was recorded.
    await put(`users/${U}/eventDrafts/${PHOLD}`, draft('Old Photos', 'completed', { completedAt: closedAgo(3) }))
    await ledger(PHOLD, { media: { purchased: 20, consumed: 0, onExhausted: 'block' } })
    await put(`licenseOrders/lic_${PHOLD}`, { orderId: `lic_${PHOLD}`, eventId: PHOLD, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 4_720, serviceItems: [item('media', 20, 4_720)], createdAt: ts(1), paidAt: ts(1) })

    // VAL — WhatsApp bought twice at different prices: 10 @ ₹1.18 then 10 @ ₹2.36; 15 used.
    await put(`users/${U}/eventDrafts/${VAL}`, draft('Two Prices', 'cancelled', { cancelledAt: closedAgo(4) }))
    await ledger(VAL, { whatsapp: { purchased: 20, consumed: 15, onExhausted: 'block' } }, { whatsapp: 15 })
    await put(`licenseOrders/lic_${VAL}`, { orderId: `lic_${VAL}`, eventId: VAL, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 1_180, serviceItems: [item('whatsapp', 10, 1_180)], createdAt: ts(1), paidAt: ts(1) })
    await put(`licenseOrders/add_${VAL}_1`, { orderId: `add_${VAL}_1`, eventId: VAL, organizerUid: U, purpose: 'addon', status: 'paid', amountPaise: 2_360, serviceItems: [item('whatsapp', 10, 2_360)], createdAt: ts(5), paidAt: ts(5) })

    // ALL — WhatsApp + certificates both unused, for "refund all".
    await put(`users/${U}/eventDrafts/${ALL}`, draft('Everything', 'archived', { archivedAt: closedAgo(3) }))
    await ledger(ALL, { whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' }, certificates: { purchased: 5, consumed: 0, onExhausted: 'block' } })
    await put(`licenseOrders/lic_${ALL}`, { orderId: `lic_${ALL}`, eventId: ALL, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 1_770, serviceItems: [item('whatsapp', 10, 1_180), item('certificates', 5, 590)], createdAt: ts(1), paidAt: ts(1) })

    await put(`users/${U}/eventDrafts/${DST}`, draft('Next Event', 'published'))
  }, T)

  afterAll(async () => {
    for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null)
    for (const id of ledgers) await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${id}`)).catch(() => null)
    for (const c of ['walletServiceRequests', 'walletServiceRequestsLocks']) {
      const qs = await adminDb.collection(c).where('organizerUid', '==', U).get().catch(() => null)
      for (const d of qs?.docs ?? []) await d.ref.delete().catch(() => null)
    }
    for (const c of ['adminAuditLogs']) {
      const qs = await adminDb.collection(c).where('adminUid', '==', SUPER).get().catch(() => null)
      for (const d of qs?.docs ?? []) await d.ref.delete().catch(() => null)
    }
    for (const id of [`lic_${CAP}`, `${P}_notify`, `${P}_unpaid`]) {
      await adminDb.doc(`purchaseNotifications/${id}`).delete().catch(() => null)
      await adminDb.doc(`adminNotifications/purchase-${id}`).delete().catch(() => null)
    }
  }, T)
  afterEach(() => { h.who = '' })

  const json = async (res: Response) => ({ status: res.status, body: await res.json() as Body })
  const req = (url: string, method = 'GET', body?: unknown) => new NextRequest(`http://localhost${url}`, {
    method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const view = async (draftId: string) => {
    h.who = U
    const { GET } = await import('@/app/api/organizer/wallet/service-requests/route')
    return json(await GET(req(`/api/organizer/wallet/service-requests?event=${draftId}`)))
  }
  const svc = (body: Body, service: string) =>
    (body.services as Array<{ state: Body; refund: Body; carryForward: Body }>).find(x => x.state.service === service)!
  const submit = async (b: Body) => {
    h.who = U
    const { POST } = await import('@/app/api/organizer/wallet/service-requests/route')
    return json(await POST(req('/api/organizer/wallet/service-requests', 'POST', b)))
  }
  const decide = async (id: string, b: Body) => {
    h.who = SUPER
    const { POST } = await import('@/app/api/admin/wallet-service-requests/[id]/route')
    return json(await POST(req(`/api/admin/wallet-service-requests/${id}`, 'POST', b), { params: Promise.resolve({ id }) }))
  }
  const REASON = 'Verified against the paid orders.'

  // ── registration capacity ─────────────────────────────────────────────────────────────────────
  it('capacity: paid units above the free allowance and registrations, valued line by line; never carried', async () => {
    const v = await view(CAP)
    const c = svc(v.body, 'registrations')
    expect(c.state).toMatchObject({ applicable: true, purchased: 400, used: 150, ownUnused: 350, paidPaise: 70_800, facts: { capacity: 500, registrations: 150, freeCapacity: 100, paidUsed: 50, reducedCapacity: 0 } })
    // Capacity invariant in PAID units: purchased = paidUsed + ownUnused + refunded + reduced.
    const f = c.state.facts as Record<string, number>
    expect(400).toBe(f.paidUsed + (c.state.ownUnused as number) + (c.state.refunded as number) + f.reducedCapacity)
    // Used: 150 sold − 100 free = 50 paid units, from the OLDEST order. Unused 350 = 200 (newest, ₹354) + 150 of the oldest.
    expect(c.refund).toMatchObject({ eligible: true, quantity: 350, upperBoundPaise: 35_400 + 26_550 })
    expect(c.carryForward).toMatchObject({ eligible: false, code: 'SERVICE_NOT_SUPPORTED' })
  }, T)

  it('capacity: approval lowers the enforced capacity atomically and exactly once', async () => {
    const s = await submit({ kind: 'refund', draftId: CAP, service: 'registrations' })
    expect(s.status).toBe(201)
    const id = (s.body.request as Body).id as string
    expect((s.body.request as Body).refundUpperBoundPaise).toBe(61_950)
    const results = await Promise.all([1, 2].map(() => decide(id, { action: 'approve', reason: REASON, approvedAmountPaise: 61_950 })))
    expect(results.every(r => r.status === 200)).toBe(true)
    expect(results.filter(r => r.body.already === false)).toHaveLength(1)
    expect((await adminDb.doc(`events/${slugCap}`).get()).get('totalCapacity')).toBe(150)
    expect((await adminDb.doc(`eventLicenses/${slugCap}`).get()).get('capacity')).toBe(150)
    // Refund-history S4 — before / refunded / after recorded once, on the request and in the audit row
    const stored = (await adminDb.doc(`walletServiceRequests/${id}`).get()).data()!
    expect(stored.capacity).toEqual({ before: 500, refunded: 350, after: 150 })
    expect(stored.capacity.before - stored.capacity.refunded).toBe(stored.capacity.after)
    const audits = (await adminDb.collection('adminAuditLogs').where('entityId', '==', id).get()).docs.map(d => d.data())
    expect(audits).toHaveLength(1)   // the duplicate approval wrote nothing
    expect(audits[0].metadata).toMatchObject({ capacityBefore: 500, capacityRefunded: 350, capacityAfter: 150 })
    const { reconcileServiceRefunds } = await import('@/lib/wallet/serviceRequests')
    const rec = await reconcileServiceRefunds({ limit: 100 })
    expect(rec.rows.find(r => r.requestId === id)).toMatchObject({ status: 'approved', capacity: { before: 500, refunded: 350, after: 150 }, outstandingPaise: 61_950 })
    expect(rec.findings.filter(f => f.requestId === id)).toEqual([])
    const after = svc((await view(CAP)).body, 'registrations')
    expect(after.state).toMatchObject({ ownUnused: 0, refunded: 350, remaining: 0, facts: { paidUsed: 50, reducedCapacity: 0, capacity: 150 } })
    const af = after.state.facts as Record<string, number>
    expect(400).toBe(af.paidUsed + (after.state.ownUnused as number) + (after.state.refunded as number) + af.reducedCapacity)
    expect(after.refund).toMatchObject({ eligible: false, code: 'NOTHING_UNUSED' })
  }, T)

  it('capacity bought with an activation coupon is valued at what was COLLECTED (Option A)', async () => {
    const c = svc((await view(CAPC)).body, 'registrations')
    expect(c.state).toMatchObject({ purchased: 200, ownUnused: 200, paidPaise: 30_000 })
    expect(c.refund).toMatchObject({ eligible: true, quantity: 200, upperBoundPaise: 30_000 })
  }, T)

  // ── photos ────────────────────────────────────────────────────────────────────────────────────
  it('photos: used = every stored photo (no free base); refund and carry-forward of the unused PAID units', async () => {
    const p = svc((await view(PH)).body, 'media')
    expect(p.state).toMatchObject({ purchased: 50, used: 20, ownUnused: 30, remaining: 30, facts: { storedPhotos: 20, baseCapAtPurchase: null } })
    expect(p.refund).toMatchObject({ eligible: true, quantity: 30, upperBoundPaise: 7_080 })
    const cf = await submit({ kind: 'carry_forward', draftId: PH, service: 'media', destinationDraftId: DST })
    expect(cf.status).toBe(201)
    const ok = await decide((cf.body.request as Body).id as string, { action: 'approve', reason: REASON })
    expect(ok.status).toBe(200)
    expect(((await adminDb.doc(`eventServiceAllowances/${PH}`).get()).data()!.media)).toMatchObject({ purchased: 50, carriedOut: 30 })
    ledgers.push(DST)
    expect(((await adminDb.doc(`eventServiceAllowances/${DST}`).get()).data()!.media)).toMatchObject({ carriedIn: 30 })
  }, T)

  it('RD-PHOTO-01 · photos bought before a base was recorded are measurable now: nothing stored ⇒ all unused paid units', async () => {
    const p = svc((await view(PHOLD)).body, 'media')
    // No free base exists any more, so no snapshot is needed: used = photos the event holds (0).
    expect(p.state).toMatchObject({ purchased: 20, used: 0, remaining: 20, ownUnused: 20, problem: null })
    expect(p.refund).toMatchObject({ eligible: true, quantity: 20, upperBoundPaise: 4_720 })
  }, T)

  // ── valuation across orders ───────────────────────────────────────────────────────────────────
  it('two purchases at different prices: the 5 unused units are the NEWEST, valued at the newer price', async () => {
    const w = svc((await view(VAL)).body, 'whatsapp')
    expect(w.refund).toMatchObject({ eligible: true, quantity: 5, upperBoundPaise: 1_180, valuation: [{ orderId: `add_${VAL}_1`, units: 5, valuePaise: 1_180 }] })
  }, T)

  // ── refund all ────────────────────────────────────────────────────────────────────────────────
  it('"refund all" submits one request per eligible service, together (one group), and moves nothing', async () => {
    const r = await submit({ kind: 'refund', draftId: ALL, services: 'all', note: 'Event archived' })
    expect(r.status).toBe(201)
    const reqs = r.body.requests as Body[]
    expect(reqs.map(x => x.service).sort()).toEqual(['certificates', 'whatsapp'])
    expect(new Set(reqs.map(x => x.groupId)).size).toBe(1)
    expect(reqs[0].groupId).not.toBeNull()
    expect(reqs.find(x => x.service === 'whatsapp')).toMatchObject({ quantity: 10, refundUpperBoundPaise: 1_180 })
    expect(((await adminDb.doc(`eventServiceAllowances/${ALL}`).get()).data()!.whatsapp.refunded)).toBeUndefined()
    const again = await submit({ kind: 'refund', draftId: ALL, services: 'all' })
    expect(again.status).toBe(409); expect(again.body.code).toBe('NOTHING_ELIGIBLE')
    expect((await submit({ kind: 'carry_forward', draftId: ALL, services: 'all', destinationDraftId: DST })).body.code).toBe('ALL_REFUND_ONLY')
  }, T)

  // ── purchase notifications ────────────────────────────────────────────────────────────────────
  it('a paid order notifies the organizer, the support inbox, EACH Super Admin and the Super Admin feed — exactly once', async () => {
    await put(`licenseOrders/${P}_notify`, { orderId: `${P}_notify`, eventId: ALL, organizerUid: U, purpose: 'addon', status: 'paid', amountPaise: 1_180, razorpayPaymentId: 'pay_TEST', serviceItems: [item('whatsapp', 10, 1_180)], createdAt: ts(9), paidAt: ts(9) })
    // Two real Super Admin accounts (Auth emulator) + one uid whose email repeats the support inbox
    // (sent once) + one that does not exist (skipped, never guessed).
    const { adminAuth } = await import('@/lib/firebase/admin')
    const { getBrandingConfig } = await import('@/lib/config/resolveBrandingConfig')
    const support = (await getBrandingConfig()).supportEmail
    const sa = [`${P}-sa1`, `${P}-sa2`, `${P}-sa3`]
    await adminAuth.createUser({ uid: sa[0], email: `${P}-sa1@example.test` }).catch(() => null)
    await adminAuth.createUser({ uid: sa[1], email: `${P}-sa2@example.test` }).catch(() => null)
    await adminAuth.createUser({ uid: sa[2], email: support.toUpperCase() }).catch(() => null)
    const prevAdmins = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = [...sa, `${P}-missing`].join(',')
    h.sends = []
    try {
      const { notifyServicePurchase } = await import('@/lib/notifications/servicePurchase')
      const results = await Promise.all([1, 2, 3].map(() => notifyServicePurchase(`${P}_notify`)))
      expect(results.filter(r => r === 'sent')).toHaveLength(1)
      expect(results.filter(r => r === 'duplicate')).toHaveLength(2)
      expect(h.sends.filter(s => s.type === 'SERVICE_PURCHASED').map(s => s.to)).toEqual([`${P}@example.test`])
      expect(h.sends.filter(s => s.type === 'SERVICE_PURCHASE_ADMIN').map(s => s.to.toLowerCase()).sort())
        .toEqual([support.toLowerCase(), `${P}-sa1@example.test`, `${P}-sa2@example.test`].sort())
    } finally {
      process.env.ADMIN_UIDS = prevAdmins
      for (const uid of sa) await adminAuth.deleteUser(uid).catch(() => null)
    }
    const { notifyServicePurchase } = await import('@/lib/notifications/servicePurchase')
    expect((await adminDb.doc(`adminNotifications/purchase-${P}_notify`).get()).exists).toBe(true)
    expect((await adminDb.doc(`purchaseNotifications/${P}_notify`).get()).get('status')).toBe('sent')
    // A replay later (webhook redelivery, refresh) sends nothing.
    h.sends = []
    expect(await notifyServicePurchase(`${P}_notify`)).toBe('duplicate')
    expect(h.sends).toHaveLength(0)
  }, T)

  it('an unpaid order is never notified', async () => {
    await put(`licenseOrders/${P}_unpaid`, { orderId: `${P}_unpaid`, eventId: ALL, organizerUid: U, purpose: 'addon', status: 'created', amountPaise: 1_180, serviceItems: [item('whatsapp', 10, 1_180)], createdAt: ts(9) })
    const { notifyServicePurchase } = await import('@/lib/notifications/servicePurchase')
    expect(await notifyServicePurchase(`${P}_unpaid`)).toBe('not_paid')
    expect((await adminDb.doc(`purchaseNotifications/${P}_unpaid`).get()).exists).toBe(false)
  }, T)

  it('the Super Admin feed: ADMIN_UIDS only; read state is per admin', async () => {
    const { GET, POST } = await import('@/app/api/admin/notifications/route')
    h.who = PLAIN
    expect((await GET(req('/api/admin/notifications'))).status).toBe(403)
    h.who = U
    expect((await GET(req('/api/admin/notifications'))).status).toBe(403)
    h.who = SUPER
    const list = await json(await GET(req('/api/admin/notifications')))
    expect(list.status).toBe(200)
    const item0 = (list.body.items as Body[]).find(i => i.id === `purchase-${P}_notify`)!
    expect(item0).toMatchObject({ read: false })
    expect((await json(await POST(req('/api/admin/notifications', 'POST', { ids: [item0.id, 'does-not-exist'] })))).body.marked).toBe(1)
    expect((await adminDb.doc('adminNotifications/does-not-exist').get()).exists).toBe(false)
    const after = await json(await GET(req('/api/admin/notifications')))
    expect((after.body.items as Body[]).find(i => i.id === item0.id)).toMatchObject({ read: true })
  }, T)
})
