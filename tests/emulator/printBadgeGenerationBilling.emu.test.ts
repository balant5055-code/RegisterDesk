// RD-PRINT-BILL-P5 · ID-badge GENERATION billing on REAL Firestore (emulator), through the real
// create / quote / retry / cancel routes, the real job runner and the real renderer.
//
// Test-process mocks ONLY (the source gates stay closed — PAID_BADGE_GENERATION_RELEASED = false):
//   • resolveEffectivePrintBadgeTerms → the ungated precedence while `h.gateOpen` (else the real gate)
//   • getGlobalPrintBadgeTerms        → paid generation on, ₹0.20 incl. 18 % GST (no Business Config)
//   • authorizeWorkspace              → the owner, or a `certificates` staff member (h.owner)
//   • renderToPdf                     → throws for an attendee named "Fail-Sentinel" while h.failRender
//   • after() / notifications         → no-ops
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  gateOpen: false, owner: true, failRender: false, onClaimRead: null as null | (() => Promise<void>),
  // RD-PRINT-P8 — the pilot as the billing resolver sees it: everyone (default), nobody, or unreadable.
  // RD-PRINT-P8.3 — 'freshRemoved' = the cache still lists the organizer, a FRESH read does not.
  pilot: 'all' as 'all' | 'none' | 'unavailable' | 'freshUnavailable' | 'freshRemoved', pilotReads: 0,
  // RD-PRINT-P8.2 — the options of every pilot read; 'freshUnavailable' = the cache still lists the
  // organizer but a FRESH read fails.
  pilotOpts: [] as Array<{ fresh?: boolean } | undefined>,
}))
const PID = process.pid
const P = `p5b-${PID}`
const OWNER = `${P}-owner`
const EV = `${P}-ev`

vi.mock('@/lib/licensing/printBadgeCommercial', async orig => {
  const real = await orig<typeof import('@/lib/licensing/printBadgeCommercial')>()
  return { ...real, resolveEffectivePrintBadgeTerms: (g: Parameters<typeof real.printBadgePrecedence>[0], o: unknown) => (h.gateOpen ? real.printBadgePrecedence(g, o) : real.resolveEffectivePrintBadgeTerms(g, o)) }
})
vi.mock('@/lib/licensing/printBadgeTermsServer', () => ({
  getGlobalPrintBadgeTerms: async () => ({ ok: true, terms: { paidGenerationEnabled: true, unitPricePaise: 20, gstRatePercent: 18 }, saleState: 'available' }),
}))
// RD-PRINT-P8 — the pilot is read like the terms above: every organizer here is a pilot organizer, so
// this suite keeps testing exactly the behaviour it was written for. Pilot rules: printBadgePilotP8.
vi.mock('@/lib/licensing/printBadgePilotServer', () => ({
  readPrintBadgePilot: async (opts?: { fresh?: boolean }) => {
    h.pilotReads++
    h.pilotOpts.push(opts)
    if (h.pilot === 'unavailable' || (h.pilot === 'freshUnavailable' && opts?.fresh === true)) return { ok: false, reason: 'unavailable' }
    if (h.pilot === 'freshRemoved') return { ok: true, organizerUids: { has: () => opts?.fresh !== true } }
    return { ok: true, organizerUids: { has: () => h.pilot === 'all' || h.pilot === 'freshUnavailable' } }
  },
}))
vi.mock('@/lib/team/workspace', async orig => {
  const O = `p5b-${process.pid}-owner`
  const ctx = () => h.owner
    ? { callerUid: O, workspaceUid: O, role: 'owner', permissions: ['certificates'], isOwner: true, eventIds: [], isStaffCredential: false }
    : { callerUid: `${O}-staff`, workspaceUid: O, role: 'manager', permissions: ['certificates'], isOwner: false, eventIds: [], isStaffCredential: false }
  return { ...(await orig<typeof import('@/lib/team/workspace')>()), authorizeWorkspace: async () => ({ ...ctx(), ok: true, status: 200, error: '' }) }
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
// Fix-pass hook: runs ONCE at the next claim read (inside a create's / reopen's checks), to
// interleave a second request or a state change at that exact point. Pass-through otherwise.
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
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifyPrintJobComplete: async () => {} }))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
type Rec = Record<string, unknown>
type Handler = (r: NextRequest, c?: unknown) => Promise<Response>
const rid = (i: number) => `${P}-r${String(i).padStart(2, '0')}`
const ids = (...n: number[]) => n.map(rid)
const EXTRA_DRAFTS = [`${P}-x`, `${P}-legacy`, `${P}-foreign`]
const EXTRA_EVENTS = [`${P}-legacy-ev`, `${P}-other-ev`]
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => rid(a + k))

