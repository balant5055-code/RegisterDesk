// RD-RACEOPS-01 Sprint 2 — CSV reader + provider.
//
// Includes the three cases that make lib/events/builder/contacts.ts `parseCsvText`
// unusable for results, so a future "just reuse the other parser" refactor fails here:
//   • header casing preserved            • file row numbers preserved across blank rows
//   • RFC-4180 `""` escaped quote        (+ empty vs header-only distinguished)

import { describe, it, expect } from 'vitest'
import { readCsvText } from '@/features/race-operations/import/parsers/csv/readCsvText'
import { csvParser } from '@/features/race-operations/import/parsers/csv/csvParser'
import { tabulate } from '@/features/race-operations/import/parsers/tabulate'
import type { ResultFileSource } from '@/features/race-operations/import/parsers/types'

const asFile = (name: string, text: string): ResultFileSource => ({
  name, size: text.length, text: async () => text,
})

describe('readCsvText — RFC-4180', () => {
  it('splits a simple grid', () => {
    expect(readCsvText('Bib,Time\n101,00:45:12')).toEqual([['Bib', 'Time'], ['101', '00:45:12']])
  })

  it('preserves a quoted comma inside a field', () => {
    expect(readCsvText('Name,Note\n"Doe, Jane",ok')).toEqual([['Name', 'Note'], ['Doe, Jane', 'ok']])
  })

  it('decodes the escaped double quote ("" → ") — the existing parseCsvText loses this', () => {
    expect(readCsvText('A\n"he said ""hi"""')).toEqual([['A'], ['he said "hi"']])
  })

  it('keeps a blank line as an empty row so file row numbers do not shift', () => {
    expect(readCsvText('Bib,Time\n\n101,00:45:12')).toEqual([
      ['Bib', 'Time'], [''], ['101', '00:45:12'],
    ])
  })

  it('handles CRLF, LF and CR line endings', () => {
    const expected = [['A', 'B'], ['1', '2']]
    expect(readCsvText('A,B\r\n1,2')).toEqual(expected)
    expect(readCsvText('A,B\n1,2')).toEqual(expected)
    expect(readCsvText('A,B\r1,2')).toEqual(expected)
  })

  it('strips a UTF-8 BOM (Excel writes one by default)', () => {
    expect(readCsvText('﻿Bib,Time\n101,1:00')[0]).toEqual(['Bib', 'Time'])
  })

  it('ignores a single trailing newline but keeps a genuine trailing blank row', () => {
    expect(readCsvText('A\n1\n')).toEqual([['A'], ['1']])
    expect(readCsvText('A\n1\n\n')).toEqual([['A'], ['1'], ['']])
  })

  it('supports a newline inside a quoted field', () => {
    expect(readCsvText('A,B\n"line1\nline2",x')).toEqual([['A', 'B'], ['line1\nline2', 'x']])
  })

  it('returns [] for empty text', () => {
    expect(readCsvText('')).toEqual([])
  })
})

describe('tabulate — headers and row numbers', () => {
  it('preserves ORIGINAL header casing (the mapping UI depends on it)', () => {
    const out = tabulate([['Bib No', 'Net Time'], ['101', '1:00']], { provider: 'csv', sheetName: null })
    expect(out.ok && out.table.headers).toEqual(['Bib No', 'Net Time'])
  })

  it('numbers the first data row 2, because the header is row 1', () => {
    const out = tabulate([['Bib'], ['101'], ['102']], { provider: 'csv', sheetName: null })
    expect(out.ok && out.table.rows.map(r => r.rowNumber)).toEqual([2, 3])
  })

  it('keeps an interior blank row so later row numbers stay true to the file', () => {
    const out = tabulate([['Bib'], ['101'], [''], ['103']], { provider: 'csv', sheetName: null })
    expect(out.ok && out.table.rows.map(r => r.rowNumber)).toEqual([2, 3, 4])
    expect(out.ok && out.table.rows[2].cells['Bib']).toBe('103')
  })

  it('trims trailing all-blank rows (a spreadsheet export artefact)', () => {
    const out = tabulate([['Bib'], ['101'], [''], ['']], { provider: 'csv', sheetName: null })
    expect(out.ok && out.table.rows.map(r => r.rowNumber)).toEqual([2])
  })

  it('de-duplicates repeated header names so both columns stay addressable', () => {
    const out = tabulate([['Time', 'Time'], ['1:00', '2:00']], { provider: 'csv', sheetName: null })
    expect(out.ok && out.table.headers).toEqual(['Time', 'Time (2)'])
    expect(out.ok && out.table.rows[0].cells).toEqual({ 'Time': '1:00', 'Time (2)': '2:00' })
  })

  it('drops trailing empty headers', () => {
    const out = tabulate([['Bib', 'Time', '', ''], ['101', '1:00', '', '']], { provider: 'csv', sheetName: null })
    expect(out.ok && out.table.headers).toEqual(['Bib', 'Time'])
  })

  it('rejects an empty matrix and a header-only file with DIFFERENT messages', () => {
    const empty      = tabulate([], { provider: 'csv', sheetName: null })
    const headerOnly = tabulate([['Bib', 'Time']], { provider: 'csv', sheetName: null })
    expect(empty.ok).toBe(false)
    expect(headerOnly.ok).toBe(false)
    expect(!empty.ok && empty.message).not.toBe(!headerOnly.ok && headerOnly.message)
    expect(!headerOnly.ok && headerOnly.message).toMatch(/no result rows/i)
  })

  it('rejects a file whose first row has no headings', () => {
    const out = tabulate([['', ''], ['101', '1:00']], { provider: 'csv', sheetName: null })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).toMatch(/no column headings/i)
  })
})

describe('csvParser provider', () => {
  it('claims .csv only, case-insensitively', () => {
    expect(csvParser.supports({ name: 'a.csv', size: 1 })).toBe(true)
    expect(csvParser.supports({ name: 'a.CSV', size: 1 })).toBe(true)
    expect(csvParser.supports({ name: 'a.xlsx', size: 1 })).toBe(false)
  })

  it('parses to a ParsedTable stamped with the provider id', async () => {
    const out = await csvParser.parse(asFile('r.csv', 'Bib,Net Time\n101,00:45:12\n'))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.table.provider).toBe('csv')
    expect(out.table.sheetName).toBeNull()
    expect(out.table.rows).toHaveLength(1)
    expect(out.table.rows[0].cells).toEqual({ 'Bib': '101', 'Net Time': '00:45:12' })
  })

  it('reports an empty file rather than throwing', async () => {
    const out = await csvParser.parse(asFile('r.csv', '   '))
    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).toMatch(/empty/i)
  })

  it('reports a read failure as an organizer-facing message, never a stack trace', async () => {
    const out = await csvParser.parse({
      name: 'r.csv', size: 10, text: async () => { throw new Error('ENOENT deep internals') },
    })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).not.toMatch(/ENOENT/)
  })
})
