// RD-PRINT-AUDIT — the four final-audit fixes and the error-history hardening, on REAL
// Firestore, the REAL Storage emulator and REAL Auth-emulator ID tokens, through the real
// routes. Stubbed: Next's `after()`, the logo bytes fetch, and — for the hardening test only —
// the renderer throwing an error whose text contains an attendee's name.
//
//   1. a legacy template whose stored size predates today's limits can still be renamed /
//      re-statused (metadata-only PATCH), and that creates no version; a real size change is
//      still validated;
//   2. regenerating a job's cards uses the job's PINNED version — after the template is
//      re-sized, archived and even deleted;
//   3. a completed run refuses further batches and can never be turned into "failed" — not by a
//      stale batch after a refund, not by a concurrent fail, not by a racing terminal batch;
//   4. completion is checked against the merged PDF's ACTUAL page count — a wrong count is refused;
//   H. no exception text (which could quote attendee data) is stored in item or run history,
//      and a client's free-text failure reason is not stored either.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import zlib from 'node:zlib'
import { PDFDocument } from 'pdf-lib'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = `prfx-${process.pid}`
const OWNER = `${P}-owner`
const EV = `${P}-ev`
const PW = 'PrintFixPassw0rd!'
const N = 20
const rid = (i: number) => `${P}-r${String(i).padStart(3, '0')}`
const MM = 72 / 25.4
const SECRET_NAME = 'Zxqv Explode-Sentinel'          // a name that must never reach stored history

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
// Hardening only: a renderer error whose text quotes the attendee's name (as a font/PDF library might).
vi.mock('@/lib/printAssets/render', async (orig) => {
  const real = await orig<typeof import('@/lib/printAssets/render')>()
  const named = (v: unknown) => JSON.stringify(v ?? '').includes('Explode-Sentinel')
  return {
    ...real,
    renderToPdf: async (input: Parameters<typeof real.renderToPdf>[0]) => {
      if (named(input.variables)) throw new Error(`WinAnsi cannot encode "${SECRET_NAME}"`)
      return real.renderToPdf(input)
    },
    renderSheetsToPdf: async (input: Parameters<typeof real.renderSheetsToPdf>[0]) => {
      if (named(input.cards)) throw new Error(`WinAnsi cannot encode "${SECRET_NAME}"`)
      return real.renderSheetsToPdf(input)
    },
  }
})

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

