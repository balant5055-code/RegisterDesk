// RD-RACEOPS-02C · The results template and start list are DERIVED from the canonical
// result model — never a hand-typed list — and round-trip through the real parser and
// mapper with every column detected exactly.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TEMPLATE_COLUMNS, TEMPLATE_HEADERS, RESULTS_SHEET, HOW_TO_FILL_SHEET,
  SPLITS_SHEET, SPLIT_TEMPLATE_HEADERS,
  howToFillRows, resultsCsv, resultsWorkbookTables, templateFileStem,
} from '@/features/race-operations/templates/resultsTemplate'
import { RESULT_FIELDS, REQUIRED_RESULT_FIELDS, RACE_RESULT_STATUS_LABEL } from '@/features/race-operations/types/results'
import { autoMapColumns } from '@/features/race-operations/import/mapping/autoMap'
import { readCsvText } from '@/features/race-operations/import/parsers/csv/readCsvText'
import { tabulate } from '@/features/race-operations/import/parsers/tabulate'
import { applyMapping } from '@/features/race-operations/import/mapping/applyMapping'
import { validateResults } from '@/features/race-operations/import/validation/engine'
import { selectResultsSheet } from '@/features/race-operations/import/parsers/excel/excelParser'
import { tablesToXlsx } from '@/lib/reports/xlsx'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('template columns are the canonical fields', () => {
  it('one column per RESULT_FIELDS entry, headers are the fields\' own labels, nothing invented', () => {
    expect(TEMPLATE_COLUMNS.map(c => c.field).sort()).toEqual(RESULT_FIELDS.map(f => f.field).sort())
    for (const c of TEMPLATE_COLUMNS) {
      expect(c.header).toBe(RESULT_FIELDS.find(f => f.field === c.field)!.label)
      expect(c.required).toBe(REQUIRED_RESULT_FIELDS.includes(c.field))
    }
  })

  it('no rank / position column — ranking is computed server-side', () => {
    expect(TEMPLATE_HEADERS.some(h => /rank|position/i.test(h))).toBe(false)
  })

  it('identity first, required columns present, sport-neutral naming', () => {
    expect(TEMPLATE_HEADERS[0]).toBe('Bib Number')
    expect(TEMPLATE_HEADERS).toContain('Chip Time')
    expect(TEMPLATE_HEADERS.join(' ')).not.toMatch(/runner/i)
    expect(TEMPLATE_HEADERS).toContain('Participant Name')
  })

  it('every header maps EXACTLY through the real auto-mapper, in any order', () => {
    const shuffled = [...TEMPLATE_HEADERS].reverse()
    const r = autoMapColumns(shuffled)
    expect(r.unmappedHeaders).toEqual([])
    for (const c of TEMPLATE_COLUMNS) {
      expect(r.mapping[c.field], c.field).toBe(c.header)
      expect(r.confidence[c.field], c.field).toBe('exact')
    }
  })
})

describe('the CSV template round-trips through the parser', () => {
  it('an empty template has a header row and no result rows — never a phantom result', () => {
    const csv = resultsCsv()
    expect(csv.split('\n').filter(Boolean)).toHaveLength(1)
    const outcome = tabulate(readCsvText(csv), { provider: 'csv', sheetName: null })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/no result rows/)
  })

  it('a start list prefilled from the roster parses, maps and validates as unfinished rows', () => {
    const csv = resultsCsv([{ bibNumber: '101', participantName: 'Asha, Kumar' }, { bibNumber: '102', participantName: null }])
    const table = tabulate(readCsvText(csv), { provider: 'csv', sheetName: null })
    expect(table.ok).toBe(true)
    if (!table.ok) return
    expect(table.table.headers).toEqual([...TEMPLATE_HEADERS])
    expect(table.table.rows[0].cells['Participant Name']).toBe('Asha, Kumar')   // quoted comma survives
    const auto = autoMapColumns(table.table.headers)
    const v = validateResults(applyMapping(table.table, auto.mapping))
    // identity present, times still to be filled in
    expect(v.summary.rowsFound).toBe(2)
    expect(v.issues.filter(i => i.code === 'MISSING_TIME')).toHaveLength(2)
    expect(v.issues.filter(i => i.code === 'MISSING_BIB')).toHaveLength(0)
  })

  it('a filled-in start list validates clean', () => {
    const csv = resultsCsv([{ bibNumber: '101', participantName: 'A' }]).replace(/\n$/, '') // header only + one row below
    // RD-RACEOPS-RESULTS-04 · the row is built from the HEADERS rather than a hand-counted
    // list of cells, so adding a column can never silently shift a time into another field —
    // which is exactly what happened to this test when Distance was added.
    const values: Record<string, string> = {
      'Bib Number': '101', 'Participant Name': 'A', Distance: '10 KM',
      'Chip Time': '01:48:32', 'Gun Time': '01:49:00', Status: 'Finished',
    }
    const filled = csv.split('\n')[0] + '\n' + TEMPLATE_HEADERS.map(h => values[h] ?? '').join(',') + '\n'
    const table = tabulate(readCsvText(filled), { provider: 'csv', sheetName: null })
    if (!table.ok) throw new Error(table.message)
    const v = validateResults(applyMapping(table.table, autoMapColumns(table.table.headers).mapping))
    expect(v.summary).toMatchObject({ rowsFound: 1, validRows: 1, errorCount: 0, warningCount: 0 })
  })
})

