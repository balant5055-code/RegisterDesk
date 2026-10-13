// RD-PRINT-P0 — Print & Assets security + no stored output, on REAL Firestore, the REAL
// Storage emulator and REAL Auth-emulator ID tokens, through the real route handlers.
// No identity mocks. Only Next's `after()` is captured (it needs a request scope) so the
// test drives the job chunks itself.
//
//   • generation and packaging write NO object to Storage, NO URL/path, and NO attendee
//     copy to Firestore — history is metadata only;
//   • cards and ZIPs are rendered ON DEMAND into the response;
//   • every job/package route requires `certificates`: manager, finance and gate staff
//     are refused (403) and nothing changes; another workspace gets 404 (IDOR);
//   • a login token in the query string is NOT accepted;
//   • a registration refunded after generation can no longer get a card;
//   • LEGACY records (stored output + token URL + attendee copy) are served without ever
//     returning or following the stored URL, and are left untouched;
//   • the read-only inventory counts legacy objects/records without exposing paths,
//     URLs, tokens or attendee data.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `prp0-${process.pid}`
const OWNER = `${P}-owner`, OTHER = `${P}-other`
const ADMIN = `${P}-admin`, MANAGER = `${P}-manager`, FINANCE = `${P}-finance`, GATE = `${P}-gate`
const EV = `${P}-ev`
const PW = 'PrintP0Passw0rd!'
const email = (uid: string) => `${uid}@registerdesk.test`
const LEGACY_JOB = `pgen_${P}-legacy`, LEGACY_PKG = `pkg_${P}-legacy`

const deferred = vi.hoisted(() => ({ fns: [] as Array<() => unknown> }))
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => unknown) => { deferred.fns.push(fn) } }))
vi.mock('@/lib/notifications/inbox/notify', async (orig) => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifyPrintJobComplete: async () => {} }))

async function signIn(e: string): Promise<string> {
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: PW, returnSecureToken: true }),
  })
  const b = await r.json() as { idToken?: string; error?: { message?: string } }
  if (!b.idToken) throw new Error(`sign-in failed: ${b.error?.message}`)
  return b.idToken
}
const req = (url: string, token: string | null, method = 'GET', body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })
type Rec = Record<string, unknown>

