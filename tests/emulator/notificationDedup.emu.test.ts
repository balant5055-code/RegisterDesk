// RD-NOTIFY-DEDUP — duplicate-email regression suite, on REAL Firestore + Auth (emulators), through
// the REAL outbox, recipient resolver, support-ticket route and payout-profile route. Only the email
// engine is stubbed — every "send" is recorded here; no provider is contacted, no real address used.
//
//   outbox     · two concurrent drivers send each recipient once · a driver that loses its lease
//                mid-send stops, and the takeover neither repeats the in-flight recipient nor the
//                ones already delivered · a crash after the provider accepted (in-flight left
//                behind) is settled 'unconfirmed', never re-sent · ambiguous answers stay unconfirmed
//   recipients · the support inbox and admin accounts are de-duplicated by MAILBOX (Gmail dots,
//                +tags, googlemail.com, case)
//   support    · one ticket → one Super Admin notice → one email per mailbox · a repeated submission
//                with the same Idempotency-Key (sequential or concurrent) → the same ticket, no second
//                notice · different keys → separate tickets
//   payout     · create and update each queue one notice · a replay with the same key writes nothing
//                (no second history row, no second notice) · two distinct saves notify independently
//                · the route never sends email itself (outbox only, after the commit)

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/rateLimit', async orig => ({ ...(await orig<typeof import('@/lib/rateLimit')>()), checkRateLimit: () => ({ limited: false, remaining: 99, resetAt: 0 }) }))
vi.mock('@/lib/config/resolveBrandingConfig', async orig => ({
  ...(await orig<typeof import('@/lib/config/resolveBrandingConfig')>()),
  getBrandingConfig: async () => ({ supportEmail: 'QA.Support+Desk@googlemail.com' }),       // same mailbox as qasupport@gmail.com
}))
type Outcome = 'ok' | 'unknown'
const h = vi.hoisted(() => ({ sent: [] as { to: string; subject: string }[], delayMs: 0, outcome: new Map<string, Outcome>() }))
vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      ...real.notificationEngine,
      isAvailable: () => true,
      send: async (_t: unknown, p: { to: string; subject: string }) => {
        if (h.delayMs) await new Promise(r => setTimeout(r, h.delayMs))
        if (h.outcome.get(p.to.toLowerCase()) === 'unknown') return { success: false, deliveryUnknown: true, error: 'timeout' }
        h.sent.push({ to: p.to, subject: p.subject }); return { success: true, messageId: `m-${h.sent.length}` }
      },
    },
  }
})

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `dd${process.pid}`
type Json = Record<string, unknown>