describeEmu('RD-PRINT-AUDIT · final-audit fixes (real Auth, Firestore, Storage)', () => {
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let gen: typeof import('@/lib/printAssets/generationJob')
  let token = ''
  const R: Record<string, Record<string, Handler>> = {}
  const templates: string[] = [], jobs: string[] = []
  let DESIGN: Rec, LOGO_URL = ''
  let reqN = 0

  const call = (name: string, method: string, r: NextRequest, p?: Record<string, string>) => R[name][method](r, p ? ctx(p) : undefined)
  const json = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) as Rec })
  const createTemplate = async (name: string, canvas: Rec) => {
    const c = await call('list', 'POST', req('/x', token, 'POST', { eventId: EV, name, assetType: 'ID_CARD', canvas }))
    expect(c.status).toBe(201)
    const id = ((await c.json()) as { template: Rec }).template.id as string
    templates.push(id)
    expect((await call('design', 'PUT', req('/x', token, 'PUT', { design: DESIGN }), { id })).status).toBe(200)
    return id
  }
  const drive = async (jobId: string) => { for (let i = 0; i < 10; i++) if ((await gen.processPrintGenerationChunk(jobId)).status === 'completed') break }
  const runJob = async (tid: string) => {
    const c = await call('jobs', 'POST', req('/x', token, 'POST', { templateId: tid }))
    expect(c.status).toBe(201)
    const id = ((await c.json()) as { jobId: string }).jobId
    jobs.push(id)
    await drive(id)
    return id
  }
  const pageSize = async (jobId: string, registrationId: string) => {
    const res = await call('itemDl', 'GET', req('/x', token), { jobId, registrationId })
    expect(res.status, res.status === 200 ? '' : await res.clone().text()).toBe(200)
    const p = (await PDFDocument.load(new Uint8Array(await res.arrayBuffer()))).getPage(0).getSize()
    return { w: Math.round(p.width), h: Math.round(p.height) }
  }
  const plan = async (jobId: string, body: Rec = {}) =>
    ((await json(await call('plan', 'POST', req('/x', token, 'POST', { requestId: `fx-${P}-${++reqN}`, ...body }), { jobId }))).body.run as Rec)
  const batch = (runId: string, i: number) => call('batch', 'POST', req('/x', token, 'POST', {}), { runId, index: String(i) })
  const complete = (runId: string, pageCount: unknown) => call('complete', 'POST', req('/x', token, 'POST', { pageCount }), { runId })
  const runDoc = async (id: string) => (await adminDb.doc(`printRuns/${id}`).get()).data() as Rec

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const admin = await import('@/lib/firebase/admin')
    adminAuth = admin.adminAuth; adminDb = admin.adminDb
    const { FIREBASE_STORAGE_BUCKET } = await import('@/lib/env')
    gen = await import('@/lib/printAssets/generationJob')
    const { PRINT_COLLECTIONS } = await import('@/lib/printAssets/collections')
    const badge = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge')!
    DESIGN = { ...badge.design, elements: [...badge.design.elements, { id: 'logo', type: 'image', x: 0.06, y: 0.82, width: 0.4, height: 0.14, rotation: 0, visible: true, locked: false, zIndex: 50, properties: { text: '{{custom.eventLogo}}', fit: 'contain' } }] } as unknown as Rec
    LOGO_URL = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_STORAGE_BUCKET}/o/${encodeURIComponent(`event-assets/${OWNER}/${EV}/logo/logo.png`)}?alt=media&token=test`

    await adminAuth.deleteUser(OWNER).catch(() => null)
    await adminAuth.createUser({ uid: OWNER, email: `${OWNER}@registerdesk.test`, password: PW, emailVerified: true })
    await adminDb.doc(`users/${OWNER}`).set({ uid: OWNER, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    const ev = { eventType: 'workshop', eventDetails: { seo: { urlSlug: EV }, info: { name: 'Design Workshop 2026' }, media: { logo: { value: LOGO_URL } } } }
    await adminDb.doc(`users/${OWNER}/eventDrafts/${EV}`).set({ status: 'published', ...ev })
    await adminDb.doc(`events/${EV}`).set({ uid: OWNER, draftId: EV, slug: EV, lifecycleStatus: 'published', ...ev })
    const b = adminDb.batch()
    for (let i = 0; i < N; i++) {
      b.set(adminDb.doc(`registrations/${rid(i)}`), {
        organizerUid: OWNER, eventSlug: EV, eventName: 'Design Workshop 2026', status: 'confirmed', paymentStatus: 'paid',
        passId: 'p1', passName: 'Participant', ticketCode: `RD-${P}-T${i}`, ticket: { qrValue: `RD:${EV}:${rid(i)}:RD-${P}-T${i}` },
        attendee: { name: `Participant ${String(i).padStart(3, '0')}`, email: `p${i}.${P}@example.test` },
      })
    }
    await b.commit()
    token = await signIn(`${OWNER}@registerdesk.test`)

    const base = '@/app/api/organizer'
    R.list     = await import(`${base}/print-templates/route`) as unknown as Record<string, Handler>
    R.one      = await import(`${base}/print-templates/[id]/route`) as unknown as Record<string, Handler>
    R.design   = await import(`${base}/print-templates/[id]/design/route`) as unknown as Record<string, Handler>
    R.jobs     = await import(`${base}/print-jobs/route`) as unknown as Record<string, Handler>
    R.retry    = await import(`${base}/print-jobs/[jobId]/retry/route`) as unknown as Record<string, Handler>
    R.itemDl   = await import(`${base}/print-jobs/[jobId]/items/[registrationId]/download/route`) as unknown as Record<string, Handler>
    R.plan     = await import(`${base}/print-jobs/[jobId]/runs/route`) as unknown as Record<string, Handler>
    R.batch    = await import(`${base}/print-runs/[runId]/batches/[index]/route`) as unknown as Record<string, Handler>
    R.complete = await import(`${base}/print-runs/[runId]/complete/route`) as unknown as Record<string, Handler>
    R.fail     = await import(`${base}/print-runs/[runId]/fail/route`) as unknown as Record<string, Handler>
  }, T)

  afterAll(async () => {
    for (const d of (await adminDb.collection('printRuns').where('eventId', '==', EV).get()).docs) await d.ref.delete()
    for (const id of jobs) await adminDb.recursiveDelete(adminDb.doc(`printGenerationJobs/${id}`)).catch(() => null)
    for (const d of (await adminDb.collection('printTemplateVersions').where('eventId', '==', EV).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('printTemplates').where('eventId', '==', EV).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('registrations').where('eventSlug', '==', EV).get()).docs) await d.ref.delete()
    await adminDb.recursiveDelete(adminDb.doc(`users/${OWNER}`)).catch(() => null)
    await adminDb.doc(`events/${EV}`).delete().catch(() => null)
    await adminAuth.deleteUser(OWNER).catch(() => null)
  }, T)

  it('FIX 1 · a legacy template with an out-of-range size can be renamed and re-statused; no version is created; a real size change is still validated', async () => {
    const ref = adminDb.collection('printTemplates').doc()
    templates.push(ref.id)
    const legacyCanvas = { preset: 'CUSTOM', width: 2000, height: 3000, unit: 'px', orientation: 'portrait' }   // ~529 × 794 mm: beyond A3
    await ref.set({ eventId: EV, organizerUid: OWNER, createdBy: OWNER, name: 'Old poster', description: '', assetType: 'CUSTOM',
      status: 'draft', canvas: legacyCanvas, createdAt: new Date(), updatedAt: new Date() })
    // What the edit form now sends when the size is unchanged: metadata only.
    const renamed = await json(await call('one', 'PATCH', req('/x', token, 'PATCH', { name: 'Old poster (renamed)', description: 'kept', assetType: 'CUSTOM', status: 'published' }), { id: ref.id }))
    expect(renamed.status).toBe(200)
    expect(renamed.body.template).toMatchObject({ name: 'Old poster (renamed)', status: 'published', canvas: legacyCanvas })
    expect((await adminDb.collection('printTemplateVersions').where('templateId', '==', ref.id).get()).size).toBe(0)   // no "resize" version
    // Re-sending that out-of-range size (an actual size edit) is still refused.
    const resize = await call('one', 'PATCH', req('/x', token, 'PATCH', { name: 'x', canvas: legacyCanvas }), { id: ref.id })
    expect(resize.status).toBe(400)
  }, T)

  it('FIX 2 · regenerate uses the job\'s PINNED version after the template is re-sized, archived and deleted', async () => {
    const id = await createTemplate('Pinned badge', { preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait' })
    const jobId = await runJob(id)
    const cr80 = { w: Math.round(54 * MM), h: Math.round(85.6 * MM) }
    expect(await pageSize(jobId, rid(0))).toEqual(cr80)

    expect((await call('one', 'PATCH', req('/x', token, 'PATCH', { canvas: { preset: 'A6', width: 105, height: 148, unit: 'mm', orientation: 'portrait' } }), { id })).status).toBe(200)
    expect((await call('one', 'PATCH', req('/x', token, 'PATCH', { status: 'archived' }), { id })).status).toBe(200)
    // Exactly what "Regenerate selected" now calls.
    const regen = await json(await call('retry', 'POST', req('/x', token, 'POST', { mode: 'regenerate', registrationIds: [rid(0), rid(1)] }), { jobId }))
    expect(regen.status).toBe(200)
    await drive(jobId)
    expect(await pageSize(jobId, rid(0))).toEqual(cr80)                         // pinned CR80, not the new A6
    expect(await pageSize(jobId, rid(1))).toEqual(cr80)

    expect((await call('one', 'DELETE', req('/x', token, 'DELETE'), { id })).status).toBe(200)
    const again = await json(await call('retry', 'POST', req('/x', token, 'POST', { mode: 'regenerate', registrationIds: [rid(2)] }), { jobId }))
    expect(again.status).toBe(200)
    await drive(jobId)
    expect(await pageSize(jobId, rid(2))).toEqual(cr80)
    // The path the old button used is refused for an archived/deleted template — which is why it was wrong.
    expect((await call('jobs', 'POST', req('/x', token, 'POST', { templateId: id }))).status).toBe(404)
  }, T)

  describe('runs (FIX 3, FIX 4)', () => {
    let jobId = ''
    beforeAll(async () => {
      jobId = await runJob(await createTemplate('Run badge', { preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait' }))
    }, T)
    const renderAll = async (run: Rec) => {
      for (let i = 0; i < (run.batchCount as number); i++) expect((await batch(run.runId as string, i)).status).toBe(200)
    }

    it('FIX 4 · completion is checked against the ACTUAL merged page count: wrong, missing or non-numeric counts are refused', async () => {
      const run = await plan(jobId, { batchCards: 9 })                           // 20 cards → 3 sheets, 3 batches
      expect(run.sheets).toBe(3)
      await renderAll(run)
      for (const wrong of [2, 4, '3', null, undefined]) {
        const r = await json(await complete(run.runId as string, wrong))
        expect(r.status, String(wrong)).toBe(409)
        expect(r.body.code).toBe('PAGE_COUNT_MISMATCH')
      }
      expect((await runDoc(run.runId as string)).status).toBe('planned')
      expect((await complete(run.runId as string, 3)).status).toBe(200)
    }, T)

    it('FIX 3 · a COMPLETED run refuses further batches and stays completed — even after a refund makes the batch invalid', async () => {
      const run = await plan(jobId, { batchCards: 9 })
      await renderAll(run)
      expect((await complete(run.runId as string, run.sheets)).status).toBe(200)
      const stale = await json(await batch(run.runId as string, 0))
      expect([stale.status, stale.body.code]).toEqual([409, 'RUN_COMPLETED'])
      await adminDb.doc(`registrations/${rid(1)}`).update({ paymentStatus: 'refunded' })
      try {
        const replay = await json(await batch(run.runId as string, 0))
        expect([replay.status, replay.body.code]).toEqual([409, 'RUN_COMPLETED'])
        expect(await runDoc(run.runId as string)).toMatchObject({ status: 'completed', errorCode: null })
        // A late client-reported failure cannot flip it either.
        expect(((await (await call('fail', 'POST', req('/x', token, 'POST', {}), { runId: run.runId as string })).json()) as { run: Rec }).run.status).toBe('completed')
      } finally {
        await adminDb.doc(`registrations/${rid(1)}`).update({ paymentStatus: 'paid' })
      }
      expect((await runDoc(run.runId as string)).status).toBe('completed')
    }, T)

    it('FIX 3 · concurrent complete + fail: one wins, and every response agrees with the final state', async () => {
      for (let round = 0; round < 3; round++) {
        const run = await plan(jobId, { batchCards: 9 })
        await renderAll(run)
        const [c, f] = await Promise.all([complete(run.runId as string, run.sheets), call('fail', 'POST', req('/x', token, 'POST', {}), { runId: run.runId as string })])
        const final = (await runDoc(run.runId as string)).status
        const fRun = ((await f.json()) as { run: Rec }).run
        if (final === 'completed') {
          expect(c.status).toBe(200)
          expect(fRun.status).toBe('completed')                                    // fail saw it completed and changed nothing
        } else {
          expect(final).toBe('failed')
          expect(c.status).toBe(409)
        }
      }
    }, T)

    it('FIX 3 · a terminal batch failure racing completion never overwrites "completed"', async () => {
      for (let round = 0; round < 3; round++) {
        const run = await plan(jobId, { batchCards: 9 })
        await renderAll(run)
        await adminDb.doc(`registrations/${rid(0)}`).update({ paymentStatus: 'refunded' })   // batch 0 is now invalid
        try {
          const [c, b] = await Promise.all([complete(run.runId as string, run.sheets), batch(run.runId as string, 0)])
          const final = (await runDoc(run.runId as string)).status
          const bBody = (await b.json()) as { code?: string }
          if (c.status === 200) {
            expect(final).toBe('completed')                                        // the batch's failure write was refused
            expect(['RUN_COMPLETED', 'REGISTRATION_CHANGED']).toContain(bBody.code)
          } else {
            expect(final).toBe('failed')
            expect(bBody.code).toBe('REGISTRATION_CHANGED')
          }
        } finally {
          await adminDb.doc(`registrations/${rid(0)}`).update({ paymentStatus: 'paid' })
        }
      }
    }, T)
  })

  it('HARDENING · exception text (which could quote an attendee) is never stored; client free-text reasons are not stored', async () => {
    await adminDb.doc(`registrations/${rid(5)}`).update({ 'attendee.name': SECRET_NAME })
    try {
      const jobId = await runJob(await createTemplate('Hardening badge', { preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait' }))
      const item = (await adminDb.doc(`printGenerationJobs/${jobId}/items/${rid(5)}`).get()).data() as Rec
      expect(item).toMatchObject({ rendered: false, error: gen.CARD_RENDER_FAILED_MESSAGE })
      const job = (await adminDb.doc(`printGenerationJobs/${jobId}`).get()).data() as Rec
      // The download response does not leak it either.
      const dl = await call('itemDl', 'GET', req('/x', token), { jobId, registrationId: rid(5) })
      const dlText = await dl.text()
      // Plan a run over the job: rid(5) is skipped with a fixed reason; render the rest fine.
      const run = await plan(jobId, { batchCards: 9 })
      // Force a terminal RENDER_FAILED on a run whose cards include the sentinel name, via the sheets renderer.
      await adminDb.doc(`printGenerationJobs/${jobId}/items/${rid(5)}`).update({ rendered: true, error: null })
      const run2 = await plan(jobId, { batchCards: 9 })
      const failed = await json(await batch(run2.runId as string, 0))                // batch 0 holds rid(5)
      expect(failed.body.code).toBe('RENDER_FAILED')
      const fail = await call('fail', 'POST', req('/x', token, 'POST', { reason: `client says ${SECRET_NAME}` }), { runId: run.runId as string })
      expect(fail.status).toBe(200)
      const stored = JSON.stringify({ item, job, run: await runDoc(run.runId as string), run2: await runDoc(run2.runId as string), dl: dlText, failed: failed.body })
      expect(stored).not.toContain('Explode-Sentinel')
      expect(stored).not.toContain('WinAnsi')
      expect(await runDoc(run2.runId as string)).toMatchObject({ status: 'failed', errorCode: 'RENDER_FAILED' })
      expect(await runDoc(run.runId as string)).toMatchObject({ status: 'failed', errorCode: 'CLIENT_ABORTED' })
    } finally {
      await adminDb.doc(`registrations/${rid(5)}`).update({ 'attendee.name': 'Participant 005' })
    }
  }, T)
})
