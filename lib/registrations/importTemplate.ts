// Shared contract for the Bulk Registration Import template + parser.
// PURE + isomorphic — no Firebase, no server/client-only imports — so the SERVER
// template generator (RM-2.1) and the CLIENT parser (RM-2.2A) agree on one source
// of truth for sheet names, the template version, required headers, and limits.

import type { ReportTable } from '@/lib/reports/types'

export const IMPORT_TEMPLATE_VERSION = '1'

// Sheet names inside the generated workbook.
export const IMPORT_SHEET_PARTICIPANTS  = 'Participants'
export const IMPORT_SHEET_FIELD_OPTIONS = 'Field Options'
export const IMPORT_SHEET_INSTRUCTIONS  = 'Instructions'
export const IMPORT_SHEET_META          = 'Meta'

// Standard header cells that MUST be present in the Participants sheet for the file
// to be structurally valid (the required standard columns carry a " *" marker).
export const IMPORT_REQUIRED_HEADERS = ['Full Name *', 'Email *', 'Pass *'] as const

// Structural limits (enforced by the parser — NOT value validation).
export const IMPORT_MAX_ROWS       = 2000
export const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024   // 5 MB

// Row keys used in the Meta sheet (Key | Value pairs).
export const IMPORT_META_KEYS = {
  version:     'Template Version',
  eventId:     'Event ID',
  eventSlug:   'Event Slug',
  generatedAt: 'Generated At',
} as const

export interface ImportTemplateMetadata {
  version:     string
  eventId:     string
  eventSlug:   string
  generatedAt: string   // ISO 8601
}

// ─── Meta sheet (template AND failed-rows re-import file) ────────────────────
// RD-IMPORT-RT-01 — ONE builder for the machine-read contract, so the "failed rows"
// workbook can be fixed and re-imported exactly like the template it came from.
export function importMetaTable(eventId: string, eventSlug: string, generatedAt: string = new Date().toISOString()): ReportTable {
  return {
    id:      IMPORT_SHEET_META,
    title:   IMPORT_SHEET_META,
    columns: [
      { key: 'key',   label: 'Key',   type: 'text' },
      { key: 'value', label: 'Value', type: 'text' },
    ],
    rows: [
      { key: IMPORT_META_KEYS.version,     value: IMPORT_TEMPLATE_VERSION },
      { key: IMPORT_META_KEYS.eventId,     value: eventId },
      { key: IMPORT_META_KEYS.eventSlug,   value: eventSlug },
      { key: IMPORT_META_KEYS.generatedAt, value: generatedAt },
    ],
  }
}

// ─── Cell → text (client parser) ──────────────────────────────────────────────
// RD-IMPORT-RT-01 — Excel stores a typed date as a DATE SERIAL, which the workbook
// reader hands back as a JS Date. `String(date)` produced "Fri May 15 1990 05:30:00
// GMT+0530 (India Standard Time)" — stored verbatim, and a day early west of UTC.
// The reader builds the Date in UTC, so its UTC fields are the date the organizer
// typed: a date-only cell → "YYYY-MM-DD", a time-only cell (Excel day zero) → "HH:MM",
// both → "YYYY-MM-DD HH:MM" — the shapes the online form's date/time inputs store.
// Rounded to the minute: the reader floors milliseconds, so 13:20 arrives as 13:19:59.999.
export function importCellText(v: unknown): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return ''
    const iso = new Date(Math.round(v.getTime() / 60_000) * 60_000).toISOString()
    const date = iso.slice(0, 10), time = iso.slice(11, 16)
    if (Number(iso.slice(0, 4)) < 1900) return time                 // time-only cell
    return time === '00:00' ? date : `${date} ${time}`
  }
  return String(v ?? '').trim()
}

// RD-IMPORT-ROWNUM-01 — the Participants sheet's data rows WITH their real spreadsheet row
// numbers. `data` is the reader's grid, header first. The reader keeps leading and interior
// blank rows (it trims only trailing ones), so data[k] IS spreadsheet row k + 1: the header is
// row 1 and the first data row is row 2. Blank rows are dropped for import, but every kept row
// remembers where it was, so a message about "row 7" points at row 7 in Excel.
export function numberImportRows(
  data: unknown[][], headers: string[],
): { rows: Record<string, string>[]; rowNumbers: number[] } {
  const kept = data.slice(1)
    .map((r, k) => ({ cells: headers.map((_, i) => importCellText(r?.[i])), rowNumber: k + 2 }))
    .filter(x => x.cells.some(c => c !== ''))
  return {
    rows:       kept.map(x => Object.fromEntries(headers.map((h, i) => [h, x.cells[i] ?? '']))),
    rowNumbers: kept.map(x => x.rowNumber),
  }
}
