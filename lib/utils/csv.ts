// SINGLE source of truth for CSV cell encoding. Pure + dependency-free so both
// server export routes and client-side exporters share ONE implementation
// (no duplicated escaping logic).
//
// Two responsibilities:
//   1. CSV / formula (DDE) injection defense — a cell whose first character is
//      one of  =  +  -  @  (or a leading tab / carriage-return) is interpreted as
//      a formula by Excel / Google Sheets / LibreOffice. Attendee-controlled
//      fields (name, company, website, custom form answers) flow verbatim into
//      organizer/admin exports, so a payload like  =HYPERLINK(...)  or a DDE
//      string must be neutralized. Prefixing a single quote forces the cell to be
//      treated as text.
//   2. RFC-4180 quoting — wrap cells containing a comma, double-quote, or newline
//      and escape embedded quotes.

const FORMULA_TRIGGER = /^[=+\-@\t\r]/

/** Encode any value as one safe CSV cell (formula-neutralized + RFC-4180 quoted). */
export function csvCell(value: unknown): string {
  let v = value == null ? '' : String(value)
  // (1) Neutralize a leading formula / DDE trigger.
  if (FORMULA_TRIGGER.test(v)) v = `'${v}`
  // (2) RFC-4180 quoting.
  if (v.includes(',') || v.includes('"') || v.includes('\n') || v.includes('\r')) {
    return `"${v.replace(/"/g, '""')}"`
  }
  return v
}

/** Join a list of values into one CSV record; each cell hardened via csvCell. */
export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',')
}
