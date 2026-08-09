// RD-RACEOPS-01 Sprint 2 — column mapping + the canonical model.
//
// Covers the brief's requirement that no single Excel format is imposed:
//   Bib No → bibNumber · Net Time → chipTime · Runner ID → bibNumber

import { describe, it, expect } from 'vitest'
import { autoMapColumns, missingRequiredFields } from '@/features/race-operations/import/mapping/autoMap'
import { applyMapping, resolveStatus, isUnrecognisedStatus } from '@/features/race-operations/import/mapping/applyMapping'
import { normalizeHeader } from '@/features/race-operations/import/mapping/aliases'
import { tabulate } from '@/features/race-operations/import/parsers/tabulate'
import { RESULT_FIELDS } from '@/features/race-operations/types/results'
import type { ColumnMapping, ParsedTable } from '@/features/race-operations/types/results'

const table = (matrix: string[][]): ParsedTable => {
  const out = tabulate(matrix, { provider: 'csv', sheetName: null })
  if (!out.ok) throw new Error(out.message)
  return out.table
}

describe('normalizeHeader', () => {
  it('collapses punctuation, spacing and case', () => {
    for (const h of ['Bib No', 'bib_no', 'BIB-NO', 'Bib  No.', 'bibNo']) {
      expect(normalizeHeader(h)).toBe('bibno')
    }
  })
})

describe('autoMapColumns — the brief’s examples', () => {
  it('Bib No → bibNumber', () => {
    expect(autoMapColumns(['Bib No']).mapping.bibNumber).toBe('Bib No')
  })

  it('Net Time → chipTime', () => {
    expect(autoMapColumns(['Net Time']).mapping.chipTime).toBe('Net Time')
  })

  it('Runner ID → bibNumber', () => {
    expect(autoMapColumns(['Runner ID']).mapping.bibNumber).toBe('Runner ID')
  })

  it('maps a full realistic header row', () => {
    const { mapping, unmappedHeaders } = autoMapColumns(
      ['Bib No', 'Net Time', 'Gun Time', 'Status', 'Gender', 'Category', 'Age Group'],
    )
    expect(mapping).toEqual({
      bibNumber: 'Bib No', chipTime: 'Net Time', gunTime: 'Gun Time',
      status: 'Status', gender: 'Gender', category: 'Category', ageGroup: 'Age Group',
    })
    expect(unmappedHeaders).toEqual([])
  })

  it('matches a decorated heading by substring', () => {
    expect(autoMapColumns(['Net Time (hh:mm:ss)']).mapping.chipTime).toBe('Net Time (hh:mm:ss)')
  })

  it('reports headers it could not place, so nothing is silently ignored', () => {
    const { mapping, unmappedHeaders } = autoMapColumns(['Bib', 'Chip Time', 'Sponsor Code', 'T-Shirt'])
    expect(mapping.bibNumber).toBe('Bib')
    expect(unmappedHeaders).toEqual(['Sponsor Code', 'T-Shirt'])
  })

  it('never assigns one header to two fields', () => {
    const { mapping } = autoMapColumns(['Time'])
    const used = Object.values(mapping)
    expect(new Set(used).size).toBe(used.length)
  })

  it('gives the first matching header the field when two compete', () => {
    const { mapping } = autoMapColumns(['Chip Time', 'Net Time'])
    expect(mapping.chipTime).toBe('Chip Time')
  })

  it('produces an empty mapping for a wholly unrecognisable header row', () => {
    const { mapping, unmappedHeaders } = autoMapColumns(['Alpha', 'Beta'])
    expect(mapping).toEqual({})
    expect(unmappedHeaders).toEqual(['Alpha', 'Beta'])
  })
})

