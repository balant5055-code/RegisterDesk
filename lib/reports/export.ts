// Centralized export serializer: ReportTable[] + format → downloadable payload.
// One switch, reused by every report route (organizer + admin).

import type { ReportTable, ExportFormat } from '@/lib/reports/types'
import { tableToCsv }   from '@/lib/reports/csv'
import { tablesToXlsx } from '@/lib/reports/xlsx'
import { reportPdf }    from '@/lib/reports/pdf'

export interface SerializedReport {
  body:        Uint8Array | string
  contentType: string
  filename:    string
}

export async function serializeTables(
  tables: ReportTable[],
  format: Exclude<ExportFormat, 'json'>,
  filenameBase: string,
  pdfMeta: { heading: string; sub?: string },
): Promise<SerializedReport> {
  switch (format) {
    case 'csv':
      return {
        body: tableToCsv(tables[0]),
        contentType: 'text/csv; charset=utf-8',
        filename: `${filenameBase}.csv`,
      }
    case 'xlsx':
      return {
        body: new Uint8Array(tablesToXlsx(tables)),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${filenameBase}.xlsx`,
      }
    case 'pdf':
      return {
        body: await reportPdf(tables, pdfMeta),
        contentType: 'application/pdf',
        filename: `${filenameBase}.pdf`,
      }
  }
}

export function isExportFormat(v: string | null): v is Exclude<ExportFormat, 'json'> {
  return v === 'csv' || v === 'xlsx' || v === 'pdf'
}
