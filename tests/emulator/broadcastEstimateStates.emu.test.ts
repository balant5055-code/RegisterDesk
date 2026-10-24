// RD-BCAST-ESTIMATE-01 · the composer's "Estimated cost" states, end to end on REAL Firestore (emulator).
//
// The REAL count route answers; its body goes through the SAME client mapping the composer uses
// (toRecipientCountState → broadcastEstimate → estimateAllowsSend). Then the REAL create route
// proves the server never relies on that estimate:
//
//   • no opt-in ⇒ no_recipients WITH the reason (noConsent), Send off; the server refuses (422)
//   • no ledger / 0 units ⇒ no_capacity, Send off; the server refuses (402), nothing created
//   • short ⇒ insufficient with the shortfall; the server refuses (402)
//   • enough ⇒ ready (messages from prepaid capacity, never ₹0 / "—"); the server sends
//   • a STALE estimate (capacity used elsewhere after the count) ⇒ the server refuses (402)
//   • duplicate numbers: dedupe counts canonical numbers — preview = required = charged
//   • a large legacy wallet balance funds nothing (no fallback) and is not touched
//   • scheduling with a ready estimate is accepted and charges nothing until it runs
//   • the event's type does not change any of it
//   • RD-BCAST-COST-01 · the stored estimatedCostPaise equals the money billing actually debits:
//     0 for a prepaid-capacity campaign (units are charged, not money); the legacy price only on
//     the (disabled by default) legacy-balance path, where it matches actualCostPaise exactly

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { withWaOptIn } from '../helpers/whatsappConsentFixture'
import { toRecipientCountState, broadcastEstimate, estimateAllowsSend, type CountApiResponse } from '@/lib/broadcasts/recipientCount'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const UID = `bcest-org-${P}`

const h = vi.hoisted(() => ({ sends: [] as string[], seq: 0, legacy: false }))

vi.mock('@/lib/env', async orig => ({
  ...(await orig<typeof import('@/lib/env')>()),
  META_APP_ID: 'test-app', META_APP_SECRET: 'bcest-secret', META_ACCESS_TOKEN: 'test-token',
  META_PHONE_NUMBER_ID: 'pnid', META_BUSINESS_ACCOUNT_ID: 'test-waba', META_WEBHOOK_VERIFY_TOKEN: 'test-verify',
}))
vi.mock('@/lib/whatsapp', async orig => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  getMetaProvider: async () => ({ sendTemplate: async (m: { to?: string }) => { h.sends.push(String(m.to ?? '')); return { success: true, messageId: `wamid.bcest.${P}.${++h.seq}` } } }),
}))
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => { const c = await real.getCommunicationConfig(); return { ...c, email: { ...c.email, enabled: true }, whatsapp: { ...c.whatsapp, enabled: true } } } }
})
vi.mock('@/lib/config/resolveFeatureFlags', async orig => {
  const real = await orig<typeof import('@/lib/config/resolveFeatureFlags')>()
  return { ...real, getFeatureFlags: async () => ({ ...(await real.getFeatureFlags()), broadcast: true }) }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['broadcasts'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))
// Production value is false (RD-WA-BLOCK-01); ONE test flips it to prove the legacy-path estimate.
vi.mock('@/lib/communications/capacity', async orig => {
  const real = await orig<typeof import('@/lib/communications/capacity')>()
  return { ...real, legacyBalanceCanFundNewWhatsApp: (balance: number, cost: number) => h.legacy ? balance >= cost && cost > 0 : real.legacyBalanceCanFundNewWhatsApp(balance, cost) }
})
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifyBroadcastComplete: () => undefined }))

type Body = Record<string, unknown>

