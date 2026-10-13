// lib/wallet/serviceRequestRules.ts
// RD-WALLET-REQ — the event-wise Wallet: each prepaid service's state, organizer REFUND and
// CARRY-FORWARD requests for unused units of a closed event, and the PURE rules the server, the
// organizer Wallet and the Super Admin console share. Client-safe: no Firebase, no network, no React.
//
// ═══ POLICY, AS IMPLEMENTED ══════════════════════════════════════════════════════════════════════
// D6 (approved 2026-10-01) + the event-wise Wallet decisions (2026-10-02):
//   • closed / archived / cancelled events only (lifecycle, never dates);
//   • ONLY UNUSED units are refundable — never used, already refunded or already carried units;
//   • a REFUND request must be submitted within 24 HOURS of the event's closure instant
//     (eventClosedAtMs) — changed from 30 days on 2026-10-06. Submitted before closure + 24 h ⇒ in
//     time; at or after it ⇒ REFUND_WINDOW_CLOSED. Checked at SUBMISSION only. An unrecorded closure
//     fails closed (review);
//   • the refund CAP is the verified value of exactly those unused units, from the actual paid
//     purchase lines (incl. GST), minus anything already approved — valueUnits below;
//   • coupons (Option A): a licence coupon discounts the ACTIVATION FEE only; service lines are
//     charged at full price, so their verified line totals are used as-is, never re-allocated;
//   • the Super Admin approves an amount ≤ the cap re-derived at decision time, with a reason;
//     approval never moves money; "processed" needs the external refund reference;
//   • carry-forward: Super Admin approval, to an open event of the same organizer, units only.
//
// Services:
//   whatsapp, certificates — ledger counters (purchased / consumed), reconciled against paid order
//                            lines and usage records. Refund + carry-forward.
//   media (event photos)   — purchased units raise the event's photo limit; used = photos stored
//                            above the base limit RECORDED ON THE PURCHASE LINE (baseCapAtPurchase,
//                            from 2026-10-02). Lines without it → Super Admin review, no amount.
//                            Refund + carry-forward. (Organizer-wide media CREDITS are a different
//                            entitlement with their own refund flow — never refunded here.)
//   registrations          — capacity-priced events only: paid capacity units above the free
//                            allowance; used = registrations above the free allowance. Refund ONLY
//                            (decided 2026-10-02): approval lowers the event's enforced capacity.
//                            Never carried forward.
//
// VALUATION (valueUnits): units of a service are ordered oldest purchase line → newest. Usage
// consumes from the OLDEST end (first in, first out); units that left the event (refunds,
// carry-forwards, capacity reductions) leave from the NEWEST end. The unused units are what is left
// in between, so each is valued at the price of the line it came from — never an average. Each line
// contributes floor(units × lineTotal ÷ lineQuantity), so partial refunds of one line can never add
// up to more than that line's total.

import type { EventLifecycleStatus } from '@/types/events'

export const SERVICE_REQUESTS_COLLECTION = 'walletServiceRequests'

export type ServiceRequestKind = 'refund' | 'carry_forward'
export const SERVICE_REQUEST_KINDS: readonly ServiceRequestKind[] = ['refund', 'carry_forward']
export type ServiceRequestStatus = 'submitted' | 'approved' | 'rejected' | 'processed'
export const SERVICE_REQUEST_STATUSES: readonly ServiceRequestStatus[] = ['submitted', 'approved', 'rejected', 'processed']

/** Every event service the Wallet shows, in display order. */
// RD-PRINT-BILL-P4 — 'print_badges': prepaid ID-badge units (bought only through a badge purchase
// order; never in the generic add-on selection — SERVICE_KINDS is unchanged).
export type RequestableService = 'registrations' | 'whatsapp' | 'certificates' | 'media' | 'print_badges'
export const REQUESTABLE_SERVICES: readonly RequestableService[] = ['registrations', 'whatsapp', 'certificates', 'media', 'print_badges']
/** Services whose units can be carried to another event (capacity cannot — decided 2026-10-02). */
export const CARRYABLE_SERVICES: readonly RequestableService[] = ['whatsapp', 'certificates', 'media', 'print_badges']
/** The allowance-ledger services (eventServiceAllowances lines). */
export type LedgerService = Exclude<RequestableService, 'registrations'>
export const isLedgerService = (s: RequestableService): s is LedgerService => s !== 'registrations'

