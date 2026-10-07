// RD-RACEOPS-RESULTS-06 · Flat results table → cell matrix.
//
// PURE. No SDK, no provider names, no hardcoded coordinates.
//
// ─── The rule this file exists to avoid ─────────────────────────────────────
//   if (x > 123) column = 'bib'
// A parser written that way reads exactly one provider's export and silently mis-columns
// the next. Here the COLUMNS COME FROM THE DOCUMENT: the header row's own items define the
// column anchors, and every later row is assigned by proximity to those anchors. A provider
// that lays its table out differently simply produces different anchors.
//
// ─── How a header is recognised ─────────────────────────────────────────────
// Through the EXISTING mapper (`import/mapping/autoMap.ts` → `aliases.ts`) — the same
// vocabulary the XLSX and CSV importers map with, plus the "RegisterDesk calculates this"
// list from 04. A line is the header when enough of its cells are headings the mapper
// already understands. Nothing about PDFs is special here, which is the point: one
// vocabulary, three file types.
//
// RD-RACEOPS-RESULTS-07B · "understands" now means exactly what `autoMapColumns` would
// map, via `recogniseHeading`. RESULTS-06 counted only direct aliases, so a real
// provider's `Pl. | Bib | Name | Finish ChipTime | Finish TimeOfDay` scored 2 — the mapper
// would have mapped `Finish ChipTime` one step later, but the listing never got there.
//
// ─── Section headings (07B) ─────────────────────────────────────────────────
// A provider that groups its listing by gender and age band prints those as lines between
// the rows ("Male", "16-25 Yrs") rather than as columns. `readTable` carries each heading
// onto the rows beneath it and appends the two facts as extra columns, labelled so the
// mapping step shows where they came from. See ./sections.ts for what is (and is not)
// accepted as a heading.

import {
  ALIAS_TO_FIELD, isProviderCalculatedHeading, normalizeHeader,
} from '@/features/race-operations/import/mapping/aliases'
import { autoMapColumns, recogniseHeading } from '@/features/race-operations/import/mapping/autoMap'
import { isPageFurniture } from './lines'
import {
  EMPTY_SECTION_CONTEXT, SECTION_AGE_GROUP_HEADER, SECTION_GENDER_HEADER,
  applySectionHeading, parseSectionHeading, sectionAgeGroupValue, type SectionContext,
} from './sections'
import type { PdfLine, PdfTextItem } from './types'

/** A header line must carry at least this many recognised headings to be believed. */
const MIN_RECOGNISED_HEADINGS = 3
/** …and one of them must identify a participant, or it is a summary table, not results. */
const IDENTITY_FIELDS = new Set(['bibNumber', 'participantName'])

/** Two or more spaces: the fallback separator when a producer emits a row as ONE item. */
const WIDE_GAP = /\s{2,}/

/** A cell that is only digits, times or punctuation is a value, never a heading. */
const VALUE_ONLY = /^[\d:.,\-+%/\s]+$/

export interface TableColumn {
  header: string
  /** Horizontal centre of the header cell — the anchor rows are matched against. */
  centre: number
}

/**
 * How well a line reads as a header row.
 *
 * A cell counts when the mapper would either map it to a field or recognise it as a column
 * RegisterDesk calculates (rank, pace, speed) — both prove this is a header. The mapper's
 * own safety rules apply unchanged: a clock heading ("Finish TimeOfDay") is never counted
 * as a result time, because the mapper would never map it as one.
 */
export function headingScore(cells: readonly string[]): { recognised: number; identity: boolean } {
  let recognised = 0
  let identity = false
  for (const cell of cells) {
    if (cell.trim() === '' || VALUE_ONLY.test(cell)) continue
    const seen = recogniseHeading(cell)
    if (seen === null) continue
    recognised++
    if (seen.kind === 'field' && IDENTITY_FIELDS.has(seen.field)) identity = true
  }
  return { recognised, identity }
}

/**
 * The cells of a line.
 *
 * Positions first: each text item is a cell. When a producer emits the whole row as a
 * single item — common for simple generators — the text is split on runs of two or more
 * spaces instead. That fallback is a general typographic heuristic, not a fixed offset, and
 * it is only reached when there is literally one item to work with.
 */
