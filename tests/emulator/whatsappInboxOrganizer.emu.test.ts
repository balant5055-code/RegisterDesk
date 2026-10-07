// WhatsApp Inbox (Phase 1b) — the organizer inbox API against REAL Firestore (emulator).
//
// Drives the four real route handlers. Only the authentication boundary (authorizeWorkspace,
// so a test can act as organizer A, organizer B, or a refused caller), the feature flag and
// the Meta env values are mocked. Queries, ownership checks, pagination, mark-read and the
// count aggregate are production code.
//
// ⚠ The emulator does NOT enforce composite indexes; they must be deployed before production.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const T = vi.hoisted(() => ({
  caller: { uid: '', ok: true, status: 200, error: '' },
  flags:  { whatsappInbox: true },
}))

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async (_req: Request, permission: string) => T.caller.ok
    ? { ok: true, status: 200, error: '', workspaceUid: T.caller.uid, callerUid: `${T.caller.uid}-member`, role: 'admin', permissions: [permission] }
    : { ok: false, status: T.caller.status, error: T.caller.error, workspaceUid: '', callerUid: '', role: 'owner', permissions: [] },
}))
vi.mock('@/lib/config/resolveFeatureFlags', () => ({ getFeatureFlags: async () => ({ ...T.flags }) }))
vi.mock('@/lib/env', async orig => ({
  ...(await orig<typeof import('@/lib/env')>()),
  META_APP_ID: 'a', META_APP_SECRET: 's', META_ACCESS_TOKEN: 't', META_PHONE_NUMBER_ID: 'PNID-ORG-TEST',
  META_BUSINESS_ACCOUNT_ID: 'w', META_WEBHOOK_VERIFY_TOKEN: 'v',
}))

const EMULATOR    = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID  = process.pid
const A    = `wainboxorg-A-${PID}`
const B    = `wainboxorg-B-${PID}`
const C    = `wainboxorg-C-${PID}`       // pagination fixture
const EV1  = `wainboxorg-ev1-${PID}`
const EV2  = `wainboxorg-ev2-${PID}`
const phone = (n: number) => `917${String(PID * 1000 + n).padStart(9, '0')}`

type Json = Record<string, unknown>
const as = (uid: string) => { T.caller = { uid, ok: true, status: 200, error: '' } }