export const isRequestableService = (v: unknown): v is RequestableService =>
  typeof v === 'string' && (REQUESTABLE_SERVICES as readonly string[]).includes(v)
export const isServiceRequestKind = (v: unknown): v is ServiceRequestKind =>
  typeof v === 'string' && (SERVICE_REQUEST_KINDS as readonly string[]).includes(v)
export const isServiceRequestStatus = (v: unknown): v is ServiceRequestStatus =>
  typeof v === 'string' && (SERVICE_REQUEST_STATUSES as readonly string[]).includes(v)

// ── the event must be CLOSED by the organizer's own lifecycle action ──────────────────────────────
const CLOSED: readonly EventLifecycleStatus[] = ['completed', 'archived', 'cancelled']
export const isClosedLifecycle = (l: EventLifecycleStatus) => CLOSED.includes(l)

// ── service state (built by the server from verified records) ───────────────────────────────────
/** One paid purchase line: an order's service line, or a capacity order's paid units. */
export interface PurchaseLot { orderId: string; at: number; quantity: number; totalPaise: number }

export type StateProblemCode =
  | 'LEDGER_UNRECONCILED'          // counters disagree with paid orders / usage records
  | 'USAGE_UNVERIFIABLE'           // usage could not be read right now
  | 'HISTORICAL_DATA_UNAVAILABLE'  // the records needed to value / measure these units do not exist
  | 'CAPACITY_TERMS_CHANGED'       // capacity orders were priced under different free allowances

export interface ServiceState {
  service:     RequestableService
  /** false → nothing was bought for this service on this event (or it does not apply). */
  applicable:  boolean
  notApplicableReason: string | null
  /** Units PAID for on this event (registrations: paid capacity units above the free allowance). */
  purchased:   number
  /** Units used; null when it could not be measured. */
  used:        number | null
  carriedIn:   number
  carriedOut:  number
  refunded:    number
  /** Units still usable on this event (incl. carried-in); null when usage cannot be measured — never assumed 0. */
  remaining:   number | null
  /** Unused units of THIS event's own purchase — the only refundable / carryable units. */
  ownUnused:   number
  /** Σ verified paid line totals (incl. GST). */
  paidPaise:   number
  lots:        PurchaseLot[]
  /** Valuation positions (see the header): units consumed from the oldest end / gone from the newest. */
  usedFront:   number
  removedBack: number
  /** A data problem that blocks requests for this service (Super Admin review). */
  problem:     { code: StateProblemCode; reason: string } | null
  /** Service-specific facts shown with the figures. */
  facts:       Record<string, number | null>
}

// ── valuation ───────────────────────────────────────────────────────────────────────────────────
export interface ValuationPart { orderId: string; units: number; valuePaise: number }

/**
 * Pure. The value of the `k` unused units nearest the NEWEST end (just inside the units that already
 * left), line by line. null when the positions are inconsistent (more units than were bought).
 */
export function valueUnits(lots: readonly PurchaseLot[], usedFront: number, removedBack: number, k: number): { valuePaise: number; parts: ValuationPart[] } | null {
  const sorted = [...lots].filter(l => l.quantity > 0).sort((a, b) => a.at - b.at || a.orderId.localeCompare(b.orderId))
  const total = sorted.reduce((n, l) => n + l.quantity, 0)
  const take = Math.trunc(k)
  if (take < 0 || usedFront < 0 || removedBack < 0 || usedFront + removedBack + take > total) return null
  const end = total - removedBack, start = end - take
  const parts: ValuationPart[] = []
  let pos = 0
  for (const l of sorted) {
    const s = Math.max(start, pos), e = Math.min(end, pos + l.quantity)
    if (e > s) {
      const units = e - s
      parts.push({ orderId: l.orderId, units, valuePaise: units === l.quantity ? l.totalPaise : Math.floor((units * l.totalPaise) / l.quantity) })
    }
    pos += l.quantity
  }
  return { valuePaise: parts.reduce((n, p) => n + p.valuePaise, 0), parts }
}

