// PDF exporter (pdf-lib). Two outputs:
//   • reportPdf(tables)        — generic paginated tabular report
//   • payoutStatementPdf(stmt) — formatted payout statement (Gross/Fees/GST/Refunds/Net)
// Reuses the pdf-lib patterns already used by receipts.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { ReportTable, ReportCell, ReportColumnType, PayoutStatement } from '@/lib/reports/types'
import { REPORT_ROW_CAP } from '@/lib/reports/types'
import { cellToDisplay, fmtMoney, fmtDate } from '@/lib/reports/format'

// pdf-lib standard fonts use WinAnsi and throw on any glyph they can't encode
// (₹, Devanagari, CJK, emoji…). Sanitize ALL dynamic text: ₹→Rs, keep ASCII +
// Latin-1 letters, replace anything else with '?'. (CSV/XLSX keep full Unicode.)
function pdfSafe(s: string): string {
  let out = ''
  for (const ch of s.replace(/₹/g, 'Rs ')) {
    const c = ch.codePointAt(0) ?? 63
    if (c >= 0x20 && c <= 0x7e) out += ch                 // printable ASCII
    else if (c >= 0xa0 && c <= 0xff) out += ch            // Latin-1 supplement (WinAnsi-safe)
    else out += '?'
  }
  return out
}
const disp  = (v: ReportCell, t: ReportColumnType) => pdfSafe(cellToDisplay(v, t, true))
const money = (paise: number) => fmtMoney(paise, true)   // already ASCII

const A4: [number, number] = [595.28, 841.89]
const M = 40                          // page margin
const C_PRIMARY = rgb(0.18, 0.20, 0.55)
const C_TEXT    = rgb(0.12, 0.12, 0.14)
const C_MUTED   = rgb(0.45, 0.45, 0.50)
const C_WARN    = rgb(0.70, 0.15, 0.10)   // truncation / partial-total disclosure
const C_LINE    = rgb(0.85, 0.85, 0.88)
const C_HEADBG  = rgb(0.95, 0.95, 0.97)

interface Ctx { doc: PDFDocument; font: PDFFont; bold: PDFFont; page: PDFPage; y: number }

function truncate(raw: string, font: PDFFont, size: number, maxW: number): string {
  const text = pdfSafe(raw)
  if (font.widthOfTextAtSize(text, size) <= maxW) return text
  let t = text
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1)
  return t + '…'
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage(A4)
  ctx.y = A4[1] - M
}

function ensureSpace(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < M + 24) newPage(ctx)
}

function drawHeader(ctx: Ctx, heading: string, sub: string): void {
  ctx.page.drawRectangle({ x: 0, y: A4[1] - 70, width: A4[0], height: 70, color: C_PRIMARY })
  ctx.page.drawText('REGISTERDESK', { x: M, y: A4[1] - 28, size: 9, font: ctx.bold, color: rgb(1, 1, 1), opacity: 0.8 })
  ctx.page.drawText(pdfSafe(heading), { x: M, y: A4[1] - 50, size: 16, font: ctx.bold, color: rgb(1, 1, 1) })
  if (sub) ctx.page.drawText(pdfSafe(sub), { x: M, y: A4[1] - 64, size: 8.5, font: ctx.font, color: rgb(1, 1, 1) })
  ctx.y = A4[1] - 70 - 24
}

function colWeights(table: ReportTable): number[] {
  const w = table.columns.map(c => c.type === 'text' ? 3 : c.type === 'date' ? 1.6 : c.type === 'money' ? 1.6 : 1.1)
  const total = w.reduce((s, x) => s + x, 0)
  const avail = A4[0] - 2 * M
  return w.map(x => (x / total) * avail)
}

function drawTable(ctx: Ctx, table: ReportTable): void {
  const widths = colWeights(table)
  const xs: number[] = []
  let cx = M
  for (const wd of widths) { xs.push(cx); cx += wd }
  const size = 8
  const rowH = 15

  // Title
  ensureSpace(ctx, 30)
  ctx.page.drawText(pdfSafe(table.title), { x: M, y: ctx.y, size: 11, font: ctx.bold, color: C_TEXT })
  ctx.y -= 18

  const drawHeadRow = () => {
    ctx.page.drawRectangle({ x: M, y: ctx.y - rowH + 4, width: A4[0] - 2 * M, height: rowH, color: C_HEADBG })
    table.columns.forEach((col, i) => {
      const right = col.align === 'right' || col.type === 'money' || col.type === 'number'
      const label = truncate(col.label, ctx.bold, size, widths[i] - 6)
      const tw = ctx.bold.widthOfTextAtSize(label, size)
      ctx.page.drawText(label, { x: right ? xs[i] + widths[i] - tw - 4 : xs[i] + 2, y: ctx.y - rowH + 9, size, font: ctx.bold, color: C_MUTED })
    })
    ctx.y -= rowH
  }
  drawHeadRow()

  if (table.rows.length === 0) {
    ctx.page.drawText('No records for the selected filters.', { x: M + 2, y: ctx.y - 10, size, font: ctx.font, color: C_MUTED })
    ctx.y -= rowH + 6
  }

  for (const row of table.rows) {
    if (ctx.y - rowH < M + 24) { newPage(ctx); drawHeadRow() }
    table.columns.forEach((col, i) => {
      const right = col.align === 'right' || col.type === 'money' || col.type === 'number'
      const raw = disp(row[col.key] ?? null, col.type)
      const txt = truncate(raw, ctx.font, size, widths[i] - 6)
      const tw = ctx.font.widthOfTextAtSize(txt, size)
      ctx.page.drawText(txt, { x: right ? xs[i] + widths[i] - tw - 4 : xs[i] + 2, y: ctx.y - 10, size, font: ctx.font, color: C_TEXT })
    })
    ctx.page.drawLine({ start: { x: M, y: ctx.y - rowH + 3 }, end: { x: A4[0] - M, y: ctx.y - rowH + 3 }, thickness: 0.3, color: C_LINE })
    ctx.y -= rowH
  }

  // Summary
  if (table.summary && table.summary.length > 0) {
    ctx.y -= 6
    for (const s of table.summary) {
      ensureSpace(ctx, rowH)
      ctx.page.drawText(pdfSafe(s.label), { x: M + 2, y: ctx.y - 10, size: 8.5, font: ctx.bold, color: C_TEXT })
      const val = disp(s.value, s.type)
      const tw = ctx.bold.widthOfTextAtSize(val, 8.5)
      ctx.page.drawText(val, { x: A4[0] - M - tw - 4, y: ctx.y - 10, size: 8.5, font: ctx.bold, color: C_TEXT })
      ctx.y -= rowH
    }
  }
  if (table.truncated) {
    ctx.y -= 4
    ctx.page.drawText(`Note: limited to the most recent ${table.rows.length} records. Narrow the date range for a complete export.`,
      { x: M, y: ctx.y - 8, size: 7, font: ctx.font, color: C_MUTED })
    ctx.y -= 14
  }
  ctx.y -= 16
}

