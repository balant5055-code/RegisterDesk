// RD-RACEOPS-RESULTS-06 · PDF text extraction — SERVER ONLY.
//
// The ONE module that touches a PDF reader. Everything above it consumes `PdfPage[]`, so
// the reader is replaceable and the reconstruction algorithms are testable from literals
// with no PDF at all.
//
// ─── Why `unpdf` ────────────────────────────────────────────────────────────
// It wraps a serverless-ready pdf.js build: MIT, ~2 MB unpacked, ZERO dependencies, and
// `extractTextItems` returns each run's text WITH its x/y/width/height — which is what the
// column clustering needs. `pdfjs-dist` gives the same data but is ~35 MB unpacked and
// wants DOM shims; `pdf-lib`, already in this repo, only WRITES PDFs and has no text
// extraction at all.
//
// ─── Why server-only ────────────────────────────────────────────────────────
// A PDF reader is a large parser processing untrusted bytes. It stays on the server, where
// the upload is already authorized and size-capped, and never enters the organizer's
// bundle — the browser posts the file and receives a small cell matrix back.
//
// ─── Untrusted input ────────────────────────────────────────────────────────
// Only `getTextContent` is used: no rendering, no embedded JavaScript, no attachments, no
// outbound requests. `isEvalSupported: false` and `disableFontFace` keep the reader from
// compiling anything out of the document. Nothing is written to disk. PDF metadata (Author,
// Title) is never read, so a document cannot name a participant through it.

// Imported ONLY by the parse route (a Node runtime handler) and by tests. The `unpdf`
// import below is dynamic, so nothing in this module is reachable from a client bundle
// unless a client imports it — which nothing does, and which the parser shim exists to
// prevent (see pdfParser.ts).

import { pdfError, type PdfPage, type PdfParseError, type PdfTextItem } from './types'

/** Hard ceiling, matching the results upload cap. Bytes above this never reach the reader. */
export const PDF_MAX_BYTES = 15 * 1024 * 1024

/** Pages read per document. A results listing far longer than this is an XLSX job. */
export const PDF_MAX_PAGES = 200

export type ExtractOutcome =
  | { ok: true;  pages: PdfPage[] }
  | { ok: false; error: PdfParseError }

/**
 * Reads every page's text runs, with positions.
 *
 * The byte array is COPIED before it reaches the reader: pdf.js transfers the underlying
 * ArrayBuffer to its worker, which detaches the caller's view — a second read of the same
 * upload would otherwise fail with an opaque DataCloneError.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<ExtractOutcome> {
  if (bytes.byteLength === 0) return { ok: false, error: pdfError('PDF_EMPTY') }
  if (bytes.byteLength > PDF_MAX_BYTES) {
    return { ok: false, error: { code: 'PDF_TEXT_UNAVAILABLE', message: 'This PDF is too large to read.' } }
  }

  let raw: { totalPages: number; items: { str: string; x: number; y: number; width: number; height: number; fontSize: number }[][] }
  try {
    const { extractTextItems } = await import('unpdf')
    raw = await extractTextItems(Uint8Array.from(bytes))
  } catch {
    // A reader failure is reported as "no usable text" rather than surfaced: the message an
    // organizer needs is what to do next, and a pdf.js stack trace is neither actionable nor
    // safe to echo back.
    return { ok: false, error: pdfError('PDF_TEXT_UNAVAILABLE') }
  }

  if (!raw || !Array.isArray(raw.items) || raw.items.length === 0) {
    return { ok: false, error: pdfError('PDF_EMPTY') }
  }

  const pages: PdfPage[] = raw.items.slice(0, PDF_MAX_PAGES).map((items, index) => ({
    pageNumber: index + 1,
    items: (items ?? []).reduce<PdfTextItem[]>((out, i) => {
      // Defensive: every field is checked because it comes from a third-party file.
      if (typeof i?.str !== 'string' || i.str.trim() === '') return out
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      out.push({
        str: i.str, x: num(i.x), y: num(i.y),
        width: num(i.width), height: num(i.height),
        fontSize: num(i.fontSize) || 10,
      })
      return out
    }, []),
  }))

  return { ok: true, pages }
}