/**
 * RD-PRINT-BILL-P4 · Pure. The EXACT valuation used for badge lots only (every other service keeps
 * valueUnits above, unchanged). A lot's unit at position i (0-based, oldest first) is worth
 * F(i+1) − F(i) with F(n) = ⌊n × total ÷ quantity⌋, so the parts of ONE lot always add up to its
 * total exactly — however many separate refunds take them. With valueUnits' per-part floor, two
 * half refunds of a 2,001-paise lot would come to 2,000 and the lot could never be fully refunded.
 * Same positions, same parts and the same null on inconsistency as valueUnits.
 */
export function valueUnitsExact(lots: readonly PurchaseLot[], usedFront: number, removedBack: number, k: number): { valuePaise: number; parts: ValuationPart[] } | null {
  const sorted = [...lots].filter(l => l.quantity > 0).sort((a, b) => a.at - b.at || a.orderId.localeCompare(b.orderId))
  const total = sorted.reduce((n, l) => n + l.quantity, 0)
  const take = Math.trunc(k)
  if (take < 0 || usedFront < 0 || removedBack < 0 || usedFront + removedBack + take > total) return null
  const end = total - removedBack, start = end - take
  const parts: ValuationPart[] = []
  let pos = 0
  for (const l of sorted) {
    const s = Math.max(start, pos), e = Math.min(end, pos + l.quantity)
    if (e > s) {
      const F = (n: number) => Math.floor((n * l.totalPaise) / l.quantity)
      parts.push({ orderId: l.orderId, units: e - s, valuePaise: F(e - pos) - F(s - pos) })
    }
    pos += l.quantity
  }
  return { valuePaise: parts.reduce((n, p) => n + p.valuePaise, 0), parts }
}

/** The valuation a service's refunds use: exact for badge lots, valueUnits for everything else. */
export const valuationFor = (service: RequestableService) => service === 'print_badges' ? valueUnitsExact : valueUnits

// ── eligibility ─────────────────────────────────────────────────────────────────────────────────
export type IneligibleCode =
  | 'EVENT_NOT_CLOSED'
  | 'DONATION_CAMPAIGN'
  | 'NOT_APPLICABLE'
  | 'NOTHING_UNUSED'
  | 'REQUEST_OPEN'
  | 'NO_PAID_BASIS'
  | 'SERVICE_NOT_SUPPORTED'
  | 'REFUND_WINDOW_CLOSED'
  | 'CLOSURE_DATE_UNKNOWN'
  | StateProblemCode

export type Eligibility =
  | { eligible: true; quantity: number; upperBoundPaise?: number; valuation?: ValuationPart[] }
  | { eligible: false; code: IneligibleCode; reason: string }

export interface EligibilityContext {
  lifecycle:    EventLifecycleStatus
  campaignType: string | null
  /** An undecided request (either kind) for this event + service exists. */
  openRequest:  boolean
  closedAtMs:   number | null
  /** The SUBMISSION instant — omitted at approval (the 24-hour window is a submission rule). */
  windowAt?:    number
  /** Σ amounts already approved / refunded for this event + service. */
  approvedPaise: number
}

