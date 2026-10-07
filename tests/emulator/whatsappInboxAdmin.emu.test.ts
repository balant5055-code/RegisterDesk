// WhatsApp Inbox (Phase 1c) — the Super Admin API against REAL Firestore (emulator).
//
// Drives all seven real admin route handlers. Mocked: the admin-auth boundary
// (resolveSuperAdminUid — "Bearer super" is a Super Admin, anything else is not), the Meta env
// values, and the feature flag (OFF, to prove the admin inbox does not depend on it).
// Unmatched messages are produced by the REAL receipt + routing pipeline, so the safeguards
// under test are the production ones.
//
// The emulator holds data from other suites, so global counts are asserted as DELTAS and
// list assertions are scoped to this run's ids.
//
// ⚠ The emulator does NOT enforce composite indexes; they must be deployed before production.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', () => ({
  resolveSuperAdminUid: async (h: string | null) => (h === 'Bearer super' ? 'super-admin-uid' : null),
  resolveAdminUid:      async (h: string | null) => (h === 'Bearer super' ? 'x' : null),
  legacyAdminClaimOnly: async (h: string | null) => h === 'Bearer claim-admin',
}))
vi.mock('@/lib/config/resolveFeatureFlags', () => ({ getFeatureFlags: async () => ({ whatsappInbox: false }) }))
vi.mock('@/lib/env', async orig => ({
  ...(await orig<typeof import('@/lib/env')>()),
  META_APP_ID: 'a', META_APP_SECRET: 's', META_ACCESS_TOKEN: 't', META_PHONE_NUMBER_ID: 'PNID-ADMIN-TEST',
  META_BUSINESS_ACCOUNT_ID: 'w', META_WEBHOOK_VERIFY_TOKEN: 'v',
}))

const EMULATOR    = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID  = process.pid
const A    = `waadm-A-${PID}`
const B    = `waadm-B-${PID}`
const C    = `waadm-C-${PID}`
const D    = `waadm-D-${PID}`       // ambiguity fixture: one phone, two organizers
const E    = `waadm-E-${PID}`
const EVA  = `waadm-evA-${PID}`
const EVA2 = `waadm-evA2-${PID}`
const EVB  = `waadm-evB-${PID}`
const EVC  = `waadm-evC-${PID}`
const EVD  = `waadm-evD-${PID}`
const EVE  = `waadm-evE-${PID}`
const phone = (n: number) => `917${String(PID * 1000 + n).padStart(9, '0')}`
const local = (p: string) => p.slice(2)
const wamid = (s: string) => `wamid.adm.${PID}.${s}`

type Json = Record<string, unknown>

