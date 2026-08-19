// Reads the LAID-OUT geometry of a pdf-lib PDF: where each text run sits, how wide it is,
// and therefore whether it stays inside the page.
//
// WHY THIS IS NEEDED. pdf-lib does not clip. A `drawText` whose string is wider than the page
// is painted straight past the edge and simply disappears from the rendered output — no error,
// no warning, nothing in the byte count to notice. "The PDF generated successfully" and "the
// venue is missing from the ticket" are both true at the same time. Only measuring each run
// against the page box can tell them apart.

import { inflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'

export interface TextRun {
  x: number
  y: number
  size: number
  bold: boolean
  text: string
  /** Rendered width in points, measured with the real font. */
  width: number
}

export interface PageGeometry {
  width: number
  height: number
  pageCount: number
  runs: TextRun[]
}

function contentStreams(pdf: Uint8Array): string[] {
  const raw = Buffer.from(pdf)
  const hay = raw.toString('latin1')
  const out: string[] = []
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(hay)) !== null) {
    const start = m.index + m[0].length
    const end = hay.indexOf('endstream', start)
    if (end < 0) continue
    const slice = raw.subarray(start, end)
    try { out.push(inflateSync(slice).toString('latin1')) }
    catch { out.push(slice.toString('latin1')) }
  }
  return out
}

const fromHex = (hex: string): string => {
  const clean = hex.replace(/\s+/g, '')
  let s = ''
  for (let i = 0; i + 1 < clean.length; i += 2) s += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16))
  return s
}

/** Parses text placement operators and measures each run in its actual font. */
export async function readPdfGeometry(pdf: Uint8Array): Promise<PageGeometry> {
  const doc  = await PDFDocument.load(pdf)
  const page = doc.getPage(0)

  // A measuring document — embedding here does not touch the PDF under test.
  const probe = await PDFDocument.create()
  const reg: PDFFont  = await probe.embedFont(StandardFonts.Helvetica)
  const bold: PDFFont = await probe.embedFont(StandardFonts.HelveticaBold)

  const runs: TextRun[] = []
  for (const stream of contentStreams(pdf)) {
    let size = 10, isBold = false, x = 0, y = 0
    for (const line of stream.split(/\r?\n/)) {
      let m: RegExpExecArray | null
      if ((m = /^\/(\S+)\s+([\d.]+)\s+Tf$/.exec(line))) { isBold = /Bold/i.test(m[1]); size = parseFloat(m[2]); continue }
      if ((m = /^1 0 0 1 ([\d.-]+) ([\d.-]+) Tm$/.exec(line))) { x = parseFloat(m[1]); y = parseFloat(m[2]); continue }
      if ((m = /^<([0-9A-Fa-f]*)>\s*Tj$/.exec(line))) {
        const text = fromHex(m[1])
        runs.push({ x, y, size, bold: isBold, text, width: (isBold ? bold : reg).widthOfTextAtSize(text, size) })
      }
    }
  }
  return { width: page.getWidth(), height: page.getHeight(), pageCount: doc.getPageCount(), runs }
}

export interface LayoutProblem { kind: string; detail: string }

/**
 * Every way a run can be wrong: past either margin, off the page, or sitting on top of a
 * neighbour that shares its baseline.
 */
export function findLayoutProblems(geo: PageGeometry, margin: number): LayoutProblem[] {
  const problems: LayoutProblem[] = []
  const clip = (s: string) => s.length > 42 ? `${s.slice(0, 42)}…` : s

  for (const r of geo.runs) {
    if (r.x < margin - 0.5) {
      problems.push({ kind: 'left-overflow', detail: `x=${r.x.toFixed(1)} < ${margin} "${clip(r.text)}"` })
    }
    if (r.x + r.width > geo.width - margin + 0.5) {
      problems.push({
        kind: 'right-overflow',
        detail: `ends at ${(r.x + r.width).toFixed(1)} > ${geo.width - margin} "${clip(r.text)}"`,
      })
    }
    if (r.y < 8 || r.y > geo.height) {
      problems.push({ kind: 'off-page', detail: `y=${r.y.toFixed(1)} "${clip(r.text)}"` })
    }
  }

  const byBaseline = new Map<number, TextRun[]>()
  for (const r of geo.runs) {
    const k = Math.round(r.y)
    byBaseline.set(k, [...(byBaseline.get(k) ?? []), r])
  }
  for (const [k, group] of byBaseline) {
    const sorted = [...group].sort((a, b) => a.x - b.x)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].x < sorted[i - 1].x + sorted[i - 1].width - 0.5) {
        problems.push({
          kind: 'overlap',
          detail: `y=${k} "${clip(sorted[i - 1].text)}" / "${clip(sorted[i].text)}"`,
        })
      }
    }
  }
  return problems
}

/** All drawn text as one searchable string. */
export function geometryText(geo: PageGeometry): string {
  return geo.runs.map(r => r.text).join(' ')
}
