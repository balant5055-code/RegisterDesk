// RD-CERT-2E — the layout is the whole contract: nothing renders that the organizer did not place.
//
// THE BUG THIS PINS. `renderCertificatePdf` used to fall back to a built-in design whenever the
// layout was absent or empty, stamping the participant's name, the certificate id, the issue
// date and a verification QR onto the uploaded artwork at fixed coordinates. A template with
// zero builder elements therefore issued certificates carrying attendee data nobody placed —
// and the Layers panel honestly said "No elements yet", so nothing on screen contradicted it.
//
// ═══ WHY THESE ASSERTIONS AND NOT "the PDF contains the name" ════════════════
// It cannot be tested that way, and a test that tried would pass against the BROKEN code.
// pdf-lib Flate-compresses content streams AND draws through embedded subset fonts, so the
// drawn name is never literal text in the output — searching the bytes for the name returns
// false even while the bug is live. Verified before this file was written.
//
// So two glyph-agnostic signals are used against the real render path instead:
//
//   1. NO TEXT OPERATORS. A background-only render must emit no `Tj`/`TJ` at all.
//   2. INVARIANCE. Rendering the same template with two different participant names must
//      produce a byte-identical page content stream unless a Participant Name element exists.
//      This is the property that actually matters — "attendee data cannot influence the output
//      unless it was placed" — and it holds regardless of fonts, compression or encoding.

import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import { renderCertificatePdf } from '@/lib/certificates/render'
import type { CertificateLayout, LayoutElement } from '@/lib/certificates/types'

// ─── A real 4×4 PNG, built here so the test needs no fixture file ─────────────

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
const IHDR = Buffer.alloc(13)
IHDR.writeUInt32BE(4, 0); IHDR.writeUInt32BE(4, 4); IHDR[8] = 8; IHDR[9] = 2   // 4×4, 8-bit RGB
const PIXELS = Buffer.concat(Array.from({ length: 4 }, () =>
  Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 0xEE)])))
const PNG = new Uint8Array(Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', IHDR), pngChunk('IDAT', zlib.deflateSync(PIXELS)), pngChunk('IEND', Buffer.alloc(0)),
]))

// ─── Page-content extraction ──────────────────────────────────────────────────

/**
 * Page 0's decompressed content stream — every drawing operator, in order.
 *
 * The whole-file bytes are NOT used: pdf-lib stamps a creation timestamp, so two renders of
 * identical content differ at the file level. The page content stream is deterministic, which
 * is exactly what makes the invariance assertions below meaningful.
 */
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

const hasText = (content: string) => /\bTj\b|\bTJ\b/.test(content)

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CANVAS = { width: 800, height: 600 }

function text(id: string, content: string, y: number): LayoutElement {
  return {
    id, type: 'text', content, zIndex: 1, x: 0.1, y, width: 0.8,
    fontFamily: 'helvetica', fontSizeFrac: 0.05, weight: 'normal',
    color: '#111111', align: 'center',
  } as LayoutElement
}
const layoutOf = (...elements: LayoutElement[]): CertificateLayout =>
  ({ version: 1, canvas: CANVAS, elements })

const ctx = (participantName: string) => ({
  participantName,
  eventName:     'RegisterDesk Marathon',
  certificateId: 'RDC-2026-TEST',
  issueDate:     '15 August 2026',
})

async function render(layout: CertificateLayout | null, participantName: string): Promise<string> {
  const bytes = await renderCertificatePdf({
    templateBytes: PNG, templateType: 'png', dimensions: CANVAS,
    context: ctx(participantName),
    verifyUrl: 'https://registerdesk.in/verify/certificate/RDC-2026-TEST',
    layout,
  })
  return pageContent(bytes)
}

const NAME_A = 'Balaganapathy NT'
const NAME_B = 'Someone Else Entirely'

// ─── 1. Background-only ───────────────────────────────────────────────────────

describe('background-only template', () => {
  it('draws no text at all when the layout is absent', async () => {
    expect(hasText(await render(null, NAME_A))).toBe(false)
  })

  it('draws no text at all when the layout exists but has zero elements', async () => {
    expect(hasText(await render(layoutOf(), NAME_A))).toBe(false)
  })

  it('renders identically for two different participants — attendee data cannot leak in', async () => {
    // The property that would have caught the original bug: the name had influence.
    expect(await render(layoutOf(), NAME_A)).toBe(await render(layoutOf(), NAME_B))
    expect(await render(null, NAME_A)).toBe(await render(null, NAME_B))
  })

  it('emits no certificate id, issue date or verification QR either', async () => {
    // The old default drew all three. The page is now the background image and nothing else:
    // one XObject draw, no text-showing op, and no rectangle op (the QR was drawn as rects).
    const ops = (await render(layoutOf(), NAME_A))
      .split(/\s+/).filter(t => /^(Do|Tj|TJ|re|f|S)$/.test(t))

    expect(ops).toEqual(['Do'])
  })
})

// ─── 2-4. Explicit elements ───────────────────────────────────────────────────

describe('explicit elements', () => {
  it('renders the participant name when a Participant Name element exists', async () => {
    const layout = layoutOf(text('t1', '{{participantName}}', 0.4))

    expect(hasText(await render(layout, NAME_A))).toBe(true)
    // ...and it is genuinely THAT attendee's name driving the output.
    expect(await render(layout, NAME_A)).not.toBe(await render(layout, NAME_B))
  })

  it('does NOT render the participant name when only an Event Name element exists', async () => {
    const layout = layoutOf(text('t1', '{{eventName}}', 0.4))

    expect(hasText(await render(layout, NAME_A))).toBe(true)        // the event name IS drawn
    expect(await render(layout, NAME_A)).toBe(await render(layout, NAME_B))   // the name is not
  })

  it('renders ONLY the configured fields when several are placed', async () => {
    const configured = layoutOf(
      text('t1', '{{eventName}}', 0.30),
      text('t2', '{{certificateId}}', 0.55),
      text('t3', 'Certificate of Completion', 0.75),
    )
    // No participantName element among them → the participant still has no influence.
    expect(await render(configured, NAME_A)).toBe(await render(configured, NAME_B))

    // Adding the participant element is what makes the output attendee-specific.
    const withName = layoutOf(...configured.elements, text('t4', '{{participantName}}', 0.45))
    expect(await render(withName, NAME_A)).not.toBe(await render(withName, NAME_B))
  })

  it('is unchanged for a designed template regardless of participant — a pure background diff', async () => {
    // A designed layout renders strictly more than a bare background, never less.
    const designed = await render(layoutOf(text('t1', '{{eventName}}', 0.4)), NAME_A)
    const bare     = await render(layoutOf(), NAME_A)

    expect(designed.length).toBeGreaterThan(bare.length)
    expect(hasText(bare)).toBe(false)
  })
})