describeEmu('duplicate emails — outbox, recipients, support tickets, payout profile', () => {
  let db: import('firebase-admin/firestore').Firestore
  let auth: import('firebase-admin/auth').Auth
  let ob: typeof import('@/lib/notifications/outbox')
  let createTicketRoute: (r: Request) => Promise<Response>
  let payoutPut: (r: Request) => Promise<Response>
  const ORG = `${P}-org`, A1 = `${P}-a1`, A2 = `${P}-a2`
  const tokens: Record<string, string> = {}
  const ids: string[] = []
  let prevAdmins: string | undefined

  async function idToken(uid: string) {
    const custom = await auth.createCustomToken(uid)
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })
    return (await res.json() as { idToken: string }).idToken
  }
  const req = (url: string, method: string, body: unknown, key?: string) => new NextRequest(new Request(`http://x${url}`, {
    method, headers: { authorization: `Bearer ${tokens[ORG]}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body),
  }))
  const call = async (r: Promise<Response>) => { const res = await r; return { status: res.status, body: await res.json().catch(() => ({})) as Json } }
  const outboxDocs = async (prefix: string) => (await db.collection('notificationOutbox').get()).docs.filter(d => d.id.startsWith(prefix))
  const make = async (id: string) => {
    ids.push(id)
    const b = db.batch()
    ob.stageOutboxMessage(b, { id, audience: { kind: 'super_admins' }, adminKind: 'support_ticket', subject: `subj ${id}`, heading: 'h', intro: 'i', facts: [], path: '/x', ctaLabel: 'c' })
    await b.commit()
  }
  const sentFor = (id: string) => h.sent.filter(s => s.subject === `subj ${id}`).map(s => s.to.toLowerCase()).sort()
  const ticket = { subject: 'Scanner rejects valid QR codes', description: 'Every QR code scans as invalid at the gate since this morning.', category: 'checkin_qr', priority: 'high', eventId: null }
  const payout = (holder = 'Dawn Runners') => ({ accountHolderName: holder, payoutMethod: 'upi', upiId: 'dawnrunners@okbank', panNumber: 'ABCDE1234F' })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db, adminAuth: auth } = await import('@/lib/firebase/admin'))
    ob = await import('@/lib/notifications/outbox')
    createTicketRoute = (await import('@/app/api/organizer/support/tickets/route') as unknown as { POST: typeof createTicketRoute }).POST
    payoutPut = (await import('@/app/api/organizer/payout-profile/route') as unknown as { PUT: typeof payoutPut }).PUT
    const emails: Record<string, string> = { [ORG]: `${ORG}@rd.test`, [A1]: 'QA.Admin@gmail.com', [A2]: 'qasupport@gmail.com' }
    for (const uid of [ORG, A1, A2]) {
      await auth.deleteUser(uid).catch(() => null)
      await auth.createUser({ uid, email: emails[uid], emailVerified: true })
    }
    await db.doc(`users/${ORG}`).set({ uid: ORG, email: emails[ORG], name: 'Dawn Owner', organizationName: 'Dawn Runners', role: 'organizer', workspaceOwner: true, accountStatus: 'active', createdAt: new Date() })
    prevAdmins = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = [A1, A2].join(',')
    tokens[ORG] = await idToken(ORG)
  }, T)

  beforeEach(() => { h.sent = []; h.delayMs = 0; h.outcome = new Map() })

  afterAll(async () => {
    if (prevAdmins === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = prevAdmins
    for (const id of ids) {
      await db.doc(`notificationOutbox/${id}`).delete().catch(() => null)
      await db.doc(`adminNotifications/${id}`).delete().catch(() => null)
    }
    for (const d of (await db.collection('supportTickets').where('workspaceUid', '==', ORG).get()).docs) await db.recursiveDelete(d.ref)
    for (const d of await outboxDocs(`support-ticket_`)) if (String(d.data().subject ?? '').includes(ticket.subject)) { await d.ref.delete(); await db.doc(`adminNotifications/${d.id}`).delete().catch(() => null) }
    for (const d of await outboxDocs(`payout-profile_${ORG}`)) { await d.ref.delete(); await db.doc(`adminNotifications/${d.id}`).delete().catch(() => null) }
    for (const d of (await db.collection('payoutProfileHistory').where('organizerUid', '==', ORG).get().catch(() => null))?.docs ?? []) await d.ref.delete()
    await db.doc(`organizerPayoutProfiles/${ORG}`).delete().catch(() => null)
    for (const q of (await db.collection('supportTicketQuota').get()).docs.filter(d => d.id.startsWith(ORG))) await q.ref.delete()
    await db.recursiveDelete(db.doc(`users/${ORG}`)).catch(() => null)
    for (const uid of [ORG, A1, A2]) await auth.deleteUser(uid).catch(() => null)
  }, T)

  // ── recipients ──
  it('the support inbox and admin accounts are one recipient per MAILBOX', async () => {
    const { superAdminRecipients, canonicalMailbox } = await import('@/lib/notifications/superAdminRecipients')
    expect(canonicalMailbox('Bala.NT5055+ops@GoogleMail.com')).toBe('balant5055@gmail.com')
    expect(canonicalMailbox('team+x@example.org')).toBe('team@example.org')
    expect(canonicalMailbox('first.last@example.org')).toBe('first.last@example.org')          // dots matter outside Gmail
    // support 'QA.Support+Desk@googlemail.com' and admin 'qasupport@gmail.com' are the same inbox
    expect((await superAdminRecipients()).map(e => e.toLowerCase())).toEqual(['qa.support+desk@googlemail.com', 'qa.admin@gmail.com'])
  }, T)

  // ── outbox delivery safety ──
  it('two concurrent drivers: each recipient is sent exactly once', async () => {
    const id = `${P}-o1`; await make(id); h.delayMs = 40
    const outcomes = await Promise.all([ob.deliverOutboxMessage(id), ob.deliverOutboxMessage(id)])
    expect(outcomes.filter(o => o === 'sent')).toHaveLength(1)                // the other driver: busy / done
    expect(sentFor(id)).toEqual(['qa.admin@gmail.com', 'qa.support+desk@googlemail.com'])
  }, T)

  it('a driver that loses its lease mid-send stops; the takeover repeats nobody', async () => {
    const id = `${P}-o2`; await make(id); h.delayMs = 1200
    const t = Date.now()
    const first = ob.deliverOutboxMessage(id)                               // will be slow on its first recipient
    await new Promise(r => setTimeout(r, 300))
    const takeover = ob.deliverOutboxMessage(id, t + 3 * 60_000)            // sees the 2-minute lease as expired
    const outcomes = await Promise.all([first, takeover])
    expect(outcomes).toContain('busy')                                      // the first driver noticed it lost the lease
    const sent = sentFor(id)
    expect(new Set(sent).size).toBe(sent.length)                            // nobody twice
    const doc = (await db.doc(`notificationOutbox/${id}`).get()).data() as Json
    expect(doc.inflight ?? {}).toEqual({})
    expect(['sent', 'unconfirmed']).toContain(doc.status)
  }, T)

  it('a crash after the provider accepted (in-flight left behind) is settled unconfirmed, never re-sent', async () => {
    const id = `${P}-o3`; await make(id)
    const key = ob.recipientKey('QA.Admin@gmail.com')
    await db.doc(`notificationOutbox/${id}`).update({ status: 'sending', leaseId: 'dead-driver', leaseUntil: new Date(Date.now() - 1000), nextAttemptAt: new Date(Date.now() - 1000), [`inflight.${key}`]: 'dead-driver' })
    expect(await ob.deliverOutboxMessage(id)).toBe('unconfirmed')
    expect(sentFor(id)).toEqual(['qa.support+desk@googlemail.com'])        // only the one never attempted
    const doc = (await db.doc(`notificationOutbox/${id}`).get()).data() as Json
    expect(doc.skipped).toEqual({ [key]: 'unconfirmed' })
    expect(String(doc.lastError)).toContain('not re-sent')
    expect(await ob.deliverOutboxMessage(id, Date.now() + 86_400_000)).toBe('done')
    expect(sentFor(id)).toHaveLength(1)
  }, T)

  it('an ambiguous provider answer stays unconfirmed and is not retried', async () => {
    const id = `${P}-o4`; await make(id)
    h.outcome.set('qa.admin@gmail.com', 'unknown')
    expect(await ob.deliverOutboxMessage(id)).toBe('unconfirmed')
    h.outcome.clear()
    await ob.drainOutbox(50, Date.now() + 86_400_000)
    expect(sentFor(id)).toEqual(['qa.support+desk@googlemail.com'])
  }, T)

  // ── support tickets ──
  it('one ticket → one Super Admin notice → one email per mailbox; the same Idempotency-Key never opens a second', async () => {
    const key = `${P}-ticket-key-1`
    const first = await call(createTicketRoute(req('/api/organizer/support/tickets', 'POST', ticket, key)))
    expect(first.status).toBe(201)
    const again = await call(createTicketRoute(req('/api/organizer/support/tickets', 'POST', ticket, key)))
    expect(again).toMatchObject({ status: 200, body: { id: first.body.id, number: first.body.number, replayed: true } })
    const notices = await outboxDocs(`support-ticket_${first.body.id}`)
    expect(notices).toHaveLength(1)
    expect(await ob.deliverOutboxMessage(notices[0].id)).toBe('sent')
    expect(h.sent.map(s => s.to.toLowerCase()).sort()).toEqual(['qa.admin@gmail.com', 'qa.support+desk@googlemail.com'])

    // concurrent duplicates (double click) — one ticket, one notice
    const k2 = `${P}-ticket-key-2`
    const both = await Promise.all([0, 1].map(() => call(createTicketRoute(req('/api/organizer/support/tickets', 'POST', ticket, k2)))))
    expect(new Set(both.map(b => b.body.id)).size).toBe(1)
    expect(both.map(b => b.status).sort()).toEqual([200, 201])
    expect(await outboxDocs(`support-ticket_${both[0].body.id}`)).toHaveLength(1)

    // a different key is a different ticket
    const other = await call(createTicketRoute(req('/api/organizer/support/tickets', 'POST', ticket, `${P}-ticket-key-3`)))
    expect(other.status).toBe(201)
    expect(other.body.id).not.toBe(first.body.id)
    expect(await call(createTicketRoute(req('/api/organizer/support/tickets', 'POST', ticket, 'bad key!')))).toMatchObject({ status: 400 })
  }, T)

  // ── payout profile ──
  it('payout profile: create and update each queue one notice; a replay writes nothing; distinct saves notify independently', async () => {
    const history = async () => (await db.collection('payoutProfileHistory').where('organizerUid', '==', ORG).get()).size
    const k1 = `${P}-payout-key-1`
    const created = await call(payoutPut(req('/api/organizer/payout-profile', 'PUT', payout(), k1)))
    expect(created.status).toBe(200)
    expect(await outboxDocs(`payout-profile_${ORG}`)).toHaveLength(1)
    const h1 = await history()

    const replay = await call(payoutPut(req('/api/organizer/payout-profile', 'PUT', payout(), k1)))
    expect(replay).toMatchObject({ status: 200, body: { replayed: true } })
    expect(await outboxDocs(`payout-profile_${ORG}`)).toHaveLength(1)
    expect(await history()).toBe(h1)

    // concurrent replays of a NEW save — one write, one notice
    const k2 = `${P}-payout-key-2`
    const both = await Promise.all([0, 1].map(() => call(payoutPut(req('/api/organizer/payout-profile', 'PUT', payout('Dawn Runners Trust'), k2)))))
    expect(both.every(b => b.status === 200)).toBe(true)
    expect(await outboxDocs(`payout-profile_${ORG}`)).toHaveLength(2)
    expect(await history()).toBe(h1 + 1)

    // another legitimate update — its own notice
    await call(payoutPut(req('/api/organizer/payout-profile', 'PUT', payout('Dawn Runners Society'), `${P}-payout-key-3`)))
    const notices = await outboxDocs(`payout-profile_${ORG}`)
    expect(notices).toHaveLength(3)
    expect(notices.map(n => String(n.data().subject)).filter(s => s.startsWith('New payout profile submitted'))).toHaveLength(1)

    // each notice delivers exactly once per mailbox (two legitimate updates may share a subject)
    for (const n of notices) {
      const before = h.sent.length
      expect(await ob.deliverOutboxMessage(n.id)).toBe('sent')
      const mine = h.sent.slice(before).map(x => x.to.toLowerCase()).sort()
      expect(mine).toEqual(['qa.admin@gmail.com', 'qa.support+desk@googlemail.com'])
      expect(await ob.deliverOutboxMessage(n.id)).toBe('done')
    }
    expect(h.sent).toHaveLength(notices.length * 2)

    // no key → the previous behaviour (a new save each time)
    await call(payoutPut(req('/api/organizer/payout-profile', 'PUT', payout('Dawn Runners Club'))))
    expect(await outboxDocs(`payout-profile_${ORG}`)).toHaveLength(4)
  }, T)

  it('the payout route sends no email itself: one outbox message, staged in the save batch, delivered after it', () => {
    const src = readFileSync('app/api/organizer/payout-profile/route.ts', 'utf8')
    expect(src).not.toMatch(/notificationEngine|sendEmail|getEmailProvider|\.send\(/)
    expect(src.match(/stageOutboxMessage\(/g)).toHaveLength(1)
    expect(src.indexOf('await batch.commit()')).toBeLessThan(src.indexOf('scheduleOutboxDelivery(profileAlert.id)'))
  })
})
