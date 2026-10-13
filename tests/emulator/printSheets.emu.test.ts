// RD-PRINT-P2 — print sheets end to end on REAL Firestore, the REAL Storage emulator and REAL
// Auth-emulator ID tokens, through the real routes. Only two things are stubbed: Next's
// `after()` (needs a request scope) and the network read of the logo bytes
// (`safeFetchBytes`) — the logo URL is still validated and ownership-checked for real, but
// its bytes come from a local PNG instead of Google's production storage host.
//
//   • branded cards (event logo + QR + text) on A4 / A3, portrait / landscape, with crop
//     marks: page count, page size, cards per sheet and the logo embedded ONCE;
//   • the job's PINNED card size is used even after the template is re-sized;
//   • a card too large for the paper, a bad sheet spec and too-tight crop-mark margins are
//     clear 4xx errors; >500 cards is refused before rendering; the byte and time limits refuse;
//   • a refunded registration is left out and reported;
//   • nothing is stored (Storage, URLs, attendee copies);
//   • `certificates` + ownership: manager / finance / gate staff 403, another workspace 404,
//     a query-string token 401.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import zlib from 'node:zlib'
import { PDFDocument, PDFName, PDFDict, PDFRef } from 'pdf-lib'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `prp2-${process.pid}`
const OWNER = `${P}-owner`, OTHER = `${P}-other`
const ADMIN = `${P}-admin`, MANAGER = `${P}-manager`, FINANCE = `${P}-finance`, GATE = `${P}-gate`
const EV = `${P}-ev`
const PW = 'PrintP2Passw0rd!'
const email = (uid: string) => `${uid}@registerdesk.test`
const MM = 72 / 25.4

function png(w: number, h: number): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = (x * 3) & 255; raw[o + 1] = (y * 5) & 255; raw[o + 2] = 90; raw[o + 3] = 255 }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
const LOGO_BYTES = png(240, 120)

const deferred = vi.hoisted(() => ({ fns: [] as Array<() => unknown> }))
const fetched = vi.hoisted(() => ({ urls: [] as string[] }))
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => unknown) => { deferred.fns.push(fn) } }))
vi.mock('@/lib/notifications/inbox/notify', async (orig) => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifyPrintJobComplete: async () => {} }))
vi.mock('@/lib/certificates/urlGuard', async (orig) => ({
  ...(await orig<typeof import('@/lib/certificates/urlGuard')>()),
  safeFetchBytes: async (url: string) => { fetched.urls.push(url); return LOGO_BYTES },
}))

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

