// RD-RACEOPS-RESULTS-04 · The optional Splits sheet — PURE.
//
// No SDK, no I/O. Turns the second sheet of a results workbook into checkpoints attached to
// the results that already exist, and reports every way that can go wrong.
//
// ─── Why a separate SHEET and not more columns ───────────────────────────────
// Provider A publishes 7 checkpoints, Provider B publishes 2, and a triathlon publishes
// swim / T1 / bike / T2 / run. A wide template would need `Split 1 Time … Split 30 Speed`
// and would still be wrong for the next provider. A second sheet is variable-length by
// construction, and — crucially — it keeps the RESULTS sheet at exactly ONE ROW PER BIB, so
// `DUPLICATE_BIB` stays a blocking error and the one-bib-one-result invariant that the
// whole publish pipeline rests on is untouched.
//
// ─── Identity ────────────────────────────────────────────────────────────────
// A checkpoint is identified by (result bib, `splitKey`). `splitKey` is the provider's own
// name normalised, so "5 KM" / "5km" / "5KM" are ONE checkpoint and a re-upload overwrites
// rather than appends. The same pair twice in one file is a blocking error — silently
// keeping the last row would publish a leg nobody ran.
//
// ─── What is NOT read here ───────────────────────────────────────────────────
// Pace, speed, lap pace and lap speed columns are recognised and ignored: they are derived
// from the times and distances in this sheet (utils/performance.ts). Importing them would
// let a stored number contradict the time printed beside it.

import type {
  NormalizedRaceResult, NormalizedRaceSplit, ParsedTable, SplitColumnMapping, SplitField,
} from '@/features/race-operations/types/results'
import { MAX_SPLITS_PER_RESULT, SPLIT_FIELDS } from '@/features/race-operations/types/results'
import { parseSplitElapsed, parseTimeOfDay } from '../validation/time'
import { parseRaceDistance } from '../validation/distance'
import { normalizeHeader } from '../mapping/aliases'
import { bibKey } from '@/features/race-operations/utils/publicKeys'

// ─── Header aliases for the splits sheet ──────────────────────────────────────
//
// EXACT matching only — a splits sheet is already an advanced path, and a wrong guess here
// silently reshapes someone's race. Anything unrecognised is reported, never assumed.
const SPLIT_ALIASES: Readonly<Record<SplitField, readonly string[]>> = {
  bibNumber:   ['bib', 'bibno', 'bibnumber', 'bibnum', 'racenumber', 'raceno', 'startnumber', 'startno'],
  split:       ['split', 'splitname', 'checkpoint', 'checkpointname', 'point', 'lap', 'lapname',
                'segment', 'segmentname', 'leg', 'legname', 'stage', 'marker', 'location'],
  distance:    ['distance', 'splitdistance', 'checkpointdistance', 'cumulativedistance',
                'overalldistance', 'totaldistance', 'distanceatsplit'],
  timeOfDay:   ['timeofday', 'timeoftheday', 'clocktime', 'crossingtime', 'tod', 'timeofdayhhmmss'],
  elapsedTime: ['elapsedtime', 'elapsed', 'cumulativetime', 'overalltime', 'chiptime', 'nettime',
                'splitelapsed', 'totaltime', 'timeatsplit', 'cumulative'],
  splitTime:   ['splittime', 'laptime', 'segmenttime', 'legtime', 'sectiontime', 'lapelapsed'],
}

/** Columns a provider prints that RegisterDesk calculates. Recognised so they can be named. */
export const SPLIT_DERIVED_HEADERS: ReadonlySet<string> = new Set([
  'pace', 'overallpace', 'lappace', 'splitpace', 'segmentpace', 'avgpace', 'averagepace',
  'speed', 'overallspeed', 'lapspeed', 'splitspeed', 'segmentspeed', 'avgspeed', 'averagespeed',
  'lapdistance', 'segmentdistance', 'legdistance',   // read from the dedicated column below
].map(normalizeHeader))

/**
 * `Lap Distance` is a FACT, not a derived value — but it is the SEGMENT length, never the
 * cumulative one, so it has its own aliases and never feeds `distance`.
 */
const SEGMENT_DISTANCE_ALIASES: ReadonlySet<string> =
  new Set(['lapdistance', 'segmentdistance', 'legdistance', 'sectiondistance'].map(normalizeHeader))

