// PA-3 verification — Designer JSON → renderer → preview.
// Run: npx --yes tsx scripts/verify-print-render.ts
//
// Exercises: fraction→point coordinates, rotation, frozen layer order,
// visibility filtering, opacity, variable resolution, schema validation, and
// that the SVG preview and the PDF come from the same pipeline.

import type { PrintCanvas, PrintDesign, PrintElement } from '../lib/printAssets/types'
import { PRINT_DESIGN_VERSION } from '../lib/printAssets/types'
import {
  normalizeDesign, validateRenderDocument, renderToSvg, renderToPdf,
  sampleVariableSources, pageSizeOf,
} from '../lib/printAssets/render'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

function el(partial: Partial<PrintElement> & { type: PrintElement['type']; id: string }): PrintElement {
  return {
    x: 0.1, y: 0.1, width: 0.8, height: 0.1, rotation: 0,
    visible: true, locked: false, zIndex: 0, properties: {}, ...partial,
  }
}

async function main() {
  const canvas: PrintCanvas = { preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait' }
  const design: PrintDesign = {
    version: PRINT_DESIGN_VERSION,
    canvas: { background: '#ffffff', borderColor: '#e5e7eb', borderWidth: 0.01, showGrid: true, snap: true, gridStep: 0.025 },
    elements: [
      el({ id: 'txt', type: 'text', x: 0.1, y: 0.4, width: 0.8, height: 0.1, rotation: 30, zIndex: 9,
           properties: { text: 'Hi {{name}}', fontSize: 0.05, align: 'center', color: '#111827', opacity: 1 } }),
      el({ id: 'rct', type: 'rect', x: 0.1, y: 0.1, width: 0.8, height: 0.2, zIndex: 1,
           properties: { fill: '#ff0000', opacity: 0.5 } }),
      el({ id: 'qr',  type: 'qr',   x: 0.6, y: 0.7, width: 0.2, height: 0.1, properties: {} }),
      el({ id: 'img', type: 'image', x: 0.1, y: 0.7, width: 0.2, height: 0.1, properties: { fit: 'contain' } }),
      el({ id: 'ln',  type: 'line', x: 0.1, y: 0.92, width: 0.8, height: 0.02, properties: { orientation: 'horizontal', thickness: 0.006, color: '#333333' } }),
      el({ id: 'hidden', type: 'text', visible: false, properties: { text: 'SHOULD_NOT_APPEAR' } }),
    ],
  }

  // ── Normalize + validate ──
  const doc = normalizeDesign(canvas, design, { templateId: 't1', name: 'Test Badge' })
  check('schemaVersion mapped from design.version', doc.schemaVersion === PRINT_DESIGN_VERSION)
  const v = validateRenderDocument(doc)
  check('valid document passes validation', v.ok)
  if (!v.ok) { console.log(v.error); process.exit(1) }

  const page = pageSizeOf(doc.canvas)
  check('CR80 portrait ≈ 153×242 pt', Math.round(page.width) === 153 && Math.round(page.height) === 243)

  // ── SVG preview ──
  const svg = await renderToSvg({ document: v.document, variables: sampleVariableSources() })
  check('variable {{name}} resolved', svg.includes('Hi Priya Sharma'))
  check('hidden element excluded', !svg.includes('SHOULD_NOT_APPEAR'))
  check('rotation honored (rotate(30 …))', /rotate\(30 /.test(svg))
  check('opacity honored (0.5)', svg.includes('opacity="0.5"'))
  check('background painted', svg.includes('fill="#ffffff"'))
  check('canvas border drawn', svg.includes('#e5e7eb'))

  // Frozen tier order: rect < image < qr < text in document order.
  const iRect = svg.indexOf('#ff0000')
  const iText = svg.indexOf('Hi Priya Sharma')
  check('layer order: rect painted before text (frozen tiers, not zIndex)', iRect >= 0 && iRect < iText)

  // Fraction→point: text center element (x .1 w .8) is horizontally centered.
  check('text element spans canvas width via fractions', /rotate\(30 76\.\d+ /.test(svg) || svg.includes('rotate(30 76'))

  // ── PDF from the same pipeline ──
  const pdf = await renderToPdf({ document: v.document, variables: sampleVariableSources() })
  const header = Buffer.from(pdf.slice(0, 5)).toString('latin1')
  check('PDF produced (%PDF header)', header === '%PDF-')
  check('PDF non-trivial size', pdf.length > 800)

  // ── Schema guard: unsupported version fails gracefully ──
  const bad = validateRenderDocument({ ...doc, schemaVersion: 999 })
  check('unsupported schemaVersion rejected', !bad.ok)

  // ── Unknown element type dropped as a warning, not a throw ──
  const withUnknown = normalizeDesign(canvas, {
    ...design,
    elements: [...design.elements, el({ id: 'weird', type: 'polygon' as PrintElement['type'], properties: {} })],
  })
  const vu = validateRenderDocument(withUnknown)
  check('unknown element type dropped with warning', vu.ok && vu.warnings.some(w => w.includes('unknown type')))

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
