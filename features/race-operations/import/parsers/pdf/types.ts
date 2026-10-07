// RD-RACEOPS-RESULTS-06 · PDF import — the shared vocabulary.
//
// PURE. No SDK, no I/O, no DOM. The extraction layer (server-only, unpdf) produces these
// shapes; every reconstruction step below consumes only these, so the whole algorithm is
// testable from a literal without a PDF reader — and swapping the reader later touches one
// file.

/**
 * One run of text as the PDF itself positions it.
 *
 * Coordinates are PDF user space: origin BOTTOM-LEFT, y grows upwards. Reconstruction
 * therefore sorts lines by DESCENDING y. Kept as-is rather than flipped, because the
 * numbers then match what a PDF inspector shows when someone is debugging a real file.
 */
export interface PdfTextItem {
  str:      string
  x:        number
  y:        number
  width:    number
  height:   number
  fontSize: number
}

export interface PdfPage {
  /** 1-based, as a human would cite it. */
  pageNumber: number
  items:      readonly PdfTextItem[]
}

/**
 * One visual line: the items that share a baseline, in reading order.
 *
 * `text` is the line with single spaces between items — used for heuristics (is this a page
 * footer?) and for the whitespace fallback when a producer emits a whole row as ONE item.
 */
export interface PdfLine {
  pageNumber: number
  /** Baseline, for vertical-gap reasoning. */
  y:          number
  items:      readonly PdfTextItem[]
  text:       string
}

// ─── Parse failures ───────────────────────────────────────────────────────────

/**
 * Why a PDF could not become rows. These are PARSE-stage failures — the file could not be
 * read as results at all.
 *
 * Everything that IS readable but wrong — a missing bib, a duplicate bib, an unreadable
 * time, a broken split — deliberately does NOT get a PDF-specific code. Those rows are
 * emitted and fail through the EXISTING validation vocabulary (`MISSING_BIB`,
 * `DUPLICATE_BIB`, `INVALID_TIME`, `SPLIT_*`, and the start-list gate), so a PDF import
 * reports its problems in exactly the words a CSV or XLSX import does and the organizer
 * learns one set of fixes.
 */
export type PdfParseErrorCode =
  | 'PDF_TEXT_UNAVAILABLE'
  | 'PDF_TABLE_UNRECOGNIZED'
  | 'PDF_RUNNER_BLOCK_UNRECOGNIZED'
  | 'PDF_EMPTY'

export interface PdfParseError {
  code:    PdfParseErrorCode
  /** Organizer-facing. Never a stack trace, never a file path. */
  message: string
}

export const PDF_PARSE_MESSAGES: Readonly<Record<PdfParseErrorCode, string>> = {
  PDF_EMPTY:
    'This PDF has no pages to read.',
  PDF_TEXT_UNAVAILABLE:
    'This PDF appears to be scanned or image-based. Text PDF import is currently supported; OCR is not supported. Export the results as XLSX or CSV, or ask your timing provider for a text PDF.',
  PDF_TABLE_UNRECOGNIZED:
    'No results table was found in this PDF. The columns could not be identified — check that the file is the results listing rather than a summary or certificate, or upload the XLSX your timing provider produced.',
  PDF_RUNNER_BLOCK_UNRECOGNIZED:
    'This PDF has text but no recognisable result rows. RegisterDesk could not tell one participant from the next, so nothing was imported.',
}

export const pdfError = (code: PdfParseErrorCode): PdfParseError =>
  ({ code, message: PDF_PARSE_MESSAGES[code] })

/** What reconstruction produces: cell matrices ready for the EXISTING `tabulate()`. */
export interface PdfReconstruction {
  /** How the document was read — reported to the organizer, and useful in a bug report. */
  shape:  'table' | 'blocks'
  /** Header row first, exactly as `tabulate` expects. */
  results: string[][]
  /** The splits sheet equivalent, or null when the PDF carried no checkpoints. */
  splits:  string[][] | null
  /** Pages that contributed rows — so "we read 3 of 5 pages" is answerable. */
  pagesUsed: number
}
