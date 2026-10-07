// GET /api/organizer/dashboard
//
// Single aggregation endpoint for the organizer dashboard.
// Runs all Firestore reads in parallel and returns a structured payload.
// Called once on page load; the page derives all sections from this response.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeAnyWorkspace }     from '@/lib/team/workspace'
import { ensureOrganizerProfile }    from '@/lib/organizer/ensureProfile'
import { deriveLifecycleStatus } from '@/lib/events/lifecycle'
import { presentEventStatus } from '@/lib/events/eventContext'
import { isArchivedTabEvent } from '@/lib/events/listingTabs'
import { revenueStateFromCounterMap, toConfirmedRevenueFields } from '@/lib/finance/revenueState'
import {
  readActivityPage, ACTIVITY_PAGE_SIZE,
  type ActivityPage,
} from '@/lib/dashboard/activityFeed'
import { getWalletBalance }          from '@/lib/firebase/firestore/wallet'
import { getLicenseCatalog, getLicenseCatalogV2 } from '@/lib/licensing/resolveCatalog'
import { resolveEventCapacitySummary } from '@/lib/registrations/capacity'
import {
  getLedgerTotals, getAttendeePaid, getRefundTotals,
  type MaybeMoney, type GatewayFeeBasis,
} from '@/lib/finance/financeAnalytics'
import { EVENT_LICENSES_COLLECTION }  from '@/lib/licensing/schema'
import { resolveLicenseEntryForVersion } from '@/lib/licensing/licenseCatalogShared'
import { isUnlimited, isValidTierForVersion } from '@/lib/licensing/eventLicense'
import { EVENT_STATS_VERSION }       from '@/lib/registrations/types'
import type { RegistrationCounter } from '@/lib/registrations/types'
import { aggregateRegistrationStatusCounts, getAttendanceShardSums, sumConfirmedRevenueFromLedgerChecked } from '@/lib/firebase/firestore/registrationCounters'
import type { AttendanceShardSums } from '@/lib/firebase/firestore/registrationCounters'
// RD-DASH-13 · the SHARED counters type is no longer imported here. The dashboard
// resolves its own `EventStatusCounts`, whose `waitlisted` and `total` carry their own
// null and which has no `checkedIn` — see lib/analytics/dashboardAnalytics.
import {
  aggregateCancelledByPass, aggregateWaitlistedCount, aggregateValueByPass,
} from '@/lib/analytics/registrationPassAggregates'
import { getOrganizerCouponPerformance, EMPTY_ORGANIZER_COUPON_PERFORMANCE } from '@/lib/analytics/couponPerformance'
import type { OrganizerCouponPerformance } from '@/lib/analytics/couponPerformance'
import { buildDashboardAnalytics } from '@/lib/analytics/dashboardAnalytics'
import { dayKey, dayKeyRange, buildSeries, resolveCoverage, ALL_EVENTS } from '@/lib/dashboard/dailyStats'
import { readDailyStats, readCoverage } from '@/lib/dashboard/dailyStatsAdmin'
import { readCommunicationUsage } from '@/lib/dashboard/communicationUsageAdmin'
import { buildWorkspaceHealth } from '@/lib/dashboard/workspaceHealth'
import { readBroadcastActivity } from '@/lib/dashboard/broadcastActivityAdmin'
import { resolveCheckInFromCounters } from '@/lib/dashboard/checkInStatusAdmin'
import type { CheckInStatus } from '@/lib/dashboard/checkInStatus'
import type { BroadcastActivity } from '@/lib/dashboard/broadcastActivity'
import type { WorkspaceHealth } from '@/lib/dashboard/workspaceHealth'
import { evaluatePublishRequirements, severityOf } from '@/lib/events/publishRequirements'
import type { CommunicationUsage } from '@/lib/dashboard/communicationUsage'
import {
  buildAttention, buildUpcoming, computeDelta,
  type AttentionSignal, type UpcomingEvent, type Delta, type EventSignalInput,
} from '@/lib/dashboard/insights'
import type {
  DashboardAnalytics, EventPerformanceRow, EventStatusCounts, PassRow, RegistrationTotals, StatusRow,
} from '@/lib/analytics/dashboardAnalytics'
import { resolveOwnedEvents, resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

/**
 * Ceiling on per-pass cancelled aggregates for ONE dashboard load (events × passes).
 *
 * Cancelled-by-pass costs one count() per (event, pass), so an organizer with many events
 * each carrying many passes could otherwise fire hundreds of queries per render. Events with
 * zero cancellations are skipped entirely, so in practice this is rarely approached — and
 * when it is, the affected events report "unavailable" rather than a fabricated zero.
 */
const PASS_AGGREGATE_BUDGET = 120

/**
 * How many EVENTS may have per-pass aggregates in flight at once.
 *
 * Each helper already chunks its own passes 8 at a time, so this multiplies with that:
 * the real ceiling is EVENT_CONCURRENCY × 8 outstanding aggregates. Six keeps that under
 * fifty — enough to collapse the serial chain, not enough to burst the connection pool.
 * The BUDGET, not this number, is what bounds total work; this only bounds concurrency.
 */
const EVENT_CONCURRENCY = 6

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving nothing about order.
 *
 * Order does not need preserving because every caller writes into a Map keyed by slug.
 * What DOES need preserving is which items run at all, and that is decided before this is
 * called — see the budget plan in the handler.
 */
async function mapWithConcurrency<T>(
  items: readonly T[], limit: number, fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

/** Days of history the trend covers. ONE rollup document read per day. */
const TREND_DAYS = 90

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Narrows a query to one event when a slug is given, and leaves it alone when it is not.
 *
 * ONE helper rather than a ternary at each call site: four communication aggregates need the
 * same narrowing, and a hand-written conditional at each is four chances to write
 * `.where('eventSlug','==',null)` — which silently matches nothing — or to forget the
 * narrowing entirely and report workspace send volume under one event's name.
 *
 * Every caller is guarded by `scopedNoSlug` first, so `null` here always means all-events
 * mode and never "scoped to an event that happens to have no slug".
 */
// RD-DASH-06 — `withEventSlug` is gone with its last callers (the communication
// aggregates). Scope narrowing for those now lives in lib/dashboard/communicationUsage,
// beside the queries it applies to.

function tsToDate(ts: unknown): Date | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate()
  }
  return null
}

// RD-DASHBOARD-02 — `isToday` and `ymd` were removed with the 5,000-row scan they
// served. Day bucketing now lives in lib/dashboard/dailyStats (`dayKey`), which uses
// a FIXED reporting offset rather than the server's local zone; these helpers read
// the host clock, so on a UTC serverless host they put every registration after
// 18:30 IST into "tomorrow" and the dashboard disagreed with the organizer's own
// calendar every evening.

// ─── Response types (exported for the page to import) ─────────────────────────

export interface DashboardAlert {
  type:      'nearly_full' | 'comm_payment_pending' | 'cert_missing' | 'reg_closing_soon'
  severity:  'critical' | 'warning'
  title:     string
  meta:      string
  eventSlug: string | null
  /**
   * The event this alert is about, by draft id.
   *
   * The scope filter keys on THIS, not on `eventSlug`: an unpublished event has a null
   * slug, so slug identity would make one draft's alert match every other draft's.
   */
  eventDraftId: string | null
}

export interface DashboardEvent {
  draftId:         string
  name:            string
  slug:            string | null
  registered:      number
  capacity:        number | null
  fillPct:         number
  startDate:       string | null
  lifecycleStatus: string
  reviewStatus:    'rejected' | 'changes_requested' | null
  licenseTier:     string
  bannerUrl:       string | null
  /**
   * RD-ANALYTICS-12-24 · THE CANONICAL NAME for this figure.
   *
   * Canonical confirmed ticket revenue in integer PAISE — the same quantity, source,
   * counter/ledger resolution, status filter, refund behaviour and `transactions` gate that
   * `revenuePaise` has always carried on this contract. Nothing about the calculation moved;
   * only the name did.
   *
   * ═══ WHY THIS NAME, AND WHY ONLY THIS FIELD ════════════════════════════════
   * RD-ANALYTICS-12-23 found that `revenuePaise` is not one concept: the same spelling also
   * names day-attributed rollup revenue, windowed period revenue in Analytics, and platform
   * LICENCE income in Admin — money flowing the other way. Exactly one of them, this one, is
   * the quantity `/api/organizer/events` calls `confirmedRevenuePaise`. So this field
   * converges and the others deliberately do not.
   *
   * Null when the caller holds no `transactions` permission. Never a zeroed figure.
   */
  confirmedRevenuePaise: number | null
  /**
   * RD-ANALYTICS-12-21 (F1) · the revenue figure could not be READ for this event, so its `0`
   * is a placeholder rather than a measurement. Absent/false ⇒ the number is real.
   *
   * The same additive flag `/api/organizer/events` has carried since RD-EVENT-02, and the
   * same rule: a reader that ignores it is no worse off than before, one that checks it is
   * correct. It is derived from the same `RevenueState` as the figure it qualifies, so the
   * two cannot disagree.
   */
  revenueUnavailable?: boolean
}

export interface DashboardTransaction {
  id:           string
  type:         string
  amountPaise:  number
  balancePaise: number
  description:  string
  createdAt:    string | null
}

export interface DashboardActionEvent {
  draftId:         string
  name:            string
  slug:            string | null
  lifecycleStatus: string
  reviewStatus:    'rejected' | 'changes_requested' | null
}

export interface DashboardActivity {
  type:          'registration' | 'checkin'
  /**
   * The registration this activity happened to.
   *
   * Carried so the client has a STABLE key and a real destination. The feed previously
   * keyed rows on their array index, which changes whenever the sort settles differently —
   * React then reuses the wrong row's DOM on a refresh.
   *
   * One registration legitimately produces TWO activities (registered, then checked in),
   * so identity is `type + sourceId`, never `sourceId` alone.
   */
  sourceId:      string
  /**
   * RD-ANALYTICS-12-17 · `null` when the caller holds neither `registrations` nor
   * `transactions`.
   *
   * RD-DASH-12 removed `attendeeEmail` from this row for a neighbouring reason — it was
   * `sensitive: true` and reached a role with no `registrations` grant — and deliberately
   * kept the name, which `lib/metadata/registry.ts` does not class sensitive. This does not
   * reverse that: it puts the name behind the union of the two permissions that already
   * grant attendee names elsewhere, so no role loses it today and a future role cannot
   * inherit it by default.
   */
  attendeeName:  string | null
  // RD-DASH-12 · removed. See lib/dashboard/activityFeed — read, shipped, never rendered.
  /** Stable event identity. The NAME is for display; this is what scoping compares. */
  eventSlug:     string
  eventName:     string
  passName:      string
  timestamp:     string   // ISO 8601
}

/**
 * RD-DASHBOARD-02 · Finance permission gating.
 *
 * ═══ WHY MONEY IS OMITTED, NOT ZEROED ════════════════════════════════════════
 * This endpoint authorizes with `authorizeAnyWorkspace`, which requires NO specific
 * permission — every non-gate member of the workspace reaches it. But the payload
 * carried gross revenue, platform fees, net payout, wallet balance and recent wallet
 * transactions, so an `admin` or `manager` — neither of whom holds `transactions`,
 * `wallet` or `settlements`, and both of whom `/api/organizer/finance` refuses — read
 * the same headline money here. Two endpoints, one data class, two answers.
 *
 * The fix is server-side and structural: when the caller lacks the permission the
 * fields are ABSENT from the response, not zeroed. `₹0` is a lie that looks like a
 * fact; a missing field lets the UI say "not available to your role", which is true.
 */
export interface FinanceGate {
  /** True when the caller may see money. Mirrors the `transactions` permission. */
  allowed: boolean
}

/**
 * RD-DASHBOARD-05 · What this payload is scoped to.
 *
 * The client renders the scope, so a number can never appear under the wrong heading.
 *
 * ═══ WHAT CANNOT BE EVENT-SCOPED, AND WHY ════════════════════════════════════
 * Three sections stay workspace-level even in event mode, because the underlying
 * record IS the workspace and no honest per-event value exists:
 *
 *   • wallet / settlement — ONE `organizerRevenueWallets/{uid}` doc per organizer.
 *     Ticket revenue is per-event and IS scoped; the wallet balance and payout
 *     position are not divisible by event.
 *   • communications — the counts come from indexed aggregates keyed on
 *     organizerUid + status + createdAt. `emailLogs` does carry `eventSlug`, but the
 *     composite index for (organizerUid + eventSlug + status + createdAt) does not
 *     exist, so scoping it today would silently drop to an unindexed query.
 *   • workspace health / pending review — properties of the workspace, not an event.
 *
 * They are flagged rather than quietly mixed in. Pretending a workspace figure is an
 * event figure is precisely the defect this scope work removes.
 */
export interface DashboardScope {
  /** 'all' = every authorized event. 'event' = the selected event only. */
  mode:      'all' | 'event'
  /** Draft id of the selected event, echoed back so the client can verify. */
  eventId:   string | null
  eventSlug: string | null
  eventName: string | null
  /**
   * Derived lifecycle of the selected event ('draft', 'published', 'completed', …).
   * Null in all-events mode.
   */
  /**
   * The event's OWN configured taxonomy ids, straight from the draft the Create Event
   * wizard wrote. Ids, not labels: the client maps them through lib/events/taxonomy.ts,
   * which is the same catalog the wizard's picker renders from.
   *
   * Null when the event has none. The header then shows no category rather than guessing
   * one — an invented "Sports → Running" is worse than an absent line.
   */
  eventType:      string | null
  eventSubtype:   string | null
  /** The organizer's free-text subtype when they chose "Other". */
  eventCustomSubtype: string | null
  eventLifecycle: string | null
  /**
   * False when the selected event has never been published.
   *
   * ═══ WHY THIS IS A STATE AND NOT AN ERROR ══════════════════════════════════
   * The Event Selector lists every draft the organizer owns, so a draft is selectable and
   * must therefore be servable — an organizer whose only event is a draft would otherwise
   * meet a hard failure on their own dashboard.
   *
   * The zeros that come back are TRUE, not a fallback: with no public slug there is no
   * registration page, no counter document, no rollup row and no email log, so nothing can
   * have happened. This flag exists so the UI can say WHY the page is empty instead of
   * presenting "0 registrations · ₹0" as a business result.
   */
  eventPublished: boolean
  /**
   * Sections in THIS payload that remain workspace-level despite event mode.
   * The UI labels each one; it must not present them as event figures.
   */
  workspaceOnly: string[]
}