/** Pure. Can `kind` be requested for this service now — and for a refund, up to what amount? */
export function requestEligibility(kind: ServiceRequestKind, s: ServiceState, c: EligibilityContext): Eligibility {
  const no = (code: IneligibleCode, reason: string): Eligibility => ({ eligible: false, code, reason })
  if (!isClosedLifecycle(c.lifecycle)) return no('EVENT_NOT_CLOSED', 'Available once the event is marked completed, cancelled or archived.')
  if (c.campaignType === 'donation_only') return no('DONATION_CAMPAIGN', 'Donation campaigns have no prepaid services.')
  if (kind === 'carry_forward' && !CARRYABLE_SERVICES.includes(s.service)) {
    return no('SERVICE_NOT_SUPPORTED', 'Registration capacity cannot be carried to another event.')
  }
  if (!s.applicable) return no('NOT_APPLICABLE', s.notApplicableReason ?? 'Nothing was bought for this service on this event.')
  if (s.problem) return no(s.problem.code, s.problem.reason)
  if (s.ownUnused <= 0) return no('NOTHING_UNUSED', 'No unused units from this event’s own purchase.')
  if (c.openRequest) return no('REQUEST_OPEN', 'A request for this service is already awaiting a decision.')
  if (kind === 'carry_forward') return { eligible: true, quantity: s.ownUnused }
  if (c.windowAt !== undefined) {
    const w = refundWindowProblem({ closedAtMs: c.closedAtMs, windowAt: c.windowAt })
    if (w) return w
  }
  const v = valuationFor(s.service)(s.lots, s.usedFront, s.removedBack, s.ownUnused)
  if (!v) return no('LEDGER_UNRECONCILED', 'The unused units do not match the paid purchase lines — requires Super Admin review.')
  const cap = Math.max(0, Math.min(v.valuePaise, s.paidPaise - Math.max(0, c.approvedPaise)))
  if (cap <= 0) return no('NO_PAID_BASIS', 'No paid amount is on record for these units — requires Super Admin review.')
  return { eligible: true, quantity: s.ownUnused, upperBoundPaise: cap, valuation: v.parts }
}

// ── The event-service refund window: 24 HOURS from closure (2026-10-06; D6 had 30 days) ──────────
export const REFUND_WINDOW_HOURS = 24
export const REFUND_WINDOW_MS = REFUND_WINDOW_HOURS * 3_600_000

/**
 * Pure. The instant the event CLOSED, in ms, from the stamps the only lifecycle writer
 * (lib/events/lifecycle applyLifecycleTransition) sets with the server clock: completedAt,
 * cancelledAt, archivedAt. Completed / cancelled can only move on to archived, so the FIRST closure
 * stamp is the closure; the only way back is restore (which stamps restoredAt), so stamps from before
 * the last restore belong to an earlier closure and are ignored. null when none is recorded.
 */
export function eventClosedAtMs(stamps: { completedAt: number | null; cancelledAt: number | null; archivedAt: number | null; restoredAt: number | null }): number | null {
  const after = stamps.restoredAt ?? -Infinity
  const closes = [stamps.completedAt, stamps.cancelledAt, stamps.archivedAt].filter((t): t is number => t !== null && t > after)
  return closes.length ? Math.min(...closes) : null
}

/**
 * Pure. The instant the refund window CLOSES (closure + 24 h), or null when the closure is unknown.
 * Exclusive: a request submitted strictly BEFORE it is in time; at or after it is not.
 */
export const refundDeadlineMs = (closedAtMs: number | null) => (closedAtMs === null ? null : closedAtMs + REFUND_WINDOW_MS)

/** Pure. Was a refund request submitted at `atMs` inside the window? (null deadline ⇒ unknown) */
export const withinRefundWindow = (atMs: number, closedAtMs: number | null): boolean | null => {
  const deadline = refundDeadlineMs(closedAtMs)
  return deadline === null ? null : atMs < deadline
}

/**
 * Pure. The 24-hour window for a REFUND request, checked at SUBMISSION (`windowAt`) only — a request
 * submitted in time is never expired by a slow review. Carry-forward moves units, not money, and has
 * no window. A closure instant that is not recorded fails closed (review), never "open".
 */
