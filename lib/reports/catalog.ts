// ─── The report catalogue — the PURE half of the registry ────────────────────
//
// RD-ANALYTICS-12-08. Metadata for every organizer report: label, description, category,
// permission, downloadable formats, scope, date-range support and output shape. No builder,
// no Firestore, no `firebase-admin` — nothing here executes a report.
//
// ═══ WHY THIS IS SEPARATE FROM registry.ts ═══════════════════════════════════
// `finance/reports/page.tsx` is a client component, and `lib/reports/registry.ts` value-imports
// the builders, which import `@/lib/firebase/admin`. Importing the registry from the client
// would therefore pull firebase-admin into the browser bundle. The same trap is documented in
// `lib/discovery/completedDestinations.ts`, which was split for exactly this reason.
//
// So: the catalogue is pure and importable from anywhere; `registry.ts` imports it and adds
// the builder dispatch for server use. Label and permission are defined HERE, once.
//
// ═══ WHY payout-statement IS DESCRIBED BUT NOT DISPATCHED ════════════════════
// It is a different object: `buildPayoutStatement` returns a `PayoutStatement`, not a
// `ReportTable`; it renders through `payoutStatementPdf` rather than `serializeTables`; and it
// answers on its own route. Adding it to the runtime dispatch map would make it resolvable at
// `/api/organizer/reports/payout-statement` and acceptable to the export-job create route,
// both of which would then call `meta.build` and receive the wrong shape. Describing it here
// is what registration means for a report that does not share the table contract — and its
// behaviour is untouched.

import type { ReportDefinition } from '@/lib/reports/types'

/** Downloadable formats every table report supports. `json` is preview, not a download. */
const TABLE_FORMATS = ['csv', 'xlsx', 'pdf'] as const

/**
 * Every organizer report the product offers, in the order the finance page has always listed
 * them. Declaration order IS display order — no separate `order` field, because this object is
 * already ordered and a second source of ordering could disagree with it.
 */
export const REPORT_CATALOG: Record<string, ReportDefinition> = {
  'transactions': {
    kind: 'transactions', label: 'Transactions',
    description: 'Transaction-level financial activity for the selected period.',
    category: 'financial', permission: 'transactions',
    formats: [...TABLE_FORMATS], scope: 'workspace', dateRange: true, output: 'table',
  },
  'settlements': {
    kind: 'settlements', label: 'Settlements',
    description: 'Settlement requests with their status, payout reference and dates.',
    category: 'financial', permission: 'settlements',
    formats: [...TABLE_FORMATS], scope: 'workspace', dateRange: true, output: 'table',
  },
  'wallet-ledger': {
    kind: 'wallet-ledger', label: 'Wallet Ledger',
    description: 'Wallet credits and debits with the running balance after each entry.',
    category: 'financial', permission: 'wallet',
    formats: [...TABLE_FORMATS], scope: 'workspace', dateRange: true, output: 'table',
  },
  'donations': {
    kind: 'donations', label: 'Donations',
    description: 'Donations received, with donor PAN where a receipt records one.',
    category: 'financial', permission: 'transactions',
    formats: [...TABLE_FORMATS], scope: 'workspace', dateRange: true, output: 'table',
  },
  'refunds': {
    kind: 'refunds', label: 'Refunds',
    description: 'Refunds issued from both the registration and donation ledgers.',
    category: 'financial', permission: 'transactions',
    formats: [...TABLE_FORMATS], scope: 'workspace', dateRange: true, output: 'table',
  },
  'broadcast-usage': {
    kind: 'broadcast-usage', label: 'Broadcast Usage',
    description: 'Broadcast campaigns with recipient, delivery and cost figures.',
    category: 'financial', permission: 'wallet',
    formats: [...TABLE_FORMATS], scope: 'workspace', dateRange: true, output: 'table',
  },
  'gst': {
    kind: 'gst', label: 'GST Summary',
    description: 'Taxable value and GST on platform fees, grouped by month.',
    category: 'financial', permission: 'transactions',
    formats: [...TABLE_FORMATS], scope: 'workspace', dateRange: true, output: 'table',
  },
  'payout-statement': {
    kind: 'payout-statement', label: 'Payout Statement',
    description: 'Gross, fees, refunds and net settlement for the period, as a statement.',
    category: 'financial', permission: 'settlements',
    // PDF only — its route rejects every other format, and it has no table to serialize.
    formats: ['pdf'], scope: 'workspace', dateRange: true, output: 'statement',
  },
}

/** Every report the UI may offer, catalogue order preserved. */
export const REPORT_DEFINITIONS: ReportDefinition[] = Object.values(REPORT_CATALOG)
