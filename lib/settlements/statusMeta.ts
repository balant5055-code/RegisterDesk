// Settlement status — metadata-driven rendering config (Phase H.5.1).
//
// One declarative table drives every settlement status pill/label/description
// across the app, replacing the three inline `SETTLE_STATUS_STYLES` maps that had
// drifted apart (organizer finance page, admin console). Pure (type-only import)
// so it also runs under tsx for unit tests. No business logic — presentation +
// copy only; the state machine itself lives in the admin settlement route.

import type { SettlementStatus } from './types'

export type SettlementTone = 'warning' | 'info' | 'success' | 'error'

export interface SettlementStatusMeta {
  status:      SettlementStatus
  label:       string
  tone:        SettlementTone
  badgeClass:  string   // matches the existing organizer finance styling exactly
  description: string
}

export const SETTLE_STATUS_META: Record<SettlementStatus, SettlementStatusMeta> = {
  pending:  { status: 'pending',  label: 'Pending',  tone: 'warning', badgeClass: 'bg-amber-100 text-amber-700',    description: 'Awaiting admin review.' },
  approved: { status: 'approved', label: 'Approved', tone: 'info',    badgeClass: 'bg-blue-100 text-blue-700',      description: 'Approved — payout in progress.' },
  paid:     { status: 'paid',     label: 'Paid',     tone: 'success', badgeClass: 'bg-emerald-100 text-emerald-700', description: 'Paid out to your bank account.' },
  rejected: { status: 'rejected', label: 'Rejected', tone: 'error',   badgeClass: 'bg-red-100 text-red-700',        description: 'Request was rejected.' },
}

const FALLBACK: SettlementStatusMeta = {
  status: 'pending', label: 'Unknown', tone: 'info', badgeClass: 'bg-muted text-muted-foreground', description: '',
}

export const SETTLEMENT_STATUSES = Object.keys(SETTLE_STATUS_META) as SettlementStatus[]

export function settlementStatusMeta(status: string): SettlementStatusMeta {
  return SETTLE_STATUS_META[status as SettlementStatus] ?? FALLBACK
}

export function isSettlementStatus(value: string): value is SettlementStatus {
  return Object.prototype.hasOwnProperty.call(SETTLE_STATUS_META, value)
}
