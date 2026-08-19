// RD-CERT-PHOTO-01 — attendee-photo support in the RENDERER, and the proof that nothing
// else moved.
//
// ═══ WHY BYTE-COMPARISON AND NOT "the PDF contains the photo" ════════════════
// Same reason as certificateRenderNoImplicitFields: pdf-lib Flate-compresses content
// streams, so an embedded image is not literal in the output. The assertions here work on
// the DECOMPRESSED page content stream — every drawing operator, in order — which is
// deterministic across renders (the whole file is not: pdf-lib stamps a creation date).
//
// The property that matters most is INVARIANCE: supplying an attendee photo must not change
// a single operator for a template that has no attendeePhoto element. That is what makes
// "this port cannot regress existing certificates" a fact rather than a hope.

import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { PDFDocument, PDFName } from 'pdf-lib'
import { renderCertificatePdf } from '@/lib/certificates/render'
import type { CertificateLayout, LayoutElement } from '@/lib/certificates/types'

// ─── Two real PNGs, built here so the test needs no fixture file ──────────────
// They differ in pixel colour, so "which bytes were drawn" is observable in the output.

function crc32(buf: Buffer): number {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  let x = 0xFFFFFFFF
  for (const b of buf) x = t[(x ^ b) & 0xFF] ^ (x >>> 8)
  return (x ^ 0xFFFFFFFF) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td  = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function makePng(fill: number): Uint8Array {
  const IHDR = Buffer.alloc(13)
  IHDR.writeUInt32BE(4, 0); IHDR.writeUInt32BE(4, 4); IHDR[8] = 8; IHDR[9] = 2  // 4×4 8-bit RGB
  const PIXELS = Buffer.concat(Array.from({ length: 4 }, () =>
    Buffer.concat([Buffer.from([0]), Buffer.alloc(12, fill)])))
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', IHDR), pngChunk('IDAT', zlib.deflateSync(PIXELS)), pngChunk('IEND', Buffer.alloc(0)),
  ]))
}

const TEMPLATE = makePng(0xEE)   // background artwork
const STATIC   = makePng(0x11)   // the organizer's logo/signature/seal asset
const PHOTO    = makePng(0x77)   // the attendee's own photo

/** Page 0's decompressed content stream — deterministic, unlike the whole file. */
async function pageContent(bytes: Uint8Array): Promise<string> {
  const doc  = await PDFDocument.load(bytes)
  const page = doc.getPage(0)
  // @ts-expect-error pdf-lib internals: no public content-stream accessor exists.
  const contents = page.node.Contents()
  const refs = contents?.asArray ? contents.asArray() : [contents]
  let out = ''
  for (const ref of refs) {
    const obj = doc.context.lookup(ref) ?? ref
    // @ts-expect-error pdf-lib internals
    const raw = obj?.getContents?.()
    if (!raw) continue
    try { out += zlib.inflateSync(Buffer.from(raw)).toString('latin1') }
    catch { out += Buffer.from(raw).toString('latin1') }
  }
  return out
}

/**
 * SHA-256 of every embedded image XObject, sorted.
 *
 * The content stream cannot answer "WHICH image was drawn": it references an XObject by
 * NAME, so two different photos at the same geometry emit byte-identical operators. The
 * distinguishing bytes live in the image object itself, which is what this reads.
 */
async function imageHashes(pdf: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf)
  const out: string[] = []
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = (obj as unknown as { dict?: { get?: (k: unknown) => unknown } }).dict
    if (typeof dict?.get !== 'function') continue
    if (String(dict.get(PDFName.of('Subtype'))) !== '/Image') continue
    const raw = (obj as unknown as { getContents?: () => Uint8Array }).getContents?.()
    if (raw?.length) out.push(createHash('sha256').update(Buffer.from(raw)).digest('hex'))
  }
  return out.sort()
}

const CANVAS = { width: 800, height: 600 }
const ASSET_URL = 'https://firebasestorage.googleapis.com/v0/b/bucket/o/logo.png?alt=media'

const base = { zIndex: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }

const staticImg = (id = 'static-1', fit: 'contain' | 'cover' = 'contain'): LayoutElement =>
  ({ ...base, id, type: 'image', assetUrl: ASSET_URL, fit }) as LayoutElement

