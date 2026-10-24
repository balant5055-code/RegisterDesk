// RD-FEE-RESTORE-02 — the organizer's Fee Collection Method must reach the LIVE event.
//
// ═══ THE REPORTED DEFECT ═════════════════════════════════════════════════════
// On a PUBLISHED event an organizer selected "Attendee Pays Fees" in the wizard. The builder's
// own preview showed the attendee paying ₹1.04 on a ₹1 ticket. The attendee's checkout summary
// showed ₹1 — the ticket only, i.e. organizer-absorbs.
//
// Both surfaces were telling the truth about DIFFERENT DOCUMENTS. The wizard selector persists
// through `updateDraft`, which writes `users/{uid}/eventDrafts/{draftId}` and previews from it.
// An attendee is priced from `events/{slug}`. For an unpublished draft that gap closes at
// publish (which copies pricing wholesale); for an event that is ALREADY PUBLISHED nothing in
// the selector's own path writes the live document, so the choice stayed invisible to checkout.
//
// These cases pin the three facts that matter, in the order they were established:
//   1. the draft-only state really does price as organizer-absorbs (the reported mismatch)
//   2. Save Changes DOES carry the record across (liveContentSync keeps everything but feeModel)
//   3. PATCH /edit — the designated audited path — carries it too, and is what the wizard now uses
//
// Driven through the REAL routes against REAL Firestore. Razorpay is stubbed; no gateway call is
// made. The ₹1 ticket of the report is used verbatim so the arithmetic is the reported arithmetic.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

const OWNER = `fsync-owner-${process.pid}`
const DRAFT = `FsyncDraft${process.pid}`
const SLUG  = `fsync-run-${process.pid}`

const h = vi.hoisted(() => ({ uid: '', engine: true, seq: 0, orders: [] as Array<{ id: string; amountPaise: number }> }))

vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '', callerUid: h.uid, workspaceUid: h.uid,
    role: 'owner', permissions: [], isOwner: true, eventIds: [], isStaffCredential: false,
  }),
}))
vi.mock('@/lib/platform/pricing/resolver', async orig => ({
  ...(await orig<typeof import('@/lib/platform/pricing/resolver')>()),
  resolvePlatformPricing: async () => ({ features: { pricingEngineEnabled: h.engine } }),
}))
vi.mock('@/lib/billing/feeEngine', async orig => ({
  ...(await orig<typeof import('@/lib/billing/feeEngine')>()),
  getFeePlanForOrganizer: async () => ({ planTier: 'standard', feeConfigId: 'fc_test' }),
}))
vi.mock('@/lib/fees/resolveFeeConfig', async orig => ({
  ...(await orig<typeof import('@/lib/fees/resolveFeeConfig')>()),
  // 1% platform + 18% GST on it, 2% gateway — on a ₹1 (100 paise) ticket this gives
  // 1 + 0 + 2 = 3 paise of fees, i.e. the ₹1.03 shape of the reported ₹1.04.
  resolveFeeConfig: async () => ({ platformFeePercentBps: 100, platformFeeFixedPaise: 0, platformFeeMinPaise: 0, platformFeeMaxPaise: 0,
    gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 }),
}))
vi.mock('@/lib/rateLimit/redis', () => ({ checkDistributedRateLimit: async () => ({ allowed: true, resetAt: 0 }) }))
vi.mock('@/lib/registrations/gate', () => ({ checkRegistrationGate: async () => ({ allowed: true }) }))
vi.mock('@/lib/payments/providers', async orig => {
  const real = await orig<typeof import('@/lib/payments/providers')>()
  const adapter = {
    createOrder: async ({ amountPaise }: { amountPaise: number }) => {
      const id = `order_fsync_${process.pid}_${++h.seq}`
      h.orders.push({ id, amountPaise })
      return { providerOrderId: id, checkout: { provider: 'razorpay', keyId: 'rzp_test_stub' } }
    },
    getCheckoutHandoff: async () => ({ provider: 'razorpay', keyId: 'rzp_test_stub' }),
    fetchOrderPayments: async () => [],
  }
  return { ...real, resolveActivePaymentProviderForNewOrder: async () => ({ ok: true, provider: 'razorpay' }), resolvePaymentProvider: () => adapter }
})