export function cellsOf(line: PdfLine): { text: string; centre: number }[] {
  if (line.items.length > 1) {
    return line.items.map(i => ({ text: i.str.trim(), centre: i.x + i.width / 2 }))
  }
  const only: PdfTextItem | undefined = line.items[0]
  if (!only) return []
  const parts = only.str.trim().split(WIDE_GAP).filter(p => p !== '')
  if (parts.length <= 1) return [{ text: only.str.trim(), centre: only.x + only.width / 2 }]
  // Spread the parts across the item's own width so column anchors stay meaningful.
  const per = only.width / parts.length
  return parts.map((text, i) => ({ text, centre: only.x + per * (i + 0.5) }))
}

/**
 * RD-RACEOPS-RESULTS-06 · splits a header cell that the reader merged.
 *
 * pdf.js joins runs that sit close together, so a header laid out as
 * `Participant Name | Gender` with a 4pt gap arrives as ONE item reading
 * "Participant Name Gender". Left alone that produces one column where there are two, and
 * every data row below then piles a name and a gender into the same cell.
 *
 * The split is driven by the MAPPER'S OWN VOCABULARY, not by spacing: the text is consumed
 * left to right, taking the longest run of words that is a heading the mapper recognises.
 * A cell that is already a single recognised heading ("Age Group") is never touched, and a
 * cell that cannot be read as two or more headings is left exactly as it came.
 *
 * Each segment's centre is estimated from its character span within the item's own width —
 * the item's real geometry, not an assumed column position.
 */
function segmentHeaderCell(cell: { text: string; centre: number }, width: number): { text: string; centre: number }[] {
  const whole = normalizeHeader(cell.text)
  if (whole === '' || ALIAS_TO_FIELD.has(whole) || isProviderCalculatedHeading(whole)) return [cell]

  const tokens = cell.text.trim().split(/\s+/)
  if (tokens.length < 2) return [cell]

  const MAX_WORDS = 4
  const segments: { text: string; start: number; end: number }[] = []
  let cursor = 0
  let i = 0
  while (i < tokens.length) {
    let taken = 0
    for (let n = Math.min(MAX_WORDS, tokens.length - i); n >= 1; n--) {
      const phrase = tokens.slice(i, i + n).join(' ')
      const norm = normalizeHeader(phrase)
      if (ALIAS_TO_FIELD.has(norm) || isProviderCalculatedHeading(norm)) {
        segments.push({ text: phrase, start: cursor, end: cursor + phrase.length })
        cursor += phrase.length + 1
        i += n
        taken = n
        break
      }
    }
    if (taken === 0) return [cell]      // a word that is not part of any heading ⇒ leave it alone
  }

  if (segments.length < 2) return [cell]

  const total = cell.text.trim().length || 1
  const left = cell.centre - width / 2
  return segments.map(s => ({ text: s.text, centre: left + width * ((s.start + s.end) / 2) / total }))
}

/** The header line's cells, with merged headings separated. */
export function headerCellsOf(line: PdfLine): { text: string; centre: number }[] {
  const raw = cellsOf(line)
  if (line.items.length !== raw.length) return raw     // the whitespace fallback already split it
  return raw.flatMap((cell, i) => segmentHeaderCell(cell, line.items[i]?.width ?? 0))
}

/** Finds the header line: the best-scoring line, scanned from the top. */
export function findHeaderLine(lines: readonly PdfLine[]): { index: number; columns: TableColumn[] } | null {
  let best: { index: number; columns: TableColumn[]; recognised: number } | null = null

  for (const [index, line] of lines.entries()) {
    if (isPageFurniture(line)) continue
    const cells = headerCellsOf(line)
    if (cells.length < MIN_RECOGNISED_HEADINGS) continue
    const { recognised, identity } = headingScore(cells.map(c => c.text))
    if (!identity || recognised < MIN_RECOGNISED_HEADINGS) continue
    if (best === null || recognised > best.recognised) {
      best = { index, recognised, columns: cells.map(c => ({ header: c.text, centre: c.centre })) }
    }
  }

  return best === null ? null : { index: best.index, columns: best.columns }
}

/** True when a line repeats the header — a page header on page 2, 3, 4… */
export function repeatsHeader(line: PdfLine, columns: readonly TableColumn[]): boolean {
  const cells = cellsOf(line).map(c => normalizeHeader(c.text)).filter(c => c !== '')
  if (cells.length === 0) return false
  const headers = columns.map(c => normalizeHeader(c.header)).filter(c => c !== '')
  const overlap = cells.filter(c => headers.includes(c)).length
  // Most of the line is header words ⇒ it is the header again, not a participant.
  return overlap >= Math.max(2, Math.ceil(cells.length * 0.6))
}

