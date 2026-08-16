// RD-CERT-2E — preview obeys the same rule as issuance, and storage source has no bearing on it.
//
// WHY PREVIEW MATTERS SPECIFICALLY. Preview is how the phantom participant name looked
// legitimate: an undesigned template previewed as the built-in default design, so the organizer
// saw a name-bearing certificate and reasonably concluded the template produced it. A preview
// that shows something issuance would never produce is worse than no preview.
//
// The second half pins that this rule is orthogonal to Phase 2D: a legacy Firebase `fileUrl`
// template and an R2 `fileKey` template must render byte-identically, because the guard sits
// downstream of source resolution and must not have acquired any dependence on it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import zlib from 'node:zlib'
import { PDFDocument } from 'pdf-lib'

type Doc = Record<string, unknown>

let template: Doc | null = null

const TEMPLATE_BYTES_MARKER = 'shared-template-bytes'

// ─── A real 4×4 PNG, identical whichever store it is served from ──────────────
function crc32(buf: Buffer): number {
  const t: number[] = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  let x = 0xFFFFFFFF
  for (const b of buf) x = t[(x ^ b) & 0xFF] ^ (x >>> 8)
  return (x ^ 0xFFFFFFFF) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const IHDR = Buffer.alloc(13)
IHDR.writeUInt32BE(4, 0); IHDR.writeUInt32BE(4, 4); IHDR[8] = 8; IHDR[9] = 2
const PIXELS = Buffer.concat(Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 0xEE)])))
const PNG = new Uint8Array(Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', IHDR), pngChunk('IDAT', zlib.deflateSync(PIXELS)), pngChunk('IEND', Buffer.alloc(0)),
]))

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { doc: () => ({ get: async () => ({ exists: true }) }), collection: () => ({}) },
  adminAuth: {},
}))
vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({ ok: true, workspaceUid: 'uid-1' }),
}))
vi.mock('@/lib/certificates/firestore', () => ({
  getTemplateById: async () => template,
}))

// Both stores hand back the SAME bytes, so any rendering difference would be the code's doing.
const reads = { r2: [] as string[], firebase: [] as string[] }
vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      download: async (key: string) => { reads.r2.push(key); return { body: PNG, contentType: 'image/png' } },
    },
  }
})
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async (url: string) => { reads.firebase.push(url); return PNG },
  validateEventTemplateUrl:  (url: string) => ({ ok: true, url }),
  validateGlobalTemplateUrl: (url: string) => ({ ok: true, url }),
}))

const { POST: PREVIEW } = await import(
  '@/app/api/organizer/events/[eventId]/certificates/templates/[templateId]/preview/route'
)
const { loadRenderAssets } = await import('@/lib/certificates/generate')
const { renderCertificatePdf } = await import('@/lib/certificates/render')

const CANVAS = { width: 800, height: 600 }
const DESIGNED = {
  version: 1, canvas: CANVAS,
  elements: [{
    id: 't1', type: 'text', content: '{{participantName}}', zIndex: 1, x: 0.1, y: 0.4, width: 0.8,
    fontFamily: 'helvetica', fontSizeFrac: 0.05, weight: 'normal', color: '#111111', align: 'center',
  }],
}

const KEY        = 'events/evt-1/certificates/templates/uid-1/tpl-1/design.png'
const LEGACY_URL = 'https://firebasestorage.googleapis.com/v0/b/x/o/design.png?alt=media'

const tpl = (over: Doc): Doc => ({
  templateId: 'tpl-1', eventId: 'evt-1', organizerUid: 'uid-1', name: TEMPLATE_BYTES_MARKER,
  templateType: 'png', fileName: 'design.png', fileSize: 10, dimensions: CANVAS, ...over,
})

function req(body: unknown) {
  return new Request('http://x/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  }) as never
}
const params = Promise.resolve({ eventId: 'evt-1', templateId: 'tpl-1' })

async function pageContent(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(0)
  // @ts-expect-error pdf-lib internals
  const contents = page.node.Contents()
  const refs = contents?.asArray ? contents.asArray() : [contents]
  let out = ''
  for (const ref of refs) {
    const obj = doc.context.lookup(ref) ?? ref
    // @ts-expect-error pdf-lib internals
    const raw = obj?.getContents?.()
    if (!raw) continue
    try { out += zlib.inflateSync(Buffer.from(raw)).toString('latin1') } catch { out += Buffer.from(raw).toString('latin1') }
  }
  return out
}

beforeEach(() => { template = null; reads.r2.length = 0; reads.firebase.length = 0 })

describe('preview guard', () => {
  it('refuses to preview a template that was never designed', async () => {
    template = tpl({ fileKey: KEY })

    const res = await PREVIEW(req({}), { params })

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      error: 'Certificate template must be designed before certificates can be issued.',
    })
  })

  it('refuses an empty layout supplied inline from the unsaved builder state', async () => {
    template = tpl({ fileKey: KEY, layout: DESIGNED })

    // The organizer deleted every element but has not saved: preview must not fall back either.
    const res = await PREVIEW(
      req({ layout: { version: 1, canvas: { ...CANVAS, unit: 'pt' }, elements: [] } }),
      { params },
    )

    // 422 not 400: the layout is structurally VALID, it is just not something that may be
    // issued — the same answer issuance gives.
    expect(res.status).toBe(422)
  })

  it('previews normally once the template carries a design', async () => {
    template = tpl({ fileKey: KEY, layout: DESIGNED })

    const res = await PREVIEW(req({}), { params })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('pdf')
  })
})

describe('storage source has no bearing on rendering', () => {
  const render = async (t: Doc) => {
    const { templateBytes, assets } = await loadRenderAssets(t as never)
    return pageContent(await renderCertificatePdf({
      templateBytes, templateType: 'png', dimensions: CANVAS,
      context: { participantName: 'Balaganapathy NT' },
      verifyUrl: 'https://registerdesk.in/verify/certificate/RDC-2026-TEST',
      layout: DESIGNED as never, assets,
    }))
  }

  it('a legacy fileUrl template and an R2 fileKey template render identically', async () => {
    const fromR2     = await render(tpl({ fileKey: KEY,        layout: DESIGNED }))
    const fromLegacy = await render(tpl({ fileUrl: LEGACY_URL, layout: DESIGNED }))

    expect(fromR2).toBe(fromLegacy)
    // ...and each genuinely came from its own store, not from a shared cache.
    expect(reads.r2).toEqual([KEY])
    expect(reads.firebase).toEqual([LEGACY_URL])
  })

  it('an explicit R2 template still renders its configured field', async () => {
    const ops = (await render(tpl({ fileKey: KEY, layout: DESIGNED })))
      .split(/\s+/).filter(t => /^(Do|Tj|TJ)$/.test(t))

    expect(ops).toContain('Do')                      // the background
    expect(ops.some(o => o === 'Tj' || o === 'TJ')).toBe(true)   // the participant name
  })
})
