// PA-9 S1 verification — the preview route's LIVE-design path reuses the one renderer.
// Mirrors exactly what the route does with an inline design (no HTTP, no Firebase writes).
// Run: source .env.local; npx --yes tsx scripts/verify-print-livepreview.ts

import type { PrintCanvas } from '../lib/printAssets/types'
import { PRINT_DESIGN_VERSION } from '../lib/printAssets/types'
import { validateDesign } from '../lib/printAssets/validation'
import {
  normalizeDesign, validateRenderDocument, renderToSvg, sampleVariableSources,
} from '../lib/printAssets/render'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

async function main() {
  const templateCanvas: PrintCanvas = { preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait' }

  // The exact JSON the designer's PrintPreview posts as `design`.
  const liveDesign = {
    version: PRINT_DESIGN_VERSION,
    canvas: { background: '#ffffff', borderColor: '#e5e7eb', borderWidth: 0, showGrid: true, snap: true, gridStep: 0.025 },
    elements: [
      { id: 'a', type: 'text', x: 0.1, y: 0.4, width: 0.8, height: 0.1, rotation: 0, visible: true, locked: false, zIndex: 1, properties: { text: 'Hi {{name}}', fontSize: 0.06 } },
      { id: 'b', type: 'qr', x: 0.4, y: 0.6, width: 0.2, height: 0.16, rotation: 0, visible: true, locked: false, zIndex: 2, properties: { text: '{{qr}}' } },
    ],
  }

  // Route step 1: sanitize the inline design with the SAME validator.
  const vd = validateDesign(liveDesign)
  check('inline design passes validateDesign', vd.ok)
  if (!vd.ok) { console.log(vd.error); process.exit(1) }

  // Route step 2: normalize with the template's physical canvas + validate.
  const doc = normalizeDesign(templateCanvas, vd.value, { templateId: 't1' })
  const rv = validateRenderDocument(doc)
  check('normalized live design validates', rv.ok)
  if (!rv.ok) { console.log(rv.error); process.exit(1) }

  // Route step 3: the ONE renderer.
  const svg = await renderToSvg({ document: rv.document, variables: sampleVariableSources() })
  check('renderToSvg produces an <svg>', svg.startsWith('<svg'))
  check('live variable {{name}} resolved (matches renderer)', svg.includes('Hi Priya Sharma'))
  check('live QR rendered as real cells', (svg.match(/fill="#000000"/g) ?? []).length > 15)

  // A garbage design must fail gracefully (422 in the route), never throw.
  const bad = validateDesign(42)
  check('non-object design → validation error (graceful)', !bad.ok)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
