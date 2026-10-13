// RD-PRINT-BILL-P6 · The organizer ID-badge flow on REAL Firestore, through the real routes the UI
// calls — the summary, the generation quote / create / retry, the badge purchase quote / purchase and
// the shared licensing confirm — and the REAL generation controller (useBadgeGeneration's state
// machine) driving those routes in-process.
//
// Test-process mocks ONLY (the source gates stay false; tests/unit pins them):
//   • isServicePurchaseReleased('print_badges')   → h.purchaseGate
//   • resolveEffectivePrintBadgeTerms            → the ungated precedence while h.genGate
//   • getGlobalPrintBadgeTerms                   → paid generation on, ₹0.20 incl. 18 % GST, on sale
//   • the Razorpay client                        → no gateway, no money
//   • authorizeWorkspace                         → owner / `certificates` staff / no permission
//   • the renderer                               → throws for "Fail-Sentinel" while h.failRender
//   • after(), notifications                     → no-ops
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const SECRET = 'rd_p6_badges_secret'
const h = vi.hoisted(() => ({
  purchaseGate: true, genGate: true, failRender: false,
  role: 'owner' as 'owner' | 'staff' | 'none',
  seq: 0,
  captures: new Map<string, Array<Record<string, unknown>>>(),
  payments: new Map<string, Record<string, unknown>>(),
  onClaimRead: null as null | (() => Promise<void>),
}))

vi.mock('@/lib/licensing/serviceAllowances', async orig => {
  const real = await orig<typeof import('@/lib/licensing/serviceAllowances')>()
  return { ...real, isServicePurchaseReleased: (k: unknown) => (k === 'print_badges' ? h.purchaseGate : real.isServicePurchaseReleased(k)) }
})
vi.mock('@/lib/licensing/printBadgeCommercial', async orig => {
  const real = await orig<typeof import('@/lib/licensing/printBadgeCommercial')>()
  return { ...real, resolveEffectivePrintBadgeTerms: (g: Parameters<typeof real.printBadgePrecedence>[0], o: unknown) => (h.genGate ? real.printBadgePrecedence(g, o) : real.resolveEffectivePrintBadgeTerms(g, o)) }
})
vi.mock('@/lib/licensing/printBadgeTermsServer', () => ({
  getGlobalPrintBadgeTerms: async () => ({ ok: true, terms: { paidGenerationEnabled: true, unitPricePaise: 20, gstRatePercent: 18 }, saleState: 'available' }),
}))
// RD-PRINT-P8 — the pilot is read like the terms above: every organizer here is a pilot organizer, so
// this suite keeps testing exactly the behaviour it was written for. Pilot rules: printBadgePilotP8.
vi.mock('@/lib/licensing/printBadgePilotServer', () => ({
  readPrintBadgePilot: async () => ({ ok: true, organizerUids: { has: () => true } }),
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_p6', RAZORPAY_KEY_SECRET: 'rd_p6_badges_secret',
  razorpay: {
    orders: {
      create: async (o: { amount: number }) => ({ id: `order_p6b_${++h.seq}`, amount: o.amount }),
      fetchPayments: async (orderId: string) => ({ items: h.captures.get(orderId) ?? [] }),
    },
    payments: {
      fetch: async (id: string) => { const p = h.payments.get(id); if (!p) throw new Error('payment not found'); return p },
      refund: async () => { throw new Error('no automatic refunds') },
    },
  },
}))
vi.mock('@/lib/team/workspace', async orig => {
  const O = `p6b-${process.pid}-owner`
  const ctx = () => h.role === 'owner'
    ? { callerUid: O, workspaceUid: O, role: 'owner', permissions: ['events', 'certificates'], isOwner: true, eventIds: [], isStaffCredential: false }
    : { callerUid: `${O}-staff`, workspaceUid: O, role: 'manager', permissions: ['events', 'certificates'], isOwner: false, eventIds: [], isStaffCredential: false }
  const authz = async () => h.role === 'none' ? { ok: false, status: 403, error: 'Forbidden' } : { ...ctx(), ok: true, status: 200, error: '' }
  return { ...(await orig<typeof import('@/lib/team/workspace')>()), authorizeWorkspace: authz, resolveWorkspaceUid: async () => ctx() }
})
vi.mock('@/lib/printAssets/badgeBilling/store', async orig => {
  const real = await orig<typeof import('@/lib/printAssets/badgeBilling/store')>()
  return {
    ...real,
    claimedRegistrationIds: async (draftId: string, ids: readonly string[]) => {
      const f = h.onClaimRead
      if (f) { h.onClaimRead = null; await f() }
      return real.claimedRegistrationIds(draftId, ids)
    },
  }
})
vi.mock('@/lib/printAssets/render', async orig => {
  const real = await orig<typeof import('@/lib/printAssets/render')>()
  return {
    ...real,
    renderToPdf: async (input: Parameters<typeof real.renderToPdf>[0]) => {
      if (h.failRender && JSON.stringify(input.variables ?? '').includes('Fail-Sentinel')) throw new Error('font cannot encode')
      return real.renderToPdf(input)
    },
  }
})
vi.mock('@/lib/firebase/auth', () => ({ auth: { currentUser: null } }))
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/notifications/servicePurchase', () => ({ scheduleServicePurchaseNotification: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifyPrintJobComplete: async () => {} }))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
type Rec = Record<string, unknown>
type Handler = (r: NextRequest, c?: unknown) => Promise<Response>
const PID = process.pid
const OWNER = `p6b-${PID}-owner`

