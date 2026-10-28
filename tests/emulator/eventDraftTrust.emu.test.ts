// RD-CE-FIX M2 / H6 / H5 — what may reach an event draft, who may write it, and what the Wallet trusts.
//
//   • M2 — drafts are written through /api/organizer/drafts with a wizard-field ALLOW-list
//     (lib/events/draftWrite.ts); firestore.rules carry the same allow-list for any direct client
//     write. Forged lifecycle / review / publish / closure stamps and unknown keys never land.
//   • H6 — the draft lives under the WORKSPACE: a team member with `events` creates and edits the
//     same document the owner, publish and licensing read; a gate-only member and another organizer
//     cannot.
//   • H5 — once a draft has produced its live event, its type / visibility / licence and public slug
//     are frozen on the draft too.
//   • M2 (Wallet) — refund eligibility and the 30-day window read lifecycle + closure from the
//     SERVER-written live event, so a forged draft can neither look closed nor reopen a window.
//
// Real Firestore + the real route handlers; only the token check is replaced (the caller uid). The
// rules cases use the real client SDK against the emulator's loaded firestore.rules.

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid

const OWNER = `dt-own-${P}`, OTHER = `dt-oth-${P}`, MGR = `dt-mgr-${P}`, GATE = `dt-gate-${P}`