describeEmu('RD-PRINT-P2 · print sheets (real Auth, Firestore, Storage)', () => {
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let bucket: ReturnType<ReturnType<typeof import('firebase-admin/storage').getStorage>['bucket']>
  let gen: typeof import('@/lib/printAssets/generationJob')
  let layoutMod: typeof import('@/lib/printAssets/sheet/layout')
  const tok: Record<string, string> = {}
  const R: Record<string, Record<string, Handler>> = {}
  const templates: string[] = [], jobs: string[] = []
  let DESIGN: Rec
  let LOGO_URL = ''

  const call = (name: string, method: string, r: NextRequest, p?: Record<string, string>) => R[name][method](r, p ? ctx(p) : undefined)
  const sheets = (jobId: string, body: Rec, t = tok[OWNER]) => call('sheets', 'POST', req('/x', t, 'POST', body), { jobId })
  const createTemplate = async (name: string, canvas: Rec) => {
    const c = await call('list', 'POST', req('/x', tok[OWNER], 'POST', { eventId: EV, name, assetType: 'ID_CARD', canvas }))
    expect(c.status).toBe(201)
    const id = ((await c.json()) as { template: Rec }).template.id as string
    templates.push(id)
    expect((await call('design', 'PUT', req('/x', tok[OWNER], 'PUT', { design: DESIGN }), { id })).status).toBe(200)
    return id
  }
  const runJob = async (templateId: string) => {
    const c = await call('jobs', 'POST', req('/x', tok[OWNER], 'POST', { templateId }))
    expect(c.status).toBe(201)
    const jobId = ((await c.json()) as { jobId: string }).jobId
    jobs.push(jobId)
    for (let i = 0; i < 10; i++) if ((await gen.processPrintGenerationChunk(jobId)).status === 'completed') break
    return jobId
  }
  const pdfOf = async (res: Response) => PDFDocument.load(new Uint8Array(await res.arrayBuffer()))
  const imageObjects = (pdf: PDFDocument) => {
    const refs = new Set<string>()
    for (const p of pdf.getPages()) {
      const xo = p.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)
      for (const [, r] of xo?.entries() ?? []) if (r instanceof PDFRef) refs.add(r.toString())
    }
    return refs.size
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const admin = await import('@/lib/firebase/admin')
    adminAuth = admin.adminAuth; adminDb = admin.adminDb
    const { getStorage } = await import('firebase-admin/storage')
    const { FIREBASE_STORAGE_BUCKET } = await import('@/lib/env')
    bucket = getStorage(admin.adminApp).bucket(FIREBASE_STORAGE_BUCKET)
    gen = await import('@/lib/printAssets/generationJob')
    layoutMod = await import('@/lib/printAssets/sheet/layout')
    const { permissionsForRole } = await import('@/lib/team/types')
    const { PRINT_COLLECTIONS } = await import('@/lib/printAssets/collections')
    const badge = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge')!
    // Branded: the bundled badge plus the EVENT LOGO (a real image element).
    DESIGN = { ...badge.design, elements: [...badge.design.elements, { id: 'logo', type: 'image', x: 0.06, y: 0.82, width: 0.4, height: 0.14, rotation: 0, visible: true, locked: false, zIndex: 50, properties: { text: '{{custom.eventLogo}}', fit: 'contain' } }] } as unknown as Rec
    LOGO_URL = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_STORAGE_BUCKET}/o/${encodeURIComponent(`event-assets/${OWNER}/${EV}/logo/logo.png`)}?alt=media&token=test`

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
    // A college fest here — nothing assumes sports.
    const ev = { eventType: 'college', eventDetails: { seo: { urlSlug: EV }, info: { name: 'Techfest Annual Summit 2026' }, media: { logo: { value: LOGO_URL } } } }
    await adminDb.doc(`users/${OWNER}/eventDrafts/${EV}`).set({ status: 'published', ...ev })
    await adminDb.doc(`events/${EV}`).set({ uid: OWNER, draftId: EV, slug: EV, lifecycleStatus: 'published', ...ev })
    const b = adminDb.batch()
    for (let i = 0; i < 25; i++) {
      b.set(adminDb.doc(`registrations/${P}-r${String(i).padStart(2, '0')}`), {
        organizerUid: OWNER, eventSlug: EV, eventName: 'Techfest Annual Summit 2026', status: 'confirmed', paymentStatus: 'paid',
        passId: 'p1', passName: 'All-Access Delegate', ticketCode: `RD-${P}-T${i}`, ticket: { qrValue: `RD:${EV}:${P}-r${i}:RD-${P}-T${i}` },
        companyName: 'Sundaram Institute of Technology', designation: 'Student Coordinator',
        attendee: { name: `Priyadarshini Ramasubramanian ${i}`, email: `p${i}.${P}@example.test`, phone: '+919876543210', formResponses: { college: 'SIT' } },
      })
    }
    await b.commit()
    for (const uid of [OWNER, OTHER, ADMIN, MANAGER, FINANCE, GATE]) tok[uid] = await signIn(email(uid))

    const base = '@/app/api/organizer'
    R.list   = await import(`${base}/print-templates/route`) as unknown as Record<string, Handler>
    R.one    = await import(`${base}/print-templates/[id]/route`) as unknown as Record<string, Handler>
    R.design = await import(`${base}/print-templates/[id]/design/route`) as unknown as Record<string, Handler>
    R.jobs   = await import(`${base}/print-jobs/route`) as unknown as Record<string, Handler>
    R.sheets = await import(`${base}/print-jobs/[jobId]/sheets/route`) as unknown as Record<string, Handler>
  }, T)

  afterAll(async () => {
    for (const id of jobs) await adminDb.recursiveDelete(adminDb.doc(`printGenerationJobs/${id}`)).catch(() => null)
    for (const d of (await adminDb.collection('printTemplateVersions').where('eventId', '==', EV).get()).docs) await d.ref.delete()
    for (const id of templates) await adminDb.doc(`printTemplates/${id}`).delete().catch(() => null)
    for (const d of (await adminDb.collection('registrations').where('eventSlug', '==', EV).get()).docs) await d.ref.delete()
    for (const uid of [ADMIN, MANAGER, FINANCE, GATE]) await adminDb.doc(`teamMembers/${P}-m-${uid}`).delete().catch(() => null)
    for (const uid of [OWNER, OTHER]) await adminDb.recursiveDelete(adminDb.doc(`users/${uid}`)).catch(() => null)
    await adminDb.doc(`events/${EV}`).delete().catch(() => null)
    for (const uid of [OWNER, OTHER, ADMIN, MANAGER, FINANCE, GATE]) await adminAuth.deleteUser(uid).catch(() => null)
  }, T)

  let jobCR80 = ''

  it('branded CR80 cards on A4 portrait with crop marks: right pages, size and grid; logo embedded once; nothing stored', async () => {
    const id = await createTemplate('Delegate Badge', { preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait' })
    jobCR80 = await runJob(id)
    const res = await sheets(jobCR80, { sheet: { paper: 'A4', orientation: 'portrait', marginMm: 10, gapMm: 4, cropMarks: true } })
    expect(res.status, res.status === 200 ? '' : await res.clone().text()).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(res.headers.get('x-print-card-count')).toBe('25')
    expect(res.headers.get('x-print-cards-per-sheet')).toBe('9')
    expect(res.headers.get('x-print-sheet-count')).toBe('3')
    const pdf = await pdfOf(res)
    expect(pdf.getPageCount()).toBe(3)
    for (const p of pdf.getPages()) { expect(p.getWidth() / MM).toBeCloseTo(210, 2); expect(p.getHeight() / MM).toBeCloseTo(297, 2) }
    expect(imageObjects(pdf)).toBe(1)                                     // the logo, once, for 25 cards
    expect(fetched.urls).toContain(LOGO_URL)
    // Nothing stored: no objects, no URL / path / attendee copy in the job's records.
    expect((await bucket.getFiles({ prefix: `printAssets/${OWNER}/` }))[0]).toEqual([])
    expect((await bucket.getFiles({ prefix: `printPackages/${OWNER}/` }))[0]).toEqual([])
    const stored = JSON.stringify({
      job: (await adminDb.doc(`printGenerationJobs/${jobCR80}`).get()).data(),
      items: (await adminDb.collection(`printGenerationJobs/${jobCR80}/items`).get()).docs.map(d => d.data()),
    })
    for (const f of ['firebasestorage', 'token=', 'Priyadarshini', '@example.test', '+919876', `RD-${P}-T`]) expect(stored, f).not.toContain(f)
  }, T)

  it('A3 and landscape change the grid exactly as the shared layout says', async () => {
    for (const s of [{ paper: 'A3', orientation: 'portrait' }, { paper: 'A4', orientation: 'landscape' }, { paper: 'A3', orientation: 'landscape' }] as const) {
      const sheet = { ...s, marginMm: 8, gapMm: 3, cropMarks: true }
      const expected = layoutMod.computeSheetLayout({ w: 54, h: 85.6 }, sheet)
      if (!expected.ok) throw new Error('fixture')
      const res = await sheets(jobCR80, { sheet })
      expect(res.status).toBe(200)
      expect(Number(res.headers.get('x-print-cards-per-sheet'))).toBe(expected.layout.perSheet)
      const pdf = await pdfOf(res)
      expect(pdf.getPageCount()).toBe(Math.ceil(25 / expected.layout.perSheet))
      expect(pdf.getPage(0).getWidth()).toBeCloseTo(expected.layout.pageW, 1)
      expect(pdf.getPage(0).getHeight()).toBeCloseTo(expected.layout.pageH, 1)
    }
  }, T)

  it('a selection prints only those cards; a refunded registration is left out and reported', async () => {
    const ids = [`${P}-r00`, `${P}-r01`, `${P}-r02`]
    await adminDb.doc(`registrations/${P}-r02`).update({ paymentStatus: 'refunded' })
    try {
      const res = await sheets(jobCR80, { registrationIds: [...ids, 'not-in-this-job'] })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-print-card-count')).toBe('2')
      expect(res.headers.get('x-print-cards-skipped')).toBe('1')
    } finally {
      await adminDb.doc(`registrations/${P}-r02`).update({ paymentStatus: 'paid' })
    }
  }, T)

  it('a job keeps its PINNED card size after the template is re-sized (custom inches → still CR80 on the sheet)', async () => {
    const tid = (((await adminDb.doc(`printGenerationJobs/${jobCR80}`).get()).data()) as Rec).templateId as string
    const resized = await call('one', 'PATCH', req('/x', tok[OWNER], 'PATCH', { canvas: { preset: 'CUSTOM', width: 4, height: 6, unit: 'in', orientation: 'portrait' } }), { id: tid })
    expect(resized.status).toBe(200)
    const res = await sheets(jobCR80, { sheet: { paper: 'A4', marginMm: 10, gapMm: 4 } })
    expect(res.headers.get('x-print-cards-per-sheet')).toBe('9')                // CR80, not 4×6 in
    // A NEW job uses the new custom size: 101.6 × 152.4 mm → 1 × 1 on A4 portrait.
    const job2 = await runJob(tid)
    const r2 = await sheets(job2, { sheet: { paper: 'A4', marginMm: 10, gapMm: 4 } })
    expect(r2.headers.get('x-print-cards-per-sheet')).toBe(String((layoutMod.computeSheetLayout({ w: 101.6, h: 152.4 }, { paper: 'A4', orientation: 'portrait', marginMm: 10, gapMm: 4, cropMarks: false }) as { layout: { perSheet: number } }).layout.perSheet))
  }, T)

  it('clear errors: card too large for the paper, invalid sheet, crop marks without margin room', async () => {
    const a4card = await createTemplate('Poster card', { preset: 'A4', width: 210, height: 297, unit: 'mm', orientation: 'portrait' })
    const job = await runJob(a4card)
    const tooBig = await sheets(job, { sheet: { paper: 'A4', marginMm: 10 } })
    expect(tooBig.status).toBe(422)
    expect(await tooBig.json()).toMatchObject({ code: 'CARD_TOO_LARGE' })
    expect((await sheets(job, { sheet: { paper: 'A4', marginMm: 0, gapMm: 0 } })).status).toBe(200)   // exactly fits
    expect(await (await sheets(jobCR80, { sheet: { paper: 'Letter' } })).json()).toMatchObject({ code: 'INVALID_SHEET' })
    expect((await sheets(jobCR80, { sheet: { marginMm: 99 } })).status).toBe(400)
    const crop = await sheets(jobCR80, { sheet: { marginMm: 2, cropMarks: true } })
    expect(crop.status).toBe(422)
    expect(await crop.json()).toMatchObject({ code: 'MARGIN_TOO_SMALL_FOR_CROP_MARKS' })
    // Template dimensions outside the printable range are refused when saved.
    const bad = await call('list', 'POST', req('/x', tok[OWNER], 'POST', { eventId: EV, name: 'x', assetType: 'ID_CARD', canvas: { preset: 'CUSTOM', width: 5, height: 50, unit: 'mm', orientation: 'portrait' } }))
    expect(bad.status).toBe(400)
  }, T)

  it('limits: >500 cards refused before rendering; byte and time budgets refuse (never truncate)', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `x${i}`)
    const t0 = Date.now()
    const r = await sheets(jobCR80, { registrationIds: many })
    expect(r.status).toBe(413)
    expect(await r.json()).toMatchObject({ code: 'TOO_MANY_CARDS' })
    expect(Date.now() - t0).toBeLessThan(3_000)
    const job = (await gen.getPrintGenerationJob(jobCR80))!
    const spec = layoutMod.DEFAULT_SHEET_SPEC
    expect(await gen.renderPrintSheets(job, { spec, limits: { maxBytes: 10_000 } })).toMatchObject({ ok: false, status: 413, code: 'TOO_LARGE' })
    expect(await gen.renderPrintSheets(job, { spec, limits: { timeBudgetMs: -1 } })).toMatchObject({ ok: false, status: 503, code: 'TIME_BUDGET' })
    const ok = await gen.renderPrintSheets(job, { spec })
    expect(ok.ok && ok.bytes.length).toBeLessThan(gen.PRINT_SHEET_MAX_BYTES)
  }, T)

  it('authorization: manager, finance and gate staff 403; another workspace 404; query-string token 401; admin allowed', async () => {
    for (const uid of [MANAGER, FINANCE, GATE]) expect((await sheets(jobCR80, {}, tok[uid])).status, uid).toBe(403)
    expect((await sheets(jobCR80, {}, tok[OTHER])).status).toBe(404)
    const q = await call('sheets', 'POST', req(`/x?token=${encodeURIComponent(tok[OWNER])}`, null, 'POST', {}), { jobId: jobCR80 })
    expect(q.status).toBe(401)
    expect((await sheets(jobCR80, {}, tok[ADMIN])).status).toBe(200)
  }, T)
})
