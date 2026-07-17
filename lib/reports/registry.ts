// Central registry: report kind → { permission, label, builder }. The single
// organizer reports route resolves everything through this map, so permission
// gating and builder dispatch live in one place.

import type { ReportMeta } from '@/lib/reports/types'
import {
  buildTransactions, buildSettlements, buildWalletLedger,
  buildDonations, buildRefunds, buildBroadcastUsage, buildGst,
} from '@/lib/reports/builders'

export const ORGANIZER_REPORTS: Record<string, ReportMeta> = {
  'transactions':    { kind: 'transactions',    label: 'Transactions',   permission: 'transactions', build: buildTransactions },
  'settlements':     { kind: 'settlements',     label: 'Settlements',    permission: 'settlements',  build: buildSettlements },
  'wallet-ledger':   { kind: 'wallet-ledger',   label: 'Wallet Ledger',  permission: 'wallet',       build: buildWalletLedger },
  'donations':       { kind: 'donations',       label: 'Donations',      permission: 'transactions', build: buildDonations },
  'refunds':         { kind: 'refunds',         label: 'Refunds',        permission: 'transactions', build: buildRefunds },
  'broadcast-usage': { kind: 'broadcast-usage', label: 'Broadcast Usage',permission: 'wallet',       build: buildBroadcastUsage },
  'gst':             { kind: 'gst',             label: 'GST Summary',    permission: 'transactions', build: buildGst },
}

export const ORGANIZER_REPORT_KINDS = Object.keys(ORGANIZER_REPORTS)
