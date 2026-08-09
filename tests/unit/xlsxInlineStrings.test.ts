// RD-RESULTS-XLSX-01 — OOXML inline-string support.
//
// Two layers:
//  1. `normalizeInlineStrings` in isolation — pure string → string.
//  2. A REAL .xlsx, zipped in memory and parsed by `read-excel-file` itself, so the
//     assertions are about what the library actually returns rather than about what we
//     believe it does. The node entry is used because Vitest runs without a DOM; the
//     cell-parsing code under test is shared with the browser entry, only the XML
//     implementation differs.

import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import readXlsxFile from 'read-excel-file/node'
import {
  extractInlineStringText, normalizeInlineStrings,
} from '@/lib/xlsx/inlineStrings'
import { repairWorkbook } from '@/lib/xlsx/readWorkbook'

// ─── Minimal but valid workbook scaffolding ────────────────────────────────────
const CT = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
const WB = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets></workbook>`
const WB_RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
const SST = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>Kavya Iyer</t></si></sst>`
const STYLES = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`

const sheetXml = (rowsXml: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`

function workbook(rowsXml: string): ArrayBuffer {
  const packed = zipSync({
    '[Content_Types].xml':        strToU8(CT),
    '_rels/.rels':                strToU8(RELS),
    'xl/workbook.xml':            strToU8(WB),
    'xl/_rels/workbook.xml.rels': strToU8(WB_RELS),
    'xl/sharedStrings.xml':       strToU8(SST),
    'xl/styles.xml':              strToU8(STYLES),
    'xl/worksheets/sheet1.xml':   strToU8(sheetXml(rowsXml)),
  }, { level: 0 })
  return packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer
}

/** Header row of inline strings + one data row, parsed the way the app parses it. */
async function parseCell(cellXml: string) {
  const rows = `<row r="1"><c r="A1" t="inlineStr"><is><t>Bib</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>`
             + `<row r="2"><c r="A2"><v>101</v></c>${cellXml}</row>`
  const sheets = await readXlsxFile(Buffer.from(repairWorkbook(workbook(rows))) as unknown as Buffer)
  return (sheets as unknown as { data: unknown[][] }[])[0].data[1][1]
}

// ─── 1. The eight cell kinds the sprint enumerates ─────────────────────────────
describe('workbook cell kinds — parsed through read-excel-file', () => {
  it('EMPTY inline string with no <is> at all reads as blank, not a crash', async () => {
    // The exact shape reported: <c r="E5" t="inlineStr"></c>
    await expect(parseCell('<c r="B2" t="inlineStr"></c>')).resolves.toBeNull()
  })

  it('EMPTY inline string, self-closed, reads as blank', async () => {
    await expect(parseCell('<c r="B2" t="inlineStr"/>')).resolves.toBeNull()
  })

  it('EMPTY inline string with an empty <is> reads as blank', async () => {
    await expect(parseCell('<c r="B2" t="inlineStr"><is/></c>')).resolves.toBeNull()
  })

  it('EMPTY inline string with an empty <t> reads as blank', async () => {
    await expect(parseCell('<c r="B2" t="inlineStr"><is><t></t></is></c>')).resolves.toBeNull()
  })

  it('POPULATED inline string reads its text', async () => {
    await expect(parseCell('<c r="B2" t="inlineStr"><is><t>Asha Menon</t></is></c>'))
      .resolves.toBe('Asha Menon')
  })

  it('RICH TEXT inline string concatenates its runs', async () => {
    // A name is split into runs whenever part of the cell is formatted differently.
    // Before this fix the whole workbook threw on this cell.
    await expect(parseCell(
      '<c r="B2" t="inlineStr"><is><r><rPr><b/></rPr><t xml:space="preserve">Asha </t></r><r><t>Menon</t></r></is></c>',
    )).resolves.toBe('Asha Menon')
  })

  it('SHARED string still resolves through the shared-strings table', async () => {
    await expect(parseCell('<c r="B2" t="s"><v>0</v></c>')).resolves.toBe('Kavya Iyer')
  })

  it('NUMERIC cell still reads as a number', async () => {
    await expect(parseCell('<c r="B2"><v>42.5</v></c>')).resolves.toBe(42.5)
  })

  it('BOOLEAN cell still reads as a boolean', async () => {
    await expect(parseCell('<c r="B2" t="b"><v>1</v></c>')).resolves.toBe(true)
  })

  it('FORMULA cell still reads its cached result', async () => {
    await expect(parseCell('<c r="B2" t="str"><f>A2&amp;""</f><v>101</v></c>')).resolves.toBe('101')
  })

  it('BLANK cell reads as null', async () => {
    await expect(parseCell('<c r="B2"/>')).resolves.toBeNull()
  })

  it('MISSING cell reads as null', async () => {
    await expect(parseCell('')).resolves.toBeNull()
  })
})

describe('a whole sheet of mixed inline-string shapes', () => {
  it('parses every row instead of failing the workbook on one cell', async () => {
    const rows =
      `<row r="1">`
      + `<c r="A1" t="inlineStr"><is><t>Bib</t></is></c>`
      + `<c r="B1" t="inlineStr"><is><t>Name</t></is></c>`
      + `<c r="C1" t="inlineStr"><is><t>Note</t></is></c>`
      + `</row>`
      + `<row r="2"><c r="A2"><v>101</v></c>`
      + `<c r="B2" t="inlineStr"><is><r><t>Asha </t></r><r><t>Menon</t></r></is></c>`
      + `<c r="C2" t="inlineStr"></c></row>`
      + `<row r="3"><c r="A3"><v>102</v></c>`
      + `<c r="B3" t="inlineStr"><is><t>Kavya Iyer</t></is></c>`
      + `<c r="C3" t="inlineStr"><is/></c></row>`

    const sheets = await readXlsxFile(Buffer.from(repairWorkbook(workbook(rows))) as unknown as Buffer)
    expect((sheets as unknown as { data: unknown[][] }[])[0].data).toEqual([
      ['Bib', 'Name', 'Note'],
      [101, 'Asha Menon', null],
      [102, 'Kavya Iyer', null],
    ])
  })
})

