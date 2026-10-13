// RD-PRINT-AUDIT — unit and source contracts for the final-audit fixes. The behaviour on real
// routes / Firestore / Storage / Auth is proven in tests/emulator/printAuditFixes.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { sameCanvas } from '@/lib/printAssets/cardDimensions'
import { mergeRunBatchesWithCount, mergeRunBatches } from '@/lib/printAssets/runs/client'
import type { PrintCanvas } from '@/lib/printAssets/types'

const read = (f: string) => readFileSync(f, 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('FIX 1 · the template form sends the card size only when it changed', () => {
  const cr80: PrintCanvas = { preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait' }
  it('sameCanvas: equal when every field matches (numeric strings tolerated), different otherwise', () => {
    expect(sameCanvas(cr80, { ...cr80 })).toBe(true)
    expect(sameCanvas(cr80, { ...cr80, width: '54' as unknown as number })).toBe(true)
    expect(sameCanvas(cr80, { ...cr80, width: 55 })).toBe(false)
    expect(sameCanvas(cr80, { ...cr80, height: 86 })).toBe(false)
    expect(sameCanvas(cr80, { ...cr80, orientation: 'landscape' })).toBe(false)
    expect(sameCanvas(cr80, { ...cr80, unit: 'in' })).toBe(false)
    expect(sameCanvas(cr80, { ...cr80, preset: 'CUSTOM' })).toBe(false)
  })
  it('the edit form omits an unchanged canvas from the PATCH body', () => {
    const src = code(read('app/(dashboard)/dashboard/print-assets/PrintAssetsClient.tsx'))
    expect(src).toContain('const canvasChanged = !original || !sameCanvas(original.canvas, canvas)')
    expect(src).toContain('...(canvasChanged ? { canvas } : {})')
  })
})

describe('FIX 2 · "Regenerate selected" re-renders from the job\'s pinned version', () => {
  it('posts to the job\'s retry route in regenerate mode, never a new job from the template', () => {
    const src = code(read('app/(dashboard)/dashboard/print-assets/operations/PrintOpsClient.tsx'))
    expect(src).toContain("`/api/organizer/print-jobs/${encodeURIComponent(assetJobId)}/retry`, { mode: 'regenerate', registrationIds: [...selected] }")
    // the regenerate action no longer creates a job from the (possibly edited/archived/deleted) template
    const regenLine = src.split('\n').find(l => l.includes('act(`regen`'))!
    expect(regenLine).not.toContain('templateId')
  })
})

describe('FIX 3 · completed runs are final (source contract)', () => {
  const src = code(read('lib/printAssets/runs/service.ts'))
  it('a completed run refuses batches; a terminal batch failure only fails a still-planned run', () => {
    expect(src).toContain("if (run.status === 'completed') return { ok: false, status: 409, code: 'RUN_COMPLETED'")
    expect(src).toContain("if ((snap.data() as PrintRun | undefined)?.status !== 'planned') return")
    expect(src).not.toMatch(/await ref\.update\(\{ status: 'failed'/)
  })
})

describe('FIX 4 · /complete receives the merged PDF\'s ACTUAL page count', () => {
  const pdfWithPages = async (n: number) => {
    const d = await PDFDocument.create()
    for (let i = 0; i < n; i++) d.addPage([100 + i, 100])
    const b = await d.save()
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }
  const plan = { cardCount: 30, perSheet: 9, batchSize: 18, batchCount: 2, sheets: 4 }
  it('returns the real page count of the merged document, and the same bytes as mergeRunBatches', async () => {
    const batches = [await pdfWithPages(2), await pdfWithPages(2)]
    const { bytes, pageCount } = await mergeRunBatchesWithCount(batches, plan)
    expect(pageCount).toBe(4)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(pageCount)
    expect((await PDFDocument.load(await mergeRunBatches(batches, plan))).getPageCount()).toBe(4)
  })
  it('the download flow reports the merge\'s count, not the plan\'s', () => {
    const src = code(read('lib/printAssets/runs/client.ts'))
    expect(src).toContain('const { bytes: merged, pageCount } = await mergeRunBatchesWithCount(batches, plan)')
    expect(src).toContain('body: JSON.stringify({ pageCount })')
    expect(src).not.toContain('const pageCount = plan.sheets')
  })
})

describe('HARDENING · no raw exception text in stored history', () => {
  it('generation stores fixed or design-only messages; runs store fixed messages; client reasons are ignored', () => {
    const gen = code(read('lib/printAssets/generationJob.ts'))
    expect(gen).toContain("export const CARD_RENDER_FAILED_MESSAGE = 'The card could not be rendered.'")
    expect(gen).not.toMatch(/error: (?:\(?err as Error\)?|err)\.message/)
    expect(gen).not.toMatch(/console\.(error|warn)\([^)]*err\.message/)
    const runs = code(read('lib/printAssets/runs/service.ts'))
    expect(runs).toContain('const error = PRINT_RUN_ERROR_MESSAGES.CLIENT_ABORTED')
    expect(runs).not.toContain('out.error.slice(')
    expect(runs).not.toContain('String(it.error)')
    const client = code(read('lib/printAssets/runs/client.ts'))
    expect(client).toContain("await fetch(`${base}/fail`, { method: 'POST', headers: await auth(), body: '{}' })")
  })
})
