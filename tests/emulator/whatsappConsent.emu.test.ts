// RD-COMMS-WA-CONSENT — WhatsApp consent for organizer broadcasts on REAL Firestore (emulator):
// the REAL webhook (signed), the REAL broadcast create route, job and billing. Meta is stubbed
// in-process; every number handed to Meta is captured.
//
//   • no explicit opt-in ⇒ excluded; explicit opt-in ⇒ sent;
//   • STOP (any case / whitespace) through the webhook ⇒ opted out ⇒ excluded from selection;
//     a duplicate / concurrent STOP changes nothing twice; a normal message opts no one in;
//   • STOP after the audience was selected ⇒ skipped AT THE SEND BOUNDARY: no Meta call, no charge;
//     an accepted recipient stays billed exactly as before (Batch A);
//   • START ⇒ eligible again; the STOP from the wa_id matches the number stored with a "+91 …";
//   • a campaign written AROUND the route, or a job with a non-consenting registration, sends nothing;
//   • transactional WhatsApp to an opted-out number is unaffected;
//   • the admin lookup is ADMIN_UIDS-only.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createHmac } from 'node:crypto'
import { withWaOptIn } from '../helpers/whatsappConsentFixture'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const UID = `wac-org-${P}`
const OTHER = `wac-other-${P}`
const SECRET = 'wac-test-app-secret'

const h = vi.hoisted(() => ({
  sends: [] as string[],
  onSend: null as null | ((to: string) => Promise<void>),
  admin: false,
  seq: 0,
}))

vi.mock('@/lib/env', async orig => ({
  ...(await orig<typeof import('@/lib/env')>()),
  META_APP_ID: 'test-app', META_APP_SECRET: 'wac-test-app-secret', META_ACCESS_TOKEN: 'test-token',
  META_PHONE_NUMBER_ID: 'pnid', META_BUSINESS_ACCOUNT_ID: 'test-waba', META_WEBHOOK_VERIFY_TOKEN: 'test-verify',
}))
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/whatsapp', async orig => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  getMetaProvider: async () => ({
    sendTemplate: async (m: { to?: string }) => {
      const to = String(m.to ?? '')
      h.sends.push(to)
      if (h.onSend) await h.onSend(to)
      return { success: true, messageId: `wamid.wac.${P}.${++h.seq}` }
    },
  }),
}))
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => { const c = await real.getCommunicationConfig(); return { ...c, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: 50 } } } }
})
vi.mock('@/lib/config/resolveFeatureFlags', async orig => {
  const real = await orig<typeof import('@/lib/config/resolveFeatureFlags')>()
  return { ...real, getFeatureFlags: async () => ({ ...(await real.getFeatureFlags()), broadcast: true }) }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['broadcasts'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))
vi.mock('@/lib/admin/auth', async orig => ({ ...(await orig<typeof import('@/lib/admin/auth')>()), resolveAdminUid: async () => (h.admin ? 'admin' : null) }))
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifyBroadcastComplete: () => undefined }))