// ₹1 — the reported ticket, verbatim.
const TICKET   = 100
const PLATFORM = 1      // 1% of 100
const GST      = 0      // 18% of 1, rounded
const GATEWAY  = 2      // 2% of 100
const ATTENDEE_TOTAL = TICKET + PLATFORM + GST + GATEWAY   // 103 paise

const PASS = {
  id: 'pass_1', name: 'Entry', type: 'paid', price: 1, earlyBirdEnabled: false, unlimited: false, quantity: 100,
  visibility: 'public', status: 'active', advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] },
}
const basePricing = { eventType: 'paid', feeModel: 'organizer_absorbs', passes: [PASS], advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] } }
const details = { info: { name: 'Fsync Run' }, schedule: { startDate: '2099-12-31', timezone: 'Asia/Kolkata' }, seo: { urlSlug: SLUG } }

const CHOICE = { model: 'attendee_pays', setAt: '2026-10-24T12:00:00.000Z', setBy: OWNER, version: 1 }

const post = (url: string, body: unknown) => new NextRequest(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body),
})
const patch = (body: unknown) => new NextRequest('http://x/api/t', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body),
})
const orderReq = (key: string, email = 'runner@example.test') => post('http://x/api/registrations/create-order', {
  slug: SLUG, passId: PASS.id, attendee: { name: 'Runner', email }, formResponses: {}, idempotencyKey: key, termsAccepted: true,
})

