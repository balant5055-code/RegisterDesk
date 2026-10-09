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
  /**
   * XLSX only, opt-in: format every column as Text (Excel numFmt 49), so values an
   * organizer TYPES into the sheet are kept exactly — "+919876543210", "0012",
   * "1990-05-15" — instead of Excel turning them into numbers or date serials.
   * For fill-in templates; exports leave it unset.
   */
  textColumns?: boolean
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

// ═══ RD-ANALYTICS-12-08 · REPORT METADATA ════════════════════════════════════
//
// `ReportMeta` above is the RUNTIME dispatch contract: which permission gates this kind, and
// which builder produces its table. It carries nothing a UI can render from, which is why
// `finance/reports/page.tsx` kept its own hardcoded list of the same eight reports — two
// definitions of one thing, free to drift.
//
// `ReportDefinition` is that missing description. It is metadata only: no builder, no
// behaviour, and adding an entry to the catalogue does not make a report callable.

/**
 * Every report today is financial. A single-member union rather than a free string, so a
 * future non-financial report has to be added deliberately instead of by typo — and so the
 * upcoming workspace can group without inventing a taxonomy.
 */
export type ReportCategory = 'financial'

/** Workspace-wide, or scoped to one event. Every current report is workspace-wide. */
export type ReportScope = 'workspace' | 'event'

/**
 * What the report PRODUCES, and therefore how it is fetched and previewed.
 *
 * This replaces the `statement: true` flag the UI kept. It is not decoration: `table` reports
 * go through `/api/organizer/reports/[kind]`, serialize via `serializeTables`, and are
 * eligible for background export jobs; `statement` means the payout statement, which has its
 * own route, returns a `PayoutStatement` rather than a `ReportTable`, and renders through
 * `payoutStatementPdf`.
 */
export type ReportOutput = 'table' | 'statement'

/**
 * Presentation metadata for one report.
 *
 * `formats` lists the DOWNLOADABLE file formats only. Every report also answers `format=json`
 * on its route for in-app preview — that is a route capability, not a download, and it is
 * deliberately not listed here so the field means one thing.
 */
export interface ReportDefinition {
  kind:        string
  label:       string
  /** One factual sentence. Shown beside the report; not marketing copy. */
  description: string
  category:    ReportCategory
  permission:  TeamPermission
  /** Reuses ExportFormat rather than restating it; `json` is preview, never a download. */
  formats:     Exclude<ExportFormat, 'json'>[]
  scope:       ReportScope
  /** True when the report honours `from`/`to`. */
  dateRange:   boolean
  output:      ReportOutput
  /**
   * Reserved for operational reports that only apply where a capability is configured (e.g.
   * timing). Every current report is universal across all nine event types, so no entry sets
   * it. Left optional rather than modelled speculatively — RD-ANALYTICS-10's
   * `OperationalCapabilities` is the resolver a future report would use, and event-type is
   * never the source.
   */
  capability?: never
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
  grossRevenuePaise:        number

  // ═══ FOUR FEES, FOUR FIELDS ══════════════════════════════════════════════
  // RegisterDesk and Razorpay are different companies charging different fees. They were
  // previously summed into one field named `platformFeesPaise`, which reported Razorpay’s
  // cut as RegisterDesk’s. The components are now separate and the aggregate is named
  // for what it is.
  platformFeeBasePaise:     number
  platformFeeGstPaise:      number
  platformFeeTotalPaise:    number

  /** `actual ?? estimate`, per transaction. TAX-INCLUSIVE. */
  gatewayFeePaise:          number
  /** Sum over the rows that carry an actual; null when none do. */
  gatewayFeeActualPaise:    number | null
  gatewayFeeEstimatePaise:  number
  /** GST CONTAINED WITHIN `gatewayFeePaise`. Never added to it, never a fifth charge. */
  gatewayTaxPaise:          number | null
  gatewayFeeBasis:          'actual' | 'estimated' | 'mixed'

  /** platformFeeTotal + gatewayFee. An aggregate, published beside its components. */
  totalFeesPaise:           number

  refundsPaise:             number
  registrationRefundsPaise: number
  donationRefundsPaise:     number
  refundCount:              number

  /**
   * The organizer payable, SUMMED FROM THE STORED LEDGER — never recomputed as
   * gross − fees − refunds. Under an attendee-pays model the attendee bore the fees and
   * the organizer receives the full gross; subtracting them understated the payout by the
   * whole fee total. The ledger already records what is owed.
   */
  netSettlementPaise:       number
  transactionCount:         number
  // GA-8 P1-2: true when any source (transactions/refunds/settlements) hit
  // REPORT_ROW_CAP, so the statement can DISCLOSE that its totals are partial
  // rather than silently under-report money. Mirrors ReportTable.truncated.
  truncated:            boolean
}
