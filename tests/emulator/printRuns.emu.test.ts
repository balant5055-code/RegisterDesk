// RD-PRINT-P3 — combined on-demand print runs end to end on REAL Firestore, the REAL Storage
// emulator and REAL Auth-emulator ID tokens, through the real routes, merged with the SAME
// mergeRunBatches the browser uses. Stubbed: Next's `after()` and the network read of the
// logo bytes (`safeFetchBytes` — the URL is still validated and ownership-checked).
//
//   • multiple sheet-aligned batches merge into ONE PDF holding every eligible card exactly
//     once, in the frozen deterministic order (read back from the PDF text);
//   • missing / refunded / foreign selections are reported as skipped at planning;
//   • a registration refunded AFTER planning fails its batch and the run (no partial PDF);
//   • retrying a batch is safe; completion needs every batch and the planned page count;
//   • a duplicate submission returns the same run; history is metadata only; nothing stored;
//   • pinned version survives a template re-size; dense sheets / oversize selections /
//     unpinned jobs are refused before rendering; text-overflow warnings leave the design alone;
//   • `certificates` + ownership: manager / finance / gate 403, another workspace 404, query token 401.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import zlib from 'node:zlib'
import { PDFDocument, PDFArray, PDFName, PDFRawStream } from 'pdf-lib'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = `prp3-${process.pid}`
const OWNER = `${P}-owner`, OTHER = `${P}-other`
const ADMIN = `${P}-admin`, MANAGER = `${P}-manager`, FINANCE = `${P}-finance`, GATE = `${P}-gate`
const EV = `${P}-ev`
const PW = 'PrintP3Passw0rd!'
const email = (uid: string) => `${uid}@registerdesk.test`
const N = 30
const rid = (i: number) => `${P}-r${String(i).padStart(3, '0')}`

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
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => unknown) => { deferred.fns.push(fn) } }))
vi.mock('@/lib/notifications/inbox/notify', async (orig) => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifyPrintJobComplete: async () => {} }))
vi.mock('@/lib/certificates/urlGuard', async (orig) => ({ ...(await orig<typeof import('@/lib/certificates/urlGuard')>()), safeFetchBytes: async () => LOGO_BYTES }))

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

