// PA-8 verification — collection designs are valid + recommendations map correctly.
// Run: npx --yes tsx scripts/verify-print-collections.ts   (no Firebase needed)

import { PRINT_COLLECTIONS, getCollection, recommendCollection } from '../lib/printAssets/collections'
import { validateDesign } from '../lib/printAssets/validation'
import { PRINT_ELEMENT_TYPES, PRINT_ASSET_TYPES, CANVAS_UNITS, CANVAS_ORIENTATIONS } from '../lib/printAssets/types'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failures++
}

function main() {
  const expected: Record<string, number> = { sports: 10, conference: 8, corporate: 5, ngo: 5, college: 5, expo: 5, festival: 5, custom: 6 }

  check('all 8 collections present', PRINT_COLLECTIONS.length === 8)

  let total = 0
  for (const c of PRINT_COLLECTIONS) {
    check(`collection "${c.id}" has ${expected[c.id]} templates`, c.templates.length === expected[c.id])
    total += c.templates.length
    let allValid = true, allShapesOk = true
    for (const t of c.templates) {
      if (!(PRINT_ASSET_TYPES as string[]).includes(t.assetType)) allShapesOk = false
      if (!(CANVAS_UNITS as string[]).includes(t.canvas.unit)) allShapesOk = false
      if (!(CANVAS_ORIENTATIONS as string[]).includes(t.canvas.orientation)) allShapesOk = false
      if (!(t.canvas.width > 0 && t.canvas.height > 0)) allShapesOk = false
      // Every design must survive the SAME validator the import route runs.
      const v = validateDesign({ design: t.design })
      if (!v.ok) { allValid = false; console.log(`   ✗ ${c.id}/${t.name}: ${v.error}`); continue }
      for (const el of t.design.elements) {
        if (!(PRINT_ELEMENT_TYPES as string[]).includes(el.type)) allShapesOk = false
        if (el.x < 0 || el.x > 1 || el.y < 0 || el.y > 1 || el.width <= 0 || el.width > 1 || el.height <= 0 || el.height > 1) allShapesOk = false
        if (!el.properties || typeof el.properties !== 'object') allShapesOk = false
      }
    }
    check(`  "${c.id}" designs all pass validateDesign`, allValid)
    check(`  "${c.id}" elements well-formed (types + [0,1] coords)`, allShapesOk)
  }
  check('total bundled templates = 49', total === 49)

  // Smart recommendations
  check('marathon → sports', recommendCollection('marathon') === 'sports')
  check('conference → conference', recommendCollection('conference') === 'conference')
  check('fundraiser → ngo', recommendCollection('fundraiser') === 'ngo')
  check('corporate → corporate', recommendCollection('corporate') === 'corporate')
  check('unknown type → null', recommendCollection('spaceflight') === null)
  check('getCollection round-trips', getCollection('sports')?.name === 'Sports & Marathon')

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
