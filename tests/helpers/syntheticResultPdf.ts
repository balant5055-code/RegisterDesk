// RD-RACEOPS-RESULTS-06 · SYNTHETIC result PDFs for parser tests.
//
// ⚠ THESE ARE NOT REAL TIMING-PROVIDER DOCUMENTS.
//
// They are written here with pdf-lib — the repo's existing PDF *writer* — purely to give the
// reader something structurally representative to read: real text runs at real coordinates,
// laid out the way a results listing and a per-runner result page are laid out. They prove
// the reconstruction algorithms behave; they prove NOTHING about any named provider's actual
// export, and no test may describe them as such.
//
// Real timing-provider PDF parity is deliberately out of reach until a real file is supplied
// (see RD-RACEOPS-RESULTS-07).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

const A4: [number, number] = [595, 842]
const SIZE = 9.5
const TOP = 790
const LINE = 16

/** One page's worth of drawing helpers, in PDF coordinates (origin bottom-left). */
interface Pen {
  page: PDFPage
  font: PDFFont
  y:    number
}

function text(pen: Pen, x: number, value: string, size = SIZE): void {
  if (value === '') return
  pen.page.drawText(value, { x, y: pen.y, size, font: pen.font, color: rgb(0, 0, 0) })
}

/** Draws one row of cells at fixed column x positions — a normal table layout. */
function row(pen: Pen, columns: readonly number[], cells: readonly string[], size = SIZE): void {
  cells.forEach((cell, i) => text(pen, columns[i] ?? columns[columns.length - 1], cell, size))
  pen.y -= LINE
}

export interface TableRunner {
  rank?: string
  bib: string
  name: string
  gender?: string
  category?: string
  ageGroup?: string
  distance?: string
  gun?: string
  net?: string
  status?: string
}

/**
 * A FLAT results listing: one header row, one row per runner, repeated page headers, and a
 * page footer — the shape most "download results" PDFs take.
 */
export async function flatTablePdf(
  runners: readonly TableRunner[],
  opts: { rowsPerPage?: number; headerEveryPage?: boolean; footer?: boolean } = {},
): Promise<Uint8Array> {
  const { rowsPerPage = 30, headerEveryPage = true, footer = true } = opts
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const columns = [40, 80, 170, 250, 300, 360, 420, 480, 540]
  const headers = ['Rank', 'Bib', 'Participant Name', 'Gender', 'Category', 'Age Group', 'Distance', 'Gun Time', 'Net Time']
  const cellsOf = (r: TableRunner) => [
    r.rank ?? '', r.bib, r.name, r.gender ?? '', r.category ?? '', r.ageGroup ?? '',
    r.distance ?? '', r.gun ?? '', r.net ?? '',
  ]

  let page = doc.addPage(A4)
  let pen: Pen = { page, font, y: TOP }
  let onPage = 0
  let pageNo = 1

  const startPage = () => {
    pen.page.drawText('City Marathon 2026 — Official Results', { x: 40, y: TOP + 24, size: 12, font: bold })
    if (headerEveryPage || pageNo === 1) {
      const head: Pen = { page: pen.page, font: bold, y: pen.y }
      row(head, columns, headers)
      pen.y = head.y
    }
  }
  startPage()

  for (const r of runners) {
    if (onPage >= rowsPerPage) {
      if (footer) pen.page.drawText(`Page ${pageNo}`, { x: 290, y: 30, size: 8, font })
      page = doc.addPage(A4)
      pen = { page, font, y: TOP }
      onPage = 0
      pageNo++
      startPage()
    }
    row(pen, columns, cellsOf(r))
    onPage++
  }
  if (footer) pen.page.drawText(`Page ${pageNo}`, { x: 290, y: 30, size: 8, font })

  return doc.save()
}

export interface BlockSplit {
  split: string
  distance?: string
  timeOfDay?: string
  overall?: string
  lapDistance?: string
  lapTime?: string
}

export interface BlockRunner {
  name: string
  bib: string
  gender?: string
  ageGroup?: string
  category?: string
  distance?: string
  gun?: string
  net?: string
  /** Provider-calculated columns — present in the document, never imported. */
  overallRank?: string
  pace?: string
  speed?: string
  splits?: readonly BlockSplit[]
}

/**
 * A per-runner RESULT BLOCK document: label/value lines, then an optional split sub-table,
 * then a gap before the next runner. Several runners per page, to exercise the boundary
 * rules rather than relying on page breaks to separate them.
 */