describeEmu('WhatsApp Inbox · Super Admin API', { timeout: 60_000 }, () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let P: typeof import('@/lib/whatsapp-inbox/persist')
  let conversationIdFor: typeof import('@/lib/whatsapp-inbox/types').conversationIdFor
  let parse: typeof import('@/lib/whatsapp/webhookInbound').parseWhatsAppInboundMessages
  let orgRead: typeof import('@/lib/whatsapp-inbox/read')
  const R: Record<string, (req: NextRequest, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>> = {}
  const logs: string[] = [], regs: string[] = [], inbound: string[] = []

  const base = 'http://localhost/api/admin/whatsapp-inbox'
  async function call(route: string, path: string, opts: { auth?: string; method?: string; params?: Record<string, string> } = {}) {
    const headers: Record<string, string> = {}
    if (opts.auth !== undefined) headers.authorization = opts.auth
    const res = await R[route](new NextRequest(`${base}${path}`, { method: opts.method ?? 'GET', headers }),
      opts.params ? { params: Promise.resolve(opts.params) } : undefined)
    return { status: res.status, body: await res.json() as Json }
  }
  const su = (route: string, path: string, params?: Record<string, string>, method?: string) => call(route, path, { auth: 'Bearer super', params, method })
  const ids = (b: Json) => ((b.items ?? []) as Json[]).map(i => i.id as string)

  /** Deliver inbound WhatsApp messages through the REAL receipt + routing pipeline. */
  async function deliver(msgs: { id: string; from: string; text: string; ctx?: string; ts?: number }[]) {
    const payload = { entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'PNID-ADMIN-TEST' },
      messages: msgs.map(m => ({ from: m.from, id: m.id, timestamp: String(m.ts ?? Math.floor(Date.now() / 1000)), type: 'text', text: { body: m.text }, ...(m.ctx ? { context: { id: m.ctx } } : {}) })),
    } }] }] }
    const rec = await P.recordInboundMessages(parse(payload))
    inbound.push(...rec.created)
    for (const id of rec.created) await P.routeInboundMessage(id)
  }
  async function outbound(id: string, o: { org: string; ev: string; reg: string | null; phone: string; w: string }) {
    logs.push(id)
    await adminDb.collection('emailLogs').doc(id).set({
      organizerUid: o.org, eventId: o.ev, eventSlug: o.ev, eventName: `Event ${o.ev.split('-')[1]}`, templateKey: 'registration_confirmation',
      recipientEmail: `${id}@t.local`, recipientName: 'x', subject: 's', status: 'sent', provider: 'meta', channel: 'whatsapp',
      recipientPhone: o.phone, providerMessageId: o.w, ...(o.reg ? { registrationId: o.reg } : {}), createdAt: new Date(), updatedAt: new Date(),
    })
  }
  async function registration(id: string, o: { org: string; ev: string; phone: string; name: string }) {
    regs.push(id)
    await adminDb.collection('registrations').doc(id).set({ id, eventSlug: o.ev, organizerUid: o.org, eventName: `Event ${o.ev.split('-')[1]}`, attendee: { name: o.name, email: `${id}@t.local`, phone: o.phone } })
  }
  /** One routed conversation: an outbound confirmation + the attendee's reply to it. */
  async function conversation(n: number, org: string, ev: string, name: string, ts: number) {
    const reg = `waadm-reg${n}-${PID}`, out = wamid(`out${n}`)
    await registration(reg, { org, ev, phone: local(phone(n)), name })
    await outbound(`waadm-log${n}-${PID}`, { org, ev, reg, phone: local(phone(n)), w: out })
    await deliver([{ id: wamid(`in${n}`), from: phone(n), text: `question from ${name}`, ctx: out, ts }])
    return conversationIdFor(org, ev, phone(n))
  }

  const ID: Record<string, string> = {}
  let summaryBefore: { unreadConversations: number; unmatched: number }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('Refusing to run outside a demo- project.')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    P = await import('@/lib/whatsapp-inbox/persist')
    ;({ conversationIdFor } = await import('@/lib/whatsapp-inbox/types'))
    ;({ parseWhatsAppInboundMessages: parse } = await import('@/lib/whatsapp/webhookInbound'))
    orgRead = await import('@/lib/whatsapp-inbox/read')
    R.list    = (await import('@/app/api/admin/whatsapp-inbox/conversations/route')).GET
    R.detail  = (await import('@/app/api/admin/whatsapp-inbox/conversations/[conversationId]/route')).GET as never
    R.read    = (await import('@/app/api/admin/whatsapp-inbox/conversations/[conversationId]/read/route')).POST as never
    R.summary = (await import('@/app/api/admin/whatsapp-inbox/summary/route')).GET
    R.facets  = (await import('@/app/api/admin/whatsapp-inbox/facets/route')).GET
    R.unm     = (await import('@/app/api/admin/whatsapp-inbox/unmatched/route')).GET
    R.unmOne  = (await import('@/app/api/admin/whatsapp-inbox/unmatched/[inboundId]/route')).GET as never

    await adminDb.doc(`users/${A}`).set({ organizationName: 'Alpha Sports Co' })
    await adminDb.doc(`users/${B}`).set({ organizationName: 'Bravo Summits' })

    summaryBefore = (await su('summary', '/summary')).body as never
    const now = Math.floor(Date.now() / 1000)
    ID.a1 = await conversation(1, A, EVA,  'Asha Rao',   now - 60)
    ID.a2 = await conversation(2, A, EVA2, 'Ravi Kumar', now - 50)
    ID.b1 = await conversation(3, B, EVB,  'Meera Nair', now - 40)
    for (let i = 0; i < 33; i++) ID[`c${i}`] = await conversation(100 + i, C, EVC, `C Person ${i}`, now - 3000 + i)

    // Unmatched, produced by the real safeguards:
    //  • no_candidates — an unknown sender with no reference
    await deliver([{ id: wamid('u-none'), from: phone(50), text: 'who is this?' }])
    //  • context_phone_mismatch — replies to A's message from a DIFFERENT phone that already
    //    has a conversation with A (the phone fallback must NOT be used)
    await deliver([{ id: wamid('u-mismatch'), from: phone(2), text: 'reply from the wrong phone', ctx: wamid('out1') }])
    //  • ambiguous_organizer — phone(60) has conversations with D and E, then writes plainly
    for (const [org, ev, tag] of [[D, EVD, 'x'], [E, EVE, 'y']] as const) {
      const reg = `waadm-reg60${tag}-${PID}`, out = wamid(`out60${tag}`)
      await registration(reg, { org, ev, phone: local(phone(60)), name: 'Two Orgs' })
      await outbound(`waadm-log60${tag}-${PID}`, { org, ev, reg, phone: local(phone(60)), w: out })
      await deliver([{ id: wamid(`seed60${tag}`), from: phone(60), text: 'seed', ctx: out }])
    }
    await deliver([{ id: wamid('u-ambig'), from: phone(60), text: 'which one?' }])
    ID.uNone     = P.inboundDocIdFor(wamid('u-none'))
    ID.uMismatch = P.inboundDocIdFor(wamid('u-mismatch'))
    ID.uAmbig    = P.inboundDocIdFor(wamid('u-ambig'))
    ID.routedIn  = P.inboundDocIdFor(wamid('in1'))
  }, 300_000)

  afterAll(async () => {
    if (!adminDb) return
    const convs = await adminDb.collection('whatsappConversations').where('organizerUid', 'in', [A, B, C, D, E]).get()
    await Promise.all(convs.docs.map(d => adminDb.recursiveDelete(d.ref)))
    await Promise.all([A, B, C, D, E].map(org => adminDb.recursiveDelete(adminDb.doc(`users/${org}`))))
    const batch = adminDb.batch()
    logs.forEach(id => batch.delete(adminDb.collection('emailLogs').doc(id)))
    regs.forEach(id => batch.delete(adminDb.collection('registrations').doc(id)))
    inbound.forEach(id => batch.delete(adminDb.collection('whatsappInbound').doc(id)))
    await batch.commit()
  }, 300_000)

  // ── authorization ─────────────────────────────────────────────────────────
  it('1 · every route: no token → 401, organizer or claim-only admin → 403, with no data', async () => {
    const calls: [string, string, Record<string, string>?, string?][] = [
      ['list', '/conversations'], ['detail', `/conversations/${ID.a1}`, { conversationId: ID.a1 }],
      ['read', `/conversations/${ID.a1}/read`, { conversationId: ID.a1 }, 'POST'], ['summary', '/summary'],
      ['facets', '/facets'], ['unm', '/unmatched'], ['unmOne', `/unmatched/${ID.uNone}`, { inboundId: ID.uNone }],
    ]
    for (const [route, path, params, method] of calls) {
      expect(await call(route, path, { params, method })).toEqual({ status: 401, body: { success: false, error: 'Unauthorized' } })
      for (const auth of ['Bearer organizer-token', 'Bearer claim-admin']) {
        expect(await call(route, path, { auth, params, method })).toEqual({ status: 403, body: { success: false, error: 'Super Admin access is required.' } })
      }
    }
    // A refused mark-read changed nothing.
    expect((await adminDb.collection('whatsappConversations').doc(ID.a1).get()).data()?.adminUnread).toBe(true)
  })

  // ── cross-organizer listing ───────────────────────────────────────────────
  it('2 · lists every organizer’s conversations with organizer + event context (flag OFF)', async () => {
    const r = await su('list', `/conversations?organizerUid=${A}`)
    expect(r.status).toBe(200)
    expect(ids(r.body)).toEqual([ID.a2, ID.a1])
    expect((r.body.items as Json[])[1]).toMatchObject({
      organizerUid: A, organizerName: 'Alpha Sports Co', eventId: EVA, attendeeName: 'Asha Rao', adminUnreadCount: 1, unreadCount: 1,
    })
    expect(ids((await su('list', `/conversations?organizerUid=${B}`)).body)).toEqual([ID.b1])
  })

  it('3 · filters: event, admin-unread, and combinations', async () => {
    expect(ids((await su('list', `/conversations?eventId=${EVA2}`)).body)).toEqual([ID.a2])
    expect(ids((await su('list', `/conversations?organizerUid=${A}&eventId=${EVA}`)).body)).toEqual([ID.a1])
    expect(ids((await su('list', `/conversations?organizerUid=${B}&eventId=${EVA}`)).body)).toEqual([])
    expect(ids((await su('list', `/conversations?organizerUid=${A}&unread=1`)).body)).toEqual([ID.a2, ID.a1])
    expect(ids((await su('list', `/conversations?eventId=${EVB}&unread=1`)).body)).toEqual([ID.b1])
  })

  it('4 · search by attendee, phone, event and ORGANIZER name', async () => {
    const found = async (q: string) => ids((await su('list', `/conversations?q=${encodeURIComponent(q)}`)).body)
    expect(await found('asha rao')).toContain(ID.a1)
    expect(await found(phone(3).slice(-7))).toEqual([ID.b1])
    expect(await found('Bravo Summits')).toEqual(expect.arrayContaining([ID.b1]))
    expect(await found('Alpha Sports')).toEqual(expect.arrayContaining([ID.a1, ID.a2]))
  })

  it('5 · pagination: 30 + 3 for one organizer, no overlap', async () => {
    const p1 = await su('list', `/conversations?organizerUid=${C}`)
    expect(ids(p1.body)).toHaveLength(30)
    const p2 = await su('list', `/conversations?organizerUid=${C}&cursor=${p1.body.nextCursor}`)
    expect(ids(p2.body)).toHaveLength(3)
    expect(p2.body.nextCursor).toBeNull()
    expect(new Set([...ids(p1.body), ...ids(p2.body)]).size).toBe(33)
  })

  it('6 · facets name both organizers and their events', async () => {
    const f = (await su('facets', '/facets')).body as { organizers: { uid: string; name: string }[]; events: { eventId: string; organizerUid: string }[] }
    expect(f.organizers).toEqual(expect.arrayContaining([{ uid: A, name: 'Alpha Sports Co' }, { uid: B, name: 'Bravo Summits' }]))
    expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventId: EVA, organizerUid: A }), expect.objectContaining({ eventId: EVB, organizerUid: B })]))
  })

  // ── detail + read state ───────────────────────────────────────────────────
  it('7 · any organizer’s conversation opens for the Super Admin; missing → 404', async () => {
    const r = await su('detail', `/conversations/${ID.b1}`, { conversationId: ID.b1 })
    expect(r.body.conversation).toMatchObject({ id: ID.b1, organizerUid: B, organizerName: 'Bravo Summits', registrationIds: [`waadm-reg3-${PID}`] })
    expect((r.body.messages as Json[]).map(m => m.text)).toEqual(['question from Meera Nair'])
    const missing = await su('detail', '/conversations/nope__nope__910000000000', { conversationId: 'nope__nope__910000000000' })
    expect(missing).toEqual({ status: 404, body: { success: false, error: 'Conversation not found.' } })
  })

  it('8 · Super Admin read and organizer read are INDEPENDENT', async () => {
    const doc = () => adminDb.collection('whatsappConversations').doc(ID.a1).get().then(s => s.data()!)
    expect(await su('read', `/conversations/${ID.a1}/read`, { conversationId: ID.a1 }, 'POST')).toEqual({ status: 200, body: { success: true } })
    expect(await doc()).toMatchObject({ adminUnread: false, adminUnreadCount: 0, adminLastReadByUid: 'super-admin-uid', unread: true, unreadCount: 1 })

    await orgRead.markConversationRead(A, ID.a2, 'org-member')
    expect((await adminDb.collection('whatsappConversations').doc(ID.a2).get()).data()).toMatchObject({ unread: false, unreadCount: 0, adminUnread: true, adminUnreadCount: 1 })

    expect(ids((await su('list', `/conversations?organizerUid=${A}&unread=1`)).body)).toEqual([ID.a2])
    // The organizer still sees ID.a1 as unread.
    expect((await orgRead.listConversations(A, { unread: true })).items.map(c => c.id)).toEqual([ID.a1])
  })

  it('9 · summary counts move with this run’s data', async () => {
    const s = (await su('summary', '/summary')).body as { unreadConversations: number; unmatched: number }
    // 36 conversations + 2 seed conversations for phone(60) were created; ID.a1 was read by the admin.
    expect(s.unreadConversations - summaryBefore.unreadConversations).toBe(36 + 2 - 1)
    expect(s.unmatched - summaryBefore.unmatched).toBe(3)
  })

  // ── unmatched queue ───────────────────────────────────────────────────────
  it('10 · the queue holds exactly this run’s three unmatched messages, newest first, filterable by reason', async () => {
    const mine = [ID.uNone, ID.uMismatch, ID.uAmbig]
    const all = ids((await su('unm', '/unmatched')).body).filter(i => mine.includes(i))
    expect(all).toEqual([ID.uAmbig, ID.uMismatch, ID.uNone])
    expect(ids((await su('unm', '/unmatched?reason=context_phone_mismatch')).body)).toContain(ID.uMismatch)
    expect(ids((await su('unm', '/unmatched?reason=context_phone_mismatch')).body)).not.toContain(ID.uNone)
    expect(await su('unm', '/unmatched?reason=drop_table')).toEqual({ status: 400, body: { success: false, error: 'Unknown reason filter.' } })
  })

  it('11 · inspecting a phone-mismatch shows the evidence — other people’s numbers masked — and changes nothing', async () => {
    const before = (await adminDb.collection('whatsappInbound').doc(ID.uMismatch).get()).data()
    const r = await su('unmOne', `/unmatched/${ID.uMismatch}`, { inboundId: ID.uMismatch })
    expect(r.status).toBe(200)
    expect(r.body.item).toMatchObject({ id: ID.uMismatch, fromPhone: `+${phone(2)}`, text: 'reply from the wrong phone', reason: 'context_phone_mismatch', context: 'invalid', contextWamid: wamid('out1') })
    const ev = r.body.evidence as { matchedLog: Json; candidateRegistrations: Json[]; phoneConversations: Json[] }
    expect(ev.matchedLog).toMatchObject({ organizerUid: A, organizerName: 'Alpha Sports Co', eventId: EVA, hasRegistration: true, recipientPhone: `••••${phone(1).slice(-4)}` })
    expect(ev.candidateRegistrations).toEqual([expect.objectContaining({ id: `waadm-reg1-${PID}`, attendeeName: 'Asha Rao', phone: `••••${phone(1).slice(-4)}` })])
    // A conversation exists for this phone — routing still did NOT use it (safeguard).
    expect(ev.phoneConversations.map(c => c.id)).toEqual([ID.a2])
    expect(JSON.stringify(r.body)).not.toContain(local(phone(1)))
    // Inspection is read-only.
    expect((await adminDb.collection('whatsappInbound').doc(ID.uMismatch).get()).data()).toEqual(before)
    expect((await adminDb.collection('whatsappConversations').doc(ID.a2).get()).data()?.messageCount).toBe(1)
  })

  it('12 · an ambiguous-organizer message lists both candidate conversations; routed receipts are not in the queue', async () => {
    const r = await su('unmOne', `/unmatched/${ID.uAmbig}`, { inboundId: ID.uAmbig })
    const convs = (r.body.evidence as { phoneConversations: Json[] }).phoneConversations
    expect(convs.map(c => c.organizerUid).sort()).toEqual([D, E].sort())
    expect(await su('unmOne', `/unmatched/${ID.routedIn}`, { inboundId: ID.routedIn }))
      .toEqual({ status: 404, body: { success: false, error: 'Unmatched message not found.' } })
  })
})
