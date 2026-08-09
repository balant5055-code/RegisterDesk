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
    description: 'Identifies the participant. Required.' },
  { field: 'participantName', label: 'Runner Name', required: false,
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
