// RD-RACEOPS-02C · The results template and start list — PURE builders.
//
// No SDK, no I/O. Everything an organizer downloads to prepare a results file is
// derived HERE from the canonical result model (`RESULT_FIELDS`), so the template can
// never drift from what the parser, the mapper and the validator accept:
//
//   • the column headers ARE the fields' own labels, and every one is an EXACT alias in
//     the mapping table — a template filled in and uploaded maps with no review needed
//     (pinned by tests/unit/raceOpsTemplates.test.ts)
//   • the "How to fill" sheet quotes the parser's accepted time forms and status words
//     from the same modules that enforce them
//   • rank / position is NOT a column: RegisterDesk ranks on chip time server-side, and a
//     column nobody reads would only invite the organizer to fill it in
//
// The workbook shape is the repository's existing `ReportTable` so the dependency-free
// writer in lib/reports/xlsx produces it; CSV uses the shared csv helpers.

import {
  RESULT_FIELDS, RACE_RESULT_STATUS_LABEL, SPLIT_FIELDS,
  type NormalizedRaceResult, type ResultField, type SplitField,
} from '@/features/race-operations/types/results'
import { formatMaxFileSize, RESULTS_ACCEPTED_EXTENSIONS, RESULTS_MAX_ROWS } from '@/features/race-operations/import/constants'
import { csvRow } from '@/lib/utils/csv'
import type { ReportRow, ReportTable } from '@/lib/reports/types'

/** Sheet names. The parser prefers a sheet called "Results" (see excelParser). */
export const RESULTS_SHEET     = 'Results'
/**
 * RD-RACEOPS-RESULTS-04 · the OPTIONAL checkpoint sheet, read by name.
 *
 * A second sheet rather than more columns: providers publish anywhere from two checkpoints
 * to thirty, so a wide template would need `Split 1 Time … Split 30 Speed` and still be
 * wrong for the next one. And it keeps the Results sheet at exactly one row per bib, which
 * is what makes DUPLICATE_BIB a blocking error and one-bib-one-result an invariant.
 */
export const SPLITS_SHEET      = 'Splits'
export const HOW_TO_FILL_SHEET = 'How to fill'

/** One template column: the canonical field and the header the organizer sees. */
export interface TemplateColumn {
  field:    ResultField
  header:   string
  required: boolean
  /** One line, organizer language. */
  fill:     string
}

/** The columns, in file order — identity first, times, status, then the optional facts. */
export const TEMPLATE_COLUMNS: readonly TemplateColumn[] = (() => {
  const fill: Record<ResultField, string> = {
    bibNumber:       'The bib exactly as printed and as it appears on the start list. Do not change or reformat it.',
    participantName: 'Optional. Shown on the public results page. Leave blank to omit.',
    distance:        'Optional but recommended: 21.1 KM, 10 Km or 5000 m. Always include the unit — RegisterDesk calculates pace and speed from this and will not guess between kilometres and metres.',
    chipTime:        'The elapsed time from the timing system. hh:mm:ss (e.g. 01:48:32), h:mm:ss.fff, or mm:ss for results under an hour. Leave blank only for DNF / DNS / DQ.',
    gunTime:         'Optional. Start-to-finish clock time, if your timing system supplies one. Same format as Chip Time.',
    status:          'Optional. Finished (default when a time is present), DNF, DNS or DQ.',
    // RD-RACEOPS-RESULTS-04 · these three now reach the published result and are RANKED
    // within their own group, so the old "stored, not ranked" line would be untrue.
    gender:          'Optional. As recorded by you or the timing system. RegisterDesk works out each finisher\'s position within their gender from it.',
    category:        'Optional. Competition category as recorded. Shown on the result, not ranked.',
    ageGroup:        'Optional. Age band as recorded. RegisterDesk works out each finisher\'s position within their age group from it.',
  }
  const order: ResultField[] = ['bibNumber', 'participantName', 'distance', 'chipTime', 'gunTime', 'status', 'gender', 'category', 'ageGroup']
  return order.map(field => {
    const def = RESULT_FIELDS.find(f => f.field === field)
    if (!def) throw new Error(`RESULT_FIELDS has no ${field}`)
    return { field, header: def.label, required: def.required, fill: fill[field] }
  })
})()

export const TEMPLATE_HEADERS: readonly string[] = TEMPLATE_COLUMNS.map(c => c.header)

// ─── RD-RACEOPS-RESULTS-04 · the optional Splits sheet ────────────────────────

export interface SplitTemplateColumn {
  field:    SplitField
  header:   string
  required: boolean
  fill:     string
}

