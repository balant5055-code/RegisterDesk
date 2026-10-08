// RD-COMMS-M3 — shared WhatsApp capacity transparency on REAL Firestore (emulator): the REAL count
// and create routes, the REAL transactional confirmation. Meta is stubbed in-process.
//
// The warning is computed in the composer from the count route's capacity quote; these tests show
// that quote gives exactly the warning's numbers, that previewing it reserves NOTHING, and that
// sending, blocking and transactional WhatsApp behave exactly as before (one shared pool).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { withWaOptIn } from '../helpers/whatsappConsentFixture'
import { broadcastCapacityWarning } from '@/lib/broadcasts/capacityWarning'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const UID = `capm3-org-${P}`

const h = vi.hoisted(() => ({ sends: [] as string[], seq: 0 }))

vi.mock('@/lib/env', async orig => ({
  ...(await orig<typeof import('@/lib/env')>()),
  META_APP_ID: 'test-app', META_APP_SECRET: 'capm3-secret', META_ACCESS_TOKEN: 'test-token',
  META_PHONE_NUMBER_ID: 'pnid', META_BUSINESS_ACCOUNT_ID: 'test-waba', META_WEBHOOK_VERIFY_TOKEN: 'test-verify',
}))
vi.mock('@/lib/whatsapp', async orig => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  getMetaProvider: async () => ({ sendTemplate: async (m: { to?: string }) => { h.sends.push(String(m.to ?? '')); return { success: true, messageId: `wamid.capm3.${P}.${++h.seq}` } } }),
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

describeEmu('RD-COMMS-M3 · shared WhatsApp capacity — warning only (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let createRoute: { POST: (r: NextRequest) => Promise<Response>; GET: (r: NextRequest) => Promise<Response> }
  let countRoute: { POST: (r: NextRequest) => Promise<Response> }
  const trees = new Set<string>()
  let n = 0

  const phone = (k: number, i: number) => `+91 9${String(P).padStart(5, '0').slice(-5)}${String(k).padStart(2, '0')}${String(i).padStart(2, '0')}`

  /** An event with `recipients` opted-in confirmed registrations and `available` WhatsApp units. */
  async function event(opts: { recipients: number; available: number | null; refunded?: number }) {
    const k = ++n, d = `capm3-d${k}-${P}`, slug = `capm3-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true }, eventDetails: { info: { name: `Cap ${k}` } } })
    if (opts.available !== null) await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: opts.available, consumed: 0, onExhausted: 'block' } })
    const ids: string[] = []
    const total = opts.recipients + (opts.refunded ?? 0)
    for (let s = 0; s < total; s += 400) {
      const batch = adminDb.batch()
      for (let i = s; i < Math.min(total, s + 400); i++) {
        const id = `capm3-r-${slug}-${String(i).padStart(3, '0')}`
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

  const preview = async (slug: string) => {
    const r = await count(slug)
    return r.body.capacity as Parameters<typeof broadcastCapacityWarning>[0]
  }

  it('1 + 5 + 6 · large but allowed (9 of 10): warns with required / available / remaining after — and the preview reserves nothing', async () => {
    const ev = await event({ recipients: 9, available: 10 })
    for (let i = 0; i < 3; i++) expect(broadcastCapacityWarning(await preview(ev.slug))).toEqual({ required: 9, available: 10, remainingAfter: 1 })
    expect(await consumed(ev.d)).toBe(0)                                     // previewing three times reserved nothing
    expect(await campaigns()).toHaveLength(0)
    expect((await adminDb.collection(`eventServiceAllowances/${ev.d}/usage`).get()).empty).toBe(true)
    expect((await create(ev.slug)).status).toBe(200)                        // allowed: sends exactly as before
    expect(h.sends).toHaveLength(9)
    expect(await consumed(ev.d)).toBe(9)                                     // remaining after = 1, as warned
  }, T)

  it('2 · small (2 of 10): no warning; sends as before', async () => {
    const ev = await event({ recipients: 2, available: 10 })
    expect(broadcastCapacityWarning(await preview(ev.slug))).toBeNull()
    expect((await create(ev.slug)).status).toBe(200)
    expect(h.sends).toHaveLength(2)
  }, T)

  it('3 + 8 · insufficient (11 of 10): no warning, still BLOCKED — a direct API call is refused the same way', async () => {
    const ev = await event({ recipients: 11, available: 10 })
    const q = await preview(ev.slug)
    expect(q).toMatchObject({ sufficient: false, shortfall: 1 })
    expect(broadcastCapacityWarning(q)).toBeNull()
    const r = await create(ev.slug)                                          // the composer would disable Send; call the API anyway
    expect(r.status).toBe(402)
    expect(r.body.error).toBe('WHATSAPP_CAPACITY_REQUIRED')
    expect(await campaigns()).toHaveLength(0)
    expect(h.sends).toEqual([])
    expect(await consumed(ev.d)).toBe(0)
  }, T)

  it('4 · exact (10 of 10): warns that nothing will remain, and is still allowed — sends all 10', async () => {
    const ev = await event({ recipients: 10, available: 10 })
    expect(broadcastCapacityWarning(await preview(ev.slug))).toEqual({ required: 10, available: 10, remainingAfter: 0 })
    expect((await create(ev.slug)).status).toBe(200)
    expect(h.sends).toHaveLength(10)
    expect(await consumed(ev.d)).toBe(10)
  }, T)

  it('7 · transactional WhatsApp shares the pool exactly as before: it uses what the broadcast left, then the existing exhausted rule applies', async () => {
    const ev = await event({ recipients: 9, available: 10 })
    expect((await create(ev.slug)).status).toBe(200)                        // 9 of 10 used, 1 left — nothing reserved for notifications
    h.sends = []
    const { sendWhatsAppConfirmation } = await import('@/lib/registrations/sendWhatsAppConfirmation')
    const confirm = (i: number) => sendWhatsAppConfirmation({ registrationId: ev.ids[i], organizerUid: UID, eventSlug: ev.slug, attendeeName: 'A', eventName: 'E', ticketCode: `T${i}` })
    await confirm(0)
    expect(h.sends).toHaveLength(1)                                          // the last unit
    expect(await consumed(ev.d)).toBe(10)
    await confirm(1)
    expect(h.sends).toHaveLength(1)                                          // pool empty: not sent (existing behaviour)
    expect(await consumed(ev.d)).toBe(10)                                    // and never over-consumed
  }, T)
})
