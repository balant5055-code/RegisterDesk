// RD-RACEOPS-01 · Race Operations — THE canonical result model.
//
// SDK-FREE. No firebase-admin, no next/*, no React. Client + server + test safe.
//
// ─── The contract ────────────────────────────────────────────────────────────
// Every parser provider — CSV, Excel, and any future RaceTec / MyLaps / NovaRace
// provider — converges on `NormalizedRaceResult`. NOTHING downstream (validation,
// summary, report, preview, and later ranking and publish) may read a provider's
// raw shape. Adding a provider must therefore never require a change to validation.
//
// ─── Naming precision (Phase 0 §3.3 flagged "category" as ambiguous) ─────────
// RegisterDesk already uses "category" for three unrelated things:
//   1. `events/{slug}.pricing.passes[].raceDetails.category` — the pass builder's
//      race category (an eligibility/config value chosen before the event).
//   2. `registrations.bibCategory` — the identifier label captured at bib assignment.
//   3. `identifierConfigs.pools[].by: 'category'` — a pool partitioning strategy.
// `NormalizedRaceResult.category` is a FOURTH, distinct thing: the competition
// category **as stated in the uploaded timing file**. It is never read from, written
// to, or reconciled against any of the three above. Same for `gender` and `ageGroup`:
// they come from the FILE only, per the approved Phase 0 decision D4 — never inferred
// from `registrations.attendee.formResponses`, which is optional and unindexed.

// ─── RD-RACEOPS-RESULTS-04 · what a provider MAY send and what it may not decide ──
// Real timing exports (Provider A 21K, Provider B 10K in the 03 audit) carry three kinds
// of column:
//
//   FACTS      bib, name, gender, category, age group, distance, chip/net, gun, status,
//              and per-checkpoint elapsed / time-of-day values. These are imported.
//   DERIVED    pace and speed — pure functions of (elapsed, distance). Computed at read
//              time from the facts, never stored, so a stored number can never contradict
//              the time printed beside it.
//   THEIR RANK overall / gender / age-group position and totals. RegisterDesk computes its
//              own from the roster-verified set it actually publishes; a provider's rank
//              describes THEIR field, their DNF calls and their late corrections.
//
// A DERIVED or rank column is recognised by the mapper and reported as "calculated by
// RegisterDesk" rather than as an unknown column — see mapping/aliases.ts.

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * Outcome for one participant. Deliberately NOT reusing `RegistrationStatus`
 * (confirmed/cancelled/waitlisted/pending/rejected) — that is registration
 * lifecycle, a different domain with no overlapping member.
 */
export type RaceResultStatus =
  | 'finished'
  | 'dnf'        // did not finish
  | 'dns'        // did not start
  | 'dq'         // disqualified

/** Statuses for which a finish time is NOT expected. */
export const NON_FINISHING_STATUSES: readonly RaceResultStatus[] = ['dnf', 'dns', 'dq']

export const RACE_RESULT_STATUS_LABEL: Readonly<Record<RaceResultStatus, string>> = {
  finished: 'Finished',
  dnf:      'DNF',
  dns:      'DNS',
  dq:       'DQ',
}

// ─── The canonical model ──────────────────────────────────────────────────────

/**
 * One participant's result, provider-neutral.
 *
 * Every string field is already trimmed. An absent optional value is `null`, never
 * `undefined` and never `''` — so "not supplied" is unambiguous for validation and,
 * later, for a Firestore write.
 */
/**
 * RD-RACEOPS-RESULTS-04 · one checkpoint for one participant.
 *
 * A split carries BOTH readings a timing system gives, because they answer different
 * questions and neither is derivable from the other alone:
 *
 *   cumulative — "where was this runner at 10 km?"  (Provider A "Chip Time",
 *                Provider B "Overall Time")
 *   segment    — "how fast was the 5→10 km leg?"    (Provider B "Lap Time")
 *
 * `timeOfDay` is a WALL-CLOCK reading, kept as a normalised "HH:MM:SS" string. It is never
 * put through `parseRaceTime`: "06:28:51" is a perfectly valid 6-hour elapsed duration, and
 * treating a start-of-day stamp as an elapsed time is exactly the class of error 02E closed
 * for headings (see validation/time.ts `parseTimeOfDay`).
 *
 * Pace and speed are deliberately ABSENT. Both are computed from the times and distances
 * here — see utils/performance.ts.
 */