export function refundWindowProblem(i: { closedAtMs: number | null; windowAt: number }): Extract<Eligibility, { eligible: false }> | null {
  const deadline = refundDeadlineMs(i.closedAtMs)
  if (deadline === null) return { eligible: false, code: 'CLOSURE_DATE_UNKNOWN', reason: 'The event’s closure date is not recorded, so the refund window cannot be checked — requires Super Admin review.' }
  if (i.windowAt >= deadline) return { eligible: false, code: 'REFUND_WINDOW_CLOSED', reason: `Refund requests closed ${REFUND_WINDOW_HOURS} hours after the event was completed, cancelled or archived.` }
  return null
}

/** Pure. Can units be carried INTO this event? (Ownership is checked by the server.) */
export function destinationProblem(d: { draftId: string; lifecycle: EventLifecycleStatus; campaignType: string | null }, sourceDraftId: string): string | null {
  if (d.draftId === sourceDraftId) return 'Choose a different event to carry units into.'
  if (isClosedLifecycle(d.lifecycle)) return 'The destination event is already closed.'
  if (d.campaignType === 'donation_only') return 'Donation campaigns cannot use prepaid services.'
  return null
}

// ── decisions ───────────────────────────────────────────────────────────────────────────────────
export type ServiceRequestAction = 'approve' | 'reject' | 'mark_processed'
export const isServiceRequestAction = (v: unknown): v is ServiceRequestAction =>
  v === 'approve' || v === 'reject' || v === 'mark_processed'

/** The status a decision moves a request to. */
export function targetStatus(action: ServiceRequestAction): ServiceRequestStatus {
  return action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'processed'
}

/**
 * Pure. Is `action` allowed on a request of `kind` in `status`?
 *   'apply'   — make the change;
 *   'already' — the request is ALREADY in the target state (a repeat): change nothing;
 *   'refuse'  — not a valid transition.
 */
export function decisionTransition(kind: ServiceRequestKind, status: ServiceRequestStatus, action: ServiceRequestAction): 'apply' | 'already' | 'refuse' {
  if (action === 'mark_processed' && kind !== 'refund') return 'refuse'      // a carry-forward completes at approval
  if (status === targetStatus(action)) return 'already'
  if (action === 'mark_processed') return status === 'approved' ? 'apply' : 'refuse'
  return status === 'submitted' ? 'apply' : 'refuse'
}

/** An external refund reference: entered by the Super Admin, recorded as entered (never invented). */
const EXTERNAL_REF = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,99}$/
export function parseExternalReference(v: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = typeof v === 'string' ? v.trim() : ''
  return EXTERNAL_REF.test(s)
    ? { ok: true, value: s }
    : { ok: false, error: 'The external refund reference must be 3–100 characters: letters, digits and _ . : / - only.' }
}

/** An optional organizer note: trimmed, ≤ 500 chars. */
export function parseOrganizerNote(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 500) : ''
}

// ── response shapes ─────────────────────────────────────────────────────────────────────────────
export interface ServiceRequestHistoryEntry {
  at:     string
  by:     string
  role:   'organizer' | 'super_admin'
  action: 'submitted' | 'approved' | 'rejected' | 'processed'
  note:   string
}

export interface ServiceRequestView {
  id:            string
  kind:          ServiceRequestKind
  status:        ServiceRequestStatus
  organizerUid:  string
  service:       RequestableService
  quantity:      number
  source:        { draftId: string; name: string; slug?: string | null }
  destination:   { draftId: string; name: string } | null
  /** Requests submitted together ("refund all") share a group id. */
  groupId:       string | null
  /** Refunds only: the cap when submitted (and the lines it came from), and what was approved. */
  refundUpperBoundPaise: number | null
  valuation:     ValuationPart[]
  approvedAmountPaise:   number | null
  externalReference:     string | null
  organizerNote: string
  createdAt:     string | null
  updatedAt:     string | null
  history:       ServiceRequestHistoryEntry[]
  /** RD-INTEG — the Super Admin decision (approve/reject) and the recorded payout, when present. */
  decision?:     { action: 'approved' | 'rejected'; by: string; reason: string; at: string | null } | null
  processed?:    { by: string; reason: string; externalReference: string; at: string | null; refundedAmountPaise: number | null } | null
  /**
   * Refund-history S1 — the 24-hour refund window AS IT WAS when the request was accepted (server
   * snapshot, never recomputed). null for carry-forward and for requests submitted before snapshots
   * existed ("not recorded" — never inferred).
   */
  window:        RefundWindowSnapshot | null
  /** Refund-history S2 — the money actually refunded outside RegisterDesk, recorded with the reference. null until recorded (and on older requests: not recorded — never assumed to equal the approved amount). */
  refundedAmountPaise: number | null
  /** Refund-history S4 — registration-capacity refunds: the event's enforced capacity before / refunded / after, recorded in the approval transaction. */
  capacity:      CapacityRefundRecord | null
}