/**
 * RD-DASHBOARD-08 · The organizer's REGISTRATION ENTITLEMENT, from the license model.
 *
 * ═══ THIS IS NOT EVENT CAPACITY ══════════════════════════════════════════════
 * Two different ceilings that a dashboard must never merge:
 *
 *   • EVENT CAPACITY — `eventDetails.capacity.totalCapacity`, how many seats the
 *     organizer decided to sell. A product decision, editable at will.
 *   • LICENSE ENTITLEMENT — how many registrations the PURCHASED PLAN permits. A
 *     commercial ceiling, changed only by buying an upgrade.
 *
 * An event can be sold out (capacity) with plenty of entitlement left, or blocked by the
 * plan (entitlement) while seats remain. Showing one under the other's name would tell the
 * organizer to do the wrong thing, so this object carries ONLY the license figure.
 *
 * Source: `eventLicenses/{slug}` resolved against the effective (config-aware) catalog for
 * the license's own stored version — the SAME resolution /api/organizer/licenses uses, so
 * the dashboard and the billing page can never disagree. Nothing here is hardcoded.
 */
export interface DashboardLicense {
  /** 'event' = the selected event's own license. 'workspace' = every active license. */
  scope:     'event' | 'workspace'
  /** Plan id and its display name, from the catalog. */
  tier:      string
  tierName:  string
  status:    string
  /** Confirmed registrations counted against the entitlement. */
  used:      number
  /** Null means UNLIMITED — the client must not invent a denominator. */
  limit:     number | null
  remaining: number | null
  /** Null when the plan is unlimited; there is no percentage of infinity. */
  percentUsed: number | null
  /** The next tier up, when one exists. Absent ⇒ no upgrade to offer. */
  upgrade:   { tier: string; name: string } | null
  expiresAt: string | null
  /** Workspace scope only: how many licensed events this aggregates. */
  eventCount: number
  /**
   * The license could not be read, or the selected event has none.
   *
   * Rendered as an honest "unavailable" state — never as 0 used of 0, which would read as
   * a plan with no entitlement rather than an unknown one.
   */
  unavailable: boolean
}

/**
 * RD-DASHBOARD-12 · Fees and payout, from the per-transaction ledger.
 *
 * ═══ EVERY FIELD IS RECORDED, NONE IS ESTIMATED AT RENDER ════════════════════
 * `platformTransactions` stores what each payment actually cost, written at capture time.
 * This aggregates those rows — count + sum, no documents transferred — through
 * `getLedgerTotals`, the Finance module's own resolver. The dashboard therefore cannot
 * disagree with /dashboard/finance, and no percentage is applied to anything here.
 *
 * ═══ ACTUAL GATEWAY FEE, AND WHY THE BASIS TRAVELS WITH IT ═══════════════════
 * `gatewayFeeActualPaise` is written from the payment.captured webhook, so new payments
 * carry what the gateway really charged. Historical rows predate that writer and carry
 * only the recorded ESTIMATE (0 of 775 reconciled on the reference event at the time of
 * writing), and a backfill is a separate, approved migration.
 *
 * A workspace therefore sits in one of three states, and `gatewayBasis` names which:
 * fully reconciled, fully estimated, or MIXED. `gatewayFeePaise` resolves per
 * transaction — actual where recorded, estimate elsewhere — so the figure is right in
 * all three, and the label prevents an estimate from ever reading as a settled fact.
 *
 * The tax rides along as a COMPONENT of the fee, never as a sibling charge: Razorpay
 * reports amount − fee = credit, so adding tax to fee would double-count it.
 */
export interface DashboardFees {
  /** 'event' when a single event is selected, else the whole authorized workspace. */
  scope:            'event' | 'workspace'
  /** Settlement basis — what the organizer is owed. */
  netPayoutPaise:   number | null
  /** RegisterDesk's fee, base + GST, as charged. */
  platformFeePaise: number | null
  /** Recorded ESTIMATE of the gateway's cut. Kept for comparison, never the headline. */
  gatewayEstimatePaise: number | null
  /** Gateway money actually charged, over the rows that carry it. Null = none do. */
  gatewayActualPaise:   number | null
  /**
   * THE gateway figure to display: per-transaction actual where recorded, estimate
   * elsewhere. Read this with `gatewayBasis`, never on its own.
   *
   * ⚠ TAX-INCLUSIVE. `gatewayTaxPaise` is the GST inside this number, not beside it.
   */
  gatewayFeePaise:  number | null
  /** What `gatewayFeePaise` is made of. The client must never infer this itself. */
  gatewayBasis:     'actual' | 'estimated' | 'mixed'
  /** GST CONTAINED WITHIN `gatewayFeePaise`. Adding the two double-counts the tax. */
  gatewayTaxPaise:  number | null
  /** Transactions carrying an actual gateway fact, out of those in scope. */
  gatewayCoverage:  { withActual: number | null; total: number | null }
  /**
   * platformFee + gatewayFee — an AGGREGATE published beside its two components, never
   * instead of them. RegisterDesk and Razorpay are different companies charging
   * different fees; a single blended number would misrepresent both.
   */
  totalFeesPaise:   number | null
  transactions:     number | null
  /** True when the ledger read failed — the UI must say so rather than show zeros. */
  unavailable:      boolean
}

/**
 * Money that did NOT stay: cancellations and refunds, which are different things.
 *
 * CANCELLED is the ticket value of registrations whose status is 'cancelled' — summed
 * from the amounts actually on those registrations, never `count × current pass price`,
 * which would drift the moment a price changed.
 *
 * REFUNDED is money returned through the gateway (`refundAmount`). A cancellation does not
 * imply a refund and a refund does not imply a cancellation, so they are never merged.
 */
export interface DashboardReversals {
  /**
   * How many registrations are cancelled — a registration STATUS, which is why it is shown
   * on Total Registrations and not beside revenue.
   *
   * Derived from `registrationCounters.cancelledCount`, already read for this dashboard, so
   * it costs nothing. The cancelled VALUE is deliberately absent: no card renders it, and
   * measuring it needs two sum() aggregates plus four composite indexes. Cancellation money
   * belongs to Finance and will come from that module's own sources.
   */
  cancelledCount: number
}

/**
 * RD-DASH-02 · the Finance Summary payload.
 *
 * ═══ EVERY FIGURE IS RESOLVED SERVER-SIDE, NONE IS DERIVED ═══════════════════
 * The previous shape carried three numbers and the card arranged them into a fourth.
 * `platformFeePaise` was `gross − netSettlement`, which under an attendee-pays model is
 * ZERO by construction — the attendee bore the fees, so the organizer receives the full
 * gross and the subtraction has nothing to find. A real event charged thousands of rupees in
 * platform fees and the card said ₹0.
 *
 * Each field below now comes from the resolver that owns it, and the two fee families
 * stay apart: RegisterDesk charged the platform fee, Razorpay charged the gateway fee,
 * and the tax is a component INSIDE the gateway fee rather than a fifth charge.
 *
 * `null` means "could not be measured" and must render as an em dash, never as ₹0.
 */
export type CommunicationCostScope = 'workspace' | 'event'

export interface DashboardSettlement {
  /** RD-FIN-02 · the population every figure on the card covers. */
  scope:                  'event' | 'workspace_lifetime'
  /** What attendees were actually charged, from the registration ledger population. */
  attendeePaidPaise:      number | null
  /** Ticket value after discount — the basis the platform fee was charged on. */
  ticketValuePaise:       number | null

  /** RegisterDesk's fee, before its GST. */
  platformFeeBasePaise:   number | null
  /** GST on the RegisterDesk platform fee. */
  platformFeeGstPaise:    number | null
  /** platformFeeBase + platformFeeGst. Contains nothing the GATEWAY charged. */
  platformFeeTotalPaise:  number | null

  /** Gateway fee: actual where reconciled, recorded estimate elsewhere. TAX-INCLUSIVE. */
  gatewayFeePaise:        number | null
  /** GST CONTAINED WITHIN `gatewayFeePaise`. Adding the two double-counts the tax. */
  gatewayTaxPaise:        number | null
  /** What `gatewayFeePaise` is made of. The client renders this, it never infers it. */
  gatewayFeeBasis:        GatewayFeeBasis

  /** platformFeeTotal + gatewayFee. An aggregate, published beside its components. */
  totalFeesPaise:         number | null

  /** Money returned through the gateway, including refunds nobody could attribute. */
  refundsPaise:           number | null
  refundCount:            number | null

  /** The stored settlement basis. Never gross minus fees. */
  organizerPayablePaise:  number | null

  /** Communication billing — a separate wallet, never mixed into the figures above. */
  communicationCostPaise: number
  /**
   * Whether the figure above covers the workspace or the selected event. Billing is
   * recorded per DRAFT with no event-scoped rollup, so today it is always workspace —
   * stated rather than quietly presented as the selected event’s spend.
   */
  communicationCostScope: CommunicationCostScope
}

/**
 * RD-DASH-13 §4 · one trend window, RESOLVED.
 *
 * The panel used to slice `trendDays` and reduce it — twice, once for the window and once
 * for the window before it — then call `computeDelta` on the result. Those are business
 * totals and a business percentage, computed in a component from a series that had
 * travelled over the wire for charting.
 *
 * The server runs the SAME `computeDelta` over the SAME rollup rows, so every figure is
 * identical; the range toggle stays client-side because which window to look at is a UI
 * question, and all three are pre-resolved.
 */
export interface DashboardTrendRange {
  /** 7 / 30 / 90 — the windows the panel offers. */
  days:  number
  /** Σ confirmed registrations in the window, and the change vs the window before it. */
  registrations: { total: number; delta: Delta }
  /** Absent when `finance.allowed` is false — never zeroed. */
  revenue?: { totalPaise: number; delta: Delta }
}

export interface DashboardData {
  scope: DashboardScope
  /**
   * RD-DASH-12 · GATED. Absent — not zeroed — for a caller without `transactions`.
   *
   * This was a REQUIRED field, so every role that can open the dashboard received the
   * organizer payable, both fee families, the gateway tax and the transaction count, and
   * the Fees & payout tile rendered them. `admin` and `manager` hold no finance
   * permission, and the settlement card beside this one was correctly refusing them the
   * same numbers. Measured against production during the RD-DASH-12 audit: the full
   * payout position was disclosed to a role that cannot open /dashboard/finance.
   * (The figures themselves live in tests/unit/dashboardMoneyGate.test.ts — this file is
   * guarded against carrying real totals.)
   */
  fees?:     DashboardFees
  reversals: DashboardReversals
  /** Absent only when the licence read itself threw; see `unavailable` for the normal gap. */
  license: DashboardLicense
  organizer: {
    name:    string
    orgName: string
    logoUrl: string | null
  }
  finance: FinanceGate
  overview: {
    activeEvents:       number
    totalRegistrations: number
    /** Absent when `finance.allowed` is false, null when unmeasured — never 0. */
    totalRevenuePaise?:  number | null
    todayRevenuePaise?:  number | null
    todayRegistrations: number
    /** RD-DASH-13 · null ⇒ the count could not be read. NEVER 0 on failure. */
    todayCheckins:      number | null
    /**
     * RD-DASH-13 §4 · today's check-ins as a share of all registrations.
     *
     * The page computed `Math.round((todayCheckins / totalRegistrations) * 100)` itself —
     * a check-in rate derived in React. It also had to special-case a non-zero count that
     * rounds to 0%. Both decisions belong beside the numerator, so both moved here.
     * null ⇒ no denominator, or the count itself is unavailable.
     */
    todayCheckinShare:  number | null
    monthRevenuePaise?:  number   // current calendar month-to-date (confirmed)
    monthRegistrations: number   // current calendar month-to-date (confirmed)
  }
  /**
   * RD-DASHBOARD-02 · Trend integrity.
   *
   * `trendUnavailable` — the rollups could not be read. The client must render the
   * trend as a failure with retry, NEVER as a flat line of zeros.
   *
   * `historySince` / `historyPartial` — how far back the rollups can be trusted. A
   * range extending before `historySince` is INCOMPLETE, and the client must disclose
   * that rather than draw the uncovered days as zero activity. This is the same class
   * of honesty the capped 5,000-row window never had.
   */
  trendUnavailable: boolean
  historySince:     string | null
  historyPartial:   boolean
  /** Deterministic attention signals — see lib/dashboard/insights.ts. */
  attention:        AttentionSignal[]
  /** Next events by start date, with capacity and days remaining. */
  upcoming:         UpcomingEvent[]
  /** Period-over-period change for the headline figures. */
  deltas: {
    registrations: Delta
    revenue?:      Delta   // absent when finance is gated
  }
  // RD-DASHBOARD-02 — the standalone `alerts` array is RETIRED from the response.
  //
  // It duplicated `attention`: nearly_full and reg_closing_soon are the same rules
  // buildAttention already expresses deterministically. Its two UNIQUE signals
  // (cert_missing, comm_payment_pending) are merged into `attention` rather than
  // dropped, so no working warning was lost — see the merge above. Emitting both
  // arrays would have put the same warning on screen twice under two headings.
  /** Absent entirely when `finance.allowed` is false — see FinanceGate. */
  settlement?: DashboardSettlement
  /** PAGE ONE of the feed — ten rows. Later pages come from /dashboard/activity. */
  activity:   DashboardActivity[]
  /**
   * Paging state for `activity`.
   *
   * There is no total: an exact one needs count() over both streams, and the check-in
   * count is not served by any deployed index. The feed reports the page it is on and
   * whether another exists rather than inventing a denominator.
   */
  activityPage: {
    pageSize:   number
    hasMore:    boolean
    nextCursor: string | null
    /** False when scope had to be applied in memory, so `hasMore` is best-effort. */
    exact:      boolean
    /** RD-DASH-15 · page one could not be read. The card says so instead of "no activity". */
    unavailable: boolean
  }
  /**
   * How many feed rows were unreadable and therefore skipped.
   *
   * Present so a SHORTER list can be explained rather than silently presented as the
   * whole truth. 0 in every healthy workspace.
   */
  activitySkipped?: number
  events:     DashboardEvent[]
  /** RD-PREPROD · revenuePaise is null for a caller without the 'transactions' permission (money gate). */
  trendDays:  { date: string; count: number; revenuePaise: number | null }[]   // 90 entries, oldest → newest
  /**
   * RD-DASH-13 §4 · the 7/30/90 windows with their totals and deltas already resolved.
   *
   * `trendDays` remains, because the chart genuinely needs the per-day series to draw bars.
   * What it no longer carries is the expectation that the component will reduce it into
   * business figures.
   */
  trendRanges: DashboardTrendRange[]
  // Organizer-wide, ALL-TIME breakdowns — derived from the registrationCounters documents
  // this route already fetches, NOT from the 90-day recent window. No extra Firestore reads
  // in the healthy case. Empty ⇒ charts degrade.
  /** Confirmed + cancelled per pass, + Other / Unassigned / Unattributed. `count` is the
   *  CONFIRMED figure, kept under that name so the bar chart and insights are unchanged. */
  passDistribution:   PassRow[]
  /** Organizer-wide, all-time, by status — each row with its share already resolved. */
  registrationStatus: StatusRow[]
  /** RD-DASH-13 §4 · Pass Distribution footer figures, summed over EVERY pass. */
  passTotals: { confirmed: number; cancelled: number; salesPaise: number | null }
  /** RD-DASH-13 · true when a waitlist count could not be read for an event in scope. */
  waitlistUnavailable: boolean
  /** Every status total, so the card can show counts AND percentages from one source. */
  registrationTotals: RegistrationTotals
  /** True when at least one event's counts could not be read. The client must NOT render
   *  these two charts as authoritative zeros when this is set. */
  analyticsUnavailable?: boolean
  /** False when no event in scope has configured passes — see DashboardAnalytics. */
  passDataAvailable:        boolean
  /** Per-pass ticket value could not be measured — render nothing, never ₹0. */
  passValueUnavailable:     boolean
  /** True when a per-pass cancelled split could not be completed for some event with
   *  cancellations. The client must hide the cancelled column rather than show zeros. */
  passCancelledUnavailable?: boolean
  /** Registered per event, SAME event scope and SAME confirmed figure as the two breakdowns
   *  above, Top-N with a real remainder row. RD-DASH-10 gave each row its SLUG (two events may
   *  share a name) and its resolved state. */
  eventPerformance:   EventPerformanceRow[]
  /** Comparison facts computed server-side, so no surface sums its own rows. */
  eventPerformanceMeta: DashboardAnalytics['eventPerformanceMeta']
  /**
   * RD-DASH-06 — every figure is `number | null`, and null means UNREAD, never zero.
   *
   * The shape changed because the old one could not tell the truth. It carried
   * `emailsSent` (which counted registrations), `emailsSentToday` (which counted
   * "handed to a provider" under the word "delivered"), and `whatsappSent` (a literal
   * 0 that was never queried). See lib/dashboard/communicationUsage for the full audit.
   */
  /**
   * RD-DASH-09 — the campaigns themselves, one row each.
   *
   * Deliberately separate from `communications`: that field answers HOW MUCH was sent,
   * this one answers WHAT was sent. Merging them would put a five-row list inside a card
   * whose whole job is totals.
   */
  broadcasts: BroadcastActivity
  /**
   * RD-DASH-11A · gate progress for the SELECTED event.
   *
   * Folded from the attendance shards, which is where check-in writes actually go — the
   * base counter's `checkedInCount` reads 0 against 288 real check-ins on the audited
   * event, and this is the field that must never be read for this figure again.
   */
  checkIn: CheckInStatus
  communications: CommunicationUsage & {
    /** Communication wallet spend. A BILLING figure — never mixed with the counts above. */
    costPaise: number
  }
  /**
   * RD-DASH-08 — replaces `healthScore`, which was `round(done / 6 * 100)` over six
   * equally-weighted checklist items. RegisterDesk has no authoritative health-scoring
   * model, so those weights were invented; a percentage implies a model that does not
   * exist. What ships now is a STATE plus the checks it was derived from.
   */
  workspaceHealth: WorkspaceHealth
  /** Both absent when `finance.allowed` is false — never zeroed. */
  walletBalancePaise?:  number
  recentTransactions?:  DashboardTransaction[]
  licenseSummary: {
    pendingApproval:  number
    changesRequested: number
    published:        number
    rejected:         number
  }
  actionEvents:        DashboardActionEvent[]
  /**
   * Coupon performance across the organizer's events. Derived from the coupon documents
   * plus ONE sum() aggregate — never a registration scan — so it is exact regardless of how
   * many registrations exist. `partial` is true when the event budget was reached.
   */
  couponPerformance:   OrganizerCouponPerformance
}

