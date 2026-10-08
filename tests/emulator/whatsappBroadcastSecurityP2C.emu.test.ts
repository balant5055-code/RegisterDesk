// RD-COMMS-P2-C — organizer WhatsApp broadcast authorization, through the REAL create route and the
// REAL broadcast job on real Firestore (emulator). Meta is stubbed in-process; what WOULD be sent to
// Meta (template + body parameters) is captured and asserted.
//
//   • an allowlisted template is accepted and sent (and still billed from the event's capacity —
//     Batch A funding untouched);
//   • a platform / transactional template is refused (403) and nothing is created or sent — and a
//     campaign written AROUND the route is refused again by the job at the send boundary;
//   • a missing required variable is refused before anything is sent;
//   • the event name in the message is the event document's, whatever the client sends — as the
//     body field or as a template variable;
//   • another organizer's event cannot be used.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { withWaOptIn } from '../helpers/whatsappConsentFixture'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const UID = `p2c-org-${P}`

const h = vi.hoisted(() => ({ sends: [] as Array<{ templateName: string; params: string[] }>, seq: 0 }))

vi.mock('@/lib/whatsapp', async orig => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  getMetaProvider: async () => ({
    sendTemplate: async (m: { templateName?: string; bodyParameters?: Array<{ text?: string }> }) => {
      h.sends.push({ templateName: String(m.templateName), params: (m.bodyParameters ?? []).map(p => String(p.text ?? '')) })
      return { success: true, messageId: `wamid.p2c.${P}.${++h.seq}` }
    },
  }),
}))
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => {
    const c = await real.getCommunicationConfig()
    return { ...c, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: 50 } }
  } }
})
vi.mock('@/lib/config/resolveFeatureFlags', async orig => {
  const real = await orig<typeof import('@/lib/config/resolveFeatureFlags')>()
  return { ...real, getFeatureFlags: async () => ({ ...(await real.getFeatureFlags()), broadcast: true }) }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['broadcasts'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))

describeEmu('RD-COMMS-P2-C · organizer WhatsApp broadcast authorization (real route, real job)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let POST: (req: NextRequest) => Promise<Response>
  const trees = new Set<string>()
  let n = 0

  async function event(opts: { uid?: string; name?: string } = {}) {
    const k = ++n, d = `p2c-d${k}-${P}`, slug = `p2c-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    const uid = opts.uid ?? UID
    await adminDb.doc(`events/${slug}`).set({ uid, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true }, eventDetails: { info: { name: opts.name ?? `Real Event ${k}` } } })
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: uid, whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    for (let i = 0; i < 2; i++) {
      const id = `p2c-r-${slug}-${i}`
      trees.add(`registrations/${id}`)
      await adminDb.doc(`registrations/${id}`).set(withWaOptIn({ organizerUid: uid, eventSlug: slug, status: 'confirmed', ticketCode: `T${i}`, attendee: { name: `Attendee ${i}`, email: `a${i}@example.test`, phone: `+9198766${String(10000 + k * 10 + i)}` } }))
    }
    return { d, slug, name: opts.name ?? `Real Event ${k}` }
  }
  const create = async (body: Record<string, unknown>) => {
    const res = await POST(new NextRequest('http://localhost/api/organizer/broadcasts', {
      method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'whatsapp', audience: 'all', ...body }),
    }))
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const campaigns = async () => (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).get()).docs
  const consumed = async (d: string) => ((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data()?.whatsapp?.consumed as number | undefined) ?? 0

  async function wipe() {
    for (const c of await campaigns()) await adminDb.recursiveDelete(c.ref)
    for (const d of (await adminDb.collection('whatsappBroadcastJobs').where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(d.ref)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST } = await import('@/app/api/organizer/broadcasts/route') as unknown as { POST: typeof POST })
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active' })
  }, T)
  beforeEach(async () => { h.sends = []; await wipe() }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null) }, T)

  it('an allowlisted template is accepted, sent with the EVENT DOCUMENT\'s name (body and variable forgeries ignored), and billed from capacity', async () => {
    const ev = await event()
    const r = await create({ eventSlug: ev.slug, templateType: 'EVENT_UPDATED', eventName: 'Forged Event', variables: { eventName: 'Another Event', attendeeName: 'Not You' } })
    expect(r.status).toBe(200)
    const [c] = await campaigns()
    expect(c.data()).toMatchObject({ eventName: ev.name, templateType: 'EVENT_UPDATED', variables: {} })
    expect(h.sends).toHaveLength(2)
    for (const s of h.sends) {
      expect(s.params).toContain(ev.name)
      expect(s.params.join('|')).not.toMatch(/Forged Event|Another Event|Not You/)
    }
    expect(await consumed(ev.d)).toBe(2)                                    // Batch A capacity funding intact
  }, T)

  it('platform and transactional templates are refused (403) — nothing is created, charged or sent', async () => {
    const ev = await event()
    for (const templateType of ['WALLET_RECHARGED', 'SETTLEMENT_APPROVED', 'EVENT_APPROVED', 'REFUND_SUCCESS', 'EVENT_CANCELLED', 'REGISTRATION_CONFIRMATION']) {
      const r = await create({ eventSlug: ev.slug, templateType, variables: { organizerName: 'RegisterDesk', amount: '₹10,000', refundAmount: '₹5,000' } })
      expect([r.status, r.body.error], templateType).toEqual([403, 'TEMPLATE_NOT_ALLOWED'])
    }
    expect(await campaigns()).toHaveLength(0)
    expect(h.sends).toEqual([])
    expect(await consumed(ev.d)).toBe(0)
  }, T)

  it('a campaign written AROUND the route with a protected template is refused again at the send boundary; its units are returned', async () => {
    const ev = await event()
    const id = `p2c-around-${P}`
    trees.add(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({
      organizerUid: UID, createdBy: UID, eventId: ev.slug, eventSlug: ev.slug, eventName: 'Forged', channel: 'whatsapp', audience: 'all',
      subject: 'x', html: '', templateType: 'REFUND_SUCCESS', variables: { refundAmount: '₹99,999' }, recipientCount: 2, successCount: 0, failCount: 0, status: 'draft', actualCostPaise: 0,
    })
    const { startBroadcastCampaign } = await import('@/lib/broadcasts/send')
    await startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 2 })
    expect(h.sends).toEqual([])
    const c = (await adminDb.doc(`broadcastCampaigns/${id}`).get()).data()!
    expect(c).toMatchObject({ status: 'failed', failReason: 'template_not_allowed' })
    expect(await consumed(ev.d)).toBe(0)                                    // nothing accepted ⇒ everything returned
  }, T)

  it('a missing required variable is refused (400) before anything is created or sent', async () => {
    const ev = await event()
    const r = await create({ eventSlug: ev.slug, templateType: 'EVENT_LOCATION', variables: { eventDate: '20 Aug', eventTime: '5:30 AM', mapsUrl: 'https://maps.app.goo.gl/x' } })
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain('venue')
    const bad = await create({ eventSlug: ev.slug, templateType: 'EVENT_LOCATION', variables: { eventDate: '20 Aug', eventTime: '5:30 AM', venue: 'Stadium', mapsUrl: 'javascript:alert(1)' } })
    expect(bad.status).toBe(400)
    expect(await campaigns()).toHaveLength(0)
    expect(h.sends).toEqual([])
  }, T)

  it('another organizer\'s event cannot be used (404), whatever template', async () => {
    const theirs = await event({ uid: `p2c-other-${P}`, name: 'Their Event' })
    const r = await create({ eventSlug: theirs.slug, templateType: 'EVENT_UPDATED' })
    expect(r.status).toBe(404)
    expect(h.sends).toEqual([])
  }, T)
})
