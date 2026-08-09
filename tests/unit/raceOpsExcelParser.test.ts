// RD-RACEOPS-01 Sprint 2 — Excel provider + the registry gate.
//
// The workbook READER is injected (createExcelParser), so sheet selection, Date/number
// cell coercion and error mapping are all exercised in Node with no browser and no real
// .xlsx fixture. That injection point exists precisely to make this testable.

import { describe, it, expect } from 'vitest'
import {
  createExcelParser, excelParser, selectResultsSheet, type WorkbookSheet,
} from '@/features/race-operations/import/parsers/excel/excelParser'
import { cellToString } from '@/features/race-operations/import/parsers/tabulate'
import { resolveParser } from '@/features/race-operations/import/parsers/registry'
import { RESULTS_MAX_FILE_BYTES } from '@/features/race-operations/import/constants'

const sheet = (name: string, data: WorkbookSheet['data']): WorkbookSheet => ({ sheet: name, data })
const file  = (name = 'results.xlsx', size = 1024) => ({ name, size })

describe('selectResultsSheet', () => {
  it('picks the first sheet with a header and at least one data row', () => {
    const picked = selectResultsSheet([
      sheet('Cover', [['Coimbatore Marathon 2026']]),
      sheet('Results', [['Bib', 'Time'], ['101', '1:00']]),
    ])
    expect(picked?.sheet).toBe('Results')
  })

  it('returns null when every sheet is empty or header-only', () => {
    expect(selectResultsSheet([sheet('A', []), sheet('B', [['Bib']])])).toBeNull()
  })
})

describe('cellToString — spreadsheet cell coercion', () => {
  it('renders an elapsed-time Date cell as hh:mm:ss', () => {
    expect(cellToString(new Date(Date.UTC(1899, 11, 30, 1, 48, 32)))).toBe('01:48:32')
  })

  it('keeps sub-second precision when present', () => {
    expect(cellToString(new Date(Date.UTC(1899, 11, 30, 0, 45, 12, 470)))).toBe('00:45:12.470')
  })

  it('passes numbers through as text so a fraction-of-day survives to the time parser', () => {
    expect(cellToString(0.0753703703)).toBe('0.0753703703')
  })

  it('preserves a bib string with leading zeros', () => {
    expect(cellToString('0042')).toBe('0042')
  })

  it('maps null and undefined to empty string', () => {
    expect(cellToString(null)).toBe('')
    expect(cellToString(undefined)).toBe('')
  })
})

describe('excelParser', () => {
  it('claims .xlsx only', () => {
    expect(excelParser.supports(file('a.xlsx'))).toBe(true)
    expect(excelParser.supports(file('a.xls'))).toBe(false)
    expect(excelParser.supports(file('a.csv'))).toBe(false)
  })

  it('parses the chosen sheet and records its name', async () => {
    const parser = createExcelParser(async () => [
      sheet('Notes', [['ignore me']]),
      sheet('Finishers', [['Bib No', 'Net Time'], ['101', '00:45:12']]),
    ])
    const out = await parser.parse(file())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.table.provider).toBe('excel')
    expect(out.table.sheetName).toBe('Finishers')
    expect(out.table.headers).toEqual(['Bib No', 'Net Time'])
    expect(out.table.rows[0].rowNumber).toBe(2)
  })

  it('maps a corrupt-zip exception to a human message with no stack trace', async () => {
    const parser = createExcelParser(async () => { throw new Error('invalid central directory signature') })
    const out = await parser.parse(file())
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.message).toMatch(/corrupted/i)
    expect(out.message).not.toMatch(/central directory/)
  })

  it('maps an encrypted workbook to specific advice', async () => {
    const parser = createExcelParser(async () => { throw new Error('file is password protected') })
    const out = await parser.parse(file())
    expect(!out.ok && out.message).toMatch(/password-protected/i)
  })

  it('reports a workbook with no usable sheet', async () => {
    const parser = createExcelParser(async () => [sheet('Only', [['Bib']])])
    const out = await parser.parse(file())
    expect(!out.ok && out.message).toMatch(/no sheet containing result rows/i)
  })

  it('reports a reader that returns nothing', async () => {
    const parser = createExcelParser(async () => [])
    const out = await parser.parse(file())
    expect(!out.ok && out.message).toMatch(/no sheets/i)
  })
})

describe('resolveParser — the upload gate', () => {
  it('routes .csv and .xlsx to their providers', () => {
    const csv = resolveParser({ name: 'r.csv', size: 10 })
    const xls = resolveParser({ name: 'r.xlsx', size: 10 })
    expect(csv.ok && csv.parser.id).toBe('csv')
    expect(xls.ok && xls.parser.id).toBe('excel')
  })

  it('rejects an unsupported extension', () => {
    const out = resolveParser({ name: 'r.txt', size: 10 })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).toMatch(/not supported/i)
  })

  it('names PDF and ZIP as future formats rather than a flat refusal', () => {
    for (const ext of ['pdf', 'zip']) {
      const out = resolveParser({ name: `r.${ext}`, size: 10 })
      expect(out.ok).toBe(false)
      expect(!out.ok && out.message).toMatch(/planned for a later release/i)
    }
  })

  it('rejects a file with no extension', () => {
    expect(resolveParser({ name: 'results', size: 10 }).ok).toBe(false)
  })

  it('rejects a zero-byte file', () => {
    const out = resolveParser({ name: 'r.csv', size: 0 })
    expect(!out.ok && out.message).toMatch(/empty/i)
  })

  it('rejects a file over the size cap', () => {
    const out = resolveParser({ name: 'r.csv', size: RESULTS_MAX_FILE_BYTES + 1 })
    expect(!out.ok && out.message).toMatch(/too large/i)
  })

  it('accepts a file exactly at the cap', () => {
    expect(resolveParser({ name: 'r.csv', size: RESULTS_MAX_FILE_BYTES }).ok).toBe(true)
  })
})
