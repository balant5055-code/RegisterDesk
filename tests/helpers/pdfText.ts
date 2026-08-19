// Extracts the visible text from a pdf-lib–produced PDF.
//
// WHY THIS EXISTS. Asserting "the PDF is 2,343 bytes" or "it has one page" cannot tell an
// OLD attendee name from a NEW one — and that distinction is the whole question behind the
// "Download PDF still shows the old name" report. These helpers read the actual glyphs back
// out of the content stream so a test can assert on what a human would see.
//
// pdf-lib Flate-compresses content streams, so the bytes must be inflated before the text
// operators are visible. Standard (WinAnsi) fonts write their strings literally inside
// `(...)`, which is what makes this readable without a full PDF parser.

import { inflateSync } from 'node:zlib'

/** Every decompressed content stream in the document, as latin1 text. */
function contentStreams(pdf: Uint8Array): string[] {
  const raw = Buffer.from(pdf)
  const hay = raw.toString('latin1')
  const out: string[] = []
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null

  while ((m = re.exec(hay)) !== null) {
    const start = m.index + m[0].length
    const end   = hay.indexOf('endstream', start)
    if (end < 0) continue
    const slice = raw.subarray(start, end)
    try {
      out.push(inflateSync(slice).toString('latin1'))
    } catch {
      // Not a Flate stream (or not a content stream) — the uncompressed form is still usable.
      out.push(slice.toString('latin1'))
    }
  }
  return out
}

/** Unescape a PDF literal string: \( \) \\ and octal escapes. */
function unescapePdfString(s: string): string {
  return s
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
}

/**
 * All drawn text, in document order.
 *
 * pdf-lib emits HEX strings — `<52454749…> Tj` — rather than the literal `(...)` form, so
 * both are handled. (A test that only looked for `(...)` silently found nothing, which is a
 * far worse failure than an error: it would have made every content assertion vacuous.)
 */
export function extractPdfText(pdf: Uint8Array): string[] {
  const pieces: string[] = []
  for (const stream of contentStreams(pdf)) {
    const re = /<([0-9A-Fa-f\s]*)>\s*(?:Tj|TJ)|\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|TJ)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stream)) !== null) {
      if (m[1] !== undefined) {
        const hex = m[1].replace(/\s+/g, '')
        let s = ''
        for (let i = 0; i + 1 < hex.length; i += 2) {
          s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
        }
        pieces.push(s)
      } else if (m[2] !== undefined) {
        pieces.push(unescapePdfString(m[2]))
      }
    }
  }
  return pieces
}

/** The document's text as one searchable string. */
export function pdfTextContent(pdf: Uint8Array): string {
  return extractPdfText(pdf).join(' ')
}

/** True when `needle` appears in the rendered text. */
export function pdfContains(pdf: Uint8Array, needle: string): boolean {
  return pdfTextContent(pdf).includes(needle)
}
