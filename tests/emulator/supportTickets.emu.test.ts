// RD-SUPPORT-01 — Support tickets end to end on the emulators: real route handlers, real Firebase
// Auth tokens, real Firestore transactions, and real (emulated) Firebase Storage for screenshots.
// Only the email engine is stubbed (no provider is contacted) and the in-process burst limiter is
// switched off so the scenarios can run back to back.
//
//   create     · JSON and multipart; number, first message, history, Super Admin feed + outbox
//   ownership  · another workspace / a non-admin member who did not open it → 404 everywhere
//                (ticket, reply, screenshot); the owner and a workspace admin see it
//   admin      · organizer tokens and claim-only admins are refused on every admin endpoint
//   privacy    · an internal note never appears in any organizer response, inbox item or outbox doc
//   lifecycle  · waiting → organizer reply hands back; resolve → reopen; closed is final; window
//   triage     · priority / assignee recorded, not notified; assignee must be a Super Admin; stale
//   delivery   · an organizer notice is retried after a provider failure and then sent once
//   storage    · screenshots are private (no download token) and served only after authorization

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/rateLimit', async orig => ({ ...(await orig<typeof import('@/lib/rateLimit')>()), checkRateLimit: () => ({ limited: false, remaining: 99, resetAt: 0 }) }))
const h = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; html: string }[], fail: new Set<string>() }))
vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      ...real.notificationEngine,
      isAvailable: () => true,
      send: async (_t: unknown, p: { to: string; subject: string; html: string }) => {
        if (h.fail.has(p.to)) return { success: false, error: 'rejected by provider' }
        h.sent.push(p); return { success: true, messageId: `m-${h.sent.length}` }
      },
    },
  }
})

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `sup${process.pid}`
type Json = Record<string, unknown>
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4])
const SECRET = 'INTERNAL-ONLY note: refund was blocked by finance'

