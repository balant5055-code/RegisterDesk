// lib/wallet/eventWalletView.ts
// RD-WALLET-EVT-01 — the organizer's event-wise Wallet: response shapes and the PURE rules the
// server and the console share. Client-safe: no Firebase, no network, no React.
//
// Nothing here computes money or usage from client input. The server derives every figure from
// the workspace's own records (lib/wallet/eventWalletService.ts) and the console only renders
// them; the helpers below decide labels, phases and attribution — never amounts.

import type { EventLifecycleStatus } from '@/types/events'
import type { AllowanceExhaustionPolicy, ServiceKind } from '@/lib/licensing/serviceAllowances'

// ── phases (the Wallet's filter tabs) ───────────────────────────────────────────────────────────
export type WalletEventPhase = 'live' | 'upcoming' | 'completed' | 'cancelled'
export const WALLET_EVENT_PHASES: readonly WalletEventPhase[] = ['live', 'upcoming', 'completed', 'cancelled']

export function parseWalletEventPhase(v: string | null | undefined): WalletEventPhase | null {
  return v && (WALLET_EVENT_PHASES as readonly string[]).includes(v) ? v as WalletEventPhase : null
}

/** YYYY-MM-DD for `now` in `timeZone` (an invalid / missing zone falls back to India time). */
export function todayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  try { return fmt(timeZone || 'Asia/Kolkata') } catch { return fmt('Asia/Kolkata') }
}

const DAY = /^\d{4}-\d{2}-\d{2}/

/**
 * Pure. Which Wallet tab an event belongs to — from its EFFECTIVE lifecycle (the Events
 * listing's own derivation) and its schedule dates, compared as calendar days in the event's
 * time zone:
 *   cancelled → Cancelled;  completed / archived → Completed;
 *   published / registration_closed / unpublished → by date: ended → Completed, not started →
 *   Upcoming, otherwise (or no dates) → Live;
 *   draft / pending_review / changes_requested (never live yet) → Upcoming.
 */
export function walletEventPhase(lifecycle: EventLifecycleStatus, startDate: string | null, endDate: string | null, today: string): WalletEventPhase {
  if (lifecycle === 'cancelled') return 'cancelled'
  if (lifecycle === 'completed' || lifecycle === 'archived') return 'completed'
  if (lifecycle === 'published' || lifecycle === 'registration_closed' || lifecycle === 'unpublished') {
    const start = startDate && DAY.test(startDate) ? startDate.slice(0, 10) : null
    const end   = endDate && DAY.test(endDate) ? endDate.slice(0, 10) : start
    if (end && end < today) return 'completed'
    if (start && start > today) return 'upcoming'
    return 'live'
  }
  return 'upcoming'
}

// ── response shapes ─────────────────────────────────────────────────────────────────────────────
/** A figure the server could not read is `unavailable` — never shown as zero. */
export type Measured<T> = { ok: true; value: T } | { ok: false; reason: 'unavailable' }

export type RegistrationLine =
  | { state: 'limited';   limit: number; used: number; remaining: number; capacityModel: boolean }
  | { state: 'unlimited'; used: number; capacityModel: boolean }
  /** Paid capacity of an event that is not live yet (activation / add-on orders), nothing used. */
  | { state: 'prepaid';   paidCapacity: number }
  | { state: 'not_applicable'; reason: 'donation_campaign' | 'not_published' | 'no_licence' }
  | { state: 'unavailable' }

export interface ServiceLine {
  service:     ServiceKind
  purchased:   number
  consumed:    number
  remaining:   number
  /** Policy stored with the allowance; null when nothing was purchased. */
  onExhausted: AllowanceExhaustionPolicy | null
  /** RD-WALLET-REQ — units moved by Super Admin-approved requests (0 when none). */
  carriedIn:   number
  carriedOut:  number
  refunded:    number
}

export type PhotoLine =
  /** RD-PHOTO-01 — baseCap is always 0 (no free photos); cap = paid capacity; maxAdditional = 3,000 − cap. */
  | { state: 'limited';   baseCap: number; purchased: number; cap: number; stored: Measured<number>; maxAdditional: number }
  | { state: 'unlimited'; stored: Measured<number> }
  | { state: 'unavailable' }

