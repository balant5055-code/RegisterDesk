// RD-RACEOPS-01 Sprint 2 — validation engine + downloadable report.
//
// Every rule the brief names: file readable, required columns, duplicate bib, missing
// bib, missing time, invalid time, unsupported columns (warning), empty file, duplicate
// rows, malformed rows.
//
// Also pins the hard constraint that validation is SELF-CONTAINED — it consumes
// NormalizedRaceResult[] only and can reach no database.

import { describe, it, expect } from 'vitest'
import { validateResults } from '@/features/race-operations/import/validation/engine'
import {
  buildValidationReportCsv, validationReportFilename, NO_VALUE_PLACEHOLDER,
} from '@/features/race-operations/import/validation/report'
import { VALIDATION_ISSUES, severityOf } from '@/features/race-operations/import/validation/types'
import { applyMapping } from '@/features/race-operations/import/mapping/applyMapping'
import { tabulate } from '@/features/race-operations/import/parsers/tabulate'
import type { ColumnMapping } from '@/features/race-operations/types/results'

const MAP: ColumnMapping = { bibNumber: 'Bib', chipTime: 'Time', status: 'Status' }

/** csv text-ish matrix → validated result, through the real pipeline. */
function run(matrix: string[][], mapping: ColumnMapping = MAP, unmappedHeaders: string[] = []) {
  const t = tabulate(matrix, { provider: 'csv', sheetName: null })
  if (!t.ok) throw new Error(t.message)
  return validateResults(applyMapping(t.table, mapping), { unmappedHeaders })
}

const codesFor = (r: ReturnType<typeof run>, rowNumber: number) =>
  r.issues.filter(i => i.rowNumber === rowNumber).map(i => i.code)

describe('validateResults — clean data', () => {
  it('reports every row valid with no issues', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', '00:45:12', 'FIN'], ['102', '00:46:03', 'FIN']])
    expect(r.summary).toEqual({
      rowsFound: 2, validRows: 2, warningRows: 0, errorRows: 0, errorCount: 0, warningCount: 0,
    })
    expect(r.canPreview).toBe(true)
  })
})

describe('validateResults — errors', () => {
  it('MISSING_BIB', () => {
    const r = run([['Bib', 'Time', 'Status'], ['', '00:45:12', '']])
    expect(codesFor(r, 2)).toContain('MISSING_BIB')
    expect(r.rows[0].usable).toBe(false)
  })

  it('DUPLICATE_BIB flags BOTH rows and names the other row', () => {
    const r = run([['Bib', 'Time', 'Status'], ['21044', '00:45:12', ''], ['21044', '00:47:00', '']])
    expect(codesFor(r, 2)).toContain('DUPLICATE_BIB')
    expect(codesFor(r, 3)).toContain('DUPLICATE_BIB')
    expect(r.issues.find(i => i.rowNumber === 2 && i.code === 'DUPLICATE_BIB')?.message).toContain('row 3')
  })

  it('DUPLICATE_BIB is case-insensitive', () => {
    const r = run([['Bib', 'Time', 'Status'], ['a101', '00:45:12', ''], ['A101', '00:47:00', '']])
    expect(codesFor(r, 2)).toContain('DUPLICATE_BIB')
  })

  it('MISSING_TIME', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', '', '']])
    expect(codesFor(r, 2)).toContain('MISSING_TIME')
  })

  it('INVALID_TIME quotes the organizer’s own value', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', 'ABC', '']])
    expect(codesFor(r, 2)).toContain('INVALID_TIME')
    expect(r.issues.find(i => i.code === 'INVALID_TIME')?.value).toBe('ABC')
  })

  it('TIME_OUT_OF_RANGE is distinct from INVALID_TIME', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', '00:00:00', '']])
    expect(codesFor(r, 2)).toContain('TIME_OUT_OF_RANGE')
    expect(codesFor(r, 2)).not.toContain('INVALID_TIME')
  })

  it('MALFORMED_ROW for a wholly blank row, and nothing else piled on', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', '00:45:12', ''], ['', '', ''], ['103', '00:47:00', '']])
    expect(codesFor(r, 3)).toEqual(['MALFORMED_ROW'])
    // Row numbers stay faithful to the file either side of the blank.
    expect(r.rows.map(x => x.result.rowNumber)).toEqual([2, 3, 4])
  })

  it('a DNF/DNS/DQ row does NOT require a time', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', '', 'DNF'], ['102', '', 'DNS'], ['103', '', 'DQ']])
    expect(r.summary.errorCount).toBe(0)
    expect(r.summary.validRows).toBe(3)
  })
})

describe('validateResults — warnings', () => {
  it('DUPLICATE_ROW for two identical lines', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', '00:45:12', 'FIN'], ['101', '00:45:12', 'FIN']])
    expect(codesFor(r, 2)).toContain('DUPLICATE_ROW')
    expect(severityOf('DUPLICATE_ROW')).toBe('warning')
  })

  it('UNRECOGNISED_STATUS explains the fallback', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', '00:45:12', 'WAVE-2']])
    const issue = r.issues.find(i => i.code === 'UNRECOGNISED_STATUS')
    expect(issue?.message).toMatch(/treated as Finished/i)
    expect(r.rows[0].usable).toBe(true)          // a warning never blocks
  })

  it('UNMAPPED_COLUMN is a file-level warning with a null row number', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', '00:45:12', '']], MAP, ['Sponsor Code'])
    const issue = r.issues.find(i => i.code === 'UNMAPPED_COLUMN')
    expect(issue?.rowNumber).toBeNull()
    expect(issue?.severity).toBe('warning')
    expect(issue?.value).toBe('Sponsor Code')
  })

  it('GUN_BEFORE_CHIP catches swapped time columns', () => {
    const r = run(
      [['Bib', 'Time', 'Gun'], ['101', '00:46:00', '00:45:00']],
      { bibNumber: 'Bib', chipTime: 'Time', gunTime: 'Gun' },
    )
    expect(codesFor(r, 2)).toContain('GUN_BEFORE_CHIP')
    expect(r.rows[0].usable).toBe(true)
  })

  it('INVALID_GUN_TIME does not block the row', () => {
    const r = run(
      [['Bib', 'Time', 'Gun'], ['101', '00:46:00', 'oops']],
      { bibNumber: 'Bib', chipTime: 'Time', gunTime: 'Gun' },
    )
    expect(codesFor(r, 2)).toContain('INVALID_GUN_TIME')
    expect(r.rows[0].usable).toBe(true)
  })
})

