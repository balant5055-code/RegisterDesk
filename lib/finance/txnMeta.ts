// Wallet Ledger & Transaction Explorer — consolidated, metadata-driven rendering
// config (Phase H.5.2).
//
// Unifies the two divergent transaction vocabularies (revenue/platform vs comms
// wallet) plus the comms-channel styling into ONE declarative module, reusing the
// existing label maps in lib/wallet/types + lib/ui/statusColors instead of the
// per-page inline copies. Pure (no React/lucide) so it runs under tsx for tests;
// icons are referenced by key and mapped to lucide in the components.

import {
  WALLET_TXN_TYPE_LABELS, WALLET_TXN_STATUS_LABELS, COMM_CHANNEL_LABELS,
  type WalletTxnType, type WalletTxnStatus, type CommChannel,
} from '@/lib/wallet/types'
import { walletTxnStatusCls } from '@/lib/ui/statusColors'

export interface BadgeMeta { label: string; badgeClass: string }

// ─── Revenue ledger (platformTransactions) status ─────────────────────────────
// Mirrors the existing TXN_STATUS_STYLES on the finance page (now single-source).
const FINANCE_TXN_STATUS: Record<string, BadgeMeta> = {
  completed:  { label: 'Completed',  badgeClass: 'bg-emerald-100 text-emerald-700' },
  pending:    { label: 'Pending',    badgeClass: 'bg-amber-100 text-amber-700' },
  refunded:   { label: 'Refunded',   badgeClass: 'bg-blue-100 text-blue-700' },
  disputed:   { label: 'Disputed',   badgeClass: 'bg-red-100 text-red-700' },
  backfilled: { label: 'Backfilled', badgeClass: 'bg-muted text-muted-foreground' },
}
export const FINANCE_TXN_STATUSES = Object.keys(FINANCE_TXN_STATUS)
export function financeTxnStatusMeta(status: string): BadgeMeta {
  return FINANCE_TXN_STATUS[status] ?? { label: status, badgeClass: 'bg-muted text-muted-foreground' }
}

const FINANCE_TYPE_LABELS: Record<string, string> = {
  event_registration:    'Ticket',
  workshop_fee:          'Workshop',
  conference_ticket:     'Ticket',
  marathon_registration: 'Ticket',
  exhibition_booth:      'Booth',
  sponsorship_package:   'Sponsorship',
  donation:              'Donation',
  membership:            'Membership',
}
export function financeTxnTypeLabel(type: string): string {
  return FINANCE_TYPE_LABELS[type] ?? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ─── Explorer filters (map to the existing ?filter= query values) ─────────────
export type TxnFilter = 'all' | 'tickets' | 'donations' | 'refunds'
export const TXN_FILTERS: { key: TxnFilter; label: string }[] = [
  { key: 'all',       label: 'All'       },
  { key: 'tickets',   label: 'Tickets'   },
  { key: 'donations', label: 'Donations' },
  { key: 'refunds',   label: 'Refunds'   },
]

// ─── Communication wallet transaction ─────────────────────────────────────────
const WALLET_CREDIT_TYPES = new Set<WalletTxnType>(['fund_added', 'refund'])
export function isWalletCredit(type: WalletTxnType): boolean {
  return WALLET_CREDIT_TYPES.has(type)
}
export function walletTxnTypeLabel(type: WalletTxnType): string {
  return WALLET_TXN_TYPE_LABELS[type] ?? type
}
export function walletTxnStatusMeta(status: WalletTxnStatus): BadgeMeta {
  return {
    label:      WALLET_TXN_STATUS_LABELS[status] ?? status,
    badgeClass: walletTxnStatusCls[status] ?? 'bg-muted text-muted-foreground',
  }
}

// ─── Communication channel ────────────────────────────────────────────────────
export interface ChannelMeta { label: string; iconKey: string; badgeClass: string }
const CHANNEL_META: Record<CommChannel, ChannelMeta> = {
  email:    { label: COMM_CHANNEL_LABELS.email,    iconKey: 'mail',            badgeClass: 'bg-sky-100 text-sky-700'         },
  sms:      { label: COMM_CHANNEL_LABELS.sms,      iconKey: 'message-square',  badgeClass: 'bg-amber-100 text-amber-700'     },
  whatsapp: { label: COMM_CHANNEL_LABELS.whatsapp, iconKey: 'messages-square', badgeClass: 'bg-emerald-100 text-emerald-700' },
}
export const COMM_CHANNELS = Object.keys(CHANNEL_META) as CommChannel[]
export function channelMeta(channel: string): ChannelMeta {
  return CHANNEL_META[channel as CommChannel] ?? { label: channel, iconKey: 'circle', badgeClass: 'bg-muted text-muted-foreground' }
}

// ─── Deep-links ───────────────────────────────────────────────────────────────
// Only campaign entities resolve cleanly from the data the transactions API
// exposes today (entityId = campaign slug → the campaign page). Event rows carry
// a slug but event routes are keyed by draft id, so they are intentionally not
// linked (documented reuse-only limitation — no backend change).
export function txnDeepLink(entityType: string, entityId: string): string | null {
  if (entityType === 'campaign' && entityId) return `/dashboard/campaigns/${entityId}`
  return null
}
