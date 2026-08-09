// RD-RACEOPS-01 Sprint 2 · Matrix → ParsedTable.
//
// PURE. The one place a raw cell grid becomes a ParsedTable, shared by the CSV and
// Excel providers so header handling and row numbering cannot drift between them.
//
// Row-number contract: the header is file row 1, so the first data row is row 2.
// Blank rows are RETAINED as empty rows rather than filtered, because dropping them
// would shift every subsequent row number and make the validation report cite rows the
// organizer cannot find. (This is precisely why lib/events/builder/contacts.ts
// `parseCsvText` — which filters blank lines and lower-cases headers — cannot be
// reused here; see docs/RD-RACEOPS-DATAFLOW.md.)

import type { ParsedRow, ParsedTable } from '@/features/race-operations/types/results'

/** A cell may arrive as a string, number, boolean, Date (Excel) or null. */
export type RawCell = string | number | boolean | Date | null | undefined

export interface TabulateOptions {
  provider:  string
  sheetName: string | null
}

export type TabulateOutcome =
  | { ok: true;  table: ParsedTable }
  | { ok: false; message: string }

/**
 * Excel time cells arrive as a Date (read-excel-file converts them) or as a fraction
 * of a day. Both must survive to the mapping layer as text, so they are stringified
 * losslessly enough for the time parser to recover them.
 */
export function cellToString(cell: RawCell): string {
  if (cell === null || cell === undefined) return ''
  if (cell instanceof Date) {
    // A spreadsheet duration cell has no meaningful date part — emit hh:mm:ss(.mmm)
    // in UTC, which is how read-excel-file encodes an elapsed-time cell.
    const h  = cell.getUTCHours()
    const m  = cell.getUTCMinutes()
    const s  = cell.getUTCSeconds()
    const ms = cell.getUTCMilliseconds()
    const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return ms > 0 ? `${base}.${String(ms).padStart(3, '0')}` : base
  }
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  return String(cell).trim()
}

/** De-duplicates header names so two columns called "Time" stay addressable. */
function normalizeHeaders(rawHeaderRow: RawCell[]): string[] {
  const out:  string[] = []
  const seen = new Map<string, number>()

  for (const raw of rawHeaderRow) {
    const label = cellToString(raw)
    if (!label) { out.push(''); continue }
    const n = seen.get(label) ?? 0
    seen.set(label, n + 1)
    out.push(n === 0 ? label : `${label} (${n + 1})`)
  }

  // Drop only TRAILING empties — an interior blank header keeps its position so the
  // columns after it stay aligned with their data.
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

export function tabulate(matrix: RawCell[][], opts: TabulateOptions): TabulateOutcome {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return { ok: false, message: 'This file is empty — there is nothing to import.' }
  }

  const headers = normalizeHeaders(matrix[0] ?? [])
  if (headers.length === 0 || headers.every(h => h === '')) {
    return { ok: false, message: 'The first row of this file has no column headings. Add a header row and upload again.' }
  }

  const rows: ParsedRow[] = []
  for (let i = 1; i < matrix.length; i++) {
    const cells: Record<string, string> = {}
    const source = matrix[i] ?? []
    headers.forEach((header, col) => {
      if (!header) return                    // interior blank header — column unaddressable
      cells[header] = cellToString(source[col])
    })
    rows.push({ rowNumber: i + 1, cells })   // header is row 1 ⇒ first data row is 2
  }

  // Trailing all-blank rows are an artefact of spreadsheet exports, not organizer data.
  // Only the tail is trimmed, so interior blanks keep their row numbers and are
  // reported as malformed.
  while (rows.length > 0 && Object.values(rows[rows.length - 1].cells).every(v => v === '')) {
    rows.pop()
  }

  if (rows.length === 0) {
    return { ok: false, message: 'This file has column headings but no result rows.' }
  }

  return { ok: true, table: { headers, rows, provider: opts.provider, sheetName: opts.sheetName } }
}