const SPLIT_ALIAS_TO_FIELD: ReadonlyMap<string, SplitField> = (() => {
  const map = new Map<string, SplitField>()
  for (const [field, aliases] of Object.entries(SPLIT_ALIASES) as [SplitField, readonly string[]][]) {
    for (const alias of aliases) { const k = normalizeHeader(alias); if (!map.has(k)) map.set(k, field) }
  }
  return map
})()

export interface SplitAutoMapResult {
  mapping:         SplitColumnMapping
  /** The header feeding segment length, when the sheet has one. Not part of the mapping. */
  segmentDistanceHeader: string | null
  /** Headers RegisterDesk calculates and deliberately ignored. */
  derivedHeaders:  string[]
  /** Headers it could not place at all. */
  unknownHeaders:  string[]
  missingRequired: SplitField[]
}

/** Maps a splits sheet's headers. Exact aliases only; first header wins a field. */
export function autoMapSplitColumns(headers: readonly string[]): SplitAutoMapResult {
  const mapping: SplitColumnMapping = {}
  const derivedHeaders: string[] = []
  const unknownHeaders: string[] = []
  let segmentDistanceHeader: string | null = null

  for (const header of headers) {
    const norm = normalizeHeader(header)
    if (norm === '') continue
    if (SEGMENT_DISTANCE_ALIASES.has(norm)) {
      segmentDistanceHeader ??= header
      continue
    }
    if (SPLIT_DERIVED_HEADERS.has(norm)) { derivedHeaders.push(header); continue }
    const field = SPLIT_ALIAS_TO_FIELD.get(norm)
    if (field === undefined) { unknownHeaders.push(header); continue }
    if (mapping[field] === undefined) mapping[field] = header
  }

  const missingRequired = SPLIT_FIELDS.filter(f => f.required && mapping[f.field] === undefined).map(f => f.field)
  return { mapping, segmentDistanceHeader, derivedHeaders, unknownHeaders, missingRequired }
}

// ─── Parsing the sheet ────────────────────────────────────────────────────────

/** Normalised checkpoint identity. Same rules as `bibKey`: upper-case, alphanumeric only. */
export function splitKey(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24)
}

/** One problem found while reading the splits sheet. Row numbers cite the SPLITS sheet. */
export interface SplitIssue {
  code:
    | 'SPLIT_MISSING_BIB'
    | 'SPLIT_MISSING_NAME'
    | 'SPLIT_NO_TIME'
    | 'SPLIT_INVALID_TIME'
    | 'SPLIT_INVALID_TIME_OF_DAY'
    | 'SPLIT_INVALID_DISTANCE'
    | 'DUPLICATE_SPLIT'
    | 'ORPHAN_SPLIT_BIB'
    | 'TOO_MANY_SPLITS'
    | 'SPLIT_TIME_DECREASING'
    | 'SPLIT_FINISH_MISMATCH'
  severity: 'error' | 'warning'
  rowNumber: number | null
  bibNumber: string | null
  message:   string
}

export interface ParsedSplitSheet {
  /** bibKey → that participant's checkpoints, in sheet order. */
  byBib:  Map<string, NormalizedRaceSplit[]>
  issues: SplitIssue[]
  /** How many data rows carried a usable checkpoint. */
  rows:   number
}

const cell = (cells: Readonly<Record<string, string>>, header: string | undefined): string =>
  header ? (cells[header] ?? '').trim() : ''

/**
 * Reads the splits sheet into per-bib checkpoints.
 *
 * Every failure is reported against the row the organizer can see; nothing is silently
 * dropped, and nothing is invented — a checkpoint with neither an elapsed time nor a split
 * time is an error, because a checkpoint with no time says nothing at all.
 */