const photoImg = (id = 'photo-1'): LayoutElement =>
  ({ ...base, id, type: 'image', assetUrl: '', source: 'attendeePhoto', fit: 'contain' }) as LayoutElement

const explicitStatic = (id = 'static-2'): LayoutElement =>
  ({ ...base, id, type: 'image', assetUrl: ASSET_URL, source: 'static', fit: 'contain' }) as LayoutElement

const layoutOf = (...elements: LayoutElement[]): CertificateLayout =>
  ({ version: 1, canvas: CANVAS, elements })

const CTX = {
  participantName: 'Balaganapathy NT',
  eventName:       'RegisterDesk Marathon',
  certificateId:   'RDC-2026-TEST',
  issueDate:       '15 August 2026',
}

async function render(
  layout: CertificateLayout | null,
  opts: { assets?: Map<string, Uint8Array>; attendeePhoto?: Uint8Array } = {},
): Promise<Uint8Array> {
  return renderCertificatePdf({
    templateBytes: TEMPLATE, templateType: 'png', dimensions: CANVAS,
    context: CTX,
    verifyUrl: 'https://registerdesk.in/verify/certificate/RDC-2026-TEST',
    layout,
    assets: opts.assets,
    attendeePhoto: opts.attendeePhoto,
  })
}

const withStatic = () => new Map([[ASSET_URL, STATIC]])

// ─── 1–3. Static rendering is untouched ───────────────────────────────────────

describe('static image rendering is unchanged by this port', () => {
  it('1 · a static image with an asset still draws, and supplying a photo changes NOTHING', async () => {
    const l = layoutOf(staticImg())
    const without = await pageContent(await render(l, { assets: withStatic() }))
    const with_   = await pageContent(await render(l, { assets: withStatic(), attendeePhoto: PHOTO }))

    expect(without).toContain('Do')            // an image WAS drawn
    // The invariance that matters: a template with no attendeePhoto element cannot be
    // influenced by the new parameter, whatever is passed.
    expect(with_).toBe(without)
  })

  it('2 · `source` ABSENT behaves exactly as before (legacy template)', async () => {
    const legacy = await pageContent(await render(layoutOf(staticImg()), { assets: withStatic() }))
    expect(legacy).toContain('Do')
    expect(legacy).not.toBe('')
  })

  it('3 · `source: "static"` is identical to source absent', async () => {
    const absent   = await pageContent(await render(layoutOf(staticImg('same')),        { assets: withStatic() }))
    const explicit = await pageContent(await render(layoutOf(explicitStatic('same')),   { assets: withStatic() }))
    expect(explicit).toBe(absent)
  })

  it('still honours BOTH fits for static images', async () => {
    const contain = await pageContent(await render(layoutOf(staticImg('f', 'contain')), { assets: withStatic() }))
    const cover   = await pageContent(await render(layoutOf(staticImg('f', 'cover')),   { assets: withStatic() }))
    // Different geometry ⇒ different operators. `cover` was not quietly collapsed away.
    expect(cover).not.toBe(contain)
  })
})

// ─── 4–6. Attendee photo ──────────────────────────────────────────────────────

describe('attendeePhoto elements', () => {
  it('4 · draws the supplied attendee photo bytes', async () => {
    const withPhoto = await render(layoutOf(photoImg()), { attendeePhoto: PHOTO })
    const noPhoto   = await render(layoutOf(photoImg()))

    expect(await pageContent(withPhoto)).toContain('Do')     // an image was drawn
    // The template is always embedded; a SECOND image object appears only when the
    // attendee's photo is actually embedded.
    expect((await imageHashes(withPhoto)).length).toBe(2)
    expect((await imageHashes(noPhoto)).length).toBe(1)
  })

  it('5 · never reads assetUrl — a stale URL in `assets` is NOT used', async () => {
    // A crafted element carrying BOTH a source and a resolvable assetUrl. The renderer must
    // take the photo path; with no photo supplied it must draw nothing at all, rather than
    // silently falling back to the organizer's asset.
    const crafted = { ...base, id: 'x', type: 'image', assetUrl: ASSET_URL, source: 'attendeePhoto', fit: 'contain' } as LayoutElement
    const empty   = await pageContent(await render(layoutOf(), { assets: withStatic() }))
    const crafted_= await pageContent(await render(layoutOf(crafted), { assets: withStatic() }))
    expect(crafted_).toBe(empty)           // nothing drawn — no fallback to assetUrl
  })

  it('6 · a MISSING photo skips the element and still produces a valid PDF', async () => {
    const pdf = await render(layoutOf(photoImg()))
    const doc = await PDFDocument.load(pdf)        // parses ⇒ structurally valid
    expect(doc.getPageCount()).toBe(1)

    const skipped = await pageContent(pdf)
    const empty   = await pageContent(await render(layoutOf()))
    expect(skipped).toBe(empty)                    // the box simply does not draw
  })

  it('one attendee’s photo cannot leak onto another render off the same assets map', async () => {
    // Two consecutive renders sharing ONE template-level assets map — the exact shape a bulk
    // job uses. Each must embed its OWN photo.
    const assets = withStatic()
    const a = await imageHashes(await render(layoutOf(photoImg()), { assets, attendeePhoto: PHOTO }))
    const b = await imageHashes(await render(layoutOf(photoImg()), { assets, attendeePhoto: STATIC }))
    expect(a).not.toEqual(b)
    // …and the renderer must not have written the photo into the shared cache.
    expect(assets.size).toBe(1)
    expect([...assets.keys()]).toEqual([ASSET_URL])
  })
})

