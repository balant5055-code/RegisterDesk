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

// ─── RD-RACEOPS-02C · timing precedence, order independence, confidence ──────

describe('RD-RACEOPS-02C · chip / finish / gun precedence', () => {
  const perms = <T,>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))

  it('Chip Time + Finish Time → chip ← Chip Time, gun ← Finish Time, in EVERY column order', () => {
    for (const headers of perms(['Bib No', 'Finish Time', 'Chip Time', 'Position', 'Status'])) {
      const r = autoMapColumns(headers)
      expect(r.mapping, headers.join('|')).toMatchObject({ bibNumber: 'Bib No', chipTime: 'Chip Time', gunTime: 'Finish Time', status: 'Status' })
      // RD-RACEOPS-RESULTS-04 · "Position" is a rank RegisterDesk computes itself, so it is
      // now reported as CALCULATED rather than as an unrecognised column. It is still never
      // mapped — the change is what the organizer is told about it.
      expect(r.unmappedHeaders, headers.join('|')).toEqual([])
      expect(r.calculatedHeaders, headers.join('|')).toEqual(['Position'])
      expect(r.confidence.chipTime).toBe('exact')
      expect(r.confidence.gunTime).toBe('review')      // a generic heading was re-read as gun time
    }
  })

  it('Net Time + Gross Time → chip ← Net Time, gun ← Gross Time', () => {
    const r = autoMapColumns(['Gross Time', 'Net Time', 'Bib'])
    expect(r.mapping).toMatchObject({ chipTime: 'Net Time', gunTime: 'Gross Time', bibNumber: 'Bib' })
    expect(r.confidence).toMatchObject({ chipTime: 'exact', gunTime: 'exact', bibNumber: 'exact' })
  })

  it('Net Time + Finish Time → chip ← Net Time, gun ← Finish Time (review)', () => {
    const r = autoMapColumns(['Finish Time', 'Net Time'])
    expect(r.mapping).toMatchObject({ chipTime: 'Net Time', gunTime: 'Finish Time' })
    expect(r.confidence.gunTime).toBe('review')
  })

  it('Finish Time only → chip ← Finish Time, flagged for review, no gun time invented', () => {
    const r = autoMapColumns(['Bib', 'Finish Time'])
    expect(r.mapping).toMatchObject({ chipTime: 'Finish Time' })
    expect(r.mapping.gunTime).toBeUndefined()
    expect(r.confidence.chipTime).toBe('review')
  })

  it('Chip Time only / Net Time only → exact', () => {
    expect(autoMapColumns(['Bib', 'Chip Time']).confidence.chipTime).toBe('exact')
    expect(autoMapColumns(['Bib', 'Net Time']).confidence.chipTime).toBe('exact')
  })

  it('Time only → chip ← Time, review', () => {
    const r = autoMapColumns(['Bib', 'Time'])
    expect(r.mapping.chipTime).toBe('Time')
    expect(r.confidence.chipTime).toBe('review')
    expect(r.mapping.gunTime).toBeUndefined()
  })

  it('two exact chip columns (Chip Time + Net Time) → a deterministic pick, flagged for review', () => {
    const a = autoMapColumns(['Net Time', 'Chip Time'])
    const b = autoMapColumns(['Chip Time', 'Net Time'])
    expect(a.mapping.chipTime).toBe(b.mapping.chipTime)   // alias preference, not column order
    expect(a.mapping.chipTime).toBe('Chip Time')
    expect(a.confidence.chipTime).toBe('review')
    expect(a.unmappedHeaders).toEqual(['Net Time'])
  })

  it('Gun Time + Finish Time (no chip column) → gun ← Gun Time, chip ← Finish Time (review)', () => {
    const r = autoMapColumns(['Gun Time', 'Finish Time'])
    expect(r.mapping).toMatchObject({ gunTime: 'Gun Time', chipTime: 'Finish Time' })
    expect(r.confidence.chipTime).toBe('review')
    expect(r.confidence.gunTime).toBe('exact')
  })

  it('a substring guess ("Net Time (final)") maps but is review-level; the listed "Net Time (hh:mm:ss)" spelling stays exact', () => {
    const r = autoMapColumns(['Bib', 'Net Time (final)'])
    expect(r.mapping.chipTime).toBe('Net Time (final)')
    expect(r.confidence.chipTime).toBe('review')
    expect(autoMapColumns(['Bib', 'Net Time (hh:mm:ss)']).confidence.chipTime).toBe('exact')
  })

  it('an exact alias of another field is never taken as a substring guess for this one', () => {
    // "Gun Time" contains no chip alias; "Chip Time" is exact for chip and must not become gun.
    const r = autoMapColumns(['Chip Time', 'Bib'])
    expect(r.mapping.gunTime).toBeUndefined()
  })

  it('the canonical template headers map exactly, every one', () => {
    const r = autoMapColumns(['Bib Number', 'Participant Name', 'Chip Time', 'Gun Time', 'Status', 'Gender', 'Category', 'Age Group'])
    expect(r.mapping).toEqual({
      bibNumber: 'Bib Number', participantName: 'Participant Name', chipTime: 'Chip Time', gunTime: 'Gun Time',
      status: 'Status', gender: 'Gender', category: 'Category', ageGroup: 'Age Group',
    })
    expect(Object.values(r.confidence).every(c => c === 'exact')).toBe(true)
    expect(r.unmappedHeaders).toEqual([])
  })
})