describeEmu('RD-PRINT-BILL-P6 · organizer ID-badge flow (real Firestore, mocked gateway)', () => {
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let businessConfig: typeof import('@/lib/config/businessConfigService').businessConfig
  let gen: typeof import('@/lib/printAssets/generationJob')
  let ctl: typeof import('@/components/print-assets/badges/useBadgeGeneration')
  let createTpl: typeof import('@/lib/printAssets/firestore')['createPrintTemplate']
  let saveDesign: typeof import('@/lib/printAssets/firestore')['savePrintDesign']
  let BADGE: { canvas: never; design: never }
  const R: Record<string, Record<string, Handler>> = {}
  let cfgBackup: Rec | null = null
  let approvalBackup: Rec | null = null
  const made: Array<{ slug: string; draft: string }> = []
  let n = 0

  const req = (url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const json = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) as Rec })
  const params = (p: Rec) => ({ params: Promise.resolve(p) })
  const summary = async (slug: string) => json(await R.summary.GET(req(`/api/organizer/events/${slug}/print-badges`), params({ eventId: slug })))
  const as = async <X>(role: typeof h.role, fn: () => Promise<X>) => { h.role = role; try { return await fn() } finally { h.role = 'owner' } }
  const drive = async (jobId: string) => { for (let i = 0; i < 10; i++) if ((await gen.processPrintGenerationChunk(jobId)).status === 'completed') break }

  /** What the UI's fetch would do, dispatched in-process to the real route handlers. */
  async function dispatch(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const m = url.match(/^\/api\/organizer\/print-jobs(?:\/(quote)|\/([^/]+)\/retry)?$/)
    if (!m) throw new Error(`no route for ${url}`)
    const res = m[1] ? await R.quote.POST(req(url, body))
      : m[2] ? await R.retry.POST(req(url, body), params({ jobId: decodeURIComponent(m[2]) }))
      : await R.jobs.POST(req(url, body))
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  /** The real controller, on fake timers, over the real routes. */
  function controller(requestId?: string) {
    let now = Date.now(), id = 0, inflight = 0
    const timers: { id: number; at: number; fn: () => void }[] = []
    const c = ctl.createBadgeGenerationController({
      post: async (u, b) => { inflight++; try { return await dispatch(u, b) } finally { inflight-- } },
      now: () => now,
      setTimer: (fn, ms) => { const k = ++id; timers.push({ id: k, at: now + ms, fn }); return k },
      clearTimer: k => { const i = timers.findIndex(t => t.id === k); if (i >= 0) timers.splice(i, 1) },
      newRequestId: () => requestId ?? `p6-rq-${PID}-${++n}`,
      onChange: () => undefined,
    })
    const advance = async (ms: number) => {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const t = timers[0]
        if (!t || t.at > end) break
        timers.shift(); now = t.at; t.fn()
        await new Promise(r => setTimeout(r, 0))
        for (let i = 0; i < 800 && inflight > 0; i++) await new Promise(r => setTimeout(r, 25))
        await new Promise(r => setTimeout(r, 0))
      }
      now = end
    }
    return { c, advance, timers }
  }

  async function newEvent(over: Rec = {}): Promise<{ slug: string; draft: string; tpl: string }> {
    const k = ++n
    const slug = `p6b-ev-${PID}-${k}`, draft = `p6b-dr-${PID}-${k}`
    await adminDb.doc(`users/${OWNER}/eventDrafts/${draft}`).set({ status: 'published', eventDetails: { seo: { urlSlug: slug }, info: { name: `Badge Summit ${k}` } } })
    await adminDb.doc(`events/${slug}`).set({ uid: OWNER, draftId: draft, slug, lifecycleStatus: 'published', ...over })
    made.push({ slug, draft })
    const t = await createTpl(OWNER, OWNER, { eventId: draft, name: `P6 ${k}`, assetType: 'ID_CARD', canvas: BADGE.canvas })
    await saveDesign(t.id, BADGE.design, { actorUid: OWNER })
    return { slug, draft, tpl: t.id }
  }
  async function addRegs(slug: string, ids: string[], name = (i: number) => `Delegate ${i}`) {
    const b = adminDb.batch()
    ids.forEach((id, i) => b.set(adminDb.doc(`registrations/${id}`), {
      organizerUid: OWNER, eventSlug: slug, eventName: 'Badge Summit', status: 'confirmed', paymentStatus: 'paid',
      passId: 'p1', passName: 'Delegate', ticketCode: `T-${id}`, ticket: { qrValue: `RD:${slug}:${id}:T-${id}` },
      attendee: { name: name(i), email: `${id}@example.test` },
    }))
    await b.commit()
  }
  /** The purchase panel's sequence: price → order → (mocked) checkout + capture → confirm. */
  async function buyUnits(slug: string, quantity: number) {
    const q = await json(await R.bquote.POST(req(`/api/organizer/events/${slug}/print-badges/quote`, { quantity }), params({ eventId: slug })))
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    const net = (q.body.quote as Rec).netPaise as number
    const requestId = `p6-buy-${PID}-${++n}`
    const p = await json(await R.purchase.POST(req(`/api/organizer/events/${slug}/print-badges/purchase`, { quantity, requestId, expectedNetPaise: net }), params({ eventId: slug })))
    expect(p.status, JSON.stringify(p.body)).toBe(200)
    const co = p.body.checkout as { razorpayOrderId: string; amountPaise: number }
    const payId = `pay_p6b_${++h.seq}`
    h.payments.set(payId, { id: payId, amount: co.amountPaise, currency: 'INR', status: 'captured', order_id: co.razorpayOrderId })
    h.captures.set(co.razorpayOrderId, [{ id: payId, amount: co.amountPaise, currency: 'INR', status: 'captured' }])
    const sig = crypto.createHmac('sha256', SECRET).update(`${co.razorpayOrderId}|${payId}`).digest('hex')
    const c = await json(await R.confirm.POST(req('/api/licensing/checkout/confirm', { eventId: slug, orderId: p.body.orderId, razorpay_order_id: co.razorpayOrderId, razorpay_payment_id: payId, razorpay_signature: sig })))
    return { quote: q.body.quote as Rec, purchase: p.body, confirm: c }
  }
  async function writesFor(slug: string, draft: string) {
    const count = async (c: string, f: string, v: string) => (await adminDb.collection(c).where(f, '==', v).count().get()).data().count
    return JSON.stringify({
      ledger: (await adminDb.doc(`eventServiceAllowances/${draft}`).get()).data() ?? null,
      orders: await count('licenseOrders', 'eventId', draft), rounds: await count('printBadgeRounds', 'eventId', draft),
      claims: await count('printBadgeClaims', 'eventId', draft), jobs: await count('printGenerationJobs', 'eventSlug', slug),
      requests: await count('printJobRequests', 'organizerUid', OWNER), history: await count('licenseHistory', 'eventId', draft),
    })
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    adminDb = (await import('@/lib/firebase/admin')).adminDb
    businessConfig = (await import('@/lib/config/businessConfigService')).businessConfig
    gen = await import('@/lib/printAssets/generationJob')
    ctl = await import('@/components/print-assets/badges/useBadgeGeneration')
    ;({ createPrintTemplate: createTpl, savePrintDesign: saveDesign } = await import('@/lib/printAssets/firestore'))
    const { PRINT_COLLECTIONS } = await import('@/lib/printAssets/collections')
    BADGE = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge') as never
    const cfg = await adminDb.doc('system/businessConfiguration').get(); cfgBackup = cfg.exists ? cfg.data() as Rec : null
    const ap = await adminDb.doc('platformApprovals/print_badges_gst').get(); approvalBackup = ap.exists ? ap.data() as Rec : null
    await adminDb.doc('system/businessConfiguration').set({
      licensing: {
        serviceAllowances: { print_badges: { enabled: true, unitPricePaise: 20, gstRatePercent: 18, minQuantity: 100, maxQuantity: null, presets: [], onExhausted: 'block' } },
        printBadgeBilling: { paidGenerationEnabled: false, allowFreeCoupons: false },
      },
    }, { merge: true })
    businessConfig.invalidateCache()
    const tax = await import('@/lib/licensing/printBadgePurchase/taxApproval')
    await tax.recordBadgeTaxApproval({ adminUid: 'p6-super', reason: 'Accountant approved the badge GST treatment', configuredGstRate: 18,
      input: { gstRatePercent: 18, taxTreatmentId: 'badge-inclusive-v1', accountantName: 'A. Accountant & Co', accountantReference: 'AC/2026/88', accountantApprovedOn: '2026-10-01' } })
    await adminDb.doc(`users/${OWNER}`).set({ uid: OWNER, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    R.summary  = await import('@/app/api/organizer/events/[eventId]/print-badges/route') as never
    R.bquote   = await import('@/app/api/organizer/events/[eventId]/print-badges/quote/route') as never
    R.purchase = await import('@/app/api/organizer/events/[eventId]/print-badges/purchase/route') as never
    R.confirm  = await import('@/app/api/licensing/checkout/confirm/route') as never
    R.jobs     = await import('@/app/api/organizer/print-jobs/route') as never
    R.quote    = await import('@/app/api/organizer/print-jobs/quote/route') as never
    R.retry    = await import('@/app/api/organizer/print-jobs/[jobId]/retry/route') as never
  }, T)

  afterAll(async () => {
    h.purchaseGate = false; h.genGate = false
    if (cfgBackup) await adminDb.doc('system/businessConfiguration').set(cfgBackup); else await adminDb.doc('system/businessConfiguration').delete().catch(() => null)
    businessConfig?.invalidateCache()
    await adminDb.recursiveDelete(adminDb.doc('platformApprovals/print_badges_gst')).catch(() => null)
    if (approvalBackup) await adminDb.doc('platformApprovals/print_badges_gst').set(approvalBackup)
    for (const { slug, draft } of made) {
      for (const c of ['licenseOrders', 'licenseHistory', 'printBadgeClaims', 'printBadgeRounds', 'printTemplates', 'printTemplateVersions']) {
        for (const d of (await adminDb.collection(c).where('eventId', '==', draft).get()).docs) await d.ref.delete()
      }
      for (const d of (await adminDb.collection('printGenerationJobs').where('eventSlug', '==', slug).get()).docs) await adminDb.recursiveDelete(d.ref)
      for (const d of (await adminDb.collection('registrations').where('eventSlug', '==', slug).get()).docs) await d.ref.delete()
      await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${draft}`)).catch(() => null)
      await adminDb.doc(`events/${slug}`).delete().catch(() => null)
    }
    for (const d of (await adminDb.collection('printJobRequests').where('organizerUid', '==', OWNER).get()).docs) await d.ref.delete()
    await adminDb.recursiveDelete(adminDb.doc(`users/${OWNER}`)).catch(() => null)
  }, T)

  it('A · summary: gates closed ⇒ free + not released, reading nothing it does not need and writing nothing', async () => {
    const ev = await newEvent()
    h.purchaseGate = false; h.genGate = false
    try {
      const before = await writesFor(ev.slug, ev.draft)
      const s = await summary(ev.slug)
      expect(s.status).toBe(200)
      expect(s.body.summary).toMatchObject({
        eventSlug: ev.slug, draftId: ev.draft,
        billing: { mode: 'free', reason: 'global_disabled', unitPricePaise: null, priceSource: null },
        units: { available: 0, purchased: 0, carriedIn: 0, used: 0, reserved: 0 },
        purchase: { state: 'not_released', canBuy: false },
      })
      expect(await writesFor(ev.slug, ev.draft)).toBe(before)
    } finally { h.purchaseGate = true; h.genGate = true }
  }, T)

  it('B · summary access: owner and `certificates` staff read it; no permission ⇒ 403; not this workspace\'s / unpublished ⇒ 404', async () => {
    const ev = await newEvent()
    const owner = await summary(ev.slug)
    expect(owner.body.summary).toMatchObject({ billing: { mode: 'paid', unitPricePaise: 20, priceSource: 'global' }, purchase: { state: 'available', canBuy: true } })
    const staff = await as('staff', () => summary(ev.slug))
    expect(staff.status).toBe(200)
    expect(staff.body.summary).toMatchObject({ purchase: { state: 'available', canBuy: false } })
    expect((await as('none', () => summary(ev.slug))).status).toBe(403)

    expect((await summary(`p6b-missing-${PID}`)).status).toBe(404)
    const foreign = `p6b-foreign-${PID}`
    await adminDb.doc(`events/${foreign}`).set({ uid: 'someone-else', draftId: 'x', slug: foreign, lifecycleStatus: 'published' })
    made.push({ slug: foreign, draft: 'x' })
    expect((await summary(foreign)).status).toBe(404)
    const unpub = `p6b-unpub-${PID}`
    await adminDb.doc(`users/${OWNER}/eventDrafts/${unpub}`).set({ status: 'draft', eventDetails: { seo: { urlSlug: unpub } } })
    expect((await summary(unpub)).status).toBe(404)

    const cancelled = await newEvent({ lifecycleStatus: 'cancelled' })
    expect((await summary(cancelled.slug)).body.summary).toMatchObject({ purchase: { state: 'event_not_eligible', canBuy: false } })
    await adminDb.doc(`events/${ev.slug}`).update({ printBadgeCommercial: { complimentary: true } })
    expect((await summary(ev.slug)).body.summary).toMatchObject({ billing: { mode: 'complimentary' }, purchase: { state: 'badges_not_charged', canBuy: false } })
  }, T)

  it('C · the full sequence: summary → quote → 402 → buy (mocked Razorpay) → confirm → balance → create → duplicate (in progress → existing) → paid retry needs a quote', async () => {
    const ev = await newEvent()
    const ids = [`p6b-${PID}-a`, `p6b-${PID}-b`, `p6b-${PID}-c`]
    await addRegs(ev.slug, ids, i => (i === 2 ? 'Fail-Sentinel' : `Delegate ${i}`))
    const sel = { registrationIds: ids }

    // 1 · summary — paid, no units yet
    expect((await summary(ev.slug)).body.summary).toMatchObject({ billing: { mode: 'paid' }, units: { available: 0 }, purchase: { canBuy: true } })

    // 2 + 3 · the controller quotes, the owner confirms, the server refuses for lack of units (402)
    const a = controller()
    await a.c.start({ kind: 'create', templateId: ev.tpl, filters: sel })
    expect(a.c.state).toMatchObject({ phase: 'confirm', quote: { eligible: 3, previouslyBilled: 0, chargeable: 3, available: 0, shortfall: 3, unitPricePaise: 20 } })
    await a.c.confirm()
    expect(a.c.state).toMatchObject({ phase: 'blocked', outcome: { kind: 'insufficient', quote: { shortfall: 3 } } })
    expect((await summary(ev.slug)).body.summary).toMatchObject({ units: { available: 0, purchased: 0 } })

    // 4 + 5 · buy 100 units (owner) — staff are refused by the server, not just the button
    const staffQuote = await as('staff', async () => json(await R.bquote.POST(req(`/api/organizer/events/${ev.slug}/print-badges/quote`, { quantity: 100 }), params({ eventId: ev.slug }))))
    expect(staffQuote.body.code).toBe('OWNER_REQUIRED')
    const bought = await buyUnits(ev.slug, 100)
    expect(bought.quote).toMatchObject({ quantity: 100, unitPricePaise: 20, grossPaise: 2000, netPaise: 2000 })
    expect(bought.confirm).toMatchObject({ status: 200, body: { success: true, quantity: 100 } })

    // 6 · the balance moved
    expect((await summary(ev.slug)).body.summary).toMatchObject({ units: { available: 100, purchased: 100, used: 0, reserved: 0 } })

    // 7 · the SAME intent (same requestId, the quote the owner accepted) is re-sent after the purchase:
    //     the recount is within the accepted quote and units now suffice — the job is created.
    await a.c.resume()
    expect(a.c.state).toMatchObject({ phase: 'done', existing: false, billingMode: 'paid' })
    const jobId = (a.c.state as { jobId: string }).jobId
    expect((await summary(ev.slug)).body.summary).toMatchObject({ units: { available: 97, reserved: 3 } })

    // 8 · a duplicate of a request still seeding: REQUEST_IN_PROGRESS, retried with the SAME requestId → existing
    const ev2 = await newEvent()
    const ids2 = [`p6b-${PID}-d`, `p6b-${PID}-e`]
    await addRegs(ev2.slug, ids2)
    await buyUnits(ev2.slug, 100)
    const shared = `p6-shared-${PID}`
    const original = controller(shared), dup = controller(shared)
    await original.c.start({ kind: 'create', templateId: ev2.tpl, filters: { registrationIds: ids2 } })
    expect(original.c.state).toMatchObject({ phase: 'confirm' })
    h.onClaimRead = async () => {
      h.onClaimRead = async () => {   // the original is seeding now (it owns the request marker)
        await dup.c.start({ kind: 'create', templateId: ev2.tpl, filters: { registrationIds: ids2 } })
        await dup.c.confirm()
        expect(dup.c.state).toMatchObject({ phase: 'waiting', attempt: 1 })
      }
    }
    await original.c.confirm()
    expect(original.c.state).toMatchObject({ phase: 'done', existing: false })
    await dup.advance(2_000)
    expect(dup.c.state).toMatchObject({ phase: 'done', existing: true, jobId: (original.c.state as { jobId: string }).jobId })
    expect((await adminDb.collection('printGenerationJobs').where('eventSlug', '==', ev2.slug).get()).size).toBe(1)

    // 9 · a paid job's failed card: Retry needs the owner and a fresh quote; billed cards stay free
    h.failRender = true
    await drive(jobId)
    h.failRender = false
    expect((await adminDb.doc(`printBadgeRounds/${jobId}_r1`).get()).data()).toMatchObject({ status: 'settled', keptUnits: 2, releasedUnits: 1 })
    const staffRetry = controller()
    await as('staff', () => staffRetry.c.start({ kind: 'reopen', jobId, mode: 'retry' }))
    expect(staffRetry.c.state).toMatchObject({ phase: 'blocked', outcome: { kind: 'owner_required' } })   // refused before any quote
    const retry = controller()
    await retry.c.start({ kind: 'reopen', jobId, mode: 'retry' })
    expect(retry.c.state).toMatchObject({ phase: 'confirm', reason: 'required', quote: { chargeable: 1, available: 98 } })
    await retry.c.confirm()
    expect(retry.c.state).toMatchObject({ phase: 'done', billingMode: 'paid' })
    await drive(jobId)
    expect((await adminDb.doc(`printBadgeClaims/${ev.draft}__${ids[2]}`).get()).data()).toMatchObject({ jobId, round: 2 })
    // A regenerate of billed cards is a free run (no quote), and staff may do it.
    const regen = controller()
    await as('staff', () => regen.c.start({ kind: 'reopen', jobId, mode: 'regenerate', registrationIds: [ids[0]] }))
    expect(regen.c.state).toMatchObject({ phase: 'done' })
    await drive(jobId)
    expect((await summary(ev.slug)).body.summary).toMatchObject({ units: { available: 97, used: 3, reserved: 0 } })

    // Job / item views carry only the approved billing fields.
    const view = gen.toPrintJobView((await gen.getPrintGenerationJob(jobId))!)
    expect(view.billing).toEqual({ mode: 'paid', round: 2 })
    const items = await gen.listPrintJobItemViews(jobId)
    expect(items.find(i => i.registrationId === ids[0])?.billed).toBe('prior')
    expect(items.find(i => i.registrationId === ids[2])?.billed).toBe('new')
  }, T)

  it('D · complimentary and gate-closed events take the free path (no confirmation, no units, no purchase)', async () => {
    const comp = await newEvent({ printBadgeCommercial: { complimentary: true } })
    await addRegs(comp.slug, [`p6b-${PID}-f`])
    const c1 = controller()
    await as('staff', () => c1.c.start({ kind: 'create', templateId: comp.tpl, filters: { registrationIds: [`p6b-${PID}-f`] } }))
    expect(c1.c.state).toMatchObject({ phase: 'done', billingMode: 'complimentary' })
    expect((await summary(comp.slug)).body.summary).toMatchObject({ billing: { mode: 'complimentary' }, units: { available: 0 } })

    const free = await newEvent()
    await addRegs(free.slug, [`p6b-${PID}-g`])
    h.genGate = false
    try {
      const before = (await adminDb.collection('printBadgeClaims').where('eventId', '==', free.draft).get()).size
      const c2 = controller()
      await as('staff', () => c2.c.start({ kind: 'create', templateId: free.tpl, filters: { registrationIds: [`p6b-${PID}-g`] } }))
      expect(c2.c.state).toMatchObject({ phase: 'done', billingMode: 'free' })
      const job = await gen.getPrintGenerationJob((c2.c.state as { jobId: string }).jobId)
      expect(job?.billing).toBeUndefined()
      expect(gen.toPrintJobView(job!).billing).toBeNull()
      expect((await adminDb.collection('printBadgeClaims').where('eventId', '==', free.draft).get()).size).toBe(before)
    } finally { h.genGate = true }
  }, T)
})
