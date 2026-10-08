// RD-COMMS-CAPACITY-UX — organizer capacity UX and refunded audiences on REAL Firestore (emulator):
// the REAL count, create and list routes, the REAL scheduled start. Meta is stubbed in-process.
//
//   M1 · 0 / 50 / 100 / 150 available for 100 required: the preview states it; short ⇒ the create
//        route refuses (402 + required/available/shortfall), creates nothing, calls Meta 0 times and
//        consumes nothing; enough ⇒ it sends exactly 100;
//   M2 · scheduling is refused when short (nothing created); a scheduled campaign whose capacity
//        ran out before its send time fails with a reason the history shows, and the event's draft
//        id for the License & Services link;
//   L3 · 'confirmed' excludes a completed refund (count, create, send); 'all' still includes it;
//        a transactional confirmation to a refunded attendee is unchanged.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { withWaOptIn } from '../helpers/whatsappConsentFixture'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const UID = `capux-org-${P}`

const h = vi.hoisted(() => ({ sends: [] as string[], seq: 0 }))

vi.mock('@/lib/env', async orig => ({
  ...(await orig<typeof import('@/lib/env')>()),
  META_APP_ID: 'test-app', META_APP_SECRET: 'capux-secret', META_ACCESS_TOKEN: 'test-token',
  META_PHONE_NUMBER_ID: 'pnid', META_BUSINESS_ACCOUNT_ID: 'test-waba', META_WEBHOOK_VERIFY_TOKEN: 'test-verify',
}))
vi.mock('@/lib/whatsapp', async orig => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  getMetaProvider: async () => ({ sendTemplate: async (m: { to?: string }) => { h.sends.push(String(m.to ?? '')); return { success: true, messageId: `wamid.capux.${P}.${++h.seq}` } } }),
}))
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => { const c = await real.getCommunicationConfig(); return { ...c, email: { ...c.email, enabled: true }, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: 50 } } } }
})
vi.mock('@/lib/config/resolveFeatureFlags', async orig => {
  const real = await orig<typeof import('@/lib/config/resolveFeatureFlags')>()
  return { ...real, getFeatureFlags: async () => ({ ...(await real.getFeatureFlags()), broadcast: true }) }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['broadcasts'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifyBroadcastComplete: () => undefined }))

type Body = Record<string, unknown>

