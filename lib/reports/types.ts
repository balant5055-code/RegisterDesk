// Finance & Compliance Reports — shared types (Phase G.1).
//
// A ReportTable is the SINGLE normalized shape every builder emits and every
// exporter (CSV/XLSX/PDF) consumes. Cells hold RAW values (paise for money, ISO
// strings for dates) + a column `type`; each exporter formats according to type.
// This is why there is exactly one place that knows how to render money/dates —
// no duplicated financial formatting across export formats.

import type { TeamPermission } from '@/lib/team/types'

export type ReportColumnType = 'text' | 'money' | 'date' | 'number'

export interface ReportColumn {
  key:    string
  label:  string
  type:   ReportColumnType
  align?: 'left' | 'right'
}

// Cell values: money columns hold PAISE (integer); date columns hold ISO string
// or null; number columns hold a raw number; text holds a string.
export type ReportCell = string | number | null
export type ReportRow  = Record<string, ReportCell>

export interface ReportSummaryItem {
  label: string
  value: ReportCell
  type:  ReportColumnType
}

export interface ReportTable {
  id:        string                 // sheet name / file slug
  title:     string
  columns:   ReportColumn[]
  rows:      ReportRow[]
  summary?:  ReportSummaryItem[]     // totals shown below the table
  truncated?: boolean                // true when the row cap was hit
  note?:     string
}

export interface ReportFilters {
  from?:     string   // 'YYYY-MM-DD' inclusive (UTC day start)
  to?:       string   // 'YYYY-MM-DD' inclusive (UTC day end)
  event?:    string   // entityId / eventSlug
  campaign?: string   // campaignSlug
  status?:   string   // report-specific status token
}

export type ExportFormat = 'csv' | 'xlsx' | 'pdf' | 'json'

export interface ReportMeta {
  kind:        string
  label:       string
  permission:  TeamPermission
  build:       (uid: string, filters: ReportFilters) => Promise<ReportTable>
}

// Cap on rows scanned per report (keeps reads + memory bounded). Builders set
// `truncated: true` when they hit it so the UI/exports can disclose the limit.
export const REPORT_ROW_CAP = 5000

// Payout statement — a settlement-style financial summary rendered to PDF.
// All amounts in paise; derived ONLY from stored ledger fields (no recomputation).
export interface PayoutStatement {
  organizerName:        string
  period:               { from: string | null; to: string | null }
  settlementReference:  string | null   // UTR / bank reference
  settlementDate:       string | null   // ISO
  grossRevenuePaise:    number
  platformFeesPaise:    number
  gstPaise:             number
  refundsPaise:         number
  netSettlementPaise:   number
  transactionCount:     number
  // GA-8 P1-2: true when any source (transactions/refunds/settlements) hit
  // REPORT_ROW_CAP, so the statement can DISCLOSE that its totals are partial
  // rather than silently under-report money. Mirrors ReportTable.truncated.
  truncated:            boolean
}