export interface NormalizedRaceSplit {
  /** 1-based position within this participant's splits, in file order. Drives display order. */
  sequence:         number
  /** Normalised identity of the checkpoint within the race: `splitKey()`. Unique per bib. */
  splitKey:         string
  /** The checkpoint as the provider named it — "3 KM", "T1", "Lap 2". */
  name:             string
  /** Cumulative course distance at this checkpoint, when the file says. */
  distanceMeters:   number | null
  /** Length of the segment ENDING here (Provider B "Lap Distance"), when the file says. */
  segmentMeters:    number | null
  /** Elapsed time from the start to this checkpoint. `0` is legal — the "Start" split. */
  cumulativeTimeMs: number | null
  /** Elapsed time for the segment ending here. Derived from cumulatives when absent. */
  segmentTimeMs:    number | null
  /** Wall clock, normalised "HH:MM:SS". Null when the provider supplied none. */
  timeOfDay:        string | null
}

export interface NormalizedRaceResult {
  /** 1-based row number IN THE UPLOADED FILE. Survives blank and malformed rows so
   *  the validation report can cite the row the organizer actually sees. */
  rowNumber:      number

  /**
   * The participant's name as printed in the TIMING FILE. Optional — many timing exports
   * carry only bibs. Added in Sprint 4 because the public leaderboard needs a Runner column
   * and name search. It is never inferred from `registrations`, which would require a
   * bib→registration match that does not exist.
   */
  participantName: string | null

  /** As printed on the bib. Kept as a STRING — bibs are identifiers, not numbers:
   *  leading zeros ("0042") and alphanumerics ("A101") are both real and must not be
   *  normalised away. Matches `registrations.bibNumber`, which is also a string. */
  bibNumber:      string | null

  /** Chip / net time, normalised to whole milliseconds. */
  chipTimeMs:     number | null
  /** Gun / gross time, normalised to whole milliseconds. */
  gunTimeMs:      number | null
  /** The chip time exactly as it appeared in the file — shown in the preview and the
   *  validation report so the organizer sees their own value, not our reformat. */
  chipTimeRaw:    string | null
  gunTimeRaw:     string | null

  status:         RaceResultStatus
  /** The raw status cell, when one was supplied. */
  statusRaw:      string | null

  /** From the FILE only (see the naming note above). */
  gender:         string | null
  category:       string | null
  ageGroup:       string | null

  /**
   * RD-RACEOPS-RESULTS-04 · the race distance as stated in the file, in METRES.
   *
   * Canonical because pace and speed are meaningless without it. Parsed only from an
   * explicit unit ("21.1 KM", "10 Km", "5000 m") — a bare number is refused rather than
   * guessed, and a LAP / SPLIT / CHECKPOINT distance heading never feeds this field (see
   * validation/distance.ts and mapping/autoMap.ts).
   *
   * Null on every result imported before this sprint, and on any file without the column.
   */
  distanceMeters: number | null
  /** The distance cell exactly as written, echoed in reports and shown to the organizer. */
  distanceRaw:    string | null

  /**
   * Checkpoints for this participant, in file order. Empty when the file had no splits —
   * which is the common case, and never an error.
   *
   * Splits arrive on their OWN sheet keyed by bib (see import/splits/splitSheet.ts) and are
   * attached to the result here, so the Results sheet keeps exactly one row per bib and the
   * one-bib-one-result invariant is untouched.
   */
  splits?:        readonly NormalizedRaceSplit[]

  /** The complete original row, header-keyed with ORIGINAL header casing. Retained so
   *  the validation report can echo the organizer's own values verbatim. */
  rawRow:         Readonly<Record<string, string>>

  /** Which provider produced this record, e.g. 'csv' | 'excel'. */
  sourceProvider: string
}

// ─── Canonical fields available for column mapping ────────────────────────────

/**
 * The mappable target fields. `bibNumber` and `chipTime` are the only ones the
 * validation engine requires; the rest are optional enrichment.
 */
export type ResultField =
  | 'bibNumber'
  | 'participantName'
  | 'chipTime'
  | 'gunTime'
  | 'status'
  | 'gender'
  | 'category'
  | 'ageGroup'
  // RD-RACEOPS-RESULTS-04 · the race distance. Optional, but without it there is no pace
  // and no speed — so the template asks for it and the mapper recognises it exactly.
  | 'distance'

export interface ResultFieldDef {
  field:       ResultField
  label:       string
  required:    boolean
  description: string
}

/** Single source of truth for the mappable fields — the mapping UI, the auto-mapper
 *  and validation all read this. No field list is hardcoded anywhere else. */