describeEmu('support tickets — organizer ↔ Super Admin', () => {
  let db: import('firebase-admin/firestore').Firestore
  let auth: import('firebase-admin/auth').Auth
  let ob: typeof import('@/lib/notifications/outbox')
  type R = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>
  const H: Record<string, R> = {}
  const OWNER = `${P}-owner`, ADMINM = `${P}-wsadmin`, MANAGER = `${P}-manager`, OTHER = `${P}-other`, SA = `${P}-sa`, SA2 = `${P}-sa2`, CLAIM = `${P}-claim`
  const tokens: Record<string, string> = {}
  const ticketIds: string[] = []
  let prevAdmins: string | undefined

  async function idToken(uid: string) {
    const custom = await auth.createCustomToken(uid)
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })
    return (await res.json() as { idToken: string }).idToken
  }
  const req = (url: string, who: string | null, method = 'GET', body?: unknown) => {
    const isForm = body instanceof FormData
    return new NextRequest(new Request(`http://x${url}`, {
      method,
      headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {}),
    }))
  }
  const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) })
  const call = async (r: Promise<Response>) => { const res = await r; const text = await res.text(); let body: Json = {}; try { body = JSON.parse(text) } catch { /* bytes */ } return { status: res.status, body, text, headers: res.headers } }
  const ticket = (extra: Json = {}) => ({ subject: 'Scanner says invalid ticket', description: 'Every QR code scans as invalid at the gate since this morning.', category: 'checkin_qr', priority: 'high', eventId: null, ...extra })
  async function open(who = OWNER, extra: Json = {}) {
    const r = await call(H.orgCreate(req('/api/organizer/support/tickets', who, 'POST', ticket(extra))))
    if (r.status === 201) ticketIds.push(String(r.body.id))
    return r
  }
  const form = (payload: Json, files: { bytes: Uint8Array; name: string; type: string }[]) => {
    const fd = new FormData()
    fd.set('payload', JSON.stringify(payload))
    for (const f of files) fd.append('files', new File([f.bytes as BlobPart], f.name, { type: f.type }))
    return fd
  }
  const tdoc = async (id: string) => (await db.doc(`supportTickets/${id}`).get()).data() as Json
  const outboxFor = async (id: string) => (await db.collection('notificationOutbox').get()).docs.filter(d => d.id.startsWith(`support-ticket_${id}`)).map(d => ({ id: d.id, ...d.data() as Json }))
  const orgReply = (id: string, who: string, body: unknown) => call(H.orgReply(req(`/api/organizer/support/tickets/${id}/replies`, who, 'POST', body), ctx({ id })))
  const admReply = (id: string, body: unknown, who = SA) => call(H.admReply(req(`/api/admin/support/tickets/${id}/replies`, who, 'POST', body), ctx({ id })))
  const admPatch = (id: string, body: unknown, who = SA) => call(H.admPatch(req(`/api/admin/support/tickets/${id}`, who, 'PATCH', body), ctx({ id })))

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db, adminAuth: auth } = await import('@/lib/firebase/admin'))
    ob = await import('@/lib/notifications/outbox')
    const m = (p: string) => import(p) as Promise<Record<string, R>>
    const [l, d, rp, at, al, ad, ar, an, aa, cl] = await Promise.all([
      m('@/app/api/organizer/support/tickets/route'), m('@/app/api/organizer/support/tickets/[id]/route'),
      m('@/app/api/organizer/support/tickets/[id]/replies/route'), m('@/app/api/organizer/support/tickets/[id]/attachments/[attachmentId]/route'),
      m('@/app/api/admin/support/tickets/route'), m('@/app/api/admin/support/tickets/[id]/route'),
      m('@/app/api/admin/support/tickets/[id]/replies/route'), m('@/app/api/admin/support/tickets/[id]/notes/route'),
      m('@/app/api/admin/support/tickets/[id]/attachments/[attachmentId]/route'),
      m('@/app/api/organizer/support/tickets/[id]/close/route'),
    ])
    Object.assign(H, { orgList: l.GET, orgCreate: l.POST, orgGet: d.GET, orgReply: rp.POST, orgFile: at.GET, admList: al.GET, admGet: ad.GET, admPatch: ad.PATCH, admReply: ar.POST, admNote: an.POST, admFile: aa.GET, orgClose: cl.POST })

    for (const uid of [OWNER, ADMINM, MANAGER, OTHER, SA, SA2, CLAIM]) {
      await auth.deleteUser(uid).catch(() => null)
      await auth.createUser({ uid, email: `${uid}@rd.test`, emailVerified: true, displayName: uid })
      const owner = uid === OWNER || uid === OTHER
      await db.doc(`users/${uid}`).set({ uid, email: `${uid}@rd.test`, name: `Name ${uid}`, ...(owner ? { organizationName: `${uid} Events`, workspaceOwner: true } : {}), role: 'organizer', accountStatus: 'active', createdAt: new Date() })
    }
    await auth.setCustomUserClaims(CLAIM, { admin: true, isAdmin: true, role: 'superadmin' })
    for (const [uid, role] of [[ADMINM, 'admin'], [MANAGER, 'manager']] as const) {
      await db.doc(`teamMembers/${P}-${role}`).set({ organizerUid: OWNER, memberUid: uid, email: `${uid}@rd.test`, role, permissions: [], eventIds: [], status: 'active', invitedBy: OWNER, invitedAt: new Date(), acceptedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), inviteToken: null })
    }
    await db.doc(`users/${OWNER}/eventDrafts/${P}-ev`).set({ eventDetails: { info: { name: 'Dawn 10K' } } })
    await db.doc(`users/${OTHER}/eventDrafts/${P}-oev`).set({ eventDetails: { info: { name: 'Not yours' } } })
    prevAdmins = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = [SA, SA2].join(',')
    for (const u of [OWNER, ADMINM, MANAGER, OTHER, SA, SA2, CLAIM]) tokens[u] = await idToken(u)
  }, T)

  beforeEach(() => { h.sent = []; h.fail = new Set() })

  afterAll(async () => {
    if (prevAdmins === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = prevAdmins
    const { deleteByPrefix } = await import('@/lib/firebase/storage/admin')
    for (const id of ticketIds) {
      await deleteByPrefix(`support-tickets/${id}/`).catch(() => null)
      await db.recursiveDelete(db.doc(`supportTickets/${id}`)).catch(() => null)
      await db.doc(`adminNotifications/support-ticket_${id}`).delete().catch(() => null)
      for (const o of await outboxFor(id)) await db.doc(`notificationOutbox/${o.id}`).delete().catch(() => null)
      for (const a of (await db.collection('adminAuditLogs').where('entityId', '==', id).get()).docs) await a.ref.delete()
    }
    for (const a of (await db.collection('adminNotifications').get()).docs.filter(x => x.id.startsWith('support-ticket_') && ticketIds.some(t => x.id.includes(t)))) await a.ref.delete()
    for (const uid of [OWNER, ADMINM, MANAGER, OTHER, SA, SA2, CLAIM]) {
      await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => null)
      await auth.deleteUser(uid).catch(() => null)
    }
    for (const r of ['admin', 'manager']) await db.doc(`teamMembers/${P}-${r}`).delete().catch(() => null)
    for (const q of (await db.collection('supportTicketQuota').get()).docs.filter(d => d.id.startsWith(P))) await q.ref.delete()
  }, T)

  it('opens a ticket: number, first message, history, and ONE Super Admin notice (feed + outbox)', async () => {
    const r = await open(OWNER, { eventId: `${P}-ev` })
    expect(r.status).toBe(201)
    expect(String(r.body.number)).toMatch(/^RD-\d{6}$/)
    const id = String(r.body.id)
    expect(await tdoc(id)).toMatchObject({ workspaceUid: OWNER, createdBy: OWNER, status: 'open', priority: 'high', eventName: 'Dawn 10K', assigneeUid: null, messageCount: 1 })
    const out = await outboxFor(id)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ audience: { kind: 'super_admins' }, status: 'pending' })
    expect(String(out[0].subject)).toContain(String(r.body.number))
    expect(JSON.stringify(out[0])).not.toContain('Every QR code scans')                       // no body in the notice
    expect((await db.doc(`adminNotifications/support-ticket_${id}`).get()).data()).toMatchObject({ kind: 'support_ticket' })

    const list = await call(H.orgList(req('/api/organizer/support/tickets', OWNER)))
    expect((list.body.tickets as Json[]).map(t => t.id)).toContain(id)
    const one = await call(H.orgGet(req(`/api/organizer/support/tickets/${id}`, OWNER), ctx({ id })))
    expect(one.status).toBe(200)
    const t = one.body.ticket as Json
    expect((t.messages as Json[])[0]).toMatchObject({ from: 'organizer', body: ticket().description })
    expect(t).not.toHaveProperty('assigneeUid')
  }, T)

  it('validates on the server: missing fields, a foreign event, a card number, and a non-image screenshot are refused', async () => {
    expect((await open(OWNER, { subject: '', category: 'nope' })).status).toBe(400)
    expect((await open(OWNER, { eventId: `${P}-oev` })).body).toMatchObject({ code: 'EVENT_NOT_FOUND' })
    expect((await open(OWNER, { description: 'I was charged twice on 4111 1111 1111 1111 yesterday evening' })).body).toMatchObject({ code: 'INVALID', fields: { description: expect.stringContaining('card number') } })
    const svg = await call(H.orgCreate(req('/api/organizer/support/tickets', OWNER, 'POST',
      form(ticket(), [{ bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), name: 'x.png', type: 'image/png' }]))))
    expect(svg.status).toBe(400)
  }, T)

  it('ownership: other workspaces and non-admin members who did not open it get 404 — ticket, reply and screenshot', async () => {
    const r = await call(H.orgCreate(req('/api/organizer/support/tickets', OWNER, 'POST', form(ticket(), [{ bytes: PNG, name: 'gate.png', type: 'image/png' }]))))
    expect(r.status).toBe(201)
    const id = String(r.body.id); ticketIds.push(id)
    const t = (await call(H.orgGet(req(`/api/organizer/support/tickets/${id}`, OWNER), ctx({ id })))).body.ticket as Json
    const att = ((t.messages as Json[])[0].attachments as Json[])[0]
    expect(att).toMatchObject({ name: 'gate.png', contentType: 'image/png', size: PNG.byteLength })
    const aid = String(att.id)
    const fileUrl = `/api/organizer/support/tickets/${id}/attachments/${aid}`

    // the owner and a workspace admin may read it
    for (const who of [OWNER, ADMINM]) {
      const f = await call(H.orgFile(req(fileUrl, who), ctx({ id, attachmentId: aid })))
      expect(f.status, who).toBe(200)
      expect(f.headers.get('cache-control')).toBe('private, no-store')
      expect(f.headers.get('x-content-type-options')).toBe('nosniff')
    }
    // another workspace, and a manager who did not open the ticket: indistinguishable from missing
    for (const who of [OTHER, MANAGER]) {
      expect((await call(H.orgGet(req(`/api/organizer/support/tickets/${id}`, who), ctx({ id })))).status, who).toBe(404)
      expect((await orgReply(id, who, { body: 'me too' })).status, who).toBe(404)
      expect((await call(H.orgFile(req(fileUrl, who), ctx({ id, attachmentId: aid })))).status, who).toBe(404)
      expect(((await call(H.orgList(req('/api/organizer/support/tickets', who)))).body.tickets as Json[]).map(x => x.id)).not.toContain(id)
    }
    // an attachment id from a different ticket is not reachable through this one
    const other = String((await open(OWNER)).body.id)
    expect((await call(H.orgFile(req(`/api/organizer/support/tickets/${other}/attachments/${aid}`, OWNER), ctx({ id: other, attachmentId: aid })))).status).toBe(404)
    // no token: 401
    expect((await call(H.orgFile(req(fileUrl, null), ctx({ id, attachmentId: aid })))).status).toBe(401)

    // the manager sees their OWN ticket; the owner sees it too
    const mine = await open(MANAGER)
    expect(mine.status).toBe(201)
    expect(((await call(H.orgList(req('/api/organizer/support/tickets', MANAGER)))).body.tickets as Json[]).map(x => x.id)).toEqual([mine.body.id])
    expect(((await call(H.orgList(req('/api/organizer/support/tickets', OWNER)))).body.tickets as Json[]).map(x => x.id)).toContain(mine.body.id)

    // Super Admin reads the screenshot through the admin route; nobody else can use that route
    expect((await call(H.admFile(req(`/api/admin/support/tickets/${id}/attachments/${aid}`, SA), ctx({ id, attachmentId: aid })))).status).toBe(200)
    for (const who of [OWNER, CLAIM]) expect((await call(H.admFile(req(`/api/admin/support/tickets/${id}/attachments/${aid}`, who), ctx({ id, attachmentId: aid })))).status).toBe(403)

    // stored privately: no download token, so no capability URL exists
    const { getStorage } = await import('firebase-admin/storage')
    const { adminApp } = await import('@/lib/firebase/admin')
    const [files] = await getStorage(adminApp).bucket(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET).getFiles({ prefix: `support-tickets/${id}/` })
    expect(files).toHaveLength(1)
    const [meta] = await files[0].getMetadata()
    expect(meta.contentType).toBe('image/png')
    expect(JSON.stringify(meta.metadata ?? {})).not.toContain('firebaseStorageDownloadTokens')
  }, T)

  it('every admin endpoint refuses organizers and claim-only admins', async () => {
    const id = String((await open()).body.id)
    for (const who of [OWNER, CLAIM]) {
      expect((await call(H.admList(req('/api/admin/support/tickets', who)))).status, who).toBe(403)
      expect((await call(H.admGet(req(`/api/admin/support/tickets/${id}`, who), ctx({ id })))).status, who).toBe(403)
      expect((await admPatch(id, { status: 'resolved' }, who)).status, who).toBe(403)
      expect((await admReply(id, { body: 'hi' }, who)).status, who).toBe(403)
      expect((await call(H.admNote(req(`/api/admin/support/tickets/${id}/notes`, who, 'POST', { text: 'x x' }), ctx({ id })))).status, who).toBe(403)
    }
    expect((await tdoc(id)).status).toBe('open')
  }, T)

  it('internal notes never reach the organizer — not the API, the inbox or any notification', async () => {
    const id = String((await open()).body.id)
    expect((await call(H.admNote(req(`/api/admin/support/tickets/${id}/notes`, SA, 'POST', { text: SECRET }), ctx({ id })))).status).toBe(201)
    await admReply(id, { body: 'Looking into it now.', status: 'in_progress' })
    const admin = await call(H.admGet(req(`/api/admin/support/tickets/${id}`, SA), ctx({ id })))
    expect(JSON.stringify(admin.body)).toContain(SECRET)                                       // the desk shows it
    const views = [
      (await call(H.orgGet(req(`/api/organizer/support/tickets/${id}`, OWNER), ctx({ id })))).text,
      (await call(H.orgList(req('/api/organizer/support/tickets', OWNER)))).text,
      JSON.stringify((await db.collection(`users/${OWNER}/notifications`).get()).docs.map(d => d.data())),
      JSON.stringify(await outboxFor(id)),
      JSON.stringify((await db.collection('adminAuditLogs').where('entityId', '==', id).get()).docs.map(d => d.data())),
    ]
    for (const v of views) expect(v).not.toContain('INTERNAL-ONLY')
  }, T)

  it('lifecycle: waiting → reply hands back; resolve → reopen; closed is final; the reopen window is enforced', async () => {
    const id = String((await open()).body.id)
    // support asks for details → one organizer notice
    expect((await admReply(id, { body: 'Which scanner app version?', status: 'waiting_for_organizer', expectedStatus: 'open' })).body).toMatchObject({ status: 'waiting_for_organizer' })
    const notices = (await outboxFor(id)).filter(o => (o.audience as Json).kind === 'organizer')
    expect(notices).toHaveLength(1)
    expect(String(notices[0].subject)).toContain('New reply')
    expect(JSON.stringify(notices[0])).not.toContain('Which scanner app version')               // body stays in the app
    const inbox = (await db.doc(`users/${OWNER}/notifications/${notices[0].id}`).get()).data() as Json
    expect(inbox).toMatchObject({ type: 'support_ticket_reply', actionRequired: true, link: `/dashboard/support?id=${id}` })

    // the organizer answers → back to support (unassigned → open), Super Admins alerted
    expect((await orgReply(id, OWNER, { body: 'Version 4.2 on Android.' })).body).toMatchObject({ status: 'open' })
    expect((await outboxFor(id)).filter(o => (o.audience as Json).kind === 'super_admins')).toHaveLength(2)

    // assigned → an answer goes to in progress
    await admPatch(id, { assigneeUid: SA2 })
    await admReply(id, { body: 'Try again please.', status: 'waiting_for_organizer' })
    expect((await orgReply(id, OWNER, { body: 'Still failing.' })).body).toMatchObject({ status: 'in_progress' })

    // resolved: replies refused, reopen allowed (needs a message), back to support
    await admPatch(id, { status: 'resolved' })
    expect((await orgReply(id, OWNER, { body: 'thanks' })).body).toMatchObject({ code: 'RESOLVED' })
    expect((await orgReply(id, OWNER, { body: '', reopen: true })).status).toBe(400)
    expect((await orgReply(id, OWNER, { body: 'It broke again at gate 2.', reopen: true })).body).toMatchObject({ status: 'in_progress' })
    const hist = (await db.collection(`supportTickets/${id}/history`).get()).docs.map(d => d.data())
    expect(hist.some(x => x.type === 'reopened' && x.from === 'resolved' && x.actorRole === 'organizer')).toBe(true)

    // the window: a ticket resolved 31 days ago cannot be reopened
    await admPatch(id, { status: 'resolved' })
    await db.doc(`supportTickets/${id}`).update({ resolvedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) })
    expect((await orgReply(id, OWNER, { body: 'Again?', reopen: true })).body).toMatchObject({ code: 'REOPEN_EXPIRED' })

    // closed: final for the organizer; history kept
    await admPatch(id, { status: 'closed' })
    expect((await orgReply(id, OWNER, { body: 'hello?' })).body).toMatchObject({ code: 'CLOSED' })
    expect((await orgReply(id, OWNER, { body: 'hello?', reopen: true })).body).toMatchObject({ code: 'CLOSED' })
    const closed = (await call(H.orgGet(req(`/api/organizer/support/tickets/${id}`, OWNER), ctx({ id })))).body.ticket as Json
    expect(closed).toMatchObject({ status: 'closed', canReply: false, canReopen: false })
    expect((closed.messages as Json[]).length).toBe(6)
    // a Super Admin reply to a closed ticket must reopen it
    expect((await admReply(id, { body: 'Reopening for you.' })).body).toMatchObject({ code: 'CLOSED' })
    expect((await admReply(id, { body: 'Reopening for you.', status: 'open' })).body).toMatchObject({ status: 'open' })
  }, T)

  it('triage: priority and assignee are recorded and audited, not notified; only Super Admins can be assigned; stale saves refused', async () => {
    const id = String((await open()).body.id)
    const before = (await outboxFor(id)).length
    expect((await admPatch(id, { priority: 'critical', assigneeUid: SA })).status).toBe(200)
    expect((await outboxFor(id)).length).toBe(before)
    expect(await tdoc(id)).toMatchObject({ priority: 'critical', assigneeUid: SA })
    const hist = (await db.collection(`supportTickets/${id}/history`).get()).docs.map(d => d.data())
    expect(hist.filter(x => x.type === 'priority' || x.type === 'assignee').map(x => [x.type, x.to, x.actorUid]).sort())
      .toEqual([['assignee', SA, SA], ['priority', 'critical', SA]])
    const audit = (await db.collection('adminAuditLogs').where('entityId', '==', id).get()).docs.map(d => d.data())
    expect(audit.some(a => a.action === 'support_ticket.updated')).toBe(true)

    expect((await admPatch(id, { assigneeUid: OWNER })).body).toMatchObject({ code: 'BAD_ASSIGNEE' })
    expect((await admPatch(id, { assigneeUid: CLAIM })).body).toMatchObject({ code: 'BAD_ASSIGNEE' })
    expect((await admPatch(id, { priority: 'critical' })).body).toMatchObject({ code: 'NO_CHANGE' })
    expect((await admPatch(id, { status: 'resolved', expectedStatus: 'waiting_for_organizer' })).body).toMatchObject({ code: 'STALE' })
    // unassigning works and the queue filters by assignee
    expect((await admPatch(id, { assigneeUid: null })).status).toBe(200)
    const list = await call(H.admList(req('/api/admin/support/tickets?assignee=unassigned&priority=critical', SA)))
    expect((list.body.rows as Json[]).map(r => r.id)).toContain(id)
    expect((list.body.admins as Json[]).map(a => a.uid).sort()).toEqual([SA, SA2].sort())
  }, T)

  it('delivery: a provider failure is retried for the organizer notice, then sent once — queued is not "sent"', async () => {
    const id = String((await open()).body.id)
    await admReply(id, { body: 'Fixed on our side.', status: 'resolved' })
    const [n] = (await outboxFor(id)).filter(o => (o.audience as Json).kind === 'organizer')
    expect(n.status).toBe('pending')                                                           // queued, not delivered
    h.fail.add(`${OWNER}@rd.test`)
    const t0 = Date.now()
    expect(await ob.deliverOutboxMessage(n.id, t0)).toBe('retry')
    expect((await db.doc(`notificationOutbox/${n.id}`).get()).data()).toMatchObject({ status: 'pending', attempts: 1 })
    h.fail.clear()
    expect(await ob.deliverOutboxMessage(n.id, t0 + 61_000)).toBe('sent')
    expect(await ob.deliverOutboxMessage(n.id, t0 + 120_000)).toBe('done')
    expect(h.sent.map(s => s.to)).toEqual([`${OWNER}@rd.test`])
    expect(h.sent[0].subject).toContain('New reply from RegisterDesk Support')
    expect(h.sent[0].html).not.toContain('Fixed on our side')
  }, T)

  it('Confirm & Close: only a Resolved ticket; history records who, when, from → to and why; ONE Super Admin notice', async () => {
    const id = String((await open()).body.id)
    const close = (who: string, body: unknown = { expectedStatus: 'resolved' }) => call(H.orgClose(req(`/api/organizer/support/tickets/${id}/close`, who, 'POST', body), ctx({ id })))
    // not resolved yet → refused; the organizer view does not offer it
    expect((await close(OWNER, {})).body).toMatchObject({ code: 'NOT_RESOLVED' })
    expect(((await call(H.orgGet(req(`/api/organizer/support/tickets/${id}`, OWNER), ctx({ id })))).body.ticket as Json).canConfirmClose).toBe(false)

    await call(H.admNote(req(`/api/admin/support/tickets/${id}/notes`, SA, 'POST', { text: SECRET }), ctx({ id })))
    await admReply(id, { body: 'Fixed on our side — please confirm.', status: 'resolved' })
    const view = (await call(H.orgGet(req(`/api/organizer/support/tickets/${id}`, OWNER), ctx({ id })))).body.ticket as Json
    expect(view).toMatchObject({ status: 'resolved', canReply: false, canReopen: true, canConfirmClose: true })
    expect(((await call(H.orgList(req('/api/organizer/support/tickets', OWNER)))).body.tickets as Json[]).find(t => t.id === id)).toMatchObject({ status: 'resolved', canConfirmClose: true })

    // another workspace / a member who did not open it → 404, nothing changes
    for (const who of [OTHER, MANAGER]) expect((await close(who)).status, who).toBe(404)
    // a stale page (support reopened it meanwhile) is refused
    expect((await close(OWNER, { expectedStatus: 'waiting_for_organizer' })).body).toMatchObject({ code: 'STALE' })

    const adminNoticesBefore = (await outboxFor(id)).filter(o => (o.audience as Json).kind === 'super_admins').length
    expect((await close(OWNER)).body).toMatchObject({ status: 'closed' })
    const t = await tdoc(id)
    expect(t).toMatchObject({ status: 'closed', statusChangedBy: OWNER })
    expect(t.closedAt).toBeTruthy()
    const hist = (await db.collection(`supportTickets/${id}/history`).get()).docs.map(d => d.data())
    const closing = hist.filter(x => x.to === 'closed')
    expect(closing).toHaveLength(1)
    expect(closing[0]).toMatchObject({ type: 'status', from: 'resolved', to: 'closed', actorUid: OWNER, actorRole: 'organizer', reason: 'Organizer confirmed the issue is resolved' })
    expect(closing[0].at).toBeTruthy()
    const adminNotices = (await outboxFor(id)).filter(o => (o.audience as Json).kind === 'super_admins')
    expect(adminNotices.length).toBe(adminNoticesBefore + 1)                       // exactly one for this transition
    expect(String(adminNotices.find(o => String(o.subject).includes('Resolution confirmed'))?.subject)).toContain('Resolution confirmed')
    for (const o of await outboxFor(id)) expect(JSON.stringify(o)).not.toContain('INTERNAL-ONLY')

    // closed is final for the organizer: no second close, no reply, no reopen
    expect((await close(OWNER, {})).body).toMatchObject({ code: 'CLOSED' })
    expect((await orgReply(id, OWNER, { body: 'one more thing' })).body).toMatchObject({ code: 'CLOSED' })
    expect((await orgReply(id, OWNER, { body: 'It is back again.', reopen: true })).body).toMatchObject({ code: 'CLOSED' })
    expect(((await call(H.orgGet(req(`/api/organizer/support/tickets/${id}`, OWNER), ctx({ id })))).body.ticket as Json)).toMatchObject({ status: 'closed', canReply: false, canReopen: false, canConfirmClose: false })
    // the thread, notes and history are all still there
    expect((await db.collection(`supportTickets/${id}/messages`).get()).size).toBe(2)
    expect((await db.collection(`supportTickets/${id}/notes`).get()).size).toBe(1)
  }, T)

  it('an eligible Resolved ticket can still be reopened instead of closed', async () => {
    const id = String((await open()).body.id)
    await admReply(id, { body: 'Should be fixed now.', status: 'resolved' })
    expect((await orgReply(id, OWNER, { body: 'Still failing at gate 2.', reopen: true })).body).toMatchObject({ status: 'open' })
    expect(((await call(H.orgGet(req(`/api/organizer/support/tickets/${id}`, OWNER), ctx({ id })))).body.ticket as Json)).toMatchObject({ status: 'open', canReply: true, canConfirmClose: false })
  }, T)

  it('Super Admin: explicit Close notifies the organizer once; reopening a CLOSED ticket needs a reason, kept in history', async () => {
    const id = String((await open()).body.id)
    await admReply(id, { body: 'Done.', status: 'resolved' })
    const orgNotices = async () => (await outboxFor(id)).filter(o => (o.audience as Json).kind === 'organizer')
    const before = (await orgNotices()).length
    expect((await admPatch(id, { status: 'closed', expectedStatus: 'resolved' })).body).toMatchObject({ status: 'closed', notified: true })
    expect((await orgNotices()).length).toBe(before + 1)
    expect((await admPatch(id, { status: 'closed' })).body).toMatchObject({ code: 'NO_CHANGE' })   // a repeat is refused, no notice
    expect((await orgNotices()).length).toBe(before + 1)

    expect((await admPatch(id, { status: 'open' })).body).toMatchObject({ code: 'REASON_REQUIRED' })
    expect((await admPatch(id, { status: 'open', reason: 'no' })).body).toMatchObject({ code: 'INVALID' })
    expect((await tdoc(id)).status).toBe('closed')
    expect((await admPatch(id, { status: 'open', reason: 'Organizer phoned — the issue came back.' })).body).toMatchObject({ status: 'open', notified: true })
    const reopen = (await db.collection(`supportTickets/${id}/history`).get()).docs.map(d => d.data()).find(x => x.from === 'closed')
    expect(reopen).toMatchObject({ to: 'open', actorUid: SA, actorRole: 'super_admin', reason: 'Organizer phoned — the issue came back.' })
    // the admin view shows the reason; the organizer view never shows actors or reasons
    const admin = (await call(H.admGet(req(`/api/admin/support/tickets/${id}`, SA), ctx({ id })))).body.ticket as Json
    expect((admin.history as Json[]).some(x => x.reason === 'Organizer phoned — the issue came back.')).toBe(true)
    const org = (await call(H.orgGet(req(`/api/organizer/support/tickets/${id}`, OWNER), ctx({ id })))).body.ticket as Json
    expect(JSON.stringify(org.history)).not.toMatch(/phoned|actorUid|reason/)
  }, T)
})