export async function runnerBlockPdf(
  runners: readonly BlockRunner[],
  opts: { perPage?: number } = {},
): Promise<Uint8Array> {
  const { perPage = 2 } = opts
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const LABEL_X = 40
  const VALUE_X = 170
  const splitColumns = [40, 130, 220, 320, 420, 500]
  const splitHeaders = ['Split', 'Distance', 'Time of Day', 'Overall Time', 'Lap Distance', 'Lap Time']

  let page = doc.addPage(A4)
  let pen: Pen = { page, font, y: TOP }
  let onPage = 0

  const pair = (label: string, value?: string) => {
    if (value === undefined || value === '') return
    text(pen, LABEL_X, label)
    text(pen, VALUE_X, value)
    pen.y -= LINE
  }

  for (const r of runners) {
    if (onPage >= perPage) {
      page = doc.addPage(A4)
      pen = { page, font, y: TOP }
      onPage = 0
    }

    pair('Participant', r.name)
    pair('BIB', r.bib)
    pair('Gender', r.gender)
    pair('Age Group', r.ageGroup)
    pair('Category', r.category)
    pair('Distance', r.distance)
    pair('Gun Time', r.gun)
    pair('Net Time', r.net)
    // Provider-calculated values: present, and expected NOT to be imported.
    pair('Overall Rank', r.overallRank)
    pair('Pace', r.pace)
    pair('Speed', r.speed)

    if (r.splits && r.splits.length > 0) {
      pen.y -= 4
      const head: Pen = { page: pen.page, font: bold, y: pen.y }
      row(head, splitColumns, splitHeaders)
      pen.y = head.y
      for (const s of r.splits) {
        row(pen, splitColumns, [
          s.split, s.distance ?? '', s.timeOfDay ?? '', s.overall ?? '', s.lapDistance ?? '', s.lapTime ?? '',
        ])
      }
    }

    // The gap that separates one runner from the next — one of the boundary signals.
    pen.y -= LINE * 2.5
    onPage++
  }

  return doc.save()
}

/** One line of a grouped listing: a section heading on its own line, or a row of cells. */
export type ListingLine = { section: string } | { cells: readonly string[] }

/**
 * RD-RACEOPS-RESULTS-07B · A GROUPED listing with EXPLICIT headings — the layout the
 * real-provider audit (RESULTS-07) found: a title, a race caption, the header row, then
 * section headings ("Male", "16-25 Yrs") on lines of their own between the result rows.
 *
 * Still synthetic: the words are the caller's, the geometry is pdf-lib's. The headings are
 * given verbatim so a test can pin a real provider's exact spelling without shipping the
 * provider's file.
 */
export async function sectionedTablePdf(
  headers: readonly string[],
  lines: readonly ListingLine[],
  opts: { rowsPerPage?: number; headerEveryPage?: boolean; caption?: string; title?: string } = {},
): Promise<Uint8Array> {
  const { rowsPerPage = 30, headerEveryPage = true, caption = '10KM', title = 'Results 10KM' } = opts
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  // Column x positions from each column's WIDEST content (heading or cell), each followed by
  // a clear gutter — the way a real generator lays a table out, so two runs never touch and
  // merge into one text item.
  const columns: number[] = []
  let x = 30
  headers.forEach((h, i) => {
    columns.push(x)
    const widest = Math.max(
      bold.widthOfTextAtSize(h, 12),
      ...lines.map(l => ('cells' in l ? font.widthOfTextAtSize(l.cells[i] ?? '', 10) : 0)),
    )
    x += Math.ceil(widest) + 28
  })

  let page = doc.addPage(A4)
  let pen: Pen = { page, font, y: TOP }
  let onPage = 0
  let pageNo = 1

  const startPage = () => {
    pen.page.drawText(title, { x: 28, y: TOP + 24, size: 16, font: bold })
    if (headerEveryPage || pageNo === 1) {
      const head: Pen = { page: pen.page, font: bold, y: pen.y }
      row(head, columns, headers, 12)
      pen.y = head.y
    }
    if (pageNo === 1) { text(pen, 28, caption, 12); pen.y -= LINE }
  }
  startPage()

  for (const line of lines) {
    if (onPage >= rowsPerPage) {
      pen.page.drawText(`${pageNo}`, { x: 561, y: 32, size: 10, font })
      page = doc.addPage(A4)
      pen = { page, font, y: TOP }
      onPage = 0
      pageNo++
      startPage()
    }
    if ('section' in line) {
      text(pen, 28, line.section, 12)
      pen.y -= LINE
    } else {
      row(pen, columns, line.cells, 10)
    }
    onPage++
  }
  pen.page.drawText(`${pageNo}`, { x: 561, y: 32, size: 10, font })

  return doc.save()
}

/** A PDF with pages but no text at all — what a scanned document looks like to a reader. */
export async function imageOnlyPdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage(A4)
    // A filled rectangle stands in for the scan: real page furniture, zero text runs.
    page.drawRectangle({ x: 40, y: 400, width: 500, height: 300, color: rgb(0.85, 0.85, 0.85) })
  }
  return doc.save()
}

/** Text, but nothing that reads as results — a certificate or a covering note. */
export async function proseOnlyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage(A4)
  const lines = [
    'Certificate of Completion',
    'This is to certify that the participant completed the course',
    'in accordance with the rules of the event.',
    'Issued by the organising committee.',
  ]
  lines.forEach((l, i) => page.drawText(l, { x: 60, y: 700 - i * 28, size: 13, font }))
  return doc.save()
}

/** An empty document: pages, no content at all. */
export async function emptyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage(A4)
  return doc.save()
}
