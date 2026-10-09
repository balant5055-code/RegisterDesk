// RD-IMPORT-RT-01 — registration import: what Excel does to a filled-in template.
//
//   1. Cells as EXCEL SAVES THEM (a typed date becomes a date serial with a date format; a
//      time becomes a fraction of a day; a typed phone becomes a number), parsed by the real
//      `read-excel-file` — then turned into text by `importCellText`, the drawer's converter.
//   2. The template writer's opt-in Text columns (numFmt 49): present on the Participants
//      sheet, absent from every ordinary export.
//   3. The Meta contract builder shared by the template and the failed-rows re-import file.
// Behaviour through the real routes: tests/emulator/registrationImportRoundTrip.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import readXlsxFile from 'read-excel-file/node'
import { repairWorkbook } from '@/lib/xlsx/readWorkbook'
import { tablesToXlsx } from '@/lib/reports/xlsx'
import {
  importCellText, importMetaTable, IMPORT_META_KEYS, IMPORT_TEMPLATE_VERSION, IMPORT_SHEET_META,
} from '@/lib/registrations/importTemplate'

// ─── A workbook shaped like Excel's output (date styles, numeric cells) ─────────
const CT = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
const WB = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Participants" sheetId="1" r:id="rId1"/></sheets></workbook>`
const WB_RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
// cellXfs: 0 = General, 1 = built-in date "m/d/yyyy" (14), 2 = built-in time "h:mm" (20)
const STYLES = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="20" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`

function excelWorkbook(rowsXml: string): Buffer {
  const packed = zipSync({
    '[Content_Types].xml': strToU8(CT), '_rels/.rels': strToU8(RELS), 'xl/workbook.xml': strToU8(WB),
    'xl/_rels/workbook.xml.rels': strToU8(WB_RELS), 'xl/styles.xml': strToU8(STYLES),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`),
  }, { level: 0 })
  return Buffer.from(repairWorkbook(packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer))
}
/** One data row of cells, parsed exactly as the app parses, converted as the drawer converts. */
async function parsedRow(cellsXml: string): Promise<string[]> {
  const sheets = await readXlsxFile(excelWorkbook(`<row r="1"><c r="A1" t="inlineStr"><is><t>H</t></is></c></row><row r="2">${cellsXml}</row>`) as unknown as Buffer)
  return ((sheets as unknown as { data: unknown[][] }[])[0].data[1]).map(importCellText)
}

describe('1 · Excel-shaped cells → import text', () => {
  it('a typed DATE (serial + date format) becomes YYYY-MM-DD — never a locale timestamp, never a day off', async () => {
    // 1990-05-15 = serial 33008; 2026-07-15 = 46218
    expect(await parsedRow('<c r="A2" s="1"><v>33008</v></c><c r="B2" s="1"><v>46218</v></c>')).toEqual(['1990-05-15', '2026-07-15'])
  })
  it('a typed TIME (fraction of a day + time format) becomes HH:MM, rounded to the minute', async () => {
    // 07:30 = 0.3125 (exact); 13:20 = 0.5555… (the reader floors to 13:19:59.999)
    expect(await parsedRow('<c r="A2" s="2"><v>0.3125</v></c><c r="B2" s="2"><v>0.55555555555555558</v></c>')).toEqual(['07:30', '13:20'])
  })
  it('a date WITH a time keeps both', () => {
    expect(importCellText(new Date(Date.UTC(2026, 6, 15, 6, 45)))).toBe('2026-07-15 06:45')
  })
  it('numbers and text are kept as written (trimmed); empty stays empty', async () => {
    expect(await parsedRow('<c r="A2"><v>919876543210</v></c><c r="B2" t="inlineStr"><is><t>  +919876543210 </t></is></c><c r="C2" t="inlineStr"><is><t>0012</t></is></c>'))
      .toEqual(['919876543210', '+919876543210', '0012'])
    expect(importCellText(null)).toBe('')
    expect(importCellText(undefined)).toBe('')
    expect(importCellText(new Date(NaN))).toBe('')
  })
})