/**
 * Assigns a line's cells to the header's columns.
 *
 * Nearest anchor wins, and two cells landing in one column are joined with a space rather
 * than one overwriting the other — a wrapped name must not silently delete a bib.
 */
export function rowFor(line: PdfLine, columns: readonly TableColumn[]): string[] {
  const row = columns.map(() => '')
  for (const cell of cellsOf(line)) {
    if (cell.text === '') continue
    let nearest = 0
    let distance = Number.POSITIVE_INFINITY
    for (const [i, col] of columns.entries()) {
      const d = Math.abs(col.centre - cell.centre)
      if (d < distance) { distance = d; nearest = i }
    }
    row[nearest] = row[nearest] === '' ? cell.text : `${row[nearest]} ${cell.text}`
  }
  return row
}

export interface TableReadOutcome {
  ok:        boolean
  matrix:    string[][]
  pagesUsed: number
  /** RD-RACEOPS-RESULTS-07B · section headings found and carried onto rows, in order. */
  sections:  string[]
}

/**
 * Reads a flat results table out of the document's lines.
 *
 * Rows continue across pages: a repeated header is skipped, furniture is skipped, and a
 * line that lands in fewer than two columns is skipped as a stray caption rather than
 * imported as a participant with one field.
 *
 * RD-RACEOPS-RESULTS-07B · a line that reads as a SECTION HEADING ("Male", "16-25 Yrs",
 * "Female 26-45") is never a row either — it becomes the gender / age-band context for the
 * rows that follow, until the next heading of its level. When at least one heading was
 * seen, the matrix gains a `Gender (section)` and/or `Age Group (section)` column holding
 * that context per row, so the EXISTING mapper, validation and ranking read the facts the
 * way they would read a provider column. A column is only added for a dimension the table
 * does not already carry as a real column: a printed "Gender" column always wins over a
 * heading, so the two can never disagree on one row.
 *
 * Context persists across a page break while the same table continues — a band that starts
 * at the foot of one page governs the rows at the head of the next, which is how every
 * grouped listing is paginated. It is reset only by a heading, never by a page number.
 */
export function readTable(lines: readonly PdfLine[]): TableReadOutcome {
  const header = findHeaderLine(lines)
  if (header === null) return { ok: false, matrix: [], pagesUsed: 0, sections: [] }

  const headers = header.columns.map(c => c.header)
  const rows: { cells: string[]; context: SectionContext }[] = []
  const pages = new Set<number>()
  const sections: string[] = []
  let context: SectionContext = EMPTY_SECTION_CONTEXT

  for (const line of lines.slice(header.index + 1)) {
    if (isPageFurniture(line)) continue
    if (repeatsHeader(line, header.columns)) continue

    const heading = parseSectionHeading(line.text)
    if (heading !== null) {
      context = applySectionHeading(context, heading)
      sections.push(line.text)
      continue
    }

    const row = rowFor(line, header.columns)
    if (row.filter(c => c !== '').length < 2) continue

    rows.push({ cells: row, context })
    pages.add(line.pageNumber)
  }

  // A header with no rows under it is not a results table — it is a legend or a summary.
  if (rows.length === 0) return { ok: false, matrix: [headers], pagesUsed: 0, sections }

  // Section facts become columns — only where the table has no real column for the field.
  const mapped = sections.length > 0 ? autoMapColumns(headers).mapping : {}
  const addGender   = sections.length > 0 && mapped.gender   === undefined && rows.some(r => r.context.gender   !== null)
  const addAgeGroup = sections.length > 0 && mapped.ageGroup === undefined && rows.some(r => r.context.ageGroup !== null)

  const matrix: string[][] = [[
    ...headers,
    ...(addGender   ? [SECTION_GENDER_HEADER]    : []),
    ...(addAgeGroup ? [SECTION_AGE_GROUP_HEADER] : []),
  ]]
  for (const r of rows) {
    matrix.push([
      ...r.cells,
      ...(addGender   ? [r.context.gender   ?? ''] : []),
      ...(addAgeGroup ? [sectionAgeGroupValue(r.context) ?? ''] : []),
    ])
  }

  return { ok: true, matrix, pagesUsed: pages.size, sections }
}
