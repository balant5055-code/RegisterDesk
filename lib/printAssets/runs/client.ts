// RD-PRINT-P3 · Browser side of a combined print run: plan → fetch every batch (with
// bounded retries) → verify → merge into ONE PDF → server-confirmed completion → download.
//
// The PDF is assembled in the browser's memory and handed to the user as a download; it is
// never uploaded or stored. It is produced ONLY when every batch arrived with exactly the
// planned number of sheets and the server confirms the run is complete — otherwise the run
// is marked failed and nothing is downloaded (never a silently incomplete PDF).
//
// Isomorphic apart from `downloadCombinedPrintRun` (browser APIs); `mergeRunBatches` is
// also used by the tests.

import type { SheetSpec } from '@/lib/printAssets/sheet/layout'
import type { PDFRef as PdfRef } from 'pdf-lib'
import { batchSheets } from './plan'

export interface RunPlanView {
  runId: string; status: string
  cardCount: number; perSheet: number; batchSize: number; batchCount: number; sheets: number
  skippedCount: number; skipped: { registrationId: string; reason: string }[]
  overflowCount: number
}

export class PrintRunError extends Error {
  constructor(message: string, readonly code: string, readonly registrationIds?: string[]) { super(message) }
}

/** Merge the batches IN ORDER into one PDF; refuses unless every batch and the total match the plan. */
export async function mergeRunBatches(batches: ArrayBuffer[], plan: Pick<RunPlanView, 'cardCount' | 'batchSize' | 'perSheet' | 'batchCount' | 'sheets'>): Promise<Uint8Array> {
  return (await mergeRunBatchesWithCount(batches, plan)).bytes
}

/**
 * RD-PRINT-AUDIT · the merge plus the merged document's ACTUAL page count, which is what the
 * browser reports to /complete — so the server checks the real PDF, not the plan against itself.
 */
export async function mergeRunBatchesWithCount(batches: ArrayBuffer[], plan: Pick<RunPlanView, 'cardCount' | 'batchSize' | 'perSheet' | 'batchCount' | 'sheets'>): Promise<{ bytes: Uint8Array; pageCount: number }> {
  if (batches.length !== plan.batchCount) throw new PrintRunError('A batch is missing — the PDF would be incomplete.', 'INCOMPLETE')
  const { PDFDocument } = await import('pdf-lib')
  const out = await PDFDocument.create()
  for (let i = 0; i < batches.length; i++) {
    const src = await PDFDocument.load(batches[i])
    const expected = batchSheets(plan.cardCount, plan.batchSize, plan.perSheet, i)
    if (src.getPageCount() !== expected) {
      throw new PrintRunError(`Batch ${i + 1} has ${src.getPageCount()} sheets; ${expected} were planned.`, 'SHEET_MISMATCH')
    }
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p)
  }
  if (out.getPageCount() !== plan.sheets) throw new PrintRunError('The merged PDF does not have the planned number of sheets.', 'SHEET_MISMATCH')
  await dedupeImages(out)
  const pageCount = out.getPageCount()
  return { bytes: await out.save(), pageCount }
}

type PdfDoc = Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>

/**
 * RD-PRINT-P4 — every batch embeds its own copy of each image (the logo), so a 26-batch run
 * carried the logo 26 times. After merging, an image whose BYTES, image dictionary (minus the
 * mask reference) and transparency mask are identical to one already kept is pointed at the
 * kept object and the duplicate is removed. Page content streams are not touched and the
 * kept object is byte-identical, so the rendered appearance cannot change.
 */
export async function dedupeImages(doc: PdfDoc): Promise<{ removed: number }> {
  const { PDFName, PDFDict, PDFRef, PDFRawStream } = await import('pdf-lib')
  const ctx = doc.context
  const keyOf = new Map<string, string>()            // ref → content key
  const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('')

  async function key(ref: PdfRef, depth = 0): Promise<string | null> {
    const memo = keyOf.get(ref.toString())
    if (memo !== undefined) return memo
    const obj = ctx.lookup(ref)
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image' || depth > 1) return null
    const parts: string[] = []
    for (const [k, v] of obj.dict.entries()) {
      if (k.toString() === '/SMask') continue
      parts.push(`${k.toString()}=${v.toString()}`)
    }
    parts.sort()
    const smask = obj.dict.get(PDFName.of('SMask'))
    const smaskKey = smask instanceof PDFRef ? await key(smask, depth + 1) : 'none'
    if (smaskKey === null) return null
    const digest = hex(await globalThis.crypto.subtle.digest('SHA-256', obj.contents.slice().buffer as ArrayBuffer))
    const k = `${digest}|${obj.contents.length}|${parts.join(';')}|${smaskKey}`
    keyOf.set(ref.toString(), k)
    return k
  }

  const kept = new Map<string, PdfRef>()   // content key → kept ref
  const keptRefs = new Set<string>()
  const dropped = new Map<string, PdfRef>()
  for (const page of doc.getPages()) {
    const xo = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    if (!xo) continue
    for (const [name, ref] of xo.entries()) {
      if (!(ref instanceof PDFRef)) continue
      const k = await key(ref)
      if (!k) continue
      const first = kept.get(k)
      if (!first) { kept.set(k, ref); keptRefs.add(ref.toString()); continue }
      if (first.toString() === ref.toString()) continue
      xo.set(name, first)
      dropped.set(ref.toString(), ref)
    }
  }
  // Remove each duplicate and its (equally duplicate) mask — never anything still kept.
  let removed = 0
  for (const ref of dropped.values()) {
    if (keptRefs.has(ref.toString())) continue
    const obj = ctx.lookup(ref)
    const smask = obj instanceof PDFRawStream ? obj.dict.get(PDFName.of('SMask')) : undefined
    ctx.delete(ref); removed++
    if (smask instanceof PDFRef && !keptRefs.has(smask.toString()) && ![...kept.values()].some(r => {
      const o = ctx.lookup(r)
      return o instanceof PDFRawStream && o.dict.get(PDFName.of('SMask'))?.toString() === smask.toString()
    })) { ctx.delete(smask); removed++ }
  }
  return { removed }
}