// ─── 7. Everything else still renders ─────────────────────────────────────────

describe('7 · other element types are unaffected', () => {
  const textEl: LayoutElement = {
    id: 't', type: 'text', content: '{{participantName}}', zIndex: 1, x: 0.1, y: 0.4, width: 0.8,
    fontFamily: 'helvetica', fontSizeFrac: 0.05, weight: 'normal', color: '#111111', align: 'center',
  } as LayoutElement
  const qrEl:   LayoutElement = { id: 'q', type: 'qr', source: 'verify', zIndex: 2, x: 0.8, y: 0.8, width: 0.12, height: 0.12 } as LayoutElement
  const lineEl: LayoutElement = { id: 'l', type: 'line', color: '#999999', thickness: 0.004, zIndex: 3, x: 0.35, y: 0.6, width: 0.3 } as LayoutElement

  it('text, QR and line render identically with and without a photo supplied', async () => {
    const l = layoutOf(textEl, qrEl, lineEl)
    const without = await pageContent(await render(l))
    const with_   = await pageContent(await render(l, { attendeePhoto: PHOTO }))
    expect(with_).toBe(without)
    expect(/\bTj\b|\bTJ\b/.test(without)).toBe(true)   // text really did draw
  })

  it('logo / signature / seal roles still draw as static images', async () => {
    for (const role of ['logo', 'signature', 'seal'] as const) {
      const el = { ...base, id: role, type: 'image', assetUrl: ASSET_URL, fit: 'contain', role } as LayoutElement
      const c  = await pageContent(await render(layoutOf(el), { assets: withStatic() }))
      expect(c, role).toContain('Do')
    }
  })
})

// ─── RD-CERT-2E must survive this port ────────────────────────────────────────

describe('RD-CERT-2E — drawDefault stays deleted', () => {
  it('a null layout draws no text, with or without a photo', async () => {
    expect(/\bTj\b|\bTJ\b/.test(await pageContent(await render(null)))).toBe(false)
    expect(/\bTj\b|\bTJ\b/.test(await pageContent(await render(null, { attendeePhoto: PHOTO })))).toBe(false)
  })

  it('an EMPTY layout draws no text either', async () => {
    expect(/\bTj\b|\bTJ\b/.test(await pageContent(await render(layoutOf())))).toBe(false)
  })

  it('attendee data cannot influence output unless an element was placed', async () => {
    const a = await renderCertificatePdf({
      templateBytes: TEMPLATE, templateType: 'png', dimensions: CANVAS,
      context: { ...CTX, participantName: 'Person A' },
      verifyUrl: 'https://registerdesk.in/verify/certificate/RDC-2026-TEST',
      layout: layoutOf(photoImg()), attendeePhoto: PHOTO,
    })
    const b = await renderCertificatePdf({
      templateBytes: TEMPLATE, templateType: 'png', dimensions: CANVAS,
      context: { ...CTX, participantName: 'Person B Entirely Different' },
      verifyUrl: 'https://registerdesk.in/verify/certificate/RDC-2026-TEST',
      layout: layoutOf(photoImg()), attendeePhoto: PHOTO,
    })
    expect(await pageContent(a)).toBe(await pageContent(b))
  })
})