/** Derived from `SPLIT_FIELDS`, exactly as the result columns are derived from RESULT_FIELDS. */
export const SPLIT_TEMPLATE_COLUMNS: readonly SplitTemplateColumn[] = (() => {
  const fill: Record<SplitField, string> = {
    bibNumber:   'The same bib as on the Results sheet. A bib that is not on the Results sheet stops the import.',
    split:       'The checkpoint name from your timing system — 5KM, 10KM, Lap 2, T1. The same name may appear only once per bib.',
    distance:    'Optional. Distance into the race at this checkpoint, with its unit: 5 KM, 10 KM, 1500 m.',
    timeOfDay:   'Optional. The clock time the participant crossed — 06:28:51. A time of day, NOT an elapsed time.',
    elapsedTime: 'Time from the start to this checkpoint — 00:16:05. 0:00 is correct for a Start line split.',
    splitTime:   'Optional. Time for this leg only — 00:16:30. Leave blank and RegisterDesk works it out from the elapsed times.',
  }
  const order: SplitField[] = ['bibNumber', 'split', 'distance', 'timeOfDay', 'elapsedTime', 'splitTime']
  return order.map(field => {
    const def = SPLIT_FIELDS.find(f => f.field === field)
    if (!def) throw new Error(`SPLIT_FIELDS has no ${field}`)
    return { field, header: def.label, required: def.required, fill: fill[field] }
  })
})()

export const SPLIT_TEMPLATE_HEADERS: readonly string[] = SPLIT_TEMPLATE_COLUMNS.map(c => c.header)

/**
 * The Splits sheet: headers and NOTHING ELSE.
 *
 * Deliberately empty. An example row here would carry a bib that is not on this race's start
 * list, so a workbook downloaded and uploaded unedited would fail with ORPHAN_SPLIT_BIB —
 * the template would create the error it exists to prevent. The worked example lives in the
 * "How to fill" sheet instead, where it can be read without being submitted.
 *
 * A header-only sheet is also how the parser recognises "no checkpoints": `selectSplitsSheet`
 * requires a data row, so an untouched sheet is simply absent rather than empty.
 */
export function splitsSheet(): ReportTable {
  return {
    id:      SPLITS_SHEET,
    title:   SPLITS_SHEET,
    columns: SPLIT_TEMPLATE_COLUMNS.map(c => ({ key: c.field, label: c.header, type: 'text' as const })),
    rows:    [],
  }
}

/** What the organizer must know before filling a row. Quoted from the parser's own vocabulary. */
export function howToFillRows(ctx: { eventName: string; raceName: string; participantCount?: number }): ReportRow[] {
  const statuses = (Object.keys(RACE_RESULT_STATUS_LABEL) as NormalizedRaceResult['status'][])
    .map(s => RACE_RESULT_STATUS_LABEL[s]).join(', ')
  const required = TEMPLATE_COLUMNS.filter(c => c.required).map(c => c.header).join(' and ')
  return [
    { topic: 'Event',              details: ctx.eventName },
    { topic: 'Race',               details: `${ctx.raceName}. One workbook = this one race. Upload it under the same race in Publish Results.` },
    ...(ctx.participantCount !== undefined
      ? [{ topic: 'Start list', details: `${ctx.participantCount.toLocaleString('en-IN')} participants with a bib were on the start list when this file was generated. Bibs assigned later can be added as new rows.` }]
      : []),
    { topic: 'One row per bib',    details: 'Each row is one participant\'s result. A bib may appear once — duplicate bibs are rejected on upload.' },
    { topic: 'Required columns',   details: `${required}. Every other column is optional.` },
    { topic: 'Do not change bibs', details: 'Keep the Bib Number column exactly as printed on the bib. Bibs that are not on this race\'s start list stop the import until they are fixed.' },
    { topic: 'Time format',        details: 'hh:mm:ss — for example 01:48:32. Fractions are accepted (01:48:32.470, comma decimals too). Results under an hour may be written mm:ss (48:32). Anything over 10 days is rejected.' },
    { topic: 'Chip / Net Time',    details: 'The participant\'s elapsed result from the timing system. This is the time RegisterDesk ranks by and shows on results and certificates.' },
    { topic: 'Distance',           details: 'Write the race distance with its unit — 21.1 KM, 10 Km, 5000 m. RegisterDesk calculates pace and speed from it; without a unit the value is refused rather than guessed, and without the column there is no pace or speed to show.' },
    { topic: 'Gun / Gross Time',   details: 'Start-to-finish clock time, when your timing system supplies one. Shown alongside the chip time; never used for ranking.' },
    { topic: 'Status values',      details: `${statuses}. Leave blank or write Finished for a finisher. DNF = did not finish, DNS = did not start, DQ = disqualified.` },
    { topic: 'DNF / DNS / DQ',     details: 'Leave Chip Time blank for these rows. They are published with their status and are not ranked. Any other status word stops the row from importing until it is corrected — it is never guessed.' },
    { topic: 'What RegisterDesk calculates', details: 'Overall position, position within gender, position within age group, the totals beside them, pace and speed. None of these are columns here. If your timing export has them they are recognised and left out — a provider\'s ranks describe their field, and RegisterDesk publishes positions for the start list it verified.' },
    { topic: 'Bibs must already exist', details: 'Every bib must be on this race\'s start list. Results do not create participants: an unknown bib stops the import until you fix the file or register the participant.' },
    { topic: 'Splits (optional)',  details: `Use the "${SPLITS_SHEET}" sheet for checkpoints: one row per checkpoint per bib, with the bib repeated. Leave the whole sheet empty if you have none — results publish perfectly well without it. Every bib there must also be on the "${RESULTS_SHEET}" sheet.` },
    // A worked example, here rather than in the sheet itself: a sample row on the Splits sheet
    // would carry a bib that is not on this race's start list, and an unedited upload would
    // fail on it.
    { topic: 'Example result',     details: 'Bib Number 10571 · Distance 10 KM · Chip Time 00:32:35' },
    { topic: 'Example checkpoints', details: 'Two rows for bib 10571 — "10571, 5KM, 5 KM, 06:16:05, 00:16:05, 00:16:05" then "10571, 10KM, 10 KM, 06:32:35, 00:32:35, 00:16:30". The second row\'s Split Time (00:16:30) is that leg alone, not the total.' },
    { topic: 'Time of day',        details: 'On the Splits sheet, Time of Day is a clock reading (06:28:51) and Elapsed Time is time since the start (00:12:05). They are never read as each other.' },
    { topic: 'CSV and splits',     details: 'A CSV file holds one sheet, so it carries the core results only. Download the .xlsx template if you want to publish checkpoints.' },
    { topic: 'Keep the header row', details: 'Columns are matched by their names. If you rename one you will be asked to map it by hand.' },
    { topic: 'File limits',        details: `${RESULTS_ACCEPTED_EXTENSIONS.join(' or ')}, up to ${formatMaxFileSize()} and ${RESULTS_MAX_ROWS.toLocaleString('en-IN')} rows per upload.` },
    { topic: 'Other sheets',       details: `Only the "${RESULTS_SHEET}" sheet is read. This sheet is for you.` },
  ]
}