describe('the XLSX workbook', () => {
  it('has the Results sheet first and the How to fill sheet second, and the writer accepts it', () => {
    const tables = resultsWorkbookTables([{ bibNumber: '7', participantName: 'P' }], { eventName: 'E', raceName: '10K', participantCount: 1 })
    // RD-RACEOPS-RESULTS-04 · the optional Splits sheet sits between the data and the help.
    expect(tables.map(t => t.title)).toEqual([RESULTS_SHEET, SPLITS_SHEET, HOW_TO_FILL_SHEET])
    expect(tables[1].columns.map(c => c.label)).toEqual([...SPLIT_TEMPLATE_HEADERS])
    // …and it ships EMPTY: a sample row would carry a bib that is not on this race's start
    // list, so an unedited upload would fail on the very sheet meant to help.
    expect(tables[1].rows).toEqual([])
    expect(tables[0].columns.map(c => c.label)).toEqual([...TEMPLATE_HEADERS])
    const buf = tablesToXlsx(tables)
    expect(buf.length).toBeGreaterThan(500)
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')   // a zip container
  })

  it('the parser prefers the sheet named Results even when the instructions sheet also has rows', () => {
    const picked = selectResultsSheet([
      { sheet: HOW_TO_FILL_SHEET, data: [['Topic', 'Details'], ['Event', 'E']] },
      { sheet: RESULTS_SHEET,     data: [[...TEMPLATE_HEADERS], ['101', '', '01:00:00', '', '', '', '', '']] },
    ])
    expect(picked?.sheet).toBe(RESULTS_SHEET)
    // an unfilled Results sheet (header only) is not picked over nothing — the workbook then
    // reports header-only, never the instructions as results
    const headerOnly = selectResultsSheet([
      { sheet: RESULTS_SHEET,     data: [[...TEMPLATE_HEADERS]] },
      { sheet: HOW_TO_FILL_SHEET, data: [['Topic', 'Details'], ['Event', 'E']] },
    ])
    expect(headerOnly?.sheet).toBe(HOW_TO_FILL_SHEET)   // documented fallback: first sheet with rows
    const parsed = tabulate(headerOnly!.data, { provider: 'excel', sheetName: headerOnly!.sheet })
    // …which maps to no bib column and is refused at mapping, not imported.
    expect(parsed.ok && autoMapColumns(parsed.table.headers).mapping.bibNumber).toBeUndefined()
  })

  it('How to fill quotes the parser vocabulary: statuses, time forms, required columns, one race, no duplicates', () => {
    const rows = howToFillRows({ eventName: 'Coimbatore Marathon', raceName: '10K', participantCount: 1197 })
    const text = rows.map(r => `${r.topic}: ${r.details}`).join('\n')
    for (const s of Object.values(RACE_RESULT_STATUS_LABEL)) expect(text).toContain(s)
    expect(text).toContain('hh:mm:ss')
    expect(text).toContain('Bib Number and Chip Time')
    expect(text).toContain('One workbook = this one race')
    expect(text).toContain('duplicate bibs are rejected')
    expect(text).toContain('1,197')
    expect(text).toMatch(/Chip \/ Net Time/)
    expect(text).toMatch(/Gun \/ Gross Time/)
    // RD-RACEOPS-RESULTS-04 · the old line said only that rank "is not a column". The sheet
    // now names everything RegisterDesk works out, because a provider export carries all of
    // it and the organizer needs to know none of it is imported.
    expect(text).toContain('What RegisterDesk calculates')
    expect(text).toMatch(/position within gender/)
    expect(text).toMatch(/pace and speed/)
    expect(text).toContain('Every bib must be on this race')
    expect(text).toMatch(/Time of Day is a clock reading/)
    expect(text).toMatch(/CSV file holds one sheet/)
    // the worked example lives in the instructions, not in the sheet
    expect(text).toContain('00:16:30')
    expect(text).toContain('10571')
  })

  it('filenames carry the race', () => {
    expect(templateFileStem('start-list', 'cbe-2026', '10k')).toBe('start-list-cbe-2026-10k')
  })
})

describe('the routes are read-only and derive from the same module', () => {
  it('start list reads the verification roster and writes nothing', () => {
    const src = read('app/api/organizer/race-operations/races/start-list/route.ts')
    expect(src).toContain('fetchEventRoster')
    expect(src).toContain('resolveRace(authz.workspaceUid, eventId, passId)')
    expect(src).toContain('authorizeRaceOps(req)')
    expect(src).not.toMatch(/\.set\(|\.update\(|\.add\(|batch\(/)
  })
  it('the template route builds from resultsTemplate and never lists fields itself', () => {
    const src = read('app/api/organizer/race-operations/races/template/route.ts')
    expect(src).toContain("from '@/features/race-operations/templates/resultsTemplate'")
    expect(src).not.toMatch(/'Bib Number'|'Chip Time'/)
  })
  it('the dry-run check uses the same matcher as post-import verification and writes nothing', () => {
    const src = read('app/api/organizer/race-operations/races/start-list-check/route.ts')
    expect(src).toContain('matchAgainstRoster')
    expect(src).toContain('fetchEventRoster')
    expect(src).not.toMatch(/createSession|\.set\(|\.update\(/)
  })
})
