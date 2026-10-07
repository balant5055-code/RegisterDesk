// Central registry: report kind → { permission, label, builder }. The single organizer
// reports route resolves everything through this map, so permission gating and builder
// dispatch live in one place.
//
// ═══ RD-ANALYTICS-12-08 · WHAT CHANGED ═══════════════════════════════════════
// `ORGANIZER_REPORTS` is unchanged in shape and contents — the same seven kinds, the same
// permissions, the same builders. Every consumer behaves exactly as before:
// `/api/organizer/reports/[kind]`, the export-job create route, `permissionForExportJob`, and
// the download authorization that depends on it.
//
// What changed is where a kind's LABEL and PERMISSION are defined. They now live once, in
// `lib/reports/catalog.ts`, and this map is derived from it — so the runtime map and the UI
// cannot drift. The catalogue is deliberately free of any Firestore import (see its header),
// which is what lets the client page read the report list without pulling firebase-admin into
// the browser bundle.
//
// `payout-statement` is in the catalogue but NOT here, because it does not share the
// `ReportTable` contract — see the catalogue for why, and why that is registration rather
// than an omission.

import type { ReportMeta } from '@/lib/reports/types'
import { REPORT_CATALOG } from '@/lib/reports/catalog'
import {
  buildTransactions, buildSettlements, buildWalletLedger,
  buildDonations, buildRefunds, buildBroadcastUsage, buildGst,
} from '@/lib/reports/builders'

/** Builders for the kinds that produce a `ReportTable`. Keyed to match the catalogue. */
const TABLE_BUILDERS: Record<string, ReportMeta['build']> = {
  'transactions':    buildTransactions,
  'settlements':     buildSettlements,
  'wallet-ledger':   buildWalletLedger,
  'donations':       buildDonations,
  'refunds':         buildRefunds,
  'broadcast-usage': buildBroadcastUsage,
  'gst':             buildGst,
}

export const ORGANIZER_REPORTS: Record<string, ReportMeta> = Object.fromEntries(
  Object.entries(TABLE_BUILDERS).map(([kind, build]) => {
    const def = REPORT_CATALOG[kind]
    // A builder with no catalogue entry would have no label and no permission — fail at
    // module load rather than serve a report nobody described.
    if (!def) throw new Error(`[reports/registry] no catalogue entry for builder "${kind}"`)
    return [kind, { kind, label: def.label, permission: def.permission, build }]
  }),
)

export const ORGANIZER_REPORT_KINDS = Object.keys(ORGANIZER_REPORTS)

// Re-exported so server callers that already import the registry need not know about the
// split. Client components must import from '@/lib/reports/catalog' directly.
export { REPORT_CATALOG, REPORT_DEFINITIONS } from '@/lib/reports/catalog'
