// RD-PRINT-P4 — print-run reliability: image de-duplication (appearance unchanged), the stale
// (abandoned) rule, history status/messages, and what the reconciliation may touch.
// Behaviour on real emulators: tests/emulator/printRuns.emu.test.ts (Phase 4 section).

import { describe, it, expect, vi } from 'vitest'
import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import { PDFDocument, PDFName, PDFDict, PDFRef, PDFArray, PDFRawStream } from 'pdf-lib'
import { Timestamp } from 'firebase-admin/firestore'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import { dedupeImages, mergeRunBatches } from '@/lib/printAssets/runs/client'
import { isStalePrintRun, toPrintRunView, RUN_STALE_MS, PRINT_RUN_ERROR_MESSAGES, type PrintRun } from '@/lib/printAssets/runs/service'
import { planBatches, batchSlice } from '@/lib/printAssets/runs/plan'
import { normalizeDesign, renderSheetsToPdf } from '@/lib/printAssets/render'
import { computeSheetLayout } from '@/lib/printAssets/sheet/layout'
import { cardSizeMm } from '@/lib/printAssets/cardDimensions'
import { PRINT_COLLECTIONS } from '@/lib/printAssets/collections'

const read = (f: string) => readFileSync(f, 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

function png(w: number, h: number): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = (x * 3) & 255; raw[o + 1] = (y * 5) & 255; raw[o + 2] = 90; raw[o + 3] = (x + y) & 255 }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

// Branded batches exactly as the batch route produces them (logo with transparency + QR + text).
async function brandedBatches(cards: number, batchCards: number) {
  const LOGO = 'https://firebasestorage.googleapis.com/v0/b/demo/o/organizer-assets%2Fu%2Flogo.png?alt=media'
  const badge = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge')!
  const design = { ...badge.design, elements: [...badge.design.elements, { id: 'logo', type: 'image', x: 0.06, y: 0.82, width: 0.4, height: 0.14, rotation: 0, visible: true, locked: false, zIndex: 50, properties: { text: '{{logo}}', fit: 'contain' } }] }
  const doc = normalizeDesign(badge.canvas, design as never, {})
  const L = computeSheetLayout(cardSizeMm(badge.canvas), { paper: 'A4', orientation: 'portrait', marginMm: 10, gapMm: 4, cropMarks: true })
  if (!L.ok) throw new Error(L.error)
  const p = planBatches(cards, L.layout.perSheet, batchCards)
  if (!p.ok) throw new Error(p.error)
  const ids = Array.from({ length: cards }, (_, i) => i)
  const assets = new Map([[LOGO, png(240, 120)]])
  const batches: ArrayBuffer[] = []
  for (let b = 0; b < p.plan.batchCount; b++) {
    const { bytes } = await renderSheetsToPdf({
      document: doc, assets, layout: L.layout,
      cards: batchSlice(ids, p.plan.batchSize, b).map(i => ({ registration: { name: `Holder ${i}`, ticket: `T-${i}` }, system: { qr: `RD:e:r${i}:T-${i}` }, branding: { logo: LOGO } }) as never),
    })
    batches.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  }
  return { batches, plan: { cardCount: cards, perSheet: L.layout.perSheet, ...p.plan } }
}