// ─── Organizer event enumeration ──────────────────────────────────────────────
// RD-DASHBOARD-01 Phase 4 (H4): enumerate the organizer's ENTIRE eventDrafts
// collection deterministically, removing the former .limit(500) correctness ceiling
// that silently dropped an organizer's 501st+ event from every derived total.
//
// It keeps the EXACT query the dashboard already used — orderBy('updatedAt','desc'),
// same single-field index — and simply pages through it with a DocumentSnapshot cursor
// (startAfter) until the collection is exhausted. Because the ordering field and its
// implicit __name__ tiebreak are unchanged, the returned sequence is byte-for-byte the
// same order the old single page produced (a draft missing updatedAt was excluded then
// and still is), so downstream ordering (alerts, event cards, the action list) and every
// derived count/sum are identical for organizers within the old 500-event window. Larger
// organizers are simply no longer truncated. No new index, no second event source; reads
// stay bounded to PAGE_SIZE per round-trip.
const DRAFTS_PAGE_SIZE = 500
async function fetchAllOrganizerDrafts(
  uid: string,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const col = adminDb.collection(`users/${uid}/eventDrafts`)
  const docs: FirebaseFirestore.QueryDocumentSnapshot[] = []
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
  for (;;) {
    let q = col.orderBy('updatedAt', 'desc').limit(DRAFTS_PAGE_SIZE)
    if (cursor) q = q.startAfter(cursor)
    const page = await q.get()
    docs.push(...page.docs)
    // A short page means the collection is exhausted (a full page continues).
    if (page.size < DRAFTS_PAGE_SIZE) break
    cursor = page.docs[page.docs.length - 1]
  }
  return docs
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid
  // The same permission /api/organizer/finance requires, so the two endpoints agree about
  // who may see money. Declared here because it now gates the finance READS themselves —
  // an unauthorized caller must not cost the workspace those queries either.
  const financeAllowed = authz.permissions.includes('transactions')

  // ── Batch 1: four parallel root fetches ────────────────────────────────────
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  // EA-2 S1: the former UNBOUNDED all-time registrations scan is gone. All-time
  // totals + revenue now come from the per-event statistics docs (batch 2). What
  // still needs per-registration rows — the 90-day trend, today's numbers and the
  // activity feed — is served by a BOUNDED recent window; the two refund-sensitive
  // / all-time scalar figures (settlement gross, emails sent, today's check-ins)
  // are served by indexed aggregates that transfer no documents.
  // RD-DASHBOARD-01 Phase 3 (H3): the last two unbounded scans — today's emailLogs
  // and all sent/partial broadcastCampaigns — are now indexed count()/sum() aggregates
  // too. Every batch-1 read is now a document lookup, an aggregate, or a bounded query.
  const cutoff90         = new Date(Date.now() - 90 * 86_400_000)


  /**
   * Registration statuses whose `amount` counts as "what attendees paid".
   *
   * The SAME set /dashboard/finance uses, so the two surfaces measure one population.
   * Cancelled is included because the attendee was charged; whether any of it came back
   * is what the separate Refunds figure answers.
   */
  const ATTENDEE_PAID_STATUSES = ['confirmed', 'cancelled'] as const
  const regsCol          = adminDb.collection('registrations')

  // ═══ RD-DASHBOARD-05 · SELECTED-EVENT SCOPE ════════════════════════════════
  // The global Event Selector is the single source of truth, and it reaches the
  // server as `?eventId=`. Absent ⇒ ALL EVENTS mode.
  //
  // Ownership is proven by the PATH — `users/{workspaceUid}/eventDrafts/{eventId}`.
  // An event the workspace does not own simply does not exist there, so a forged id
  // cannot widen the result set. This is the canonical pattern the rest of the
  // platform uses, and it doubles as the authorization check.
  //
  // A bad id REFUSES. It must never fall back to "some event": showing another
  // event's numbers under the requested event's name is the exact defect this scope
  // work exists to remove.
  //
  // ═══ A DRAFT IS SELECTABLE, SO A DRAFT MUST BE SERVABLE ════════════════════
  // The Event Selector loads /api/organizer/events with NO tab filter, so it lists every
  // draft the organizer owns, and `presentEventStatus` has a dedicated "Draft" branch to
  // render them. An organizer whose only event is a draft would therefore select it and be
  // answered with a hard failure — the dashboard refusing the one event they have.
  //
  // So an unpublished event is now a SCOPE STATE, not an error. It scopes to that event
  // and reports zeros, and those zeros are the TRUTH rather than a fallback: with no public
  // slug there is no registration page, no counter document and no rollup row, so nothing
  // can have happened. `eventPublished: false` travels with the payload so the UI states
  // WHY it is empty instead of presenting "0 registrations" as a business result.
  const requestedEventId = req.nextUrl.searchParams.get('eventId')?.trim() || null
  let selectedSlug: string | null = null
  let selectedName: string | null = null
  /** True when the selection is an event that has never been published (no public slug). */
  let selectedUnpublished = false
  let selectedLifecycle: string | null = null
  let selectedType:      string | null = null
  let selectedSubtype:   string | null = null
  let selectedCustomSub: string | null = null

  // ═══ RD-DASH-12 · THE ID IS A DOCUMENT NAME, SO IT MUST LOOK LIKE ONE ══════
  // `adminDb.doc()` builds a path by concatenation. A value containing `/` therefore
  // changes the SHAPE of the path, and an odd segment count made the SDK throw before any
  // catch — one query parameter, and the whole endpoint answered 500 instead of 404.
  //
  // Not a traversal: this was tested against production and Firestore rejects `..` as a
  // literal, invalid segment (INVALID_ARGUMENT) rather than normalising it, so no crafted
  // id ever reached another workspace. The defect is the unhandled error, not an escape —
  // and the fix is to refuse a malformed id the same way an unknown one is refused, so
  // both answer with the same status and neither reveals which it was.
  //
  // The test is FIRESTORE'S OWN document-id rule, not a tighter allowlist of our own: a
  // narrower pattern would refuse a legitimate id the platform had already issued, turning
  // a 500 into a 404 for a real event. An id may not contain `/`, may not be `.` or `..`,
  // may not match `__.*__`, and is capped at 1500 bytes.
  const validDocId = (id: string) =>
    id.length > 0 && id.length <= 1500 && !id.includes('/')
    && id !== '.' && id !== '..' && !/^__.*__$/.test(id)

  if (requestedEventId !== null && !validDocId(requestedEventId)) {
    return NextResponse.json(
      { error: 'This event is not available in your workspace.', code: 'EVENT_NOT_IN_WORKSPACE' },
      { status: 404 },
    )
  }

  if (requestedEventId) {
    const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${requestedEventId}`).get()
    if (!draftSnap.exists) {
      return NextResponse.json(
        { error: 'This event is not available in your workspace.', code: 'EVENT_NOT_IN_WORKSPACE' },
        { status: 404 },
      )
    }
    const d       = draftSnap.data() as Record<string, unknown>
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info as Record<string, unknown>) ?? {}
    // RD-CE-FIX C1 · only a slug the live document proves is THIS workspace's event for THIS draft —
    // the pointer is client-writable and every counter/revenue/coupon read below is keyed by it.
    selectedSlug  = await resolveOwnedEventSlug(uid, requestedEventId, d)
    selectedName  = typeof info.name === 'string' ? info.name : 'Untitled Event'
    selectedLifecycle   = deriveLifecycleStatus(d)
    selectedUnpublished = selectedSlug === null
    // Straight off the draft the wizard wrote. Top-level fields, not nested under
    // eventDetails — that is where Step 1 stores them.
    selectedType      = typeof d.eventType === 'string' && d.eventType ? d.eventType : null
    selectedSubtype   = typeof d.eventSubtype === 'string' && d.eventSubtype ? d.eventSubtype : null
    selectedCustomSub = typeof d.customEventSubtype === 'string' && d.customEventSubtype.trim()
      ? d.customEventSubtype.trim() : null
  }

  /**
   * True when every event-scoped widget must filter to one event.
   *
   * Driven by the REQUESTED id, not by the slug: an unpublished event has no slug, and
   * keying off the slug would silently drop it back to workspace mode — a workspace total
   * under one draft's name, which is precisely the defect this parameter exists to prevent.
   */
  const scoped = requestedEventId !== null
  /**
   * Scoped to an event that owns no counters, no rollups and no registrations.
   *
   * Every read keyed on the slug is SKIPPED rather than run with a null — saving the read
   * and, more importantly, making it impossible for a null filter to fall through to a
   * workspace-wide query.
   */
  const scopedNoSlug = scoped && selectedUnpublished

  // RD-DASHBOARD-02 — the rollup window. 90 deterministic document ids in ONE getAll,
  // so the trend costs 90 reads regardless of registration volume.
  const nowMs      = Date.now()
  const trendKeys  = dayKeyRange(nowMs, TREND_DAYS)

  const [
    draftDocs, profileSnap,
    commUsage, broadcasts,
    walletBalancePaise, todayCheckinsAgg,
    dailySeriesResult, coverageSince,
  ] = await Promise.all([
    // RD-DASHBOARD-01 Phase 4 (H4): complete, deterministic enumeration of the
    // organizer's events (replaces the former .limit(500) ceiling). Same order/index
    // as before, just uncapped — see fetchAllOrganizerDrafts. Still one entry in this
    // parallel batch; internally it pages with a cursor, bounded per round-trip.
    fetchAllOrganizerDrafts(uid),
    // RD-DASH-03: the two activity-feed queries that lived here are GONE. The feed is read
    // by lib/dashboard/activityFeed, which fetches ONE page — so the dashboard no longer
    // transfers 60 registration documents on every load to render ten rows, and the paging
    // endpoint cannot drift from page 1 in its scope, window or tie-break.
    adminDb.collection('users').doc(uid).get(),
    // ═══ RD-DASH-06 · COMMUNICATION USAGE ══════════════════════════════════
    // THREE aggregates became ONE call to a dedicated reader, and the reason is that all
    // three were reporting zeros that were not zeros:
    //
    //   • Both today-window email counts required a composite index on
    //     (organizerUid, status, createdAt) that is DECLARED but not deployed. Every load
    //     hit FAILED_PRECONDITION, the .catch swallowed it, and `?? 0` printed "0" — for
    //     a workspace with 15,179 logged communications.
    //   • The campaign aggregate combined count() and sum('successCount'). An aggregation
    //     index must carry the SUMMED field, and (organizerUid, status, successCount) was
    //     never declared — so the missing index for "recipients reached" also zeroed the
    //     campaign COUNT. The organizer had sent 50.
    //
    // The reader runs only index-backed queries that were VERIFIED against production, and
    // resolves each figure to null rather than 0 when its read fails. An unpublished event
    // has no logs to read, so it is a genuine empty rather than a skipped query.
    readCommunicationUsage(uid, { scoped, slug: selectedSlug }),
    // RD-DASH-09 — ONE query, limit 6, ordered by send time. Same scope intention as the
    // usage read above, so the two communication cards can never disagree about which
    // event they are describing.
    readBroadcastActivity(uid, { scoped, slug: selectedSlug }),
    getWalletBalance(uid),
    // RD-DASH-13 §3A · the `walletTransactions` read is GONE. It fetched 12 documents on
    // every load to populate `recentTransactions`, which a repo-wide search found is
    // rendered by nothing — not by /dashboard, not by /welcome (the only other consumer
    // of this endpoint), and `DashboardTransaction` had no importer outside this file.
    // The wallet BALANCE is still read; it is on screen.
    // RD-DASH-02: the revenue-wallet read is GONE. It supplied the settlement card’s
    // gross / fees / net in all-events mode, but the wallet stores fees as the same
    // gross-minus-net subtraction — materialised, and therefore ₹0 under attendee-pays.
    // Both modes now read `getLedgerTotals`, which this route already calls, so the card
    // and the Fees & Payout tile cannot disagree and one document read is saved.
    // RD-DASH-06 — the read that fed "Emails sent" is GONE. It counted REGISTRATIONS whose
    // `emailStatus` field said 'sent' — one per registration, confirmation mail only. Under
    // the label "Emails sent" that figure excluded every reminder, every broadcast and every
    // WhatsApp message, and tracked the registration count rather than the send volume: on
    // the audited event it read 2,328 against 15,072 communications actually logged. Send
    // volume now comes from emailLogs, which is what records a send.
    // Today's check-ins — one indexed count (accurate regardless of volume).
    //
    // ═══ RD-DASH-13 · MEASURED ZERO AND FAILED READ ARE DIFFERENT ═════════════
    // This resolved to `null` for BOTH, and the consumer wrote `?? 0`. An unpublished
    // event genuinely has no check-ins (no slug ⇒ no registrations can carry one), but a
    // FAILED aggregate is not a zero — and the tile said "0 · No check-ins yet today"
    // either way. The two cases now carry different shapes and only one of them is a
    // number.
    scopedNoSlug
      ? Promise.resolve({ ok: true as const, n: 0 })
      : (selectedSlug
          ? regsCol.where('organizerUid', '==', uid).where('eventSlug', '==', selectedSlug)
          : regsCol.where('organizerUid', '==', uid)
        ).where('checkedInAt', '>=', todayStart)
          // ═══ RD-DASH-13 · THE orderBy IS LOAD-BEARING ═══════════════════════════
          // Without it this count had been FAILING on production, every load, with
          // FAILED_PRECONDITION — and the old `?? 0` printed "0 · No check-ins yet today"
          // over the top of it. Verified against the live project during this phase.
          //
          // An inequality with no explicit order implies ASCENDING on that field, and the
          // deployed composite indexes are `(organizerUid[, eventSlug], checkedInAt DESC)`.
          // Naming DESC matches an index that already exists, so this needs no deployment.
          //
          // It changes nothing about WHAT is counted: `orderBy` on a field excludes documents
          // that lack it, and `checkedInAt >= todayStart` already excludes those.
          .orderBy('checkedInAt', 'desc')
          .count().get()
          .then(s => ({ ok: true as const, n: s.data().count }))
          .catch(() => ({ ok: false as const, n: 0 })),
    // RD-DASHBOARD-02 — the daily rollups powering every trend/today/month figure.
    // Resolves to null on failure rather than an empty series, so the client can tell
    // "no activity" from "could not load" instead of reading a flat line as fact.
    // The trend reads the EVENT's rollup row when scoped, and the workspace row
    // otherwise. Never the workspace series under an event heading.
    scopedNoSlug
      ? Promise.resolve(buildSeries(trendKeys, new Map()))
      : readDailyStats(uid, selectedSlug ?? ALL_EVENTS, trendKeys).catch(() => null),
    readCoverage(uid),
  ])

  // Rollup outcome, resolved once. A failed read must never look like a quiet zero.
  const trendUnavailable = dailySeriesResult === null
  const dailySeries      = dailySeriesResult ?? buildSeries(trendKeys, new Map())
  const coverage         = resolveCoverage(trendKeys, coverageSince)

  // RD-AUTH-02: the single organizer-session boot endpoint is the safest place to
  // guarantee the canonical /users/{uid} profile exists. Idempotent + piggybacks the
  // read above, so the self-heal write fires ONLY when the profile is genuinely missing
  // (an orphaned/legacy account whose profile write never completed).
  let profile: Record<string, unknown> = profileSnap.exists ? (profileSnap.data() ?? {}) : {}
  if (!profileSnap.exists) {
    const healed = await ensureOrganizerProfile(uid)
    if (healed) profile = healed
  }
  const drafts     = draftDocs.map(d => ({ id: d.id, ...d.data() }) as Record<string, unknown>)


  // ── Collect slugs + draft IDs for batch 2 ─────────────────────────────────
  // Also archive-guarded: an event archived before the current writer existed can still
  // carry the legacy status 'published', which would put it back into the alerts, the
  // Active-events KPI and the event-health list.
  const publishedDrafts = drafts.filter(d => d.status === 'published' && !isArchivedTabEvent(d))
  // Certificate-template alerts are scoped to currently-published events.
  const draftIdList: string[] = publishedDrafts.map(d => d.id as string)

  // RD-DASH-03: the slug rule now lives in lib/dashboard/activityFeed and is shared with
  // the activity paging endpoint, so the two cannot resolve scope differently.
  //
  // RD-CE-FIX C1 · ...but only the slugs the live documents prove belong to THIS workspace's drafts
  // (one getAll). The draft pointer is client-writable; an unverified slug reads as unpublished.
  // RD-FIN-02 · the same single getAll, now keeping the live event data it read (capacity).
  const ownedEvents = await resolveOwnedEvents(uid, drafts.map(d => ({ id: d.id as string, data: d })))
  const ownedSlugs  = new Map([...ownedEvents].map(([id, v]) => [id, v.slug] as [string, string]))
  const slugOfDraft = (d: Record<string, unknown>): string | null => ownedSlugs.get(d.id as string) ?? null
  const liveEventBySlug = new Map([...ownedEvents.values()].map(v => [v.slug, v.data] as [string, Record<string, unknown>]))

  // ══ THE CANONICAL DASHBOARD EVENT SET ════════════════════════════════════════
  //
  // ONE definition, used by EVERY figure on this dashboard: the KPI cards, revenue, both
  // trend charts, pass distribution, registration status, event performance, insights and
  // the activity feed. No card may filter events for itself — that is exactly how they
  // drifted apart before.
  //
  //   ever published (has publishedAt)  AND  NOT shown under the Archived tab
  //
  // THE INVARIANT: if the Events page files an event under "Archived", it contributes
  // nothing here. That tab is a bucket for FOUR terminal states — completed, cancelled,
  // archived and unpublished — and `isArchivedTabEvent` derives its answer from the very
  // same `listingTabsForEvent` mapping the tab uses, so the two can never disagree.
  //
  // Re-listing those states here instead would be a second copy destined to drift: that is
  // precisely how an UNPUBLISHED event kept feeding Pass Distribution and Event Performance
  // while the operator was looking at it under the Archived tab.
  //
  // NOT the same question as `isArchivedEvent`, which means the genuine permanent archived
  // state and gates permanent DELETION. An unpublished event is excluded from the dashboard
  // yet stays editable, restorable, and NOT permanently deletable.
  const dashboardDrafts = drafts.filter(d => d.publishedAt && !isArchivedTabEvent(d))
  const slugList = Array.from(new Set(
    dashboardDrafts.map(slugOfDraft).filter((s): s is string => !!s),
  ))
  // The same set as a lookup. The recent-registration scan below is organizerUid-scoped with
  // NO event filter, so without this an archived event's registrations would flow straight
  // into both trend charts, today's figures and the activity feed.
  const dashboardSlugs = new Set(slugList)

  // ═══ THE LOOKUP SET ════════════════════════════════════════════════════════
  // `dashboardDrafts` is the WORKSPACE aggregate set, and it deliberately excludes
  // anything filed under the Archived tab — completed, cancelled, archived, unpublished.
  //
  // An explicit selection is a different question. An organizer opening a FINISHED race
  // to review it has selected that event by name, and the archive rule would answer with
  // zeros — "0 registrations, ₹0" under the event's own heading, which is the exact
  // fabrication this scope work exists to remove. So the selected event joins the set the
  // per-event lookups are built from.
  //
  // It never joins `slugList`, so it still cannot leak into a workspace aggregate or into
  // the cross-event comparison.
  // Matched by ID, never by slug. An unpublished draft's slug is null, and `slugOfDraft`
  // returns null for every other unpublished draft too — so a slug match would bind the
  // selection to whichever draft happened to come first.
  const selectedDraft = scoped ? drafts.find(d => d.id === requestedEventId) ?? null : null
  const lookupDrafts  = selectedDraft && (selectedSlug === null || !dashboardSlugs.has(selectedSlug))
    ? [...dashboardDrafts, selectedDraft]
    : dashboardDrafts
  const lookupSlugs   = Array.from(new Set(
    lookupDrafts.map(slugOfDraft).filter((x): x is string => !!x),
  ))

  // ═══ THE SCOPED SET ════════════════════════════════════════════════════════
  // `registrationCounters` is keyed by event slug, so every counter-derived widget —
  // registrations, revenue, pass distribution, registration status, coupons — scopes
  // to one event for FREE by narrowing this list. No extra read, no new index.
  //
  // `slugList` stays the full set and is used ONLY by Event Performance, which is the
  // documented cross-event exception.
  //
  // In event mode this is the SELECTED slug itself rather than `slugList` narrowed by it:
  // narrowing would silently produce an empty set — and therefore zeros — for an event the
  // archive rule excludes, which is precisely the case an operator reviewing a finished
  // event is in.
  const scopedSlugs = scoped ? (selectedSlug ? [selectedSlug] : []) : slugList

  // RD-DASH-03: the in-memory scope filter that stood here is gone with the queries it
  // filtered. The feed reader pushes the event set INTO the query, so a limited read can
  // no longer be spent on rows that are then discarded.

  // ── Batch 2: counters + cert templates ────────────────────────────────────
  // D.1: read each set with a single getAll() multi-get instead of N individual
  // doc().get() calls. Same documents and billed reads, but the round trips drop
  // from 2·(published events) to 2. getAll preserves argument order, so the
  // snapshot arrays still align 1:1 with slugList / draftIdList below.
  // (getAll throws with zero refs, so guard the empty case.)
  const counterRefs = lookupSlugs.map(s  => adminDb.collection('registrationCounters').doc(s))
  const certDraftIds = Array.from(new Set([...draftIdList, ...lookupDrafts.map(d => d.id as string)]))
  const certRefs    = certDraftIds.map(id => adminDb.collection('certificateTemplates').doc(id))
  // eventLicenses is keyed by event SLUG, so the scoped set addresses it directly: ONE
  // document in event mode, N in all-events mode — the same ids already in hand.
  const licenseSlugs = scoped ? scopedSlugs : slugList
  const licenseRefs  = licenseSlugs.map(sl => adminDb.collection(EVENT_LICENSES_COLLECTION).doc(sl))
  // ═══ RD-DASH-13 · THE ONE READ THE DASHBOARD CANNOT DEGRADE AROUND ═════════
  // `registrationCounters` is the source of confirmed registrations, ticket revenue, the
  // per-pass split, the licence usage figure, the cancelled count, every capacity alert
  // and the Check-in denominator. Without it there is no dashboard — there is a page of
  // "unavailable".
  //
  // It had NO catch, so a transient failure surfaced as an unhandled 500 with a stack
  // trace. Catching it and carrying on would be worse: every counter-derived figure would
  // read `?? 0` and the organizer would be shown a workspace with no registrations and no
  // revenue, which is a lie rather than an outage.
  //
  // So it fails EXPLICITLY, with a code and a retryable message. The two non-load-bearing
  // reads beside it degrade individually and do not take the page down: a missing
  // certificate template only suppresses an alert, and a missing licence document is
  // already handled as "no licence yet".
  const [counterSnapsResult, certSnaps, licenseSnaps] = await Promise.all([
    counterRefs.length ? adminDb.getAll(...counterRefs).catch(() => null) : Promise.resolve([]),
    certRefs.length    ? adminDb.getAll(...certRefs).catch(() => [])      : Promise.resolve([]),
    licenseRefs.length ? adminDb.getAll(...licenseRefs).catch(() => [])   : Promise.resolve([]),
  ])
  if (counterSnapsResult === null) {
    return NextResponse.json(
      {
        error: 'Your registration counters could not be read just now. Nothing is wrong with your data — please try again.',
        code:  'COUNTERS_UNAVAILABLE',
      },
      { status: 503 },
    )
  }
  const counterSnaps = counterSnapsResult

  // counterMap = confirmed registered per event (totalCount is ALWAYS maintained,
  // so reliable even for not-yet-backfilled events). revBySlug = confirmed revenue
  // per event, from the denormalized stats doc when complete, else deferred to a
  // self-healing per-event aggregate below.
  const counterMap = new Map<string, number>()
  /**
   * slug → confirmed revenue in paise. RD-DASH-13: `null` ⇒ UNMEASURED.
   *
   * The self-healing aggregate below used to `.catch(() => 0)`, so a failed sum became a
   * real-looking ₹0 in the Ticket Revenue KPI and in `events[].revenuePaise`. A counter
   * document that is simply ABSENT still maps to 0, because no counter means no
   * registrations and no revenue — that zero is measured, not assumed.
   */
  const revBySlug  = new Map<string, number | null>()
  const revenueFallbackSlugs: string[] = []
  // RD-DASHBOARD-ANALYTICS — the raw counter per slug, kept so the organizer-wide
  // Registration Status and Pass Distribution can be derived from these ALREADY-LOADED
  // documents instead of the 90-day/5000-capped registration scan. Absent ⇒ no counter doc.
  const counterBySlug = new Map<string, RegistrationCounter | null>()
  counterSnaps.forEach((snap, i) => {
    const slug = lookupSlugs[i]
    if (!snap.exists) { counterMap.set(slug, 0); revBySlug.set(slug, 0); counterBySlug.set(slug, null); return }
    const d = snap.data() as RegistrationCounter
    counterBySlug.set(slug, d)
    counterMap.set(slug, d.totalCount ?? 0)
    if ((d.statsVersion ?? 0) >= EVENT_STATS_VERSION) revBySlug.set(slug, d.revenuePaise ?? 0)
    else revenueFallbackSlugs.push(slug)
  })
  // Self-healing fallback: confirmed-revenue aggregate for any event whose stats
  // doc predates the backfill. One indexed sum per event, no document transfer;
  // empty in steady state (after reconciliation stamps statsVersion).
  if (revenueFallbackSlugs.length) {
    // RD-FIN-02 B5 · the ONE ticket-revenue definition (Σ amount − Σ attendee fees) — the same helper
    // Analytics, the Events list, Finance and reconciliation use. An unreadable sum stays null (unknown).
    const sums = await Promise.all(revenueFallbackSlugs.map(slug =>
      sumConfirmedRevenueFromLedgerChecked(slug).then(r => (r.ok ? r.value : null)).catch(() => null)))
    revenueFallbackSlugs.forEach((slug, i) => revBySlug.set(slug, sums[i]))
  }

  const certTemplateSet = new Set<string>()
  certSnaps.forEach((snap, i) => {
    if (snap.exists) certTemplateSet.add(certDraftIds[i])
  })

  // ── Overview ───────────────────────────────────────────────────────────────

  const activeLifecycles = new Set(['published', 'registration_closed'])
  // In event mode this counts the SELECTED event only — 1 when it is live, 0 when it is
  // not. A workspace count of active events beside one event's registrations would be two
  // different scopes sitting in the same KPI row.
  const activeEvents = scoped
    ? (selectedDraft && activeLifecycles.has(deriveLifecycleStatus(selectedDraft)) ? 1 : 0)
    : publishedDrafts.filter(d => activeLifecycles.has(deriveLifecycleStatus(d))).length

  // All-time totals from the per-event statistics docs (O(events), no scan).
  const totalRegs     = scopedSlugs.reduce((s, slug) => s + (counterMap.get(slug) ?? 0), 0)
  // One unmeasured event makes the WHOLE ticket-revenue figure unmeasured. Summing the
  // rest and presenting it as the total would understate it by an unknown amount, which
  // is the failure mode a plain number cannot express.
  const revenueUnavailable = scopedSlugs.some(slug => revBySlug.get(slug) === null)
  const totalRevPaise: number | null = revenueUnavailable
    ? null
    : scopedSlugs.reduce((s, slug) => s + (revBySlug.get(slug) ?? 0), 0)

  // RD-DASHBOARD-02 — today and month-to-date now come from the ROLLUPS, not from a
  // capped scan. `dailySeries` is exact for every day inside coverage regardless of
  // registration volume, so these numbers no longer degrade on a busy event.
  const todayKey  = dayKey(nowMs)
  const todayRow  = dailySeries.find(p => p.date === todayKey)
  const todayRegs       = todayRow?.confirmed ?? 0
  const todayRevPaise   = todayRow?.revenuePaise ?? 0
  /** null ⇒ the aggregate failed. The tile renders "unavailable", never 0. */
  const todayCheckins: number | null = todayCheckinsAgg.ok ? todayCheckinsAgg.n : null

  // Month-to-date = the rollup days belonging to the current calendar month. String
  // comparison is safe and timezone-stable because every key is `YYYY-MM-DD` in the
  // one reporting zone (see dayKey).
  const monthPrefix   = todayKey.slice(0, 7)
  const monthRows     = dailySeries.filter(p => p.date.startsWith(monthPrefix))
  const monthRegs     = monthRows.reduce((s, p) => s + p.confirmed, 0)
  const monthRevPaise = monthRows.reduce((s, p) => s + p.revenuePaise, 0)

  // ── Alerts ─────────────────────────────────────────────────────────────────

  // RD-FIN-02 · each event's capacity is the ENFORCED capacity of its live document — the value
  // the registration gate and the settlement transaction compare against — via the ONE summary
  // every surface uses (lib/registrations/capacity.ts). It used to be read from the LICENCE,
  // which diverges after a Super Admin override and for legacy tier licences. Zero extra reads:
  // the live docs were loaded by the ownership check above.
  const capacityOf = (slug: string | null): number | null =>
    slug ? resolveEventCapacitySummary({ eventDoc: liveEventBySlug.get(slug) ?? null, counter: null }).total : null

  const alerts: DashboardAlert[] = []

  // Only currently-published events raise these; the lookup set is used so a selected
  // event outside the workspace aggregate set still gets its own alerts.
  lookupDrafts.forEach(d => {
    if (deriveLifecycleStatus(d) !== 'published') return

    const details   = (d.eventDetails as Record<string, unknown>) ?? {}
    const info      = (details.info     as Record<string, unknown>) ?? {}
    const sched     = (details.schedule as Record<string, unknown>) ?? {}
    const name      = typeof info.name    === 'string' ? info.name    : 'Untitled Event'
    const slug      = slugOfDraft(d)
    const draftId   = d.id as string

    const capacity = capacityOf(slug)
    const regCount = slug ? (counterMap.get(slug) ?? 0) : 0

    // Nearly full
    if (capacity !== null && capacity > 0) {
      const pct = regCount / capacity
      if (pct >= 0.9) {
        alerts.push({
          type: 'nearly_full', severity: 'critical',
          title: `${name} is almost full`,
          meta:  `${regCount}/${capacity} seats · ${Math.round(pct * 100)}% filled`,
          eventSlug: slug, eventDraftId: draftId,
        })
      } else if (pct >= 0.8) {
        alerts.push({
          type: 'nearly_full', severity: 'warning',
          title: `${name} is filling fast`,
          meta:  `${regCount}/${capacity} seats · ${Math.round(pct * 100)}% filled`,
          eventSlug: slug, eventDraftId: draftId,
        })
      }
    }

    // Certificate template missing
    if (!certTemplateSet.has(draftId)) {
      alerts.push({
        type: 'cert_missing', severity: 'warning',
        title: 'Certificate template missing',
        meta:  `Set up certificates for ${name}`,
        eventSlug: slug, eventDraftId: draftId,
      })
    }

    // Registration closing soon (event starts within 48 h)
    const startStr = typeof sched.startDate === 'string' ? sched.startDate : null
    if (startStr) {
      const hoursUntil = (new Date(startStr).getTime() - Date.now()) / 3_600_000
      if (hoursUntil > 0 && hoursUntil <= 48) {
        alerts.push({
          type:     'reg_closing_soon',
          severity: hoursUntil <= 24 ? 'critical' : 'warning',
          title:    'Registration closing soon',
          meta:     `${name} starts in ${Math.round(hoursUntil)}h`,
          eventSlug: slug, eventDraftId: draftId,
        })
      }
    }
  })

  // Communication payment pending
  // Canonical set: an archived event needs no action, so it must not raise an alert.
  lookupDrafts.forEach(d => {
    const billing = d.communicationBilling as Record<string, unknown> | null | undefined
    if (billing?.status !== 'pending') return
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info    as Record<string, unknown>) ?? {}
    const name    = typeof info.name === 'string' ? info.name : 'an event'
    alerts.push({
      type: 'comm_payment_pending', severity: 'warning',
      title: 'Communication payment required',
      meta:  `Complete payment to publish ${name}`,
      // Carries its event so the scope filter can keep it out of another event's screen.
      // It used to be null, which read as "workspace-level" for an alert that names one event.
      eventSlug:    slugOfDraft(d),
      eventDraftId: d.id as string,
    })
  })

  // ═══ SETTLEMENT — NOW EVENT-SCOPED WHEN AN EVENT IS SELECTED ═══════════════
  //
  // It used to be workspace-lifetime in EVERY mode, so a selected event's screen carried
  // one event's ticket revenue beside the organizer's lifetime payout position — two
  // populations under one heading, and the direct cause of the "Confirmed revenue does not
  // match Gross revenue" report.
  //
  // `platformTransactions` is already per-event (`entityId = eventSlug`) and already has a
  // composite index built for exactly this aggregate, so scoping costs ONE count + ONE sum
  // and transfers no documents. `getLedgerTotals` is the canonical resolver the Finance
  // module itself uses — not a second calculation.
  //
  // All-events mode keeps the wallet rollup: it is the materialised lifetime position and
  // is what /dashboard/finance shows, so the two surfaces still agree.
  // Read in BOTH modes now: the Fees & Payout card needs the platform-vs-gateway SPLIT,
  // and the materialised wallet stores only the two combined. Cost is one count + one sum,
  // no documents transferred, on an index that already exists.
  // from/to null ⇒ the WHOLE lifetime, matching the KPI's all-time basis.
  const ledger = await getLedgerTotals({
    organizerUid: uid,
    eventSlug:    scoped ? selectedSlug : null,
    from: null, to: null,
  }).catch(() => null)
  // MaybeMoney is a discriminated union: `ok: false` means "could not measure", which must
  // never be read as zero. Unwrapping to null keeps that distinction intact.
  const ledgerMoney = (m: MaybeMoney | null | undefined): number | null =>
    m && m.ok ? m.paise : null

  // ═══ RD-DASH-02 · NOTHING BELOW IS DERIVED ═════════════════════════════════
  // `scopedFees = gross − net` used to live here. Under attendee-pays the organizer
  // receives the full gross, so that subtraction is structurally zero and the card
  // reported a ₹0 platform fee against a real, non-zero one. Every figure now comes from the
  // resolver field that means it, and the wallet rollup is no longer consulted for fees:
  // it stores the same subtraction, materialised.
  //
  // The ledger is read in BOTH modes (it already was, for the Fees & Payout tile), so the
  // two finance surfaces on this screen cannot disagree.
  const ledgerGateway = ledger?.gateway ?? null

  // Communication billing is a SEPARATE concern (comms wallet), surfaced on the
  // Communication usage card — never mixed into the revenue settlement figures above.
  // Canonical set: this is a dashboard money figure, so an archived event's communication
  // spend must not keep appearing in the settlement card after the event is off the books.
  const commSpendOf = (d: Record<string, unknown> | null): number => {
    const b = d?.communicationBilling as Record<string, unknown> | null | undefined
    return (b?.status === 'paid' && typeof b.amount === 'number') ? b.amount : 0
  }
  const communicationCostPaise = dashboardDrafts.reduce((s, d) => s + commSpendOf(d), 0)
  // Billing is recorded per DRAFT with no event-scoped rollup, so this figure is
  // workspace-wide even when an event is selected. RD-DASH-02 states that rather than
  // narrowing it: making it event-scoped is a BILLING change, not a display one.
  const communicationCostScope: CommunicationCostScope = 'workspace'

  // ── The two remaining canonical finance readers ────────────────────────────
  // Same scope object the ledger above already used, so every figure on the card
  // describes one population. `getAttendeePaid` follows the DASHBOARD event set, which
  // is what the rest of this screen counts; both degrade to null rather than to zero.
  // RD-FIN-02 · ONE scope for the whole card. All-events mode: the ledger, fees and refunds above
  // cover the WORKSPACE LIFETIME ledger (archived events included — the wallet's population, and what
  // /dashboard/finance "All events" shows), while Attendee paid used to cover only the non-archived
  // dashboard set. It now follows the same population; the card says so (scope below).
  const settlementSlugs = scoped ? scopedSlugs : Array.from(new Set(ownedSlugs.values()))
  const [attendeePaidRead, refundRead] = await Promise.all([
    financeAllowed && settlementSlugs.length > 0
      ? getAttendeePaid(settlementSlugs, ATTENDEE_PAID_STATUSES).catch(() => null)
      : Promise.resolve(null),
    financeAllowed
      ? getRefundTotals({
          organizerUid: uid,
          eventSlug:    scoped ? selectedSlug : null,
          from: null, to: null,
        }).catch(() => null)
      : Promise.resolve(null),
  ])

  // ── Activity Feed ──────────────────────────────────────────────────────────
  //
  // RD-DASH-03: assembled by lib/dashboard/activityFeed, the same reader the paging
  // endpoint uses. It used to be built inline here — two queries, a merge and a sort — and
  // the page-2 endpoint would have been a second copy of all three, free to drift in its
  // scope rules, its window and its tie-break. Page 1 and page 2 now differ only by cursor.
  const activityPageResult: ActivityPage = await readActivityPage({
    organizerUid:   uid,
    eventSlug:      scoped ? selectedSlug : null,
    dashboardSlugs: slugList,
    since:          cutoff90,
    // RD-ANALYTICS-12-17 · the union that already grants attendee names in this product:
    // `registrations` (registration lists and exports) or `transactions` (payment issues).
    // Neither ⇒ the name is not read and not returned. See ActivityScope for the reasoning.
    canReadAttendeeName: authz.permissions.includes('registrations')
                      || authz.permissions.includes('transactions'),
    // ═══ RD-DASH-15 · A FAILED FEED IS NOT A QUIET ONE ══════════════════════════
    // This resolved to an empty page, and the card rendered "No recent activity yet." —
    // indistinguishable from an event where genuinely nobody has registered yet. The
    // reader is defensive enough that this catch is close to unreachable; that is a reason
    // to make it honest, not a reason to leave it lying.
  }, { pageSize: ACTIVITY_PAGE_SIZE }).catch(() => ({
    items: [], pageSize: ACTIVITY_PAGE_SIZE, hasMore: false, nextCursor: null, skipped: 0,
    exact: true, unavailable: true,
  }))

  const activity: DashboardActivity[] = activityPageResult.items
  const activitySkipped = activityPageResult.skipped
  // ── Event Health (published + registration_closed + completed) ─────────────

  const visibleStatuses = new Set(['published', 'registration_closed', 'completed'])
  // Event mode narrows this to the selected event — and drops the archive guard for it,
  // because a deliberately selected event must describe itself even when the workspace
  // aggregate would exclude it.
  const events: DashboardEvent[] = (scoped ? (selectedDraft ? [selectedDraft] : []) : drafts)
    .filter(d => scoped || (visibleStatuses.has(deriveLifecycleStatus(d)) && !isArchivedTabEvent(d)))
    .map(d => {
      const details  = (d.eventDetails as Record<string, unknown>) ?? {}
      const info     = (details.info    as Record<string, unknown>) ?? {}
      const sched    = (details.schedule as Record<string, unknown>) ?? {}
      const media    = (details.media   as Record<string, unknown>) ?? {}
      const banner   = (media.coverBanner as Record<string, unknown>) ?? {}
      const slug     = slugOfDraft(d)
      const capacity = capacityOf(slug)
      const regCount = slug ? (counterMap.get(slug) ?? 0) : 0
      const fillPct  = capacity ? Math.round((regCount / capacity) * 100) : 0
      /*
        RD-ANALYTICS-12-24/25 · ONE state, serialized once.

        `confirmedRevenuePaise` and `revenueUnavailable` are both encoded from this single
        value by `toConfirmedRevenueFields` — no second calculation, no second read, no
        second encoder, so the figure and the flag that qualifies it cannot disagree.
      */
      const revenue  = revenueStateFromCounterMap(revBySlug, slug, financeAllowed)

      return {
        draftId:         d.id as string,
        name:            typeof info.name      === 'string' ? info.name      : 'Untitled Event',
        slug,
        registered:      regCount,
        capacity,
        fillPct,
        startDate:       typeof sched.startDate === 'string' ? sched.startDate : null,
        lifecycleStatus: deriveLifecycleStatus(d),
        reviewStatus:    d.reviewStatus === 'rejected' || d.reviewStatus === 'changes_requested' ? d.reviewStatus : null,
        licenseTier:     typeof d.licenseTier === 'string' ? d.licenseTier : 'starter',
        bannerUrl:       typeof banner.value === 'string' ? banner.value : null,
        // RD-DASH-12 · null, never a figure, for a caller without `transactions`.
        // RD-ANALYTICS-12-21 (F1) · derived from one `RevenueState`, so the fields cannot
        // contradict. The former `revBySlug.get(slug) ?? 0` turned this map's `null` — which
        // means UNMEASURED — into a measured-looking ₹0, while `totalRevPaise` two hundred
        // lines up reported the same event as unavailable.
        // RD-ANALYTICS-12-25 · the deprecated `revenuePaise` alias has been removed; the
        // canonical name is now the only one this contract emits.
        ...toConfirmedRevenueFields(revenue),
      }
    })

  // ── Trend data — from the ROLLUPS ──────────────────────────────────────────
  //
  // Previously bucketed by scanning up to 5,000 registration documents. Now a direct
  // projection of organizerDailyStats: exact at any volume, and the read cost is the
  // number of DAYS (90) rather than the number of registrations.
  //
  //  already covers every day in the window, zero-filled, so no seeding
  // pass is needed — a day with no document genuinely had no activity, because the
  // write path only creates a document when something happened.

  // RD-PREPROD · per-day revenue is MONEY: withheld (null) without 'transactions', like every other
  // revenue figure on this response. It used to be emitted ungated, so a team member who may not see
  // revenue could sum 90 days of it from the chart series.
  const trendDays = dailySeries.map(p => ({
    date: p.date, count: p.confirmed, revenuePaise: financeAllowed ? p.revenuePaise : null,
  }))

  // ── passId → pass name, from the drafts ALREADY loaded above (no extra reads) ──
  // `passCounts` is keyed by passId; the chart shows names. Passes live at
  // `draft.pricing.passes`, the same shape the attendance and event routes read.
  //
  // A pass whose configured name is genuinely "free" therefore DISPLAYS as "free" — that is
  // real configured data, not a fallback. An unresolvable passId becomes "Unassigned"
  // downstream; the two are never confused.
  const passNamesBySlug = new Map<string, Record<string, string>>()
  const eventNameBySlug = new Map<string, string>()
  /**
   * RD-DASH-10 · slug → the event's state, as the ORGANIZER already reads it elsewhere.
   *
   * Resolved with `presentEventStatus` — the one mapping the Event Selector, the breadcrumb
   * trail and the event overview share. Event Performance becomes the fourth surface using
   * it rather than the first to describe an event's state in its own words.
   */
  const eventStatusLabelBySlug = new Map<string, string>()
  // Canonical set. These are only ever read for a slug already in `slugList`, so an archived
  // entry could not leak — but building them from the same source keeps the invariant true
  // by construction rather than by luck, and lets a test assert it.
  lookupDrafts.forEach(d => {
    const slug = slugOfDraft(d)
    if (!slug) return
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info as Record<string, unknown>) ?? {}
    eventNameBySlug.set(slug, typeof info.name === 'string' && info.name ? info.name : 'Untitled Event')

    const sched = (details.schedule as Record<string, unknown>) ?? {}
    eventStatusLabelBySlug.set(slug, presentEventStatus({
      draftId: d.id as string,
      name: eventNameBySlug.get(slug) ?? 'Untitled Event',
      slug,
      status: d.status === 'published' ? 'published' : 'draft',
      lifecycleStatus: deriveLifecycleStatus(d),
      startDate: typeof sched.startDate === 'string' ? sched.startDate : null,
      endDate: null, totalRegistrations: 0, totalCapacity: null, updatedAt: '',
    }, nowMs).label)

    const raw = (d.pricing as Record<string, unknown> | undefined)?.passes
    if (!Array.isArray(raw)) return
    const names: Record<string, string> = {}
    for (const p of raw as Array<Record<string, unknown>>) {
      const id   = typeof p.id === 'string' ? p.id : ''
      const name = typeof p.name === 'string' ? p.name.trim() : ''
      if (id) names[id] = name
    }
    passNamesBySlug.set(slug, names)
  })

  // ── Organizer-wide, ALL-TIME status + pass distribution ───────────────────────
  //
  // WHY NOT THE RECENT SCAN. These two charts used to be derived from `recentRegs`, which is
  // organizerUid + registeredAt ≥ 90d + limit(5000) and carries NO event filter. That made
  // them silently window-limited and cap-limited, and inconsistent with Event Performance on
  // the same screen (which is all-time, from the counters). They now come from the counter
  // documents that this route already fetches, so they are all-time, uncapped, and cheaper.
  //
  // The recent scan REMAINS — trendDays, today's figures and the activity feed genuinely need
  // recent per-registration rows.
  // ── ONE authoritative status source per event ─────────────────────────────────
  // C: every event resolves its status breakdown the same way, so Waitlisted stops being a
  // confident zero. `registrationCounters` carries pending/cancelled/rejected but has NO
  // waitlistedCount field — the counter path could therefore never report a waitlist. Events
  // with current stats reuse the counter (free, already fetched) plus ONE extra aggregate for
  // waitlisted; events with stale stats fall back to the full shared aggregate as before.
  // Every query is a count(): zero documents transferred, existing indexes.
  const eventStatus = new Map<string, EventStatusCounts | null>()

  const staleSet    = new Set(lookupSlugs.filter(slug => {
    const c = counterBySlug.get(slug)
    return !c || (c.statsVersion ?? 0) < EVENT_STATS_VERSION
  }))
  const staleSlugs  = lookupSlugs.filter(s => staleSet.has(s))
  const freshSlugs  = lookupSlugs.filter(s => !staleSet.has(s))

  // ═══ RD-DASH-13 · THE FOLD IS NOW THE SELECTED EVENT ONLY ══════════════════
  // RD-DASH-11B folded every fresh event's attendance shards so that
  // `eventStatus.checkedIn` would be authoritative rather than a permanent 0. It made
  // that field correct — and then RD-DASH-12 established that NOTHING reads it:
  // `buildDashboardAnalytics` has never referenced `checkedIn`, and the Check-in card is
  // served by `resolveCheckInFromCounters` below.
  //
  // So the field is gone from the dashboard's own status shape (see EventStatusCounts)
  // and with it one `attendanceShards` subcollection read PER EVENT — measured at 50 of
  // them on a 50-event workspace, for a number that was never rendered. The shared
  // `RegistrationStatusCounts` still carries `checkedIn` for the three routes that do use
  // it; only the dashboard stops paying.
  //
  // ONE fold survives, for the SELECTED event, because the Check-in card genuinely needs
  // it. Still exactly one read and one fold — the RD-DASH-11B invariant is unchanged.
  const shardSlugs = scoped && selectedSlug ? [selectedSlug] : []

  const [staleRows, waitRows, shardRows] = await Promise.all([
    Promise.all(staleSlugs.map(slug => aggregateRegistrationStatusCounts(uid, slug).catch(() => null))),
    Promise.all(freshSlugs.map(slug => aggregateWaitlistedCount(uid, slug))),
    // Null on failure — unread, never zero. A base-counter fallback would reinstate the
    // exact defect this repair removes.
    Promise.all(shardSlugs.map(slug => getAttendanceShardSums(slug).catch(() => null))),
  ])

  const attendanceBySlug = new Map<string, AttendanceShardSums | null>()
  shardSlugs.forEach((slug, i) => attendanceBySlug.set(slug, shardRows[i]))

  // The stale path answers every status from ONE shared aggregate, so its waitlist can
  // never be independently missing — it is present or the whole read failed.
  staleSlugs.forEach((slug, i) => {
    const r = staleRows[i]
    eventStatus.set(slug, r === null ? null : {
      total: r.total, confirmed: r.confirmed, pending: r.pending,
      cancelled: r.cancelled, rejected: r.rejected, waitlisted: r.waitlisted,
    })
  })
  freshSlugs.forEach((slug, i) => {
    const c = counterBySlug.get(slug)!
    const waitlisted = waitRows[i]
    // ═══ RD-DASH-13 · A MISSING WAITLIST LOSES THE WAITLIST ════════════════════
    // This used to be `if (waitlisted === null) { eventStatus.set(slug, null); return }`,
    // which discarded the entire event. Measured: failing that ONE count took
    // `registrationTotals.confirmed` to 0 and emptied Registration Status, Pass
    // Distribution and Event Performance, while the Confirmed-registrations KPI — reading
    // the same counter document directly — kept its real value. One screen, two answers.
    //
    // The four figures below come from the counter document this route already holds. The
    // waitlist is the ONE field that needs its own query, so it is the one field that goes
    // null, and `total` goes with it because a sum missing a part is not a total.
    const confirmed = c.totalCount     ?? 0
    const pending   = c.pendingCount   ?? 0
    const cancelled = c.cancelledCount ?? 0
    const rejected  = c.rejectedCount  ?? 0
    eventStatus.set(slug, {
      // SUMMED from the parts, never read as an independent figure — the counter has no
      // all-status total, and inventing one by another route could disagree with them.
      total: waitlisted === null ? null : confirmed + pending + cancelled + rejected + waitlisted,
      confirmed, pending, cancelled, rejected, waitlisted,
    })
  })

  // ── A: cancelled split by pass, count()-only and budgeted ─────────────────────
  // Runs ONLY for events that actually have cancellations, so a clean event costs nothing.
  // The budget caps events × passes; once spent, the remaining events report `null` (→
  // "unavailable"), never zeros.
  const passIdsBySlug = new Map<string, string[]>()
  lookupDrafts.forEach(d => {      // lookup set — see eventNameBySlug above
    const slug = slugOfDraft(d)
    if (!slug) return
    const raw = (d.pricing as Record<string, unknown> | undefined)?.passes
    if (!Array.isArray(raw)) return
    passIdsBySlug.set(slug, (raw as Array<Record<string, unknown>>)
      .map(p => (typeof p.id === 'string' ? p.id : ''))
      .filter(Boolean))
  })

  // ═══ RD-DASH-13 · PLAN, ALLOCATE, THEN RUN IN PARALLEL ═════════════════════
  // These two loops were `for … await`, one event at a time, and together they were the
  // dominant term in the measured serial depth: ~2.75 sequential round trips per event,
  // projecting to a ~13.7 s floor at 50 events against production latency.
  //
  // They could not simply be wrapped in Promise.all, because both draw on ONE mutable
  // budget and the ORDER of consumption decides which events get measured and which
  // report "unavailable". Racing them would make that allocation non-deterministic — the
  // same workspace could show a different set of unavailable events on each load.
  //
  // The allocation, however, needs no I/O at all: each helper charges the budget UP FRONT
  // from `passIds.length`, which is already in hand. So the plan is computed first, in the
  // exact order the loops used to run and by the exact same rules — including the rule
  // that an event too big for the remaining budget is SKIPPED without consuming it, so a
  // later smaller event can still fit — and only then is the work executed concurrently.
  //
  // Identical inputs therefore produce an identical allocation, an identical set of
  // `null`s, and identical numbers. Only the wall-clock changes.
  const passBudget = { remaining: PASS_AGGREGATE_BUDGET }

  /** Events whose cancelled-by-pass split the budget can afford, in the original order. */
  const cancelledPlan: string[] = []
  const cancelledByPass = new Map<string, Record<string, number> | null>()
  for (const slug of lookupSlugs) {
    const st = eventStatus.get(slug)
    if (!st || st.cancelled === 0) continue          // nothing to attribute — no map entry
    const ids = passIdsBySlug.get(slug) ?? []
    // Mirrors aggregateCancelledByPass exactly: no passes ⇒ trivially complete and free.
    if (ids.length === 0) { cancelledByPass.set(slug, {}); continue }
    if (ids.length > passBudget.remaining) { cancelledByPass.set(slug, null); continue }
    passBudget.remaining -= ids.length
    cancelledPlan.push(slug)
  }

  // ── RD-DASH-05: per-pass ticket VALUE ───────────────────────────────────────
  //
  // Registration analytics, not finance. These sum `registrations.amount` — the ticket
  // value on the registration — so a pass can report what it sold and what cancelled out
  // of it. No gateway fee, no platform fee, no settlement, and explicitly NOT a refund
  // amount: a cancellation and a refund are different events, and Finance owns the latter.
  //
  // The sum needs a composite index carrying `amount`; until one is deployed every query
  // fails and the event reports `null`, which the panel renders as "not measured" rather
  // than as ₹0. Runs only for the SCOPED set, so an all-events dashboard with many events
  // does not pay for a breakdown it is not showing.
  //
  // RD-DASH-12 · GATED on `transactions`, like every other money read in this route.
  // These sums are ticket money, and they reached the Pass Distribution panel — which
  // renders "Ticket sales" and "Cancelled value" per pass — for roles the settlement card
  // was already refusing. Skipping the read leaves every row's `salesPaise` null, and the
  // panel omits its money rows for a null exactly as it does for an unmeasured one. No new
  // flag, no ₹0, and a restricted caller no longer pays for aggregates it may not see.
  const valueByPass = new Map<string, Record<string, { salesPaise: number; cancelledPaise: number }> | null>()
  /** Events whose per-pass VALUE split fits in what the plan above left. */
  const valuePlan: string[] = []
  if (financeAllowed) {
    for (const slug of scopedSlugs) {
      const ids = passIdsBySlug.get(slug) ?? []
      if (ids.length === 0) continue                 // no passes — no map entry, as before
      const cost = ids.length * 2                    // confirmed + cancelled per pass
      if (cost > passBudget.remaining) { valueByPass.set(slug, null); continue }
      passBudget.remaining -= cost
      valuePlan.push(slug)
    }
  }

  // ── Execute the whole plan concurrently, under ONE global ceiling ─────────
  // `mapWithConcurrency` caps how many events are in flight; each helper still chunks its
  // own passes internally. The ceiling is what keeps this a parallelisation rather than a
  // burst — 50 events must not open 50 × 8 aggregates at once.
  //
  // The budget is already spent, so the helpers are handed a pre-paid allowance and
  // cannot re-charge it or race each other for it.
  const prepaid = () => ({ remaining: Number.MAX_SAFE_INTEGER })
  await Promise.all([
    mapWithConcurrency(cancelledPlan, EVENT_CONCURRENCY, async slug => {
      const r = await aggregateCancelledByPass(uid, slug, passIdsBySlug.get(slug) ?? [], prepaid())
      cancelledByPass.set(slug, r.complete ? r.counts : null)
    }),
    mapWithConcurrency(valuePlan, EVENT_CONCURRENCY, async slug => {
      const r = await aggregateValueByPass(uid, slug, passIdsBySlug.get(slug) ?? [], prepaid())
      valueByPass.set(slug, r.complete ? r.values : null)
    }),
  ])

  // ── Coupon performance (organizer-wide) ──────────────────────────────────
  // Reuses the SAME bounded event set the rest of this route already established, so it
  // cannot widen the dashboard's scope. Cost is one coupons-subcollection read per event
  // (capped inside the helper) plus ONE sum() aggregate for the whole organizer — never a
  // registration scan, never a query per coupon. A failure degrades to an empty card rather
  // than taking the dashboard down.
  const couponPerformance = await getOrganizerCouponPerformance(
    uid,
    scopedSlugs.map(slug => ({ slug, name: eventNameBySlug.get(slug) ?? 'Untitled Event' })),
    // RD-DASH-07 — the discount aggregate now follows the SAME scope as the rows above it.
    // It had no event filter at all, so in event mode it would have printed the workspace
    // discount total beneath one event's coupons.
    // RD-DASH-12 · and the same permission gate. The discount total is money, and it was
    // reaching finance-restricted roles in full.
    { scoped, slug: selectedSlug, financeAllowed },
    // ═══ RD-DASH-15 · A FAILED RESOLVER IS NOT AN EMPTY WORKSPACE ═══════════
    // `EMPTY_ORGANIZER_COUPON_PERFORMANCE` carries `unavailable: false`, because it is
    // also the honest answer for an organizer with no events to look in. Handed to the
    // card after a THROW it said "No coupons created yet" — a statement about the
    // workspace made on the strength of a failed call. The flag is set here, at the one
    // place that knows the difference.
  ).catch(() => ({ ...EMPTY_ORGANIZER_COUPON_PERFORMANCE, unavailable: true }))

  // ═══ RD-DASH-11A · CHECK-IN PROGRESS ══════════════════════════════════════
  // ONE counter read + ONE attendanceShards fold, and ONLY when an event is selected.
  //
  // The fold is the whole point: check-in writes go to those shards, so
  // `registrationCounters/{slug}.checkedInCount` — which this route already loads and which
  // `eventStatus.checkedIn` is built from — reads 0 on an event with 288 real check-ins.
  // Nothing here reads that field.
  //
  // Event-scoped by design, not by omission: check-in is a gate operation for one event on
  // one day, and blending a finished race with an upcoming one produces a rate nobody can
  // act on. All-events mode reads NOTHING and the card asks for an event.
  // Synchronous, and fed from the SAME fold `eventStatus` uses — so the card and the read
  // model can no longer answer "how many checked in" with two different numbers.
  const checkIn = resolveCheckInFromCounters(
    {
      scoped,
      slug:      selectedSlug,
      lifecycle: selectedLifecycle,
      passNames: selectedSlug ? (passNamesBySlug.get(selectedSlug) ?? {}) : {},
    },
    // The confirmed-per-pass split from the counter this route already holds — so the
    // per-pass rates divide by the same figure Pass Distribution does.
    selectedSlug
      ? ((counterBySlug.get(selectedSlug)?.passCounts ?? {}) as Record<string, number>)
      : {},
    selectedSlug ? (counterBySlug.get(selectedSlug) ?? null) : null,
    selectedSlug ? (attendanceBySlug.get(selectedSlug) ?? null) : null,
  )

  // Pass distribution + registration status follow the SCOPED set.
  /** Cross-event comparison — the documented exception. Always the full set. */
  const crossEventAnalytics = scoped
    ? buildDashboardAnalytics(slugList.map(slug => ({
        slug,
        eventName:     eventNameBySlug.get(slug) ?? 'Untitled Event',
        status:        eventStatus.get(slug) ?? null,
        // This pass feeds Event Performance ONLY, which counts registrations and needs no
        // money — so it does not pay for the per-pass value aggregates.
        passValue:     {},
        passConfirmed: (counterBySlug.get(slug)?.passCounts ?? {}) as Record<string, number>,
        passCancelled: cancelledByPass.has(slug) ? cancelledByPass.get(slug)! : {},
        passNames:     passNamesBySlug.get(slug) ?? {},
        statusLabel:   eventStatusLabelBySlug.get(slug) ?? null,
      })))
    : null

  const analytics = buildDashboardAnalytics(scopedSlugs.map(slug => ({
    slug,
    eventName:     eventNameBySlug.get(slug) ?? 'Untitled Event',
    status:        eventStatus.get(slug) ?? null,
    // Absent from the map ⇒ the event has no configured passes, so there is nothing to
    // value; present ⇒ the measured split, or null when it could not be read.
    passValue:     valueByPass.has(slug) ? valueByPass.get(slug)! : {},
    passConfirmed: (counterBySlug.get(slug)?.passCounts ?? {}) as Record<string, number>,
    // Absent from the map ⇒ nothing to attribute (no cancellations); present ⇒ the computed
    // split, or null when it could not be completed.
    passCancelled: cancelledByPass.has(slug) ? cancelledByPass.get(slug)! : {},
    passNames:     passNamesBySlug.get(slug) ?? {},
    // Carried for shape completeness. This pass never feeds Event Performance — the cross-event
    // pass above does — so the label is unused here rather than absent.
    statusLabel:   eventStatusLabelBySlug.get(slug) ?? null,
  })))

  const registrationStatus = analytics.registrationStatus
  const passDistribution   = analytics.passDistribution

  // ── Communications ─────────────────────────────────────────────────────────

  // Every count arrives already measured-or-null from the reader; nothing is defaulted to
  // zero here. `?? 0` on an unread aggregate is the single line that produced four false
  // zeros on this card, so there is deliberately not one anywhere below.
  const communications = {
    ...commUsage,
    // The event's own communication spend in event mode — NOT the workspace figure that
    // feeds the settlement card below. Same field, two scopes, computed separately so
    // neither can borrow the other's meaning.
    costPaise: scoped
      ? commSpendOf(selectedDraft)
      : communicationCostPaise,
  }

  // ── Workspace health ───────────────────────────────────────────────────────
  //
  // Costs NOTHING extra: the profile document and every draft are already in hand, and
  // `evaluatePublishRequirements` is pure computation over them. No query, no aggregate.
  //
  // The event side runs the SAME evaluator the publish flow runs, so a gap this card calls
  // "required" is exactly one the platform would block a publish on. It is applied only to
  // PUBLISHED events: a draft with unfinished configuration is a draft, not a defect.

  const branding    = (profile.branding            as Record<string, unknown>) ?? {}
  const orgProfile  = (profile.organizationProfile as Record<string, unknown>) ?? {}
  const commsConfig = (profile.communications      as Record<string, unknown>) ?? {}

  const publishedGaps = publishedDrafts.map(d => {
    const failing = evaluatePublishRequirements({
      pricing:          d.pricing          as Record<string, unknown> | null | undefined,
      eventDetails:     d.eventDetails     as Record<string, unknown> | null | undefined,
      registrationForm: d.registrationForm as Record<string, unknown> | null | undefined,
    }).filter(r => !r.passed)
    const det  = (d.eventDetails as Record<string, unknown> | undefined) ?? {}
    const info = (det.info as Record<string, unknown> | undefined) ?? {}
    return {
      draftId:  typeof d.id === 'string' ? d.id : '',
      name:     typeof info.name === 'string' && info.name.trim() ? info.name : 'Untitled Event',
      critical: failing.filter(r => severityOf(r) === 'critical').length,
      warning:  failing.filter(r => severityOf(r) !== 'critical').length,
    }
  }).filter(g => g.critical > 0 || g.warning > 0)

  const workspaceHealth = buildWorkspaceHealth({
    profile: {
      organizationName: typeof profile.organizationName === 'string' ? profile.organizationName : null,
      supportEmail:     typeof orgProfile.supportEmail === 'string' ? orgProfile.supportEmail : null,
      logoUrl:          typeof branding.logoUrl === 'string' ? branding.logoUrl : null,
      certSignatureUrl: typeof branding.certSignatureUrl === 'string' ? branding.certSignatureUrl : null,
      // Passed through as STORED — undefined when the organizer never opened the setting.
      // The default lives in the pure module, beside the note explaining why it is `true`.
      sendRegistrationConfirmation: typeof commsConfig.sendRegistrationConfirmation === 'boolean'
        ? commsConfig.sendRegistrationConfirmation
        : undefined,
    },
    events: { publishedCount: publishedDrafts.length, gaps: publishedGaps },
  })

  // ── License entitlement ────────────────────────────────────────────────────
  //
  // Resolved against the effective catalog for EACH license's own stored version, so a
  // historical V1 license and a current V2 one both report their real limits. Nothing here
  // is hardcoded; the catalogs come from the config engine (60s cached), so this costs no
  // Firestore round trip of its own.
  const license: DashboardLicense = await (async (): Promise<DashboardLicense> => {
    const empty = (scopeKind: 'event' | 'workspace'): DashboardLicense => ({
      scope: scopeKind, tier: '', tierName: '', status: 'none',
      used: 0, limit: null, remaining: null, percentUsed: null,
      upgrade: null, expiresAt: null, eventCount: 0, unavailable: true,
    })
    const scopeKind: 'event' | 'workspace' = scoped ? 'event' : 'workspace'
    if (licenseSlugs.length === 0) return empty(scopeKind)

    try {
      const [cat1, cat2] = await Promise.all([getLicenseCatalog(), getLicenseCatalogV2()])

      interface Row { tier: string; name: string; limit: number; used: number; status: string
                      expiresAt: string | null; next: { tier: string; name: string } | null }
      const rows: Row[] = []

      licenseSnaps.forEach((snap, i) => {
        if (!snap.exists) return                       // event has no license doc yet
        const d       = snap.data() as Record<string, unknown>
        // RD-EVENT-COMMERCE-04 — a capacity-model licence carries the free tier ONLY as a
        // compatibility stamp: its entitlement is the capacity it BOUGHT, and there is no tier
        // to upgrade to (capacity is added on the event's License & Services page). Reading it
        // through the tier catalog showed "Free · 200 · Upgrade to Starter".
        if (d.commercialModel === 'capacity') {
          const cap = d.capacity
          if (!(typeof cap === 'number' && Number.isInteger(cap) && cap > 0)) return   // never guessed
          rows.push({
            tier: 'capacity', name: 'Capacity licence', limit: cap,
            used:   counterMap.get(licenseSlugs[i]) ?? 0,
            status: typeof d.status === 'string' ? d.status : 'active',
            expiresAt: tsToDate(d.expiresAt)?.toISOString() ?? null,
            next:   null,
          })
          return
        }
        const version = typeof d.version === 'number' && d.version >= 1 ? d.version : 1
        const tier    = isValidTierForVersion(d.tier, version) ? (d.tier as string) : null
        if (!tier) return                              // unrecognised tier — never guessed
        const entry = resolveLicenseEntryForVersion(cat1, cat2, tier, version as 1 | 2)
        rows.push({
          tier,
          name:   `${entry.name} (legacy)`,
          limit:  entry.registrationLimit,
          used:   counterMap.get(licenseSlugs[i]) ?? 0,
          status: typeof d.status === 'string' ? d.status : 'active',
          expiresAt: tsToDate(d.expiresAt)?.toISOString() ?? null,
          // RD-EVENT-COMMERCE-05 — a historical tier licence is shown as LEGACY and offered no
          // "Upgrade to <tier>": tiers are no longer sold.
          next:   null,
        })
      })

      if (rows.length === 0) return empty(scopeKind)

      // WORKSPACE scope sums the entitlements, because one event = one license: the
      // workspace's total permitted registrations IS the sum of its licenses. Any single
      // unlimited license makes the total unlimited — Infinity does not sum meaningfully,
      // and "unlimited + 500" is still unlimited.
      const anyUnlimited = rows.some(r => isUnlimited(r.limit))
      const used  = rows.reduce((n, r) => n + r.used, 0)
      const limit = anyUnlimited ? null : rows.reduce((n, r) => n + r.limit, 0)

      // The PLAN NAME shown is the highest-entitlement license — the one that actually
      // determines what the workspace can do. Ranked by limit, never by tier name.
      const headline = rows.reduce((best, r) =>
        (isUnlimited(r.limit) ? Number.MAX_SAFE_INTEGER : r.limit) >
        (isUnlimited(best.limit) ? Number.MAX_SAFE_INTEGER : best.limit) ? r : best, rows[0])

      const remaining   = limit === null ? null : Math.max(0, limit - used)
      const percentUsed = limit === null || limit <= 0 ? null
        : Math.min(100, Math.round((used / limit) * 1000) / 10)

      return {
        scope:      scopeKind,
        tier:       headline.tier,
        tierName:   headline.name,
        status:     headline.status,
        used, limit, remaining, percentUsed,
        // An upgrade is offered ONLY when a higher tier genuinely exists. On the top tier
        // there is nothing to sell, and a dead "Upgrade" button is worse than none.
        upgrade:    headline.next,
        expiresAt:  headline.expiresAt,
        eventCount: rows.length,
        unavailable: false,
      }
    } catch {
      // A failed catalog/licence read is UNKNOWN, not zero. Zero would read as a plan with
      // no entitlement left and push the organizer toward an upgrade they may not need.
      return empty(scopeKind)
    }
  })()

  // ── Fees & payout ──────────────────────────────────────────────────────────
  const feePlatform = ledger
    ? (() => {
        const base = ledgerMoney(ledger.platformFeeBase)
        const gst  = ledgerMoney(ledger.platformFeeGst)
        return base === null || gst === null ? null : base + gst
      })()
    : null
  const feeGatewayEst = ledger ? ledgerMoney(ledger.gatewayEstimate) : null
  // The resolved figure — NOT the estimate. Identical to it while nothing is reconciled,
  // and correct the moment anything is, without this file changing again.
  const feeGateway    = ledger ? ledgerMoney(ledger.gateway.fee) : null
  const fees: DashboardFees = {
    scope:                scoped ? 'event' : 'workspace',
    netPayoutPaise:       ledger ? ledgerMoney(ledger.organizerPayable) : null,
    platformFeePaise:     feePlatform,
    gatewayEstimatePaise: feeGatewayEst,
    gatewayActualPaise:   ledger ? ledgerMoney(ledger.gatewayActual) : null,
    gatewayFeePaise:      feeGateway,
    gatewayBasis:         ledger ? ledger.gateway.basis : 'estimated',
    gatewayTaxPaise:      ledger ? ledgerMoney(ledger.gateway.tax) : null,
    gatewayCoverage:      ledger ? ledger.gateway.coverage : { withActual: null, total: null },
    // Built from the RESOLVED gateway fee so the total never lags the components.
    totalFeesPaise:       feePlatform !== null && feeGateway !== null ? feePlatform + feeGateway : null,
    transactions:         ledger ? ledger.transactions : null,
    unavailable:          ledger === null,
  }

  // ── Reversals ──────────────────────────────────────────────────────────────
  // The cancelled VALUE is summed from the amounts actually on the cancelled
  // registrations — NOT cancelledCount multiplied by the current pass price, which would
  // silently drift the moment a price changed and would misreport every historical
  // cancellation.
  //
  // One indexed sum() per figure, no documents transferred. Both resolve to null rather
  // than 0 on failure: "we could not measure this" and "nothing was cancelled" must stay
  // distinguishable.
  const reversals: DashboardReversals = {
    // From the counters already read for this dashboard — no query of its own.
    cancelledCount: scopedSlugs.reduce((n, sl) => n + (counterBySlug.get(sl)?.cancelledCount ?? 0), 0),
  }

  // ── Assemble and return ────────────────────────────────────────────────────

  // License summary + events needing attention (pending / changes-requested /
  // rejected) — derived from the drafts already loaded (no extra reads).
  const licenseSummary = {
    pendingApproval:  drafts.filter(d => deriveLifecycleStatus(d) === 'pending_review').length,
    changesRequested: drafts.filter(d => deriveLifecycleStatus(d) === 'changes_requested' || d.reviewStatus === 'changes_requested').length,
    published:        drafts.filter(d => deriveLifecycleStatus(d) === 'published').length,
    rejected:         drafts.filter(d => d.reviewStatus === 'rejected').length,
  }

  const actionEvents: DashboardActionEvent[] = drafts
    .filter(d => {
      const ls = deriveLifecycleStatus(d)
      return ls === 'pending_review' || ls === 'changes_requested' || d.reviewStatus === 'rejected'
    })
    .map(d => {
      const det  = (d.eventDetails as Record<string, unknown>) ?? {}
      const info = (det.info as Record<string, unknown>) ?? {}
      return {
        draftId:         d.id as string,
        name:            typeof info.name === 'string' ? info.name : 'Untitled Event',
        slug:            slugOfDraft(d),
        lifecycleStatus: deriveLifecycleStatus(d),
        reviewStatus:    d.reviewStatus === 'rejected' ? 'rejected' as const
          : d.reviewStatus === 'changes_requested' ? 'changes_requested' as const : null,
      }
    })
    .slice(0, 10)

  // RD-DASH-13 §3A · `recentTransactions` is gone with the query that fed it. See the
  // note in batch 1: twelve wallet documents were read and serialised on every load for a
  // field no client rendered.

  // ── RD-DASHBOARD-02 · intelligence, deltas and the finance gate ────────────

  // Event signals, built from data already loaded — no additional reads.
  // Attention signals and the upcoming list are EVENT-scoped in event mode: an alert
  // about a different event has no business appearing under this event's heading.
  const signalSource = scoped ? (selectedDraft ? [selectedDraft] : []) : drafts
  const signalEvents: EventSignalInput[] = signalSource.map(d => {
    const det     = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (det.info as Record<string, unknown>) ?? {}
    const sched   = (det.schedule as Record<string, unknown>) ?? {}
    const pricing = (d.pricing as Record<string, unknown>) ?? {}
    const passes  = Array.isArray(pricing.passes) ? pricing.passes : []
    const slug    = slugOfDraft(d)
    return {
      draftId:         d.id as string,
      name:            typeof info.name === 'string' ? info.name : 'Untitled Event',
      slug,
      lifecycleStatus: deriveLifecycleStatus(d),
      status:          d.status === 'published' ? 'published' : 'draft',
      startDate:       typeof sched.startDate === 'string' ? sched.startDate : null,
      // The canonical registration close date — the same field lib/registrations/gate.ts
      // reads, so an alert here can never disagree with whether the gate is actually open.
      regCloseDate:    typeof pricing.registrationEndDate === 'string' ? pricing.registrationEndDate : null,
      registered:      slug ? (counterMap.get(slug) ?? 0) : 0,
      // RD-FIN-02 · was draft `eventDetails.capacity.totalCapacity` — a field nothing writes, so the
      // nearly-full / pace signals never fired. Now the enforced capacity, like every other figure.
      capacity:        capacityOf(slug),
      passCount:       passes.length,
      reviewStatus:    d.reviewStatus === 'rejected' ? 'rejected' as const
        : d.reviewStatus === 'changes_requested' ? 'changes_requested' as const : null,
    }
  })

  // Pace comes from the rollups already in hand, and those now carry an event dimension —
  // so in event mode this is the SELECTED event's pace, not the workspace's. Attributing a
  // workspace pace to one event was the fabrication this dimension was added to prevent.
  const attention = buildAttention({ events: signalEvents, now: nowMs })
  const upcoming  = buildUpcoming(signalEvents, nowMs)

  // ═══ LEGACY ALERTS, MERGED — NOT DROPPED ═══════════════════════════════════
  // The previous dashboard had its own `alerts` array with four hardcoded types.
  // `buildAttention` supersedes two of them (nearly_full, reg_closing_soon) with the
  // same rules expressed deterministically — but the other two, `cert_missing` and
  // `comm_payment_pending`, are REAL signals derived from data the engine does not
  // see (certificate templates, communication billing).
  //
  // Deleting the array would have silently removed two working warnings, so those two
  // are folded into the one list the UI renders instead. The duplicated pair is
  // dropped, because emitting the same warning twice under two headings is worse than
  // either alone.
  const SUPERSEDED = new Set(['nearly_full', 'reg_closing_soon'])
  const mergedAttention: AttentionSignal[] = [
    ...attention,
    ...alerts
      // Two filters, both load-bearing: SUPERSEDED drops the pair `buildAttention`
      // already emits, and the scope check keeps another event's warning off this
      // event's screen. Every legacy alert names its event, so none is scope-ambiguous.
      .filter(a => !SUPERSEDED.has(a.type))
      .filter(a => !scoped || a.eventDraftId === requestedEventId)
      .map((a, i): AttentionSignal => ({
        id:          `legacy:${a.type}:${i}`,
        severity:    a.severity === 'critical' ? 'critical' : 'warning',
        title:       a.title,
        detail:      a.meta,
        eventId:     null,
        actionHref:  a.type === 'cert_missing'
          ? '/dashboard/communications/certificates'
          : '/dashboard/events',
        actionLabel: a.type === 'cert_missing' ? 'Set up' : 'Open',
      })),
  ].sort((a, b) => {
    const rank = { critical: 0, warning: 1, info: 2 } as const
    return rank[a.severity] - rank[b.severity]
  })

  // ═══ RD-DASH-13 §4 · THE TREND WINDOWS, RESOLVED SERVER-SIDE ═══════════════
  // Same slices, same reduce, same `computeDelta` the panel imported — run once here
  // instead of on every range toggle, and emitted as facts rather than as a series the
  // component is expected to do arithmetic on.
  const TREND_RANGES = [7, 30, 90] as const
  const trendRanges: DashboardTrendRange[] = TREND_RANGES.map(days => {
    const cur  = dailySeries.slice(-days)
    const prev = dailySeries.slice(-days * 2, -days)
    const sumC = (xs: typeof dailySeries) => xs.reduce((n, d) => n + d.confirmed, 0)
    const sumR = (xs: typeof dailySeries) => xs.reduce((n, d) => n + d.revenuePaise, 0)
    return {
      days,
      registrations: { total: sumC(cur), delta: computeDelta(sumC(cur), sumC(prev)) },
      ...(financeAllowed
        ? { revenue: { totalPaise: sumR(cur), delta: computeDelta(sumR(cur), sumR(prev)) } }
        : {}),
    }
  })

  // Period-over-period: the most recent 30 covered days against the 30 before them.
  // Computed from the rollups, so it is exact rather than sampled.
  const last30  = dailySeries.slice(-30)
  const prev30  = dailySeries.slice(-60, -30)
  const cur     = last30.reduce((a, p) => ({ c: a.c + p.confirmed, r: a.r + p.revenuePaise }), { c: 0, r: 0 })
  const prv     = prev30.reduce((a, p) => ({ c: a.c + p.confirmed, r: a.r + p.revenuePaise }), { c: 0, r: 0 })

  // ═══ THE FINANCE GATE ═══════════════════════════════════════════════════════
  // Resolved SERVER-SIDE from the caller's own permissions. `transactions` is the
  // who may see money. Omission, not zeroing — see FinanceGate.

  const data: DashboardData = {
    organizer: {
      name:    typeof profile.name             === 'string' ? (profile.name             as string) : '',
      orgName: typeof profile.organizationName === 'string' ? (profile.organizationName as string) : '',
      logoUrl: typeof branding.logoUrl         === 'string' ? (branding.logoUrl         as string) : null,
    },
    license,
    reversals,
    scope: {
      mode:      scoped ? 'event' : 'all',
      eventId:   requestedEventId,
      eventSlug: selectedSlug,
      eventName: selectedName,
      eventType:          selectedType,
      eventSubtype:       selectedSubtype,
      eventCustomSubtype: selectedCustomSub,
      eventLifecycle: selectedLifecycle,
      eventPublished: scoped ? !selectedUnpublished : true,
      // Named explicitly so the client never has to guess which figures are which.
      // `communications` LEFT this list once the composite indexes existed. The UI reads the
      // list rather than a hardcoded copy, so the "All events" pill disappeared from that
      // card by itself — which is the whole reason the list is server-owned.
      workspaceOnly: scoped
        ? (ledger !== null
            // Settlement money is the SELECTED EVENT's, so the card no longer wears the
            // workspace label. The wallet balance still does — one wallet per organizer —
            // and the communication-cost ROW carries its own scope, since billing has no
            // per-event rollup to narrow.
            ? ['wallet', 'health', 'pendingReview']
            : ['wallet', 'settlement', 'health', 'pendingReview'])
        : [],
    },
    finance: { allowed: financeAllowed },
    trendUnavailable: trendUnavailable,
    historySince:     coverage.since,
    historyPartial:   coverage.partial,
    attention: mergedAttention,
    upcoming,
    deltas: {
      registrations: computeDelta(cur.c, prv.c),
      ...(financeAllowed ? { revenue: computeDelta(cur.r, prv.r) } : {}),
    },
    overview: {
      activeEvents:       activeEvents,
      totalRegistrations: totalRegs,
      todayRegistrations: todayRegs,
      todayCheckins:      todayCheckins,
      // The `<1%` rule is not a nicety: 2 check-ins against 420 registrations rounds to 0,
      // and "0% of all registrations" printed beside the number 2 says the two disagree.
      // Resolved here so the surface renders a number rather than deciding one.
      todayCheckinShare:
        todayCheckins === null || totalRegs <= 0 || todayCheckins === 0
          ? null
          : Math.max(Math.round((todayCheckins / totalRegs) * 100), 1),

      monthRegistrations: monthRegs,
      ...(financeAllowed ? {
        totalRevenuePaise: totalRevPaise,
        todayRevenuePaise: todayRevPaise,
        monthRevenuePaise: monthRevPaise,
      } : {}),
    },
    // Money — spread in ONLY when permitted, so an unauthorized caller receives a
    // payload with no financial keys at all rather than zeroed ones.
    ...(financeAllowed ? {
      // RD-DASH-12 · `fees` was OUTSIDE this block. It is money, and it now travels with
      // the rest of it.
      fees,
      settlement: {
        scope:                  scoped ? 'event' : 'workspace_lifetime',
        attendeePaidPaise:      attendeePaidRead ? ledgerMoney(attendeePaidRead.totalPaise) : null,
        ticketValuePaise:       ledger ? ledgerMoney(ledger.grossPaise) : null,
        platformFeeBasePaise:   ledger ? ledgerMoney(ledger.platformFeeBase) : null,
        platformFeeGstPaise:    ledger ? ledgerMoney(ledger.platformFeeGst) : null,
        platformFeeTotalPaise:  ledger ? ledgerMoney(ledger.platformFeeTotal) : null,
        gatewayFeePaise:        ledgerGateway ? ledgerMoney(ledgerGateway.fee) : null,
        gatewayTaxPaise:        ledgerGateway ? ledgerMoney(ledgerGateway.tax) : null,
        gatewayFeeBasis:        ledgerGateway ? ledgerGateway.basis : 'estimated',
        totalFeesPaise:         ledger ? ledgerMoney(ledger.totalFees) : null,
        refundsPaise:           refundRead ? ledgerMoney(refundRead.amount) : null,
        refundCount:            refundRead ? refundRead.count : null,
        organizerPayablePaise:  ledger ? ledgerMoney(ledger.organizerPayable) : null,
        communicationCostPaise,
        communicationCostScope,
      },
      walletBalancePaise,
    } : {}),
    activity,
    activityPage: {
      pageSize:   activityPageResult.pageSize,
      hasMore:    activityPageResult.hasMore,
      nextCursor: activityPageResult.nextCursor,
      exact:      activityPageResult.exact,
      unavailable: activityPageResult.unavailable,
    },
    ...(activitySkipped > 0 ? { activitySkipped } : {}),
    events,
    trendDays,
    trendRanges,
    passDistribution,
    registrationStatus,
    // RD-DASH-13 §4 · resolved server-side so no card reduces its own rows.
    passTotals:               analytics.passTotals,
    // RD-DASH-13 · the waitlist aggregate failed for at least one event in scope. Every
    // OTHER status stays a measured count — see EventStatusCounts.
    waitlistUnavailable:      analytics.waitlistUnavailable,
    registrationTotals:       analytics.totals,
    // ═══ THE CROSS-EVENT EXCEPTION ═══════════════════════════════════════════
    // Event Performance compares the organizer's events against each other, so it is
    // built from the FULL slug set even when the dashboard is scoped to one event.
    // Scoping it would reduce it to a single bar and destroy the only thing it is for.
    // Every OTHER breakdown above follows scopedSlugs.
    //
    // TODO (RD-DASH-02 finding, RE-VERIFIED empirically by RD-DASH-10, deliberately NOT
    // fixed here): the comparison includes obvious test and throwaway events, which rank
    // beside real ones. The event model carries NO authoritative test / internal /
    // environment / demo flag — only lifecycle and archive state, both of which are already
    // applied. Inventing a flag (name matching, registration-count thresholds) would be a
    // heuristic masquerading as data, so the events stay until a classification exists.
    //
    // RD-DASH-10 audited EVERY field on every draft in production against a candidate
    // pattern (test|demo|sandbox|internal|environment|staging|mock|…): zero matches across
    // all 29 top-level draft fields. The one authoritative field that CORRELATES on the
    // audited workspace is `visibility` — the real event is 'public', the throwaway ones
    // are 'private' — and it is deliberately NOT used: a private event is a genuine event
    // with a restricted audience, so filtering on it would hide real corporate events. A
    // correlation is not a classification.
    eventPerformance:         (crossEventAnalytics ?? analytics).eventPerformance,
    eventPerformanceMeta:     (crossEventAnalytics ?? analytics).eventPerformanceMeta,
    analyticsUnavailable:     analytics.statusUnavailable,
    // False for event types that have no passes at all — the panel says so rather than
    // rendering one unnamed bar that reads as a distribution.
    passDataAvailable:        analytics.passDataAvailable,
    // True when per-pass ticket value could not be measured for an event in scope — the
    // panel then omits the money rows instead of printing ₹0.
    passValueUnavailable:     analytics.passValueUnavailable,
    passCancelledUnavailable: analytics.passCancelledUnavailable,
    broadcasts,
    checkIn,
    communications,
    workspaceHealth,
    licenseSummary,
    actionEvents,
    couponPerformance,
  }

  return NextResponse.json(data)
}
