// RD-CERT-SCALE P2-3 — the certificate stats endpoint must be flat in event size.
//
// THE DEFECT. The route loaded EVERY `certificateRecords` document for the event with an
// unbounded `.get()`, then produced four counters with `.filter().length` and twenty rows
// with an in-memory sort. At 10k that is 10,000 document reads to render a summary card; at
// 25k it is 25,000. Nothing about the output needed them.
//
// The shape of the fix is what the tests pin: counters come from `count()` aggregates (which
// transfer zero documents) and the recent list is ordered and limited BY FIRESTORE.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const STATS = 'app/api/organizer/events/[eventId]/certificates/stats/route.ts'
const src   = strip(read(STATS))

describe('the stats route reads a bounded number of documents', () => {
  it('never loads the whole certificate collection', () => {
    // The exact call that made cost scale with the event.
    expect(src).not.toMatch(/getCertificatesByEventId/)
  })

  it('derives every counter from a count() aggregate', () => {
    expect(src).toMatch(/base\.count\(\)\.get\(\)/)
    expect(src).toMatch(/base\.where\('downloadCount', '>', 0\)\.count\(\)\.get\(\)/)
    expect(src).toMatch(/base\.where\('emailStatus', '==', 'sent'\)\.count\(\)\.get\(\)/)
  })

  it('bounds the recent list in the QUERY, not in memory', () => {
    expect(src).toMatch(/\.orderBy\('issuedAt', 'desc'\)\.limit\(20\)\.get\(\)/)
    // An in-memory sort implies the whole collection was fetched.
    expect(src).not.toMatch(/records\s*\n?\s*\.sort\(/)
    expect(src).not.toMatch(/\.slice\(0, 20\)/)
  })

  it('keeps the query scoped to ONE organizer and ONE event', () => {
    // Event isolation is unchanged: both equality filters are still present.
    expect(src).toMatch(/\.where\('organizerUid', '==', uid\)/)
    expect(src).toMatch(/\.where\('eventId',\s+'==', eventId\)/)
  })

  it('still authorizes before reading anything', () => {
    const authAt = src.indexOf('authorizeWorkspace')
    const readAt = src.indexOf('LEGACY_CERTIFICATE_RECORDS')
    expect(authAt).toBeGreaterThan(-1)
    expect(authAt).toBeLessThan(readAt)
  })

  it('preserves the response shape exactly', () => {
    expect(src).toMatch(/generated, downloaded, emailed, pending, recent,/)
    expect(src).toMatch(/satisfies CertificateStatsResponse/)
  })

  it('keeps pending as a count() aggregate too', () => {
    // Pre-existing behaviour; it must not have regressed into a scan.
    expect(src).toMatch(/\.where\('status',\s+'==', 'confirmed'\)\s*\n?\s*\.count\(\)\.get\(\)/)
  })
})

describe('the indexes those queries require are declared', () => {
  const idx = JSON.parse(read('firestore.indexes.json')) as {
    indexes: { collectionGroup: string; fields: { fieldPath: string; order?: string }[] }[]
  }
  const shapes = idx.indexes
    .filter(i => i.collectionGroup === 'certificateRecords')
    .map(i => i.fields.map(f => `${f.fieldPath}:${f.order ?? 'ASCENDING'}`).join(','))

  it('has the equality-only index used by the generated count', () => {
    expect(shapes).toContain('organizerUid:ASCENDING,eventId:ASCENDING')
  })

  it('has the range index for downloadCount > 0, with the range field LAST', () => {
    expect(shapes).toContain('organizerUid:ASCENDING,eventId:ASCENDING,downloadCount:ASCENDING')
  })

  it('has the equality index for emailStatus', () => {
    expect(shapes).toContain('organizerUid:ASCENDING,eventId:ASCENDING,emailStatus:ASCENDING')
  })

  it('has the DESCENDING issuedAt index for the recent list', () => {
    // issuedAt, not createdAt — CertificateRecord has no createdAt field.
    expect(shapes).toContain('organizerUid:ASCENDING,eventId:ASCENDING,issuedAt:DESCENDING')
  })

  it('declares no duplicate certificateRecords index', () => {
    expect(new Set(shapes).size).toBe(shapes.length)
  })
})