describe('missingRequiredFields', () => {
  it('lists required fields that are unmapped', () => {
    expect(missingRequiredFields({})).toEqual(['bibNumber', 'chipTime'])
    expect(missingRequiredFields({ bibNumber: 'Bib' })).toEqual(['chipTime'])
    expect(missingRequiredFields({ bibNumber: 'Bib', chipTime: 'Time' })).toEqual([])
  })

  it('never demands an optional field', () => {
    const optional = RESULT_FIELDS.filter(f => !f.required).map(f => f.field)
    expect(missingRequiredFields({ bibNumber: 'B', chipTime: 'T' })).not.toEqual(
      expect.arrayContaining(optional),
    )
  })
})

describe('resolveStatus / isUnrecognisedStatus', () => {
  it.each([
    ['Finished', 'finished'], ['FIN', 'finished'], ['ok', 'finished'], ['Completed', 'finished'],
    ['DNF', 'dnf'], ['Did Not Finish', 'dnf'], ['retired', 'dnf'],
    ['DNS', 'dns'], ['no show', 'dns'],
    ['DQ', 'dq'], ['DSQ', 'dq'], ['Disqualified', 'dq'],
  ])('maps %s → %s', (raw, expected) => {
    expect(resolveStatus(raw)).toBe(expected)
  })

  it('defaults a blank status to finished rather than inventing a DNF', () => {
    expect(resolveStatus('')).toBe('finished')
    expect(isUnrecognisedStatus('')).toBe(false)
  })

  it('treats an unknown status as finished but flags it', () => {
    expect(resolveStatus('WAVE-2')).toBe('finished')
    expect(isUnrecognisedStatus('WAVE-2')).toBe(true)
  })
})

describe('applyMapping — building NormalizedRaceResult', () => {
  const t = table([
    ['Bib No', 'Net Time', 'Gun Time', 'Status', 'Gender', 'Category', 'Age Group', 'Sponsor'],
    ['0042',   '01:48:32', '01:49:10', 'FIN',    'M',      'Open',     '30-39',     'ACME'],
  ])
  const mapping: ColumnMapping = {
    bibNumber: 'Bib No', chipTime: 'Net Time', gunTime: 'Gun Time',
    status: 'Status', gender: 'Gender', category: 'Category', ageGroup: 'Age Group',
  }

  it('produces the canonical shape', () => {
    const [r] = applyMapping(t, mapping)
    expect(r.rowNumber).toBe(2)
    expect(r.bibNumber).toBe('0042')          // leading zero preserved — bibs are strings
    expect(r.chipTimeMs).toBe(6_512_000)
    expect(r.gunTimeMs).toBe(6_550_000)
    expect(r.chipTimeRaw).toBe('01:48:32')
    expect(r.status).toBe('finished')
    expect(r.gender).toBe('M')
    expect(r.category).toBe('Open')
    expect(r.ageGroup).toBe('30-39')
    expect(r.sourceProvider).toBe('csv')
  })

  it('retains the FULL original row, including unmapped columns', () => {
    const [r] = applyMapping(t, mapping)
    expect(r.rawRow['Sponsor']).toBe('ACME')
  })

  it('uses null — never undefined or empty string — for an unmapped optional field', () => {
    const [r] = applyMapping(t, { bibNumber: 'Bib No', chipTime: 'Net Time' })
    expect(r.gunTimeMs).toBeNull()
    expect(r.gunTimeRaw).toBeNull()
    expect(r.gender).toBeNull()
    expect(r.statusRaw).toBeNull()
  })

  it('keeps an unreadable time as raw text with a null millisecond value', () => {
    const bad = table([['Bib', 'Time'], ['101', 'ABC']])
    const [r] = applyMapping(bad, { bibNumber: 'Bib', chipTime: 'Time' })
    expect(r.chipTimeRaw).toBe('ABC')
    expect(r.chipTimeMs).toBeNull()
  })

  it('stamps every record with the producing provider', () => {
    const xl = table([['Bib', 'Time'], ['1', '1:00']])
    const rows = applyMapping({ ...xl, provider: 'excel' }, { bibNumber: 'Bib', chipTime: 'Time' })
    expect(rows.every(r => r.sourceProvider === 'excel')).toBe(true)
  })
})
