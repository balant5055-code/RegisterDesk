// CSV exporter. Cell encoding (formula-injection defense + RFC-4180 quoting) is
// delegated to the shared lib/utils/csv helper — no local escaping logic.

import type { ReportTable } from '@/lib/reports/types'
import { cellToDisplay } from '@/lib/reports/format'
import { csvCell as csvEscape } from '@/lib/utils/csv'

/** One table → CSV text (header, rows, blank line, then summary rows). */
export function tableToCsv(table: ReportTable): string {
  const lines: string[] = []
  lines.push(table.columns.map(c => csvEscape(c.label)).join(','))
  for (const row of table.rows) {
    lines.push(table.columns.map(c => csvEscape(cellToDisplay(row[c.key] ?? null, c.type))).join(','))
  }
  if (table.summary && table.summary.length > 0) {
    lines.push('')
    for (const s of table.summary) {
      lines.push(`${csvEscape(s.label)},${csvEscape(cellToDisplay(s.value, s.type))}`)
    }
  }
  // GA-7C S2/P6: disclose truncation IN-FILE (was only shown in the PDF) so a CSV
  // opened in a spreadsheet never silently under-reports. Same wording as the PDF.
  if (table.truncated) {
    lines.push('')
    lines.push(csvEscape(`Note: limited to the most recent ${table.rows.length} records. Narrow the date range for a complete export.`))
  }
  // BOM so Excel opens UTF-8 (₹) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n'
}