export const RESULT_FIELDS: readonly ResultFieldDef[] = [
  { field: 'bibNumber', label: 'Bib Number', required: true,
    description: 'Identifies the participant. Required — must be on the start list for the selected race.' },
  { field: 'participantName', label: 'Participant Name', required: false,
    description: 'Shown on the public leaderboard. Optional — results work without it.' },
  { field: 'chipTime',  label: 'Chip Time',  required: true,
    description: 'Net / chip time. Required for finishers.' },
  { field: 'gunTime',   label: 'Gun Time',   required: false,
    description: 'Gross / gun time, if your timing file has one.' },
  { field: 'status',    label: 'Status',     required: false,
    description: 'Finished, DNF, DNS or DQ. Assumed Finished when a time is present.' },
  { field: 'gender',    label: 'Gender',     required: false,
    description: 'As recorded in the timing file.' },
  { field: 'category',  label: 'Category',   required: false,
    description: 'Competition category as recorded in the timing file.' },
  { field: 'ageGroup',  label: 'Age Group',  required: false,
    description: 'Age band as recorded in the timing file.' },
  { field: 'distance',  label: 'Distance',   required: false,
    description: 'Race distance with its unit — 21.1 KM, 10 Km, 5000 m. RegisterDesk calculates pace and speed from it.' },
] as const

export const REQUIRED_RESULT_FIELDS: readonly ResultField[] =
  RESULT_FIELDS.filter(f => f.required).map(f => f.field)

export const RESULT_FIELD_LABEL: Readonly<Record<ResultField, string>> =
  Object.fromEntries(RESULT_FIELDS.map(f => [f.field, f.label])) as Record<ResultField, string>

// ─── Column mapping ───────────────────────────────────────────────────────────

/**
 * Which uploaded header feeds each canonical field. A field absent from the record
 * is unmapped. Held in memory for the session only — Sprint 2 persists nothing.
 */
export type ColumnMapping = Partial<Record<ResultField, string>>

// ─── RD-RACEOPS-RESULTS-04 · the splits sheet ─────────────────────────────────

/**
 * The mappable columns of the OPTIONAL splits sheet. Deliberately a separate vocabulary
 * from `ResultField`: a splits row is not a result, and letting the two share a field type
 * would let a splits column be offered as a result column in the mapping UI.
 */
export type SplitField =
  | 'bibNumber'
  | 'split'
  | 'distance'
  | 'timeOfDay'
  | 'elapsedTime'
  | 'splitTime'

export interface SplitFieldDef {
  field:       SplitField
  label:       string
  required:    boolean
  description: string
}

/** Single source of truth for the splits sheet — template, mapper and validator read it. */
export const SPLIT_FIELDS: readonly SplitFieldDef[] = [
  { field: 'bibNumber',   label: 'Bib Number',   required: true,
    description: 'The bib this checkpoint belongs to. It must also appear on the Results sheet.' },
  { field: 'split',       label: 'Split',        required: true,
    description: 'The checkpoint as your timing system names it — 5KM, Lap 2, T1.' },
  { field: 'distance',    label: 'Distance',     required: false,
    description: 'Cumulative course distance at this checkpoint, with its unit.' },
  { field: 'timeOfDay',   label: 'Time of Day',  required: false,
    description: 'Clock time the participant crossed the mat. A time of day, not an elapsed time.' },
  { field: 'elapsedTime', label: 'Elapsed Time', required: false,
    description: 'Time from the start to this checkpoint. 0:00 is valid for the Start split.' },
  { field: 'splitTime',   label: 'Split Time',   required: false,
    description: 'Time for this segment only. Calculated from the elapsed times when left blank.' },
] as const

export const REQUIRED_SPLIT_FIELDS: readonly SplitField[] =
  SPLIT_FIELDS.filter(f => f.required).map(f => f.field)

export const SPLIT_FIELD_LABEL: Readonly<Record<SplitField, string>> =
  Object.fromEntries(SPLIT_FIELDS.map(f => [f.field, f.label])) as Record<SplitField, string>

export type SplitColumnMapping = Partial<Record<SplitField, string>>

/** A result may not carry more checkpoints than this. Bounds the stored document. */
export const MAX_SPLITS_PER_RESULT = 60

// ─── Parsed table (what a provider returns) ────────────────────────────────────

export interface ParsedRow {
  /** 1-based row number in the source file, counting the header row as row 1. */
  rowNumber: number
  /** Header-keyed cells, ORIGINAL header casing preserved, values trimmed. */
  cells:     Readonly<Record<string, string>>
}

export interface ParsedTable {
  /** Headers in file order, original casing. Empty trailing headers are dropped. */
  headers:  readonly string[]
  rows:     readonly ParsedRow[]
  /** Provider that produced this table. */
  provider: string
  /** Sheet name for spreadsheet providers; null for CSV. */
  sheetName: string | null
}