describeEmu('RD-BCAST-ESTIMATE-01 · estimate states vs the server (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let createRoute: { POST: (r: NextRequest) => Promise<Response> }
  let countRoute: { POST: (r: NextRequest) => Promise<Response> }
  const trees = new Set<string>()
  let n = 0

  const phone = (k: number, i: number) => `+91 8${String(P).padStart(5, '0').slice(-5)}${String(k).padStart(2, '0')}${String(i).padStart(2, '0')}`

  async function event(opts: { recipients: number; available: number | null; optIn?: boolean; samePhone?: boolean; eventType?: string }) {
    const k = ++n, d = `bcest-d${k}-${P}`, slug = `bcest-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', eventType: opts.eventType ?? 'sports', pricing: { whatsappEnabled: true }, eventDetails: { info: { name: `Est ${k}` } } })
    if (opts.available !== null) await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: opts.available, consumed: 0, onExhausted: 'block' } })
    const batch = adminDb.batch()
    for (let i = 0; i < opts.recipients; i++) {
      const id = `bcest-r-${slug}-${i}`
      trees.add(`registrations/${id}`)
      const doc = { organizerUid: UID, eventSlug: slug, status: 'confirmed', ticketCode: `T${i}`, paymentStatus: 'paid',
        attendee: { name: `A${i}`, email: `a${i}-${slug}@example.test`, phone: phone(k, opts.samePhone ? 0 : i) } }
      batch.set(adminDb.doc(`registrations/${id}`), opts.optIn === false ? doc : withWaOptIn(doc))
    }
    await batch.commit()
    return { d, slug }
  }
  const post = async (mod: { POST: (r: NextRequest) => Promise<Response> }, url: string, body: Body) => {
    const res = await mod.POST(new NextRequest(`http://localhost${url}`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    return { status: res.status, ok: res.ok, body: await res.json() as Body }
  }
  /** The composer's view of a count: the real route, mapped exactly as the client maps it. */
  const estimateFor = async (slug: string, extra: Body = {}) => {
    const r = await post(countRoute, '/api/organizer/broadcasts/count', { eventSlug: slug, audience: 'confirmed', channel: 'whatsapp', ...extra })
    const s = toRecipientCountState(r.ok, r.body as unknown as CountApiResponse)
    const est = broadcastEstimate({
      channel: 'whatsapp', eventSelected: true, filtersReady: true, loading: false,
      failed: s.status === 'error', recipientCount: s.status === 'ready' ? s.count : null,
      capacity: s.status === 'ready' ? s.capacity ?? null : null, excluded: s.status === 'ready' ? s.excluded ?? null : null,
    })
    return { est, send: estimateAllowsSend(est), raw: r.body }
  }
  const create = (slug: string, extra: Body = {}) => post(createRoute, '/api/organizer/broadcasts', { eventSlug: slug, audience: 'confirmed', channel: 'whatsapp', templateType: 'EVENT_UPDATED', variables: {}, ...extra })
  const campaignsFor = async (slug: string) => (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).where('eventSlug', '==', slug).get()).size
  const consumed = async (d: string) => ((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data()?.whatsapp?.consumed as number | undefined) ?? 0

  async function wipe() {
    for (const c of (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(c.ref)
    for (const j of (await adminDb.collection('whatsappBroadcastJobs').where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(j.ref)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    createRoute = await import('@/app/api/organizer/broadcasts/route') as unknown as typeof createRoute
    countRoute = await import('@/app/api/organizer/broadcasts/count/route') as unknown as typeof countRoute
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active' })
  }, T)
  beforeEach(async () => { h.sends = []; h.legacy = false; await wipe() }, T)
  afterAll(async () => {
    await wipe()
    await adminDb.doc(`users/${UID}`).delete().catch(() => null)
    await adminDb.doc(`organizerWallets/${UID}`).delete().catch(() => null)
  }, T)

  it('no opt-in ⇒ no_recipients WITH the reason; Send off; the server refuses (422) and creates nothing', async () => {
    const ev = await event({ recipients: 4, available: 10, optIn: false })
    const { est, send } = await estimateFor(ev.slug)
    expect(est).toEqual({ kind: 'no_recipients', excluded: { noConsent: 4, optedOut: 0 } })
    expect(send).toBe(false)
    const r = await create(ev.slug)
    expect(r).toMatchObject({ status: 422, body: { error: 'NO_RECIPIENTS' } })
    expect(await campaignsFor(ev.slug)).toBe(0)
  }, T)

  it('no capacity bought ⇒ no_capacity; Send off; the server refuses (402); nothing created or sent', async () => {
    const ev = await event({ recipients: 3, available: null })
    const { est, send } = await estimateFor(ev.slug)
    expect(est).toEqual({ kind: 'no_capacity', count: 3 })
    expect(send).toBe(false)
    expect(await create(ev.slug)).toMatchObject({ status: 402, body: { error: 'WHATSAPP_CAPACITY_REQUIRED' } })
    expect(await campaignsFor(ev.slug)).toBe(0)
    expect(h.sends).toEqual([])
  }, T)

  it('short ⇒ insufficient with the exact shortfall; the server refuses (402)', async () => {
    const ev = await event({ recipients: 5, available: 2 })
    const { est, send } = await estimateFor(ev.slug)
    expect(est).toEqual({ kind: 'insufficient', count: 5, available: 2, shortfall: 3 })
    expect(send).toBe(false)
    expect(await create(ev.slug)).toMatchObject({ status: 402, body: { capacity: { required: 5, available: 2, shortfall: 3 } } })
    expect(await consumed(ev.d)).toBe(0)
  }, T)

  it('enough ⇒ ready (messages from prepaid capacity); the server sends and consumes exactly that', async () => {
    const ev = await event({ recipients: 3, available: 10 })
    const { est, send } = await estimateFor(ev.slug)
    expect(est).toEqual({ kind: 'ready', count: 3, available: 10 })
    expect(send).toBe(true)
    expect((await create(ev.slug)).status).toBe(200)
    expect(h.sends).toHaveLength(3)
    expect(await consumed(ev.d)).toBe(3)
  }, T)

  it('a STALE ready estimate cannot authorize a send: capacity used elsewhere after the count ⇒ 402, nothing sent', async () => {
    const ev = await event({ recipients: 3, available: 3 })
    expect((await estimateFor(ev.slug)).est.kind).toBe('ready')
    await adminDb.doc(`eventServiceAllowances/${ev.d}`).update({ 'whatsapp.consumed': 2 })
    expect(await create(ev.slug)).toMatchObject({ status: 402, body: { error: 'WHATSAPP_CAPACITY_REQUIRED', capacity: { available: 1, shortfall: 2 } } })
    expect(h.sends).toEqual([])
    expect(await consumed(ev.d)).toBe(2)
  }, T)

  it('duplicate numbers: with dedupe the preview, the requirement and the charge are the canonical count', async () => {
    const ev = await event({ recipients: 3, available: 1, samePhone: true })
    expect((await estimateFor(ev.slug)).est).toEqual({ kind: 'insufficient', count: 3, available: 1, shortfall: 2 })
    const deduped = await estimateFor(ev.slug, { dedupePhones: true })
    expect(deduped.est).toEqual({ kind: 'ready', count: 1, available: 1 })
    expect((await create(ev.slug, { dedupePhones: true })).status).toBe(200)
    expect(h.sends).toHaveLength(1)
    expect(await consumed(ev.d)).toBe(1)
  }, T)

  it('no legacy-wallet fallback: a large balance does not make sending available, and is not touched', async () => {
    await adminDb.doc(`organizerWallets/${UID}`).set({ organizerUid: UID, balancePaise: 10_000_000 })
    const ev = await event({ recipients: 2, available: null })
    const { est, send } = await estimateFor(ev.slug)
    expect(est.kind).toBe('no_capacity')
    expect(send).toBe(false)
    expect((await create(ev.slug)).status).toBe(402)
    expect((await adminDb.doc(`organizerWallets/${UID}`).get()).data()?.balancePaise).toBe(10_000_000)
  }, T)

  it('scheduling with a ready estimate is accepted and charges nothing until it runs', async () => {
    const ev = await event({ recipients: 2, available: 5 })
    expect((await estimateFor(ev.slug)).send).toBe(true)
    const r = await create(ev.slug, { scheduledFor: new Date(Date.now() + 3_600_000).toISOString() })
    expect(r.status).toBe(200)
    expect((r.body.campaign as Body).status).toBe('scheduled')
    expect(await consumed(ev.d)).toBe(0)
    expect(h.sends).toEqual([])
  }, T)

  it('estimatedCostPaise: a prepaid-capacity campaign stores 0 money (units are what it uses) — never the legacy wallet price', async () => {
    const ev = await event({ recipients: 3, available: 10 })
    const r = await create(ev.slug)
    expect(r.status).toBe(200)
    const c = (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).where('eventSlug', '==', ev.slug).get()).docs[0].data()
    expect(c.estimatedCostPaise).toBe(0)
    expect(c).toMatchObject({ actualCostPaise: 0, fundedBy: 'prepaid_allowance', chargedUnits: 3 })
    // scheduled: same estimate, still nothing charged
    const ev2 = await event({ recipients: 2, available: 10 })
    expect((await create(ev2.slug, { scheduledFor: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(200)
    const c2 = (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).where('eventSlug', '==', ev2.slug).get()).docs[0].data()
    expect(c2).toMatchObject({ status: 'scheduled', estimatedCostPaise: 0 })
  }, T)

  it('estimatedCostPaise on the legacy-balance path (re-enabled only for this test) equals what billing debits', async () => {
    h.legacy = true
    await adminDb.doc(`organizerWallets/${UID}`).set({ organizerUid: UID, balancePaise: 1_000_000 })
    const ev = await event({ recipients: 4, available: null })
    expect((await create(ev.slug)).status).toBe(200)
    const c = (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).where('eventSlug', '==', ev.slug).get()).docs[0].data()
    const { getCommunicationConfig } = await import('@/lib/communications/resolveCommunicationConfig')
    const price = (await getCommunicationConfig()).whatsapp.pricePaise
    expect(c.estimatedCostPaise).toBe(price * 4)
    expect(c.actualCostPaise).toBe(c.estimatedCostPaise)
    await adminDb.doc(`organizerWallets/${UID}`).delete()
  }, T)

  for (const eventType of ['conference', 'custom', 'workshop']) {
    it(`event type '${eventType}' follows the same rules (ready vs no_capacity)`, async () => {
      expect((await estimateFor((await event({ recipients: 2, available: 5, eventType })).slug)).est.kind).toBe('ready')
      expect((await estimateFor((await event({ recipients: 2, available: null, eventType })).slug)).est.kind).toBe('no_capacity')
    }, T)
  }
})
