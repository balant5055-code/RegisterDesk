// WhatsApp Inbox (Phase 1a) — inbound persistence + routing against REAL Firestore.
//
// Drives the REAL webhook route with correctly signed payloads, then the real routing
// transaction. Only three things are mocked: the env values (a test app secret + phone
// number id — .env.emulator deliberately leaves Meta unset), `after()` (captured and
// awaited explicitly so the test controls when post-response work runs), and the feature
// flag (toggled per test). Everything else — receipts, dedupe, the routing lookups, the
// transaction, notifications, the sweep — is production code.
//
// ⚠ The emulator does NOT enforce composite indexes. The sweep's (state, receivedAt) query
// passes here regardless of what is deployed; the index must be deployed before production.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'

const T = vi.hoisted(() => ({
  SECRET: 'wa-inbox-test-secret',
  PNID:   'PNID-WA-INBOX-TEST',
  flags:  { whatsappInbox: true },
  afters: [] as Array<() => unknown>,
  /** Test 20: make the notification write fail INSIDE the routing transaction. */
  breakNotification: false,
}))

vi.mock('@/lib/notifications/inbox/write', async orig => {
  const real = await orig<typeof import('@/lib/notifications/inbox/write')>()
  return {
    ...real,
    prepareNotification: (input: Parameters<typeof real.prepareNotification>[0]) => {
      const n = real.prepareNotification(input)
      // An `undefined` field is rejected by the Admin SDK — a real, synchronous write failure.
      return n && T.breakNotification ? { ref: n.ref, data: { ...n.data, poison: undefined } } : n
    },
  }
})

vi.mock('@/lib/env', async orig => ({
  ...(await orig<typeof import('@/lib/env')>()),
  META_APP_ID: 'test-app', META_APP_SECRET: T.SECRET, META_ACCESS_TOKEN: 'test-token',
  META_PHONE_NUMBER_ID: T.PNID, META_BUSINESS_ACCOUNT_ID: 'test-waba', META_WEBHOOK_VERIFY_TOKEN: 'test-verify',
}))
vi.mock('next/server', async orig => ({
  ...(await orig<typeof import('next/server')>()),
  after: (cb: () => unknown) => { T.afters.push(cb) },
}))
vi.mock('@/lib/config/resolveFeatureFlags', () => ({
  getFeatureFlags: async () => ({ ...T.flags }),
}))

const EMULATOR    = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const ORG_A = `wainbox-orgA-${PID}`
const ORG_B = `wainbox-orgB-${PID}`
const EV_A  = `wainbox-evA-${PID}`
const EV_A2 = `wainbox-evA2-${PID}`
const EV_B  = `wainbox-evB-${PID}`
/** A valid, run-unique Indian mobile: 91 + 10 digits. */
const phone = (n: number) => `91${7}${String(PID * 100 + n).padStart(9, '0')}`
const local = (p: string) => p.slice(2)            // stored "as typed": 10-digit national
const wamid = (s: string) => `wamid.${PID}.${s}`

type Json = Record<string, unknown>