describeEmu('RD-COMMS-CAPACITY-UX · capacity before Send, scheduled capacity, refunded audiences (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let createRoute: { POST: (r: NextRequest) => Promise<Response>; GET: (r: NextRequest) => Promise<Response> }
  let countRoute: { POST: (r: NextRequest) => Promise<Response> }
  const trees = new Set<string>()
  let n = 0

  const phone = (k: number, i: number) => `+91 9${String(P).padStart(5, '0').slice(-5)}${String(k).padStart(2, '0')}${String(i).padStart(2, '0')}`

  /** An event with `recipients` opted-in confirmed registrations and `available` WhatsApp units. */
  async function event(opts: { recipients: number; available: number | null; refunded?: number }) {
    const k = ++n, d = `capux-d${k}-${P}`, slug = `capux-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true }, eventDetails: { info: { name: `Cap ${k}` } } })
    if (opts.available !== null) await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: opts.available, consumed: 0, onExhausted: 'block' } })
    const ids: string[] = []
    const total = opts.recipients + (opts.refunded ?? 0)
    for (let s = 0; s < total; s += 400) {
      const batch = adminDb.batch()
      for (let i = s; i < Math.min(total, s + 400); i++) {
        const id = `capux-r-${slug}-${String(i).padStart(3, '0')}`
        trees.add(`registrations/${id}`); ids.push(id)
        batch.set(adminDb.doc(`registrations/${id}`), withWaOptIn({
          organizerUid: UID, eventSlug: slug, status: 'confirmed', ticketCode: `T${i}`,
          paymentStatus: i < opts.recipients ? 'paid' : 'refunded',
          attendee: { name: `A${i}`, email: `a${i}-${slug}@example.test`, phone: phone(k, i) },
        }))
      }
      await batch.commit()
    }
    return { d, slug, ids }
  }
  const post = async (mod: { POST: (r: NextRequest) => Promise<Response> }, url: string, body: Body) => {
    const res = await mod.POST(new NextRequest(`http://localhost${url}`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    return { status: res.status, body: await res.json() as Body }
  }
  const count = (slug: string, extra: Body = {}) => post(countRoute, '/api/organizer/broadcasts/count', { eventSlug: slug, audience: 'confirmed', channel: 'whatsapp', ...extra })
  const create = (slug: string, extra: Body = {}) => post(createRoute, '/api/organizer/broadcasts', { eventSlug: slug, audience: 'confirmed', channel: 'whatsapp', templateType: 'EVENT_UPDATED', variables: {}, ...extra })
  const campaigns = async () => (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).get()).docs
  const consumed = async (d: string) => ((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data()?.whatsapp?.consumed as number | undefined) ?? 0

  async function wipe() {
    for (const c of await campaigns()) await adminDb.recursiveDelete(c.ref)
    for (const j of (await adminDb.collection('whatsappBroadcastJobs').where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(j.ref)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const d of (await adminDb.collection('emailLogs').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    createRoute = await import('@/app/api/organizer/broadcasts/route') as unknown as typeof createRoute
    countRoute = await import('@/app/api/organizer/broadcasts/count/route') as unknown as typeof countRoute
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active' })
  }, T)
  beforeEach(async () => { h.sends = []; await wipe() }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null) }, T)

  // ── M1 ──────────────────────────────────────────────────────────────────────
  for (const [available, sufficient] of [[0, false], [50, false], [100, true], [150, true]] as const) {
    it(`M1 · ${available} available / 100 required ⇒ ${sufficient ? 'shown as enough and SENT' : 'shown as short; refused; nothing created, sent or charged'}`, async () => {
      const ev = await event({ recipients: 100, available })
      const preview = await count(ev.slug)
      expect(preview.body).toMatchObject({ success: true, count: 100, capacity: { required: 100, available, sufficient, shortfall: sufficient ? 0 : 100 - available } })

      const r = await create(ev.slug)
      if (sufficient) {
        expect(r.status).toBe(200)
        expect(h.sends).toHaveLength(100)
        expect(await consumed(ev.d)).toBe(100)
      } else {
        expect(r.status).toBe(402)
        expect(r.body).toMatchObject({ error: 'WHATSAPP_CAPACITY_REQUIRED', capacity: { required: 100, available, shortfall: 100 - available, sufficient: false } })
        expect(String(r.body.message)).toContain('License & Services')
        expect(await campaigns()).toHaveLength(0)                            // no campaign, no job
        expect(h.sends).toEqual([])                                         // Meta never called
        expect(await consumed(ev.d)).toBe(0)                                // nothing charged
      }
    }, T)
  }

  // ── M2 ──────────────────────────────────────────────────────────────────────
  it('M2 · scheduling with enough capacity is accepted; with too little it is refused and nothing is created', async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString()
    const ok = await event({ recipients: 3, available: 5 })
    const r1 = await create(ok.slug, { scheduledFor: later })
    expect(r1.status).toBe(200)
    expect(((r1.body.campaign) as Body).status).toBe('scheduled')
    expect(await consumed(ok.d)).toBe(0)                                     // nothing charged until it runs
    expect(h.sends).toEqual([])

    const short = await event({ recipients: 3, available: 1 })
    const r2 = await create(short.slug, { scheduledFor: later })
    expect(r2.status).toBe(402)
    expect(r2.body).toMatchObject({ error: 'WHATSAPP_CAPACITY_REQUIRED', capacity: { required: 3, available: 1, shortfall: 2 } })
    expect((await campaigns()).filter(c => c.data().eventSlug === short.slug)).toHaveLength(0)
  }, T)

  it('M2 · capacity that runs out AFTER scheduling ⇒ failed at send time (no send, no charge) — and history says why, with the event for the purchase link', async () => {
    const ev = await event({ recipients: 3, available: 3 })
    const r = await create(ev.slug, { scheduledFor: new Date(Date.now() + 3_600_000).toISOString() })
    const campaignId = String((r.body.campaign as Body).id)
    await adminDb.doc(`eventServiceAllowances/${ev.d}`).update({ 'whatsapp.consumed': 2 })   // used elsewhere meanwhile
    const { startBroadcastCampaign } = await import('@/lib/broadcasts/send')
    expect(await startBroadcastCampaign({ campaignId, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 3 })).toEqual({ ok: false, reason: 'allowance_exhausted' })
    expect(h.sends).toEqual([])
    expect(await consumed(ev.d)).toBe(2)

    const list = await createRoute.GET(new NextRequest('http://localhost/api/organizer/broadcasts', { headers: { authorization: 'Bearer t' } }))
    const row = ((await list.json()) as { campaigns: Body[] }).campaigns.find(c => c.id === campaignId)!
    expect(row).toMatchObject({ status: 'failed', failReason: 'allowance_exhausted', eventDraftId: ev.d })
    const { campaignFailureLabel, isCapacityFailure } = await import('@/lib/broadcasts/campaignFailure')
    expect(campaignFailureLabel(row.failReason as string)).toBe('Failed — Insufficient WhatsApp capacity')
    expect(isCapacityFailure(row.failReason as string)).toBe(true)
  }, T)

  // ── L3 ──────────────────────────────────────────────────────────────────────
  it("L3 · 'confirmed' excludes refunded attendees everywhere (count, create, send); 'all' keeps them", async () => {
    const ev = await event({ recipients: 3, available: 10, refunded: 2 })
    expect((await count(ev.slug)).body).toMatchObject({ count: 3, capacity: { required: 3 } })
    expect((await count(ev.slug, { audience: 'all' })).body).toMatchObject({ count: 5 })
    // Email preview (index-only aggregate) and its dedupe branch agree.
    expect((await count(ev.slug, { channel: 'email' })).body).toMatchObject({ count: 3 })
    expect((await count(ev.slug, { channel: 'email', audience: 'all' })).body).toMatchObject({ count: 5 })
    expect((await count(ev.slug, { channel: 'email', dedupeEmails: true })).body).toMatchObject({ count: 3 })

    expect((await create(ev.slug)).status).toBe(200)
    expect(h.sends.sort()).toEqual([0, 1, 2].map(i => phone(n, i).replace(/\D/g, '')).sort())
    expect(await consumed(ev.d)).toBe(3)                                     // refunded attendees are not charged for
  }, T)

  it('L3 · a transactional WhatsApp confirmation to a refunded attendee is unchanged by the audience rule', async () => {
    const ev = await event({ recipients: 0, available: 5, refunded: 1 })
    const { sendWhatsAppConfirmation } = await import('@/lib/registrations/sendWhatsAppConfirmation')
    await sendWhatsAppConfirmation({ registrationId: ev.ids[0], organizerUid: UID, eventSlug: ev.slug, attendeeName: 'A', eventName: 'E', ticketCode: 'T' })
    expect(h.sends).toHaveLength(1)
  }, T)

  // ── RD-COMMS-FINAL · cross-organizer ────────────────────────────────────────
  it("cross-organizer · organizer A asking for organizer B's event gets 404 — no count, no capacity, no writes; A's own event unchanged", async () => {
    const OTHER = `capux-other-${P}`
    const theirs = await event({ recipients: 4, available: 777 })
    // Re-own B's event, ledger and registrations: same public slug, a different organizer.
    await adminDb.doc(`events/${theirs.slug}`).update({ uid: OTHER })
    await adminDb.doc(`eventServiceAllowances/${theirs.d}`).update({ organizerUid: OTHER })
    for (const id of theirs.ids) await adminDb.doc(`registrations/${id}`).update({ organizerUid: OTHER })
    const before = JSON.stringify((await adminDb.doc(`eventServiceAllowances/${theirs.d}`).get()).data())

    for (const channel of ['whatsapp', 'email']) {
      const r = await count(theirs.slug, { channel })
      expect(r.status, channel).toBe(404)
      expect(r.body, channel).toEqual({ success: false, error: 'Event not found' })            // nothing else disclosed
      expect(JSON.stringify(r.body), channel).not.toMatch(/777|capacity|available|required|count/)
    }
    expect((await count('capux-no-such-event')).status).toBe(404)                           // indistinguishable from unknown
    expect(JSON.stringify((await adminDb.doc(`eventServiceAllowances/${theirs.d}`).get()).data())).toBe(before)
    expect(await campaigns()).toHaveLength(0)
    expect(h.sends).toEqual([])

    const mine = await event({ recipients: 4, available: 10 })                               // own event: unchanged
    expect((await count(mine.slug)).body).toMatchObject({ success: true, count: 4, capacity: { required: 4, available: 10, sufficient: true } })
  }, T)
})