describeEmu('RD-FEE-RESTORE-02 · the fee choice must reach the LIVE event', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let createOrder: (r: NextRequest) => Promise<Response>
  let feePreview: (r: NextRequest) => Promise<Response>
  let saveChanges: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let editRoute:  (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>

  const draftRef = () => adminDb.doc(`users/${OWNER}/eventDrafts/${DRAFT}`)
  const liveRef  = () => adminDb.doc(`events/${SLUG}`)
  const liveChoice = async () => ((await liveRef().get()).data()!.pricing as { feeCollection?: { model?: string } }).feeCollection?.model ?? null
  const intent = async (orderId: string) => (await adminDb.doc(`paymentIntents/${orderId}`).get()).data()!
  const charge = async (key: string, email?: string) =>
    (await (await createOrder(orderReq(key, email))).json() as { amount: number }).amount
  const quote = async () =>
    (await (await feePreview(post('http://x/api/registrations/fee-preview', { slug: SLUG, passId: PASS.id }))).json() as { amountPaise: number }).amountPaise

  /** A published event whose DRAFT carries the organizer's selection and whose LIVE doc does not —
   *  exactly the state the wizard leaves behind when the selector only writes the draft. */
  async function seedDraftOnlyChoice() {
    await draftRef().set({ uid: OWNER, status: 'published', lifecycleStatus: 'published', eventType: 'sports',
      pricing: { ...basePricing, feeCollection: CHOICE }, eventDetails: details })
    await liveRef().set({ uid: OWNER, draftId: DRAFT, slug: SLUG, status: 'published', lifecycleStatus: 'published',
      totalCapacity: 100, pricing: { ...basePricing }, eventDetails: details,
      registrationForm: { sections: [] }, accessControl: { type: 'open' } })
  }
  async function wipe() {
    await adminDb.recursiveDelete(liveRef()).catch(() => null)
    await draftRef().delete().catch(() => null)
    for (const o of h.orders) await adminDb.doc(`paymentIntents/${o.id}`).delete().catch(() => null)
    const claims = await adminDb.collection('paymentAttemptClaims').where('eventSlug', '==', SLUG).get().catch(() => null)
    for (const c of claims?.docs ?? []) await c.ref.delete().catch(() => null)
    h.orders.length = 0
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST: createOrder } = await import('@/app/api/registrations/create-order/route'))
    ;({ POST: feePreview }  = await import('@/app/api/registrations/fee-preview/route'))
    ;({ POST: saveChanges } = await import('@/app/api/organizer/events/[eventId]/save-changes/route'))
    ;({ PATCH: editRoute }  = await import('@/app/api/organizer/events/[eventId]/edit/route'))
  }, T)
  afterAll(wipe, T)
  beforeEach(async () => { h.uid = OWNER; h.engine = true; await wipe() }, T)

  it('1 · REPRODUCES the report: a draft-only choice prices the attendee at the ticket alone', async () => {
    await seedDraftOnlyChoice()
    // The live document is what an attendee is priced from, and it has no record.
    expect(await liveChoice()).toBeNull()
    expect(await quote()).toBe(TICKET)                       // ₹1 — what the attendee saw
    expect(await charge('fsyncReproAAAAA')).toBe(TICKET)     // ₹1 — what would have been charged
  }, T)

  it('2 · Save Changes carries the record to the live event, and the attendee total then matches', async () => {
    await seedDraftOnlyChoice()
    const res = await saveChanges(post(`http://x/api/organizer/events/${DRAFT}/save-changes`, {}),
      { params: Promise.resolve({ eventId: DRAFT }) })
    expect(res.status).toBe(200)
    expect(await liveChoice()).toBe('attendee_pays')
    expect(await quote()).toBe(ATTENDEE_TOTAL)
    expect(await charge('fsyncSaveAAAAAA')).toBe(ATTENDEE_TOTAL)
  }, T)

  it('3 · PATCH /edit — the designated audited path — carries it too', async () => {
    await seedDraftOnlyChoice()
    const res = await editRoute(patch({ feeModel: 'attendee_pays' }), { params: Promise.resolve({ eventId: DRAFT }) })
    expect(res.status).toBe(200)
    expect(await liveChoice()).toBe('attendee_pays')
    expect(await quote()).toBe(ATTENDEE_TOTAL)
    expect(await charge('fsyncEditAAAAAA')).toBe(ATTENDEE_TOTAL)
  }, T)

  it('4 · QUOTE equals CHARGE in every one of those states — the mismatch cannot return silently', async () => {
    await seedDraftOnlyChoice()
    expect(await quote()).toBe(await charge('fsyncQ1AAAAAAAA', 'q1@example.test'))
    await editRoute(patch({ feeModel: 'attendee_pays' }), { params: Promise.resolve({ eventId: DRAFT }) })
    expect(await quote()).toBe(await charge('fsyncQ2AAAAAAAA', 'q2@example.test'))
  }, T)

  it('5 · ORGANIZER-ABSORBS still charges the ticket exactly — ₹1 stays ₹1', async () => {
    await seedDraftOnlyChoice()
    await editRoute(patch({ feeModel: 'organizer_absorbs' }), { params: Promise.resolve({ eventId: DRAFT }) })
    expect(await liveChoice()).toBe('organizer_absorbs')
    expect(await quote()).toBe(TICKET)
    const amount = await charge('fsyncOaAAAAAAAA')
    expect(amount).toBe(TICKET)
    const f = (await intent(h.orders.at(-1)!.id)).financials
    expect(f.feeModel).toBe('organizer_pays')
    expect(f.chargeAmountPaise).toBe(TICKET)
  }, T)
})

// ═══ RD-LICENSE-LOCK-02 · the SERVICE FLAGS go through the same authorized path ══════════════
//
// `pricing.whatsappEnabled` gates every WhatsApp send, and the wizard used to write it straight
// to the draft with the client SDK — no server authorization beyond firestore.rules, and the LIVE
// document that actually governs sending was only updated by a separate Save Changes.
//
// These cases drive the REAL PATCH /edit route against REAL Firestore and prove the three things
// that make it an authorization boundary rather than a convenience: both documents move together,
// another organizer cannot move them, and quantities are not reachable from this payload.

