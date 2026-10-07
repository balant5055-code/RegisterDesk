// RD-RACEOPS-RESULTS-06 · Pages → the two cell matrices the existing pipeline consumes.
//
// PURE. Decides only HOW the document is laid out, then hands off:
//
//   a flat table   → table.ts       (column clustering from the header's own positions)
//   runner blocks  → blocks.ts      (label/value, with per-runner split sub-tables)
//
// Table first, because a results listing is the common export and its header is a strong,
// checkable signal. Blocks are tried when no header is found — a per-runner PDF has no
// table header at all, so "no header" is information, not a failure.

import { linesOfDocument } from './lines'
import { readTable } from './table'
import { readBlocks } from './blocks'
import { pdfError, type PdfPage, type PdfParseError, type PdfReconstruction } from './types'

export type ReconstructOutcome =
  | { ok: true;  value: PdfReconstruction; labelMap: Record<string, string> }
  | { ok: false; error: PdfParseError }

/** How many non-blank characters a document must hold before it is worth reading. */
const MIN_TEXT_CHARS = 12

export function reconstruct(pages: readonly PdfPage[]): ReconstructOutcome {
  if (pages.length === 0) return { ok: false, error: pdfError('PDF_EMPTY') }

  const characters = pages.reduce(
    (n, p) => n + p.items.reduce((m, i) => m + i.str.trim().length, 0), 0,
  )
  // A scanned page yields a page object with no text items at all. That is the ONLY
  // honest diagnosis available without OCR, and it is the one the organizer is given.
  if (characters < MIN_TEXT_CHARS) return { ok: false, error: pdfError('PDF_TEXT_UNAVAILABLE') }

  const lines = linesOfDocument(pages)
  if (lines.length === 0) return { ok: false, error: pdfError('PDF_TEXT_UNAVAILABLE') }

  const table = readTable(lines)
  if (table.ok) {
    return {
      ok: true,
      labelMap: {},
      value: { shape: 'table', results: table.matrix, splits: null, pagesUsed: table.pagesUsed },
    }
  }

  const blocks = readBlocks(lines)
  if (blocks.ok) {
    return {
      ok: true,
      labelMap: blocks.labelMap,
      value: { shape: 'blocks', results: blocks.results, splits: blocks.splits, pagesUsed: blocks.pagesUsed },
    }
  }

  // There IS text, but neither a table header nor a runner block could be identified.
  // Which failure to report depends on what was nearly found: a header with no rows under
  // it is a table problem; no header at all is a block problem.
  return { ok: false, error: pdfError(table.matrix.length > 0 ? 'PDF_TABLE_UNRECOGNIZED' : 'PDF_RUNNER_BLOCK_UNRECOGNIZED') }
}
