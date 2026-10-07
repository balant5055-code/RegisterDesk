// RD-RACEOPS-01 Sprint 2 · ParsedTable + ColumnMapping → NormalizedRaceResult[].
//
// PURE. THE only place the canonical model is constructed, so every provider — present
// and future — produces identical records and validation has exactly one input shape.

import type {
  ColumnMapping, NormalizedRaceResult, ParsedTable, RaceResultStatus,
} from '@/features/race-operations/types/results'
import { parseRaceTime } from '../validation/time'
import { parseRaceDistance } from '../validation/distance'

// ─── Status normalisation ─────────────────────────────────────────────────────

/** Raw status spellings seen across timing exports → canonical status. */
const STATUS_ALIASES: Readonly<Record<string, RaceResultStatus>> = {
  finished: 'finished', finish: 'finished', fin: 'finished', f: 'finished',
  ok: 'finished', complete: 'finished', completed: 'finished', valid: 'finished',
  // RD-RACEOPS-02E · the noun form is unambiguous; "Finisher" is what many exports print.
  finisher: 'finished',
  dnf: 'dnf', didnotfinish: 'dnf', retired: 'dnf', ret: 'dnf', abandoned: 'dnf',
  dns: 'dns', didnotstart: 'dns', nostart: 'dns', absent: 'dns', noshow: 'dns',
  // RD-RACEOPS-02E · a scratched entrant did not start (swimming / athletics vocabulary).
  scr: 'dns', scratched: 'dns',
  dq: 'dq', dsq: 'dq', disqualified: 'dq', disq: 'dq',
  // Words such as LAP, OTL, DNP are deliberately ABSENT: they are not one of the four
  // outcomes this model can publish, and guessing would rank a non-finisher. An unknown
  // word is a blocking validation error (UNRECOGNISED_STATUS) — see resolveStatus.
}

function normalizeStatusToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * Resolves the status for a row.
 *
 * Blank or unmapped ⇒ `finished`. A row with no status and no usable time is therefore
 * `finished` and is caught by validation as "missing time", which is the honest outcome:
 * inventing a DNF for a row the organizer merely left incomplete would silently alter
 * their results.
 *
 * RD-RACEOPS-02E · an UNRECOGNISED non-empty status also resolves to `finished` here —
 * the model has no fifth value — but it is a BLOCKING validation error
 * (UNRECOGNISED_STATUS, severity error), so the row is never usable, imported or ranked
 * until the organizer writes one of the four statuses. Before this, "LAP", "OTL" or
 * "DNF (injury)" with a time were ranked as finishers behind a warning.
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

    // RD-RACEOPS-RESULTS-04 · the distance is parsed here so pace and speed have something
    // to divide by. An unreadable value becomes null and is reported by validation — it is
    // never guessed from a bare number (see validation/distance.ts).
    const distanceRaw = cellFor(row.cells, mapping, 'distance')
    const distance = parseRaceDistance(distanceRaw)

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
      distanceMeters: distance.ok ? distance.meters : null,
      distanceRaw:    orNull(distanceRaw),
      // Checkpoints arrive on their own sheet and are attached afterwards by
      // import/splits/splitSheet.ts `attachSplits`, which is the only place that can see
      // both sheets at once and therefore the only place that can detect an orphan bib.
      splits:         [],
      rawRow:         row.cells,
      sourceProvider: table.provider,
    }
  })
}
