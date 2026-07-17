// PA-5 verification — real QR, real images, branding, preview parity, dedup.
// Run: npx --yes tsx scripts/verify-print-pa5.ts

import type { PrintCanvas, PrintDesign, PrintElement } from '../lib/printAssets/types'
import { PRINT_DESIGN_VERSION } from '../lib/printAssets/types'
import {
  normalizeDesign, validateRenderDocument, renderToSvg, renderToPdf,
  buildVariableMap, collectImageSources, ensurePrintAssets,
} from '../lib/printAssets/render'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

// A valid 1×1 transparent PNG (so pdf-lib embedPng succeeds).
const PNG_1x1 = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
))

function el(p: Partial<PrintElement> & { type: PrintElement['type']; id: string }): PrintElement {
  return { x: 0.1, y: 0.1, width: 0.3, height: 0.3, rotation: 0, visible: true, locked: false, zIndex: 0, properties: {}, ...p }
}

async function main() {
  const canvas: PrintCanvas = { preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait' }
  const design: PrintDesign = {
    version: PRINT_DESIGN_VERSION,
    canvas: { background: '#ffffff', borderColor: '#e5e7eb', borderWidth: 0, showGrid: true, snap: true, gridStep: 0.025 },
    elements: [
      el({ id: 'qr',   type: 'qr',   x: 0.6, y: 0.7, width: 0.3, height: 0.2, properties: { text: '{{qr}}' } }),
      el({ id: 'logo', type: 'image', x: 0.1, y: 0.1, width: 0.3, height: 0.2, properties: { text: '{{logo}}', fit: 'contain' } }),
      el({ id: 'name', type: 'text', x: 0.1, y: 0.5, width: 0.8, height: 0.1, properties: { text: 'Hi {{name}} · {{organizer}}', fontSize: 0.05 } }),
    ],
  }

  const LOGO_URL = 'https://firebasestorage.googleapis.com/v0/b/x/o/organizer-assets%2Fu1%2Flogo.png'
  const doc = normalizeDesign(canvas, design, { templateId: 't1' })
  const v = validateRenderDocument(doc)
  if (!v.ok) { console.log(v.error); process.exit(1) }

  const variables = {
    registration: { name: 'Priya Sharma' },
    system:  { qr: 'RD:demo:reg123:TCK-1234' },
    branding: { logo: LOGO_URL, primaryColor: '#e5277e', company: 'Acme Events' },
  }
  const assets = new Map<string, Uint8Array | null>([[LOGO_URL, PNG_1x1]])

  // ── SVG ──
  const svg = await renderToSvg({ document: v.document, variables, assets })
  const qrCells = (svg.match(/fill="#000000"/g) ?? []).length
  check('real QR renders as many vector cells (SVG)', qrCells > 15)
  check('real image embedded as data URI (SVG)', svg.includes('data:image/png;base64,'))
  check('branding {{organizer}} resolved', svg.includes('Acme Events'))
  check('{{name}} resolved', svg.includes('Priya Sharma'))
  check('NO placeholder graphics remain', !svg.includes('#94a3b8') && !svg.includes('#f1f5f9'))

  // ── PDF (same pipeline → parity) ──
  const pdf = await renderToPdf({ document: v.document, variables, assets })
  check('PDF produced (%PDF header)', Buffer.from(pdf.slice(0, 5)).toString('latin1') === '%PDF-')
  check('PDF embeds content (non-trivial size)', pdf.length > 1000)

  // ── Missing asset → drawn as nothing (no placeholder) ──
  const svgNoAsset = await renderToSvg({ document: v.document, variables, assets: new Map() })
  check('missing image → no data URI, no placeholder', !svgNoAsset.includes('data:image') && !svgNoAsset.includes('#94a3b8'))
  check('QR still renders without image asset', (svgNoAsset.match(/fill="#000000"/g) ?? []).length > 15)

  // ── Download-once: collectImageSources dedups; ensurePrintAssets skips cached ──
  const dupDesign = { ...v.document, elements: [
    el({ id: 'a', type: 'image', properties: { text: '{{logo}}' } }),
    el({ id: 'b', type: 'image', properties: { text: '{{logo}}' } }),
  ] }
  const map = buildVariableMap(variables)
  const srcs = collectImageSources(dupDesign, map)
  check('duplicate image sources deduped to one URL', srcs.length === 1 && srcs[0] === LOGO_URL)

  const cache = new Map<string, Uint8Array | null>([[LOGO_URL, PNG_1x1]])   // pre-seeded
  await ensurePrintAssets(srcs, cache, 'u1')   // must NOT refetch the seeded URL
  check('pre-cached URL is not re-fetched (bytes preserved)', cache.get(LOGO_URL) === PNG_1x1)

  // ── SSRF: a non-Storage URL is refused offline (cached null, no network) ──
  const badCache = new Map<string, Uint8Array | null>()
  await ensurePrintAssets(['http://169.254.169.254/latest/meta-data'], badCache, 'u1')
  check('SSRF: non-storage URL refused (cached null)', badCache.get('http://169.254.169.254/latest/meta-data') === null)

  // ── Ownership: another org's storage object is refused ──
  const otherCache = new Map<string, Uint8Array | null>()
  await ensurePrintAssets(['https://firebasestorage.googleapis.com/v0/b/x/o/organizer-assets%2FOTHER%2Flogo.png'], otherCache, 'u1')
  check('ownership: another org object refused (cached null)', [...otherCache.values()][0] === null)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