const RETRIES = 2

async function fetchBatch(url: string, headers: Record<string, string>): Promise<ArrayBuffer> {
  let last: PrintRunError | null = null
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, cache: 'no-store' })
    } catch {
      last = new PrintRunError('Network error while downloading the print sheets.', 'NETWORK'); continue
    }
    if (res.ok) return res.arrayBuffer()
    const d = await res.json().catch(() => ({})) as { error?: string; code?: string; registrationIds?: string[] }
    last = new PrintRunError(d.error ?? `Batch failed (${res.status}).`, d.code ?? `HTTP_${res.status}`, d.registrationIds)
    if (res.status < 500) break            // 4xx: the plan or the request is wrong — retrying cannot help
  }
  throw last ?? new PrintRunError('Batch failed.', 'UNKNOWN')
}

/**
 * The whole browser flow. `requestId` must be generated ONCE per user action (a double
 * click or a retry of the same action then reuses the same run).
 */
export async function downloadCombinedPrintRun(input: {
  jobId: string; spec: SheetSpec; registrationIds?: string[]; requestId: string
  getToken: () => Promise<string>
  onPlan?: (plan: RunPlanView) => void
  onProgress?: (done: number, total: number) => void
}): Promise<{ plan: RunPlanView; filename: string }> {
  const auth = async () => ({ Authorization: `Bearer ${await input.getToken()}`, 'Content-Type': 'application/json' })
  const planRes = await fetch(`/api/organizer/print-jobs/${encodeURIComponent(input.jobId)}/runs`, {
    method: 'POST', headers: await auth(), cache: 'no-store',
    body: JSON.stringify({ requestId: input.requestId, sheet: input.spec, ...(input.registrationIds?.length ? { registrationIds: input.registrationIds } : {}) }),
  })
  const planBody = await planRes.json().catch(() => ({})) as { run?: RunPlanView; error?: string; code?: string }
  if (!planRes.ok || !planBody.run) throw new PrintRunError(planBody.error ?? 'Could not plan the print run.', planBody.code ?? 'PLAN_FAILED')
  const plan = planBody.run
  input.onPlan?.(plan)
  if (plan.status === 'failed') throw new PrintRunError('This print run failed. Start a new download.', 'RUN_FAILED')

  const base = `/api/organizer/print-runs/${encodeURIComponent(plan.runId)}`
  try {
    const batches: ArrayBuffer[] = []
    for (let i = 0; i < plan.batchCount; i++) {
      batches.push(await fetchBatch(`${base}/batches/${i}`, await auth()))
      input.onProgress?.(i + 1, plan.batchCount)
    }
    const { bytes: merged, pageCount } = await mergeRunBatchesWithCount(batches, plan)   // the REAL count
    const done = await fetch(`${base}/complete`, { method: 'POST', headers: await auth(), body: JSON.stringify({ pageCount }) })
    if (!done.ok) {
      const d = await done.json().catch(() => ({})) as { error?: string; code?: string }
      throw new PrintRunError(d.error ?? 'The server could not confirm the print run.', d.code ?? 'COMPLETE_FAILED')
    }
    const filename = `print-sheets-${plan.cardCount}-cards.pdf`
    const href = URL.createObjectURL(new Blob([merged as BlobPart], { type: 'application/pdf' }))
    const a = document.createElement('a'); a.href = href; a.download = filename; a.click()
    setTimeout(() => URL.revokeObjectURL(href), 30_000)
    return { plan, filename }
  } catch (err) {
    const e = err instanceof PrintRunError ? err : new PrintRunError(err instanceof Error ? err.message : 'Print run failed.', 'UNKNOWN')
    // Best effort; the server stores a fixed message (no client text), and a token error here
    // must not replace the real error the user is shown.
    try { await fetch(`${base}/fail`, { method: 'POST', headers: await auth(), body: '{}' }) } catch { /* best effort */ }
    throw e
  }
}