export interface RefundWindowSnapshot {
  closureAt:             string | null
  deadlineAt:            string | null
  submittedAt:           string
  submittedWithinWindow: boolean | null
}
export interface CapacityRefundRecord { before: number; refunded: number; after: number }

/** Pure — the S1 snapshot for a refund accepted at `submittedMs` against closure `closedAtMs`. */
export function refundWindowSnapshot(closedAtMs: number | null, submittedMs: number): RefundWindowSnapshot {
  const deadline = refundDeadlineMs(closedAtMs)
  return {
    closureAt: closedAtMs === null ? null : new Date(closedAtMs).toISOString(),
    deadlineAt: deadline === null ? null : new Date(deadline).toISOString(),
    submittedAt: new Date(submittedMs).toISOString(),
    submittedWithinWindow: withinRefundWindow(submittedMs, closedAtMs),
  }
}

/** Pure — the S2 rule for the amount recorded as actually refunded. */
export function refundedAmountProblem(refundedPaise: unknown, approvedPaise: number | null): string | null {
  if (typeof refundedPaise !== 'number' || !Number.isInteger(refundedPaise)) return 'Enter the amount actually refunded (whole paise).'
  if (refundedPaise < 0) return 'The refunded amount cannot be negative.'
  if (approvedPaise === null) return 'This request has no approved amount.'
  if (refundedPaise > approvedPaise) return `The refunded amount cannot exceed the approved amount (₹${(approvedPaise / 100).toFixed(2)}).`
  return null
}

export interface EventServiceView {
  state:        ServiceState
  refund:       Eligibility
  carryForward: Eligibility
}

export interface EventRequestsView {
  draftId:  string
  name:     string
  closed:   boolean
  /** D6 — when the event closed and the last instant a refund may be requested (ISO); null when unknown / open. */
  closedAt:       string | null
  refundDeadline: string | null
  /**
   * The SERVER's verdict on the 24-hour window at the time of this read: true = still open, false =
   * closed, null = not applicable (event open) or unknown (closure not recorded). The Wallet shows
   * this, never a browser-clock comparison.
   */
  refundWindowOpen: boolean | null
  services: EventServiceView[]
  destinations: { draftId: string; name: string }[]
  requests: ServiceRequestView[]
}

export const SERVICE_LABEL: Record<RequestableService, string> = {
  registrations: 'Registration capacity', whatsapp: 'WhatsApp messages', certificates: 'Certificates', media: 'Event photos',
  print_badges: 'ID badges',
}
export const SERVICE_UNIT: Record<RequestableService, string> = {
  registrations: 'registrations', whatsapp: 'messages', certificates: 'certificates', media: 'photos',
  print_badges: 'badges',
}

export const REQUEST_KIND_LABEL: Record<ServiceRequestKind, string> = { refund: 'Refund', carry_forward: 'Carry forward' }
/** What each status MEANS — "approved" never means the money has moved. */
export const REQUEST_STATUS_LABEL: Record<ServiceRequestStatus, string> = {
  submitted: 'Awaiting review', approved: 'Approved', rejected: 'Rejected', processed: 'Refunded',
}
export const REQUEST_STATUS_TONE: Record<ServiceRequestStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  submitted: 'warning', approved: 'info', rejected: 'danger', processed: 'success',
}
