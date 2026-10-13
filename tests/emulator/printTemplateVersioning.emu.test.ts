// RD-PRINT-P1 — immutable template versions + template / print-ops / preview security, on
// REAL Firestore, the REAL Storage emulator and REAL Auth-emulator ID tokens, through the
// real route handlers. No identity mocks; only Next's `after()` is captured.
//
//   • every template, preview, import and print-ops route requires `certificates`: manager,
//     finance and gate staff get 403; another workspace gets 404 / sees nothing; a
//     suspended organizer — and a member of a suspended workspace — is refused;
//   • a design save commits an immutable version; an identical save does not;
//   • a print job pins the current version and keeps rendering it after the template is
//     edited, re-sized, archived and even deleted (checked on the rendered PDF's page size);
//   • duplicate copies the actual design; starter import is v1 with its provenance;
//   • a template written before versioning is snapshotted as v1 ('legacy') unchanged;
//   • versions hold layout only — no output, no URL, no attendee data — and nothing is
//     written to Storage;
//   • an ARCHIVED template cannot start a new job (409 TEMPLATE_ARCHIVED) while a job pinned
//     before archiving keeps working; drafts stay printable;
//   • a package above PRINT_PACKAGE_MAX_CARDS is refused (413) without rendering anything;
//     exactly the cap is served.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { PDFDocument } from 'pdf-lib'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `prp1-${process.pid}`
const OWNER = `${P}-owner`, OTHER = `${P}-other`
const ADMIN = `${P}-admin`, MANAGER = `${P}-manager`, FINANCE = `${P}-finance`, GATE = `${P}-gate`
const EV = `${P}-ev`
const PW = 'PrintP1Passw0rd!'
const email = (uid: string) => `${uid}@registerdesk.test`
const MM_TO_PT = 72 / 25.4

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
const ctx = <X extends Record<string, string>>(p: X) => ({ params: Promise.resolve(p) })
type Rec = Record<string, unknown>
type Handler = (r: NextRequest, c?: unknown) => Promise<Response>