export function parseSplitSheet(table: ParsedTable, auto?: SplitAutoMapResult): ParsedSplitSheet {
  const map = auto ?? autoMapSplitColumns(table.headers)
  const byBib = new Map<string, NormalizedRaceSplit[]>()
  const issues: SplitIssue[] = []
  /** bibKey → splitKey → the row that first claimed it, for duplicate detection. */
  const claimed = new Map<string, Map<string, number>>()
  let rows = 0

  for (const missing of map.missingRequired) {
    issues.push({
      code: missing === 'bibNumber' ? 'SPLIT_MISSING_BIB' : 'SPLIT_MISSING_NAME',
      severity: 'error', rowNumber: null, bibNumber: null,
      message: missing === 'bibNumber'
        ? 'The Splits sheet has no Bib Number column, so its rows cannot be matched to a result.'
        : 'The Splits sheet has no Split column, so its checkpoints cannot be told apart.',
    })
  }
  if (map.missingRequired.length > 0) return { byBib, issues, rows }

  for (const row of table.rows) {
    const bib  = cell(row.cells, map.mapping.bibNumber)
    const name = cell(row.cells, map.mapping.split)
    // A wholly blank row is padding from the spreadsheet, not an error.
    if (bib === '' && name === '') continue

    if (bib === '') {
      issues.push({ code: 'SPLIT_MISSING_BIB', severity: 'error', rowNumber: row.rowNumber, bibNumber: null,
        message: 'This split row has no bib number.' })
      continue
    }
    if (name === '') {
      issues.push({ code: 'SPLIT_MISSING_NAME', severity: 'error', rowNumber: row.rowNumber, bibNumber: bib,
        message: 'This split row has no checkpoint name.' })
      continue
    }

    const key = splitKey(name)
    if (key === '') {
      issues.push({ code: 'SPLIT_MISSING_NAME', severity: 'error', rowNumber: row.rowNumber, bibNumber: bib,
        message: `Checkpoint "${name}" has no letters or digits, so it cannot be identified.` })
      continue
    }

    const bk = bibKey(bib)
    const seen = claimed.get(bk) ?? new Map<string, number>()
    const firstRow = seen.get(key)
    if (firstRow !== undefined) {
      issues.push({ code: 'DUPLICATE_SPLIT', severity: 'error', rowNumber: row.rowNumber, bibNumber: bib,
        message: `Bib ${bib} has checkpoint "${name}" twice (rows ${firstRow} and ${row.rowNumber}). Each checkpoint may appear once per bib.` })
      continue
    }

    // ── times ──
    const elapsedRaw = cell(row.cells, map.mapping.elapsedTime)
    const segmentRaw = cell(row.cells, map.mapping.splitTime)
    const elapsed = elapsedRaw === '' ? null : parseSplitElapsed(elapsedRaw)
    const segment = segmentRaw === '' ? null : parseSplitElapsed(segmentRaw)

    if (elapsed !== null && !elapsed.ok) {
      issues.push({ code: 'SPLIT_INVALID_TIME', severity: 'error', rowNumber: row.rowNumber, bibNumber: bib,
        message: `Elapsed time "${elapsedRaw}" could not be read. Use hh:mm:ss — 0:00 is allowed for the start.` })
      continue
    }
    if (segment !== null && !segment.ok) {
      issues.push({ code: 'SPLIT_INVALID_TIME', severity: 'error', rowNumber: row.rowNumber, bibNumber: bib,
        message: `Split time "${segmentRaw}" could not be read. Use hh:mm:ss.` })
      continue
    }
    if (elapsed === null && segment === null) {
      issues.push({ code: 'SPLIT_NO_TIME', severity: 'error', rowNumber: row.rowNumber, bibNumber: bib,
        message: `Checkpoint "${name}" has neither an elapsed time nor a split time.` })
      continue
    }

    // ── time of day: parsed by its OWN parser, never as a duration ──
    const todRaw = cell(row.cells, map.mapping.timeOfDay)
    let timeOfDay: string | null = null
    if (todRaw !== '') {
      const tod = parseTimeOfDay(todRaw)
      if (tod.ok) timeOfDay = tod.value
      else {
        issues.push({ code: 'SPLIT_INVALID_TIME_OF_DAY', severity: 'warning', rowNumber: row.rowNumber, bibNumber: bib,
          message: `Time of day "${todRaw}" is not a clock time (00:00:00–23:59:59) and was left out of this checkpoint.` })
      }
    }

    // ── distances ──
    const distRaw = cell(row.cells, map.mapping.distance)
    let distanceMeters: number | null = null
    if (distRaw !== '') {
      const d = parseRaceDistance(distRaw)
      if (d.ok) distanceMeters = d.meters
      else {
        issues.push({ code: 'SPLIT_INVALID_DISTANCE', severity: 'warning', rowNumber: row.rowNumber, bibNumber: bib,
          message: `Distance "${distRaw}" needs a unit (for example 5 KM or 5000 m). This checkpoint was stored without a distance, so its pace and speed cannot be shown.` })
      }
    }
    const segRaw = cell(row.cells, map.segmentDistanceHeader ?? undefined)
    let segmentMeters: number | null = null
    if (segRaw !== '') {
      const d = parseRaceDistance(segRaw)
      if (d.ok) segmentMeters = d.meters
    }

    const list = byBib.get(bk) ?? []
    if (list.length >= MAX_SPLITS_PER_RESULT) {
      issues.push({ code: 'TOO_MANY_SPLITS', severity: 'error', rowNumber: row.rowNumber, bibNumber: bib,
        message: `Bib ${bib} has more than ${MAX_SPLITS_PER_RESULT} checkpoints. Split the race into fewer points.` })
      continue
    }

    list.push({
      sequence:         list.length + 1,
      splitKey:         key,
      name,
      distanceMeters,
      segmentMeters,
      cumulativeTimeMs: elapsed !== null && elapsed.ok ? elapsed.ms : null,
      segmentTimeMs:    segment !== null && segment.ok ? segment.ms : null,
      timeOfDay,
    })
    byBib.set(bk, list)
    seen.set(key, row.rowNumber)
    claimed.set(bk, seen)
    rows++
  }

  return { byBib, issues, rows }
}