describeEmu('WhatsApp Inbox · organizer API', { timeout: 30_000 }, () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let conversationIdFor: typeof import('@/lib/whatsapp-inbox/types').conversationIdFor
  let LIST:   (req: NextRequest) => Promise<Response>
  let DETAIL: (req: NextRequest, ctx: { params: Promise<{ conversationId: string }> }) => Promise<Response>
  let READ:   (req: NextRequest, ctx: { params: Promise<{ conversationId: string }> }) => Promise<Response>
  let COUNT:  (req: NextRequest) => Promise<Response>
  const inboundIds: string[] = []

  const base = 'http://localhost/api/organizer/whatsapp-inbox'
  const list   = async (qs = '') => { const r = await LIST(new NextRequest(`${base}/conversations${qs}`)); return { status: r.status, body: await r.json() as Json } }
  const detail = async (id: string, qs = '') => { const r = await DETAIL(new NextRequest(`${base}/conversations/${id}${qs}`), { params: Promise.resolve({ conversationId: id }) }); return { status: r.status, body: await r.json() as Json } }
  const read   = async (id: string) => { const r = await READ(new NextRequest(`${base}/conversations/${id}/read`, { method: 'POST' }), { params: Promise.resolve({ conversationId: id }) }); return { status: r.status, body: await r.json() as Json } }
  const count  = async () => { const r = await COUNT(new NextRequest(`${base}/unread-count`)); return { status: r.status, body: await r.json() as Json } }
  const ids    = (b: Json) => ((b.items ?? []) as Json[]).map(i => i.id as string)

  /** A conversation exactly as the routing transaction writes it. */
  async function seed(org: string, ev: string, n: number, o: { name?: string | null; unread?: number; minutesAgo?: number; messages?: number } = {}) {
    const id  = conversationIdFor(org, ev, phone(n))
    const ref = adminDb.collection('whatsappConversations').doc(id)
    const at  = Timestamp.fromMillis(Date.now() - (o.minutesAgo ?? n) * 60_000)
    const unread = o.unread ?? 0
    await ref.set({
      organizerUid: org, eventId: ev, eventName: `Event ${ev.split('-')[1]}`, attendeePhone: phone(n),
      registrationIds: [`reg-${n}`], primaryRegistrationId: `reg-${n}`,
      attendeeName: o.name === undefined ? `Attendee ${n}` : o.name,
      attendeeNameLower: o.name === undefined ? `attendee ${n}` : (o.name?.toLowerCase() ?? null),
      lastMessageAt: at, lastMessagePreview: `hello from ${n}`, lastDirection: 'inbound', lastInboundAt: at,
      unreadCount: unread, unread: unread > 0, messageCount: o.messages ?? 1,
      lastReadAt: null, lastReadByUid: null, createdAt: at, updatedAt: at,
    })
    const msgs = o.messages ?? 1
    for (let i = 0; i < msgs; i += 400) {
      const batch = adminDb.batch()
      for (let j = i; j < Math.min(i + 400, msgs); j++) {
        batch.set(ref.collection('messages').doc(`m${String(j).padStart(4, '0')}`), {
          direction: 'inbound', wamid: `wamid.${n}.${j}`, type: 'text', text: `message ${j}`,
          media: null, location: null, contextWamid: j === 0 ? 'wamid.out' : null,
          metaTimestamp: Timestamp.fromMillis(at.toMillis() - (msgs - j) * 1000), status: 'received',
          routingMethod: 'context', createdAt: at,
        })
      }
      await batch.commit()
    }
    return id
  }

  const ID: Record<string, string> = {}

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('Refusing to run outside a demo- project.')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
    ;({ conversationIdFor } = await import('@/lib/whatsapp-inbox/types'))
    ;({ GET: LIST }   = await import('@/app/api/organizer/whatsapp-inbox/conversations/route'))
    ;({ GET: DETAIL } = await import('@/app/api/organizer/whatsapp-inbox/conversations/[conversationId]/route'))
    ;({ POST: READ }  = await import('@/app/api/organizer/whatsapp-inbox/conversations/[conversationId]/read/route'))
    ;({ GET: COUNT }  = await import('@/app/api/organizer/whatsapp-inbox/unread-count/route'))

    ID.a1 = await seed(A, EV1, 1, { name: 'Asha Rao', unread: 2, minutesAgo: 1, messages: 3 })
    ID.a2 = await seed(A, EV2, 2, { name: 'Ravi Kumar', minutesAgo: 5 })
    ID.a3 = await seed(A, EV1, 3, { name: null, unread: 1, minutesAgo: 10 })
    ID.a4 = await seed(A, EV1, 4, { name: 'Long Thread', minutesAgo: 20, messages: 55 })
    ID.b1 = await seed(B, EV1, 5, { name: 'Other Org Person', unread: 4, minutesAgo: 0 })
    for (let i = 0; i < 35; i++) await seed(C, EV1, 100 + i, { minutesAgo: 100 + i })
    // Warm-up. The emulator's FIRST query of a new shape was measured at >30s once (then
    // <1s on every rerun); absorbing it here keeps that cost out of an individual case.
    as(A)
    await list()
  }, 120_000)

  afterAll(async () => {
    if (!adminDb) return
    const convs = await adminDb.collection('whatsappConversations').where('organizerUid', 'in', [A, B, C]).get()
    for (const d of convs.docs) await adminDb.recursiveDelete(d.ref)
    for (const org of [A, B, C]) await adminDb.recursiveDelete(adminDb.doc(`users/${org}`))
    for (const id of inboundIds) await adminDb.collection('whatsappInbound').doc(id).delete()
  }, 120_000)

  // ── tenant isolation ──────────────────────────────────────────────────────
  it('1 · the list holds the caller’s conversations only, newest first', async () => {
    as(A)
    const r = await list()
    expect(r.status).toBe(200)
    expect(ids(r.body)).toEqual([ID.a1, ID.a2, ID.a3, ID.a4])
    const first = (r.body.items as Json[])[0]
    expect(first).toMatchObject({ attendeeName: 'Asha Rao', attendeePhone: `+${phone(1)}`, unreadCount: 2, eventId: EV1, registrationCount: 1 })
  })

  it('2 · an organizerUid query parameter is ignored', async () => {
    as(A)
    expect(ids((await list(`?organizerUid=${B}`)).body)).not.toContain(ID.b1)
  })

  it('3 · another organizer’s conversation answers 404, exactly like a missing one', async () => {
    as(A)
    const foreign = await detail(ID.b1)
    const missing = await detail(`${A}__nope__919999999999`)
    expect(foreign).toEqual({ status: 404, body: { success: false, error: 'Conversation not found.' } })
    expect(missing).toEqual(foreign)
  })

  it('4 · another organizer cannot mark a conversation read', async () => {
    as(A)
    expect((await read(ID.b1)).status).toBe(404)
    expect((await adminDb.collection('whatsappConversations').doc(ID.b1).get()).data()).toMatchObject({ unreadCount: 4, unread: true })
  })

  it('5 · a cursor pointing at another organizer’s conversation cannot position the list', async () => {
    as(A)
    expect(ids((await list(`?cursor=${ID.b1}`)).body)).toEqual([ID.a1, ID.a2, ID.a3, ID.a4])
  })

  // ── filters + search ──────────────────────────────────────────────────────
  it('6 · event and unread filters, alone and combined', async () => {
    as(A)
    expect(ids((await list(`?eventId=${EV2}`)).body)).toEqual([ID.a2])
    expect(ids((await list('?unread=1')).body)).toEqual([ID.a1, ID.a3])
    expect(ids((await list(`?eventId=${EV1}&unread=1`)).body)).toEqual([ID.a1, ID.a3])
    expect(ids((await list(`?eventId=${EV2}&unread=1`)).body)).toEqual([])
  })

  it('7 · search by name, phone digits and event — scoped to the caller', async () => {
    as(A)
    expect(ids((await list('?q=asha')).body)).toEqual([ID.a1])
    expect(ids((await list(`?q=${phone(3).slice(-6)}`)).body)).toEqual([ID.a3])
    expect(ids((await list(`?q=${encodeURIComponent('ev2')}`)).body)).toEqual([ID.a2])
    expect(ids((await list('?q=Other%20Org')).body)).toEqual([])     // B's attendee
    const r = await list('?q=zzzz')
    expect(r.body).toMatchObject({ success: true, items: [], nextCursor: null, truncated: false })
  })

  // ── pagination ────────────────────────────────────────────────────────────
  it('8 · list pagination: 30 + 5, no overlap, stable order', async () => {
    as(C)
    const p1 = await list()
    expect((p1.body.items as Json[]).length).toBe(30)
    expect(p1.body.nextCursor).toBeTruthy()
    const p2 = await list(`?cursor=${p1.body.nextCursor}`)
    expect((p2.body.items as Json[]).length).toBe(5)
    expect(p2.body.nextCursor).toBeNull()
    const all = [...ids(p1.body), ...ids(p2.body)]
    expect(new Set(all).size).toBe(35)
  })

  it('9 · message history: newest page oldest→newest, then the earlier page', async () => {
    as(A)
    const r = await detail(ID.a4)
    const msgs = r.body.messages as Json[]
    expect(msgs).toHaveLength(50)
    expect(msgs[0].text).toBe('message 5')
    expect(msgs[49].text).toBe('message 54')
    const older = await detail(ID.a4, `?before=${r.body.olderCursor}`)
    expect((older.body.messages as Json[]).map(m => m.text)).toEqual(['message 0', 'message 1', 'message 2', 'message 3', 'message 4'])
    expect(older.body.olderCursor).toBeNull()
  })

  it('10 · reading a conversation does NOT mark it read', async () => {
    as(A)
    const r = await detail(ID.a1)
    expect(r.body.conversation).toMatchObject({ id: ID.a1, unreadCount: 2, primaryRegistrationId: 'reg-1' })
    expect((r.body.messages as Json[])[0]).toMatchObject({ direction: 'inbound', type: 'text', hasContext: true })
    expect((await adminDb.collection('whatsappConversations').doc(ID.a1).get()).data()?.unreadCount).toBe(2)
  })

  // ── unread ────────────────────────────────────────────────────────────────
  it('11 · unread count, mark-read (idempotent), count follows', async () => {
    as(A)
    expect((await count()).body).toEqual({ success: true, count: 2 })
    expect((await read(ID.a1)).body).toEqual({ success: true })
    expect((await read(ID.a1)).body).toEqual({ success: true })
    expect((await adminDb.collection('whatsappConversations').doc(ID.a1).get()).data())
      .toMatchObject({ unreadCount: 0, unread: false, lastReadByUid: `${A}-member` })
    expect((await count()).body).toEqual({ success: true, count: 1 })
    expect(ids((await list('?unread=1')).body)).toEqual([ID.a3])
    as(B)
    expect((await count()).body).toEqual({ success: true, count: 1 })   // B unaffected by A
  })

  it('12 · end to end: a routed inbound message raises unread; reading clears it; the next one raises it again', async () => {
    const P = await import('@/lib/whatsapp-inbox/persist')
    const { parseWhatsAppInboundMessages } = await import('@/lib/whatsapp/webhookInbound')
    const deliver = async (wamid: string, text: string, ts: number) => {
      const payload = { entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'PNID-ORG-TEST' },
        messages: [{ from: phone(2), id: wamid, timestamp: String(ts), type: 'text', text: { body: text } }],
      } }] }] }
      const rec = await P.recordInboundMessages(parseWhatsAppInboundMessages(payload))
      inboundIds.push(...rec.created)
      for (const id of rec.created) await P.routeInboundMessage(id)
    }
    as(A)
    const before = (await count()).body.count as number
    await deliver(`wamid.org.${PID}.1`, 'is the venue open?', Math.floor(Date.now() / 1000))   // phone fallback → ID.a2
    expect((await count()).body.count).toBe(before + 1)
    expect(ids((await list()).body)[0]).toBe(ID.a2)
    expect((await list()).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: ID.a2, unreadCount: 1, lastMessagePreview: 'is the venue open?' })]))

    await read(ID.a2)
    expect((await count()).body.count).toBe(before)
    await deliver(`wamid.org.${PID}.2`, 'thanks', Math.floor(Date.now() / 1000) + 1)
    expect((await count()).body.count).toBe(before + 1)
  })

  // ── gates ─────────────────────────────────────────────────────────────────
  it('13 · a refused caller gets the authorizer’s status on every route', async () => {
    T.caller = { uid: '', ok: false, status: 403, error: 'Missing required permission: broadcasts.' }
    for (const r of [await list(), await detail(ID.a1), await read(ID.a1), await count()]) {
      expect(r).toEqual({ status: 403, body: { success: false, error: 'Missing required permission: broadcasts.' } })
    }
    T.caller = { uid: '', ok: false, status: 401, error: 'Unauthorized' }
    expect((await count()).status).toBe(401)
  })

  it('14 · with the flag OFF every route answers 404 and nothing changes', async () => {
    as(A)
    T.flags.whatsappInbox = false
    try {
      for (const r of [await list(), await detail(ID.a3), await read(ID.a3), await count()]) {
        expect(r).toEqual({ status: 404, body: { success: false, error: 'The WhatsApp Inbox is not enabled.' } })
      }
      expect((await adminDb.collection('whatsappConversations').doc(ID.a3).get()).data()?.unreadCount).toBe(1)
    } finally {
      T.flags.whatsappInbox = true
    }
  })
})