export interface WalletEventRow {
  draftId:      string
  slug:         string | null
  name:         string
  eventType:    string | null
  lifecycle:    EventLifecycleStatus
  phase:        WalletEventPhase
  startDate:    string | null
  endDate:      string | null
  registrations: RegistrationLine
  /** WhatsApp, certificates, media (extra photos) — exactly the event's allowance ledger. */
  services:     Record<ServiceKind, ServiceLine> | null
  photos:       PhotoLine
  /** WhatsApp messages logged against this event outside the prepaid allowance (usage records). */
  whatsappBilledMessages: Measured<number> | null
  /** Σ amount of this event's PAID licence orders (activation, capacity changes, add-ons). */
  paidPaise:    Measured<number>
}

export interface WalletEventsPage {
  events:      WalletEventRow[]
  nextCursor:  string | null
  /** The scan stopped at its bound before the page filled; `nextCursor` continues it. */
  scanLimited: boolean
}

export type OrderPurposeLabel = 'Activation' | 'Capacity increase' | 'Capacity reduction' | 'Add-on' | 'Licence upgrade' | 'Order'
export function orderPurposeLabel(purpose: unknown): OrderPurposeLabel {
  switch (purpose) {
    case 'purchase':          return 'Activation'
    case 'capacity_increase': return 'Capacity increase'
    case 'capacity_decrease': return 'Capacity reduction'
    case 'addon':             return 'Add-on'
    case 'upgrade':           return 'Licence upgrade'
    default:                  return 'Order'
  }
}

export interface WalletEventPayment {
  orderId:     string
  purpose:     OrderPurposeLabel
  status:      'paid' | 'refunded'
  amountPaise: number
  paidAt:      string | null
}

export interface WalletEventDetail {
  event:    WalletEventRow
  payments: WalletEventPayment[]
  /** Part of a legacy activation that was paid from the communication wallet (License Center's figure). */
  licenceWalletPaidPaise: number
  communication: {
    /** Messages logged against this event (usage records, by `eventSlug`). Null when the event has no slug yet. */
    emailMessages:    Measured<number> | null
    whatsappMessages: Measured<number> | null
    /** Actual communication-wallet debits referencing this event (ledger), and how many. */
    walletChargesPaise: Measured<number>
    walletChargeCount:  Measured<number>
  }
  links: { licenceCenter: string | null; servicesPurchase: string }
}

// ── transaction ↔ event attribution (only references the writers actually store) ─────────────────
export interface TxnEventRef { slug: string | null; draftId: string | null }

/**
 * Pure. The event a communication-wallet transaction can be RELIABLY attributed to, or null.
 *   • `metadata.eventSlug` — WhatsApp confirmations, their retries and certificate WhatsApp;
 *   • a `certificate_charge` with `metadata.eventId` — certificates store the event's DRAFT id;
 *   • anything else (top-ups, broadcast campaigns, adjustments) carries no event reference.
 */
export function txnEventRef(txn: { type?: unknown; metadata?: unknown }): TxnEventRef | null {
  const m = txn.metadata && typeof txn.metadata === 'object' ? txn.metadata as Record<string, unknown> : {}
  if (typeof m.eventSlug === 'string' && m.eventSlug) return { slug: m.eventSlug, draftId: null }
  if (txn.type === 'certificate_charge' && typeof m.eventId === 'string' && m.eventId) return { slug: null, draftId: m.eventId }
  return null
}

export function txnBelongsToEvent(txn: { type?: unknown; metadata?: unknown }, ev: { slug: string | null; draftId: string }): boolean {
  const ref = txnEventRef(txn)
  if (!ref) return false
  return (ref.slug !== null && ref.slug === ev.slug) || (ref.draftId !== null && ref.draftId === ev.draftId)
}

// ── activity filters (RD-WALLET-REQ) ────────────────────────────────────────────────────────────
/** Transaction types that ADD to the communication wallet (the Transactions page's own split). */
export const WALLET_CREDIT_TXN_TYPES: readonly string[] = ['fund_added', 'license_refund', 'refund']
export type TxnDirection = 'credit' | 'debit'
export const parseTxnDirection = (v: string | null | undefined): TxnDirection | null => (v === 'credit' || v === 'debit' ? v : null)
export const txnDirection = (type: unknown): TxnDirection => (WALLET_CREDIT_TXN_TYPES.includes(String(type)) ? 'credit' : 'debit')
