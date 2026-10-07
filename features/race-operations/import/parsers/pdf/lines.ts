// RD-RACEOPS-RESULTS-06 · Text items → visual lines.
//
// PURE. The first step of every PDF reconstruction, shared by the table reader and the
// runner-block reader so "what is a line" is decided once.
//
// ─── Why clustering and not equality ─────────────────────────────────────────
// Producers rarely place a row's cells on exactly the same baseline: a superscript, a
// different font size, or a rotated glyph shifts y by a fraction of a point. Grouping on
// `y === y` therefore splits one row into three, and every column then lands in the wrong
// place. Items are clustered with a tolerance derived from the text's OWN size, so a
// 6-point footnote and a 14-point heading are each judged on their own scale rather than
// against a constant that happens to suit one document.

import type { PdfLine, PdfPage, PdfTextItem } from './types'

/** A baseline this far apart (relative to font size) is a different line. */
const LINE_TOLERANCE_RATIO = 0.6
/** Floor for tiny or missing font sizes, in points. */
const MIN_LINE_TOLERANCE = 1.5

const isBlank = (s: string) => s.trim() === ''

/** Median, used rather than the mean so one 40-point title cannot set the tolerance. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Groups one page's items into lines, top to bottom, each ordered left to right.
 *
 * Whitespace-only items are dropped: pdf.js emits them as separators between runs, and
 * they carry no meaning once items are grouped — but their POSITIONS are exactly what the
 * column reader uses, so they are removed here and nowhere earlier.
 */
export function linesOfPage(page: PdfPage): PdfLine[] {
  const items = page.items.filter(i => !isBlank(i.str))
  if (items.length === 0) return []

  const tolerance = Math.max(MIN_LINE_TOLERANCE, median(items.map(i => i.fontSize)) * LINE_TOLERANCE_RATIO)

  // Top to bottom: PDF y grows upwards, so descending y is reading order.
  const byY = [...items].sort((a, b) => b.y - a.y)

  const lines: PdfTextItem[][] = []
  let current: PdfTextItem[] = [byY[0]]
  let anchor = byY[0].y

  for (const item of byY.slice(1)) {
    if (Math.abs(item.y - anchor) <= tolerance) {
      current.push(item)
      // The anchor follows the line's own drift so a long row of slightly-stepped cells
      // stays one line instead of splitting halfway across the page.
      anchor = (anchor + item.y) / 2
    } else {
      lines.push(current)
      current = [item]
      anchor = item.y
    }
  }
  lines.push(current)

  return lines.map(group => {
    const ordered = [...group].sort((a, b) => a.x - b.x)
    return {
      pageNumber: page.pageNumber,
      y:          ordered[0].y,
      items:      ordered,
      text:       ordered.map(i => i.str.trim()).filter(s => s !== '').join(' ').replace(/\s+/g, ' ').trim(),
    }
  })
}

/** Every page's lines, in document order. */
export function linesOfDocument(pages: readonly PdfPage[]): PdfLine[] {
  return pages.flatMap(linesOfPage)
}

/**
 * The typical vertical gap between consecutive lines on a page.
 *
 * Used to tell "the next row" from "a new section": a gap much larger than typical is a
 * structural break, which is one of the signals the runner-block reader uses instead of
 * trusting a participant's name to mark a boundary.
 */
export function medianLineGap(lines: readonly PdfLine[]): number {
  const gaps: number[] = []
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].pageNumber !== lines[i - 1].pageNumber) continue
    const gap = lines[i - 1].y - lines[i].y
    if (gap > 0) gaps.push(gap)
  }
  return median(gaps)
}

/**
 * Lines a results reader must ignore: page numbers, "Page 3 of 12", bare dates, and the
 * decorative one-liners producers put in headers and footers.
 *
 * Deliberately conservative — a line is only dropped when it is a SINGLE item and matches a
 * known furniture pattern. A real result row has several cells, so it can never match.
 */
const FURNITURE = [
  /^page\s+\d+(\s*(of|\/)\s*\d+)?$/i,
  /^\d{1,3}$/,                                  // a bare page number
  /^[-–—]\s*\d{1,3}\s*[-–—]$/,                  // "- 3 -"
  /^(printed|generated|created)\b.*$/i,
  /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}(\s+\d{1,2}:\d{2}(:\d{2})?)?$/,   // a bare timestamp
  /^https?:\/\/\S+$/i,                          // a bare URL line — never followed, never imported
]

export function isPageFurniture(line: PdfLine): boolean {
  if (line.items.length !== 1) return false
  const text = line.text.trim()
  if (text === '') return true
  return FURNITURE.some(re => re.test(text))
}