// Each case runs several reads plus a transaction against the emulator; a cold emulator
// was measured exceeding vitest's 5s default (warm: 0.1–3.6s per case).
describeEmu('WhatsApp Inbox · inbound webhook → durable receipt → routing', { timeout: 30_000 }, () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let POST: (req: NextRequest) => Promise<Response>
  let P: typeof import('@/lib/whatsapp-inbox/persist')
  let C: typeof import('@/lib/whatsapp-inbox/types')
  const cleanup = { logs: [] as string[], regs: [] as string[], inbound: new Set<string>(), orgs: [ORG_A, ORG_B] }

  // ── helpers ───────────────────────────────────────────────────────────────
  const body = (messages: Json[], opts: { pnid?: string; statuses?: Json[] } = {}) => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550000000', phone_number_id: opts.pnid ?? T.PNID },
      ...(messages.length ? { messages } : {}),
      ...(opts.statuses ? { statuses: opts.statuses } : {}),
    } }] }],
  })
  const signed = (raw: string, sig?: string) => new NextRequest('http://localhost/api/webhooks/whatsapp', {
    method: 'POST', body: raw,
    headers: { 'x-hub-signature-256': sig ?? `sha256=${createHmac('sha256', T.SECRET).update(raw).digest('hex')}` },
  })
  const text = (id: string, from: string, t: string, ctx?: string, ts = 1759140000): Json => ({
    from, id, timestamp: String(ts), type: 'text', text: { body: t }, ...(ctx ? { context: { id: ctx } } : {}),
  })
  const flushAfter = async () => {
    while (T.afters.length) await T.afters.shift()!()
  }
  const deliver = async (messages: Json[], opts?: { pnid?: string }) => {
    for (const m of messages) cleanup.inbound.add(P.inboundDocIdFor(m.id as string))
    const res = await POST(signed(body(messages, opts)))
    await flushAfter()
    return res
  }
  const receipt  = async (w: string) => (await adminDb.collection('whatsappInbound').doc(P.inboundDocIdFor(w)).get()).data() as Json | undefined
  const convRef  = (org: string, ev: string, ph: string) => adminDb.collection('whatsappConversations').doc(C.conversationIdFor(org, ev, ph))
  const conv     = async (org: string, ev: string, ph: string) => (await convRef(org, ev, ph).get()).data() as Json | undefined
  const msgCount = async (org: string, ev: string, ph: string) => (await convRef(org, ev, ph).collection('messages').count().get()).data().count
  const notif    = async (org: string, w: string) => (await adminDb.doc(`users/${org}/notifications/whatsapp_${P.inboundDocIdFor(w)}`).get()).exists

  /** An outbound attendee WhatsApp exactly as sendWhatsAppConfirmation logs it (raw phone). */
  const outbound = async (id: string, o: { org: string; ev: string; reg?: string | null; phone: string; wamid: string }) => {
    cleanup.logs.push(id)
    await adminDb.collection('emailLogs').doc(id).set({
      organizerUid: o.org, eventId: o.ev, eventSlug: o.ev, eventName: `Event ${o.ev}`,
      templateKey: 'registration_confirmation', recipientEmail: `${id}@test.local`, recipientName: 'Log Name',
      subject: 'WhatsApp: Registration confirmation', status: 'sent', provider: 'meta', channel: 'whatsapp',
      recipientPhone: o.phone, providerMessageId: o.wamid,
      ...(o.reg ? { registrationId: o.reg } : {}),
      createdAt: new Date(), updatedAt: new Date(),
    })
  }
  const registration = async (id: string, o: { org: string; ev: string; phone: string; name: string; wamid?: string }) => {
    cleanup.regs.push(id)
    await adminDb.collection('registrations').doc(id).set({
      id, eventSlug: o.ev, organizerUid: o.org, eventName: `Event ${o.ev}`,
      attendee: { name: o.name, email: `${id}@test.local`, phone: o.phone },
      ...(o.wamid ? { whatsappMessageId: o.wamid, whatsappStatus: 'sent' } : {}),
    })
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('Refusing to run outside a demo- project.')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST }    = await import('@/app/api/webhooks/whatsapp/route'))
    P = await import('@/lib/whatsapp-inbox/persist')
    C = await import('@/lib/whatsapp-inbox/types')
  }, 60_000)

  afterAll(async () => {
    if (!adminDb) return
    const convs = await adminDb.collection('whatsappConversations').where('organizerUid', 'in', cleanup.orgs).get()
    for (const d of convs.docs) await adminDb.recursiveDelete(d.ref)
    for (const org of cleanup.orgs) await adminDb.recursiveDelete(adminDb.doc(`users/${org}`))
    const batch = adminDb.batch()
    cleanup.logs.forEach(id => batch.delete(adminDb.collection('emailLogs').doc(id)))
    cleanup.regs.forEach(id => batch.delete(adminDb.collection('registrations').doc(id)))
    cleanup.inbound.forEach(id => batch.delete(adminDb.collection('whatsappInbound').doc(id)))
    await batch.commit()
  }, 60_000)

  // ── signature ─────────────────────────────────────────────────────────────
  it('1 · an invalid signature is refused and writes nothing', async () => {
    const w = wamid('badsig')
    cleanup.inbound.add(P.inboundDocIdFor(w))
    const res = await POST(signed(body([text(w, phone(1), 'hi')]), 'sha256=deadbeef'))
    expect(res.status).toBe(401)
    expect(await receipt(w)).toBeUndefined()
  })

  // ── context routing ───────────────────────────────────────────────────────
  it('2 · a reply to a confirmation routes to that organizer + event, content moves to the message', async () => {
    const ph = phone(2), out = wamid('out2'), inb = wamid('in2')
    await registration(`wainbox-reg2-${PID}`, { org: ORG_A, ev: EV_A, phone: local(ph), name: 'Asha Rao' })
    await outbound(`wainbox-log2-${PID}`, { org: ORG_A, ev: EV_A, reg: `wainbox-reg2-${PID}`, phone: local(ph), wamid: out })

    const res = await deliver([text(inb, ph, 'Is parking available?', out)])
    expect(res.status).toBe(200)

    const c = await conv(ORG_A, EV_A, ph)
    expect(c).toMatchObject({
      organizerUid: ORG_A, eventId: EV_A, eventName: `Event ${EV_A}`, attendeePhone: ph,
      registrationIds: [`wainbox-reg2-${PID}`], primaryRegistrationId: `wainbox-reg2-${PID}`,
      attendeeName: 'Asha Rao', attendeeNameLower: 'asha rao', unreadCount: 1, messageCount: 1,
      lastMessagePreview: 'Is parking available?', lastDirection: 'inbound',
    })
    const m = (await convRef(ORG_A, EV_A, ph).collection('messages').doc(P.inboundDocIdFor(inb)).get()).data()
    expect(m).toMatchObject({ direction: 'inbound', wamid: inb, type: 'text', text: 'Is parking available?', contextWamid: out, status: 'received', routingMethod: 'context' })

    const r = await receipt(inb)
    expect(r).toMatchObject({ state: 'routed', conversationId: C.conversationIdFor(ORG_A, EV_A, ph), fromPhone: ph })
    expect((r?.routing as Json)).toMatchObject({ method: 'context', context: 'matched', matchedLogId: `wainbox-log2-${PID}` })
    // Exactly one copy of the content.
    expect(r).not.toHaveProperty('text')
  })

  it('3 · a duplicate delivery is a no-op (sequential and concurrent)', async () => {
    const ph = phone(2), out = wamid('out2'), inb = wamid('in2')
    const again = await deliver([text(inb, ph, 'Is parking available?', out)])
    expect(again.status).toBe(200)

    const inb3 = wamid('in3')
    const raw = body([text(inb3, ph, 'second question', out, 1759140100)])
    cleanup.inbound.add(P.inboundDocIdFor(inb3))
    const [a, b] = await Promise.all([POST(signed(raw)), POST(signed(raw))])
    await flushAfter()
    expect([a.status, b.status]).toEqual([200, 200])

    expect(await msgCount(ORG_A, EV_A, ph)).toBe(2)
    expect(await conv(ORG_A, EV_A, ph)).toMatchObject({ unreadCount: 2, messageCount: 2, lastMessagePreview: 'second question' })
  })

  it('4 · one notification per unread burst; a new burst after read notifies again; no message text', async () => {
    const ph = phone(2)
    // Burst so far: in2 (0 → 1, notified), in3 (1 → 2, not notified).
    expect(await notif(ORG_A, wamid('in2'))).toBe(true)
    expect(await notif(ORG_A, wamid('in3'))).toBe(false)
    const n = (await adminDb.doc(`users/${ORG_A}/notifications/whatsapp_${P.inboundDocIdFor(wamid('in2'))}`).get()).data()
    expect(n).toMatchObject({ category: 'message', title: 'New WhatsApp message', eventId: EV_A, read: false })
    expect(String(n?.body)).toContain('Asha Rao')
    expect(String(n?.body)).not.toContain('parking')

    // Mark read (Phase 1b's endpoint will do exactly this), then a new message.
    await convRef(ORG_A, EV_A, ph).update({ unreadCount: 0 })
    const inb4 = wamid('in4')
    await deliver([text(inb4, ph, 'third', wamid('out2'), 1759140200)])
    expect(await notif(ORG_A, inb4)).toBe(true)
    expect(await conv(ORG_A, EV_A, ph)).toMatchObject({ unreadCount: 1, messageCount: 3 })
  })

  it('5 · with the flag OFF, messages still route but no notification is written', async () => {
    T.flags.whatsappInbox = false
    try {
      const ph = phone(2), inb = wamid('in5')
      await convRef(ORG_A, EV_A, ph).update({ unreadCount: 0 })
      await deliver([text(inb, ph, 'flag off', wamid('out2'), 1759140300)])
      expect((await receipt(inb))?.state).toBe('routed')
      expect(await notif(ORG_A, inb)).toBe(false)
    } finally {
      T.flags.whatsappInbox = true
    }
  })

  it('6 · context via registrations.whatsappMessageId when the log row is missing', async () => {
    const ph = phone(6), out = wamid('out6'), inb = wamid('in6')
    await registration(`wainbox-reg6-${PID}`, { org: ORG_B, ev: EV_B, phone: `+91 ${local(ph)}`, name: 'Ravi K', wamid: out })
    await deliver([text(inb, ph, 'hello', out)])
    expect(await conv(ORG_B, EV_B, ph)).toMatchObject({ organizerUid: ORG_B, attendeeName: 'Ravi K', unreadCount: 1 })
    expect(((await receipt(inb))?.routing as Json).method).toBe('context_registration')
  })

  // ── the approved safeguard ────────────────────────────────────────────────
  it('7 · an INVALID explicit context is unmatched even though a phone fallback exists', async () => {
    const ph = phone(2)   // has a conversation with ORG_A / EV_A
    const before = await conv(ORG_A, EV_A, ph)

    // (a) context points at a message sent to a DIFFERENT phone
    const outX = wamid('outX'), inX = wamid('inX')
    await outbound(`wainbox-logX-${PID}`, { org: ORG_B, ev: EV_B, reg: `wainbox-regX-${PID}`, phone: local(phone(99)), wamid: outX })
    // (b) context points at an organizer-directed notification (no registrationId)
    const outO = wamid('outO'), inO = wamid('inO')
    await outbound(`wainbox-logO-${PID}`, { org: ORG_A, ev: EV_A, reg: null, phone: local(ph), wamid: outO })
    // (c) context conflicts across organizers
    const outC = wamid('outC'), inC = wamid('inC')
    await outbound(`wainbox-logC1-${PID}`, { org: ORG_A, ev: EV_A, reg: `wainbox-r1-${PID}`, phone: local(ph), wamid: outC })
    await outbound(`wainbox-logC2-${PID}`, { org: ORG_B, ev: EV_B, reg: `wainbox-r2-${PID}`, phone: local(ph), wamid: outC })

    await deliver([text(inX, ph, 'x', outX, 1759140400), text(inO, ph, 'o', outO, 1759140401), text(inC, ph, 'c', outC, 1759140402)])

    expect(await receipt(inX)).toMatchObject({ state: 'unmatched', routing: { reason: 'context_phone_mismatch', context: 'invalid' }, text: 'x' })
    expect(await receipt(inO)).toMatchObject({ state: 'unmatched', routing: { reason: 'context_organizer_notification' } })
    expect(await receipt(inC)).toMatchObject({ state: 'unmatched', routing: { reason: 'context_conflict' } })
    // The existing conversation was not touched by any of them.
    const after = await conv(ORG_A, EV_A, ph)
    expect(after?.messageCount).toBe(before?.messageCount)
    expect(after?.unreadCount).toBe(before?.unreadCount)
  })

  // ── phone fallback ────────────────────────────────────────────────────────
  it('8 · no context + exactly one existing conversation routes by phone', async () => {
    const ph = phone(6), inb = wamid('in8')
    await deliver([text(inb, ph, 'no reply button used', undefined, 1759140500)])
    expect((await receipt(inb))?.routing).toMatchObject({ method: 'phone_conversation', context: 'none' })
    expect(await conv(ORG_B, EV_B, ph)).toMatchObject({ messageCount: 2, lastMessagePreview: 'no reply button used' })
  })

  it('9 · no context + conversations with two organizers → unmatched, neither organizer sees it', async () => {
    const ph = phone(9)
    for (const [org, ev, tag] of [[ORG_A, EV_A, 'a'], [ORG_B, EV_B, 'b']] as const) {
      const out = wamid(`out9${tag}`)
      await outbound(`wainbox-log9${tag}-${PID}`, { org, ev, reg: `wainbox-reg9${tag}-${PID}`, phone: local(ph), wamid: out })
      await deliver([text(wamid(`seed9${tag}`), ph, 'seed', out, 1759140600)])
    }
    const inb = wamid('in9')
    await deliver([text(inb, ph, 'which event?', undefined, 1759140700)])
    expect(await receipt(inb)).toMatchObject({ state: 'unmatched', routing: { reason: 'ambiguous_organizer', candidateCount: 2 }, text: 'which event?' })
    expect((await conv(ORG_A, EV_A, ph))?.messageCount).toBe(1)
    expect((await conv(ORG_B, EV_B, ph))?.messageCount).toBe(1)
  })

  it('10 · no context + one organizer but two events → unmatched ambiguous_event', async () => {
    const ph = phone(10)
    for (const [ev, tag] of [[EV_A, 'a'], [EV_A2, 'b']] as const) {
      const out = wamid(`out10${tag}`)
      await outbound(`wainbox-log10${tag}-${PID}`, { org: ORG_A, ev, reg: `wainbox-reg10${tag}-${PID}`, phone: local(ph), wamid: out })
      await deliver([text(wamid(`seed10${tag}`), ph, 'seed', out, 1759140800)])
    }
    const inb = wamid('in10')
    await deliver([text(inb, ph, 'hello', undefined, 1759140900)])
    expect(await receipt(inb)).toMatchObject({ state: 'unmatched', routing: { reason: 'ambiguous_event' } })
  })

  it('11 · an unknown sender with no context is unmatched with content kept for review', async () => {
    const inb = wamid('in11')
    await deliver([text(inb, phone(11), 'who is this?')])
    expect(await receipt(inb)).toMatchObject({ state: 'unmatched', routing: { reason: 'no_candidates' }, text: 'who is this?', fromPhone: phone(11) })
  })

  it('12 · a message to a different business number is ignored and its content dropped', async () => {
    const inb = wamid('in12')
    await deliver([text(inb, phone(12), 'not for us')], { pnid: 'SOME-OTHER-NUMBER' })
    const r = await receipt(inb)
    expect(r).toMatchObject({ state: 'ignored', routing: { reason: 'foreign_number' } })
    expect(r).not.toHaveProperty('text')
  })

  // ── idempotency / recovery ────────────────────────────────────────────────
  it('13 · two routers racing on one receipt produce one message and one unread', async () => {
    const ph = phone(13), out = wamid('out13'), inb = wamid('in13')
    await outbound(`wainbox-log13-${PID}`, { org: ORG_A, ev: EV_A, reg: `wainbox-reg13-${PID}`, phone: local(ph), wamid: out })
    cleanup.inbound.add(P.inboundDocIdFor(inb))
    const { parseWhatsAppInboundMessages } = await import('@/lib/whatsapp/webhookInbound')
    const rec = await P.recordInboundMessages(parseWhatsAppInboundMessages(JSON.parse(body([text(inb, ph, 'race', out)]))))
    expect(rec.created).toHaveLength(1)
    const results = await Promise.all([P.routeInboundMessage(rec.created[0]), P.routeInboundMessage(rec.created[0])])
    expect(results.map(r => r.status).sort()).toEqual(['routed', 'skipped'])
    expect(await conv(ORG_A, EV_A, ph)).toMatchObject({ unreadCount: 1, messageCount: 1 })
  })

  it('14 · the sweep routes a receipt whose after() never ran, exactly once', async () => {
    const ph = phone(14), out = wamid('out14'), inb = wamid('in14')
    await outbound(`wainbox-log14-${PID}`, { org: ORG_B, ev: EV_B, reg: `wainbox-reg14-${PID}`, phone: local(ph), wamid: out })
    cleanup.inbound.add(P.inboundDocIdFor(inb))
    await POST(signed(body([text(inb, ph, 'stuck', out)])))
    T.afters.length = 0                        // simulate a frozen function: after() lost
    const id = P.inboundDocIdFor(inb)
    const { Timestamp } = await import('firebase-admin/firestore')
    await adminDb.collection('whatsappInbound').doc(id).update({ receivedAt: Timestamp.fromMillis(Date.now() - 10 * 60_000) })
    expect((await receipt(inb))?.state).toBe('received')

    await P.sweepReceivedInbound({ olderThanMs: 2 * 60_000, batchSize: 500 })
    expect((await receipt(inb))?.state).toBe('routed')
    await P.sweepReceivedInbound({ olderThanMs: 2 * 60_000, batchSize: 500 })
    expect(await conv(ORG_B, EV_B, ph)).toMatchObject({ unreadCount: 1, messageCount: 1 })
  })

  it('15 · a receipt that keeps failing is parked as unmatched after MAX_ROUTING_ATTEMPTS', async () => {
    const inb = wamid('in15')
    cleanup.inbound.add(P.inboundDocIdFor(inb))
    const { parseWhatsAppInboundMessages } = await import('@/lib/whatsapp/webhookInbound')
    const rec = await P.recordInboundMessages(parseWhatsAppInboundMessages(JSON.parse(body([text(inb, phone(15), 'boom', wamid('out15'))]))))
    const spy = vi.spyOn(P.firestoreRoutingLookups, 'logsByWamid').mockRejectedValue(new Error('simulated outage'))
    try {
      for (let i = 0; i < P.MAX_ROUTING_ATTEMPTS; i++) await P.routeInboundMessage(rec.created[0])
    } finally {
      spy.mockRestore()
    }
    expect(await receipt(inb)).toMatchObject({
      state: 'unmatched', attempts: P.MAX_ROUTING_ATTEMPTS, lastError: 'simulated outage',
      routing: { reason: 'processing_failed' }, text: 'boom',
    })
  })

  // ── regression: delivery statuses ─────────────────────────────────────────
  it('16 · a status-only payload still updates emailLogs and creates no receipt', async () => {
    const out = wamid('out16'), id = `wainbox-log16-${PID}`
    await outbound(id, { org: ORG_A, ev: EV_A, reg: `wainbox-reg16-${PID}`, phone: local(phone(16)), wamid: out })
    const raw = body([], { statuses: [{ id: out, status: 'delivered', timestamp: '1759141000', recipient_id: phone(16) }] })
    const res = await POST(signed(raw))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, processed: 1 })
    expect((await adminDb.collection('emailLogs').doc(id).get()).data()).toMatchObject({ waStatus: 'delivered', status: 'delivered' })
    expect(T.afters).toHaveLength(0)
  })

  it('17 · a payload with BOTH a status and a message handles each', async () => {
    const ph = phone(2), out = wamid('out17'), id = `wainbox-log17-${PID}`, inb = wamid('in17')
    await outbound(id, { org: ORG_A, ev: EV_A, reg: `wainbox-reg2-${PID}`, phone: local(ph), wamid: out })
    cleanup.inbound.add(P.inboundDocIdFor(inb))
    const raw = body([text(inb, ph, 'both', out, 1759141100)], { statuses: [{ id: out, status: 'read', timestamp: '1759141100' }] })
    const res = await POST(signed(raw))
    await flushAfter()
    expect(res.status).toBe(200)
    expect((await adminDb.collection('emailLogs').doc(id).get()).data()?.waStatus).toBe('read')
    expect((await receipt(inb))?.state).toBe('routed')
  })

  it('18 · malformed JSON with a valid signature is acknowledged and writes nothing', async () => {
    const res = await POST(signed('{not json'))
    expect(res.status).toBe(200)
  })

  // ── notification atomicity + sweep pacing ─────────────────────────────────
  it('20 · a failed notification write rolls back the whole routing — nothing half-committed; the retry lands once', async () => {
    const ph = phone(20), out = wamid('out20'), inb = wamid('in20'), id = P.inboundDocIdFor(inb)
    await outbound(`wainbox-log20-${PID}`, { org: ORG_A, ev: EV_A2, reg: `wainbox-reg20-${PID}`, phone: local(ph), wamid: out })
    T.breakNotification = true
    try {
      await deliver([text(inb, ph, 'atomic?', out)])
    } finally {
      T.breakNotification = false
    }
    // Rolled back: the receipt is still pending with one failed attempt, and NOTHING else exists.
    expect(await receipt(inb)).toMatchObject({ state: 'received', attempts: 1, text: 'atomic?' })
    expect((await convRef(ORG_A, EV_A2, ph).get()).exists).toBe(false)
    expect(await notif(ORG_A, inb)).toBe(false)

    // The retry (what the sweep does) commits message + unread + notification together, once.
    expect(await P.routeInboundMessage(id)).toMatchObject({ status: 'routed', notified: true })
    expect(await conv(ORG_A, EV_A2, ph)).toMatchObject({ unreadCount: 1, adminUnreadCount: 1, messageCount: 1 })
    expect(await msgCount(ORG_A, EV_A2, ph)).toBe(1)
    expect(await notif(ORG_A, inb)).toBe(true)
    expect(await P.routeInboundMessage(id)).toEqual({ status: 'skipped' })
  })

  it('21 · the sweep gives each stuck receipt exactly ONE attempt per run, across pages', async () => {
    const { Timestamp } = await import('firebase-admin/firestore')
    const { parseWhatsAppInboundMessages } = await import('@/lib/whatsapp/webhookInbound')
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const inb = wamid(`sweep${i}`)
      const rec = await P.recordInboundMessages(parseWhatsAppInboundMessages(JSON.parse(body([text(inb, phone(30 + i), `stuck ${i}`, wamid('out-none'))]))))
      ids.push(...rec.created)
    }
    ids.forEach(id => cleanup.inbound.add(id))
    // Oldest possible, so they sit at the head of the queue regardless of other stuck data.
    for (const id of ids) await adminDb.collection('whatsappInbound').doc(id).update({ receivedAt: Timestamp.fromMillis(1_000 + ids.indexOf(id)) })

    const spy = vi.spyOn(P.firestoreRoutingLookups, 'logsByWamid').mockRejectedValue(new Error('simulated outage'))
    try {
      // batchSize 2 < 3 failing receipts: the old loop re-read the failing head and retried
      // it within the same run; the cursor must move past it instead.
      await P.sweepReceivedInbound({ olderThanMs: 60_000, batchSize: 2 })
      const after1 = await Promise.all(ids.map(id => adminDb.collection('whatsappInbound').doc(id).get().then(s => s.data()?.attempts)))
      expect(after1).toEqual([1, 1, 1])
      await P.sweepReceivedInbound({ olderThanMs: 60_000, batchSize: 2 })
      const after2 = await Promise.all(ids.map(id => adminDb.collection('whatsappInbound').doc(id).get().then(s => s.data()?.attempts)))
      expect(after2).toEqual([2, 2, 2])
    } finally {
      spy.mockRestore()
    }
  })

  // ── firestore.rules with CLIENT credentials ───────────────────────────────
  // Everything above uses the Admin SDK, which bypasses rules. This proves the explicit
  // denies with a real ID token — the OWNING organizer's — through the Firestore REST API,
  // exactly as userProfileRules.emu.test.ts does. The emulator reads firestore.rules from
  // disk; production enforces nothing until the rules are DEPLOYED.
  it('19 · even the owning organizer cannot read or write inbox data from the client', async () => {
    const FS_HOST   = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'
    const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const PROJECT   = process.env.GCLOUD_PROJECT ?? 'demo-registerdesk'
    const API_KEY   = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-api-key'
    const DOCS      = `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`

    const { adminAuth } = await import('@/lib/firebase/admin')
    const custom = await adminAuth.createCustomToken(ORG_A)
    const signIn = await fetch(
      `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) },
    )
    const { idToken } = await signIn.json() as { idToken?: string }
    expect(idToken).toBeTruthy()
    const auth = { Authorization: `Bearer ${idToken}` }

    // Positive control: the SAME token reads the owner's own notification (allowed by the
    // existing rule). Without this, a broken token would make every 403 below vacuous.
    const own = await fetch(`${DOCS}/users/${ORG_A}/notifications/whatsapp_${P.inboundDocIdFor(wamid('in2'))}`, { headers: auth })
    expect(own.status).toBe(200)

    const convId = C.conversationIdFor(ORG_A, EV_A, phone(2))
    const msgId  = P.inboundDocIdFor(wamid('in2'))
    const paths  = [
      `whatsappConversations/${convId}`,
      `whatsappConversations/${convId}/messages/${msgId}`,
      `whatsappInbound/${msgId}`,
    ]
    // The documents exist (written above), so a 403 is the rule, not a 404.
    for (const p of paths) expect((await adminDb.doc(p).get()).exists, p).toBe(true)

    for (const p of paths) {
      const read  = await fetch(`${DOCS}/${p}`, { headers: auth })
      const write = await fetch(`${DOCS}/${p}?updateMask.fieldPaths=unreadCount`, {
        method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { unreadCount: { integerValue: '0' } } }),
      })
      expect([p, read.status, write.status]).toEqual([p, 403, 403])
    }
    const list = await fetch(`${DOCS}/whatsappConversations`, { headers: auth })
    expect(list.status).toBe(403)

    await adminAuth.deleteUser(ORG_A).catch(() => undefined)
  })
})