export async function reportPdf(tables: ReportTable[], meta: { heading: string; sub?: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ctx: Ctx = { doc, font, bold, page: doc.addPage(A4), y: A4[1] - M }
  drawHeader(ctx, meta.heading, meta.sub ?? '')
  for (const t of tables) drawTable(ctx, t)
  return doc.save()
}

export async function payoutStatementPdf(stmt: PayoutStatement): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ctx: Ctx = { doc, font, bold, page: doc.addPage(A4), y: A4[1] - M }

  const periodLabel = `${fmtDate(stmt.period.from)} - ${fmtDate(stmt.period.to)}`
  drawHeader(ctx, 'Payout Statement', `${stmt.organizerName} | ${periodLabel}`)

  // Meta block
  ctx.y -= 4
  const metaRows: [string, string][] = [
    ['Statement Period',     periodLabel],
    ['Settlement Reference', stmt.settlementReference ?? '—'],
    ['Settlement Date',      stmt.settlementDate ? fmtDate(stmt.settlementDate) : '—'],
    ['Transactions',         String(stmt.transactionCount)],
  ]
  for (const [k, v] of metaRows) {
    ctx.page.drawText(pdfSafe(k), { x: M, y: ctx.y - 12, size: 9, font: ctx.font, color: C_MUTED })
    ctx.page.drawText(pdfSafe(v), { x: M + 160, y: ctx.y - 12, size: 9, font: ctx.bold, color: C_TEXT })
    ctx.y -= 18
  }
  ctx.y -= 8

  // GA-8 P1-2: NEVER silently under-report. When any source hit the row cap the
  // totals below are PARTIAL — disclose it prominently before the numbers.
  if (stmt.truncated) {
    ctx.page.drawText(pdfSafe(`PARTIAL STATEMENT — this period exceeds ${REPORT_ROW_CAP} transactions; totals below cover only the most recent ${REPORT_ROW_CAP}.`),
      { x: M, y: ctx.y - 10, size: 8, font: ctx.bold, color: C_WARN })
    ctx.y -= 14
    ctx.page.drawText(pdfSafe('Narrow the date range for a complete, reconciled statement.'),
      { x: M, y: ctx.y - 10, size: 7.5, font: ctx.font, color: C_WARN })
    ctx.y -= 18
  }

  // Amount breakdown
  const lines: [string, number, boolean][] = [
    ['Gross Revenue',     stmt.grossRevenuePaise, false],
    ['Platform Fees',     -stmt.platformFeesPaise, false],
    ['GST on Fees',       -stmt.gstPaise, false],
    ['Refunds',           -stmt.refundsPaise, false],
    ['Net Settlement',    stmt.netSettlementPaise, true],
  ]
  ctx.page.drawLine({ start: { x: M, y: ctx.y }, end: { x: A4[0] - M, y: ctx.y }, thickness: 0.5, color: C_LINE })
  ctx.y -= 6
  for (const [label, paise, isTotal] of lines) {
    if (isTotal) {
      ctx.y -= 4
      ctx.page.drawLine({ start: { x: M, y: ctx.y + 8 }, end: { x: A4[0] - M, y: ctx.y + 8 }, thickness: 0.5, color: C_LINE })
    }
    const f = isTotal ? ctx.bold : ctx.font
    const sz = isTotal ? 12 : 10
    ctx.page.drawText(label, { x: M, y: ctx.y - 12, size: sz, font: f, color: isTotal ? C_PRIMARY : C_TEXT })
    const val = money(Math.abs(paise))
    const shown = paise < 0 ? `(${val})` : val
    const tw = f.widthOfTextAtSize(shown, sz)
    ctx.page.drawText(shown, { x: A4[0] - M - tw, y: ctx.y - 12, size: sz, font: f, color: isTotal ? C_PRIMARY : C_TEXT })
    ctx.y -= isTotal ? 26 : 20
  }

  ctx.y -= 20
  ctx.page.drawText('This statement is generated from RegisterDesk ledger records. Fees and GST are as charged at transaction time.',
    { x: M, y: ctx.y, size: 7.5, font: ctx.font, color: C_MUTED })

  return doc.save()
}