describeEmu('RD-PRINT-BILL-P5 · badge generation billing (real Firestore)', () => {
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let gen: typeof import('@/lib/printAssets/generationJob')
  let store: typeof import('@/lib/printAssets/badgeBilling/store')
  let recon: typeof import('@/lib/printAssets/badgeBilling/reconcile')
  const R: Record<string, Record<string, Handler>> = {}
  const tpl: Record<string, string> = {}
  let rq = 0

  const req = (body: unknown) => new NextRequest('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) as Rec })
  const as = <X>(owner: boolean, fn: () => Promise<X>) => { h.owner = owner; return fn().finally(() => { h.owner = true }) }
  const quote = async (t: string, filters: Rec) => json(await R.quote.POST(req({ templateId: tpl[t], filters })))
  const create = async (t: string, filters: Rec, extra: Rec = {}) => json(await R.jobs.POST(req({ templateId: tpl[t], filters, ...extra })))
  const retry = async (jobId: string, body: Rec) => json(await R.retry.POST(req(body), { params: Promise.resolve({ jobId }) }))
  const cancel = async (jobId: string) => json(await R.cancel.POST(req({}), { params: Promise.resolve({ jobId }) }))
  const drive = async (jobId: string) => { for (let i = 0; i < 10; i++) if ((await gen.processPrintGenerationChunk(jobId)).status === 'completed') break }
  const nextRq = () => `${P}-rq-${++rq}`
  /** Quote then create, as the owner: returns the created job id. */
  const quotedCreate = async (t: string, filters: Rec) => {
    const q = await quote(t, filters)
    expect(q.status).toBe(200)
    const c = await create(t, filters, { requestId: nextRq(), quote: q.body.quote })
    expect(c.status, JSON.stringify(c.body)).toBe(201)
    return { jobId: c.body.jobId as string, quote: q.body.quote as Rec }
  }
  const consumed = async () => Number(((await adminDb.doc(`eventServiceAllowances/${EV}`).get()).get('print_badges') as Rec | undefined)?.consumed ?? 0)
  const setPurchased = (n: number) => adminDb.doc(`eventServiceAllowances/${EV}`).set({ print_badges: { purchased: n, onExhausted: 'block' } }, { merge: true })
  const round = async (jobId: string, n = 1) => (await adminDb.doc(`printBadgeRounds/${jobId}_r${n}`).get()).data() as Rec | undefined
  const usage = async (jobId: string, n = 1) => (await adminDb.doc(`eventServiceAllowances/${EV}/usage/${jobId}_r${n}`).get()).data() as Rec | undefined
  const claim = async (i: number) => (await adminDb.doc(`printBadgeClaims/${EV}__${rid(i)}`).get()).data() as Rec | undefined
  const item = async (jobId: string, i: number) => (await adminDb.doc(`printGenerationJobs/${jobId}/items/${rid(i)}`).get()).data() as Rec | undefined
  const job = async (jobId: string) => (await adminDb.doc(`printGenerationJobs/${jobId}`).get()).data() as Rec | undefined
  const addRegs = async (from: number, to: number, over: (i: number) => Rec = () => ({})) => {
    const b = adminDb.batch()
    for (let i = from; i <= to; i++) {
      b.set(adminDb.doc(`registrations/${rid(i)}`), {
        organizerUid: OWNER, eventSlug: EV, eventName: 'Badge Billing Summit', status: 'confirmed', paymentStatus: 'paid',
        passId: 'p1', passName: 'Delegate', ticketCode: `RD-${P}-T${i}`, ticket: { qrValue: `RD:${EV}:${rid(i)}:RD-${P}-T${i}` },
        attendee: { name: `Delegate ${i}`, email: `d${i}.${P}@example.test` }, ...over(i),
      })
    }
    await b.commit()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    adminDb = (await import('@/lib/firebase/admin')).adminDb
    gen = await import('@/lib/printAssets/generationJob')
    store = await import('@/lib/printAssets/badgeBilling/store')
    recon = await import('@/lib/printAssets/badgeBilling/reconcile')
    const { createPrintTemplate, savePrintDesign } = await import('@/lib/printAssets/firestore')
    const { PRINT_COLLECTIONS } = await import('@/lib/printAssets/collections')

    await adminDb.doc(`users/${OWNER}`).set({ uid: OWNER, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    const ev = { eventType: 'conference', eventDetails: { seo: { urlSlug: EV }, info: { name: 'Badge Billing Summit' } } }
    await adminDb.doc(`users/${OWNER}/eventDrafts/${EV}`).set({ status: 'published', ...ev })
    await adminDb.doc(`events/${EV}`).set({ uid: OWNER, draftId: EV, slug: EV, lifecycleStatus: 'published', ...ev })
    await adminDb.doc(`eventServiceAllowances/${EV}`).set({ draftId: EV, organizerUid: OWNER, print_badges: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    await addRegs(0, 7)

    const badge = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge')!
    for (const [key, assetType] of [['id', 'ID_CARD'], ['badge', 'BADGE'], ['bib', 'BIB']] as const) {
      const t = await createPrintTemplate(OWNER, OWNER, { eventId: EV, name: `P5 ${key}`, assetType, canvas: badge.canvas })
      await savePrintDesign(t.id, badge.design, { actorUid: OWNER })
      tpl[key] = t.id
    }
    const base = '@/app/api/organizer/print-jobs'
    R.jobs   = await import(`${base}/route`) as unknown as Record<string, Handler>
    R.quote  = await import(`${base}/quote/route`) as unknown as Record<string, Handler>
    R.retry  = await import(`${base}/[jobId]/retry/route`) as unknown as Record<string, Handler>
    R.cancel = await import(`${base}/[jobId]/cancel/route`) as unknown as Record<string, Handler>
  }, T)

  afterAll(async () => {
    h.gateOpen = false
    for (const c of ['printBadgeClaims', 'printBadgeRounds', 'licenseHistory', 'printTemplateVersions', 'printTemplates']) {
      for (const d of (await adminDb.collection(c).where('eventId', '==', EV).get()).docs) await d.ref.delete()
    }
    for (const d of (await adminDb.collection('printGenerationJobs').where('eventSlug', '==', EV).get()).docs) await adminDb.recursiveDelete(d.ref)
    for (const d of (await adminDb.collection('registrations').where('eventSlug', '==', EV).get()).docs) await d.ref.delete()
    await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${EV}`)).catch(() => null)
    await adminDb.recursiveDelete(adminDb.doc(`users/${OWNER}`)).catch(() => null)
    await adminDb.doc(`events/${EV}`).delete().catch(() => null)
    for (const x of EXTRA_DRAFTS) {
      for (const d of (await adminDb.collection('printTemplates').where('eventId', '==', x).get()).docs) await d.ref.delete()
      for (const d of (await adminDb.collection('printTemplateVersions').where('eventId', '==', x).get()).docs) await d.ref.delete()
      for (const d of (await adminDb.collection('printGenerationJobs').where('eventId', '==', x).get()).docs) await adminDb.recursiveDelete(d.ref)
      await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${x}`)).catch(() => null)
    }
    for (const e of EXTRA_EVENTS) await adminDb.doc(`events/${e}`).delete().catch(() => null)
    for (const d of (await adminDb.collection('printJobRequests').where('organizerUid', '==', OWNER).get()).docs) await d.ref.delete()
  }, T)

  it('A · gate CLOSED: badge jobs take the free path — no billing, no claims, no units; staff allowed', async () => {
    h.gateOpen = false
    const before = await consumed()
    expect((await as(false, () => quote('id', { registrationIds: ids(0, 1) }))).body).toEqual({ success: true, mode: 'free' })
    const c = await as(false, () => create('id', { registrationIds: ids(0, 1) }))
    expect(c.status).toBe(201)
    const jobId = c.body.jobId as string
    expect((await job(jobId))?.billing).toBeUndefined()
    await drive(jobId)
    expect((await job(jobId))?.status).toBe('completed')
    expect((await item(jobId, 0))?.rendered).toBe(true)
    expect(await claim(0)).toBeUndefined()
    expect(await round(jobId)).toBeUndefined()
    expect(await consumed()).toBe(before)
  }, T)

  it('B · refusals write nothing: no requestId (400), staff (403), no quote (409), too few units (402)', async () => {
    h.gateOpen = true
    const sel = { registrationIds: ids(0, 1) }
    const r1 = await create('id', sel)
    expect(r1.status).toBe(400); expect(r1.body.code).toBe('REQUEST_ID_REQUIRED')

    const staffRq = nextRq()
    const r2 = await as(false, () => create('id', sel, { requestId: staffRq }))
    expect(r2.status).toBe(403); expect(r2.body.code).toBe('OWNER_REQUIRED')
    const staffJob = gen.billedPrintJobId(OWNER, staffRq)
    expect(await job(staffJob)).toBeUndefined()
    expect((await adminDb.collection(`printGenerationJobs/${staffJob}/items`).get()).size).toBe(0)

    const r3 = await create('id', sel, { requestId: nextRq() })
    expect(r3.status).toBe(409); expect(r3.body.code).toBe('BILLING_QUOTE_REQUIRED')
    // The free job in A billed nobody: both attendees are still chargeable.
    expect(r3.body.quote).toMatchObject({ mode: 'paid', eligible: 2, previouslyBilled: 0, chargeable: 2, available: 10, shortfall: 0, unitPricePaise: 20, ownerRequired: true })

    await setPurchased(1)
    const q = await quote('id', sel)
    expect(q.body.quote).toMatchObject({ chargeable: 2, available: 1, shortfall: 1 })
    const poorRq = nextRq()
    const r4 = await create('id', sel, { requestId: poorRq, quote: q.body.quote })
    expect(r4.status).toBe(402); expect(r4.body.code).toBe('INSUFFICIENT_BADGE_UNITS')
    const poorJob = gen.billedPrintJobId(OWNER, poorRq)
    expect(await job(poorJob)).toBeUndefined()
    expect(await round(poorJob)).toBeUndefined()
    expect((await adminDb.collection(`printGenerationJobs/${poorJob}/items`).get()).size).toBe(0)
    expect(await consumed()).toBe(0)
    await setPurchased(10)
  }, T)

  it('C · success: reserve → claim per attendee → settle; idempotent create; ID cards and badges share one claim', async () => {
    h.gateOpen = true
    const sel = { registrationIds: range(0, 5) }
    const q = await quote('id', sel)
    expect(q.body.quote).toMatchObject({ eligible: 6, chargeable: 6 })
    const requestId = nextRq()
    const c = await create('id', sel, { requestId, quote: q.body.quote })
    expect(c.status).toBe(201)
    const jobId = c.body.jobId as string
    expect(jobId).toBe(gen.billedPrintJobId(OWNER, requestId))
    expect((await job(jobId))?.billing).toMatchObject({ mode: 'paid', round: 1, chargeable: 6, unitPricePaise: 20 })
    expect(await round(jobId)).toMatchObject({ status: 'reserved', reserved: 6, claimed: 0, quote: { chargeable: 6, quotedChargeable: 6 } })
    expect(await usage(jobId)).toMatchObject({ service: 'print_badges', quantity: 6 })
    expect(await consumed()).toBe(6)

    // D5 — the same request again returns the same job and reserves nothing more.
    const again = await create('id', sel, { requestId, quote: q.body.quote })
    expect(again.status).toBe(200); expect(again.body.jobId).toBe(jobId)
    expect(await consumed()).toBe(6)
    const reused = await create('id', { registrationIds: range(0, 4) }, { requestId, quote: q.body.quote })
    expect(reused.status).toBe(409); expect(reused.body.code).toBe('REQUEST_ID_REUSED')

    await drive(jobId)
    expect((await job(jobId))?.status).toBe('completed')
    for (let i = 0; i <= 5; i++) {
      expect(await claim(i)).toMatchObject({ jobId, round: 1, roundId: `${jobId}_r1`, mode: 'units', assetType: 'ID_CARD' })
      expect(await item(jobId, i)).toMatchObject({ rendered: true, billed: 'new', billedRound: 1 })
    }
    expect(await round(jobId)).toMatchObject({ status: 'settled', claimed: 6, keptUnits: 6, releasedUnits: 0, settledReason: 'completed' })
    expect(await consumed()).toBe(6)
    const hist = (await adminDb.collection('licenseHistory').where('eventId', '==', EV).get()).docs.map(d => d.data())
    expect(hist.filter(x => x.action === 'print_badges_consumed' && (x.after as Rec).jobId === jobId)).toHaveLength(1)

    // D1/D2 — a BADGE job over the same six plus two more bills only the two.
    const bq = await quote('badge', { registrationIds: range(0, 7) })
    expect(bq.body.quote).toMatchObject({ eligible: 8, previouslyBilled: 6, chargeable: 2 })
    const staff = await as(false, () => create('badge', { registrationIds: range(0, 7) }, { requestId: nextRq(), quote: bq.body.quote }))
    expect(staff.status).toBe(403)
    const b = await create('badge', { registrationIds: range(0, 7) }, { requestId: nextRq(), quote: bq.body.quote })
    expect(b.status).toBe(201)
    expect(await consumed()).toBe(8)
    await drive(b.body.jobId as string)
    expect(await round(b.body.jobId as string)).toMatchObject({ status: 'settled', claimed: 2, keptUnits: 2, releasedUnits: 0 })
    expect(await item(b.body.jobId as string, 0)).toMatchObject({ rendered: true, billed: 'prior' })
    expect(await claim(0)).toMatchObject({ jobId })   // the claim still names the job that billed it
    expect(await consumed()).toBe(8)

    // D3 — staff may run a paid job in which everybody is already billed (a reprint): no units.
    const s = await as(false, () => create('id', { registrationIds: ids(0, 1) }, { requestId: nextRq() }))
    expect(s.status).toBe(201)
    await drive(s.body.jobId as string)
    expect(await item(s.body.jobId as string, 1)).toMatchObject({ rendered: true, billed: 'prior' })
    expect(await consumed()).toBe(8)
    const rc = await recon.reconcilePrintBadgeUsage(EV)
    expect(rc.problems).toEqual([])
    expect(rc).toMatchObject({ ok: true, ledgerConsumed: 8, usageTotal: 8, roundClaimedTotal: 8, unitClaims: 8 })
  }, T)

  it('D · D4: a count above the quote needs a new quote; a count below proceeds and reserves only what is needed', async () => {
    h.gateOpen = true
    await addRegs(8, 9)
    const sel = { pass: 'p1' }                     // the whole event: 10 eligible, r08 + r09 unbilled
    const q = await quote('id', sel)
    expect(q.body.quote).toMatchObject({ eligible: 10, chargeable: 2 })
    await addRegs(10, 10)
    const up = await create('id', sel, { requestId: nextRq(), quote: q.body.quote })
    expect(up.status).toBe(409); expect(up.body.code).toBe('QUOTE_CHANGED')
    expect(up.body.quote).toMatchObject({ chargeable: 3 })
    await adminDb.doc(`registrations/${rid(10)}`).update({ status: 'cancelled' })
    await adminDb.doc(`registrations/${rid(9)}`).update({ status: 'cancelled' })
    const before = await consumed()
    const down = await create('id', sel, { requestId: nextRq(), quote: q.body.quote })
    expect(down.status).toBe(201)
    const jobId = down.body.jobId as string
    expect(await round(jobId)).toMatchObject({ reserved: 1, quote: { chargeable: 1, quotedChargeable: 2 } })
    expect(await consumed()).toBe(before + 1)
    await drive(jobId)
    expect(await round(jobId)).toMatchObject({ status: 'settled', keptUnits: 1, releasedUnits: 0 })
    expect(await claim(8)).toMatchObject({ jobId })
    expect(await claim(9)).toBeUndefined()
  }, T)

  it('E · overlapping jobs bill each attendee once (the later job is trimmed); racing workers create one claim', async () => {
    h.gateOpen = true
    await setPurchased(30)
    await addRegs(11, 13)
    const before = await consumed()
    const A = await quotedCreate('id', { registrationIds: ids(11, 12) })
    const B = await quotedCreate('badge', { registrationIds: ids(11, 12) })
    expect(await consumed()).toBe(before + 4)
    await drive(A.jobId); await drive(B.jobId)
    expect(await round(A.jobId)).toMatchObject({ status: 'settled', keptUnits: 2, releasedUnits: 0 })
    expect(await round(B.jobId)).toMatchObject({ status: 'settled', keptUnits: 0, releasedUnits: 2 })
    expect(await usage(B.jobId)).toBeUndefined()          // a fully released reservation leaves no usage record
    expect(await consumed()).toBe(before + 2)

    // Two jobs, one attendee, two workers at once (and a duplicate worker on one job).
    const C = await quotedCreate('id', { registrationIds: ids(13) })
    const D = await quotedCreate('badge', { registrationIds: ids(13) })
    expect(await consumed()).toBe(before + 4)
    const jc = (await job(C.jobId))!, jd = (await job(D.jobId))!
    const res = await Promise.all([
      store.claimBadgeForItem(jc as never, rid(13)), store.claimBadgeForItem(jd as never, rid(13)), store.claimBadgeForItem(jc as never, rid(13)),
    ])
    const billed = res.map(r => (r.ok ? r.billed : r.error)).sort()
    expect(billed.filter(x => x === 'new')).toHaveLength(1)
    expect(billed.filter(x => x === 'new' || x === 'prior' || x === 'already_rendered')).toHaveLength(3)
    const rc = (await round(C.jobId))!.claimed as number, rd = (await round(D.jobId))!.claimed as number
    expect(rc + rd).toBe(1)
    await drive(C.jobId); await drive(D.jobId)
    expect(Number((await round(C.jobId))!.keptUnits) + Number((await round(D.jobId))!.keptUnits)).toBe(1)
    expect(await consumed()).toBe(before + 3)
  }, T)

  it('F · cancel settles at once; a late worker is refused and never billed', async () => {
    h.gateOpen = true
    await addRegs(14, 15)
    const before = await consumed()
    const { jobId } = await quotedCreate('id', { registrationIds: ids(14, 15) })
    expect(await consumed()).toBe(before + 2)
    const c = await as(false, () => cancel(jobId))       // staff may cancel
    expect(c.status).toBe(200)
    expect(await round(jobId)).toMatchObject({ status: 'settled', keptUnits: 0, releasedUnits: 2, settledReason: 'cancelled' })
    expect(await consumed()).toBe(before)
    const late = await store.claimBadgeForItem((await job(jobId)) as never, rid(14))
    expect(late.ok).toBe(false)
    expect(await claim(14)).toBeUndefined()
    expect(await item(jobId, 14)).toMatchObject({ rendered: false })
    await gen.processPrintGenerationChunk(jobId)
    expect((await job(jobId))?.status).toBe('cancelled')
    expect(await consumed()).toBe(before)
  }, T)

  it('G · a failed render is never billed; retry after settlement needs owner + quote + units; regenerate of billed cards is free', async () => {
    h.gateOpen = true
    await addRegs(16, 17, i => (i === 16 ? { attendee: { name: 'Fail-Sentinel', email: `f.${P}@example.test` } } : {}))
    h.failRender = true
    const before = await consumed()
    const { jobId } = await quotedCreate('id', { registrationIds: ids(16, 17) })
    await drive(jobId)
    expect((await job(jobId))?.status).toBe('completed')
    expect(await item(jobId, 16)).toMatchObject({ rendered: false })
    expect(await claim(16)).toBeUndefined()
    expect(await round(jobId)).toMatchObject({ status: 'settled', keptUnits: 1, releasedUnits: 1 })
    expect(await consumed()).toBe(before + 1)

    expect((await as(false, () => retry(jobId, { mode: 'retry' }))).body.code).toBe('OWNER_REQUIRED')
    const need = await retry(jobId, { mode: 'retry' })
    expect(need.status).toBe(409); expect(need.body.code).toBe('BILLING_QUOTE_REQUIRED')
    expect(need.body.quote).toMatchObject({ chargeable: 1, eligible: 1 })
    expect(await round(jobId, 2)).toBeUndefined()
    expect(await consumed()).toBe(before + 1)

    h.failRender = false
    const ok = await retry(jobId, { mode: 'retry', quote: need.body.quote })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    await drive(jobId)
    expect((await job(jobId))?.billing).toMatchObject({ round: 2 })
    expect(await claim(16)).toMatchObject({ jobId, round: 2, roundId: `${jobId}_r2` })
    expect(await round(jobId, 2)).toMatchObject({ status: 'settled', reserved: 1, keptUnits: 1 })
    expect(await consumed()).toBe(before + 2)

    // Every card billed ⇒ regenerate is a free run, and staff may do it.
    const regen = await as(false, () => retry(jobId, { mode: 'regenerate' }))
    expect(regen.status).toBe(200)
    await drive(jobId)
    expect(await round(jobId, 3)).toBeUndefined()
    expect(await item(jobId, 16)).toMatchObject({ rendered: true, billed: 'prior' })
    expect(await consumed()).toBe(before + 2)
  }, T)

  it('H · a crashed worker (render done, claim not) is resumed and billed once; the sweep settles ended jobs', async () => {
    h.gateOpen = true
    await addRegs(18, 19)
    const before = await consumed()
    const crashed = await quotedCreate('id', { registrationIds: ids(18) })
    const { Timestamp } = await import('firebase-admin/firestore')
    await adminDb.doc(`printGenerationJobs/${crashed.jobId}`).update({ status: 'processing', lockedUntil: Timestamp.fromMillis(Date.now() - 1000) })
    await drive(crashed.jobId)
    expect(await claim(18)).toMatchObject({ jobId: crashed.jobId })
    expect(await round(crashed.jobId)).toMatchObject({ status: 'settled', claimed: 1, keptUnits: 1 })

    const dead = await quotedCreate('id', { registrationIds: ids(19) })
    await adminDb.doc(`printGenerationJobs/${dead.jobId}`).update({ status: 'failed', lockedUntil: null })
    expect(await consumed()).toBe(before + 2)
    const sw = await store.sweepPrintBadgeRounds()
    expect(sw.settled).toBeGreaterThanOrEqual(1)
    expect(await round(dead.jobId)).toMatchObject({ status: 'settled', keptUnits: 0, releasedUnits: 1, settledReason: 'sweep' })
    expect(await consumed()).toBe(before + 1)
    expect((await store.settlePrintBadgeRound(dead.jobId, 'again')).kind).toBe('already')

    // The job document deleted with its round still open (event deletion): the sweep releases the units.
    await addRegs(22, 22)
    const gone = await quotedCreate('id', { registrationIds: ids(22) })
    expect(await consumed()).toBe(before + 2)
    await adminDb.recursiveDelete(adminDb.doc(`printGenerationJobs/${gone.jobId}`))
    expect((await store.settlePrintBadgeRound(gone.jobId, 'no-hint')).kind).toBe('not_billed')
    await store.sweepPrintBadgeRounds()
    expect(await round(gone.jobId)).toMatchObject({ status: 'settled', keptUnits: 0, releasedUnits: 1, jobStatusAtSettle: 'deleted' })
    expect(await consumed()).toBe(before + 1)
  }, T)

  it('I · complimentary events record claims without units; non-chargeable asset types stay free', async () => {
    h.gateOpen = true
    await addRegs(20, 21)
    const before = await consumed()
    await adminDb.doc(`events/${EV}`).update({ printBadgeCommercial: { complimentary: true } })
    try {
      expect((await quote('id', { registrationIds: ids(20) })).body).toEqual({ success: true, mode: 'complimentary' })
      const c = await as(false, () => create('id', { registrationIds: ids(20, 0) }))
      expect(c.status).toBe(201)
      const jobId = c.body.jobId as string
      expect((await job(jobId))?.billing).toMatchObject({ mode: 'complimentary', round: 0 })
      await drive(jobId)
      expect(await claim(20)).toMatchObject({ mode: 'complimentary', round: null, roundId: null })
      expect(await item(jobId, 0)).toMatchObject({ billed: 'prior' })
      expect(await round(jobId)).toBeUndefined()
      expect(await consumed()).toBe(before)
    } finally {
      const { FieldValue } = await import('firebase-admin/firestore')
      await adminDb.doc(`events/${EV}`).update({ printBadgeCommercial: FieldValue.delete() })
    }
    const bib = await as(false, () => create('bib', { registrationIds: ids(21) }))
    expect(bib.status).toBe(201)
    expect((await job(bib.body.jobId as string))?.billing).toBeUndefined()
    await drive(bib.body.jobId as string)
    expect(await claim(21)).toBeUndefined()
    expect(await consumed()).toBe(before)
  }, T)

  it('K · fix 1: a draft cannot borrow another event slug to set the billing mode, spend its units or file claims', async () => {
    const { createPrintTemplate, savePrintDesign } = await import('@/lib/printAssets/firestore')
    const { PRINT_COLLECTIONS } = await import('@/lib/printAssets/collections')
    const badge = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge')!
    const [X, LEGACY, FOREIGN] = EXTRA_DRAFTS
    const [LEGACY_EV, OTHER_EV] = EXTRA_EVENTS
    // X points its (client-writable) slug at THIS workspace's event EV, which is stamped draftId = EV.
    await adminDb.doc(`users/${OWNER}/eventDrafts/${X}`).set({ status: 'published', eventDetails: { seo: { urlSlug: EV } } })
    await adminDb.doc(`eventServiceAllowances/${X}`).set({ draftId: X, organizerUid: OWNER, print_badges: { purchased: 50, consumed: 0, onExhausted: 'block' } })
    // LEGACY points at a same-owner event published before draftId stamps existed.
    await adminDb.doc(`users/${OWNER}/eventDrafts/${LEGACY}`).set({ status: 'published', eventDetails: { seo: { urlSlug: LEGACY_EV } } })
    await adminDb.doc(`events/${LEGACY_EV}`).set({ uid: OWNER, slug: LEGACY_EV })
    // FOREIGN points at another organizer's event (complimentary badges there).
    await adminDb.doc(`users/${OWNER}/eventDrafts/${FOREIGN}`).set({ status: 'published', eventDetails: { seo: { urlSlug: OTHER_EV } } })
    await adminDb.doc(`events/${OTHER_EV}`).set({ uid: `${P}-other-org`, draftId: FOREIGN, slug: OTHER_EV, printBadgeCommercial: { complimentary: true } })
    const tplFor = async (draftId: string) => {
      const t = await createPrintTemplate(OWNER, OWNER, { eventId: draftId, name: `K ${draftId}`, assetType: 'ID_CARD', canvas: badge.canvas })
      await savePrintDesign(t.id, badge.design, { actorUid: OWNER })
      return t.id
    }
    const tX = await tplFor(X), tL = await tplFor(LEGACY), tF = await tplFor(FOREIGN)
    const post = async (route: 'jobs' | 'quote', templateId: string, extra: Rec = {}) =>
      json(await R[route].POST(req({ templateId, filters: { registrationIds: ids(0, 1) }, ...extra })))
    const evConsumed = await consumed()

    for (const gate of [false, true]) {
      h.gateOpen = gate
      for (const t of [tX, tF]) {
        for (const r of ['quote', 'jobs'] as const) {
          const res = await post(r, t, { requestId: nextRq() })
          expect(res.status, `${r} gate=${gate}`).toBe(409)
          expect(String(res.body.error)).toMatch(/not published/)
        }
      }
    }
    // Nothing was spent or filed against either draft, and EV's ledger is untouched.
    expect(Number(((await adminDb.doc(`eventServiceAllowances/${X}`).get()).get('print_badges') as Rec).consumed)).toBe(0)
    for (const d of [X, FOREIGN]) {
      expect((await adminDb.collection('printBadgeClaims').where('eventId', '==', d).get()).size).toBe(0)
      expect((await adminDb.collection('printGenerationJobs').where('eventId', '==', d).get()).size).toBe(0)
    }
    expect(await consumed()).toBe(evConsumed)

    // A same-owner legacy event (no draftId stamp) keeps printing FREE, as before...
    h.gateOpen = false
    const free = await post('jobs', tL)
    expect(free.status).toBe(201)
    expect((await job(free.body.jobId as string))?.billing).toBeUndefined()
    // ...but cannot be BILLED: billing needs the event provably bound to this draft.
    h.gateOpen = true
    for (const r of ['quote', 'jobs'] as const) {
      const res = await post(r, tL, { requestId: nextRq() })
      expect(res.status, r).toBe(409)
      expect(res.body.code).toBe('EVENT_OWNERSHIP_UNVERIFIED')
    }
  }, T)

  it('L · fix 2: a duplicate create seeding after the first job finished leaves the finished card intact', async () => {
    h.gateOpen = true
    await addRegs(23, 23)
    const sel = { registrationIds: ids(23) }
    const requestId = nextRq()
    const q = await quote('id', sel)
    const before = await consumed()
    let firstJob = ''
    // The duplicate's checks are running (its job lookup found nothing) when the FIRST request
    // creates the job and the job renders + bills the card. The duplicate then seeds.
    h.onClaimRead = async () => {
      const first = await create('id', sel, { requestId, quote: q.body.quote })
      expect(first.status).toBe(201)
      firstJob = first.body.jobId as string
      await drive(firstJob)
      expect(await item(firstJob, 23)).toMatchObject({ rendered: true, billed: 'new' })
    }
    const dup = await create('id', sel, { requestId, quote: q.body.quote })
    expect(h.onClaimRead).toBeNull()
    expect(dup.status).toBe(200)
    expect(dup.body.jobId).toBe(firstJob)
    expect(await item(firstJob, 23)).toMatchObject({ rendered: true, billed: 'new', billedRound: 1, registrationId: rid(23) })
    expect(await claim(23)).toMatchObject({ jobId: firstJob })
    expect(await consumed()).toBe(before + 1)
  }, T)

  it('M · fix 3: a regenerate refused by the reopen transaction leaves every card ready and billing unchanged', async () => {
    h.gateOpen = true
    await addRegs(26, 27)
    const { jobId } = await quotedCreate('id', { registrationIds: ids(26, 27) })
    await drive(jobId)
    const before = { a: await item(jobId, 26), b: await item(jobId, 27), round: await round(jobId), used: await consumed() }
    expect(before.a).toMatchObject({ rendered: true, billed: 'new' })
    const { Timestamp } = await import('firebase-admin/firestore')
    // Between the regenerate's checks and its transaction, a worker leases the job.
    h.onClaimRead = async () => {
      await adminDb.doc(`printGenerationJobs/${jobId}`).update({ status: 'processing', lockedUntil: Timestamp.fromMillis(Date.now() + 60_000) })
    }
    const refused = await as(false, () => retry(jobId, { mode: 'regenerate' }))
    expect(h.onClaimRead).toBeNull()
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('Job is currently processing')
    expect(await item(jobId, 26)).toEqual(before.a)
    expect(await item(jobId, 27)).toEqual(before.b)
    expect(await round(jobId)).toEqual(before.round)
    expect(await round(jobId, 2)).toBeUndefined()
    expect(await consumed()).toBe(before.used)
    await adminDb.doc(`printGenerationJobs/${jobId}`).update({ status: 'completed', lockedUntil: null })
    // Accepted, the same regenerate resets and re-renders both cards for free.
    expect((await as(false, () => retry(jobId, { mode: 'regenerate' }))).status).toBe(200)
    await drive(jobId)
    expect((await job(jobId))?.status).toBe('completed')
    expect(await item(jobId, 26)).toMatchObject({ rendered: true, billed: 'prior' })
    expect(await consumed()).toBe(before.used)
  }, T)

  it('N · fix 4: a partial regenerate runs only its quoted target, so another unbilled failed card cannot take the unit', async () => {
    h.gateOpen = true
    // r28 sorts BEFORE r29, so without the scope r28 would be processed first and take the unit.
    await addRegs(28, 29, i => ({ attendee: { name: `Fail-Sentinel ${i}`, email: `f${i}.${P}@example.test` } }))
    h.failRender = true
    const before = await consumed()
    const { jobId } = await quotedCreate('id', { registrationIds: ids(28, 29) })
    await drive(jobId)
    expect(await round(jobId)).toMatchObject({ status: 'settled', keptUnits: 0, releasedUnits: 2 })
    h.failRender = false
    const body = { mode: 'regenerate', registrationIds: ids(29) }
    const need = await retry(jobId, body)
    expect(need.body.code).toBe('BILLING_QUOTE_REQUIRED')
    expect(need.body.quote).toMatchObject({ eligible: 1, chargeable: 1 })
    const ok = await retry(jobId, { ...body, quote: need.body.quote })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    await drive(jobId)
    expect((await job(jobId))?.runScope).toEqual(ids(29))
    expect(await claim(29)).toMatchObject({ jobId, round: 2 })
    expect(await item(jobId, 29)).toMatchObject({ rendered: true, billed: 'new', billedRound: 2 })
    expect(await claim(28)).toBeUndefined()
    expect(await item(jobId, 28)).toMatchObject({ rendered: false })
    expect(await round(jobId, 2)).toMatchObject({ status: 'settled', reserved: 1, claimed: 1, keptUnits: 1 })
    expect(await consumed()).toBe(before + 1)
    // A later full retry clears the scope (r28 is unbilled, so it needs its own quote).
    const full = await retry(jobId, { mode: 'retry' })
    expect(full.body.quote).toMatchObject({ chargeable: 1 })
    expect((await retry(jobId, { mode: 'retry', quote: full.body.quote })).status).toBe(200)
    await drive(jobId)
    expect((await job(jobId))?.runScope).toBeUndefined()
    expect(await claim(28)).toMatchObject({ jobId, round: 3 })
    expect(await consumed()).toBe(before + 2)
  }, T)

  it('O · a concurrent duplicate while the first request seeds can never add an attendee — even when eligibility changes', async () => {
    h.gateOpen = true
    await addRegs(30, 32, i => (i === 32 ? { status: 'pending' } : {}))
    const sel = { registrationIds: ids(30, 31, 32) }
    const requestId = nextRq()
    const key = gen.billedPrintJobId(OWNER, requestId)
    const q = await quote('id', sel)
    expect(q.body.quote).toMatchObject({ eligible: 2, chargeable: 2 })      // r32 is not eligible yet
    const before = await consumed()
    const during: Record<string, { status: number; body: Rec }> = {}
    // The first claim read is the original request's dry-run count; re-arm so the hook runs on its
    // FIRST SEEDED PAGE — it owns the request marker, its items are being written, no job exists yet.
    h.onClaimRead = async () => {
      h.onClaimRead = async () => {
        expect(await job(key)).toBeUndefined()
        expect((await adminDb.doc(`printJobRequests/${key}`).get()).get('status')).toBe('seeding')
        // The eligible set changes and the count stays 2: r32 is confirmed, r31 is cancelled.
        await adminDb.doc(`registrations/${rid(32)}`).update({ status: 'confirmed' })
        await adminDb.doc(`registrations/${rid(31)}`).update({ status: 'cancelled' })
        during.dup = await create('id', sel, { requestId, quote: q.body.quote })
        during.other = await create('id', { registrationIds: ids(30) }, { requestId, quote: q.body.quote })
      }
    }
    const first = await create('id', sel, { requestId, quote: q.body.quote })
    expect(h.onClaimRead).toBeNull()
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    expect(first.body.jobId).toBe(key)
    expect(during.dup.status).toBe(409); expect(during.dup.body.code).toBe('REQUEST_IN_PROGRESS')
    expect(during.other.status).toBe(409); expect(during.other.body.code).toBe('REQUEST_ID_REUSED')
    const itemIds = async () => (await adminDb.collection(`printGenerationJobs/${key}/items`).get()).docs.map(d => d.id).sort()
    expect(await itemIds()).toEqual(ids(30, 31))                                // the ORIGINAL selection only

    // Once created: the matching duplicate gets the job back UNCHANGED; a different payload is refused.
    const snap = await job(key)
    const again = await create('id', sel, { requestId, quote: q.body.quote })
    expect(again.status).toBe(200); expect(again.body.jobId).toBe(key)
    expect(await job(key)).toEqual(snap)
    expect(await itemIds()).toEqual(ids(30, 31))
    const other = await create('id', { registrationIds: ids(30) }, { requestId, quote: q.body.quote })
    expect(other.status).toBe(409); expect(other.body.code).toBe('REQUEST_ID_REUSED')

    await drive(key)
    expect(await claim(30)).toMatchObject({ jobId: key })
    expect(await claim(31)).toBeUndefined()                 // cancelled before its card rendered
    expect(await claim(32)).toBeUndefined()                 // never part of the job: no card, no claim of any kind
    expect(await item(key, 32)).toBeUndefined()
    expect(await round(key)).toMatchObject({ status: 'settled', reserved: 2, claimed: 1, keptUnits: 1, releasedUnits: 1 })
    expect(await consumed()).toBe(before + 1)
  }, T)

  it('P · request recovery: a failed seeder releases the requestId; a stalled one is taken over into a NEW job id and fenced out', async () => {
    h.gateOpen = true
    await addRegs(33, 34)
    const before = await consumed()

    // 1 · A failure after the claim RELEASES the marker (never deletes it); the retry takes over at once.
    const rqA = nextRq(), keyA = gen.billedPrintJobId(OWNER, rqA)
    const selA = { registrationIds: ids(33) }
    const qA = await quote('id', selA)
    h.onClaimRead = async () => { h.onClaimRead = async () => { throw new Error('seeding storage failure') } }
    await expect(create('id', selA, { requestId: rqA, quote: qA.body.quote })).rejects.toThrow('seeding storage failure')
    expect(await adminDb.doc(`printJobRequests/${keyA}`).get().then(s => s.get('status'))).toBe('released')
    expect(await job(keyA)).toBeUndefined()
    const retried = await create('id', selA, { requestId: rqA, quote: qA.body.quote })
    expect(retried.status).toBe(201)
    expect(retried.body.jobId).toBe(`${keyA}_a2`)
    expect(await adminDb.doc(`printJobRequests/${keyA}`).get().then(s => s.data())).toMatchObject({ status: 'created', attempt: 2, jobId: `${keyA}_a2` })
    expect((await create('id', selA, { requestId: rqA, quote: qA.body.quote })).body.jobId).toBe(`${keyA}_a2`)

    // 2 · A seeder that stalls past its lease is taken over; the stalled seeder is fenced out.
    const rqB = nextRq(), keyB = gen.billedPrintJobId(OWNER, rqB)
    const selB = { registrationIds: ids(34) }
    const qB = await quote('id', selB)
    let takeover: { status: number; body: Rec } | null = null
    let staleToken = ''
    h.onClaimRead = async () => {
      h.onClaimRead = async () => {
        staleToken = String((await adminDb.doc(`printJobRequests/${keyB}`).get()).get('token'))
        await adminDb.doc(`printJobRequests/${keyB}`).update({ leaseUntil: Date.now() - 1 })   // the lease ran out
        takeover = await create('id', selB, { requestId: rqB, quote: qB.body.quote })
      }
    }
    const stalled = await create('id', selB, { requestId: rqB, quote: qB.body.quote })
    expect(stalled.status).toBe(409); expect(stalled.body.code).toBe('REQUEST_IN_PROGRESS')
    expect(takeover!.status).toBe(201); expect(takeover!.body.jobId).toBe(`${keyB}_a2`)
    expect(await job(keyB)).toBeUndefined()                      // the stalled seeder created nothing
    // A stalled seeder reaching the create transaction is refused by the fence.
    const lost = await store.createBilledJob({
      jobId: keyB, seed: {}, total: 1, mode: 'paid', draftId: EV, organizerUid: OWNER, eventSlug: EV, assetType: 'ID_CARD',
      createdBy: OWNER, chargeable: 1, request: { key: keyB, token: staleToken },
      quote: { eligible: 1, previouslyBilled: 0, chargeable: 1, unitPricePaise: 20, priceSource: null, quoteHash: null, quotedChargeable: null, quotedAt: null },
    })
    expect(lost.kind).toBe('lost')
    expect(await job(keyB)).toBeUndefined()
    expect(await consumed()).toBe(before + 2)                    // one reservation per request, no more
    await drive(retried.body.jobId as string); await drive(`${keyB}_a2`)
    expect(await claim(33)).toMatchObject({ jobId: `${keyA}_a2` })
    expect(await claim(34)).toMatchObject({ jobId: `${keyB}_a2` })
  }, T)

  it('Q · regeneration hold: a cancel during the hold cannot be undone; an expired hold is recovered and keeps its run scope', async () => {
    h.gateOpen = true
    // 1 · Cancel while a regenerate holds the job.
    await addRegs(35, 35)
    const A = await quotedCreate('id', { registrationIds: ids(35) })
    await drive(A.jobId)
    const held = await store.reopenBilledJob({ jobId: A.jobId, expectedRound: 1, expectSettled: true, chargeable: 0, createdBy: OWNER, quote: null, holdMs: 60_000, runScope: null })
    expect(held.kind).toBe('reopened')
    const tagA = (held as { holdTag: number }).holdTag
    expect((await job(A.jobId))?.status).toBe('processing')
    expect((await retry(A.jobId, { mode: 'retry' })).body.error).toBe('Job is currently processing')
    expect((await as(false, () => cancel(A.jobId))).status).toBe(200)
    expect(await store.releaseReopenHold(A.jobId, tagA)).toBe(false)      // the stale caller's hand-off
    await gen.processPrintGenerationChunk(A.jobId)                          // what the cron would do
    await store.sweepPrintBadgeRounds()
    expect((await job(A.jobId))?.status).toBe('cancelled')
    expect(await item(A.jobId, 35)).toMatchObject({ rendered: true, billed: 'new' })

    // 2 · The caller stops after the reopen was accepted (no reset, no release): the hold expires
    //     and the worker the cron runs recovers the job — inside its run scope only.
    await addRegs(36, 37, i => ({ attendee: { name: `Fail-Sentinel ${i}`, email: `q${i}.${P}@example.test` } }))
    h.failRender = true
    const B = await quotedCreate('id', { registrationIds: ids(36, 37) })
    await drive(B.jobId)
    h.failRender = false
    const before = await consumed()
    const r = await store.reopenBilledJob({ jobId: B.jobId, expectedRound: 1, expectSettled: true, chargeable: 1, createdBy: OWNER, quote: null, holdMs: 1, runScope: ids(37) })
    expect(r.kind).toBe('reopened')
    expect(await consumed()).toBe(before + 1)
    await new Promise(res => setTimeout(res, 5))                          // the 1 ms hold has expired
    await drive(B.jobId)
    expect((await job(B.jobId))?.status).toBe('completed')
    expect(await claim(37)).toMatchObject({ jobId: B.jobId, round: 2 })
    expect(await claim(36)).toBeUndefined()                               // outside the scope: never run
    expect(await item(B.jobId, 36)).toMatchObject({ rendered: false })
    expect(await round(B.jobId, 2)).toMatchObject({ status: 'settled', reserved: 1, claimed: 1, keptUnits: 1 })
    expect(await store.releaseReopenHold(B.jobId, (r as { holdTag: number }).holdTag)).toBe(false)
    expect((await job(B.jobId))?.status).toBe('completed')
    expect(await consumed()).toBe(before + 1)
  }, T)

  // ── RD-PRINT-P8 (W5) · the paid-generation pilot ─────────────────────────────────────────────────
  it('P8-G1 · gate CLOSED: no pilot read at all — the free path is exactly as before', async () => {
    h.gateOpen = false; h.pilot = 'none'
    const reads = h.pilotReads
    try {
      expect((await quote('id', { registrationIds: ids(40) })).body).toEqual({ success: true, mode: 'free' })
      const c = await as(false, () => create('id', { registrationIds: ids(0) }))
      expect(c.status).toBe(201)
      expect((await job(c.body.jobId as string))?.billing).toBeUndefined()
      expect(h.pilotReads).toBe(reads)
    } finally { h.pilot = 'all' }
  }, T)

  it('P8-G2 · gate OPEN, organizer outside the pilot: free — no requestId / quote / owner / units, no round, no claim', async () => {
    h.gateOpen = true; h.pilot = 'none'
    await addRegs(40, 41)
    const before = await consumed()
    try {
      expect((await quote('id', { registrationIds: ids(40, 41) })).body).toEqual({ success: true, mode: 'free' })
      const c = await as(false, () => create('id', { registrationIds: ids(40, 41) }))      // staff, no requestId: the free path
      expect(c.status, JSON.stringify(c.body)).toBe(201)
      const jobId = c.body.jobId as string
      expect((await job(jobId))?.billing).toBeUndefined()
      await drive(jobId)
      expect((await job(jobId))?.status).toBe('completed')
      expect((await item(jobId, 40))?.rendered).toBe(true)
      expect(await claim(40)).toBeUndefined()
      expect(await round(jobId)).toBeUndefined()
      expect(await consumed()).toBe(before)
      // The organizer summary agrees: free because outside the pilot.
      const { getPrintBadgeSummary } = await import('@/lib/printAssets/badgeBilling/summary')
      const sum = await getPrintBadgeSummary({ slug: EV, workspaceUid: OWNER, isOwner: true })
      expect(sum.ok && sum.summary.billing).toMatchObject({ mode: 'free', reason: 'not_in_pilot' })
    } finally { h.pilot = 'all' }
  }, T)

  it('P8-G3 · gate OPEN, pilot setting unreadable: 503 on quote and create — never a silent free pass; nothing written', async () => {
    h.gateOpen = true; h.pilot = 'unavailable'
    const jobsBefore = (await adminDb.collection('printGenerationJobs').where('eventSlug', '==', EV).get()).size
    try {
      const q = await quote('id', { registrationIds: ids(40) })
      expect(q.status).toBe(503); expect(q.body.code).toBe('BILLING_UNAVAILABLE')
      const c = await as(false, () => create('id', { registrationIds: ids(40) }))           // a non-pilot staff create too
      expect(c.status).toBe(503); expect(c.body.code).toBe('BILLING_UNAVAILABLE')
      expect((await adminDb.collection('printGenerationJobs').where('eventSlug', '==', EV).get()).size).toBe(jobsBefore)
    } finally { h.pilot = 'all' }
  }, T)

  it('P8-G4 · a PAID job cannot be reopened once its organizer leaves the pilot (PILOT_REMOVED); its billing is untouched', async () => {
    h.gateOpen = true; h.pilot = 'all'
    await addRegs(42, 43)
    const lp = Number(((await adminDb.doc(`eventServiceAllowances/${EV}`).get()).get('print_badges') as Rec).purchased ?? 0)
    await setPurchased(lp + 5)
    const { jobId } = await quotedCreate('id', { registrationIds: ids(42, 43) })
    await drive(jobId)
    expect(await round(jobId)).toMatchObject({ status: 'settled' })
    const billingBefore = (await job(jobId))?.billing
    const used = await consumed()
    h.pilot = 'none'
    try {
      for (const mode of ['retry', 'regenerate'] as const) {
        const r = await retry(jobId, { mode })
        expect(r.status, mode).toBe(409); expect(r.body.code).toBe('PILOT_REMOVED')
      }
      h.pilot = 'unavailable'
      const u = await retry(jobId, { mode: 'regenerate' })
      expect(u.status).toBe(503); expect(u.body.code).toBe('BILLING_UNAVAILABLE')
      expect((await job(jobId))?.billing).toEqual(billingBefore)               // never switched in place
      expect(await round(jobId, 2)).toBeUndefined()
      expect(await consumed()).toBe(used)
      // Outside the pilot the organizer starts a NEW job — free.
      h.pilot = 'none'
      const c = await create('id', { registrationIds: ids(42, 43) })
      expect(c.status).toBe(201)
      expect((await job(c.body.jobId as string))?.billing).toBeUndefined()
    } finally { h.pilot = 'all' }
  }, T)

  it('P8.2-G5 · job CREATE reads the pilot fresh (a failed fresh read ⇒ 503, nothing written, even when the cache would allow it); the quote preview stays cached', async () => {
    h.gateOpen = true; h.pilot = 'all'; h.pilotOpts = []
    await quote('id', { registrationIds: ids(40) })
    expect(h.pilotOpts).toEqual([{ fresh: false }])
    h.pilotOpts = []
    await create('id', { registrationIds: ids(40) })                               // paid path ⇒ 400 REQUEST_ID_REQUIRED, after the read
    expect(h.pilotOpts).toEqual([{ fresh: true }])
    h.pilot = 'freshUnavailable'
    const jobsBefore = (await adminDb.collection('printGenerationJobs').where('eventSlug', '==', EV).get()).size
    try {
      expect((await quote('id', { registrationIds: ids(40) })).status).toBe(200)       // the cached read still answers a preview
      const c = await create('id', { registrationIds: ids(40) }, { requestId: nextRq() })
      expect(c.status).toBe(503); expect(c.body.code).toBe('BILLING_UNAVAILABLE')
      expect((await adminDb.collection('printGenerationJobs').where('eventSlug', '==', EV).get()).size).toBe(jobsBefore)
    } finally { h.pilot = 'all' }
  }, T)

  it('P8.3-G6 · reopening a PAID job reads the pilot FRESH: removed ⇒ PILOT_REMOVED even while the cache still lists the organizer; a failed fresh read ⇒ 503; billing untouched', async () => {
    h.gateOpen = true; h.pilot = 'all'
    await addRegs(44, 45)
    const lp = Number(((await adminDb.doc(`eventServiceAllowances/${EV}`).get()).get('print_badges') as Rec).purchased ?? 0)
    await setPurchased(lp + 5)
    const { jobId } = await quotedCreate('id', { registrationIds: ids(44, 45) })
    await drive(jobId)
    expect(await round(jobId)).toMatchObject({ status: 'settled' })
    const billingBefore = (await job(jobId))?.billing
    const used = await consumed()
    try {
      h.pilot = 'freshRemoved'; h.pilotOpts = []
      for (const mode of ['retry', 'regenerate'] as const) {
        const r = await retry(jobId, { mode })
        expect(r.status, mode).toBe(409); expect(r.body.code).toBe('PILOT_REMOVED')
      }
      expect(h.pilotOpts).toEqual([{ fresh: true }, { fresh: true }])
      h.pilot = 'freshUnavailable'
      const u = await retry(jobId, { mode: 'regenerate' })
      expect(u.status).toBe(503); expect(u.body.code).toBe('BILLING_UNAVAILABLE')   // never the cached membership
      expect((await job(jobId))?.billing).toEqual(billingBefore)
      expect(await round(jobId, 2)).toBeUndefined()
      expect(await consumed()).toBe(used)
      // The quote preview stays on the cached read (the stale cache still lists the organizer).
      h.pilot = 'freshRemoved'; h.pilotOpts = []
      expect((await quote('id', { registrationIds: ids(44) })).status).toBe(200)
      expect(h.pilotOpts).toEqual([{ fresh: false }])
    } finally { h.pilot = 'all' }
  }, T)

  it('J · reconciliation is read-only and finds every broken invariant', async () => {
    const clean = await recon.reconcilePrintBadgeUsage(EV)
    expect(clean.problems).toEqual([])
    expect(clean.ok).toBe(true)
    expect(clean.usageTotal).toBe(clean.ledgerConsumed)

    const { FieldValue } = await import('firebase-admin/firestore')
    await adminDb.doc(`eventServiceAllowances/${EV}`).update({ 'print_badges.consumed': FieldValue.increment(1) })
    const claimRef = adminDb.doc(`printBadgeClaims/${EV}__${rid(3)}`)
    const saved = (await claimRef.get()).data()!
    await claimRef.delete()
    try {
      const bad = await recon.reconcilePrintBadgeUsage(EV)
      const codes = new Set(bad.problems.map(p => p.code))
      expect(bad.ok).toBe(false)
      for (const c of ['LEDGER_USAGE_MISMATCH', 'ROUND_SETTLEMENT_MISMATCH', 'CLAIMS_WITHOUT_ROUND', 'RENDERED_WITHOUT_CLAIM']) expect(codes, c).toContain(c)
    } finally {
      await adminDb.doc(`eventServiceAllowances/${EV}`).update({ 'print_badges.consumed': FieldValue.increment(-1) })
      await claimRef.set(saved)
    }
    expect((await recon.reconcilePrintBadgeUsage(EV)).ok).toBe(true)
  }, T)
})