describeEmu('RD-LICENSE-LOCK-02 · service flags are server-authorized', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let editRoute: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>

  const draftRef = () => adminDb.doc(`users/${OWNER}/eventDrafts/${DRAFT}`)
  const liveRef  = () => adminDb.doc(`events/${SLUG}`)
  const edit = (body: unknown) => editRoute(patch(body), { params: Promise.resolve({ eventId: DRAFT }) })
  const flags = async (ref: FirebaseFirestore.DocumentReference) => {
    const p = (await ref.get()).data()?.pricing as Record<string, unknown> | undefined
    return { whatsapp: p?.whatsappEnabled, cert: p?.certEnabled }
  }

  async function seedPublished(whatsappEnabled: boolean) {
    const p = { ...basePricing, whatsappEnabled, certEnabled: false }
    await draftRef().set({ uid: OWNER, status: 'published', lifecycleStatus: 'published', eventType: 'sports',
      pricing: p, eventDetails: details })
    await liveRef().set({ uid: OWNER, draftId: DRAFT, slug: SLUG, status: 'published', lifecycleStatus: 'published',
      totalCapacity: 100, pricing: p, eventDetails: details,
      registrationForm: { sections: [] }, accessControl: { type: 'open' } })
  }

  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ PATCH: editRoute } = await import('@/app/api/organizer/events/[eventId]/edit/route'))
  }, T)
  // Shared-emulator hygiene: this block seeds `events/{SLUG}` and a draft, and a suite that
  // leaves them behind breaks LATER suites that count or page over those collections — measured,
  // not theoretical: without this afterAll, registrationFinanceFixes failed in a combined run
  // and passed alone.
  const wipeFlagsFixtures = async () => {
    await adminDb.recursiveDelete(liveRef()).catch(() => null)
    await draftRef().delete().catch(() => null)
  }
  beforeEach(async () => { h.uid = OWNER; await wipeFlagsFixtures() }, T)
  afterAll(wipeFlagsFixtures, T)

  it('A · writes the flag to BOTH the draft and the live event in one call', async () => {
    await seedPublished(true)
    expect((await edit({ whatsappEnabled: false })).status).toBe(200)
    // The live document is the one every sender reads — a draft-only write is the defect.
    expect(await flags(liveRef())).toEqual({ whatsapp: false, cert: false })
    expect(await flags(draftRef())).toEqual({ whatsapp: false, cert: false })
  }, T)

  it('B · turns a flag back ON through the same path', async () => {
    await seedPublished(false)
    expect((await edit({ whatsappEnabled: true, certEnabled: true })).status).toBe(200)
    expect(await flags(liveRef())).toEqual({ whatsapp: true, cert: true })
    expect(await flags(draftRef())).toEqual({ whatsapp: true, cert: true })
  }, T)

  it('C · ANOTHER organizer cannot change them — the draft path is uid-scoped', async () => {
    await seedPublished(true)
    h.uid = `fsync-intruder-${process.pid}`
    const res = await edit({ whatsappEnabled: false })
    expect(res.status).not.toBe(200)
    // Unchanged on both documents.
    expect(await flags(liveRef())).toEqual({ whatsapp: true, cert: false })
    expect(await flags(draftRef())).toEqual({ whatsapp: true, cert: false })
  }, T)

  it('D · a partial payload leaves the flags it did not name alone', async () => {
    await seedPublished(true)
    expect((await edit({ certEnabled: true })).status).toBe(200)
    expect(await flags(liveRef())).toEqual({ whatsapp: true, cert: true })
  }, T)

  it('E · QUANTITIES and prices are NOT reachable from this payload', async () => {
    // Capacity is priced and paid for through the licensing quote. A content edit that could
    // also grant allowance would turn this route into a free top-up.
    await seedPublished(true)
    for (const body of [
      { whatsappEnabled: true, passPrices: { pass_1: 500 } },
      { whatsappEnabled: true, licenseTier: 'pro' },
      { whatsappEnabled: true, pricingModel: 'free' },
    ]) {
      const res = await edit(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    // …and nothing was written by the refused calls.
    expect(await flags(liveRef())).toEqual({ whatsapp: true, cert: false })
    const live = (await liveRef().get()).data()!.pricing as Record<string, unknown>
    expect((live.passes as Array<{ price: number }>)[0].price).toBe(1)
  }, T)

  it('F · a non-boolean value cannot switch a service on', async () => {
    await seedPublished(false)
    expect((await edit({ whatsappEnabled: 'yes' as never })).status).toBe(200)
    // Coerced by `=== true`, never truthy-tested: a string must not enable sending.
    expect(await flags(liveRef())).toEqual({ whatsapp: false, cert: false })
  }, T)
})