describeEmu('RD-PRINT-P0 · print security + no stored output (real Auth, Firestore, Storage)', () => {
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let bucket: ReturnType<ReturnType<typeof import('firebase-admin/storage').getStorage>['bucket']>
  let gen: typeof import('@/lib/printAssets/generationJob')
  const tok: Record<string, string> = {}
  let templateId = '', jobId = '', pkgId = ''
  const routes = {} as Record<string, Rec>

  const objectsUnder = async (prefix: string) => (await bucket.getFiles({ prefix }))[0].map(f => f.name)

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const admin = await import('@/lib/firebase/admin')
    adminAuth = admin.adminAuth; adminDb = admin.adminDb
    const { getStorage } = await import('firebase-admin/storage')
    const { FIREBASE_STORAGE_BUCKET } = await import('@/lib/env')
    bucket = getStorage(admin.adminApp).bucket(FIREBASE_STORAGE_BUCKET)
    gen = await import('@/lib/printAssets/generationJob')
    const { permissionsForRole } = await import('@/lib/team/types')
    const { createPrintTemplate, savePrintDesign } = await import('@/lib/printAssets/firestore')
    const { PRINT_COLLECTIONS } = await import('@/lib/printAssets/collections')

    for (const uid of [OWNER, OTHER, ADMIN, MANAGER, FINANCE, GATE]) {
      await adminAuth.deleteUser(uid).catch(() => null)
      await adminAuth.createUser({ uid, email: email(uid), password: PW, emailVerified: true })
    }
    for (const uid of [OWNER, OTHER]) await adminDb.doc(`users/${uid}`).set({ uid, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    for (const [uid, role] of [[ADMIN, 'admin'], [MANAGER, 'manager'], [FINANCE, 'finance'], [GATE, 'checkin_staff']] as const) {
      await adminDb.doc(`teamMembers/${P}-m-${uid}`).set({
        organizerUid: OWNER, memberUid: uid, email: email(uid), role, permissions: permissionsForRole(role),
        eventIds: [], status: 'active', createdAt: new Date(), updatedAt: new Date(),
      })
    }
    const ev = { eventType: 'conference', eventDetails: { seo: { urlSlug: EV }, info: { name: 'Print P0 Event' } } }
    await adminDb.doc(`users/${OWNER}/eventDrafts/${EV}`).set({ status: 'published', ...ev })
    await adminDb.doc(`events/${EV}`).set({ uid: OWNER, draftId: EV, slug: EV, lifecycleStatus: 'published', ...ev })
    for (const n of [1, 2, 3]) {
      await adminDb.doc(`registrations/${P}-r${n}`).set({
        organizerUid: OWNER, eventSlug: EV, eventName: 'Print P0 Event', status: 'confirmed', paymentStatus: 'paid',
        passId: 'p1', passName: 'General', ticketCode: `RD-${P}-T${n}`, ticket: { qrValue: `RD:${EV}:${P}-r${n}:RD-${P}-T${n}` },
        attendee: { name: `Attendee ${n}`, email: `attendee${n}.${P}@example.test`, phone: `+9198765${String(10000 + n)}`, formResponses: { tshirt: 'M' } },
      })
    }
    const badge = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge')!
    const t = await createPrintTemplate(OWNER, OWNER, { eventId: EV, name: 'P0 Badge', assetType: 'BADGE', canvas: badge.canvas })
    await savePrintDesign(t.id, badge.design, { actorUid: OWNER })
    templateId = t.id
    for (const uid of [OWNER, OTHER, ADMIN, MANAGER, FINANCE, GATE]) tok[uid] = await signIn(email(uid))

    const base = '@/app/api/organizer'
    routes.create      = await import(`${base}/print-jobs/route`)
    routes.job         = await import(`${base}/print-jobs/[jobId]/route`)
    routes.items       = await import(`${base}/print-jobs/[jobId]/items/route`)
    routes.itemDl      = await import(`${base}/print-jobs/[jobId]/items/[registrationId]/download/route`)
    routes.process     = await import(`${base}/print-jobs/[jobId]/process/route`)
    routes.retry       = await import(`${base}/print-jobs/[jobId]/retry/route`)
    routes.cancel      = await import(`${base}/print-jobs/[jobId]/cancel/route`)
    routes.pkgCreate   = await import(`${base}/print-packages/route`)
    routes.pkg         = await import(`${base}/print-packages/[jobId]/route`)
    routes.pkgDl       = await import(`${base}/print-packages/[jobId]/download/route`)
    routes.pkgProcess  = await import(`${base}/print-packages/[jobId]/process/route`)
    routes.pkgCancel   = await import(`${base}/print-packages/[jobId]/cancel/route`)
  }, T)

  afterAll(async () => {
    for (const id of [jobId, LEGACY_JOB].filter(Boolean)) await adminDb.recursiveDelete(adminDb.doc(`printGenerationJobs/${id}`)).catch(() => null)
    for (const id of [pkgId, LEGACY_PKG].filter(Boolean)) await adminDb.doc(`printPackageJobs/${id}`).delete().catch(() => null)
    for (const n of [1, 2, 3]) await adminDb.doc(`registrations/${P}-r${n}`).delete().catch(() => null)
    if (templateId) await adminDb.doc(`printTemplates/${templateId}`).delete().catch(() => null)
    for (const uid of [ADMIN, MANAGER, FINANCE, GATE]) await adminDb.doc(`teamMembers/${P}-m-${uid}`).delete().catch(() => null)
    await adminDb.recursiveDelete(adminDb.doc(`users/${OWNER}`)).catch(() => null)
    await adminDb.doc(`users/${OTHER}`).delete().catch(() => null)
    await adminDb.doc(`events/${EV}`).delete().catch(() => null)
    for (const prefix of [`printAssets/${OWNER}/`, `printPackages/${OWNER}/`]) await bucket.deleteFiles({ prefix }).catch(() => null)
    for (const uid of [OWNER, OTHER, ADMIN, MANAGER, FINANCE, GATE]) await adminAuth.deleteUser(uid).catch(() => null)
  }, T)

  const call = (name: string, method: 'GET' | 'POST', r: NextRequest, p?: Record<string, string>) =>
    (routes[name] as Record<string, (r: NextRequest, c?: unknown) => Promise<Response>>)[method](r, p ? ctx(p) : undefined)

  it('generation stores METADATA ONLY: no Storage object, no URL/path, no attendee copy', async () => {
    const res = await call('create', 'POST', req('/api/organizer/print-jobs', tok[OWNER], 'POST', { templateId }))
    expect(res.status).toBe(201)
    jobId = ((await res.json()) as { jobId: string }).jobId
    for (let i = 0; i < 10; i++) {
      const r = await gen.processPrintGenerationChunk(jobId)
      if (r.status === 'completed') break
    }
    const job = (await adminDb.doc(`printGenerationJobs/${jobId}`).get()).data() as Rec
    expect(job.status).toBe('completed')
    expect(job.counts).toMatchObject({ total: 3, succeeded: 3, failed: 0 })
    const items = (await adminDb.collection(`printGenerationJobs/${jobId}/items`).get()).docs.map(d => d.data())
    expect(items).toHaveLength(3)
    for (const it of items) {
      expect(Object.keys(it).sort()).toEqual(['category', 'error', 'passId', 'passName', 'registrationId', 'rendered', 'renderedAt'])
      expect(it.rendered).toBe(true)
    }
    const stored = JSON.stringify({ job, items })
    for (const forbidden of ['firebasestorage', 'token=', 'printAssets/', '@example.test', '+919876', `RD-${P}-T`, 'Attendee ', 'tshirt']) {
      expect(stored, forbidden).not.toContain(forbidden)
    }
    expect(await objectsUnder(`printAssets/${OWNER}/`)).toEqual([])
  }, T)

  it('a card downloads ON DEMAND (PDF bytes in the response), and still nothing is stored', async () => {
    const res = await call('itemDl', 'GET', req('/x', tok[OWNER]), { jobId, registrationId: `${P}-r1` })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(res.headers.get('location')).toBeNull()
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
    // The items view reads names fresh from the registration; no URL anywhere.
    const view = await (await call('items', 'GET', req('/x', tok[OWNER]), { jobId })).json() as { items: Rec[] }
    expect(view.items.map(i => i.name).sort()).toEqual(['Attendee 1', 'Attendee 2', 'Attendee 3'])
    expect(JSON.stringify(view)).not.toMatch(/firebasestorage|token=|printAssets\//)
    expect(await objectsUnder(`printAssets/${OWNER}/`)).toEqual([])
  }, T)

  it('a package is metadata only; its ZIP is built on demand; nothing is stored', async () => {
    const res = await call('pkgCreate', 'POST', req('/api/organizer/print-packages', tok[OWNER], 'POST', { sourceJobId: jobId }))
    expect(res.status).toBe(201)
    const body = await res.json() as { jobId: string; job: Rec }
    pkgId = body.jobId
    expect(body.job).toMatchObject({ status: 'completed', ready: true, stats: { filesTotal: 3, packaged: 3, missing: 0 } })
    expect((body.job.output as Rec).expiresAt).toBeNull()
    const doc = (await adminDb.doc(`printPackageJobs/${pkgId}`).get()).data() as Rec
    expect(doc.output).toBeUndefined()
    expect(JSON.stringify(doc)).not.toMatch(/firebasestorage|token=|printPackages\//)
    const dl = await call('pkgDl', 'GET', req('/x', tok[OWNER]), { jobId: pkgId })
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-type')).toBe('application/zip')
    expect(dl.headers.get('x-print-card-count')).toBe('3')
    expect(Buffer.from(await dl.arrayBuffer()).subarray(0, 2).toString()).toBe('PK')
    expect(await objectsUnder(`printPackages/${OWNER}/`)).toEqual([])
    expect(await objectsUnder(`printAssets/${OWNER}/`)).toEqual([])
  }, T)

  it('a login token in the QUERY STRING is not accepted (both download routes)', async () => {
    const q = encodeURIComponent(tok[OWNER])
    expect((await call('itemDl', 'GET', req(`/x?token=${q}`, null), { jobId, registrationId: `${P}-r1` })).status).toBe(401)
    expect((await call('pkgDl', 'GET', req(`/x?token=${q}`, null), { jobId: pkgId })).status).toBe(401)
  }, T)

  it('manager, finance and gate staff are refused by EVERY print job/package route, and nothing changes', async () => {
    const before = JSON.stringify((await adminDb.doc(`printGenerationJobs/${jobId}`).get()).data())
    for (const uid of [MANAGER, FINANCE, GATE]) {
      const t = tok[uid]
      const calls: Array<[string, Promise<Response>]> = [
        ['create',     call('create', 'POST', req('/x', t, 'POST', { templateId }))],
        ['job',        call('job', 'GET', req('/x', t), { jobId })],
        ['items',      call('items', 'GET', req('/x', t), { jobId })],
        ['itemDl',     call('itemDl', 'GET', req('/x', t), { jobId, registrationId: `${P}-r1` })],
        ['process',    call('process', 'POST', req('/x', t, 'POST', {}), { jobId })],
        ['retry',      call('retry', 'POST', req('/x', t, 'POST', { mode: 'regenerate' }), { jobId })],
        ['cancel',     call('cancel', 'POST', req('/x', t, 'POST', {}), { jobId })],
        ['pkgCreate',  call('pkgCreate', 'POST', req('/x', t, 'POST', { sourceJobId: jobId }))],
        ['pkg',        call('pkg', 'GET', req('/x', t), { jobId: pkgId })],
        ['pkgDl',      call('pkgDl', 'GET', req('/x', t), { jobId: pkgId })],
        ['pkgProcess', call('pkgProcess', 'POST', req('/x', t, 'POST', {}), { jobId: pkgId })],
        ['pkgCancel',  call('pkgCancel', 'POST', req('/x', t, 'POST', {}), { jobId: pkgId })],
      ]
      for (const [name, p] of calls) expect((await p).status, `${uid} → ${name}`).toBe(403)
    }
    expect(JSON.stringify((await adminDb.doc(`printGenerationJobs/${jobId}`).get()).data())).toBe(before)
    expect(((await adminDb.doc(`printPackageJobs/${pkgId}`).get()).data() as Rec).status).toBe('completed')
  }, T)

  it('an admin (holds `certificates`) is allowed', async () => {
    expect((await call('job', 'GET', req('/x', tok[ADMIN]), { jobId })).status).toBe(200)
    expect((await call('itemDl', 'GET', req('/x', tok[ADMIN]), { jobId, registrationId: `${P}-r2` })).status).toBe(200)
  }, T)

  it('another workspace gets 404 on every job/package route (no IDOR), and nothing changes', async () => {
    const t = tok[OTHER]
    const before = JSON.stringify((await adminDb.doc(`printGenerationJobs/${jobId}`).get()).data())
    for (const [name, p] of [
      ['job',        call('job', 'GET', req('/x', t), { jobId })],
      ['items',      call('items', 'GET', req('/x', t), { jobId })],
      ['itemDl',     call('itemDl', 'GET', req('/x', t), { jobId, registrationId: `${P}-r1` })],
      ['process',    call('process', 'POST', req('/x', t, 'POST', {}), { jobId })],
      ['retry',      call('retry', 'POST', req('/x', t, 'POST', { mode: 'regenerate' }), { jobId })],
      ['cancel',     call('cancel', 'POST', req('/x', t, 'POST', {}), { jobId })],
      ['pkgCreate',  call('pkgCreate', 'POST', req('/x', t, 'POST', { sourceJobId: jobId }))],
      ['pkg',        call('pkg', 'GET', req('/x', t), { jobId: pkgId })],
      ['pkgDl',      call('pkgDl', 'GET', req('/x', t), { jobId: pkgId })],
      ['pkgProcess', call('pkgProcess', 'POST', req('/x', t, 'POST', {}), { jobId: pkgId })],
      ['pkgCancel',  call('pkgCancel', 'POST', req('/x', t, 'POST', {}), { jobId: pkgId })],
    ] as Array<[string, Promise<Response>]>) expect((await p).status, `other → ${name}`).toBe(404)
    expect((await call('create', 'POST', req('/x', t, 'POST', { templateId }))).status).toBe(404)
    expect(JSON.stringify((await adminDb.doc(`printGenerationJobs/${jobId}`).get()).data())).toBe(before)
  }, T)

  it('regenerate with an unknown id is ignored (no 500); a card for a REFUNDED registration is refused', async () => {
    const r = await call('retry', 'POST', req('/x', tok[OWNER], 'POST', { mode: 'regenerate', registrationIds: ['nope', `${P}-r2`] }), { jobId })
    expect(r.status).toBe(200)
    await adminDb.doc(`registrations/${P}-r3`).update({ paymentStatus: 'refunded' })
    const dl = await call('itemDl', 'GET', req('/x', tok[OWNER]), { jobId, registrationId: `${P}-r3` })
    expect(dl.status).toBe(410)
    expect(((await dl.json()) as { error: string }).error).toContain('no longer eligible')
    await adminDb.doc(`registrations/${P}-r3`).update({ paymentStatus: 'paid' })
  }, T)

  it('LEGACY records are served WITHOUT using or returning their stored token URL, and stay untouched', async () => {
    const { uploadServerFile } = await import('@/lib/firebase/storage/admin')
    const legacyPath = `printAssets/${OWNER}/${LEGACY_JOB}/${P}-r1.pdf`
    const { url } = await uploadServerFile(legacyPath, new TextEncoder().encode('%PDF-1.4 legacy'), 'application/pdf')
    const legacyItem = {
      registrationId: `${P}-r1`, name: 'Legacy Copy', email: `legacy.${P}@example.test`, phone: '+910000000000',
      ticketCode: 'LEGACY-T', qrValue: 'LEGACY-QR', company: '', designation: '', category: '', bibNumber: '',
      passId: 'p1', passName: 'General', formResponses: { tshirt: 'L' },
      output: { path: legacyPath, filename: 'badge-LEGACY-T.pdf', contentType: 'application/pdf', url, expiresAt: new Date(Date.now() - 86_400_000) },
    }
    await adminDb.doc(`printGenerationJobs/${LEGACY_JOB}`).set({
      jobId: LEGACY_JOB, status: 'completed', counts: { total: 1, processed: 1, succeeded: 1, failed: 0 },
      organizerUid: OWNER, createdBy: OWNER, templateId, eventId: EV, eventSlug: EV, eventName: 'Print P0 Event',
      assetType: 'BADGE', filters: {}, cursor: null, error: null, lockedUntil: null, createdAt: new Date(), updatedAt: new Date(),
    })
    await adminDb.doc(`printGenerationJobs/${LEGACY_JOB}/items/${P}-r1`).set(legacyItem)
    await adminDb.doc(`printPackageJobs/${LEGACY_PKG}`).set({
      jobId: LEGACY_PKG, status: 'completed', counts: { total: 1, processed: 1, succeeded: 1, failed: 0 },
      organizerUid: OWNER, createdBy: OWNER, sourceJobId: LEGACY_JOB, eventId: EV, eventSlug: EV, assetType: 'BADGE', filters: {},
      stats: { filesTotal: 1, packaged: 1, missing: 0, failed: 0 }, failures: [],
      output: { path: `printPackages/${OWNER}/${LEGACY_PKG}/x.zip`, filename: 'x.zip', contentType: 'application/zip', url: `${url}-zip`, fileCount: 1, expiresAt: new Date() },
      cursor: null, error: null, lockedUntil: null, createdAt: new Date(), updatedAt: new Date(),
    })

    const items = await (await call('items', 'GET', req('/x', tok[OWNER]), { jobId: LEGACY_JOB })).json() as { items: Rec[] }
    expect(items.items[0]).toMatchObject({ registrationId: `${P}-r1`, ready: true, name: 'Attendee 1', expiresAt: null })
    const pkgView = await (await call('pkg', 'GET', req('/x', tok[OWNER]), { jobId: LEGACY_PKG })).json() as { job: Rec }
    const exposed = JSON.stringify({ items, pkgView })
    for (const forbidden of ['firebasestorage', 'token=', 'printAssets/', 'printPackages/', 'Legacy Copy', `legacy.${P}@`, 'LEGACY-']) {
      expect(exposed, forbidden).not.toContain(forbidden)
    }
    // Downloads render on demand — no redirect to the stored URL, live data, real PDF.
    const dl = await call('itemDl', 'GET', req('/x', tok[OWNER]), { jobId: LEGACY_JOB, registrationId: `${P}-r1` })
    expect(dl.status).toBe(200)
    expect(dl.headers.get('location')).toBeNull()
    expect(Buffer.from(await dl.arrayBuffer()).toString('latin1')).not.toContain('legacy')
    const zip = await call('pkgDl', 'GET', req('/x', tok[OWNER]), { jobId: LEGACY_PKG })
    expect(zip.status).toBe(200)
    expect(zip.headers.get('location')).toBeNull()
    // Untouched: the legacy record and its stored object are exactly as they were.
    expect((await adminDb.doc(`printGenerationJobs/${LEGACY_JOB}/items/${P}-r1`).get()).data()).toMatchObject({ output: { url, path: legacyPath }, email: legacyItem.email })
    expect(await objectsUnder(`printAssets/${OWNER}/${LEGACY_JOB}/`)).toEqual([legacyPath])
  }, T)

  it('the READ-ONLY inventory counts legacy objects and records, exposing no path, URL, token or attendee data', async () => {
    const { inventoryLegacyPrintOutputs } = await import('@/lib/printAssets/legacyInventory')
    const before = JSON.stringify((await adminDb.doc(`printGenerationJobs/${LEGACY_JOB}/items/${P}-r1`).get()).data())
    const inv = await inventoryLegacyPrintOutputs()
    const assets = inv.storage.find(s => s.prefix === 'printAssets/')!
    expect(assets.objects).toBeGreaterThanOrEqual(1)
    expect(assets.withDownloadToken).toBeGreaterThanOrEqual(1)
    expect(assets.referencedByRecords).toBeGreaterThanOrEqual(1)
    expect(assets.totalBytes).toBeGreaterThan(0)
    expect(inv.generationJobs.items.withLegacyOutput).toBeGreaterThanOrEqual(1)
    expect(inv.generationJobs.items.legacyOutputExpired).toBeGreaterThanOrEqual(1)
    expect(inv.generationJobs.items.withLegacyAttendeeCopy).toBeGreaterThanOrEqual(1)
    expect(inv.packageJobs.withLegacyOutput).toBeGreaterThanOrEqual(1)
    expect(inv.safety).toMatchObject({ appReadsStoredObjects: false, appWritesStoredObjects: false })
    const out = JSON.stringify(inv)
    for (const forbidden of ['firebasestorage', 'token=', OWNER, P, '@example.test', 'Legacy Copy', 'LEGACY-']) {
      expect(out, forbidden).not.toContain(forbidden)
    }
    // Read-only: nothing it looked at changed, and the object is still there.
    expect(JSON.stringify((await adminDb.doc(`printGenerationJobs/${LEGACY_JOB}/items/${P}-r1`).get()).data())).toBe(before)
    expect((await objectsUnder(`printAssets/${OWNER}/${LEGACY_JOB}/`)).length).toBe(1)
  }, T)
})
