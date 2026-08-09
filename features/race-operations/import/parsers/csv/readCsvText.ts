// RD-RACEOPS-01 Sprint 2 · CSV text → cell matrix.
//
// PURE and RFC-4180 correct. No dependency.
//
// ─── Why this is not lib/events/builder/contacts.ts `parseCsvText` ────────────
// That helper is production code for the Event Builder's approved-contact list and is
// deliberately left untouched. It cannot serve results import — three verified defects
// against this use case:
//   1. It LOWER-CASES headers, so the mapping UI could not show the organizer their own
//      "Bib No" heading.
//   2. It FILTERS blank lines before indexing, so file row numbers shift and the
//      validation report would cite rows the organizer cannot locate.
//   3. It mis-parses the RFC-4180 escaped quote: `"he said ""hi"""` yields
//      `he said hi`, silently corrupting data.
// It also returns `[]` for a header-only file, which cannot be distinguished from a
// truly empty file — and those are two different validation messages.
//
// This reader emits a raw matrix and hands it to the shared `tabulate`, so CSV and
// Excel share one header/row-number implementation.

/**
 * Splits CSV text into a matrix of raw string cells.
 *
 *  • Handles quoted fields containing commas, newlines, and `""` escaped quotes.
 *  • Accepts CRLF, LF and CR line endings.
 *  • Strips a UTF-8 BOM (Excel's default CSV export writes one).
 *  • Preserves blank lines as empty rows so row numbering matches the file.
 */
export function readCsvText(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (src === '') return []

  const matrix: string[][] = []
  let row:   string[] = []
  let cell   = ''
  let inQuotes = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ }   // RFC-4180 escaped quote
        else                    { inQuotes = false }
      } else {
        cell += ch
      }
      continue
    }

    if (ch === '"')  { inQuotes = true; continue }
    if (ch === ',')  { row.push(cell); cell = ''; continue }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++       // CRLF counts once
      row.push(cell); cell = ''
      matrix.push(row); row = []
      continue
    }

    cell += ch
  }

  // Flush the final cell/row. A trailing newline leaves an empty pending row, which is
  // an artefact of the line terminator rather than a data row — drop only that case.
  row.push(cell)
  if (!(row.length === 1 && row[0] === '')) matrix.push(row)

  return matrix.map(r => r.map(c => c.trim()))
}
