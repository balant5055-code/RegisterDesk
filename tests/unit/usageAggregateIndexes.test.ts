// Communication Center › Usage — every filtered sum() aggregation the page runs must have a
// composite index in firestore.indexes.json that contains its equality fields AND the summed field.
//
// Why a static test: the Firestore emulator does not enforce composite indexes, so emulator suites
// pass while production answers 9 FAILED_PRECONDITION ("The query requires an index"). That is
// exactly how the Usage page reached production returning HTTP 500 (2026-10-26). Each entry below
// mirrors one aggregation query in source; the source check fails if the query changes shape.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

interface IndexDef { collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string; order?: string }> }
const indexes = (JSON.parse(readFileSync('firestore.indexes.json', 'utf8')) as { indexes: IndexDef[] }).indexes

/** An index serves `equality filters + sum(field)` when it holds exactly those equality fields
 *  (any order) followed by the summed field. */
function served(collection: string, equality: string[], summed: string): boolean {
  return indexes.some(ix => {
    if (ix.collectionGroup !== collection || ix.queryScope !== 'COLLECTION') return false
    const paths = ix.fields.map(f => f.fieldPath)
    return paths.length === equality.length + 1 && paths[paths.length - 1] === summed
      && [...paths.slice(0, -1)].sort().join() === [...equality].sort().join()
  })
}

const QUERIES = [
  { file: 'lib/communications/capacityActivity.ts', collection: 'broadcastCampaigns', equality: ['organizerUid', 'allowanceDraftId', 'billingSettlement'], summed: 'allowanceUnits',   source: "AggregateField.sum('allowanceUnits')" },
  { file: 'lib/communications/capacityActivity.ts', collection: 'broadcastCampaigns', equality: ['organizerUid', 'allowanceDraftId', 'billingSettlement'], summed: 'unknownHeldUnits', source: "AggregateField.sum('unknownHeldUnits')" },
  { file: 'lib/communications/capacityActivity.ts', collection: 'broadcastCampaigns', equality: ['organizerUid', 'allowanceDraftId', 'billingSettlement'], summed: 'refundedUnits',    source: "AggregateField.sum('refundedUnits')" },
  { file: 'lib/communications/usage.ts',            collection: 'communicationUsage', equality: ['organizerUid', 'eventSlug', 'channel'],                  summed: 'quantity',         source: "AggregateField.sum('quantity')" },
]

describe('Usage page aggregation queries have their composite indexes', () => {
  for (const q of QUERIES) {
    it(`${q.collection}: ${q.equality.join(' == , ')} == → sum(${q.summed})`, () => {
      const src = readFileSync(q.file, 'utf8')
      expect(src, 'the query this entry mirrors still exists').toContain(q.source)
      for (const f of q.equality) expect(src).toContain(`'${f}', '=='`)
      expect(served(q.collection, q.equality, q.summed)).toBe(true)
    })
  }
  it('capacityActivity filters only on the fields its indexes cover (no new filter without an index)', () => {
    const src = readFileSync('lib/communications/capacityActivity.ts', 'utf8')
    const filtered = [...src.matchAll(/\.where\('([A-Za-z.]+)'/g)].map(m => m[1])
    expect([...new Set(filtered)].sort()).toEqual(['allowanceDraftId', 'billingSettlement', 'organizerUid'])
  })
})
