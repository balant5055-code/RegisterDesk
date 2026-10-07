// RD-PRICING-SAFETY-01 — ordinary "Save Changes" on a PUBLISHED event cannot change what an
// attendee is charged, or whether they are charged at all.
//
// ═══ THE HOLE ════════════════════════════════════════════════════════════════
// POST /api/organizer/events/[eventId]/save-changes copies the organizer's DRAFT `pricing`
// wholesale onto the live `events/{slug}` document. The draft is client-writable (the draft
// rules block only lifecycle/billing keys), and the only pricing check was pass quantity ≥
// sold. PATCH /edit forbids prices and the pricing model after publish; save-changes did not —
// so a live ticket price, a pass's free/paid type, the event's free/paid model, early-bird
// pricing and the fee model could all be changed on a live event with one Save.
//
// Every case below drives the REAL route against REAL Firestore, with a draft id that is NOT
// the public slug (the production shape — a test where they are equal proves nothing about the
// live-document lookup). Auth is stubbed to a chosen organizer; everything else is production.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

const OWNER    = `ps01-owner-${process.pid}`
const INTRUDER = `ps01-intruder-${process.pid}`
const DRAFT    = `Ps01DraftId${process.pid}`
const SLUG     = `city-marathon-ps01-${process.pid}`

const auth = vi.hoisted(() => ({ uid: '' }))
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '', callerUid: auth.uid, workspaceUid: auth.uid,
    role: 'owner', permissions: [], isOwner: true, eventIds: [], isStaffCredential: false,
  }),
}))

const PAID_PASS = {
  id: 'pass_10k', name: '10K', code: 'TENK', description: 'Ten kilometres.', type: 'paid', price: 1500,
  earlyBirdEnabled: true, earlyBirdPrice: 1200, earlyBirdEndDate: '2099-01-01', unlimited: false, quantity: 500,
  minPurchase: 1, maxPurchase: 5, hideWhenSoldOut: false, salesStartDate: '2026-01-01', salesEndDate: '2099-12-30',
  showRemainingSeats: true, visibility: 'public', featured: false, benefits: ['Medal'], customBenefits: [],
  raceDetails: null, eventType: 'sports', eventSubtype: 'running',
  advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] }, status: 'active',
}
const FREE_PASS = { ...PAID_PASS, id: 'pass_fun', name: 'Fun Run', code: 'FUN', type: 'free', price: 0,
  earlyBirdEnabled: false, earlyBirdPrice: null, earlyBirdEndDate: '' }

const pricingOf = (kind: 'paid' | 'free', passes = [kind === 'paid' ? PAID_PASS : FREE_PASS]) => ({
  eventType: kind, feeModel: 'organizer_absorbs', estimatedRegistrations: 100, passes,
  registrationOpenDate: '', registrationEndDate: '', showRemainingSeats: true,
  whatsappEnabled: false, smsEnabled: false, certEnabled: false,
  advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] },
})
const details = (name = 'City Marathon') => ({
  info: { name, tagline: 'Run the city', description: 'An event.' },
  schedule: { startDate: '2099-12-31', startTime: '06:00', endDate: '2099-12-31', endTime: '12:00', timezone: 'Asia/Kolkata' },
  venue: { type: 'physical', physical: { name: 'Cubbon Park', city: 'Bengaluru', addressLine1: 'MG Road' } },
  organizer: { name: 'Org', email: 'o@example.test' },
  seo: { urlSlug: SLUG },
})

const post = () => new NextRequest('http://x/api/t', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: '{}' })
const patch = (body: unknown) => new NextRequest('http://x/api/t', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body) })

