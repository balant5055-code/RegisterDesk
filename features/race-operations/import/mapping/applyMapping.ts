// RD-RACEOPS-01 Sprint 2 · ParsedTable + ColumnMapping → NormalizedRaceResult[].
//
// PURE. THE only place the canonical model is constructed, so every provider — present
// and future — produces identical records and validation has exactly one input shape.

import type {
  ColumnMapping, NormalizedRaceResult, ParsedTable, RaceResultStatus,
} from '@/features/race-operations/types/results'
import { parseRaceTime } from '../validation/time'

// ─── Status normalisation ─────────────────────────────────────────────────────

/** Raw status spellings seen across timing exports → canonical status. */
const STATUS_ALIASES: Readonly<Record<string, RaceResultStatus>> = {
  finished: 'finished', finish: 'finished', fin: 'finished', f: 'finished',
  ok: 'finished', complete: 'finished', completed: 'finished', valid: 'finished',
  dnf: 'dnf', didnotfinish: 'dnf', retired: 'dnf', ret: 'dnf', abandoned: 'dnf',
  dns: 'dns', didnotstart: 'dns', nostart: 'dns', absent: 'dns', noshow: 'dns',
  dq: 'dq', dsq: 'dq', disqualified: 'dq', disq: 'dq',
}

function normalizeStatusToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * Resolves the status for a row.
 *
 * Blank, unmapped, or unrecognised ⇒ `finished`. A row with no status and no usable
 * time is therefore `finished` and is caught by validation as "missing time", which is
 * the honest outcome: inventing a DNF for a row the organizer merely left incomplete
 * would silently alter their results. An unrecognised non-empty status additionally
 * raises a warning — see `isUnrecognisedStatus`.
 */
export function resolveStatus(rawStatus: string): RaceResultStatus {
  const token = normalizeStatusToken(rawStatus)
  return (token !== '' ? STATUS_ALIASES[token] : undefined) ?? 'finished'
}

/** True when a non-empty status cell could not be understood. Reported as a warning —
 *  never silently swallowed. */
export function isUnrecognisedStatus(rawStatus: string): boolean {
  const token = normalizeStatusToken(rawStatus)
  return token !== '' && STATUS_ALIASES[token] === undefined
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function cellFor(
  cells:   Readonly<Record<string, string>>,
  mapping: ColumnMapping,
  field:   keyof ColumnMapping,
): string {
  const header = mapping[field]
  if (!header) return ''
  return (cells[header] ?? '').trim()
}

const orNull = (v: string): string | null => (v === '' ? null : v)

export function applyMapping(table: ParsedTable, mapping: ColumnMapping): NormalizedRaceResult[] {
  return table.rows.map(row => {
    const bib      = cellFor(row.cells, mapping, 'bibNumber')
    const chipRaw  = cellFor(row.cells, mapping, 'chipTime')
    const gunRaw   = cellFor(row.cells, mapping, 'gunTime')
    const statusRaw = cellFor(row.cells, mapping, 'status')

    const chip = parseRaceTime(chipRaw)
    const gun  = parseRaceTime(gunRaw)

    return {
      rowNumber:       row.rowNumber,
      participantName: orNull(cellFor(row.cells, mapping, 'participantName')),
      bibNumber:      orNull(bib),
      chipTimeMs:     chip.ok ? chip.ms : null,
      gunTimeMs:      gun.ok  ? gun.ms  : null,
      chipTimeRaw:    orNull(chipRaw),
      gunTimeRaw:     orNull(gunRaw),
      status:         resolveStatus(statusRaw),
      statusRaw:      orNull(statusRaw),
      gender:         orNull(cellFor(row.cells, mapping, 'gender')),
      category:       orNull(cellFor(row.cells, mapping, 'category')),
      ageGroup:       orNull(cellFor(row.cells, mapping, 'ageGroup')),
      rawRow:         row.cells,
      sourceProvider: table.provider,
    }
  })
}
