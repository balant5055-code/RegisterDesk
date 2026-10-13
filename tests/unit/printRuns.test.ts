// RD-PRINT-P3 — combined print runs: batch planning, merge integrity, text-overflow warnings,
// and source contracts. Real routes/Firestore/Storage/Auth: tests/emulator/printRuns.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import {
  planBatches, batchSlice, batchSheets, RUN_MAX_CARDS, RUN_BATCH_MAX_CARDS, RUN_BATCH_TARGET_CARDS,
} from '@/lib/printAssets/runs/plan'
import { mergeRunBatches, PrintRunError } from '@/lib/printAssets/runs/client'
import { analyzeTextOverflow, createTextMeasurer, normalizeDesign } from '@/lib/printAssets/render'
import { PRINT_COLLECTIONS } from '@/lib/printAssets/collections'

const read = (f: string) => readFileSync(f, 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('batch planning', () => {
  it('batches are whole sheets, at most the target, at least one sheet', () => {
    const p = planBatches(1000, 9)
    expect(p).toMatchObject({ ok: true, plan: { batchSize: 198, batchCount: 6, sheets: 112 } })   // 22 sheets per batch
    expect(planBatches(10, 9, 1)).toMatchObject({ ok: true, plan: { batchSize: 9, batchCount: 2, sheets: 2 } })  // floor at one sheet
    expect(planBatches(2000, 4, 10_000)).toMatchObject({ ok: true, plan: { batchSize: 500 } })                // capped
    expect(planBatches(5, 9)).toMatchObject({ ok: true, plan: { batchSize: 198, batchCount: 1, sheets: 1 } })
  })
  it('boundaries: exactly a batch, one over, the run cap', () => {
    expect(planBatches(198, 9)).toMatchObject({ ok: true, plan: { batchCount: 1 } })
    expect(planBatches(199, 9)).toMatchObject({ ok: true, plan: { batchCount: 2 } })
    expect(planBatches(RUN_MAX_CARDS, 9)).toMatchObject({ ok: true })
    expect(planBatches(RUN_MAX_CARDS + 1, 9)).toMatchObject({ ok: false, code: 'TOO_MANY_CARDS' })
    expect(planBatches(0, 9)).toMatchObject({ ok: false, code: 'NO_CARDS' })
    expect(planBatches(10, RUN_BATCH_MAX_CARDS + 1)).toMatchObject({ ok: false, code: 'SHEET_TOO_DENSE' })
    expect(planBatches(10, 0)).toMatchObject({ ok: false, code: 'SHEET_TOO_DENSE' })
  })
  it('the slices cover every card exactly once, in order, each starting on a fresh sheet', () => {
    for (const [n, per, want] of [[1, 9, undefined], [9, 9, 9], [30, 9, 9], [1000, 9, undefined], [4999, 16, 160], [500, 500, undefined]] as const) {
      const p = planBatches(n, per, want)
      if (!p.ok) throw new Error(p.error)
      const ids = Array.from({ length: n }, (_, i) => i)
      const out: number[] = []
      let sheets = 0
      for (let b = 0; b < p.plan.batchCount; b++) {
        const s = batchSlice(ids, p.plan.batchSize, b)
        if (b < p.plan.batchCount - 1) expect(s.length % per).toBe(0)                 // whole sheets
        out.push(...s)
        sheets += batchSheets(n, p.plan.batchSize, per, b)
      }
      expect(out).toEqual(ids)
      expect(sheets).toBe(p.plan.sheets)
    }
  })
  it('the batch ceiling matches the sheet renderer\'s card cap', () => {
    expect(read('lib/printAssets/generationJob.ts')).toContain(`export const PRINT_SHEET_MAX_CARDS = ${RUN_BATCH_MAX_CARDS}`)
    expect(RUN_BATCH_TARGET_CARDS).toBeLessThanOrEqual(RUN_BATCH_MAX_CARDS)
  })
})

describe('merging refuses anything incomplete', () => {
  const pdfWithPages = async (n: number) => {
    const d = await PDFDocument.create()
    for (let i = 0; i < n; i++) d.addPage([100 + i, 100])
    const b = await d.save()
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }
  const plan = { cardCount: 30, perSheet: 9, batchSize: 18, batchCount: 2, sheets: 4 }
  it('merges in order when every batch matches the plan', async () => {
    const merged = await PDFDocument.load(await mergeRunBatches([await pdfWithPages(2), await pdfWithPages(2)], plan))
    expect(merged.getPageCount()).toBe(4)
    expect(merged.getPages().map(p => p.getWidth())).toEqual([100, 101, 100, 101])
  })
  it('a missing batch or a batch with the wrong number of sheets is an error, never a shorter PDF', async () => {
    await expect(mergeRunBatches([await pdfWithPages(2)], plan)).rejects.toMatchObject({ code: 'INCOMPLETE' })
    await expect(mergeRunBatches([await pdfWithPages(2), await pdfWithPages(1)], plan)).rejects.toBeInstanceOf(PrintRunError)
    await expect(mergeRunBatches([await pdfWithPages(1), await pdfWithPages(2)], plan)).rejects.toMatchObject({ code: 'SHEET_MISMATCH' })
  })
})

describe('text-overflow warnings never change the design', () => {
  const badge = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge')!
  const nameEl = badge.design.elements.find(e => e.type === 'text' && (e.properties.text ?? '').includes('{{name}}'))!
  it('fits → no warning; too many lines → height; an unbreakable word → width', async () => {
    const measure = await createTextMeasurer()
    const doc = normalizeDesign(badge.canvas, badge.design, {})
    const before = JSON.stringify(doc)
    expect(analyzeTextOverflow(doc, { registration: { name: 'Asha Rao' } } as never, measure)).toEqual([])
    const long = Array.from({ length: 30 }, (_, i) => `Word${i}`).join(' ')
    expect(analyzeTextOverflow(doc, { registration: { name: long } } as never, measure)).toEqual([{ elementId: nameEl.id, kind: 'height' }])
    expect(analyzeTextOverflow(doc, { registration: { name: 'X'.repeat(120) } } as never, measure)).toEqual([{ elementId: nameEl.id, kind: 'width' }])
    expect(JSON.stringify(doc)).toBe(before)                                        // nothing mutated
  })
})

describe('source contracts', () => {
  const S = code(read('lib/printAssets/runs/service.ts'))
  it('runs store metadata only — no upload, no URL, no attendee fields', () => {
    for (const forbidden of ['uploadServerFile', 'getSignedUrl', 'firebaseStorageDownloadTokens', '.save(']) expect(S).not.toContain(forbidden)
    const T = read('lib/printAssets/runs/service.ts')
    const type = T.slice(T.indexOf('export interface PrintRun {'), T.indexOf('export type RunResult'))
    for (const f of ['name', 'email', 'phone', 'ticket', 'qr', 'url', 'path', 'bytes', 'formResponses']) {
      expect(type, f).not.toMatch(new RegExp(`\\n\\s+${f}\\w*\\s*[?:]`, 'i'))
    }
  })
  it('a plan is created with create() keyed by the request id — duplicates return the same run', () => {
    expect(S).toContain('printRunId(job.organizerUid, job.jobId, input.requestId)')
    expect(S).toContain('await runsCol().doc(runId).create(')
  })
  it('batches are rendered STRICTLY and completion requires every batch and the planned page count', () => {
    expect(code(read('lib/printAssets/generationJob.ts'))).toContain("renderCardsOnSheets(job, ids, spec, 'strict', limits)")
    expect(S).toContain("code: 'INCOMPLETE'")
    expect(S).toContain("code: 'PAGE_COUNT_MISMATCH'")
  })
  it('every new route requires `certificates`, checks ownership, and never reads a query token', () => {
    for (const f of [
      'app/api/organizer/print-jobs/[jobId]/runs/route.ts',
      'app/api/organizer/print-runs/[runId]/route.ts',
      'app/api/organizer/print-runs/[runId]/batches/[index]/route.ts',
      'app/api/organizer/print-runs/[runId]/complete/route.ts',
      'app/api/organizer/print-runs/[runId]/fail/route.ts',
    ]) {
      const src = code(read(f))
      expect(src, f).toContain("authorizeWorkspace(req, 'certificates')")
      expect(src, f).toMatch(/organizerUid !== authz\.workspaceUid|completePrintRun\(runId, authz\.workspaceUid|failPrintRun\(runId, authz\.workspaceUid/)
      expect(src, f).not.toMatch(/searchParams\.get\(\s*['"]token/)
    }
  })
  it('event deletion removes run history with its event', () => {
    expect(read('lib/events/eventDeletion.ts')).toContain("byEventId('printRuns')")
  })
})