// ─── Attaching to results ─────────────────────────────────────────────────────

export interface AttachSplitsOutcome {
  results: NormalizedRaceResult[]
  issues:  SplitIssue[]
  /** How many results ended up with at least one checkpoint. */
  withSplits: number
}

/**
 * Attaches parsed checkpoints to their results and completes the derivable facts.
 *
 * Integrity, in one place because each rule needs the other's data:
 *   ORPHAN_SPLIT_BIB       a splits bib with no row on the Results sheet — a BLOCKING error.
 *                          Publishing it would mean checkpoints for a runner with no result.
 *   SPLIT_TIME_DECREASING  cumulative time must not go backwards along the course.
 *   SPLIT_FINISH_MISMATCH  the last cumulative time disagrees with the chip time — a WARNING,
 *                          because mat placement legitimately differs by a second or two, and
 *                          NEITHER value is overwritten.
 *
 * Segment times are filled in from consecutive cumulatives (and segment distances from
 * consecutive distances) only where the arithmetic is actually supported — never guessed.
 */
export function attachSplits(
  results: readonly NormalizedRaceResult[],
  parsed:  ParsedSplitSheet,
): AttachSplitsOutcome {
  const issues: SplitIssue[] = []
  const byBib = new Map(parsed.byBib)
  const out: NormalizedRaceResult[] = []
  let withSplits = 0

  for (const r of results) {
    const bk = r.bibNumber ? bibKey(r.bibNumber) : ''
    const raw = bk === '' ? undefined : byBib.get(bk)
    if (raw === undefined) { out.push({ ...r, splits: [] }); continue }
    byBib.delete(bk)

    // ── Course order ──
    //
    // DISTANCE first, when every checkpoint has one: distance is the axis of the course, and
    // it is the only axis that can disagree with the times — which is exactly the disagreement
    // `SPLIT_TIME_DECREASING` exists to report. Sorting by time instead would quietly reorder a
    // 10 km mat that reads earlier than the 5 km one and publish it as correct.
    //
    // With no distances, cumulative time is the best available order (a provider may list
    // checkpoints in any order, and a participant must read them in the order they ran).
    // With neither, the file's own order stands.
    const everyDistance = raw.every(s => s.distanceMeters !== null)
    const everyTime = raw.every(s => s.cumulativeTimeMs !== null)
    const ordered = [...raw].sort((a, b) => {
      if (everyDistance) return (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0) || a.sequence - b.sequence
      if (everyTime)     return (a.cumulativeTimeMs ?? 0) - (b.cumulativeTimeMs ?? 0) || a.sequence - b.sequence
      return a.sequence - b.sequence
    })

    const splits: NormalizedRaceSplit[] = []
    let previous: NormalizedRaceSplit | null = null
    let decreasing = false

    for (const [i, s] of ordered.entries()) {
      if (
        previous && s.cumulativeTimeMs !== null && previous.cumulativeTimeMs !== null
        && s.cumulativeTimeMs < previous.cumulativeTimeMs
      ) decreasing = true

      const segmentTimeMs = s.segmentTimeMs ?? (
        s.cumulativeTimeMs !== null && previous?.cumulativeTimeMs != null
          ? s.cumulativeTimeMs - previous.cumulativeTimeMs
          : s.cumulativeTimeMs !== null && previous === null
            ? s.cumulativeTimeMs            // first checkpoint: the segment IS the elapsed time
            : null
      )
      const segmentMeters = s.segmentMeters ?? (
        s.distanceMeters !== null && previous?.distanceMeters != null
          ? s.distanceMeters - previous.distanceMeters
          : s.distanceMeters !== null && previous === null
            ? s.distanceMeters
            : null
      )

      const resolved: NormalizedRaceSplit = {
        ...s,
        sequence: i + 1,
        segmentTimeMs: segmentTimeMs !== null && segmentTimeMs >= 0 ? segmentTimeMs : null,
        segmentMeters: segmentMeters !== null && segmentMeters > 0 ? segmentMeters : null,
      }
      splits.push(resolved)
      previous = resolved
    }

    if (decreasing) {
      issues.push({ code: 'SPLIT_TIME_DECREASING', severity: 'error', rowNumber: r.rowNumber, bibNumber: r.bibNumber,
        message: `Bib ${r.bibNumber}: the elapsed times along the course go backwards. Check the checkpoint times.` })
    }

    const last = splits.length > 0 ? splits[splits.length - 1] : null
    if (
      last?.cumulativeTimeMs != null && r.chipTimeMs !== null && r.status === 'finished'
      && Math.abs(last.cumulativeTimeMs - r.chipTimeMs) > FINISH_TOLERANCE_MS
    ) {
      issues.push({ code: 'SPLIT_FINISH_MISMATCH', severity: 'warning', rowNumber: r.rowNumber, bibNumber: r.bibNumber,
        message: `Bib ${r.bibNumber}: the last checkpoint ("${last.name}") and the Chip Time differ by more than ${Math.round(FINISH_TOLERANCE_MS / 1000)} seconds. Both values were kept exactly as supplied — check which one is the finish.` })
    }

    if (splits.length > 0) withSplits++
    out.push({ ...r, splits })
  }

  // Anything still in the map had no result row at all.
  for (const [bk, list] of byBib) {
    issues.push({ code: 'ORPHAN_SPLIT_BIB', severity: 'error', rowNumber: null, bibNumber: list[0]?.name ? bk : bk,
      message: `The Splits sheet has ${list.length} checkpoint${list.length === 1 ? '' : 's'} for bib ${bk}, which has no row on the Results sheet. Add the result or remove the checkpoints.` })
  }

  return { results: out, issues, withSplits }
}