async function pageSnapshot(pdf: PDFDocument) {
  // Per page: the decoded content stream, and for every XObject name the referenced image's bytes (+ its mask's).
  const out: { content: string; images: Record<string, string> }[] = []
  for (const p of pdf.getPages()) {
    const c = p.node.Contents()
    const streams = c instanceof PDFArray ? c.asArray().map(r => pdf.context.lookup(r)) : [c]
    let content = ''
    for (const st of streams) if (st instanceof PDFRawStream) {
      const raw = Buffer.from(st.contents)
      content += (st.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode' ? zlib.inflateSync(raw) : raw).toString('latin1')
    }
    const images: Record<string, string> = {}
    const xo = p.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    for (const [name, ref] of xo?.entries() ?? []) {
      const obj = ref instanceof PDFRef ? pdf.context.lookup(ref) : null
      if (!(obj instanceof PDFRawStream)) continue
      const mask = obj.dict.get(PDFName.of('SMask'))
      const maskObj = mask instanceof PDFRef ? pdf.context.lookup(mask) : null
      images[name.toString()] = Buffer.from(obj.contents).toString('base64') + '|' + (maskObj instanceof PDFRawStream ? Buffer.from(maskObj.contents).toString('base64') : '')
    }
    out.push({ content, images })
  }
  return out
}
const imageObjectCount = (pdf: PDFDocument) => {
  const refs = new Set<string>()
  for (const p of pdf.getPages()) {
    const xo = p.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    for (const [, ref] of xo?.entries() ?? []) if (ref instanceof PDFRef) refs.add(ref.toString())
  }
  return refs.size
}

describe('image de-duplication keeps the rendered appearance identical', () => {
  it('a 3-batch branded run: one logo object instead of three, same page content and same image bytes, smaller file', async () => {
    const { batches } = await brandedBatches(30, 9)                                 // 4 batches
    // Reference: the merge WITHOUT de-duplication.
    const plain = await PDFDocument.create()
    for (const b of batches) { const s = await PDFDocument.load(b); for (const p of await plain.copyPages(s, s.getPageIndices())) plain.addPage(p) }
    const before = await pageSnapshot(plain)
    const plainBytes = await plain.save()
    expect(imageObjectCount(plain)).toBe(4)

    const { removed } = await dedupeImages(plain)
    expect(removed).toBeGreaterThanOrEqual(3)                                      // 3 duplicate logos (+ their masks)
    const after = await pageSnapshot(plain)
    expect(after).toEqual(before)                                                  // content streams AND image bytes, page by page
    expect(imageObjectCount(plain)).toBe(1)
    const dedupedBytes = await plain.save()
    expect(dedupedBytes.length).toBeLessThan(plainBytes.length)
    // And the saved file still parses with the same pages.
    const reloaded = await PDFDocument.load(dedupedBytes)
    expect(reloaded.getPageCount()).toBe(4)
    expect(await pageSnapshot(reloaded)).toEqual(before)
  }, 60_000)

  it('mergeRunBatches de-duplicates as part of every merge', async () => {
    const { batches, plan } = await brandedBatches(30, 9)
    const merged = await PDFDocument.load(await mergeRunBatches(batches, plan))
    expect(imageObjectCount(merged)).toBe(1)
    expect(merged.getPageCount()).toBe(plan.sheets)
  }, 60_000)

  it('different images are never merged', async () => {
    const d = await PDFDocument.create()
    const a = await d.embedPng(png(10, 10)), b = await d.embedPng(png(11, 10))
    d.addPage([100, 100]).drawImage(a, { x: 0, y: 0, width: 10, height: 10 })
    d.addPage([100, 100]).drawImage(b, { x: 0, y: 0, width: 10, height: 10 })
    expect((await dedupeImages(d)).removed).toBe(0)
    expect(imageObjectCount(d)).toBe(2)
  })
})

describe('abandoned (stale) runs', () => {
  const at = (msAgo: number) => Timestamp.fromMillis(Date.now() - msAgo)
  it('only a PLANNED run idle for longer than RUN_STALE_MS is stale', () => {
    expect(isStalePrintRun({ status: 'planned', updatedAt: at(RUN_STALE_MS + 60_000) })).toBe(true)
    expect(isStalePrintRun({ status: 'planned', updatedAt: at(RUN_STALE_MS - 60_000) })).toBe(false)
    expect(isStalePrintRun({ status: 'planned', createdAt: at(RUN_STALE_MS + 60_000) })).toBe(true)      // falls back to createdAt
    expect(isStalePrintRun({ status: 'planned' })).toBe(false)                                         // no timestamp → never guessed
    for (const s of ['completed', 'failed', 'expired'] as const) expect(isStalePrintRun({ status: s, updatedAt: at(10 * RUN_STALE_MS) })).toBe(false)
  })
  it('history shows a status label and a plain-language message for every terminal state', () => {
    const base = { runId: 'r', jobId: 'j', templateVersion: 1, sheet: {}, cardCount: 1, perSheet: 9, batchSize: 9, batchCount: 1, sheets: 1, skippedCount: 0, skipped: [], overflowCount: 0, overflow: [], renderedBatches: [] } as unknown as PrintRun
    expect(toPrintRunView({ ...base, status: 'completed', error: null, errorCode: null })).toMatchObject({ statusLabel: 'Downloaded', message: null })
    expect(toPrintRunView({ ...base, status: 'expired', error: 'x', errorCode: 'ABANDONED' })).toMatchObject({ statusLabel: 'Abandoned — nothing downloaded', message: PRINT_RUN_ERROR_MESSAGES.ABANDONED })
    expect(toPrintRunView({ ...base, status: 'failed', error: 'x', errorCode: 'REGISTRATION_CHANGED' }).message).toContain('cancelled, refunded or removed')
  })
})

describe('the reconciliation touches only stale run metadata', () => {
  const S = code(read('lib/printAssets/runs/service.ts'))
  it('expiry writes only status / error / errorCode / updatedAt of a printRuns document, in a transaction', () => {
    const fn = S.slice(S.indexOf('async function expireIfStale('), S.indexOf('export async function reconcileStalePrintRuns('))
    expect(fn).toContain('adminDb.runTransaction')
    expect(fn).toContain("tx.update(ref, { status: 'expired', error, errorCode: 'ABANDONED', updatedAt: FieldValue.serverTimestamp() })")
    expect(fn).toContain('const ref = runsCol().doc(run.runId)')
    const sweep = S.slice(S.indexOf('export async function reconcileStalePrintRuns('), S.indexOf('export async function listPrintRunsForJob('))
    expect(sweep).toContain("runsCol().where('status', '==', 'planned')")
    for (const forbidden of ['registrations', 'printGenerationJobs', 'printTemplates', 'bucket', '.delete(', '.set(']) {
      expect(fn + sweep, forbidden).not.toContain(forbidden)
    }
  })
  it('the cron route is fail-closed and calls only the reconciliation', () => {
    const R = code(read('app/api/cron/print-runs-reconcile/route.ts'))
    expect(R).toContain('if (!isAuthorizedCron(req)) return cronUnauthorized()')
    expect(R).toContain('reconcileStalePrintRuns({ limit: MAX_PER_TICK })')
  })
})
