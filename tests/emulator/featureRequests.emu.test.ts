// RD-FEATURE-REQ-01 — Feature Requests end to end on the emulators: real route handlers, real
// Firebase Auth tokens, real transactions. Outbox DELIVERY is not run (after() is a no-op); what the
// tests assert is what the transaction STAGED — the outbox message, the in-app item and the audit row.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/rateLimit', async orig => ({ ...(await orig<typeof import('@/lib/rateLimit')>()), checkRateLimit: () => ({ limited: false, remaining: 99, resetAt: 0 }) }))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `frq${process.pid}`
type Json = Record<string, unknown>

describeEmu('feature requests — organizer ↔ Super Admin', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  type R = (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>
  let orgList: R, orgCreate: R, orgGet: R, admList: R, admGet: R, admPatch: R, admNote: R
  const ORG = `${P}-org`, OTHER = `${P}-other`, ADMIN = `${P}-admin`, CLAIM = `${P}-claim`
  const tokens: Record<string, string> = {}
  let prevAdminUids: string | undefined
  const ids: string[] = []

  async function idToken(uid: string) {
    const custom = await adminAuth.createCustomToken(uid)
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'fake'}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })
    return (await res.json() as { idToken: string }).idToken
  }
  const req = (url: string, who: string | null, method = 'GET', body?: unknown) => new NextRequest(new Request(`http://x${url}`, {
    method, headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
  const call = async (r: Promise<Response>) => { const res = await r; return { status: res.status, body: await res.json().catch(() => ({})) as Json } }
  const good = (extra: Json = {}) => ({
    title: 'Bulk-edit pass prices', problem: 'Changing many pass prices one by one takes far too long before launch.',
    proposal: 'Select several passes and set a new price once; saves an hour per event.', eventId: null, eventType: 'sports', organizerPriority: 'high', ...extra,
  })
  async function submit(who = ORG, extra: Json = {}) {
    const r = await call(orgCreate(req('/api/organizer/feature-requests', who, 'POST', good(extra))))
    if (r.status === 201) ids.push(String(r.body.id))
    return r
  }
  const doc = async (id: string) => (await adminDb.doc(`featureRequests/${id}`).get()).data() as Json
  const history = async (id: string) => (await adminDb.collection(`featureRequests/${id}/history`).orderBy('at', 'asc').get()).docs.map(d => d.data())

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    const o = await import('@/app/api/organizer/feature-requests/route') as never as { GET: R; POST: R }
    const od = await import('@/app/api/organizer/feature-requests/[id]/route') as never as { GET: R }
    const a = await import('@/app/api/admin/feature-requests/route') as never as { GET: R }
    const ad = await import('@/app/api/admin/feature-requests/[id]/route') as never as { GET: R; PATCH: R }
    const an = await import('@/app/api/admin/feature-requests/[id]/notes/route') as never as { POST: R }
    orgList = o.GET; orgCreate = o.POST; orgGet = od.GET; admList = a.GET; admGet = ad.GET; admPatch = ad.PATCH; admNote = an.POST
    for (const [uid, claims] of [[ORG, null], [OTHER, null], [ADMIN, null], [CLAIM, { admin: true, isAdmin: true, role: 'superadmin' }]] as const) {
      await adminAuth.createUser({ uid, email: `${uid}@rd.test`, emailVerified: true })
      if (claims) await adminAuth.setCustomUserClaims(uid, claims)
      await adminDb.doc(`users/${uid}`).set({ uid, email: `${uid}@rd.test`, name: uid, organizationName: `${uid} Events`, role: 'organizer', workspaceOwner: true, accountStatus: 'active', emailVerified: true, createdAt: new Date() })
    }
    await adminDb.doc(`users/${ORG}/eventDrafts/${P}-ev`).set({ eventDetails: { info: { name: 'Dawn 10K' } } })
    await adminDb.doc(`users/${OTHER}/eventDrafts/${P}-other-ev`).set({ eventDetails: { info: { name: 'Not yours' } } })
    prevAdminUids = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = [prevAdminUids, ADMIN].filter(Boolean).join(',')
    for (const u of [ORG, OTHER, ADMIN, CLAIM]) tokens[u] = await idToken(u)
  }, T)

  afterAll(async () => {
    if (prevAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = prevAdminUids
    for (const id of ids) {
      await adminDb.recursiveDelete(adminDb.doc(`featureRequests/${id}`)).catch(() => null)
      await adminDb.doc(`adminNotifications/feature-request_${id}`).delete().catch(() => null)
      await adminDb.doc(`notificationOutbox/feature-request_${id}`).delete().catch(() => null)
      for (const d of (await adminDb.collection('notificationOutbox').where('metadata.requestId', '==', id).get().catch(() => null))?.docs ?? []) await d.ref.delete()
      for (const d of (await adminDb.collection('adminAuditLogs').where('entityId', '==', id).get()).docs) await d.ref.delete()
    }
    for (const d of (await adminDb.collection('notificationOutbox').get()).docs) if (d.id.startsWith('feature-request_')) await d.ref.delete()
    for (const u of [ORG, OTHER, ADMIN, CLAIM]) {
      await adminDb.recursiveDelete(adminDb.doc(`users/${u}`)).catch(() => null)
      for (const q of (await adminDb.collection('featureRequestQuota').where('workspaceUid', '==', u).get()).docs) await q.ref.delete()
      await adminAuth.deleteUser(u).catch(() => null)
    }
  }, T)

  // ─── Organizer ───────────────────────────────────────────────────────────────

  it('S1 · submission stores only whitelisted fields, records history, and alerts Super Admins once', async () => {
    const r = await submit(ORG, { status: 'released', workspaceUid: OTHER, adminPriority: 'p0', organizerResponse: 'hijack', eventId: `${P}-ev` })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const id = String(r.body.id)
    expect(await doc(id)).toMatchObject({ workspaceUid: ORG, submittedBy: ORG, status: 'submitted', adminPriority: null, organizerResponse: null, eventId: `${P}-ev`, eventName: 'Dawn 10K', rollout: { scope: 'none', enforced: false } })
    expect(await history(id)).toMatchObject([{ from: null, to: 'submitted', actorUid: ORG, actorRole: 'organizer' }])
    const feed = await adminDb.doc(`adminNotifications/feature-request_${id}`).get()
    expect(feed.data()).toMatchObject({ kind: 'feature_request', metadata: { requestId: id, workspaceUid: ORG } })
    expect((await adminDb.doc(`notificationOutbox/feature-request_${id}`).get()).data()).toMatchObject({ audience: { kind: 'super_admins' }, status: 'pending' })
  }, T)

  it('S2 · invalid input, another workspace’s event and no credentials are refused with nothing written', async () => {
    const bad = await call(orgCreate(req('/api/organizer/feature-requests', ORG, 'POST', { title: 'x' })))
    expect(bad.status).toBe(400)
    expect(Object.keys(bad.body.fields as Json).sort()).toEqual(['eventType', 'organizerPriority', 'problem', 'proposal', 'title'])
    const foreign = await submit(ORG, { eventId: `${P}-other-ev` })
    expect(foreign.status).toBe(400)
    expect(foreign.body.code).toBe('EVENT_NOT_FOUND')
    expect((await call(orgCreate(req('/api/organizer/feature-requests', null, 'POST', good())))).status).toBe(401)
    expect((await call(orgList(req('/api/organizer/feature-requests', null)))).status).toBe(401)
  }, T)

  it('S3 · the durable daily quota is enforced in the transaction', async () => {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    await adminDb.doc(`featureRequestQuota/${OTHER}_${day}`).set({ workspaceUid: OTHER, count: 10 })
    const r = await submit(OTHER)
    expect(r.status).toBe(429)
    expect(r.body.code).toBe('DAILY_LIMIT')
  }, T)

  it('S4 · organizers see only their own requests, and never internal fields', async () => {
    const mine = String((await submit(ORG)).body.id)
    await adminDb.doc(`featureRequests/${mine}`).update({ adminPriority: 'p0', rollout: { scope: 'selected_organizers', organizerUids: ['secret-org'], eventSlugs: [], eventTypes: [], flagKey: null, enforced: false } })
    await adminDb.collection(`featureRequests/${mine}/notes`).add({ text: 'INTERNAL-NOTE', authorUid: ADMIN, at: new Date() })
    const list = await call(orgList(req('/api/organizer/feature-requests', ORG)))
    expect((list.body.requests as Json[]).every(r => ids.includes(String(r.id)))).toBe(true)
    const detail = await call(orgGet(req(`/api/organizer/feature-requests/${mine}`, ORG), ctx(mine)))
    expect(detail.status).toBe(200)
    const json = JSON.stringify(detail.body)
    for (const leak of ['INTERNAL-NOTE', 'secret-org', '"p0"', 'adminPriority', 'rollout', 'workspaceUid']) expect(json, leak).not.toContain(leak)
    expect((await call(orgGet(req(`/api/organizer/feature-requests/${mine}`, OTHER), ctx(mine)))).status).toBe(404)
    const others = await call(orgList(req('/api/organizer/feature-requests', OTHER)))
    expect((others.body.requests as Json[]).some(r => r.id === mine)).toBe(false)
  }, T)

  // ─── Super Admin ─────────────────────────────────────────────────────────────

  it('A1 · only a Super Admin reaches any admin endpoint', async () => {
    const id = ids[0]!
    for (const who of [ORG, CLAIM, null]) {
      expect((await call(admList(req('/api/admin/feature-requests', who)))).status, String(who)).toBe(403)
      expect((await call(admGet(req(`/api/admin/feature-requests/${id}`, who), ctx(id)))).status).toBe(403)
      expect((await call(admPatch(req(`/api/admin/feature-requests/${id}`, who, 'PATCH', { status: 'planned' }), ctx(id)))).status).toBe(403)
      expect((await call(admNote(req(`/api/admin/feature-requests/${id}/notes`, who, 'POST', { text: 'hi there' }), ctx(id)))).status).toBe(403)
    }
    expect((await doc(id)).status).toBe('submitted')
  }, T)

  it('A2 · a status change records who and when, audits, and notifies the organizer exactly once', async () => {
    const id = ids[0]!
    const r = await call(admPatch(req(`/api/admin/feature-requests/${id}`, ADMIN, 'PATCH', { status: 'under_review', expectedStatus: 'submitted', adminPriority: 'p1', organizerResponse: 'Looking into it.' }), ctx(id)))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ status: 'under_review', notified: true })
    const d = await doc(id)
    expect(d).toMatchObject({ status: 'under_review', adminPriority: 'p1', organizerResponse: 'Looking into it.', statusChangedBy: ADMIN })
    const h = await history(id)
    expect(h.at(-1)).toMatchObject({ from: 'submitted', to: 'under_review', actorUid: ADMIN, actorRole: 'super_admin' })
    const audit = (await adminDb.collection('adminAuditLogs').where('entityId', '==', id).get()).docs.map(x => x.data())
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'feature_request.updated', entityType: 'feature_request', adminUid: ADMIN })
    const inbox = (await adminDb.collection(`users/${ORG}/notifications`).get()).docs.filter(x => x.id.startsWith(`feature-request_${id}_`))
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.data()).toMatchObject({ category: 'system', type: 'feature_request_under_review', link: `/dashboard/feature-requests?id=${id}` })
    // The organizer now sees the new status + response, with history
    const view = await call(orgGet(req(`/api/organizer/feature-requests/${id}`, ORG), ctx(id)))
    expect(view.body.request).toMatchObject({ status: 'under_review', organizerResponse: 'Looking into it.' })
    expect(((view.body.request as Json).history as Json[]).map(x => x.to)).toEqual(['submitted', 'under_review'])
  }, T)

  it('A3 · no-ops, stale writes and unexplained declines are refused and notify nobody', async () => {
    const id = ids[0]!
    const before = (await adminDb.collection(`users/${ORG}/notifications`).get()).size
    expect((await call(admPatch(req(`/api/admin/feature-requests/${id}`, ADMIN, 'PATCH', { status: 'under_review' }), ctx(id)))).body.code).toBe('NO_CHANGE')
    expect((await call(admPatch(req(`/api/admin/feature-requests/${id}`, ADMIN, 'PATCH', { status: 'planned', expectedStatus: 'submitted' }), ctx(id)))).status).toBe(409)
    const decline = await call(admPatch(req(`/api/admin/feature-requests/${id}`, ADMIN, 'PATCH', { status: 'declined', organizerResponse: null }), ctx(id)))
    expect(decline.body.code).toBe('DECLINE_NEEDS_RESPONSE')
    expect((await call(admPatch(req(`/api/admin/feature-requests/${id}`, ADMIN, 'PATCH', { status: 'released', workspaceUid: OTHER, title: 'renamed' }), ctx(id)))).status).toBe(200)
    expect(await doc(id)).toMatchObject({ status: 'released', workspaceUid: ORG, title: 'Bulk-edit pass prices' })   // mass assignment ignored
    expect((await adminDb.collection(`users/${ORG}/notifications`).get()).size).toBe(before + 1)              // only the real change
  }, T)

  it('A4 · duplicates are linked, never merged or deleted — no self links, chains or orphaned children', async () => {
    const [a, b, c] = [ids[0]!, ids[1]!, String((await submit(ORG)).body.id)]
    const patch = (id: string, duplicateOf: string | null) => call(admPatch(req(`/api/admin/feature-requests/${id}`, ADMIN, 'PATCH', { duplicateOf }), ctx(id)))
    expect((await patch(a, a)).body.code).toBe('DUPLICATE_SELF')
    expect((await patch(b, a)).status).toBe(200)
    expect((await patch(c, b)).body.code).toBe('DUPLICATE_CHAIN')         // b is itself a duplicate
    expect((await patch(a, c)).body.code).toBe('DUPLICATE_HAS_CHILDREN')  // b points at a
    expect((await patch(c, 'missing-id')).body.code).toBe('DUPLICATE_NOT_FOUND')
    for (const id of [a, b, c]) expect((await adminDb.doc(`featureRequests/${id}`).get()).exists).toBe(true)
    const detail = await call(admGet(req(`/api/admin/feature-requests/${a}`, ADMIN), ctx(a)))
    expect(((detail.body.request as Json).duplicates as Json[]).map(x => x.id)).toEqual([b])
    expect((await call(orgGet(req(`/api/organizer/feature-requests/${b}`, ORG), ctx(b)))).body.request).toMatchObject({ linkedToExisting: true })
  }, T)

  it('A5 · internal notes are audited and never reach the organizer; a rollout plan stays a plan', async () => {
    const id = ids[1]!
    const n = await call(admNote(req(`/api/admin/feature-requests/${id}/notes`, ADMIN, 'POST', { text: 'Ask product about scope' }), ctx(id)))
    expect(n.status).toBe(201)
    expect((await adminDb.collection('adminAuditLogs').where('entityId', '==', id).where('action', '==', 'feature_request.note_added').get()).size).toBe(1)
    expect(JSON.stringify((await call(orgGet(req(`/api/organizer/feature-requests/${id}`, ORG), ctx(id)))).body)).not.toContain('Ask product')
    const plan = { scope: 'event_types', eventTypes: ['sports'], flagKey: 'betaFeatures', enforced: true }
    expect((await call(admPatch(req(`/api/admin/feature-requests/${id}`, ADMIN, 'PATCH', { rollout: plan }), ctx(id)))).status).toBe(200)
    expect((await doc(id)).rollout).toEqual({ scope: 'event_types', eventSlugs: [], organizerUids: [], eventTypes: ['sports'], flagKey: 'betaFeatures', enforced: false })
    expect((await call(admPatch(req(`/api/admin/feature-requests/${id}`, ADMIN, 'PATCH', { rollout: { scope: 'all_eligible', flagKey: 'nope' } }), ctx(id)))).status).toBe(400)
    // the admin queue lists it, filterable by status
    const list = await call(admList(req('/api/admin/feature-requests?status=submitted', ADMIN)))
    expect((list.body.rows as Json[]).some(r => r.id === id)).toBe(true)
  }, T)
})