describeEmu('RD-COMMS-WA-CONSENT · organizer WhatsApp broadcast consent (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let consent: typeof import('@/lib/whatsapp/broadcastConsent')
  let create: (body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>
  let webhook: (messages: Array<{ id: string; from: string; body?: string; type?: string; ts?: number }>) => Promise<number>
  const trees = new Set<string>()
  const keys = new Set<string>()
  let n = 0

  // Phones are unique per test run; the wa_id form ("91…") and the stored form ("+91 …") differ on purpose.
  const local = (i: number) => `98${String(P).padStart(5, '0').slice(-5)}${String(i).padStart(3, '0')}`
  const stored = (i: number) => `+91 ${local(i).slice(0, 5)} ${local(i).slice(5)}`
  const waId = (i: number) => `91${local(i)}`

  async function event(regs: { i: number; optIn?: boolean; uid?: string }[], prepaid = 10) {
    const k = ++n, d = `wac-d${k}-${P}`, slug = `wac-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true }, eventDetails: { info: { name: `Consent ${k}` } } })
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: prepaid, consumed: 0, onExhausted: 'block' } })
    const ids: string[] = []
    for (const r of regs) {
      const id = `wac-r-${slug}-${r.i}`
      trees.add(`registrations/${id}`); ids.push(id)
      keys.add(consent.whatsappPhoneKey(stored(r.i))!)
      const doc = {
        organizerUid: r.uid ?? UID, eventSlug: slug, status: 'confirmed', ticketCode: `T${r.i}`,
        attendee: { name: `A${r.i}`, email: `a${r.i}@example.test`, phone: stored(r.i) },
      }
      await adminDb.doc(`registrations/${id}`).set(r.optIn ? withWaOptIn(doc) : doc)
    }
    return { d, slug, ids }
  }
  const consumed = async (d: string) => ((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data()?.whatsapp?.consumed as number | undefined) ?? 0
  const sentTo = (i: number) => h.sends.filter(s => s === waId(i)).length
  const optState = async (i: number) => (await adminDb.doc(`whatsappBroadcastOptOuts/${consent.whatsappPhoneKey(stored(i))}`).get()).data()?.state
  const broadcast = (slug: string) => create({ channel: 'whatsapp', audience: 'all', eventSlug: slug, templateType: 'EVENT_UPDATED', variables: {} })

  async function wipe() {
    for (const c of (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(c.ref)
    for (const j of (await adminDb.collection('whatsappBroadcastJobs').where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(j.ref)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const k of keys) {
      await adminDb.doc(`whatsappBroadcastOptOuts/${k}`).delete().catch(() => null)
      for (const a of (await adminDb.collection('whatsappConsentAudit').where('phoneKey', '==', k).get()).docs) await a.ref.delete()
    }
    for (const d of (await adminDb.collection('emailLogs').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    trees.clear(); keys.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    consent = await import('@/lib/whatsapp/broadcastConsent')
    const route = await import('@/app/api/organizer/broadcasts/route') as unknown as { POST: (r: NextRequest) => Promise<Response> }
    create = async body => {
      const res = await route.POST(new NextRequest('http://localhost/api/organizer/broadcasts', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }
    const wh = await import('@/app/api/webhooks/whatsapp/route')
    webhook = async messages => {
      const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pnid' }, messages: messages.map(m => ({
        id: m.id, from: m.from, timestamp: String(Math.floor((m.ts ?? Date.now()) / 1000)), type: m.type ?? 'text', text: { body: m.body ?? '' },
      })) } }] }] })
      for (const m of messages) trees.add(`whatsappInbound/${(await import('@/lib/whatsapp-inbox/persist')).inboundDocIdFor(m.id)}`)
      const res = await wh.POST(new NextRequest('http://localhost/api/webhooks/whatsapp', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` } }))
      return res.status
    }
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active' })
  }, T)
  beforeEach(async () => { h.sends = []; h.onSend = null; h.admin = false; await wipe() }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null) }, T)

  it('no explicit opt-in ⇒ excluded (even with a phone, a registration and accepted terms); explicit opt-in ⇒ sent', async () => {
    const none = await event([{ i: 1 }, { i: 2 }])
    await adminDb.doc(`registrations/${none.ids[0]}`).update({ termsAccepted: true, whatsappStatus: 'sent' })   // terms + an earlier delivery are NOT consent
    const r = await broadcast(none.slug)
    expect(r.status).toBe(422)
    expect(r.body).toMatchObject({ error: 'NO_RECIPIENTS', excluded: { noConsent: 2, optedOut: 0 } })
    expect(h.sends).toEqual([])

    const mixed = await event([{ i: 3, optIn: true }, { i: 4 }])
    expect((await broadcast(mixed.slug)).status).toBe(200)
    expect([sentTo(3), sentTo(4)]).toEqual([1, 0])
    expect(await consumed(mixed.d)).toBe(1)
  }, T)

  it('STOP through the signed webhook — any case / whitespace — opts out the number stored as "+91 …"; it is then excluded', async () => {
    const ev = await event([{ i: 5, optIn: true }, { i: 6, optIn: true }, { i: 7, optIn: true }, { i: 8, optIn: true }])
    expect(await webhook([
      { id: `wamid.in.${P}.5`, from: waId(5), body: 'STOP' },
      { id: `wamid.in.${P}.6`, from: waId(6), body: '  stop \n' },
      { id: `wamid.in.${P}.7`, from: waId(7), body: 'Stop.' },
    ])).toBe(200)
    expect([await optState(5), await optState(6), await optState(7), await optState(8)]).toEqual(['opted_out', 'opted_out', 'opted_out', undefined])
    const audit = (await adminDb.collection('whatsappConsentAudit').where('phoneKey', '==', consent.whatsappPhoneKey(stored(5))).get()).docs.map(d => d.data())
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit)).not.toContain(local(5))                    // no raw number stored
    expect((await broadcast(ev.slug)).status).toBe(200)
    expect([sentTo(5), sentTo(6), sentTo(7), sentTo(8)]).toEqual([0, 0, 0, 1])
  }, T)

  it('a duplicate / concurrent STOP changes nothing twice; a normal message opts no one in or out', async () => {
    const stop = { id: `wamid.dup.${P}`, from: waId(9), body: 'UNSUBSCRIBE' }
    const results = await Promise.all([webhook([stop]), webhook([stop]), webhook([stop])])
    expect(results).toEqual([200, 200, 200])
    expect(await optState(9)).toBe('opted_out')
    expect((await adminDb.collection('whatsappConsentAudit').where('phoneKey', '==', consent.whatsappPhoneKey(stored(9))).get()).size).toBe(1)
    keys.add(consent.whatsappPhoneKey(stored(9))!); keys.add(consent.whatsappPhoneKey(stored(10))!)

    await webhook([{ id: `wamid.hi.${P}`, from: waId(10), body: 'Hi, what time is the race?' }, { id: `wamid.yes.${P}`, from: waId(10), body: 'YES' }])
    expect(await optState(10)).toBeUndefined()
    const ev = await event([{ i: 10 }])                                      // a reply is not consent
    expect((await broadcast(ev.slug)).status).toBe(422)
  }, T)

  it('STOP after the audience was SELECTED is caught at the send boundary — no Meta call, no charge; accepted stays billed', async () => {
    // Pages hold 5 recipients and run 3 at a time, so #16 (page 2) is checked strictly AFTER the
    // first send — the STOP lands after selection and before #16's own Meta call.
    const ev = await event([11, 12, 13, 14, 15, 16].map(i => ({ i, optIn: true })))
    h.onSend = async to => { if (to === waId(11)) await webhook([{ id: `wamid.mid.${P}`, from: waId(16), body: 'STOP' }]) }
    expect((await broadcast(ev.slug)).status).toBe(200)                     // charged for 6 at start
    expect([11, 12, 13, 14, 15, 16].map(sentTo)).toEqual([1, 1, 1, 1, 1, 0])
    expect(await consumed(ev.d)).toBe(5)                                    // the skipped unit is returned
    const c = (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).get()).docs[0].data()
    expect(c).toMatchObject({ status: 'sent', successCount: 5, failCount: 0, skippedCount: 1, billedUnits: 5, refundedUnits: 1 })
    const logs = (await adminDb.collection('emailLogs').where('organizerUid', '==', UID).where('status', '==', 'skipped').get()).docs.map(d => d.data())
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ channel: 'whatsapp', costPaise: 0, error: 'Not sent — the recipient replied STOP to WhatsApp messages' })
  }, T)

  it('START is the explicit re-opt-in; an older STOP delivered late does not undo it', async () => {
    const ev = await event([{ i: 24, optIn: true }])
    const t0 = Date.now() - 60_000
    await webhook([{ id: `wamid.s1.${P}`, from: waId(24), body: 'STOP', ts: t0 }])
    expect((await broadcast(ev.slug)).status).toBe(422)
    await webhook([{ id: `wamid.s2.${P}`, from: waId(24), body: 'START', ts: t0 + 30_000 }])
    expect(await optState(24)).toBe('opted_in')
    await webhook([{ id: `wamid.s0.${P}`, from: waId(24), body: 'STOP', ts: t0 - 30_000 }])   // out of order, older
    expect(await optState(24)).toBe('opted_in')
    expect((await broadcast(ev.slug)).status).toBe(200)
    expect(sentTo(24)).toBe(1)
  }, T)

  it('direct paths cannot bypass consent: a campaign written AROUND the route, and a job holding a non-consenting registration', async () => {
    const ev = await event([{ i: 15 }, { i: 16, optIn: true }])
    await webhook([{ id: `wamid.byp.${P}`, from: waId(16), body: 'QUIT' }])
    const id = `wac-around-${P}`
    trees.add(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({ organizerUid: UID, createdBy: UID, eventId: ev.slug, eventSlug: ev.slug, eventName: 'X', channel: 'whatsapp', audience: 'all', subject: 'x', html: '', templateType: 'EVENT_UPDATED', variables: {}, recipientCount: 2, successCount: 0, failCount: 0, status: 'draft', actualCostPaise: 0 })
    const { startBroadcastCampaign } = await import('@/lib/broadcasts/send')
    await startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 2 })
    expect(h.sends).toEqual([])

    // A job snapshot that (somehow) includes them anyway: refused one by one at the send boundary.
    const waJob = await import('@/lib/broadcasts/whatsappJob')
    const id2 = `wac-around2-${P}`
    trees.add(`broadcastCampaigns/${id2}`)
    await adminDb.doc(`broadcastCampaigns/${id2}`).set({ organizerUid: UID, createdBy: UID, eventId: ev.slug, eventSlug: ev.slug, eventName: 'X', channel: 'whatsapp', audience: 'all', subject: 'x', html: '', templateType: 'EVENT_UPDATED', variables: {}, recipientCount: 2, successCount: 0, failCount: 0, status: 'sending', actualCostPaise: 0 })
    const job = await waJob.createWhatsAppBroadcastJob(id2, (await adminDb.doc(`broadcastCampaigns/${id2}`).get()).data() as never,
      ev.ids.map((rid, k) => ({ id: rid, data: { attendee: { name: 'A', email: 'a@x.test', phone: stored(15 + k) }, ticketCode: '' } })) as never)
    for (let i = 0; i < 4; i++) { const r = await waJob.processWhatsAppBroadcastChunk(job!.jobId); if (r.done) break }
    expect(h.sends).toEqual([])
    const rows = (await adminDb.collection(`whatsappBroadcastJobs/${job!.jobId}/recipients`).get()).docs.map(d => d.data().skipReason).sort()
    expect(rows).toEqual(['no_consent', 'opted_out'])
  }, T)

  it('TRANSACTIONAL WhatsApp to an opted-out, never-opted-in number still goes out', async () => {
    const { slug, ids } = await event([{ i: 17 }])
    await webhook([{ id: `wamid.tx.${P}`, from: waId(17), body: 'STOP' }])
    const { sendWhatsAppConfirmation } = await import('@/lib/registrations/sendWhatsAppConfirmation')
    await sendWhatsAppConfirmation({ registrationId: ids[0], organizerUid: UID, eventSlug: slug, attendeeName: 'A', eventName: 'E', ticketCode: 'T' })
    expect(sentTo(17)).toBe(1)
  }, T)

  it('the WhatsApp opt-out lookup is ADMIN_UIDS-only and read-only; organizers have no route to it', async () => {
    await webhook([{ id: `wamid.adm.${P}`, from: waId(18), body: 'END' }])
    keys.add(consent.whatsappPhoneKey(stored(18))!)
    const admin = await import('@/app/api/admin/communications/suppression/route')
    const look = () => admin.GET(new NextRequest(`http://localhost/api/admin/communications/suppression?phone=${encodeURIComponent(stored(18))}`))
    expect((await look()).status).toBe(403)
    h.admin = true
    const body = await (await look()).json() as { whatsapp: { state: { state: string; keyword: string }; history: unknown[] } }
    expect(body.whatsapp.state).toMatchObject({ state: 'opted_out', keyword: 'END' })
    expect(body.whatsapp.history).toHaveLength(1)
    expect(admin).not.toHaveProperty('POST')
  }, T)

  it('organizer B’s consenting attendee is never reachable from organizer A’s broadcast', async () => {
    const ev = await event([{ i: 19, optIn: true, uid: OTHER }])
    expect((await broadcast(ev.slug)).status).not.toBe(200)
    expect(sentTo(19)).toBe(0)
  }, T)

  // ── Phone binding ──────────────────────────────────────────────────────────────

  it('the stored consent carries the hash of the consenting number (no raw number)', async () => {
    const ev = await event([{ i: 29, optIn: true }])
    const c = (await adminDb.doc(`registrations/${ev.ids[0]}`).get()).data()!.whatsappBroadcastConsent
    expect(c).toMatchObject({ state: 'opted_in', phoneHash: consent.whatsappPhoneKey(stored(29)) })
    expect(JSON.stringify(c)).not.toContain(local(29))
  }, T)

  it('an ORGANIZER phone edit (the real PATCH route) never transfers consent — neither number is eligible; an explicit re-opt-in for the new number is', async () => {
    const ev = await event([{ i: 30, optIn: true }])
    const { Timestamp } = await import('firebase-admin/firestore')
    const at = Timestamp.now()
    await adminDb.doc(`registrations/${ev.ids[0]}`).update({ updatedAt: at })
    keys.add(consent.whatsappPhoneKey(stored(31))!)
    const edit = await import('@/app/api/organizer/registrations/[registrationId]/route')
    const res = await edit.PATCH(
      new NextRequest(`http://localhost/api/organizer/registrations/${ev.ids[0]}`, { method: 'PATCH', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ phone: stored(31), expectedUpdatedAt: at.toDate().toISOString() }) }),
      { params: Promise.resolve({ registrationId: ev.ids[0] }) } as never,
    )
    expect(res.status).toBe(200)
    const r = await broadcast(ev.slug)
    expect(r.status).toBe(422)                                              // old consent does not follow the new number
    expect(r.body).toMatchObject({ excluded: { noConsent: 1 } })
    expect([sentTo(30), sentTo(31)]).toEqual([0, 0])                        // and the OLD number is not messaged either

    // The attendee explicitly opts in again — now for the number on the registration.
    await adminDb.doc(`registrations/${ev.ids[0]}`).update({ ...consent.whatsappConsentFields(true, stored(31)) })
    expect((await adminDb.doc(`registrations/${ev.ids[0]}`).get()).data()!.whatsappBroadcastConsent.phoneHash).toBe(consent.whatsappPhoneKey(stored(31)))
    expect((await broadcast(ev.slug)).status).toBe(200)
    expect([sentTo(30), sentTo(31)]).toEqual([0, 1])
  }, T)

  it('a phone changed AFTER selection is caught at the send boundary — skipped, no Meta call, no charge', async () => {
    const ev = await event([40, 41, 42, 43, 44, 45].map(i => ({ i, optIn: true })))
    keys.add(consent.whatsappPhoneKey(stored(46))!)
    h.onSend = async to => { if (to === waId(40)) await adminDb.doc(`registrations/${ev.ids[5]}`).update({ 'attendee.phone': stored(46) }) }
    expect((await broadcast(ev.slug)).status).toBe(200)                     // 6 selected and charged at start
    expect([40, 41, 42, 43, 44, 45, 46].map(sentTo)).toEqual([1, 1, 1, 1, 1, 0, 0])
    expect(await consumed(ev.d)).toBe(5)                                    // the skipped unit is returned
    const skipped = (await adminDb.collection('emailLogs').where('organizerUid', '==', UID).where('status', '==', 'skipped').get()).docs.map(d => d.data())
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ costPaise: 0, error: consent.WHATSAPP_SKIP_REASONS.phone_changed })
  }, T)

  it('direct bypass: a job snapshot holding the OLD number cannot use consent given for the current one', async () => {
    const ev = await event([{ i: 50 }])
    await adminDb.doc(`registrations/${ev.ids[0]}`).update({ ...consent.whatsappConsentFields(true, stored(50)) })   // consent for #50 (current)
    keys.add(consent.whatsappPhoneKey(stored(51))!)
    const waJob = await import('@/lib/broadcasts/whatsappJob')
    const id = `wac-snap-${P}`
    trees.add(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({ organizerUid: UID, createdBy: UID, eventId: ev.slug, eventSlug: ev.slug, eventName: 'X', channel: 'whatsapp', audience: 'all', subject: 'x', html: '', templateType: 'EVENT_UPDATED', variables: {}, recipientCount: 1, successCount: 0, failCount: 0, status: 'sending', actualCostPaise: 0 })
    const job = await waJob.createWhatsAppBroadcastJob(id, (await adminDb.doc(`broadcastCampaigns/${id}`).get()).data() as never,
      [{ id: ev.ids[0], data: { attendee: { name: 'A', email: 'a@x.test', phone: stored(51) }, ticketCode: '' } }] as never)   // a DIFFERENT number
    for (let i = 0; i < 4; i++) { const r = await waJob.processWhatsAppBroadcastChunk(job!.jobId); if (r.done) break }
    expect(h.sends).toEqual([])
    expect((await adminDb.collection(`whatsappBroadcastJobs/${job!.jobId}/recipients`).get()).docs[0].data().skipReason).toBe('phone_changed')
  }, T)

  it('a consent WITHOUT a phoneHash (pre-binding) fails closed at selection and at the send boundary', async () => {
    const ev = await event([{ i: 52 }])
    await adminDb.doc(`registrations/${ev.ids[0]}`).update({ whatsappBroadcastConsent: { state: 'opted_in', source: 'registration_form', version: 'wa-broadcast-optin-v1' } })
    expect((await broadcast(ev.slug)).status).toBe(422)
    expect(sentTo(52)).toBe(0)
    expect(await consent.whatsappBroadcastSendBlock(ev.ids[0], stored(52))).toBe('no_consent')
  }, T)

  it('START lifts a STOP but never creates consent; STOP still blocks a matching consent', async () => {
    const never = await event([{ i: 53 }])
    await webhook([{ id: `wamid.st53.${P}`, from: waId(53), body: 'START' }])
    expect(await optState(53)).toBe('opted_in')                             // the STOP record says "not stopped" …
    expect((await broadcast(never.slug)).status).toBe(422)                  // … but there is still no consent
    expect(sentTo(53)).toBe(0)

    const bound = await event([{ i: 54, optIn: true }])
    await webhook([{ id: `wamid.st54.${P}`, from: waId(54), body: 'STOP' }])
    expect(await consent.whatsappBroadcastSendBlock(bound.ids[0], stored(54))).toBe('opted_out')
    expect((await broadcast(bound.slug)).status).toBe(422)
  }, T)
})