const h = vi.hoisted(() => ({ caller: '' }))
// Publish settles any pending activation checkout first (RD-CE-FIX H4) — Razorpay is never reached here.
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_dt', RAZORPAY_KEY_SECRET: 'dt',
  razorpay: {
    orders:   { create: async () => { throw new Error('no orders') }, fetchPayments: async () => ({ items: [] }) },
    payments: { fetch: async () => { throw new Error('no payment') }, refund: async () => { throw new Error('no refunds') } },
  },
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.caller ? { uid: h.caller, email: `${h.caller}@rd.test` } : null),
}))
const as = (uid: string) => { h.caller = uid }
const req = (method: string, body?: unknown) => new NextRequest('http://x/api/organizer/drafts', {
  method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const ctx = (draftId: string) => ({ params: Promise.resolve({ draftId }) })

describeEmu('RD-CE-FIX M2/H6/H5 · draft writes, ownership and Wallet trust', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let create: typeof import('@/app/api/organizer/drafts/route').POST
  let draftRoute: typeof import('@/app/api/organizer/drafts/[draftId]/route')

  beforeAll(async () => {
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ POST: create } = await import('@/app/api/organizer/drafts/route'))
    draftRoute = await import('@/app/api/organizer/drafts/[draftId]/route')
    const profile = (uid: string, owner: boolean) => db.doc(`users/${uid}`).set({ uid, role: 'organizer', accountStatus: 'active', email: `${uid}@rd.test`, workspaceOwner: owner })
    await Promise.all([profile(OWNER, true), profile(OTHER, true), profile(MGR, false), profile(GATE, false)])
    await db.collection('teamMembers').add({ memberUid: MGR, organizerUid: OWNER, role: 'manager', status: 'active', email: `${MGR}@rd.test`, eventIds: [] })
    await db.collection('teamMembers').add({ memberUid: GATE, organizerUid: OWNER, role: 'checkin_staff', status: 'active', email: `${GATE}@rd.test`, eventIds: [] })
  }, T)

  it('create: protected stamps and unknown keys in the seed never land; the draft starts as a draft', async () => {
    as(OWNER)
    const r = await create(req('POST', { seed: {
      eventType: 'custom', visibility: 'public',   // an available type (RD-EVENT-TYPES-01)
      status: 'published', lifecycleStatus: 'completed', completedAt: 1, reviewStatus: 'approved',
      publishedAt: 1, restoredAt: 1, zzInjected: { x: 1 },
    } }))
    expect(r.status).toBe(201)
    const { id, dropped } = await r.json() as { id: string; dropped: string[] }
    expect(dropped.sort()).toEqual(['completedAt', 'lifecycleStatus', 'publishedAt', 'restoredAt', 'reviewStatus', 'status', 'zzInjected'].sort())
    const d = (await db.doc(`users/${OWNER}/eventDrafts/${id}`).get()).data()!
    expect(d.status).toBe('draft')
    expect(d.publishedAt).toBeNull()
    for (const k of ['lifecycleStatus', 'completedAt', 'reviewStatus', 'restoredAt', 'zzInjected']) expect(d[k], k).toBeUndefined()
    expect(d.eventType).toBe('custom')
    expect(d.createdBy).toBe(OWNER)
  }, T)

  it('patch: a legitimate wizard update applies; forged fields are dropped; a bad shape is refused whole', async () => {
    as(OWNER)
    const { id } = await (await create(req('POST', { seed: {} }))).json() as { id: string }
    const ok = await draftRoute.PATCH(req('PATCH', {
      currentStep: 3, eventDetails: { info: { name: 'Legit' } },
      lifecycleStatus: 'completed', completedAt: 5, restoredAt: 5, reviewStatus: 'approved', publishedAt: 5, status: 'published', mystery: true,
    }), ctx(id))
    expect(ok.status).toBe(200)
    const d = (await db.doc(`users/${OWNER}/eventDrafts/${id}`).get()).data()!
    expect(d.currentStep).toBe(3)
    expect((d.eventDetails as { info: { name: string } }).info.name).toBe('Legit')
    expect(d.status).toBe('draft')
    for (const k of ['lifecycleStatus', 'completedAt', 'restoredAt', 'reviewStatus', 'mystery']) expect(d[k], k).toBeUndefined()
    expect(d.publishedAt).toBeNull()
    const bad = await draftRoute.PATCH(req('PATCH', { currentStep: 'three', eventDetails: { info: { name: 'Nope' } } }), ctx(id))
    expect(bad.status).toBe(400)
    expect(((await db.doc(`users/${OWNER}/eventDrafts/${id}`).get()).get('eventDetails.info.name'))).toBe('Legit')
  }, T)

  it('H5: after publish, type / visibility / licence and the public slug cannot be rewritten through the draft', async () => {
    const id = `dt-pub-${P}`
    await db.doc(`users/${OWNER}/eventDrafts/${id}`).set({
      status: 'published', lifecycleStatus: 'published', publishedAt: FS.Timestamp.now(),
      eventType: 'sports', eventSubtype: 'running', visibility: 'public', licenseTier: 'starter',
      eventDetails: { info: { name: 'Live Run' }, seo: { urlSlug: `dt-live-${P}` } },
    })
    as(OWNER)
    const r = await draftRoute.PATCH(req('PATCH', {
      eventType: 'conference', eventSubtype: 'tech', visibility: 'private', licenseTier: 'pro',
      eventDetails: { info: { name: 'Renamed Run' }, seo: { urlSlug: 'someone-elses-event' } },
    }), ctx(id))
    expect(r.status).toBe(200)
    const { refused } = await r.json() as { refused: string[] }
    expect(refused.sort()).toEqual(['eventDetails.seo.urlSlug', 'eventSubtype', 'eventType', 'licenseTier', 'visibility'].sort())
    const d = (await db.doc(`users/${OWNER}/eventDrafts/${id}`).get()).data()!
    expect([d.eventType, d.eventSubtype, d.visibility, d.licenseTier]).toEqual(['sports', 'running', 'public', 'starter'])
    expect((d.eventDetails as { seo: { urlSlug: string } }).seo.urlSlug).toBe(`dt-live-${P}`)
    expect((d.eventDetails as { info: { name: string } }).info.name).toBe('Renamed Run')   // content stays editable
  }, T)

  it('H6: a manager creates the WORKSPACE draft; the owner resumes it; another organizer and a gate-only member cannot', async () => {
    as(MGR)
    const r = await create(req('POST', { seed: { eventType: 'fundraising' } }))
    expect(r.status).toBe(201)
    const { id } = await r.json() as { id: string }
    expect((await db.doc(`users/${OWNER}/eventDrafts/${id}`).get()).exists).toBe(true)
    expect((await db.doc(`users/${MGR}/eventDrafts/${id}`).get()).exists).toBe(false)
    expect((await draftRoute.PATCH(req('PATCH', { currentStep: 2 }), ctx(id))).status).toBe(200)

    as(OWNER)
    const own = await draftRoute.GET(req('GET'), ctx(id))
    expect(own.status).toBe(200)
    expect(((await own.json()) as { draft: { eventType: string; currentStep: number } }).draft).toMatchObject({ eventType: 'fundraising', currentStep: 2 })

    as(OTHER)
    expect((await draftRoute.GET(req('GET'), ctx(id))).status).toBe(404)
    expect((await draftRoute.PATCH(req('PATCH', { currentStep: 5 }), ctx(id))).status).toBe(404)
    as(GATE)
    expect((await draftRoute.GET(req('GET'), ctx(id))).status).toBe(403)
    expect((await create(req('POST', { seed: {} }))).status).toBe(403)
    as('')
    expect((await draftRoute.GET(req('GET'), ctx(id))).status).toBe(401)
    expect(((await db.doc(`users/${OWNER}/eventDrafts/${id}`).get()).get('currentStep'))).toBe(2)
  }, T)

  it('H6: publish finds a team member’s draft (it lives in the workspace, not under the member)', async () => {
    as(MGR)
    const { id } = await (await create(req('POST', { seed: { eventType: 'meetup' } }))).json() as { id: string }
    const { POST: publish } = await import('@/app/api/events/publish/route')
    const r = await publish(new NextRequest('http://x/api/events/publish', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ draftId: id, agreement: { accurateInformation: true, settlementFeePolicy: true, termsOfService: true, privacyPolicy: true } }),
    }))
    const body = await r.json() as { reason?: string; error?: string }
    // An empty draft cannot publish — but it is FOUND (validation fails), never "Draft not found".
    expect(r.status).not.toBe(404)
    expect(JSON.stringify(body)).not.toMatch(/DRAFT_NOT_FOUND|Draft not found/i)
  }, T)

  it('M2 (Wallet): a draft that merely CLAIMS to be completed is not closed, and a forged restoredAt cannot reopen a window', async () => {
    const { getEventRequests } = await import('@/lib/wallet/serviceRequests')
    const ago = (d: number) => FS.Timestamp.fromMillis(Date.now() - d * 86_400_000)
    // (a) forged: lifecycle + closure on the draft only, no live event of its own.
    const forged = `dt-forged-${P}`
    await db.doc(`users/${OWNER}/eventDrafts/${forged}`).set({ status: 'draft', lifecycleStatus: 'completed', completedAt: ago(2), eventDetails: { info: { name: 'Forged' } } })
    const f = await getEventRequests(OWNER, forged)
    expect(f?.closed).toBe(false)
    expect(f?.services.every(s => !s.refund.eligible)).toBe(true)
    // (b) genuinely closed 40 days ago on the LIVE doc; the draft forges a later restoredAt.
    const real = `dt-real-${P}`, slug = `dt-real-live-${P}`
    await db.doc(`users/${OWNER}/eventDrafts/${real}`).set({ status: 'published', lifecycleStatus: 'completed', completedAt: ago(40), restoredAt: ago(1), eventDetails: { info: { name: 'Real' }, seo: { urlSlug: slug } } })
    await db.doc(`events/${slug}`).set({ uid: OWNER, draftId: real, lifecycleStatus: 'completed', completedAt: ago(40) })
    const r = await getEventRequests(OWNER, real)
    expect(r?.closed).toBe(true)
    expect(r?.refundDeadline && Date.parse(r.refundDeadline)).toBeLessThan(Date.now())   // window from the LIVE closure: expired
  }, T)

  it('rules: a direct client write cannot seed or set protected fields; a wizard update still can', async () => {
    const { initializeApp, deleteApp } = await import('firebase/app')
    const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = await import('firebase/auth')
    const { getFirestore, connectFirestoreEmulator, doc, setDoc, updateDoc, Timestamp } = await import('firebase/firestore')
    const { adminAuth } = await import('@/lib/firebase/admin')
    const email = `dt-rules-${P}@rd.test`
    const user = await adminAuth.createUser({ email, password: 'RulesPassw0rd!' })
    const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-registerdesk', apiKey: 'fake' }, `dt-${P}`)
    const auth = getAuth(app); connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
    const cdb = getFirestore(app); const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST as string).split(':'); connectFirestoreEmulator(cdb, host, Number(port))
    await signInWithEmailAndPassword(auth, email, 'RulesPassw0rd!')
    const U = user.uid, now = Timestamp.now()
    const outcome = async (fn: () => Promise<unknown>) => { try { await fn(); return 'allowed' } catch (e) { return (e as { code?: string }).code === 'permission-denied' ? 'denied' : String(e) } }
    const base = { status: 'draft', communicationBilling: null, publishedAt: null, eventType: 'sports' }
    try {
      expect(await outcome(() => setDoc(doc(cdb, `users/${U}/eventDrafts/ok-${P}`), base))).toBe('allowed')
      for (const [k, v] of [['lifecycleStatus', 'completed'], ['completedAt', now], ['reviewStatus', 'approved'], ['restoredAt', now], ['zzInjected', 1]] as const) {
        expect(await outcome(() => setDoc(doc(cdb, `users/${U}/eventDrafts/c-${k}-${P}`), { ...base, [k]: v })), `create ${k}`).toBe('denied')
        expect(await outcome(() => updateDoc(doc(cdb, `users/${U}/eventDrafts/ok-${P}`), { [k]: v })), `update ${k}`).toBe('denied')
      }
      expect(await outcome(() => setDoc(doc(cdb, `users/${U}/eventDrafts/pa-${P}`), { ...base, publishedAt: now }))).toBe('denied')
      expect(await outcome(() => updateDoc(doc(cdb, `users/${U}/eventDrafts/ok-${P}`), { currentStep: 2, eventDetails: { info: { name: 'Wizard edit' } } }))).toBe('allowed')
      // After publish (server-set), the public slug and the type are frozen for direct writes too.
      await db.doc(`users/${U}/eventDrafts/pub-${P}`).set({ ...base, status: 'published', publishedAt: FS.Timestamp.now(), eventDetails: { seo: { urlSlug: `mine-${P}` } } })
      expect(await outcome(() => updateDoc(doc(cdb, `users/${U}/eventDrafts/pub-${P}`), { 'eventDetails.seo.urlSlug': 'victim-slug' }))).toBe('denied')
      expect(await outcome(() => updateDoc(doc(cdb, `users/${U}/eventDrafts/pub-${P}`), { eventType: 'conference' }))).toBe('denied')
      expect(await outcome(() => updateDoc(doc(cdb, `users/${U}/eventDrafts/pub-${P}`), { 'eventDetails.info.name': 'Content edit' }))).toBe('allowed')
    } finally {
      await deleteApp(app)
      await adminAuth.deleteUser(U).catch(() => undefined)
    }
  }, T)
})