describeEmu('RD-PRINT-P1 · template versioning + template/print-ops/preview security (real Auth, Firestore, Storage)', () => {
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let bucket: ReturnType<ReturnType<typeof import('firebase-admin/storage').getStorage>['bucket']>
  let gen: typeof import('@/lib/printAssets/generationJob')
  const tok: Record<string, string> = {}
  const R: Record<string, Record<string, Handler>> = {}
  let BADGE_DESIGN: Rec, BADGE_CANVAS: Rec
  const templates: string[] = [], jobs: string[] = []

  const call = (name: string, method: string, r: NextRequest, p?: Record<string, string>) => R[name][method](r, p ? ctx(p) : undefined)
  const json = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) as Rec | null })
  const versionsOf = async (tid: string) => (await adminDb.collection('printTemplateVersions').where('templateId', '==', tid).get()).docs
    .map(d => ({ id: d.id, ...d.data() } as Rec)).sort((a, b) => (a.version as number) - (b.version as number))
  const createTemplate = async (name: string, design: Rec = BADGE_DESIGN, canvas: Rec = BADGE_CANVAS) => {
    const c = await json(await call('list', 'POST', req('/x', tok[OWNER], 'POST', { eventId: EV, name, assetType: 'ID_CARD', canvas })))
    expect(c.status).toBe(201)
    const id = (c.body!.template as Rec).id as string
    templates.push(id)
    const s = await json(await call('design', 'PUT', req('/x', tok[OWNER], 'PUT', { design }), { id }))
    expect(s.status).toBe(200)
    return id
  }
  const runJob = async (templateId: string) => {
    const c = await json(await call('jobs', 'POST', req('/x', tok[OWNER], 'POST', { templateId })))
    expect(c.status).toBe(201)
    const jobId = c.body!.jobId as string
    jobs.push(jobId)
    for (let i = 0; i < 10; i++) if ((await gen.processPrintGenerationChunk(jobId)).status === 'completed') break
    return jobId
  }
  const pageSizePt = async (jobId: string) => {
    const res = await call('itemDl', 'GET', req('/x', tok[OWNER]), { jobId, registrationId: `${P}-r1` })
    expect(res.status).toBe(200)
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()))
    const { width, height } = pdf.getPage(0).getSize()
    return { w: Math.round(width), h: Math.round(height) }
  }
  const mmPt = (mm: number) => Math.round(mm * MM_TO_PT)

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const admin = await import('@/lib/firebase/admin')
    adminAuth = admin.adminAuth; adminDb = admin.adminDb
    const { getStorage } = await import('firebase-admin/storage')
    const { FIREBASE_STORAGE_BUCKET } = await import('@/lib/env')
    bucket = getStorage(admin.adminApp).bucket(FIREBASE_STORAGE_BUCKET)
    gen = await import('@/lib/printAssets/generationJob')
    const { permissionsForRole } = await import('@/lib/team/types')
    const { PRINT_COLLECTIONS } = await import('@/lib/printAssets/collections')
    const badge = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge')!
    BADGE_DESIGN = badge.design as unknown as Rec
    BADGE_CANVAS = badge.canvas as unknown as Rec

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
    // Any event type — a conference here, so nothing assumes sports.
    const ev = { eventType: 'conference', eventDetails: { seo: { urlSlug: EV }, info: { name: 'Print P1 Summit' } } }
    await adminDb.doc(`users/${OWNER}/eventDrafts/${EV}`).set({ status: 'published', ...ev })
    await adminDb.doc(`users/${OTHER}/eventDrafts/${EV}-o`).set({ status: 'published', eventDetails: { seo: { urlSlug: `${EV}-o` }, info: { name: 'Other' } } })
    await adminDb.doc(`events/${EV}`).set({ uid: OWNER, draftId: EV, slug: EV, lifecycleStatus: 'published', ...ev })
    await adminDb.doc(`registrations/${P}-r1`).set({
      organizerUid: OWNER, eventSlug: EV, eventName: 'Print P1 Summit', status: 'confirmed', paymentStatus: 'paid',
      passId: 'p1', passName: 'Delegate', ticketCode: `RD-${P}-T1`, ticket: { qrValue: `RD:${EV}:${P}-r1:RD-${P}-T1` },
      attendee: { name: 'Delegate One', email: `delegate.${P}@example.test`, phone: '+919876500001', formResponses: { org: 'Acme' } },
    })
    for (const uid of [OWNER, OTHER, ADMIN, MANAGER, FINANCE, GATE]) tok[uid] = await signIn(email(uid))

    const base = '@/app/api/organizer'
    R.list      = await import(`${base}/print-templates/route`) as unknown as Record<string, Handler>
    R.one       = await import(`${base}/print-templates/[id]/route`) as unknown as Record<string, Handler>
    R.design    = await import(`${base}/print-templates/[id]/design/route`) as unknown as Record<string, Handler>
    R.duplicate = await import(`${base}/print-templates/[id]/duplicate/route`) as unknown as Record<string, Handler>
    R.preview   = await import(`${base}/print-templates/[id]/preview/route`) as unknown as Record<string, Handler>
    R.import    = await import(`${base}/print-templates/import/route`) as unknown as Record<string, Handler>
    R.opsGen    = await import(`${base}/print-ops/generation-jobs/route`) as unknown as Record<string, Handler>
    R.opsPkg    = await import(`${base}/print-ops/package-jobs/route`) as unknown as Record<string, Handler>
    R.jobs      = await import(`${base}/print-jobs/route`) as unknown as Record<string, Handler>
    R.itemDl    = await import(`${base}/print-jobs/[jobId]/items/[registrationId]/download/route`) as unknown as Record<string, Handler>
    R.retry     = await import(`${base}/print-jobs/[jobId]/retry/route`) as unknown as Record<string, Handler>
    R.pkgCreate = await import(`${base}/print-packages/route`) as unknown as Record<string, Handler>
    R.pkgDl     = await import(`${base}/print-packages/[jobId]/download/route`) as unknown as Record<string, Handler>
  }, T)

  afterAll(async () => {
    for (const id of jobs) await adminDb.recursiveDelete(adminDb.doc(`printGenerationJobs/${id}`)).catch(() => null)
    for (const d of (await adminDb.collection('printPackageJobs').where('eventId', '==', EV).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('registrations').where('eventSlug', '==', EV).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('printTemplateVersions').where('eventId', '==', EV).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('printTemplates').where('eventId', '==', EV).get()).docs) await d.ref.delete()
    for (const id of templates) await adminDb.doc(`printTemplates/${id}`).delete().catch(() => null)
    await adminDb.doc(`registrations/${P}-r1`).delete().catch(() => null)
    for (const uid of [ADMIN, MANAGER, FINANCE, GATE]) await adminDb.doc(`teamMembers/${P}-m-${uid}`).delete().catch(() => null)
    for (const uid of [OWNER, OTHER]) await adminDb.recursiveDelete(adminDb.doc(`users/${uid}`)).catch(() => null)
    await adminDb.doc(`events/${EV}`).delete().catch(() => null)
    for (const uid of [OWNER, OTHER, ADMIN, MANAGER, FINANCE, GATE]) await adminAuth.deleteUser(uid).catch(() => null)
  }, T)

  it('a design save commits an immutable version; an identical save creates none', async () => {
    const id = await createTemplate('Delegate Card')
    let v = await versionsOf(id)
    expect(v.map(x => [x.version, x.source])).toEqual([[1, 'save']])
    const t = (await json(await call('one', 'GET', req('/x', tok[OWNER]), { id }))).body!.template as Rec
    expect(t.currentVersion).toBe(1)
    const again = await json(await call('design', 'PUT', req('/x', tok[OWNER], 'PUT', { design: BADGE_DESIGN }), { id }))
    expect(again.body!.version).toBe(1)
    v = await versionsOf(id)
    expect(v).toHaveLength(1)
    // Layout only — no output, no URL, no attendee data.
    expect(Object.keys(v[0]).sort()).toEqual(['assetType', 'card', 'contentHash', 'createdAt', 'createdBy', 'design', 'eventId', 'id', 'name', 'organizerUid', 'source', 'templateId', 'version'])
    expect(JSON.stringify(v[0])).not.toMatch(/firebasestorage|token=|printAssets\/|Delegate One|@example\.test|RD-prp1/)
  }, T)

  it('a job PINS the current version and keeps rendering it after the template is edited, re-sized, archived and deleted', async () => {
    const id = await createTemplate('Pinned Card')
    const job1 = await runJob(id)
    expect(((await adminDb.doc(`printGenerationJobs/${job1}`).get()).data() as Rec).templateVersion).toBe(1)
    const v1 = await pageSizePt(job1)
    expect(v1).toEqual({ w: mmPt(54), h: mmPt(85.6) })                       // CR80 portrait

    // Edit the design AND re-size the card to A6 landscape → v2, v3.
    const edited = { ...BADGE_DESIGN, elements: (BADGE_DESIGN.elements as Rec[]).slice(0, 2) }
    expect((await json(await call('design', 'PUT', req('/x', tok[OWNER], 'PUT', { design: edited }), { id }))).body!.version).toBe(2)
    const resized = await json(await call('one', 'PATCH', req('/x', tok[OWNER], 'PATCH', {
      canvas: { preset: 'A6', width: 105, height: 148, unit: 'mm', orientation: 'landscape' },
    }), { id }))
    expect((resized.body!.template as Rec).currentVersion).toBe(3)
    expect((await versionsOf(id)).map(x => [x.version, x.source])).toEqual([[1, 'save'], [2, 'save'], [3, 'resize']])

    // The old job still renders v1; a NEW job renders v3.
    expect(await pageSizePt(job1)).toEqual(v1)
    const job3 = await runJob(id)
    expect(((await adminDb.doc(`printGenerationJobs/${job3}`).get()).data() as Rec).templateVersion).toBe(3)
    expect(await pageSizePt(job3)).toEqual({ w: mmPt(148), h: mmPt(105) })     // A6 landscape

    // v1 is untouched by everything above.
    const firstHash = (await versionsOf(id))[0].contentHash
    // Archive, then DELETE the template: historical jobs still render their pinned version.
    expect((await call('one', 'PATCH', req('/x', tok[OWNER], 'PATCH', { status: 'archived' }), { id })).status).toBe(200)
    expect(await pageSizePt(job1)).toEqual(v1)
    expect((await call('one', 'DELETE', req('/x', tok[OWNER], 'DELETE'), { id })).status).toBe(200)
    expect(await pageSizePt(job1)).toEqual(v1)
    expect(await pageSizePt(job3)).toEqual({ w: mmPt(148), h: mmPt(105) })
    expect((await versionsOf(id))[0].contentHash).toBe(firstHash)
    // Still nothing stored.
    expect((await bucket.getFiles({ prefix: `printAssets/${OWNER}/` }))[0]).toEqual([])
  }, T)

  it('duplicate copies the ACTUAL current design and records where it came from', async () => {
    const id = await createTemplate('Original')
    const res = await json(await call('duplicate', 'POST', req('/x', tok[OWNER], 'POST', {}), { id }))
    expect(res.status).toBe(201)
    const copy = res.body!.template as Rec
    templates.push(copy.id as string)
    expect(copy.currentVersion).toBe(1)
    expect((copy.design as Rec).elements).toEqual((BADGE_DESIGN.elements as Rec[]))
    const [cv] = await versionsOf(copy.id as string)
    expect(cv).toMatchObject({ source: 'duplicate', copiedFrom: { templateId: id, version: 1 } })
    expect(cv.contentHash).toBe((await versionsOf(id))[0].contentHash)
  }, T)

  it('starter import creates v1 with its provenance', async () => {
    const res = await json(await call('import', 'POST', req('/x', tok[OWNER], 'POST', { collectionId: 'conference', eventId: EV, templateIndices: [0] })))
    expect(res.status).toBe(201)
    const t = (res.body!.templates as Rec[])[0]
    templates.push(t.id as string)
    expect(t.currentVersion).toBe(1)
    const [v] = await versionsOf(t.id as string)
    expect(v).toMatchObject({ version: 1, source: 'import', starter: { collectionId: 'conference' } })
    expect((v.design as Rec).elements).toEqual((t.design as Rec).elements)
  }, T)

  it('a template written BEFORE versioning is snapshotted as v1 unchanged, then edits become v2', async () => {
    const ref = adminDb.collection('printTemplates').doc()
    templates.push(ref.id)
    await ref.set({ eventId: EV, organizerUid: OWNER, createdBy: OWNER, name: 'Pre-versioning', description: '', assetType: 'BADGE',
      status: 'published', canvas: BADGE_CANVAS, design: BADGE_DESIGN, createdAt: new Date(), updatedAt: new Date() })
    const job = await runJob(ref.id)
    expect(((await adminDb.doc(`printGenerationJobs/${job}`).get()).data() as Rec).templateVersion).toBe(1)
    const [legacy] = await versionsOf(ref.id)
    expect(legacy).toMatchObject({ version: 1, source: 'legacy' })
    expect((legacy.design as Rec).elements).toEqual(BADGE_DESIGN.elements)
    const edited = { ...BADGE_DESIGN, elements: (BADGE_DESIGN.elements as Rec[]).slice(1) }
    expect((await json(await call('design', 'PUT', req('/x', tok[OWNER], 'PUT', { design: edited }), { id: ref.id }))).body!.version).toBe(2)
    expect(await pageSizePt(job)).toEqual({ w: mmPt(54), h: mmPt(85.6) })
  }, T)

  it('manager, finance and gate staff are refused by every template, preview, import and print-ops route', async () => {
    const id = await createTemplate('Guarded')
    const before = JSON.stringify((await adminDb.doc(`printTemplates/${id}`).get()).data())
    for (const uid of [MANAGER, FINANCE, GATE]) {
      const t = tok[uid]
      const checks: Array<[string, Promise<Response>]> = [
        ['list GET',      call('list', 'GET', req('/x', t))],
        ['list POST',     call('list', 'POST', req('/x', t, 'POST', { eventId: EV, name: 'X', assetType: 'BADGE', canvas: BADGE_CANVAS }))],
        ['one GET',       call('one', 'GET', req('/x', t), { id })],
        ['one PATCH',     call('one', 'PATCH', req('/x', t, 'PATCH', { name: 'hijack' }), { id })],
        ['one DELETE',    call('one', 'DELETE', req('/x', t, 'DELETE'), { id })],
        ['design PUT',    call('design', 'PUT', req('/x', t, 'PUT', { design: BADGE_DESIGN }), { id })],
        ['duplicate',     call('duplicate', 'POST', req('/x', t, 'POST', {}), { id })],
        ['preview GET',   call('preview', 'GET', req('/x', t), { id })],
        ['preview POST',  call('preview', 'POST', req('/x', t, 'POST', {}), { id })],
        ['import',        call('import', 'POST', req('/x', t, 'POST', { collectionId: 'conference', eventId: EV, templateIndices: [0] }))],
        ['ops gen',       call('opsGen', 'GET', req('/x', t))],
        ['ops pkg',       call('opsPkg', 'GET', req('/x', t))],
      ]
      for (const [name, p] of checks) expect((await p).status, `${uid} → ${name}`).toBe(403)
    }
    expect(JSON.stringify((await adminDb.doc(`printTemplates/${id}`).get()).data())).toBe(before)
    // An admin holds `certificates` and is allowed.
    expect((await call('one', 'GET', req('/x', tok[ADMIN]), { id })).status).toBe(200)
    expect((await call('preview', 'GET', req('/x', tok[ADMIN]), { id })).status).toBe(200)
  }, T)

  it('another workspace cannot read, change, preview, duplicate or print this workspace\'s templates (404), and lists none of them', async () => {
    const id = await createTemplate('Private')
    const t = tok[OTHER]
    for (const [name, p] of [
      ['one GET',      call('one', 'GET', req('/x', t), { id })],
      ['one PATCH',    call('one', 'PATCH', req('/x', t, 'PATCH', { name: 'x' }), { id })],
      ['one DELETE',   call('one', 'DELETE', req('/x', t, 'DELETE'), { id })],
      ['design PUT',   call('design', 'PUT', req('/x', t, 'PUT', { design: BADGE_DESIGN }), { id })],
      ['duplicate',    call('duplicate', 'POST', req('/x', t, 'POST', {}), { id })],
      ['preview GET',  call('preview', 'GET', req('/x', t), { id })],
      ['job POST',     call('jobs', 'POST', req('/x', t, 'POST', { templateId: id }))],
    ] as Array<[string, Promise<Response>]>) expect((await p).status, `other → ${name}`).toBe(404)
    // Importing into this workspace's event is refused (the event is not theirs).
    expect((await call('import', 'POST', req('/x', t, 'POST', { collectionId: 'conference', eventId: EV, templateIndices: [0] }))).status).toBe(404)
    const lists = await Promise.all([call('list', 'GET', req('/x', t)), call('opsGen', 'GET', req('/x', t)), call('opsPkg', 'GET', req('/x', t))])
    const text = JSON.stringify(await Promise.all(lists.map(r => r.json())))
    expect(text).not.toContain(id)
    expect(text).not.toContain(EV)
    expect((await versionsOf(id))).toHaveLength(1)
  }, T)

  it('an ARCHIVED template cannot start a new job; drafts can; a job pinned before archiving keeps working', async () => {
    const id = await createTemplate('Archivable')                       // created as a draft
    expect(((await adminDb.doc(`printTemplates/${id}`).get()).data() as Rec).status).toBe('draft')
    const pinned = await runJob(id)                                      // drafts stay printable
    const jobsBefore = (await adminDb.collection('printGenerationJobs').where('templateId', '==', id).get()).size

    expect((await call('one', 'PATCH', req('/x', tok[OWNER], 'PATCH', { status: 'archived' }), { id })).status).toBe(200)
    const refused = await json(await call('jobs', 'POST', req('/x', tok[OWNER], 'POST', { templateId: id })))
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ success: false, code: 'TEMPLATE_ARCHIVED' })
    expect((await adminDb.collection('printGenerationJobs').where('templateId', '==', id).get()).size).toBe(jobsBefore)
    expect(await versionsOf(id)).toHaveLength(1)                         // no version minted for a refused job

    // The job pinned BEFORE archiving keeps working: regenerate, download, package.
    expect((await call('retry', 'POST', req('/x', tok[OWNER], 'POST', { mode: 'regenerate' }), { jobId: pinned })).status).toBe(200)
    for (let i = 0; i < 5; i++) if ((await gen.processPrintGenerationChunk(pinned)).status === 'completed') break
    expect((await call('itemDl', 'GET', req('/x', tok[OWNER]), { jobId: pinned, registrationId: `${P}-r1` })).status).toBe(200)
    const pkg = await json(await call('pkgCreate', 'POST', req('/x', tok[OWNER], 'POST', { sourceJobId: pinned })))
    expect(pkg.status).toBe(201)
    expect((await call('pkgDl', 'GET', req('/x', tok[OWNER]), { jobId: pkg.body!.jobId as string })).status).toBe(200)

    // Restoring it makes it printable again.
    expect((await call('one', 'PATCH', req('/x', tok[OWNER], 'PATCH', { status: 'published' }), { id })).status).toBe(200)
    expect((await call('jobs', 'POST', req('/x', tok[OWNER], 'POST', { templateId: id }))).status).toBe(201)
    for (const d of (await adminDb.collection('printGenerationJobs').where('templateId', '==', id).get()).docs) jobs.push(d.id)
  }, T)

  it('a package above 500 cards is REFUSED (413) without rendering; exactly 500 is served; the byte budget refuses', async () => {
    const { PRINT_PACKAGE_MAX_CARDS } = await import('@/lib/printAssets/packageJob')
    expect(PRINT_PACKAGE_MAX_CARDS).toBe(500)
    const id = await createTemplate('Bulk')
    const { ensureCurrentVersion } = await import('@/lib/printAssets/versions')
    const pin = await ensureCurrentVersion(id, OWNER, OWNER)
    // Fixture: 501 eligible registrations and a completed, pinned job whose 501 items rendered.
    const N = PRINT_PACKAGE_MAX_CARDS + 1
    const jobId = `pgen_${P}-bulk`
    jobs.push(jobId)
    const ids = Array.from({ length: N }, (_, i) => `${P}-b${String(i).padStart(4, '0')}`)
    for (let i = 0; i < N; i += 200) {
      const b = adminDb.batch()
      for (const rid of ids.slice(i, i + 200)) {
        b.set(adminDb.doc(`registrations/${rid}`), {
          organizerUid: OWNER, eventSlug: EV, eventName: 'Print P1 Summit', status: 'confirmed', paymentStatus: 'paid',
          passId: 'p1', passName: 'Delegate', ticketCode: `T-${rid}`, attendee: { name: `Bulk ${rid}`, email: `${rid}@example.test` },
        })
        b.set(adminDb.doc(`printGenerationJobs/${jobId}/items/${rid}`), { registrationId: rid, passId: 'p1', passName: 'Delegate', category: '', rendered: true, error: null })
      }
      await b.commit()
    }
    await adminDb.doc(`printGenerationJobs/${jobId}`).set({
      jobId, status: 'completed', counts: { total: N, processed: N, succeeded: N, failed: 0 }, organizerUid: OWNER, createdBy: OWNER,
      templateId: id, templateVersion: pin.version, templateVersionHash: pin.hash, eventId: EV, eventSlug: EV, eventName: 'Print P1 Summit',
      assetType: 'ID_CARD', filters: {}, cursor: null, error: null, lockedUntil: null, createdAt: new Date(), updatedAt: new Date(),
    })

    // 501 → the package records why and is not downloadable; the download refuses fast.
    const over = await json(await call('pkgCreate', 'POST', req('/x', tok[OWNER], 'POST', { sourceJobId: jobId })))
    expect(over.status).toBe(201)
    expect(over.body!.job).toMatchObject({ ready: false, stats: { filesTotal: N, packaged: N } })
    expect(String((over.body!.job as Rec).error)).toContain('at most 500')
    const t0 = Date.now()
    const dl = await call('pkgDl', 'GET', req('/x', tok[OWNER]), { jobId: over.body!.jobId as string })
    expect(dl.status).toBe(413)
    expect(((await dl.json()) as { error: string }).error).toContain('at most 500')
    expect(Date.now() - t0).toBeLessThan(5_000)                         // refused before rendering 501 cards

    // Exactly 500 → served as one ZIP. (RD-PRINT-P2 drew QR codes as row runs, so these cards
    // are ~5.5 KB each and 500 fit the 4 MiB budget; before that they did not.)
    const atCap = await json(await call('pkgCreate', 'POST', req('/x', tok[OWNER], 'POST', { sourceJobId: jobId, filters: { registrationIds: ids.slice(0, 500) } })))
    expect(atCap.body!.job).toMatchObject({ ready: true, stats: { packaged: 500 } })
    const zip = await call('pkgDl', 'GET', req('/x', tok[OWNER]), { jobId: atCap.body!.jobId as string })
    expect(zip.status, zip.status === 200 ? '' : await zip.clone().text()).toBe(200)
    expect(zip.headers.get('x-print-card-count')).toBe('500')
    expect(Number(zip.headers.get('content-length') ?? (await zip.clone().arrayBuffer()).byteLength)).toBeLessThan(4 * 1024 * 1024)

    // The BYTE budget refuses with its own message — never truncates (budget tightened for the test).
    const { buildPrintPackageZip, getPrintPackageJob } = await import('@/lib/printAssets/packageJob')
    const pkgDoc = (await getPrintPackageJob(atCap.body!.jobId as string))!
    const tight = await buildPrintPackageZip(pkgDoc, { maxBytes: 50_000 })
    expect(tight).toMatchObject({ ok: false, status: 413 })
    expect((tight as { error: string }).error).toContain('larger than one download allows')
    expect((await bucket.getFiles({ prefix: `printPackages/${OWNER}/` }))[0]).toEqual([])
  }, 300_000)

  it('a SUSPENDED organizer — and a member of the suspended workspace — is refused by the shared authorization', async () => {
    const id = await createTemplate('Moderated')
    await adminDb.doc(`users/${OWNER}`).update({ accountStatus: 'suspended' })
    try {
      for (const uid of [OWNER, ADMIN]) {
        const t = tok[uid]
        for (const [name, p] of [
          ['list GET',   call('list', 'GET', req('/x', t))],
          ['one GET',    call('one', 'GET', req('/x', t), { id })],
          ['design PUT', call('design', 'PUT', req('/x', t, 'PUT', { design: BADGE_DESIGN }), { id })],
          ['preview',    call('preview', 'GET', req('/x', t), { id })],
          ['job POST',   call('jobs', 'POST', req('/x', t, 'POST', { templateId: id }))],
          ['ops gen',    call('opsGen', 'GET', req('/x', t))],
        ] as Array<[string, Promise<Response>]>) expect((await p).status, `${uid} (suspended workspace) → ${name}`).toBe(403)
      }
      expect(await versionsOf(id)).toHaveLength(1)
    } finally {
      await adminDb.doc(`users/${OWNER}`).update({ accountStatus: 'active' })
    }
  }, T)
})
