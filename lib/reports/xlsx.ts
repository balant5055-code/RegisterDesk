// Dependency-free XLSX (OOXML) writer. Builds a valid .xlsx package — a ZIP of
// XML parts — with one worksheet per ReportTable, using INLINE strings (no shared
// string table) and STORED (uncompressed) ZIP entries with hand-computed CRC32.
//
// Why no library: the repo has no spreadsheet dependency, and the OOXML surface a
// finance export needs (text + numeric cells, multiple sheets) is small. Money
// cells are written as real numbers (rupees) so Excel can SUM them; dates/text are
// inline strings. Runs in the Node runtime (Buffer available).

import type { ReportTable } from '@/lib/reports/types'
import { cellToXlsx } from '@/lib/reports/format'
import { buildStoredZip, type ZipEntry } from '@/lib/zip/store'

// ─── XML helpers ─────────────────────────────────────────────────────────────
// XML 1.0 forbids most C0 control characters in document text (everything in
// U+0000–U+001F EXCEPT tab, LF and CR). A stray control code — common when cell
// values are pasted from PDFs/Word — yields a workbook that strict readers reject.
// Strip only those illegal codes; ALL normal Unicode (Tamil, Hindi, emoji,
// accents, CJK, …) is left untouched. Built from a string so no literal control
// byte ever appears in source.
const XML_ILLEGAL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g')

function xmlEscape(s: string): string {
  return s.replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function colRef(i: number): string {
  let s = '', n = i
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}
function sanitizeSheetName(name: string, idx: number): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31)
  return cleaned || `Sheet${idx + 1}`
}

// ─── Worksheet XML ─────────────────────────────────────────────────────────────
function sheetXml(table: ReportTable): string {
  const rows: string[] = []
  let r = 1

  const headerCells = table.columns.map((col, ci) =>
    `<c r="${colRef(ci)}${r}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(col.label)}</t></is></c>`,
  ).join('')
  rows.push(`<row r="${r}">${headerCells}</row>`)

  for (const row of table.rows) {
    r++
    const cells = table.columns.map((col, ci) => {
      const { v, numeric } = cellToXlsx(row[col.key] ?? null, col.type)
      const ref = `${colRef(ci)}${r}`
      return numeric
        ? `<c r="${ref}"><v>${v}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(v))}</t></is></c>`
    }).join('')
    rows.push(`<row r="${r}">${cells}</row>`)
  }

  if (table.summary && table.summary.length > 0) {
    r++ // blank spacer row
    for (const s of table.summary) {
      r++
      const { v, numeric } = cellToXlsx(s.value, s.type)
      const valCell = numeric
        ? `<c r="B${r}"><v>${v}</v></c>`
        : `<c r="B${r}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(v))}</t></is></c>`
      rows.push(`<row r="${r}"><c r="A${r}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(s.label)}</t></is></c>${valCell}</row>`)
    }
  }

  // GA-7C S2/P6: disclose truncation in-sheet (was only in the PDF) so an XLSX never
  // silently under-reports. Same wording as the PDF/CSV.
  if (table.truncated) {
    r += 2 // spacer + note row
    const note = `Note: limited to the most recent ${table.rows.length} records. Narrow the date range for a complete export.`
    rows.push(`<row r="${r}"><c r="A${r}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(note)}</t></is></c></row>`)
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`
}

// ─── Public ───────────────────────────────────────────────────────────────────
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`
  + `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>`
  + `<borders count="1"><border/></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>`
  + `</styleSheet>`

/** Build a multi-sheet .xlsx workbook (one sheet per table). */
export function tablesToXlsx(tables: ReportTable[]): Buffer {
  const sheets = tables.length > 0 ? tables : [{ id: 'empty', title: 'Empty', columns: [], rows: [] } as ReportTable]
  const usedNames = new Set<string>()
  const sheetNames = sheets.map((t, i) => {
    const name = sanitizeSheetName(t.title || t.id, i)
    let n = name, k = 1
    while (usedNames.has(n.toLowerCase())) { n = `${name.slice(0, 28)}_${++k}` }
    usedNames.add(n.toLowerCase())
    return n
  })

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + `</Types>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${sheetNames.map((nm, i) => `<sheet name="${xmlEscape(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
    + `</workbook>`

  const stylesRelId = sheets.length + 1
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `</Relationships>`

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml',      data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels',              data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml',          data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml',            data: Buffer.from(STYLES_XML, 'utf8') },
    ...sheets.map((t, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(t), 'utf8') })),
  ]

  return buildStoredZip(entries)
}