/** How far the last checkpoint may sit from the chip time before it is worth mentioning. */
export const FINISH_TOLERANCE_MS = 5_000

// ─── The server's own gate ────────────────────────────────────────────────────

/**
 * RD-RACEOPS-RESULTS-04 · the checkpoints a row is ALLOWED to store.
 *
 * The browser's pure pipeline already refuses a duplicate checkpoint, a timeless one and an
 * over-long list — but the browser is a convenience, never the authority, exactly as it is
 * for bib uniqueness (02C). Every server path runs a row's checkpoints through this before
 * they are written, so a hand-made request cannot publish a leg nobody ran:
 *
 *   • the same `splitKey` twice → the first wins, the rest are dropped
 *   • no time of any kind       → dropped (a checkpoint with no time says nothing)
 *   • a negative time or distance → dropped
 *   • more than `MAX_SPLITS_PER_RESULT` → the tail is dropped
 *   • `sequence` is re-derived, so it always describes the stored order
 *
 * Dropping rather than refusing the whole chunk is deliberate: this is the defensive layer
 * behind a validation layer that already reported the problem to the organizer, and refusing
 * here would turn a browser bug into an un-publishable race.
 */
export function sanitizeSplits(splits: readonly NormalizedRaceSplit[] | null | undefined): NormalizedRaceSplit[] {
  if (!Array.isArray(splits) || splits.length === 0) return []
  const out: NormalizedRaceSplit[] = []
  const seen = new Set<string>()

  for (const s of splits) {
    if (out.length >= MAX_SPLITS_PER_RESULT) break
    if (!s || typeof s !== 'object') continue

    const name = typeof s.name === 'string' ? s.name.trim() : ''
    const key = s.splitKey && /^[A-Z0-9]+$/.test(s.splitKey) ? s.splitKey : splitKey(name)
    if (name === '' || key === '' || seen.has(key)) continue

    const ms = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null
    const metres = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null

    const cumulativeTimeMs = ms(s.cumulativeTimeMs)
    const segmentTimeMs    = ms(s.segmentTimeMs)
    if (cumulativeTimeMs === null && segmentTimeMs === null) continue

    seen.add(key)
    out.push({
      sequence: out.length + 1,
      splitKey: key,
      name,
      distanceMeters:  metres(s.distanceMeters),
      segmentMeters:   metres(s.segmentMeters),
      cumulativeTimeMs,
      segmentTimeMs,
      timeOfDay: typeof s.timeOfDay === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(s.timeOfDay) ? s.timeOfDay : null,
    })
  }

  return out
}