describe('2 · the template writer — opt-in Text columns', () => {
  const xml = (buf: Buffer, part: string) => strFromU8(unzipSync(new Uint8Array(buf))[part])
  const table = (textColumns?: boolean) => ({
    id: 'Participants', title: 'Participants', rows: [],
    columns: [{ key: 'name', label: 'Full Name *', type: 'text' as const }, { key: 'phone', label: 'Phone', type: 'text' as const }],
    ...(textColumns ? { textColumns } : {}),
  })
  it('a template sheet declares its columns Text (style 1 = numFmt 49)', () => {
    const buf = tablesToXlsx([table(true)])
    expect(xml(buf, 'xl/worksheets/sheet1.xml')).toContain('<cols><col min="1" max="2" width="22" style="1" customWidth="1"/></cols>')
    expect(xml(buf, 'xl/styles.xml')).toContain('<xf numFmtId="49"')
  })
  it('an ordinary export is unchanged — no column styles', () => {
    expect(xml(tablesToXlsx([table()]), 'xl/worksheets/sheet1.xml')).not.toContain('<cols>')
  })
  it('PRE-FILLED data cells (failed-rows file) carry the Text style too; export cells do not', async () => {
    const filled = { ...table(true), rows: [{ name: 'Asha', phone: '+919876500001' }] }
    const sheet = xml(tablesToXlsx([filled]), 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="B2" s="1" t="inlineStr"><is><t xml:space="preserve">+919876500001</t></is></c>')
    expect(sheet).not.toContain('<c r="A1" s="1"')                         // header row untouched
    expect(xml(tablesToXlsx([{ ...table(), rows: filled.rows }]), 'xl/worksheets/sheet1.xml')).not.toContain('s="1"')
    const back = await readXlsxFile(Buffer.from(repairWorkbook(new Uint8Array(tablesToXlsx([filled])).buffer as ArrayBuffer)) as unknown as Buffer)
    expect((back as unknown as { data: unknown[][] }[])[0].data[1]).toEqual(['Asha', '+919876500001'])
  })
  it('the generated workbook still parses, headers intact', async () => {
    const sheets = await readXlsxFile(Buffer.from(repairWorkbook(new Uint8Array(tablesToXlsx([table(true)])).buffer as ArrayBuffer)) as unknown as Buffer)
    expect((sheets as unknown as { data: unknown[][] }[])[0].data[0]).toEqual(['Full Name *', 'Phone'])
  })
})

describe('3 · the Meta contract (template + failed-rows file)', () => {
  it('carries version, event id, slug and a parseable timestamp', () => {
    const t = importMetaTable('draft-1', 'my-event')
    expect(t.id).toBe(IMPORT_SHEET_META)
    const kv = Object.fromEntries(t.rows.map(r => [r.key as string, r.value as string]))
    expect(kv[IMPORT_META_KEYS.version]).toBe(IMPORT_TEMPLATE_VERSION)
    expect(kv[IMPORT_META_KEYS.eventId]).toBe('draft-1')
    expect(kv[IMPORT_META_KEYS.eventSlug]).toBe('my-event')
    expect(Number.isNaN(Date.parse(kv[IMPORT_META_KEYS.generatedAt]))).toBe(false)
  })
  it('both workbooks use it', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync('app/api/organizer/events/[eventId]/registrations/import-template/route.ts', 'utf8')).toContain('importMetaTable(eventId, slug)')
    expect(readFileSync('app/api/organizer/events/[eventId]/registrations/import/[jobId]/failed-rows/route.ts', 'utf8')).toContain('importMetaTable(eventId, slug)')
  })
})

describe('4 · the drawer explains the supported workflow', () => {
  it('only the template (or a failed-rows file) imports; an export does not; no automatic email', async () => {
    const { readFileSync } = await import('node:fs')
    const d = readFileSync('app/(dashboard)/dashboard/events/[eventId]/registrations/ImportParticipantsDrawer.tsx', 'utf8')
    expect(d).toContain('data-testid="import-supported-files"')
    expect(d).toContain('A Registrations export is a\n                report and can’t be imported back')
    expect(d).toContain('Imported participants are not emailed automatically.')
    // The error an organizer sees when uploading an export says what to do instead.
    expect(d).toContain('A Registrations export can’t be imported — download the template, copy your rows into it, and upload that.')
  })
})