/** The card holders' printed names, in document order, read from the PDF content streams. */
async function printedNames(pdf: PDFDocument): Promise<string[]> {
  const out: string[] = []
  for (const p of pdf.getPages()) {
    const c = p.node.Contents()
    const streams = c instanceof PDFArray ? c.asArray().map(r => pdf.context.lookup(r)) : [c]
    for (const st of streams) {
      if (!(st instanceof PDFRawStream)) continue
      const raw = Buffer.from(st.contents)
      const text = (st.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode' ? zlib.inflateSync(raw) : raw).toString('latin1')
      for (const m of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        const s = Buffer.from(m[1], 'hex').toString('latin1')
        const hit = /Holder (\d{3})/.exec(s)
        if (hit) out.push(hit[1])
      }
    }
  }
  return out
}

describeEmu('RD-PRINT-P3 · combined on-demand print runs (real Auth, Firestore, Storage)', () => {
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let bucket: ReturnType<ReturnType<typeof import('firebase-admin/storage').getStorage>['bucket']>
  let gen: typeof import('@/lib/printAssets/generationJob')
  let merge: typeof import('@/lib/printAssets/runs/client').mergeRunBatches
  const tok: Record<string, string> = {}
  const R: Record<string, Record<string, Handler>> = {}
  const templates: string[] = [], jobs: string[] = []
  let DESIGN: Rec, LOGO_URL = '', templateId = '', jobId = ''
  let req0 = 0
  const nextRequestId = () => `req-${P}-${++req0}`

  const call = (name: string, method: string, r: NextRequest, p?: Record<string, string>) => R[name][method](r, p ? ctx(p) : undefined)
  const plan = async (body: Rec, t = tok[OWNER], job = jobId) => {
    const res = await call('plan', 'POST', req('/x', t, 'POST', { requestId: nextRequestId(), ...body }), { jobId: job })
    return { status: res.status, body: await res.json() as Rec }
  }
  const batch = (runId: string, i: number, t = tok[OWNER]) => call('batch', 'POST', req('/x', t, 'POST', {}), { runId, index: String(i) })
  const fetchAll = async (run: Rec) => {
    const parts: ArrayBuffer[] = []
    for (let i = 0; i < (run.batchCount as number); i++) {
      const r = await batch(run.runId as string, i)
      expect(r.status, r.status === 200 ? '' : await r.clone().text()).toBe(200)
      expect(r.headers.get('cache-control')).toContain('no-store')
      parts.push(await r.arrayBuffer())
    }
    return parts
  }
  const createTemplate = async (name: string, canvas: Rec, design: Rec = DESIGN) => {
    const c = await call('list', 'POST', req('/x', tok[OWNER], 'POST', { eventId: EV, name, assetType: 'ID_CARD', canvas }))
    expect(c.status).toBe(201)
    const id = ((await c.json()) as { template: Rec }).template.id as string
    templates.push(id)
    expect((await call('design', 'PUT', req('/x', tok[OWNER], 'PUT', { design }), { id })).status).toBe(200)
    return id
  }
  const runJob = async (tid: string) => {
    const c = await call('jobs', 'POST', req('/x', tok[OWNER], 'POST', { templateId: tid }))
    expect(c.status).toBe(201)
    const id = ((await c.json()) as { jobId: string }).jobId
    jobs.push(id)
    for (let i = 0; i < 10; i++) if ((await gen.processPrintGenerationChunk(id)).status === 'completed') break
    return id
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const admin = await import('@/lib/firebase/admin')
    adminAuth = admin.adminAuth; adminDb = admin.adminDb
    const { getStorage } = await import('firebase-admin/storage')
    const { FIREBASE_STORAGE_BUCKET } = await import('@/lib/env')
    bucket = getStorage(admin.adminApp).bucket(FIREBASE_STORAGE_BUCKET)
    gen = await import('@/lib/printAssets/generationJob')
    merge = (await import('@/lib/printAssets/runs/client')).mergeRunBatches
    const { permissionsForRole } = await import('@/lib/team/types')
    const { PRINT_COLLECTIONS } = await import('@/lib/printAssets/collections')
    const badge = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge')!
    DESIGN = { ...badge.design, elements: [...badge.design.elements, { id: 'logo', type: 'image', x: 0.06, y: 0.82, width: 0.4, height: 0.14, rotation: 0, visible: true, locked: false, zIndex: 50, properties: { text: '{{custom.eventLogo}}', fit: 'contain' } }] } as unknown as Rec
    LOGO_URL = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_STORAGE_BUCKET}/o/${encodeURIComponent(`event-assets/${OWNER}/${EV}/logo/logo.png`)}?alt=media&token=test`

    for (const uid of [OWNER, OTHER, ADMIN, MANAGER, FINANCE, GATE]) {
      await adminAuth.deleteUser(uid).catch(() => null)
      await adminAuth.createUser({ uid, email: email(uid), password: PW, emailVerified: true })
    }
    for (const uid of [OWNER, OTHER]) await adminDb.doc(`users/${uid}`).set({ uid, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    for (const [uid, role] of [[ADMIN, 'admin'], [MANAGER, 'manager'], [FINANCE, 'finance'], [GATE, 'checkin_staff']] as const) {
      await adminDb.doc(`teamMembers/${P}-m-${uid}`).set({ organizerUid: OWNER, memberUid: uid, email: email(uid), role, permissions: permissionsForRole(role), eventIds: [], status: 'active', createdAt: new Date(), updatedAt: new Date() })
    }
    const ev = { eventType: 'expo', eventDetails: { seo: { urlSlug: EV }, info: { name: 'Global Trade Expo 2026' }, media: { logo: { value: LOGO_URL } } } }
    await adminDb.doc(`users/${OWNER}/eventDrafts/${EV}`).set({ status: 'published', ...ev })
    await adminDb.doc(`events/${EV}`).set({ uid: OWNER, draftId: EV, slug: EV, lifecycleStatus: 'published', ...ev })
    const b = adminDb.batch()
    for (let i = 0; i < N; i++) {
      b.set(adminDb.doc(`registrations/${rid(i)}`), {
        organizerUid: OWNER, eventSlug: EV, eventName: 'Global Trade Expo 2026', status: 'confirmed', paymentStatus: 'paid',
        passId: 'p1', passName: 'Exhibitor', ticketCode: `RD-${P}-T${i}`, ticket: { qrValue: `RD:${EV}:${rid(i)}:RD-${P}-T${i}` },
        companyName: 'Sundaram Exports Private Limited', attendee: { name: `Holder ${String(i).padStart(3, '0')}`, email: `h${i}.${P}@example.test`, phone: '+919876543210' },
      })
    }
    await b.commit()
    for (const uid of [OWNER, OTHER, ADMIN, MANAGER, FINANCE, GATE]) tok[uid] = await signIn(email(uid))

    const base = '@/app/api/organizer'
    R.list     = await import(`${base}/print-templates/route`) as unknown as Record<string, Handler>
    R.one      = await import(`${base}/print-templates/[id]/route`) as unknown as Record<string, Handler>
    R.design   = await import(`${base}/print-templates/[id]/design/route`) as unknown as Record<string, Handler>
    R.jobs     = await import(`${base}/print-jobs/route`) as unknown as Record<string, Handler>
    R.plan     = await import(`${base}/print-jobs/[jobId]/runs/route`) as unknown as Record<string, Handler>
    R.run      = await import(`${base}/print-runs/[runId]/route`) as unknown as Record<string, Handler>
    R.batch    = await import(`${base}/print-runs/[runId]/batches/[index]/route`) as unknown as Record<string, Handler>
    R.complete = await import(`${base}/print-runs/[runId]/complete/route`) as unknown as Record<string, Handler>
    R.fail     = await import(`${base}/print-runs/[runId]/fail/route`) as unknown as Record<string, Handler>

    templateId = await createTemplate('Exhibitor Badge', { preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait' })
    jobId = await runJob(templateId)
  }, T)

  afterAll(async () => {
    for (const d of (await adminDb.collection('printRuns').where('eventId', '==', EV).get()).docs) await d.ref.delete()
    for (const id of jobs) await adminDb.recursiveDelete(adminDb.doc(`printGenerationJobs/${id}`)).catch(() => null)
    for (const d of (await adminDb.collection('printTemplateVersions').where('eventId', '==', EV).get()).docs) await d.ref.delete()
    for (const id of templates) await adminDb.doc(`printTemplates/${id}`).delete().catch(() => null)
    for (const d of (await adminDb.collection('registrations').where('eventSlug', '==', EV).get()).docs) await d.ref.delete()
    for (const uid of [ADMIN, MANAGER, FINANCE, GATE]) await adminDb.doc(`teamMembers/${P}-m-${uid}`).delete().catch(() => null)
    for (const uid of [OWNER, OTHER]) await adminDb.recursiveDelete(adminDb.doc(`users/${uid}`)).catch(() => null)
    await adminDb.doc(`events/${EV}`).delete().catch(() => null)
    for (const uid of [OWNER, OTHER, ADMIN, MANAGER, FINANCE, GATE]) await adminAuth.deleteUser(uid).catch(() => null)
  }, T)

  it('several sheet-aligned batches merge into ONE PDF: every eligible card exactly once, in the frozen order', async () => {
    const p = await plan({ sheet: { paper: 'A4', marginMm: 10, gapMm: 4, cropMarks: true }, batchCards: 9 })
    expect(p.status).toBe(201)
    const run = p.body.run as Rec
    expect(run).toMatchObject({ status: 'planned', cardCount: N, perSheet: 9, batchSize: 9, batchCount: 4, sheets: 4, skippedCount: 0 })
    const merged = await PDFDocument.load(await merge(await fetchAll(run), run as never))
    expect(merged.getPageCount()).toBe(4)
    const names = await printedNames(merged)
    expect(names).toEqual(Array.from({ length: N }, (_, i) => String(i).padStart(3, '0')))   // all, once, in order
    const done = await call('complete', 'POST', req('/x', tok[OWNER], 'POST', { pageCount: 4 }), { runId: run.runId as string })
    expect(done.status).toBe(200)
    expect(((await done.json()) as { run: Rec }).run).toMatchObject({ status: 'completed', renderedBatches: [0, 1, 2, 3] })
    // Idempotent completion.
    expect((await call('complete', 'POST', req('/x', tok[OWNER], 'POST', { pageCount: 4 }), { runId: run.runId as string })).status).toBe(200)

    // History is METADATA ONLY; nothing stored in Storage.
    const doc = (await adminDb.doc(`printRuns/${run.runId}`).get()).data() as Rec
    expect(doc).toMatchObject({ templateVersion: 1, cardCount: N, status: 'completed' })
    expect(JSON.stringify(doc)).not.toMatch(/Holder|@example\.test|\+919876|RD-prp3|firebasestorage|token=/)
    expect((await bucket.getFiles({ prefix: `printAssets/${OWNER}/` }))[0]).toEqual([])
    expect((await bucket.getFiles({ prefix: `printPackages/${OWNER}/` }))[0]).toEqual([])
  }, T)

  it('a duplicate submission returns the SAME run; retrying a batch is safe', async () => {
    const body = { requestId: `dup-${P}`, sheet: { paper: 'A3' } }
    const a = await call('plan', 'POST', req('/x', tok[OWNER], 'POST', body), { jobId })
    const b = await call('plan', 'POST', req('/x', tok[OWNER], 'POST', body), { jobId })
    expect([a.status, b.status]).toEqual([201, 200])
    const ra = ((await a.json()) as { run: Rec }).run, rb = ((await b.json()) as { run: Rec }).run
    expect(rb.runId).toBe(ra.runId)
    expect((await adminDb.collection('printRuns').where('jobId', '==', jobId).where('sheet.paper', '==', 'A3').get()).size).toBe(1)
    const one = await batch(ra.runId as string, 0), two = await batch(ra.runId as string, 0)
    expect([one.status, two.status]).toEqual([200, 200])
    expect(two.headers.get('x-print-card-count')).toBe(one.headers.get('x-print-card-count'))
    expect(((await adminDb.doc(`printRuns/${ra.runId}`).get()).data() as Rec).renderedBatches).toEqual([0])
  }, T)

  it('completion is refused until every batch rendered and the page count matches', async () => {
    const run = (await plan({ batchCards: 9 })).body.run as Rec
    const id = run.runId as string
    expect((await batch(id, 0)).status).toBe(200)
    const early = await call('complete', 'POST', req('/x', tok[OWNER], 'POST', { pageCount: 4 }), { runId: id })
    expect(early.status).toBe(409)
    expect(await early.json()).toMatchObject({ code: 'INCOMPLETE' })
    for (let i = 1; i < 4; i++) await batch(id, i)
    expect(await (await call('complete', 'POST', req('/x', tok[OWNER], 'POST', { pageCount: 3 }), { runId: id })).json()).toMatchObject({ code: 'PAGE_COUNT_MISMATCH' })
    expect((await batch(id, 4)).status).toBe(404)                                  // no such batch
  }, T)

  it('missing, foreign and refunded selections are reported as skipped at planning', async () => {
    await adminDb.doc(`registrations/${rid(5)}`).update({ paymentStatus: 'refunded' })
    try {
      const p = await plan({ registrationIds: [rid(4), rid(5), rid(6), 'not-a-card'] })
      const run = p.body.run as Rec
      expect(run).toMatchObject({ cardCount: 2, skippedCount: 2 })
      expect((run.skipped as Rec[]).map(s => s.registrationId).sort()).toEqual(['not-a-card', rid(5)].sort())
      const merged = await PDFDocument.load(await merge(await fetchAll(run), run as never))
      expect(await printedNames(merged)).toEqual(['004', '006'])
    } finally {
      await adminDb.doc(`registrations/${rid(5)}`).update({ paymentStatus: 'paid' })
    }
  }, T)

  it('PARTIAL FAILURE: a registration refunded after planning fails its batch and the run — no partial PDF', async () => {
    const run = (await plan({ batchCards: 9 })).body.run as Rec
    const id = run.runId as string
    expect((await batch(id, 0)).status).toBe(200)
    await adminDb.doc(`registrations/${rid(12)}`).update({ paymentStatus: 'refunded' })           // in batch 1 (cards 9–17)
    try {
      const failed = await batch(id, 1)
      expect(failed.status).toBe(409)
      expect(await failed.json()).toMatchObject({ code: 'REGISTRATION_CHANGED', registrationIds: [rid(12)] })
      expect(((await adminDb.doc(`printRuns/${id}`).get()).data() as Rec)).toMatchObject({ status: 'failed', errorCode: 'REGISTRATION_CHANGED' })
      expect(await (await batch(id, 2)).json()).toMatchObject({ code: 'RUN_FAILED' })
      expect(await (await call('complete', 'POST', req('/x', tok[OWNER], 'POST', { pageCount: 4 }), { runId: id })).json()).toMatchObject({ code: 'RUN_FAILED' })
      // And the browser merge refuses anything short of every batch.
      await expect(merge([new ArrayBuffer(0)], run as never)).rejects.toMatchObject({ code: 'INCOMPLETE' })
    } finally {
      await adminDb.doc(`registrations/${rid(12)}`).update({ paymentStatus: 'paid' })
    }
    // A client-reported failure is recorded as metadata, idempotently.
    const other = (await plan({})).body.run as Rec
    const f = await call('fail', 'POST', req('/x', tok[OWNER], 'POST', { reason: 'Batch 2 failed after retries' }), { runId: other.runId as string })
    expect(((await f.json()) as { run: Rec }).run).toMatchObject({ status: 'failed', errorCode: 'CLIENT_ABORTED' })
  }, T)

  it('the run renders its PINNED version even after the template is re-sized', async () => {
    const run = (await plan({ batchCards: 9 })).body.run as Rec
    expect((await call('one', 'PATCH', req('/x', tok[OWNER], 'PATCH', { canvas: { preset: 'A6', width: 105, height: 148, unit: 'mm', orientation: 'portrait' } }), { id: templateId })).status).toBe(200)
    const r = await batch(run.runId as string, 0)
    expect(r.status).toBe(200)
    const pdf = await PDFDocument.load(new Uint8Array(await r.arrayBuffer()))
    expect(pdf.getPageCount()).toBe(1)
    expect(r.headers.get('x-print-card-count')).toBe('9')                          // still 9 CR80 per sheet
  }, T)

  it('refused before rendering: oversize selection, too-dense sheet, unpinned job, bad request id', async () => {
    const many = await plan({ registrationIds: Array.from({ length: 5001 }, (_, i) => `x${i}`) })
    expect([many.status, many.body.code]).toEqual([413, 'TOO_MANY_CARDS'])
    const tiny = await createTemplate('Tiny tag', { preset: 'CUSTOM', width: 10, height: 10, unit: 'mm', orientation: 'portrait' })
    const tinyJob = await runJob(tiny)
    const dense = await plan({ sheet: { paper: 'A3', marginMm: 0, gapMm: 0 } }, tok[OWNER], tinyJob)
    expect([dense.status, dense.body.code]).toEqual([422, 'SHEET_TOO_DENSE'])
    const legacy = `pgen_${P}-legacy`
    jobs.push(legacy)
    await adminDb.doc(`printGenerationJobs/${legacy}`).set({ jobId: legacy, status: 'completed', organizerUid: OWNER, templateId, eventId: EV, eventSlug: EV, eventName: 'x', assetType: 'ID_CARD', filters: {}, counts: {} })
    const unpinned = await plan({}, tok[OWNER], legacy)
    expect([unpinned.status, unpinned.body.code]).toEqual([409, 'JOB_NOT_PINNED'])
    const badId = await call('plan', 'POST', req('/x', tok[OWNER], 'POST', { requestId: 'x' }), { jobId })
    expect(badId.status).toBe(400)
  }, T)

  it('text-overflow WARNINGS are reported and the design is not changed', async () => {
    const d = JSON.parse(JSON.stringify(DESIGN)) as { elements: Rec[] }
    const nameEl = d.elements.find(e => String((e.properties as Rec).text ?? '').includes('{{name}}'))!
    nameEl.width = 0.05                                                              // a box far too narrow for any name
    const id = await createTemplate('Overflowing', { preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait' }, d as unknown as Rec)
    const job = await runJob(id)
    const versionBefore = JSON.stringify(((await adminDb.doc(`printTemplateVersions/${id}_v1`).get()).data() as Rec).design)
    const p = await plan({}, tok[OWNER], job)
    expect((p.body.run as Rec).overflowCount).toBe(N)
    expect(((p.body.run as Rec).overflow as Rec[])[0]).toMatchObject({ elementId: nameEl.id })
    expect(JSON.stringify(((await adminDb.doc(`printTemplateVersions/${id}_v1`).get()).data() as Rec).design)).toBe(versionBefore)
  }, T)

  it('authorization: manager / finance / gate 403 everywhere; another workspace 404; query token 401; admin allowed', async () => {
    const run = (await plan({})).body.run as Rec
    const id = run.runId as string
    for (const uid of [MANAGER, FINANCE, GATE]) {
      const t = tok[uid]
      for (const [name, p] of [
        ['plan',     call('plan', 'POST', req('/x', t, 'POST', { requestId: nextRequestId() }), { jobId })],
        ['get',      call('run', 'GET', req('/x', t), { runId: id })],
        ['batch',    batch(id, 0, t)],
        ['complete', call('complete', 'POST', req('/x', t, 'POST', { pageCount: 1 }), { runId: id })],
        ['fail',     call('fail', 'POST', req('/x', t, 'POST', {}), { runId: id })],
      ] as Array<[string, Promise<Response>]>) expect((await p).status, `${uid} → ${name}`).toBe(403)
    }
    const t = tok[OTHER]
    for (const [name, p] of [
      ['plan',     call('plan', 'POST', req('/x', t, 'POST', { requestId: nextRequestId() }), { jobId })],
      ['get',      call('run', 'GET', req('/x', t), { runId: id })],
      ['batch',    batch(id, 0, t)],
      ['complete', call('complete', 'POST', req('/x', t, 'POST', { pageCount: 1 }), { runId: id })],
      ['fail',     call('fail', 'POST', req('/x', t, 'POST', {}), { runId: id })],
    ] as Array<[string, Promise<Response>]>) expect((await p).status, `other → ${name}`).toBe(404)
    expect(((await adminDb.doc(`printRuns/${id}`).get()).data() as Rec).status).toBe('planned')   // untouched by them
    expect((await call('batch', 'POST', req(`/x?token=${encodeURIComponent(tok[OWNER])}`, null, 'POST', {}), { runId: id, index: '0' })).status).toBe(401)
    expect((await call('run', 'GET', req('/x', tok[ADMIN]), { runId: id })).status).toBe(200)
  }, T)

  // ─── RD-PRINT-P4 · reliability ────────────────────────────────────────────────────

  const backdate = async (runId: string, msAgo: number) => {
    const { Timestamp } = await import('firebase-admin/firestore')
    const t = Timestamp.fromMillis(Date.now() - msAgo)
    await adminDb.doc(`printRuns/${runId}`).update({ createdAt: t, updatedAt: t })
  }
  const DAY = 24 * 60 * 60 * 1000

  it('P4 · a job still generating is refused; not-generated and failed cards are REPORTED as skipped', async () => {
    const busy = `pgen_${P}-busy`
    jobs.push(busy)
    const live = (await adminDb.doc(`printGenerationJobs/${jobId}`).get()).data() as Rec
    await adminDb.doc(`printGenerationJobs/${busy}`).set({ ...live, jobId: busy, status: 'processing' })
    const refused = await plan({}, tok[OWNER], busy)
    expect([refused.status, refused.body.code]).toEqual([409, 'JOB_IN_PROGRESS'])

    await adminDb.doc(`printGenerationJobs/${jobId}/items/${rid(7)}`).update({ rendered: false, error: 'Font could not be loaded' })
    await adminDb.doc(`printGenerationJobs/${jobId}/items/${rid(8)}`).update({ rendered: false, error: null })
    try {
      const run = (await plan({})).body.run as Rec
      expect(run).toMatchObject({ cardCount: N - 2, skippedCount: 2 })
      const reasons = Object.fromEntries((run.skipped as Rec[]).map(s => [s.registrationId, s.reason]))
      expect(reasons[rid(7)]).toContain('could not be generated')
      expect(reasons[rid(8)]).toBe('Card has not been generated')
    } finally {
      await adminDb.doc(`printGenerationJobs/${jobId}/items/${rid(7)}`).update({ rendered: true, error: null })
      await adminDb.doc(`printGenerationJobs/${jobId}/items/${rid(8)}`).update({ rendered: true, error: null })
    }
  }, T)

  it('P4 · an ABANDONED planned run expires on next access; batches and completion are refused', async () => {
    const run = (await plan({ batchCards: 9 })).body.run as Rec
    const id = run.runId as string
    expect((await batch(id, 0)).status).toBe(200)
    await backdate(id, DAY + 60_000)
    const got = await (await call('run', 'GET', req('/x', tok[OWNER]), { runId: id })).json() as { run: Rec }
    expect(got.run).toMatchObject({ status: 'expired', errorCode: 'ABANDONED', statusLabel: 'Abandoned — nothing downloaded' })
    expect(await (await batch(id, 1)).json()).toMatchObject({ code: 'RUN_EXPIRED' })
    expect(await (await call('complete', 'POST', req('/x', tok[OWNER], 'POST', { pageCount: 4 }), { runId: id })).json()).toMatchObject({ code: 'RUN_EXPIRED' })
    const f = await call('fail', 'POST', req('/x', tok[OWNER], 'POST', { reason: 'late' }), { runId: id })
    expect(((await f.json()) as { run: Rec }).run.status).toBe('expired')          // terminal: unchanged
  }, T)

  it('P4 · the reconciliation expires ONLY stale planned runs and changes nothing else (registrations, jobs, templates, versions, Storage)', async () => {
    const mk = async (batchCards?: number) => ((await plan(batchCards ? { batchCards } : {})).body.run as Rec).runId as string
    const staleA = await mk(), staleB = await mk(), fresh = await mk()
    // doneOld: completed (4 batches), then made old — completed runs are never touched.
    const doneOld = await mk(9)
    for (let i = 0; i < 4; i++) expect((await batch(doneOld, i)).status).toBe(200)
    const done = await call('complete', 'POST', req('/x', tok[OWNER], 'POST', { pageCount: ((await adminDb.doc(`printRuns/${doneOld}`).get()).data() as Rec).sheets }), { runId: doneOld })
    expect(done.status).toBe(200)
    for (const id of [staleA, staleB, doneOld]) await backdate(id, 2 * DAY)

    const snapshot = async () => JSON.stringify({
      regs:  (await adminDb.collection('registrations').where('eventSlug', '==', EV).get()).docs.map(x => [x.id, x.data()]),
      job:   (await adminDb.doc(`printGenerationJobs/${jobId}`).get()).data(),
      items: (await adminDb.collection(`printGenerationJobs/${jobId}/items`).get()).docs.map(x => [x.id, x.data()]),
      tpls:  (await adminDb.collection('printTemplates').where('eventId', '==', EV).get()).docs.map(x => [x.id, x.data()]),
      vers:  (await adminDb.collection('printTemplateVersions').where('eventId', '==', EV).get()).docs.map(x => [x.id, x.data()]),
    })
    const before = await snapshot()
    const { reconcileStalePrintRuns } = await import('@/lib/printAssets/runs/service')
    const result = await reconcileStalePrintRuns()
    expect(result.expired).toBeGreaterThanOrEqual(2)
    const status = async (id: string) => ((await adminDb.doc(`printRuns/${id}`).get()).data() as Rec)
    expect(await status(staleA)).toMatchObject({ status: 'expired', errorCode: 'ABANDONED' })
    expect(await status(staleB)).toMatchObject({ status: 'expired', errorCode: 'ABANDONED' })
    expect((await status(fresh)).status).toBe('planned')
    expect((await status(doneOld)).status).toBe('completed')
    // The LAZY path too: reading an old COMPLETED run (or an old failed one) never expires it.
    const viaApi = await (await call('run', 'GET', req('/x', tok[OWNER]), { runId: doneOld })).json() as { run: Rec }
    expect(viaApi.run).toMatchObject({ status: 'completed', statusLabel: 'Downloaded' })
    expect((await status(doneOld)).status).toBe('completed')
    expect(await snapshot()).toBe(before)                                            // nothing else changed
    expect((await bucket.getFiles({ prefix: `printAssets/${OWNER}/` }))[0]).toEqual([])
    // Idempotent: a second sweep changes nothing more for these runs.
    await reconcileStalePrintRuns()
    expect((await status(fresh)).status).toBe('planned')
  }, T)

  it('P4 · concurrent duplicate submissions create ONE run; concurrent completions agree', async () => {
    const body = { requestId: `race-${P}`, batchCards: 9 }
    const results = await Promise.all([0, 1, 2].map(() => call('plan', 'POST', req('/x', tok[OWNER], 'POST', body), { jobId })))
    const runs = await Promise.all(results.map(async r => ({ status: r.status, run: ((await r.json()) as { run: Rec }).run })))
    expect(new Set(runs.map(r => r.run.runId)).size).toBe(1)
    expect(runs.filter(r => r.status === 201).length).toBe(1)
    const id = runs[0].run.runId as string
    for (let i = 0; i < 4; i++) expect((await batch(id, i)).status).toBe(200)
    const both = await Promise.all([0, 1].map(() => call('complete', 'POST', req('/x', tok[OWNER], 'POST', { pageCount: 4 }), { runId: id })))
    expect(both.map(r => r.status)).toEqual([200, 200])
    expect(((await adminDb.doc(`printRuns/${id}`).get()).data() as Rec)).toMatchObject({ status: 'completed', renderedBatches: expect.arrayContaining([0, 1, 2, 3]) })
  }, T)

  it('P4 · history lists the job\'s runs newest first with clear status; certificates + ownership enforced', async () => {
    const res = await call('plan', 'GET', req('/x', tok[OWNER]), { jobId })
    expect(res.status).toBe(200)
    const runs = ((await res.json()) as { runs: Rec[] }).runs
    expect(runs.length).toBeGreaterThan(3)
    const created = runs.map(r => Date.parse(String(r.createdAt)))
    expect([...created].sort((a, b) => b - a)).toEqual(created)
    for (const r of runs) expect(typeof r.statusLabel).toBe('string')
    expect(JSON.stringify(runs)).not.toMatch(/Holder|@example\.test|firebasestorage|token=/)
    for (const uid of [MANAGER, FINANCE, GATE]) expect((await call('plan', 'GET', req('/x', tok[uid]), { jobId })).status, uid).toBe(403)
    expect((await call('plan', 'GET', req('/x', tok[OTHER]), { jobId })).status).toBe(404)
  }, T)
})