const RESULTS_COLUMNS: ReportTable['columns'] =
  TEMPLATE_COLUMNS.map(c => ({ key: c.field, label: c.header, type: 'text' as const }))

/** A start-list row: identity prefilled, result columns empty. */
export interface StartListEntry { bibNumber: string; participantName: string | null }

/** The "Results" sheet — prefilled from the start list, or empty for the blank template. */
export function resultsSheet(entries: readonly StartListEntry[]): ReportTable {
  return {
    id:      RESULTS_SHEET,
    title:   RESULTS_SHEET,
    columns: RESULTS_COLUMNS,
    rows:    entries.map(e => ({
      bibNumber: e.bibNumber, participantName: e.participantName ?? '',
      distance: '', chipTime: '', gunTime: '', status: '', gender: '', category: '', ageGroup: '',
    })),
  }
}

export function howToFillSheet(ctx: Parameters<typeof howToFillRows>[0]): ReportTable {
  return {
    id:      HOW_TO_FILL_SHEET,
    title:   HOW_TO_FILL_SHEET,
    columns: [
      { key: 'topic',   label: 'Topic',   type: 'text' },
      { key: 'details', label: 'Details', type: 'text' },
    ],
    rows: howToFillRows(ctx),
  }
}

/**
 * The workbook: Results first (the sheet the parser reads for results), then the optional
 * Splits sheet, then the instructions.
 *
 * RD-RACEOPS-RESULTS-04 · Splits sits BETWEEN them so an organizer scrolling the tabs meets
 * it as part of the data, not as an appendix after the help.
 */
export function resultsWorkbookTables(
  entries: readonly StartListEntry[],
  ctx: Parameters<typeof howToFillRows>[0],
): ReportTable[] {
  return [resultsSheet(entries), splitsSheet(), howToFillSheet(ctx)]
}

/** The CSV template: the header row, plus prefilled identity rows when a start list is given. */
export function resultsCsv(entries: readonly StartListEntry[] = []): string {
  const lines = [csvRow([...TEMPLATE_HEADERS])]
  // One blank cell per remaining column, derived from the headers so the two can never
  // disagree — a hardcoded run of empty strings is how a column silently loses its cell.
  const blanks = TEMPLATE_HEADERS.length - 2
  for (const e of entries) {
    lines.push(csvRow([e.bibNumber, e.participantName ?? '', ...Array.from({ length: blanks }, () => '')]))
  }
  return lines.join('\n') + '\n'
}

/** Filename stems — the race is in the name so two downloads never overwrite each other. */
export function templateFileStem(kind: 'start-list' | 'results-template', eventSlug: string, passSlug: string): string {
  return `${kind}-${eventSlug}-${passSlug}`
}