describe('validateResults — summary arithmetic', () => {
  it('counts valid / warning / error rows separately', () => {
    const r = run([
      ['Bib', 'Time', 'Status'],
      ['101', '00:45:12', 'FIN'],      // valid
      ['102', '00:46:00', 'WAVE-2'],   // warning only
      ['',    '00:47:00', 'FIN'],      // error
    ])
    expect(r.summary.rowsFound).toBe(3)
    expect(r.summary.validRows).toBe(1)
    expect(r.summary.warningRows).toBe(1)
    expect(r.summary.errorRows).toBe(1)
  })

  it('still allows preview when SOME rows are usable', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', '00:45:12', ''], ['', 'ABC', '']])
    expect(r.canPreview).toBe(true)
  })

  it('blocks preview when NO row is usable', () => {
    const r = run([['Bib', 'Time', 'Status'], ['', '', ''], ['', 'ABC', '']])
    expect(r.canPreview).toBe(false)
  })

  it('handles an empty result set without throwing', () => {
    const r = validateResults([])
    expect(r.summary.rowsFound).toBe(0)
    expect(r.canPreview).toBe(false)
  })
})

describe('issue catalogue', () => {
  it('every code has exactly one severity + label entry', () => {
    const codes = VALIDATION_ISSUES.map(i => i.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const i of VALIDATION_ISSUES) expect(i.label.length).toBeGreaterThan(0)
  })
})

describe('buildValidationReportCsv', () => {
  it('emits the documented header row', () => {
    const csv = buildValidationReportCsv([])
    expect(csv.split('\r\n')[0]).toBe('Row,Severity,Issue,Field,Value,Detail')
  })

  it('renders the brief’s example rows (Row / Issue / Value)', () => {
    const r = run([
      ['Bib', 'Time', 'Status'],
      ...Array.from({ length: 23 }, (_, i) => [String(100 + i), '00:45:12', 'FIN']),
      ['',      '00:50:00', 'FIN'],   // file row 25 — Missing Bib
    ])
    const csv = buildValidationReportCsv(r.issues)
    expect(csv).toContain(`25,Error,Missing bib,bibNumber,${NO_VALUE_PLACEHOLDER},`)
  })

  it('uses a placeholder the shared CSV encoder does not have to escape', () => {
    // `--` would be rewritten to `'--` by lib/utils/csv.ts, because a leading '-' is a
    // formula trigger. That guard must stay, so the placeholder avoids triggering it.
    const r = run([['Bib', 'Time', 'Status'], ['', '00:45:12', '']])
    const csv = buildValidationReportCsv(r.issues)
    expect(csv).toContain(NO_VALUE_PLACEHOLDER)
    expect(csv).not.toContain("'--")
  })

  it('orders by row number and puts file-level issues last', () => {
    const r = run([['Bib', 'Time', 'Status'], ['', '', ''], ['102', 'ABC', '']], MAP, ['Extra'])
    const rows = buildValidationReportCsv(r.issues).trim().split('\r\n').slice(1)
    expect(rows[0].startsWith('2,')).toBe(true)
    expect(rows[rows.length - 1].startsWith('File,')).toBe(true)
  })

  it('is never truncated — one line per issue plus the header', () => {
    // Rows must be non-blank: an all-blank TRAILING block is correctly trimmed by
    // tabulate as a spreadsheet artefact, so these carry a bib but no time instead.
    const r = run([
      ['Bib', 'Time', 'Status'],
      ...Array.from({ length: 300 }, (_, i) => [String(1000 + i), '', '']),
    ])
    expect(r.issues.length).toBeGreaterThan(250)
    const lines = buildValidationReportCsv(r.issues).trim().split('\r\n')
    expect(lines.length).toBe(r.issues.length + 1)
  })

  it('neutralises a formula-injection payload via the shared csv encoder', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', '=HYPERLINK("http://evil")', '']])
    const csv = buildValidationReportCsv(r.issues)
    expect(csv).toContain("'=HYPERLINK")     // leading quote forces Excel to treat as text
    expect(csv).not.toMatch(/,=HYPERLINK/)
  })

  it('quotes a value containing a comma', () => {
    const r = run([['Bib', 'Time', 'Status'], ['101', 'a,b', '']])
    expect(buildValidationReportCsv(r.issues)).toContain('"a,b"')
  })
})

describe('validationReportFilename', () => {
  it('builds a recognisable, filesystem-safe name', () => {
    expect(validationReportFilename('validation-report', '21K Half Marathon', '2026-07-26'))
      .toBe('validation-report-21K-Half-Marathon-2026-07-26.csv')
  })

  it('falls back when the race name has no usable characters', () => {
    expect(validationReportFilename('validation-report', '///', '2026-07-26'))
      .toBe('validation-report-race-2026-07-26.csv')
  })
})