// ─── RD-RACEOPS-02E · clock-time headings are never guessed as a result time ──

describe('RD-RACEOPS-02E · time-of-day headings never pre-select chipTime', () => {
  const noTiming = (h: string) => {
    const r = autoMapColumns(['Bib', h])
    expect(r.mapping.chipTime, h).toBeUndefined()
    expect(r.mapping.gunTime, h).toBeUndefined()
    expect(r.unmappedHeaders, h).toContain(h)
  }
  it.each(['Start Time', 'Start', 'Start Time of Day', 'Finish Time of Day', 'Race Start Time', 'Lap 1', 'Split 2', 'Checkpoint 3 Time'])(
    '"%s" is left unmapped', h => noTiming(h))

  it('"Clock Time" stays the gun-time alias it always was — never chip time', () => {
    const r = autoMapColumns(['Bib', 'Clock Time'])
    expect(r.mapping.gunTime).toBe('Clock Time')
    expect(r.mapping.chipTime).toBeUndefined()
  })

  it('a Start Time beside a real result column never wins it', () => {
    for (const headers of [['Bib', 'Start Time', 'Elapsed Time'], ['Elapsed Time', 'Start Time', 'Bib'], ['Bib', 'Start Time', 'Time']]) {
      const r = autoMapColumns(headers)
      expect(r.mapping.chipTime, headers.join('|')).toBe(headers.includes('Elapsed Time') ? 'Elapsed Time' : 'Time')
      expect(r.confidence.chipTime).toBe('review')
      expect(r.unmappedHeaders).toContain('Start Time')
    }
  })

  it('legitimate mappings are unchanged', () => {
    expect(autoMapColumns(['Bib', 'Chip Time']).mapping.chipTime).toBe('Chip Time')
    expect(autoMapColumns(['Bib', 'Net Time']).mapping.chipTime).toBe('Net Time')
    expect(autoMapColumns(['Bib', 'Gun Time']).mapping.gunTime).toBe('Gun Time')
    expect(autoMapColumns(['Bib', 'Chip Time']).confidence.chipTime).toBe('exact')
    expect(autoMapColumns(['Bib', 'Net Time']).confidence.chipTime).toBe('exact')
    expect(autoMapColumns(['Bib', 'Gun Time']).confidence.gunTime).toBe('exact')
    for (const h of ['Official Time', 'Elapsed Time', 'Time', 'Elapsed']) {
      const r = autoMapColumns(['Bib', h])
      expect(r.mapping.chipTime, h).toBe(h)
      expect(r.confidence.chipTime, h).toBe('review')
    }
  })

  it('substring guesses come only from exact aliases of five or more characters', () => {
    expect(autoMapColumns(['Bib', 'Net Time (final)']).mapping.chipTime).toBe('Net Time (final)')   // 'nettime' (exact, 7)
    expect(autoMapColumns(['Bib', 'Sometime']).mapping.chipTime).toBeUndefined()                    // 'time' is generic and short
    expect(autoMapColumns(['Bib', 'Timestamp']).mapping.chipTime).toBeUndefined()
  })
})

describe('RD-RACEOPS-02E · sport vocabulary', () => {
  it('Rider and Athlete → participantName, exactly', () => {
    expect(autoMapColumns(['Bib', 'Rider']).mapping.participantName).toBe('Rider')
    expect(autoMapColumns(['Bib', 'Rider']).confidence.participantName).toBe('exact')
    expect(autoMapColumns(['Bib', 'Athlete']).mapping.participantName).toBe('Athlete')
  })

  it('Total alone → chipTime at review level; beside Chip Time or Net Time it never wins', () => {
    const alone = autoMapColumns(['Bib', 'Total'])
    expect(alone.mapping.chipTime).toBe('Total')
    expect(alone.confidence.chipTime).toBe('review')
    for (const headers of [['Bib', 'Total', 'Chip Time'], ['Chip Time', 'Total', 'Bib'], ['Bib', 'Total', 'Net Time']]) {
      const r = autoMapColumns(headers)
      expect(r.mapping.chipTime, headers.join('|')).toBe(headers.includes('Chip Time') ? 'Chip Time' : 'Net Time')
      expect(r.confidence.chipTime, headers.join('|')).toBe('exact')
      expect(r.unmappedHeaders, headers.join('|')).toContain('Total')
    }
  })
})

describe('RD-RACEOPS-02E · status words', () => {
  it('the four outcomes and their accepted spellings still resolve', () => {
    for (const [raw, want] of [['Finished', 'finished'], ['FIN', 'finished'], ['Finisher', 'finished'], ['Completed', 'finished'], ['DNF', 'dnf'], ['DNS', 'dns'], ['DQ', 'dq'], ['DSQ', 'dq'], ['Disqualified', 'dq'], [' dnf ', 'dnf'], ['SCR', 'dns'], ['Scratched', 'dns']] as const) {
      expect(resolveStatus(raw), raw).toBe(want)
      expect(isUnrecognisedStatus(raw), raw).toBe(false)
    }
  })
  it.each(['LAP', 'OTL', 'DNP', 'Outside Time Limit', 'WAVE-2', 'DNF (injury)'])('"%s" is unrecognised — never a silent Finished', raw => {
    expect(isUnrecognisedStatus(raw)).toBe(true)
  })
})