// ─── 2. The normalizer in isolation ────────────────────────────────────────────
describe('normalizeInlineStrings', () => {
  const cell = (inner: string) => sheetXml(`<row r="1"><c r="A1" t="inlineStr">${inner}</c></row>`)

  it('leaves a sheet with no inline strings untouched, by reference', () => {
    const xml = sheetXml('<row r="1"><c r="A1"><v>1</v></c><c r="A2" t="s"><v>0</v></c></row>')
    expect(normalizeInlineStrings(xml)).toBe(xml)
  })

  it('leaves an already-readable inline string byte-identical', () => {
    const xml = cell('<is><t>Asha</t></is>')
    expect(normalizeInlineStrings(xml)).toBe(xml)
  })

  it('gives a value-less inline-string cell an empty <is><t>', () => {
    expect(normalizeInlineStrings(cell('')))
      .toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve"></t></is></c>')
  })

  it('rewrites a self-closed inline-string cell into a full element', () => {
    const xml = sheetXml('<row r="1"><c r="A1" t="inlineStr"/></row>')
    expect(normalizeInlineStrings(xml))
      .toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve"></t></is></c>')
  })

  it('flattens formatted runs into a single <t>, preserving order and spacing', () => {
    expect(normalizeInlineStrings(cell('<is><r><rPr><b/></rPr><t xml:space="preserve">Asha </t></r><r><t>Menon</t></r></is>')))
      .toContain('<is><t xml:space="preserve">Asha Menon</t></is>')
  })

  it('preserves escaped entities without decoding them', () => {
    expect(normalizeInlineStrings(cell('<is><r><t>Ravi &amp; Sons</t></r></is>')))
      .toContain('<is><t xml:space="preserve">Ravi &amp; Sons</t></is>')
  })

  it('does not touch <col>, <cols> or <cellXfs> elements', () => {
    const xml = sheetXml('<cols><col min="1" max="1" width="9"/></cols><row r="1"><c r="A1"><v>1</v></c></row>')
    expect(normalizeInlineStrings(xml)).toBe(xml)
  })

  it('survives an attribute value containing a > character', () => {
    const xml = sheetXml('<row r="1"><c r="A1" s="0" t="inlineStr" cm="a>b"></c></row>')
    expect(normalizeInlineStrings(xml))
      .toContain('<c r="A1" s="0" t="inlineStr" cm="a>b"><is><t xml:space="preserve"></t></is></c>')
  })

  it('repairs several cells in one sheet', () => {
    const xml = sheetXml(
      '<row r="1"><c r="A1" t="inlineStr"></c>'
      + '<c r="B1" t="inlineStr"><is><t>ok</t></is></c>'
      + '<c r="C1" t="inlineStr"><is><r><t>x</t></r></is></c></row>',
    )
    const out = normalizeInlineStrings(xml)
    expect(out).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve"></t></is></c>')
    expect(out).toContain('<c r="B1" t="inlineStr"><is><t>ok</t></is></c>')   // untouched
    expect(out).toContain('<c r="C1" t="inlineStr"><is><t xml:space="preserve">x</t></is></c>')
  })
})

describe('extractInlineStringText', () => {
  it('reads a single <t>', () => {
    expect(extractInlineStringText('<is><t>Asha</t></is>')).toBe('Asha')
  })

  it('concatenates runs in document order', () => {
    expect(extractInlineStringText('<is><r><t>a</t></r><r><t>b</t></r><r><t>c</t></r></is>')).toBe('abc')
  })

  it('treats a self-closed <t/> as empty', () => {
    expect(extractInlineStringText('<is><t/></is>')).toBe('')
  })

  it('excludes phonetic guides, which are not part of the value', () => {
    // <rPh> carries a pronunciation hint for East-Asian text and holds its own <t>.
    expect(extractInlineStringText('<is><t>日本</t><rPh sb="0" eb="2"><t>にほん</t></rPh></is>')).toBe('日本')
  })

  it('returns empty for a cell with no <is>', () => {
    expect(extractInlineStringText('')).toBe('')
  })
})

// ─── 3. Backward compatibility of the repack step ──────────────────────────────
describe('repairWorkbook', () => {
  it('returns the ORIGINAL bytes when no cell needs repair', () => {
    const src = workbook('<row r="1"><c r="A1" t="inlineStr"><is><t>Bib</t></is></c></row>'
                       + '<row r="2"><c r="A2"><v>1</v></c></row>')
    expect(repairWorkbook(src)).toBe(src)
  })

  it('returns repacked bytes when a cell does need repair', () => {
    const src = workbook('<row r="1"><c r="A1" t="inlineStr"><is><t>Bib</t></is></c></row>'
                       + '<row r="2"><c r="A2" t="inlineStr"></c></row>')
    expect(repairWorkbook(src)).not.toBe(src)
  })

  it('passes a non-zip through untouched rather than throwing', () => {
    const notAZip = strToU8('this is not a workbook')
    const src = notAZip.buffer.slice(0, notAZip.byteLength) as ArrayBuffer
    expect(repairWorkbook(src)).toBe(src)
  })
})
