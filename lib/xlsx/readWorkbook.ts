// RD-RESULTS-XLSX-01 · The one place the app reads an .xlsx workbook in the browser.
//
// Wraps `read-excel-file/browser` with the OOXML inline-string repair in
// lib/xlsx/inlineStrings.ts, so a workbook whose text cells use inline strings — the
// normal output of many timing systems, and of any sheet with mixed formatting — parses
// instead of failing the whole upload. See that file for the root cause.
//
// `fflate` is not a new dependency in effect: `read-excel-file` already unzips with it,
// so it is in the bundle either way. It is declared directly because this module now
// imports it directly.
//
// COST: one extra unzip per workbook. A sheet needing no repair is passed through as the
// ArrayBuffer we already read, so nothing is re-zipped and the bytes handed to the
// library are the file's own. Only a workbook that actually contains an unreadable
// inline-string cell is repacked, and then STORED (level 0) — the library unzips it
// again immediately, so spending CPU on deflate would buy nothing.

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { normalizeInlineStrings } from './inlineStrings'

/** A cell as `read-excel-file` yields it. */
export type WorkbookCell = string | number | boolean | Date | null

export interface WorkbookSheetData {
  sheet: string
  data:  WorkbookCell[][]
}

/** Worksheet parts, the only parts that carry cells. */
const WORKSHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/

/**
 * Returns bytes to hand to the reader: the original ArrayBuffer when no repair was
 * needed, otherwise a repacked archive. Never throws — a workbook this cannot unzip is
 * passed through untouched so the library produces its own diagnosis, which
 * `describeWorkbookError` already translates for the organizer.
 */
export function repairWorkbook(source: ArrayBuffer): ArrayBuffer {
  let parts: Record<string, Uint8Array>
  try {
    parts = unzipSync(new Uint8Array(source))
  } catch {
    return source
  }

  const repaired: Record<string, Uint8Array> = {}
  let changed = false

  for (const name of Object.keys(parts)) {
    const data = parts[name]
    if (!WORKSHEET_PART.test(name)) { repaired[name] = data; continue }

    const xml   = strFromU8(data)
    const fixed = normalizeInlineStrings(xml)
    if (fixed === xml) { repaired[name] = data; continue }

    repaired[name] = strToU8(fixed)
    changed = true
  }

  if (!changed) return source

  const packed = zipSync(repaired, { level: 0 })
  return packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer
}

/**
 * Reads every sheet of an .xlsx file. Same return shape as `readXlsxFile`, so this is a
 * drop-in for a call that already used it.
 */
export async function readWorkbookSheets(file: Blob): Promise<WorkbookSheetData[]> {
  const readXlsxFile = (await import('read-excel-file/browser')).default
  const source = repairWorkbook(await file.arrayBuffer())
  return (await readXlsxFile(source)) as unknown as WorkbookSheetData[]
}

/** Rows of the first sheet — the shape `readSheet()` returns. */
export async function readWorkbookFirstSheet(file: Blob): Promise<WorkbookCell[][]> {
  const sheets = await readWorkbookSheets(file)
  return sheets[0]?.data ?? []
}