describeEmu('RD-PRICING-SAFETY-01 · published pricing is frozen on ordinary Save Changes', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let saveChanges: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>

  const draftRef = (uid = OWNER, id = DRAFT) => adminDb.doc(`users/${uid}/eventDrafts/${id}`)
  const liveRef  = () => adminDb.doc(`events/${SLUG}`)
  const live     = async () => (await liveRef().get()).data()!

  /** A published event: draft (owner) + live doc at a DIFFERENT id (the slug). */
  async function seedPublished(kind: 'paid' | 'free') {
    const pricing = pricingOf(kind)
    await draftRef().set({ uid: OWNER, status: 'published', lifecycleStatus: 'published', eventType: 'sports',
      pricing, eventDetails: details(), registrationForm: { fields: [] }, accessControl: { type: 'open' } })
    await liveRef().set({ uid: OWNER, draftId: DRAFT, slug: SLUG, lifecycleStatus: 'published', totalCapacity: 500,
      pricing, eventDetails: details(), registrationForm: { fields: [] }, accessControl: { type: 'open' } })
  }
  /** What a browser can do to its own draft through the client SDK (rules allow `pricing`). */
  const editDraftPricing = async (fn: (p: ReturnType<typeof pricingOf>) => unknown) => {
    const cur = (await draftRef().get()).data()!.pricing as ReturnType<typeof pricingOf>
    await draftRef().set({ pricing: fn(JSON.parse(JSON.stringify(cur))) }, { merge: true })
  }
  const save = (id = DRAFT) => saveChanges(post(), { params: Promise.resolve({ eventId: id }) })

  async function wipe() {
    for (const p of [`events/${SLUG}`, `registrationCounters/${SLUG}`]) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    await draftRef().delete().catch(() => null)
    await draftRef(INTRUDER, `Ps01Intruder${process.pid}`).delete().catch(() => null)
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST: saveChanges } = await import('@/app/api/organizer/events/[eventId]/save-changes/route'))
  }, T)
  afterAll(wipe, T)
  beforeEach(async () => { auth.uid = OWNER; await wipe() }, T)

  // ═══ 1 · price ═══════════════════════════════════════════════════════════════
  it('1 · a published PAID event: Save Changes cannot alter a ticket price', async () => {
    await seedPublished('paid')
    await editDraftPricing(p => { (p.passes[0] as { price: number }).price = 1; return p })
    const res = await save()
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error?: string }).error).toMatch(/price/i)
    expect(((await live()).pricing as { passes: Array<{ price: number }> }).passes[0].price).toBe(1500)
  }, T)

  it('1b · …nor the early-bird price, its end date, or switching early bird on/off', async () => {
    for (const mutate of [
      (x: Record<string, unknown>) => { x.earlyBirdPrice = 1 },
      (x: Record<string, unknown>) => { x.earlyBirdEndDate = '2099-12-31' },
      (x: Record<string, unknown>) => { x.earlyBirdEnabled = false },
    ]) {
      await seedPublished('paid')
      await editDraftPricing(p => { mutate(p.passes[0] as Record<string, unknown>); return p })
      expect((await save()).status).toBe(409)
      expect(((await live()).pricing as { passes: Array<Record<string, unknown>> }).passes[0]).toMatchObject({
        earlyBirdEnabled: true, earlyBirdPrice: 1200, earlyBirdEndDate: '2099-01-01' })
    }
  }, T)

  // ═══ 2 / 3 · free ↔ paid ══════════════════════════════════════════════════════
  it('2 · a published FREE event cannot be switched to paid (event model or pass type)', async () => {
    await seedPublished('free')
    await editDraftPricing(p => { p.eventType = 'paid'; return p })
    expect((await save()).status).toBe(409)
    await seedPublished('free')
    await editDraftPricing(p => { Object.assign(p.passes[0], { type: 'paid', price: 999 }); return p })
    expect((await save()).status).toBe(409)
    const lp = (await live()).pricing as { eventType: string; passes: Array<{ type: string; price: number }> }
    expect(lp.eventType).toBe('free')
    expect(lp.passes[0]).toMatchObject({ type: 'free', price: 0 })
  }, T)

  it('3 · a published PAID event cannot be switched to free', async () => {
    await seedPublished('paid')
    await editDraftPricing(p => { p.eventType = 'free'; Object.assign(p.passes[0], { type: 'free', price: 0 }); return p })
    expect((await save()).status).toBe(409)
    const lp = (await live()).pricing as { eventType: string; passes: Array<{ type: string; price: number }> }
    expect(lp.eventType).toBe('paid')
    expect(lp.passes[0]).toMatchObject({ type: 'paid', price: 1500 })
  }, T)

  // RD-EVENT-COMMERCE-05E (approved) — the fee model left this list: it is organizer-editable after
  // publish through PATCH /edit only. Save Changes neither refuses nor copies it (see 3c).
  it('3b · a new sellable pass, a removed pass and pricing-level taxes/fees are refused too', async () => {
    for (const mutate of [
      (p: ReturnType<typeof pricingOf>) => { p.passes.push({ ...PAID_PASS, id: 'pass_new', price: 5 }) },
      (p: ReturnType<typeof pricingOf>) => { p.passes = [] },
      (p: ReturnType<typeof pricingOf>) => { (p.advancedSettings.fees as unknown[]).push({ label: 'x', amount: 10 }) },
    ]) {
      await seedPublished('paid')
      await editDraftPricing(p => { mutate(p); return p })
      expect((await save()).status).toBe(409)
      expect(((await live()).pricing as { passes: unknown[] }).passes).toHaveLength(1)
    }
  }, T)

  it('RD-EVENT-COMMERCE-05E · 3c · a draft fee-model difference is NOT copied live by Save Changes (only PATCH /edit changes it)', async () => {
    await seedPublished('paid')
    await editDraftPricing(p => { p.feeModel = 'attendee_pays'; return p })
    const res = await save()
    expect(res.status).toBe(200)
    expect(((await live()).pricing as { feeModel: string }).feeModel).toBe('organizer_absorbs')
    // …while a price change in the same draft is still refused
    await editDraftPricing(p => { (p.passes[0] as { price: number }).price = 1; return p })
    expect((await save()).status).toBe(409)
  }, T)

  // ═══ 4 · ordinary edits still save ════════════════════════════════════════════
  it('4 · non-commercial edits (description, venue, pass name/benefits/sales window, quantity up) still save', async () => {
    await seedPublished('paid')
    await draftRef().set({ eventDetails: { ...details('City Marathon 2099'), venue: { type: 'physical', physical: { name: 'Palace Grounds', city: 'Bengaluru', addressLine1: 'Jayamahal' } } } }, { merge: true })
    await editDraftPricing(p => {
      Object.assign(p.passes[0], { name: '10K Open', description: 'Now with a medal.', benefits: ['Medal', 'Tee'], salesEndDate: '2099-12-29', quantity: 600, featured: true })
      p.whatsappEnabled = true      // communication toggle — not a price
      return p
    })
    const res = await save()
    expect(res.status).toBe(200)
    const l = await live()
    expect((l.eventDetails as { info: { name: string } }).info.name).toBe('City Marathon 2099')
    expect((l.pricing as { passes: Array<Record<string, unknown>> }).passes[0]).toMatchObject({
      name: '10K Open', quantity: 600, price: 1500, earlyBirdPrice: 1200, benefits: ['Medal', 'Tee'] })
    expect((l.eventDetails as { seo: { urlSlug: string } }).seo.urlSlug).toBe(SLUG)   // identity still frozen
  }, T)

  it('RD-EVENT-COMMERCE-05D · Save Changes on a live event: saved, NOT republished, no order, draft stamp advanced (client re-aligns)', async () => {
    await seedPublished('paid')
    const before = await live()
    const draftBefore = (await draftRef().get()).data()!
    await draftRef().set({ eventDetails: details('Saved Title 2099') }, { merge: true })
    const res = await save()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })        // the ONLY success signal the page toasts on
    const after = await live()
    expect((after.eventDetails as { info: { name: string } }).info.name).toBe('Saved Title 2099')   // visible on the live page
    expect(after.lifecycleStatus).toBe('published')                                                 // not republished
    expect(after.publishedAt ?? null).toEqual(before.publishedAt ?? null)
    expect((await adminDb.collection('licenseOrders').where('eventId', 'in', [DRAFT, SLUG]).get()).size).toBe(0)
    // The server moved the DRAFT's updatedAt — why the page re-aligns its draft baseline on success.
    const draftAfter = (await draftRef().get()).data()!
    expect(draftAfter.updatedAt).toBeDefined()
    expect(JSON.stringify(draftAfter.updatedAt)).not.toBe(JSON.stringify(draftBefore.updatedAt))
    // A failed save (a refused commercial change) leaves the live doc and the organizer's draft values intact.
    // (RD-EVENT-COMMERCE-05E: a ticket price, since the fee model is no longer refused here.)
    await editDraftPricing(p => { (p.passes[0] as { price: number }).price = 1; return p })
    const refused = await save()
    expect(refused.status).toBe(409)
    expect(((await draftRef().get()).data()!.pricing as { passes: Array<{ price: number }> }).passes[0].price).toBe(1)   // unsaved value kept
    expect(((await live()).pricing as { passes: Array<{ price: number }> }).passes[0].price).toBe(1500)
  }, T)

  it('4b · a legacy live doc with no fee model does not read as a fee-model change', async () => {
    await seedPublished('paid')
    const lp = (await live()).pricing as Record<string, unknown>
    delete lp.feeModel
    await liveRef().set({ pricing: lp }, { merge: false })
    await liveRef().set({ uid: OWNER, draftId: DRAFT, slug: SLUG, lifecycleStatus: 'published', totalCapacity: 500,
      pricing: lp, eventDetails: details(), registrationForm: { fields: [] }, accessControl: { type: 'open' } })
    expect((await save()).status).toBe(200)
    // RD-EVENT-COMMERCE-05E — the live fee model is preserved exactly: absent stays absent.
    expect('feeModel' in ((await live()).pricing as Record<string, unknown>)).toBe(false)
  }, T)

  it('4c · the existing sold-count guard still applies (quantity below sold is refused)', async () => {
    await seedPublished('paid')
    await adminDb.doc(`registrationCounters/${SLUG}`).set({ totalCount: 50, passCounts: { pass_10k: 50 } })
    await editDraftPricing(p => { (p.passes[0] as { quantity: number }).quantity = 10; return p })
    expect((await save()).status).toBe(400)
  }, T)

  // ═══ 5 · another organizer ═══════════════════════════════════════════════════
  it('5 · another organizer cannot alter this event — neither by id nor via a draft pointing at its slug', async () => {
    await seedPublished('paid')
    auth.uid = INTRUDER
    expect((await save()).status).toBe(404)                              // not their draft
    const hisDraft = `Ps01Intruder${process.pid}`
    await draftRef(INTRUDER, hisDraft).set({ uid: INTRUDER, status: 'published', pricing: pricingOf('paid', [{ ...PAID_PASS, price: 1 }]),
      eventDetails: details('Hijack') })                                   // seo.urlSlug = the victim's slug
    const res = await save(hisDraft)
    expect(res.status).not.toBe(200)
    expect(((await live()).pricing as { passes: Array<{ price: number }> }).passes[0].price).toBe(1500)
    expect((await live()).eventDetails).toMatchObject({ info: { name: 'City Marathon' } })
  }, T)

  // ═══ 6 · forged payload ══════════════════════════════════════════════════════
  it('6 · a forged request body cannot bypass the check (the route reads the draft, and validates it)', async () => {
    await seedPublished('paid')
    await editDraftPricing(p => { (p.passes[0] as { price: number }).price = 1; return p })
    const forged = new NextRequest('http://x/api/t', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ allowPricingChange: true, force: true, status: 'draft', pricing: pricingOf('paid') }) })
    const res = await saveChanges(forged, { params: Promise.resolve({ eventId: DRAFT }) })
    expect(res.status).toBe(409)
    expect(((await live()).pricing as { passes: Array<{ price: number }> }).passes[0].price).toBe(1500)
  }, T)

  it('6b · a draft that claims status "draft" cannot be pushed live through this route at all', async () => {
    await seedPublished('paid')
    await draftRef().set({ status: 'draft' }, { merge: true })
    expect((await save()).status).toBe(400)
  }, T)

  // ═══ 7 · stale / concurrent ══════════════════════════════════════════════════
  it('7 · validated against the LIVE document, not a stale draft copy of it', async () => {
    // The draft's own "previous" pricing is irrelevant: the live price is the baseline. Here the
    // draft is left untouched at 1500 while the live doc sits at 1800 (e.g. an admin correction);
    // saving would silently REVERT the live price to 1500 — that is a price change and is refused.
    await seedPublished('paid')
    const lp = (await live()).pricing as { passes: Array<{ price: number }> }
    lp.passes[0].price = 1800
    await liveRef().set({ pricing: lp }, { merge: true })
    expect((await save()).status).toBe(409)
    expect(((await live()).pricing as { passes: Array<{ price: number }> }).passes[0].price).toBe(1800)
  }, T)

  it('7b · concurrent saves racing a price change: the live price never moves', async () => {
    await seedPublished('paid')
    const ok = saveChanges(post(), { params: Promise.resolve({ eventId: DRAFT }) })
    const flip = editDraftPricing(p => { (p.passes[0] as { price: number }).price = 1; return p })
    const again = flip.then(() => save())
    const results = await Promise.all([ok, again])
    for (const r of results) expect([200, 409]).toContain(r.status)
    expect(((await live()).pricing as { passes: Array<{ price: number }> }).passes[0].price).toBe(1500)
  }, T)

  // ═══ 9 · the dedicated edit route is unchanged ═══════════════════════════════
  it('9 · PATCH /edit still refuses price keys and still allows a capacity increase', async () => {
    await seedPublished('paid')
    const { PATCH } = await import('@/app/api/organizer/events/[eventId]/edit/route')
    const refused = await PATCH(patch({ passPrice: 1 }), { params: Promise.resolve({ eventId: DRAFT }) })
    expect(refused.status).toBe(400)
    const ok = await PATCH(patch({ passCapacityUpdates: [{ passId: 'pass_10k', newCapacity: 700 }] }), { params: Promise.resolve({ eventId: DRAFT }) })
    expect(ok.status).toBe(200)
    const lp = (await live()).pricing as { passes: Array<{ quantity: number; price: number }> }
    expect(lp.passes[0]).toMatchObject({ quantity: 700, price: 1500 })
  }, T)
})
