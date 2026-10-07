// Per-event analytics — server-only.
//
// RD-ANALYTICS-03 · this module NO LONGER READS REGISTRATION DOCUMENTS. Counts come from
// count() aggregates (aggregateRegistrationStatusCounts, getRegistrationSplit), per-pass
// figures from the registrationCounters document and budgeted sum() aggregates, and the
// day series from the organizerDailyStats rollups — the same sources the organizer
// Dashboard reads. The cost of this endpoint is now independent of how many people
// registered: a 100,000-person event costs what a 100-person one costs.
//
// Money remains on the canonical finance readers (RD-ANALYTICS-02) and is only READ when
// the caller holds `transactions`. Where a data source doesn't exist (traffic sources,
// cert verifications, SMS) the result flags it so the UI shows "no data" rather than a
// fabricated number, and where one is still capped it says so in `limits`.

import { adminDb } from '@/lib/firebase/admin'
import { resolveEventCapacitySummary } from '@/lib/registrations/capacity'
import { readReportFromLedgerData } from '@/lib/platform/pricing'
import { COLLECTIONS as CERT_COLLECTIONS } from '@/lib/certificates/constants'
import { getCouponPerformance, EMPTY_COUPON_PERFORMANCE, type CouponPerformance } from './couponPerformance'
import {
  sumConfirmedRevenueFromLedgerChecked, aggregateRegistrationStatusCounts,
  getRegistrationCounter,
} from '@/lib/firebase/firestore/registrationCounters'
import { getRegistrationSplit } from '@/lib/finance/financeAnalytics'
import { readDailyStats, readCoverage } from '@/lib/dashboard/dailyStatsAdmin'
import {
  readCommunicationCounts, readCommunicationSpend,
  readCampaignCounts, readCommunicationSignals, readWindowedCommunicationCounts,
  type CommunicationCounts,
} from '@/lib/analytics/communicationsSources'
import { buildCommunicationIntelligence } from '@/lib/analytics/communicationIntelligence'
import {
  readRegistrationSourceComposition, type RegistrationSourceComposition,
} from '@/lib/analytics/participantsSources'
import {
  resolveOperationalCapabilities, readIdentifierProgress, readTimingProgress,
  NO_OPERATIONAL_CAPABILITIES,
  type OperationalCapabilities, type IdentifierProgress, type TimingProgress,
} from '@/lib/analytics/operationsSources'
import { resolveCoverage, dayKey, type DailyStatsPoint } from '@/lib/dashboard/dailyStats'
import {
  presetRange, rangeDayKeys, DEFAULT_PRESET, type AnalyticsDateRange,
} from '@/lib/analytics/dateRange'
import { previousPeriod } from '@/lib/analytics/comparison'
import {
  istRangeBounds, revenueVelocity, averageOrderValue, refundRate, refundsInPeriod,
  revenueBeforeDiscount,
} from '@/lib/analytics/revenueIntelligence'
import type { RevenueIntelligence, CommunicationIntelligence } from '@/lib/analytics/contract'
import { aggregateValueByPass } from '@/lib/analytics/registrationPassAggregates'
import type { PaymentStatus } from '@/lib/registrations/types'
import { readRefundSource, refundTotalsFromRead, refundsAgainstConfirmedPaise, money, gone, type MaybeMoney } from '@/lib/finance/financeAnalytics'

/**
 * RD-ANALYTICS-03 · the registration SCAN is gone. This cap now bounds only the
 * secondary collections that still have no aggregate form.
 *
 * ═══ WHAT IT USED TO DO ══════════════════════════════════════════════════════
 * `registrations` was read with .limit(CAP + 1) and every count, chart, funnel step and
 * per-pass figure was derived by iterating those documents. Above 5,000 the page reported
 * a SAMPLE as a total: a 20,000-person event showed roughly a quarter of itself, and a
 * 100,000-person event a twentieth. Raising the number would have moved the lie, not
 * removed it — the defect was deriving event-wide totals from a page of documents.
 *
 * Nothing in the registration/status/trend path reads a registration document any more.
 * See getEventAnalytics for the replacement sources.
 */
const CAP = 5000

/**
 * RD-ANALYTICS-07 · the window is now the CALLER'S, not a constant.
 *
 * ═══ THE DEFECT THIS CLOSES ══════════════════════════════════════════════════
 * The window was hard-coded at 30 days while the Overview's range control moved only the
 * LABELS. Selecting "7D" re-rendered the header as "Last 7 days · 08-30 to 09-05" above a
 * chart still showing thirty bars from 7 Aug, with a 30-day total beneath it. Every figure
 * was individually true and the screen as a whole was a lie.
 *
 * A range is therefore a parameter, and the default is the shared model's own default so
 * an omitted range means the same thing here as it does everywhere else.
 */
const DEFAULT_RANGE = () => presetRange(DEFAULT_PRESET)

/**
 * Add two channel figures, preserving "unmeasured".
 *
 * If either side could not be read the total is unknown — not the other side's value, which
 * would silently report one channel's traffic as the event's whole communication history.
 */
const sumCounts = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : a + b

/**
 * The payment statuses to count, i.e. every member of the canonical `PaymentStatus` union.
 * The `satisfies` clause is load-bearing: adding a status to the union without adding it
 * here fails the build rather than silently dropping a bucket out of the breakdown.
 */
const PAYMENT_STATUSES = [
  'not_required', 'pending', 'paid', 'refund_pending', 'refunded',
] as const satisfies readonly PaymentStatus[]

/**
 * Aggregate budget for the per-pass value split, mirroring the dashboard's use of the same
 * helper. Two sum() aggregates per pass; the helper reports `complete: false` rather than
 * returning a partial map that would under-report a pass.
 */
const PASS_VALUE_BUDGET = 60

export interface Point { label: string; value: number }

/**
 * RD-ANALYTICS-05 · a day-series point that still knows WHICH day it is.
 *
 * The three day series are built from organizerDailyStats rows, every one of which carries
 * a `day` key — and the series then threw it away, keeping only the "6/15" display label.
 * That made the date unrecoverable downstream except by counting positions from the end of
 * the array, which is exactly the kind of positional assumption that silently mislabels a
 * chart the day the window length changes.
 *
 * Additive: `label` and `value` are untouched, so every existing consumer and every chart
 * primitive that takes `{ label, value }[]` keeps working unchanged.
 */
export interface DayPoint extends Point { date: string }

/**
 * RD-ANALYTICS-07 · totals over ONE window, summed from the daily rollups.
 *
 * The unit of comparison. Each field is `number | null`: null means the rollups for that
 * window could not be read, and a delta must not be computed against it — which is a
 * different thing from a window that genuinely saw no activity and sums to 0.
 *
 * `revenuePaise` is ABSENT rather than null for a caller without `transactions`. The
 * rollup document carries confirmed, cancelled, revenue and check-ins together, so there is
 * no separate financial query to withhold; what is withheld is the FIELD, dropped at the
 * read boundary before any object that could be serialised is built.
 */
export interface PeriodTotals {
  confirmed:     number | null
  /**
   * RD-ANALYTICS-08 · cancellations RECORDED in the window.
   *
   * Deliberately not netted against `confirmed`. The rollup writer attributes a
   * cancellation to the day it happened while reversing the original day's confirmed
   * count, so the two fields answer different questions — "how many joined in this window"
   * and "how many left during it" — and subtracting one from the other would produce a
   * third number that describes neither.
   */
  cancelled:     number | null
  checkedIn:     number | null
  revenuePaise?: number | null
}

/**
 * RD-ANALYTICS-02 · the financial half of the payload, on RegisterDesk's canonical bases.
 *
 * ═══ SIX DIFFERENT THINGS, NEVER RELABELLED AS EACH OTHER ════════════════════
 * The defect this closes was one number wearing several hats. The headline "Revenue"
 * summed `amount` over paymentStatus 'paid' — which counts a CANCELLED registration that
 * was paid, drops a CONFIRMED one that was later refunded, and was silently overwritten by
 * the gateway ledger's gross whenever that read happened to succeed. Three different
 * quantities took turns being "Revenue" depending on data the organizer could not see.
 *
 *   confirmedRevenue — Σ amount over CONFIRMED registrations. The canonical ticket revenue
 *                      Dashboard, Events and Finance already publish, read through the ONE
 *                      helper they use (sumConfirmedRevenueFromLedgerChecked). Refund-STABLE
 *                      by design: a refund leaves status 'confirmed' and does not change
 *                      `amount`, so this figure does not move when money goes back.
 *   gross            — what the payment ledger recorded for this event. A different
 *                      population (captures, not registrations) and never a substitute.
 *   platformFee/gst/gatewayFee/net — the ledger's own components, unchanged.
 *   refunds          — the gateway REFUND LEDGER via getRefundTotals, the canonical reader.
 *                      Not registration.paymentStatus, and not `refundAmount ?? amount`.
 *   communicationCost— event-scoped messaging spend.
 *
 * Every figure is MaybeMoney: `gone(reason)` when its source could not be read, so a failed
 * query can never present itself as a measured ₹0. That vocabulary is the finance module's
 * (lib/finance/gatewayFee), reused rather than re-invented.
 */
export interface EventAnalyticsFinancial {
  /**
   * A · canonical CONFIRMED ticket revenue. The figure Dashboard and Finance publish.
   *
   * RD-ANALYTICS-12-21 · the SAME quantity as the Organizer contract of the same name
   * (`EventListItem.confirmedRevenuePaise`): Σ `amount` over `status === 'confirmed'`,
   * integer paise, refund-stable, and gated on the same `transactions` permission. The
   * shared name is deliberate, not a collision.
   *
   * Two differences are intentional and do NOT change the definition:
   *   • Representation — Analytics publishes `MaybeMoney` and omits the whole `financial`
   *     block when the caller is not entitled; the Organizer routes publish `number | null`
   *     and use `null` for that denial.
   *   • Source path — Analytics reads the ledger aggregate on the common path, while the
   *     Organizer routes prefer the maintained `registrationCounters.revenuePaise` and fall
   *     back to that same aggregate when the counter is not current. The counter is a cache
   *     of exactly this aggregate, so the two reconcile; the difference is freshness.
   */
  confirmedRevenuePaise:  MaybeMoney
  /**
   * RD-ANALYTICS-09 · A less C — confirmed ticket revenue after completed refunds.
   *
   * A DIFFERENT question from A, which is refund-stable by design. Published only when both
   * inputs are measured; never a partial subtraction. See the derivation for why it is its
   * own field rather than a redefinition of A.
   */
  netRevenuePaise:        MaybeMoney
  /** B · gateway/ledger collection for this event. NOT interchangeable with the above. */
  grossPaise:             MaybeMoney
  platformFeePaise:       MaybeMoney
  gstPaise:               MaybeMoney
  gatewayFeePaise:        MaybeMoney
  /** F · the ledger's own net settlement — money the organizer receives from captures. */
  netPaise:               MaybeMoney
  /** C · COMPLETED refunds from the refund ledger. Never derived from a registration. */
  refundsPaise:           MaybeMoney
  /** How many completed refunds that amount covers. null ⇒ the ledger could not be read. */
  refundCount:            number | null
  communicationCostPaise: MaybeMoney
  /**
   * net settlement − completed refunds − communication spend.
   *
   * Published ONLY when all three inputs read successfully, because the subtraction is
   * meaningless across bases: subtracting a refund-ledger figure from a registration-derived
   * stand-in for net (which is what happened whenever the transactions read failed) produced
   * a number with no defensible interpretation, and it was labelled "Profit". There is no
   * canonical profit definition anywhere in this codebase to defer to, so when any input is
   * unavailable this is `gone` rather than a partial sum.
   */
  profitEstimatePaise:    MaybeMoney
  /**
   * RD-ANALYTICS-12-26 · derived intelligence — velocity, AOV, refund rate, refunds in the
   * window, ticket value before discount. Arithmetic over the figures above and the period
   * rollup; no new source, and every result inherits its inputs' absence. Definitions live
   * on the wire type (`RevenueIntelligence` in contract.ts).
   */
  intelligence:           RevenueIntelligence
}

/**
 * RD-ANALYTICS-01 · the identity an authorization decision needs, and nothing else.
 *
 * ONE document read, deliberately separated from getEventAnalytics so the route can decide
 * who the caller is allowed to be BEFORE paying for five collection scans. It returns the
 * two identifiers authorization is expressed in:
 *
 *   organizerUid — the workspace that owns the event (`events/{slug}` is the bridge doc).
 *   draftId      — the eventDraft id, which is what `teamMembers.eventIds` holds and what
 *                  isEventInScope() compares against. The route param is a SLUG, so passing
 *                  it to the scope check directly would compare a slug to draft ids and
 *                  never match a single assignment.
 */
export interface AnalyticsEventIdentity {
  organizerUid: string
  draftId:      string | null
  /**
   * RD-ANALYTICS-06 · capability signals read off the SAME document.
   *
   * The Overview needs an event type and the registration rules to decide which analytics
   * modules exist. Both are already on the bridge document this function reads, so they are
   * returned here rather than paid for with a second read in the route.
   *
   * Both default to null/absent, which fails CLOSED: an event whose type cannot be read
   * shows no type-exclusive panel, and one whose rules cannot be read shows no waitlist
   * panel. Guessing in the other direction would offer a module the event cannot support.
   */
  eventType:         string | null
  registrationRules: Record<string, unknown> | null
  /**
   * RD-ANALYTICS-12-32 · the `events/{slug}` document this identity was resolved from, so a
   * route that has already authorized against it can hand it to `getEventAnalytics` and the
   * producer does not read the same document a second time. Carried, never re-fetched.
   */
  document: Record<string, unknown>
}

export async function resolveAnalyticsEventIdentity(
  eventId: string,
): Promise<AnalyticsEventIdentity | null> {
  const snap = await adminDb.doc(`events/${eventId}`).get()
  if (!snap.exists) return null
  const ev = snap.data() as Record<string, unknown>
  const organizerUid = typeof ev.uid === 'string' ? ev.uid
    : typeof ev.organizerUid === 'string' ? ev.organizerUid : ''
  if (!organizerUid) return null

  const details = ev.eventDetails as Record<string, unknown> | undefined
  const info    = details?.info as Record<string, unknown> | undefined
  const eventType = typeof ev.eventType === 'string' ? ev.eventType
    : typeof info?.eventType === 'string' ? info.eventType : null

  const form  = ev.registrationForm as Record<string, unknown> | undefined
  const rules = form?.registrationRules
  const registrationRules =
    rules && typeof rules === 'object' ? rules as Record<string, unknown> : null

  return {
    organizerUid,
    draftId: typeof ev.draftId === 'string' ? ev.draftId : null,
    eventType,
    registrationRules,
    document: ev,
  }
}

export interface EventAnalytics {
  eventId:        string
  eventName:      string
  lifecycleStatus: string | null
  publishedAt:    string | null
  /**
   * RD-ANALYTICS-03 · retained, and now always FALSE for the registration path.
   *
   * It used to mean "this event has more than 5,000 registrations, so every count and chart
   * below under-reports". That cap is gone: counts come from aggregates, trends from the
   * daily rollups, and neither has a document ceiling. The field stays in the contract
   * because exports and the UI read it, and because the secondary collections named in
   * `limits` below are still capped — but it no longer describes the core figures.
   *
   * It is NOT hard-coded: `limits` is the live completeness state, and this mirrors it.
   */
  truncated:      boolean
  /**
   * Per-source completeness, replacing the single event-wide truncation flag.
   *
   * Each entry is TRUE when that source was read in full. The three collections listed
   * here still have no aggregate form and keep their existing caps — documented rather
   * than removed, because removing a limit without an aggregate to replace it would just
   * move the unbounded read somewhere else.
   */
  limits: {
    /** Always true now — the registration scan is gone. */
    registrations: true
    /** emailLogs, capped at CAP. */
    communications: boolean
    /**
     * RD-ANALYTICS-12-28 · reminder STATUS counts are aggregates now; this flag covers
     * only the recipient sum, which still needs the rows. False ⇒ the page overflowed
     * and `reminders.recipients` is null.
     */
    reminders:      boolean
    /**
     * RD-ANALYTICS-12-28 · `issued` is an aggregate; `downloaded` needs the rows. False ⇒
     * the page overflowed and `downloaded` is null — never the first CAP rows' figure.
     */
    certificates:   boolean
    /** platformTransactions, capped at CAP. */
    ledger:         boolean
    /** Per-pass value split — false when the aggregate budget could not cover the event. */
    passValue:      boolean
  }
  /**
   * RD-ANALYTICS-02 · did the caller hold the finance permission?
   *
   * Mirrors the dashboard's `finance.allowed` (RD-DASH-12). When false every money-bearing
   * field below is ABSENT — not zeroed, not nulled — so a client cannot render it and an
   * export cannot serialise it. `admin` and `manager` hold `events` but no `transactions`,
   * which is exactly the pairing that made this necessary.
   */
  financialAllowed: boolean
  /**
   * RD-ANALYTICS-07 · the window these day-series and period totals describe.
   *
   * Echoed back so a consumer can prove the data it received matches the range it asked
   * for, rather than inferring it from the array length.
   */
  range: AnalyticsDateRange
  /** Totals over `range`. Summed from the same rollup rows the series is drawn from. */
  period: PeriodTotals
  /**
   * Totals over the immediately preceding window of identical length.
   *
   * null when no trustworthy baseline exists — the rollups could not be read, or the
   * previous window begins before analytics coverage does. A missing baseline must never
   * be treated as a baseline of zero: "up from nothing" and "up from unknown" are
   * different claims, and only one of them is ours to make.
   */
  baseline: PeriodTotals | null
  /**
   * The earliest day the daily rollups cover for this workspace, `YYYY-MM-DD`.
   *
   * Workspace-level, because that is the granularity the coverage marker is written at.
   * It means exactly "analytics coverage begins here" — NOT the event's creation date,
   * NOT its first registration. Null only when the marker could not be read.
   */
  coverageSince: string | null
  /** True when the requested range begins before `coverageSince`. */
  coveragePartial: boolean
  /**
   * RD-ANALYTICS-07 · WHY there is no baseline, when there is none.
   *
   * True when the PRECEDING window begins before coverage — which is a different fact from
   * `coveragePartial`, and the two disagree in the common case: a 7-day window can sit
   * entirely inside recorded history while the 7 days before it lie entirely outside it.
   * Inferring the reason from `coveragePartial` would then tell the reader "no earlier
   * period exists" about an event that ran for months before the rollups started.
   */
  baselineOutsideCoverage: boolean
  /**
   * RD-ANALYTICS-03 · every count is `number | null`.
   *
   * They come from two aggregate reads now, and a failed aggregate must not present itself
   * as an event with no registrations — the same rule lib/analytics/dashboardAnalytics.ts
   * states as "MISSING DATA IS NEVER ZERO". null means the read failed; 0 means the count
   * was taken and it was zero.
   */
  kpis: {
    /** Every registration for the event, all statuses. From the status aggregate. */
    registrations: number | null
    confirmed:     number | null
    pending:       number | null
    cancelled:     number | null
    rejected:      number | null
    waitlisted:    number | null
    /** By paymentStatus. From the registration split aggregate. Composition bucket: paid AND not refunded. */
    paid:          number | null
    /** RD-FIN-02 · THE canonical "Paid registrations": charged (paid + refund_pending + refunded) — the Finance population. */
    paidCharged:   number | null
    free:          number | null
    /** Payment pending — NOT the same population as `pending` (registration status). */
    paymentPending: number | null
    refunded:      number | null
    /**
     * Registrations whose refund is IN FLIGHT. Counted separately from `refunded` because
     * the two used to be added together: a refund that has not completed is not money
     * returned, and reporting it as one overstated refunds on every event with an open case.
     */
    refundPending: number | null
    checkedIn:     number | null
    conversionPct: number | null
    capacity:      number | null
    capacityUsedPct: number | null
    remaining:     number | null
  }
  /**
   * RD-ANALYTICS-03 · from organizerDailyStats, not from registration documents.
   *
   * null ⇒ the rollups could not be read. A series of zeros would assert that nobody
   * registered on any of these days, which is not what a failed read means.
   *
   * SEMANTIC NOTE: the rollup counts CONFIRMED registrations per day (`DailyStatsDoc`
   * carries confirmed/cancelled/revenuePaise/checkedIn). The old in-memory bucket counted
   * registrations of EVERY status. This series now matches the Dashboard's exactly.
   */
  registrationsByDay: DayPoint[] | null
  /**
   * RD-ANALYTICS-08 · cancellations per day over the same window.
   *
   * Drawn from the rollup rows already read for the trend, so it costs nothing extra. Null
   * for the same reason  is null — the rollups could not be read — and
   * clipped at the same coverage floor.
   */
  cancellationsByDay: DayPoint[] | null
  /** Financial — absent without the finance permission. From the same daily rollups. */
  revenueByDay?:      DayPoint[] | null
  paymentStatus:      Point[]
  passSales:          Point[]
  /** Financial — absent without the finance permission. */
  passRevenue?:       Point[]
  /**
   * Coupon figures are the ONE part of this payload that `truncated` does not apply to.
   * They used to come from the capped registration scan below, which silently under-reported
   * every coupon number above CAP. They now come from the coupon documents plus a single
   * sum() aggregate, so they are exact at any event size — see lib/analytics/couponPerformance.
   */
  /**
   * Financial — absent without the finance permission.
   *
   * The whole coupon block is gated, redemption counts included. RD-DASH-12 already treats
   * `totalDiscountPaise` as money requiring `transactions`, and splitting the counts out
   * would mean changing the shared CouponPerformance type that the Dashboard renders — a
   * change to Dashboard financial behaviour this phase is not permitted to make. Gating the
   * block errs toward disclosing less; the counts can be separated later if organizers ask.
   */
  couponUsage?:        Point[]
  couponPerformance?:  CouponPerformance
  /** From the rollups' `checkedIn` counter. null ⇒ unreadable. */
  checkInsByDay:      DayPoint[] | null
  funnel:             Point[]
  /** Financial — ABSENT without the finance permission. See EventAnalyticsFinancial. */
  financial?: EventAnalyticsFinancial
  /**
   * RD-ANALYTICS-01 · null ⇒ the underlying read FAILED, so nothing is known.
   *
   * These three blocks each came from one `try { … } catch { }` that left every counter at
   * its initial 0, so "the query failed" and "nothing was sent" were the same payload. Null
   * follows the shape lib/analytics/dashboardAnalytics.ts already uses for the same problem
   * (`status: EventStatusCounts | null` — "null ⇒ nothing at all could be read"), rather
   * than introducing a second way to say "unknown".
   */
  /**
   * Delivery COUNTS only — the spend lives in `financial.communicationCostPaise`.
   *
   * RD-ANALYTICS-11 · each count is now `number | null`, because they come from independent
   * aggregates and one of them can fail while the others succeed. A failed aggregate must
   * not present itself as "no messages": the whole object being null already means "we could
   * not read communications at all", which is a different fact from "delivered is unknown".
   *
   * `failed` EXCLUDES transport timeouts. Those carry `deliveryUnknown` and are reported in
   * the per-channel breakdown as unknown, never asserted as non-delivery.
   */
  communication: {
    sent:      number | null
    failed:    number | null
    delivered: number | null
  } | null
  /**
   * RD-ANALYTICS-12-28 · status counts from `count()` aggregates (exact at any scale);
   * `recipients` is a sum over the rows and is null when the page overflowed.
   */
  reminders:     { scheduled: number; sent: number; failed: number; recipients: number | null } | null
  /** `issued` is an aggregate; `downloaded` is null when the certificate page overflowed. */
  certificates:  { issued: number; downloaded: number | null } | null
  dataFlags:     { trafficSources: 'no_data'; certificateVerifications: 'no_data'; sms: 'no_data' }
  /**
   * RD-ANALYTICS-10 · what this event is configured to do operationally, and how far it
   * has got. Capabilities always present (both false when unconfigured); the progress
   * objects only when their capability is on, because a bounded read is still a read.
   */
  operationalCapabilities: OperationalCapabilities
  /**
   * RD-ANALYTICS-11 · per-channel counts from aggregates. Null when the reads failed —
   * which is a different fact from a channel having sent nothing.
   */
  communicationCounts: CommunicationCounts | null
  /** Messaging spend. ABSENT (null) for a caller without `transactions`. */
  communicationSpend:  MaybeMoney | null
  /** RD-ANALYTICS-12-28 · campaigns, composition, provider signals, the window. No money. */
  communicationIntelligence: CommunicationIntelligence
  /**
   * RD-ANALYTICS-12-29 · registration composition by SOURCE, from equality aggregates on
   * `registrationSource`. Null when the collection could not be read at all — which is the
   * signal the route turns into "the Participants module has nothing to show". Reads no
   * `attendee.*`, no `formResponses`, no CRM: seats, never people.
   */
  registrationComposition: RegistrationSourceComposition | null
  /**
   * The event's duplicate rules, flattened from `registrationForm.registrationRules`. Null
   * when absent. Facts about the gate, published as such; never used to infer identity.
   */
  registrationIdentityRules: { limitPerEmail: boolean; limitPerMobile: boolean } | null
  identifierProgress: IdentifierProgress | null
  timingProgress:     TimingProgress | null
}

const tsMs = (v: unknown): number | null => {
  if (v && typeof (v as { toMillis?: () => number }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis()
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') return (v as { toDate: () => Date }).toDate().getTime()
  return null
}
const tsISO = (v: unknown): string | null => { const ms = tsMs(v); return ms == null ? null : new Date(ms).toISOString() }


/**
 * @param includeFinancial Whether the CALLER is entitled to money. Required, never defaulted:
 *   a default would be a fail-open default on an authorization boundary. When false the
 *   financial reads are not merely stripped from the response — they are never issued.
 */
export async function getEventAnalytics(
  eventId: string,
  { includeFinancial, range, comparison = true, eventDocument }: {
    includeFinancial: boolean
    /** The window to report on. Defaults to the shared model's default preset. */
    range?: AnalyticsDateRange
    /** Read the preceding window too. Costs one more bounded getAll of day ids. */
    comparison?: boolean
    /**
     * RD-ANALYTICS-12-32 · the `events/{slug}` document, when the caller already holds it
     * (`resolveAnalyticsEventIdentity().document`). Absent ⇒ read here, exactly as before.
     * This is a request-local hand-off, not a cache: the caller MUST have resolved it for
     * this same `eventId` in this same request, after its own authorization.
     */
    eventDocument?: Record<string, unknown>
  },
): Promise<{ analytics: EventAnalytics; organizerUid: string } | null> {
  let ev: Record<string, unknown>
  if (eventDocument) {
    ev = eventDocument
  } else {
    const evSnap = await adminDb.doc(`events/${eventId}`).get()
    if (!evSnap.exists) return null
    ev = evSnap.data() as Record<string, unknown>
  }
  const organizerUid = (typeof ev.uid === 'string' ? ev.uid : (typeof ev.organizerUid === 'string' ? ev.organizerUid : '')) as string
  const eventName = (((ev.eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined)?.name as string) || eventId
  // RD-FIN-02 · the same enforced capacity every surface shows (legacy-derived, pass-bounded when
  // uncapped) — was `totalCapacity` only when numeric, so legacy events read as uncapped here while
  // the gate enforced a limit. "Used" stays the confirmed count below (the counter's own definition).
  const capacity = resolveEventCapacitySummary({ eventDoc: ev, counter: null }).total

  // ── The scalable core (RD-ANALYTICS-03) ─────────────────────────────────────
  //
  // WHAT THIS REPLACES. One `.limit(5001)` read of the registrations collection, followed
  // by an in-memory loop that produced every count, every chart bucket, the payment-status
  // split, the per-pass figures and the funnel. Above the cap all of it silently described a
  // sample — and the sample was ordered by document id, so it was not even a recent one.
  //
  // Nothing below reads a registration document. Four reads, none of which scale with the
  // number of registrations:
  //
  //   status   7 count() aggregates          — zero documents transferred
  //   split    1 + N count() aggregates      — zero documents transferred
  //   counter  1 document (registrationCounters/{slug}) + its attendance shards
  //   daily    one getAll per window        — the rollup rows, one document per DAY
  //   coverage 1 document ({uid}__meta)      — where the rollups begin
  //
  // A 100,000-registration event costs exactly what a 100-registration one costs. Adding
  // the baseline costs one more document per day of the range — bounded by the WINDOW, not
  // by the event.
  const activeRange = range ?? DEFAULT_RANGE()
  const trendKeys   = rangeDayKeys(activeRange)
  const priorRange  = comparison ? previousPeriod(activeRange) : null
  const priorKeys   = priorRange ? rangeDayKeys(priorRange) : []

  const [status, split, counter, daily, priorDaily, coverageSinceRaw, opsCaps] = await Promise.all([
    // Total + every registration STATUS, from the same helper the registrations list and
    // the attendance dashboard use, so the three cannot disagree.
    aggregateRegistrationStatusCounts(organizerUid, eventId).catch(() => null),
    // Every paymentStatus, from the helper /api/organizer/finance already uses. Counts only
    // — no money crosses this call, so it is safe for a caller without `transactions`.
    getRegistrationSplit({ organizerUid, eventSlug: eventId, from: null, to: null }, PAYMENT_STATUSES)
      .catch(() => null),
    // passCounts (confirmed per pass) — maintained at write time, O(1) to read.
    getRegistrationCounter(eventId).catch(() => null),
    // The daily rollups. Keyed by SLUG (see dailyStatsDocId), which is exactly the
    // identifier this function already has, so no draft lookup is needed.
    readDailyStats(organizerUid, eventId, trendKeys).catch(() => null),
    // The baseline window. Skipped entirely when comparison is off.
    priorKeys.length ? readDailyStats(organizerUid, eventId, priorKeys).catch(() => null) : Promise.resolve(null),
    // Where coverage begins. ONE document; falls back to the rollup epoch, which is a real
    // date the rollups started on rather than an invented one.
    readCoverage(organizerUid).catch(() => null),
    // RD-ANALYTICS-10 · ONE configuration document. It decides whether the identifier and
    // timing panels exist at all, and what this event CALLS them. Never inferred from
    // eventType; a failed read yields no capabilities, so the panels are absent rather
    // than empty.
    resolveOperationalCapabilities(eventId),
  ])

  /**
   * RD-ANALYTICS-10 · the conditional operational reads.
   *
   * Issued only when the event's own configuration says the capability exists. That is the
   * whole reason the capability document is resolved first: an event that does not issue
   * identifiers must not pay for three aggregates asking how many it has assigned, and an
   * event without chips must not pay for three more. Both readers are bounded by
   * configuration rather than by participant volume, and both fail to null rather than to
   * zero.
   */
  const capabilities: OperationalCapabilities = opsCaps ?? NO_OPERATIONAL_CAPABILITIES
  /**
   * RD-ANALYTICS-11 · communication counts and spend.
   *
   * Counts are aggregates — uncapped, zero documents, independent of message volume — and
   * are read for every caller. SPEND is a sum() and is issued ONLY when the caller holds
   * `transactions`, so an unauthorized request never asks the database about money.
   */
  const [commCounts, commSpend, identifierProgress, timingProgress] = await Promise.all([
    readCommunicationCounts(eventId).catch(() => null),
    includeFinancial ? readCommunicationSpend(eventId).catch(() => null) : Promise.resolve(null),
    capabilities.identifiersEnabled
      ? readIdentifierProgress(organizerUid, eventId).catch(() => null)
      : Promise.resolve(null),
    capabilities.timingEnabled
      ? readTimingProgress(eventId).catch(() => null)
      : Promise.resolve(null),
  ])

  /**
   * RD-ANALYTICS-12-28 · communication intelligence reads. All aggregates, no money.
   *
   * ═══ THE WINDOW ══════════════════════════════════════════════════════════════
   * The same IST instants the refund window uses (`istRangeBounds`), applied to the log's
   * `createdAt`. A message written at 23:45 UTC belongs to the NEXT IST day, and the
   * bounds say so; the Reports UTC `rangeBounds` is not used here.
   *
   * ═══ THE BASELINE, AND WHY ITS REASON IS NOT THE ROLLUPS' ═══════════════════
   * The registration comparison refuses a baseline that predates the daily rollups
   * (`coverageSince`). The message log is not a rollup: it has recorded every attempt since
   * the platform began, so a preceding window is readable back to the event's own start.
   * What makes it meaningless is a window that ends before the event was PUBLISHED —
   * nothing could have been sent — and that is the refusal made here. No publish instant
   * ⇒ nothing is refused; an unread baseline explains itself as `no_baseline`.
   */
  const commWindow      = istRangeBounds(activeRange)
  const publishedMs     = tsMs(ev.publishedAt)
  const publishedDayKey = publishedMs == null ? null : dayKey(publishedMs)
  const commBaselineOutsideCoverage = Boolean(
    priorRange && publishedDayKey && priorRange.to < publishedDayKey)
  const commPriorWindow = priorRange && !commBaselineOutsideCoverage ? istRangeBounds(priorRange) : null

  /**
   * RD-ANALYTICS-12-29 · registration source composition. Twelve equality aggregates on
   * `registrationSource` (+ `status`), taken against the status totals read above so the
   * "unrecorded" remainder is measured against the same population every module uses.
   * Skipped entirely when the status aggregates themselves failed: a remainder against an
   * unmeasured total is not a figure.
   */
  const registrationComposition = status
    ? await readRegistrationSourceComposition(organizerUid, eventId, {
        total: status.total, confirmed: status.confirmed, pending: status.pending,
        cancelled: status.cancelled, rejected: status.rejected, waitlisted: status.waitlisted,
      }).catch(() => null)
    : null
  const rulesRaw = (ev.registrationForm as Record<string, unknown> | undefined)?.registrationRules
  const registrationIdentityRules = rulesRaw && typeof rulesRaw === 'object'
    ? {
        limitPerEmail:  (rulesRaw as Record<string, unknown>).limitPerEmail  === true,
        limitPerMobile: (rulesRaw as Record<string, unknown>).limitPerMobile === true,
      }
    : null

  const [campaignCounts, commSignals, commPeriod, commBaseline] = await Promise.all([
    readCampaignCounts(organizerUid, eventId, commWindow, commPriorWindow),
    readCommunicationSignals(organizerUid, eventId, commCounts?.total ?? null),
    readWindowedCommunicationCounts(organizerUid, eventId, commWindow),
    commPriorWindow
      ? readWindowedCommunicationCounts(organizerUid, eventId, commPriorWindow)
      : Promise.resolve(null),
  ])

  // ── Coverage ────────────────────────────────────────────────────────────────
  const coverage        = resolveCoverage(trendKeys, coverageSinceRaw)
  const coverageSince   = coverageSinceRaw
  const coveragePartial = coverage.partial

  /**
   * Sum a window, dropping money at the boundary when the caller may not see it.
   *
   * The rollup row carries registrations and revenue in one document, so there is no
   * financial query to suppress — the field itself is never copied out.
   */
  const totalsOf = (rows: DailyStatsPoint[] | null): PeriodTotals | null => {
    if (rows === null) return null
    const t: PeriodTotals = {
      confirmed: rows.reduce((n, p) => n + p.confirmed, 0),
      cancelled: rows.reduce((n, p) => n + p.cancelled, 0),
      checkedIn: rows.reduce((n, p) => n + p.checkedIn, 0),
    }
    if (includeFinancial) t.revenuePaise = rows.reduce((n, p) => n + p.revenuePaise, 0)
    return t
  }

  /**
   * Rows the rollups genuinely cover.
   *
   * `buildSeries` fills every requested day, so a day BEFORE coverage began comes back as
   * a zero — indistinguishable from a quiet day. Clipping is what stops a chart claiming
   * that nobody registered in a period the platform simply was not recording.
   */
  const covered = (rows: DailyStatsPoint[] | null): DailyStatsPoint[] | null =>
    rows === null ? null
      : coverageSince ? rows.filter(p => p.date >= coverageSince)
      : rows

  const dailyCovered = covered(daily)
  const period = totalsOf(dailyCovered) ?? { confirmed: null, cancelled: null, checkedIn: null,
                                             ...(includeFinancial ? { revenuePaise: null } : {}) }

  /**
   * The baseline, or nothing.
   *
   * Refused when the preceding window starts before coverage: a partial baseline compared
   * against a complete current period manufactures growth out of missing history, which is
   * the most convincing wrong number this page could produce.
   */
  const baselineOutsideCoverage = Boolean(
    priorRange && coverageSince && priorRange.from < coverageSince)
  const baseline = baselineOutsideCoverage ? null : totalsOf(priorDaily)

  // A count is published only when its aggregate actually ran. null ≠ 0.
  const byPayment = new Map<string, number>(
    (split?.byPaymentStatus ?? []).map(r => [r.paymentStatus, r.count]),
  )
  const payCount = (ps: PaymentStatus): number | null =>
    split === null ? null : (byPayment.get(ps) ?? 0)

  const registrations = status?.total      ?? null
  const confirmed     = status?.confirmed  ?? null
  const cancelled     = status?.cancelled  ?? null
  const rejected      = status?.rejected   ?? null
  const waitlisted    = status?.waitlisted ?? null
  const pendingStatus = status?.pending    ?? null
  const checkedIn     = status?.checkedIn  ?? null

  const paid          = payCount('paid')
  // RD-FIN-02 · canonical Paid = charged; computed after refunded / refundPending below.
  const free          = payCount('not_required')
  const paymentPending = payCount('pending')
  const refunded      = payCount('refunded')
  const refundPending = payCount('refund_pending')

  // The payment-status breakdown, straight from the aggregate rather than a tallied loop.
  //
  // RESIDUE IS SURFACED, NEVER ABSORBED — the rule lib/analytics/dashboardAnalytics.ts
  // states for its own reconciliation. The aggregate can only count the statuses it was
  // ASKED for, so a registration carrying a value outside the PaymentStatus union would
  // simply vanish from this breakdown and leave it summing to less than the event. The
  // difference against the authoritative total is published as `other` instead: not a new
  // status, just the part this split cannot name.
  const payStatus = new Map<string, number>()
  for (const row of split?.byPaymentStatus ?? []) if (row.count > 0) payStatus.set(row.paymentStatus, row.count)
  if (split !== null && registrations !== null) {
    const named = [...payStatus.values()].reduce((n, v) => n + v, 0)
    if (registrations > named) payStatus.set('other', registrations - named)
  }

  // Per-pass CONFIRMED counts from the counter document. `passCounts` is keyed by passId;
  // the chart shows names, resolved from the event's own pass list below.
  const passCounts: Record<string, number> = counter?.passCounts ?? {}
  const passIds = Object.keys(passCounts)
  const passNames = new Map<string, string>()
  for (const p of Array.isArray((ev.pricing as Record<string, unknown> | undefined)?.passes)
    ? ((ev.pricing as { passes: unknown[] }).passes)
    : []) {
    const row = p as Record<string, unknown>
    if (typeof row.id === 'string' && typeof row.name === 'string') passNames.set(row.id, row.name)
  }
  const passLabel = (id: string) => passNames.get(id) ?? id

  const passCount = new Map<string, number>()
  for (const [id, n] of Object.entries(passCounts)) if (n > 0) passCount.set(passLabel(id), n)

  // Coupon performance: two bounded round trips (the coupons subcollection + one sum()
  // aggregate), independent of registration count. Failure degrades to an empty block rather
  // than taking the whole analytics payload down for a secondary widget.
  // Every read below is FINANCIAL and is skipped entirely for a caller without the
  // permission — the cheapest possible way to guarantee the data cannot leak.
  /*
    RD-ANALYTICS-12-26 (F-1) · a FAILED coupon read is not "₹0 of discount given".

    `EMPTY_COUPON_PERFORMANCE` carries `discountUnavailable: false`, because it describes an
    event with genuinely no coupons. Substituting it bare on failure turned a read error into
    a measured zero — the F1 defect class in a surface that had otherwise eliminated it. The
    dashboard hit this exact trap and fixed it the same way (`route.ts`, the organizer
    coupon read); this is the same one-line correction at the Analytics call site.
  */
  const couponPerformance = includeFinancial
    ? await getCouponPerformance(eventId, organizerUid)
        .catch(() => ({ ...EMPTY_COUPON_PERFORMANCE, discountUnavailable: true }))
    : null

  // A · the canonical confirmed ticket revenue, through the ONE helper Dashboard, Events and
  // Finance already read. One count/sum aggregate — zero documents transferred.
  const confirmedRevenue = includeFinancial
    ? await sumConfirmedRevenueFromLedgerChecked(eventId).catch(() => ({ value: 0, ok: false }))
    : null

  /*
    C · completed refunds, from the refund LEDGER — lifetime, inside the window, and inside
    the baseline window, all from ONE acquisition.

    RD-ANALYTICS-12-32 · the canonical reader reads every refund of the event and applies
    the date window afterwards, in memory. Three `getRefundTotals` calls therefore acquired
    the same rows three times (each: 2 count() aggregates, up to 1,000 + 50 documents, and up
    to 50 paymentIntents point gets). The source is now acquired once — same query, same
    ORGANIZER_REFUND_READ_CAP, same unattributed-refund recovery — and the three totals are
    the same in-memory derivations `getRefundTotals` always performed, applied to that one
    read. Reports keep using the same reader; nothing about WHAT is read changed.

    The bounds are the IST instants of the analytics day keys, not UTC midnights, so a
    refund at 01:00 IST lands in the day the organizer would say it did. A failed acquisition
    leaves all three null — exactly as three failed reads would have — and the baseline
    derivation is skipped when the baseline would be refused anyway.

    This is a request-local variable, not a cache: it is created and discarded inside this
    call, after the caller's authorization, and is never shared across requests.
  */
  const refundSource = includeFinancial
    ? await readRefundSource({ organizerUid, eventSlug: eventId }).catch(() => null)
    : null
  const refundTotals = refundSource
    ? refundTotalsFromRead(refundSource, { organizerUid, eventSlug: eventId, from: null, to: null })
    : null
  // RD-FIN-02 · only refunds of registrations that are STILL confirmed net against confirmed revenue.
  const refundsVsConfirmed: MaybeMoney = refundSource && refundTotals?.amount.ok
    ? await refundsAgainstConfirmedPaise(refundSource).catch(() => gone('query_failed'))
    : gone('query_failed')
  const refundsPeriod = refundSource
    ? refundTotalsFromRead(refundSource, { organizerUid, eventSlug: eventId, ...istRangeBounds(activeRange) })
    : null
  const refundsBaseline = refundSource && priorRange && !baselineOutsideCoverage
    ? refundTotalsFromRead(refundSource, { organizerUid, eventSlug: eventId, ...istRangeBounds(priorRange) })
    : null

  // D · per-pass ticket VALUE. Two sum() aggregates per pass under a shared budget — the
  // same helper and the same budget discipline the dashboard's pass panel uses. Financial,
  // so it is not even requested without the permission.
  const passValue = includeFinancial && passIds.length > 0
    ? await aggregateValueByPass(organizerUid, eventId, passIds, { remaining: PASS_VALUE_BUDGET })
        .catch(() => ({ values: {}, complete: false }))
    : { values: {}, complete: true }

  const passRev = new Map<string, number>()
  if (passValue.complete) {
    for (const [id, v] of Object.entries(passValue.values) as [string, { salesPaise: number }][]) {
      if (v.salesPaise > 0) passRev.set(passLabel(id), v.salesPaise)
    }
  }

  // Both ratios are null when their inputs are — a percentage of an unread count is not 0%.
  const paidCharged = paid === null || refunded === null || refundPending === null ? null : paid + refunded + refundPending
  const conversionPct = registrations === null || paidCharged === null
    ? null
    : registrations > 0 ? Math.round((paidCharged / registrations) * 100) : 0
  /**
   * RD-ANALYTICS-10 · the TRUE percentage. The clamp was in the wrong layer.
   *
   * ═══ WHAT WAS WRONG ════════════════════════════════════════════════════════
   * `Math.min(100, …)` here meant an oversubscribed event could not report 104% ANYWHERE
   * downstream — the figure was destroyed at the source. `CapacityMeter` was written on
   * the opposite assumption, and says so in its own comment: clamp the bar's WIDTH, never
   * the figure. A bar that stops at full is a drawing constraint; a number that stops at
   * 100% is a false statement about a real event.
   *
   * The clamp therefore moves to the one place it belongs — the width calculation in the
   * component — and the metric is published as measured.
   */
  const capacityUsedPct = capacity === null || confirmed === null
    ? null
    : capacity > 0 ? Math.round((confirmed / capacity) * 100) : 0
  /**
   * RD-ANALYTICS-10 · `remaining` may now go NEGATIVE, and that is the point.
   *
   * `Math.max(0, …)` reported "0 places remaining" for an event holding 1,040 confirmed
   * against a 1,000 capacity — indistinguishable from an event that is exactly full. The
   * two are operationally different: one is closed, the other is oversubscribed and its
   * organizer needs to know by how much. Consumers that want a floor apply it themselves;
   * this is the measurement.
   */
  const remaining = capacity === null || confirmed === null
    ? null
    : capacity - confirmed

  // ── Financial (platformTransactions for this event) — resilient to schema/index ──
  //
  // RD-ANALYTICS-02 · these start at 0 and mean NOTHING until ledgerAvailable is true.
  // They used to be seeded with, and fall back to, the registration-derived revenue, so
  // `grossPaise` silently changed basis whenever the ledger read failed or the event had
  // no transactions. The canonical ticket revenue is published as its own field now, so
  // the ledger figures are only ever the ledger’s — or unavailable.
  let grossPaise = 0, platformFeePaise = 0, gstPaise = 0, gatewayFeePaise = 0, netPaise = 0
  let ledgerAvailable = false
  /**
   * RD-ANALYTICS-09 · TRUNCATION IS NOW DETECTED.
   *
   * The read was `.limit(CAP)` and set `ledgerAvailable = true` whenever the page came back
   * non-empty. An event with more than CAP platform transactions therefore summed the first
   * CAP of them and published the result as gross, fees and net — a partial sum wearing the
   * label of a total, with `profitEstimate` inheriting it through `net`. That is the same
   * defect RD-ANALYTICS-03 removed from the registration path.
   *
   * Reading CAP + 1 makes the overflow visible for the cost of one extra document. Over the
   * cap NOTHING is published: the figures become `gone('out_of_budget')` and `limits.ledger`
   * goes false — precisely what `getRefundTotals` already does over its own cap.
   */
  let ledgerTruncated = false
  try {
    const ptx = includeFinancial
      ? await adminDb.collection('platformTransactions').where('entityId', '==', eventId).limit(CAP + 1).get()
      : null
    if (ptx) {
      if (ptx.docs.length > CAP) {
        ledgerTruncated = true
      } else {
        let g = 0, pf = 0, gst = 0, gw = 0, net = 0
        for (const t of ptx.docs) {
          const x = t.data() as Record<string, number>
          // RD-PRICING-02F: snapshot-first (== ledger). Gateway keeps its ACTUAL-over-
          // estimate preference; the estimate is sourced from the snapshot (== ledger).
          const fig = readReportFromLedgerData(x)
          g   += fig.grossAmountPaise
          pf  += fig.platformFeeBasePaise
          gst += fig.platformFeeGstPaise
          gw  += x.gatewayFeeActualPaise ?? fig.gatewayFeeEstimatePaise
          net += fig.netSettlementPaise
        }
        grossPaise = g; platformFeePaise = pf; gstPaise = gst; gatewayFeePaise = gw; netPaise = net
        /**
         * RD-ANALYTICS-09 · an EMPTY successful read is a measured zero.
         *
         * `ledgerAvailable` used to require a non-empty page, so an event that genuinely
         * collected nothing reported "Unavailable" for every gateway figure — the mirror
         * image of the rule this architecture enforces, and it made a free event look
         * broken. The query RAN; zero transactions is an answer, not a failure. Only a
         * throw (missing index, schema) and truncation leave it false.
         */
        ledgerAvailable = true
      }
    }
  } catch { /* missing index / schema — ledgerAvailable stays false, nothing is claimed */ }

  /**
   * ── Communication ────────────────────────────────────────────────────────
   *
   * RD-ANALYTICS-11 · the COUNTS now come from aggregates; this read survives ONLY as the
   * spend fallback — the in-memory cost total used when a caller who may see money has a
   * `sum()` aggregate that failed. RD-ANALYTICS-12-28 removed the per-template breakdown
   * this page also used to build: no contract field, normaliser, component or test ever
   * consumed it, so it was a map filled and discarded on every request.
   *
   * ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════
   * Every communication figure was derived by iterating a `.limit(CAP)` page, and
   * `limits.communications` was a `catch` flag — so a truncated read published the first
   * 5,000 messages as the event's totals with nothing on screen to say so. That is the
   * defect RD-ANALYTICS-09 removed from the payment ledger and RD-ANALYTICS-03 removed
   * from registrations.
   *
   * Reading CAP + 1 makes the overflow visible for the cost of one document. Over the cap
   * the fallback is withheld and `limits.communications` goes false; the counts are
   * unaffected either way, because they no longer come from here.
   */
  let commCostPaise = 0
  let commOk = true
  let commTruncated = false
  /*
    RD-ANALYTICS-12-32 · the page exists ONLY as the fallback for a money caller whose
    `sum('costPaise')` aggregate failed. When that aggregate answered (`ok: true`) the page
    can add nothing, so it is not read. Every other case — aggregate failed, aggregate not
    attempted (no `transactions`), aggregate ambiguous — keeps the read exactly as before,
    so an unavailable spend is never turned into a zero and `limits.communications` keeps
    describing a page that was actually attempted.
  */
  const spendAnswered = commSpend?.ok === true
  try {
    const logs = spendAnswered
      ? null
      : await adminDb.collection('emailLogs').where('eventId', '==', eventId).limit(CAP + 1).get()
    // A null page means the aggregate answered and nothing needs folding; the flag stays
    // "complete" because no page was attempted, let alone truncated.
    if (logs !== null) {
      if (logs.docs.length > CAP) {
        commTruncated = true
      } else {
        for (const l of logs.docs) {
          const x = l.data() as Record<string, unknown>
          commCostPaise += typeof x.costPaise === 'number' ? x.costPaise : 0
        }
      }
    }
  } catch { commOk = false }

  /**
   * ── Reminders (scheduledReminders for this event) ────────────────────────
   *
   * RD-ANALYTICS-12-28 · the STATUS counts are `count()` aggregates on `eventId` +
   * `status` — equality-only, served by merging single-field indexes, exact at any scale.
   * The page that used to count them was `.limit(500)` with no overflow detection, so an
   * event with 501 reminders reported 500 as its history. Only the RECIPIENT sum still
   * needs the rows (`counts.recipients` has no aggregate without an index that carries
   * it); it reads 501 so an overflow is visible, and withholds the sum rather than
   * publishing the first 500 reminders' recipients as the total.
   */
  const remCount = (status: string): Promise<number | null> =>
    adminDb.collection('scheduledReminders')
      .where('eventId', '==', eventId).where('status', '==', status)
      .count().get().then(s => s.data().count).catch(() => null)
  const [remScheduledS, remSendingS, remSentS, remPartialS, remFailedS] = await Promise.all([
    remCount('scheduled'), remCount('sending'), remCount('sent'), remCount('partial'), remCount('failed'),
  ])
  const remOk = [remScheduledS, remSendingS, remSentS, remPartialS, remFailedS].every(v => v !== null)
  const remScheduled = (remScheduledS ?? 0) + (remSendingS ?? 0)
  const remSent      = (remSentS ?? 0) + (remPartialS ?? 0)
  const remFailed    = remFailedS ?? 0
  let remRecipients: number | null = 0
  let remComplete = true
  try {
    const REM_PAGE = 500
    const rem = await adminDb.collection('scheduledReminders').where('eventId', '==', eventId).limit(REM_PAGE + 1).get()
    if (rem.docs.length > REM_PAGE) {
      remComplete = false
      remRecipients = null
    } else {
      for (const d of rem.docs) {
        const c = (d.data() as Record<string, unknown>).counts as { recipients?: number } | undefined
        remRecipients += c?.recipients ?? 0
      }
    }
  } catch { remRecipients = null; remComplete = false }

  /**
   * ── Certificates (the live `certificates` collection — the generation pipeline
   *    writes ONLY here; the legacy `certificateRecords` is never populated) ──
   *
   * RD-ANALYTICS-12-28 · `issued` is a `count()` aggregate, exact at any scale. The page
   * survives only for `downloaded` — distinct certificates with `downloadCount > 0` — which
   * has no aggregate form without a composite the deployment does not declare. It reads
   * CAP + 1 so an overflow is visible, and withholds `downloaded` rather than publishing
   * the first CAP rows' figure as the event's; `limits.certificates` says so.
   */
  const certIssuedAgg = await adminDb.collection(CERT_COLLECTIONS.CERTIFICATES)
    .where('eventId', '==', eventId).count().get()
    .then(s => s.data().count as number).catch(() => null)
  let certDownloaded: number | null = 0
  const certOk = certIssuedAgg !== null
  let certComplete = true
  try {
    const certs = await adminDb.collection(CERT_COLLECTIONS.CERTIFICATES).where('eventId', '==', eventId).limit(CAP + 1).get()
    if (certs.docs.length > CAP) {
      certComplete = false
      certDownloaded = null
    } else {
      for (const d of certs.docs) {
        // Count DISTINCT certificates downloaded at least once (people), not total
        // download events — so the funnel stage stays monotonic (never exceeds
        // "Checked in").
        const dc = (d.data() as { downloadCount?: number }).downloadCount
        if (typeof dc === 'number' && dc > 0) certDownloaded++
      }
    }
  } catch { certDownloaded = null; certComplete = false }
  const certIssued = certIssuedAgg ?? 0

  // ── RD-ANALYTICS-01 · the workspace revenue wallet is NOT read here any more ──
  //
  // `organizerRevenueWallets/{organizerUid}` holds available / pending / settled balances
  // for the WHOLE WORKSPACE. Publishing them from a per-EVENT endpoint invited every
  // reader to attribute a workspace payout position to one event, and no consumer ever
  // rendered them — the field was carried, never shown. There is no authoritative
  // event-level settlement figure to put in its place, so the field is omitted rather
  // than approximated. Workspace settlement lives on /dashboard/finance, which is
  // permission-gated for it.

  // ── Financial assembly ──────────────────────────────────────────────────────
  // grossPaise NO LONGER falls back to a registration-derived total. That fallback made the
  // same field mean "gateway gross" or "Σ paid amount" depending on whether an index existed,
  // with nothing on screen to say which — the canonical figure is published separately as
  // confirmedRevenuePaise, so the ledger fields are now only ever the ledger's.
  // RD-ANALYTICS-09 · a truncated ledger says WHY it is unavailable. `out_of_budget` is the
  // vocabulary getRefundTotals already uses for the same situation, so a consumer that
  // understands one understands the other.
  const ledgerMoney = (v: number): MaybeMoney =>
    ledgerAvailable ? money(v) : gone(ledgerTruncated ? 'out_of_budget' : 'query_failed')

  const refundsMoney: MaybeMoney = refundTotals ? refundTotals.amount : gone('query_failed')
  /**
   * RD-ANALYTICS-11 · spend comes from a sum() aggregate when the caller may see money,
   * so it is neither capped nor derived from the page above. The in-memory total survives
   * only as the fallback for a caller who is entitled to money but whose aggregate failed —
   * and even then only when the page was COMPLETE, because a truncated sum is not a total.
   */
  const commMoney: MaybeMoney =
    commSpend?.ok                ? commSpend
    : commOk && !commTruncated   ? money(commCostPaise)
    : commSpend ?? gone(commTruncated ? 'out_of_budget' : 'query_failed')
  const netMoney:     MaybeMoney = ledgerMoney(netPaise)

  // Published only when all three inputs are real numbers on compatible bases.
  const profitEstimate: MaybeMoney =
    netMoney.ok && refundsMoney.ok && commMoney.ok
      ? money(netMoney.paise - refundsMoney.paise - commMoney.paise)
      : gone('query_failed')

  const confirmedRevenueMoney: MaybeMoney =
    confirmedRevenue?.ok ? money(confirmedRevenue.value) : gone('query_failed')

  /**
   * RD-ANALYTICS-09 · confirmed ticket revenue LESS the money actually returned.
   *
   * ═══ WHY THIS IS A SEPARATE FIGURE AND NOT "REVENUE" ═════════════════════════
   * `confirmedRevenuePaise` is refund-stable on purpose — a refund does not change a
   * registration's status or its `amount`, so the canonical figure is unmoved by money
   * going back. That is correct for "what did this event sell", and useless for "what did
   * this event keep". Organizers ask both, and the defect this architecture keeps closing
   * is one number being made to answer both.
   *
   * So the subtraction is published as its OWN field with its own name, and only when both
   * sides read successfully. Integer paise throughout; no rounding happens before the
   * presentation boundary.
   *
   * The two sides come from different collections — ticket value from `registrations`,
   * refunds from the refund ledger — which is stated rather than hidden. It is the same
   * cross-source subtraction `profitEstimatePaise` performs, under the same rule: every
   * input measured, or the result is `gone`.
   */
  const netRevenuePaise: MaybeMoney =
    confirmedRevenueMoney.ok && refundsVsConfirmed.ok
      ? money(confirmedRevenueMoney.paise - refundsVsConfirmed.paise)
      : gone('query_failed')

  const financial: EventAnalyticsFinancial | undefined = includeFinancial
    ? {
        confirmedRevenuePaise: confirmedRevenueMoney,
        netRevenuePaise,
        grossPaise:            ledgerMoney(grossPaise),
        platformFeePaise:      ledgerMoney(platformFeePaise),
        gstPaise:              ledgerMoney(gstPaise),
        gatewayFeePaise:       ledgerMoney(gatewayFeePaise),
        netPaise:              netMoney,
        refundsPaise:          refundsMoney,
        refundCount:           refundTotals ? refundTotals.count : null,
        communicationCostPaise: commMoney,
        profitEstimatePaise:   profitEstimate,
        /*
          RD-ANALYTICS-12-26 · every input below was measured by a canonical reader above.
          `period.revenuePaise` is the same windowed figure the Overview compares; `paid`
          is the payment-status count() aggregate; refunds are the ledger reader, windowed
          by refund date; the discount is the registrations' own `discountAmount`, and its
          unavailability (F-1) flows through rather than becoming a zero.
        */
        intelligence: {
          velocity:          revenueVelocity(period.revenuePaise ?? null, activeRange),
          averageOrderValue: averageOrderValue(confirmedRevenueMoney, payCount('paid')),
          refundRate:        refundRate(refundsMoney, confirmedRevenueMoney),
          refundsInPeriod:   refundsInPeriod(
            { amount: refundsPeriod   ? refundsPeriod.amount   : gone('query_failed'),
              count:  refundsPeriod   ? refundsPeriod.count    : null },
            refundsBaseline
              ? { amount: refundsBaseline.amount, count: refundsBaseline.count }
              : null,
            baselineOutsideCoverage ? 'outside_coverage' : 'no_baseline',
          ),
          beforeDiscount: revenueBeforeDiscount(
            confirmedRevenueMoney,
            couponPerformance?.totalDiscountPaise ?? 0,
            couponPerformance?.discountUnavailable ?? true,
          ),
        },
      }
    : undefined

  const toPoints = (m: Map<string, number>, sortDesc = true): Point[] => {
    const arr = [...m.entries()].map(([label, value]) => ({ label, value }))
    if (sortDesc) arr.sort((a, b) => b.value - a.value)
    return arr
  }

  /**
   * The three day-series, all from the SAME rollup read.
   *
   * `daily` is null only when the getAll failed; a day with no document inside coverage
   * genuinely had no activity (the write path creates a row only when something happens),
   * which is why buildSeries fills those with zeros and this does not second-guess it.
   */
  const dayLabel = (date: string) => {
    const [, m, d] = date.split('-')
    return `${Number(m)}/${Number(d)}`
  }
  const seriesOf = (pick: (p: DailyStatsPoint) => number): DayPoint[] | null =>
    dailyCovered === null ? null
      : dailyCovered.map(p => ({ date: p.date, label: dayLabel(p.date), value: pick(p) }))

  const registrationsByDay = seriesOf(p => p.confirmed)
  // RD-ANALYTICS-08 · cancellations per day. Same rows, no additional read.
  const cancellationsByDay = seriesOf(p => p.cancelled)
  const revenueByDay       = seriesOf(p => p.revenuePaise)
  const checkInsByDay      = seriesOf(p => p.checkedIn)

  /**
   * The funnel, with every step omitted rather than zeroed when its source did not read.
   * A step showing 0 asserts that nobody reached it, which an unread aggregate does not.
   */
  const funnel: Point[] = [
    ...(registrations === null ? [] : [{ label: 'Registered', value: registrations }]),
    ...(confirmed     === null ? [] : [{ label: 'Confirmed',  value: confirmed }]),
    ...(paid          === null ? [] : [{ label: 'Paid · not refunded', value: paid }]),
    ...(checkedIn     === null ? [] : [{ label: 'Checked in', value: checkedIn }]),
    // Omitted, not zeroed, when the download page overflowed — the same rule as every step.
    ...(certOk && certDownloaded !== null ? [{ label: 'Certificate downloaded', value: certDownloaded }] : []),
  ]

  const analytics: EventAnalytics = {
    eventId, eventName,
    lifecycleStatus: typeof ev.lifecycleStatus === 'string' ? ev.lifecycleStatus : null,
    publishedAt: tsISO(ev.publishedAt),
    // RD-ANALYTICS-03 · the registration path is complete at any event size, so the
    // event-wide truncation claim is retired. It is derived, never hard-coded: if a source
    // in `limits` ever loses completeness the flag follows it.
    truncated: !ledgerAvailable && includeFinancial,
    limits: {
      registrations: true,
      // False when the read failed OR overflowed its bound — a partial breakdown is not
      // a complete one, and the flag has to agree with the figures.
      communications: commOk && !commTruncated,
      // RD-ANALYTICS-12-28 · the status counts are aggregates; these flags cover the two
      // figures that still need rows (reminder recipients, certificate downloads).
      reminders:      remOk && remComplete,
      certificates:   certOk && certComplete,
      ledger:         !includeFinancial || ledgerAvailable,
      passValue:      !includeFinancial || passValue.complete,
    },
    financialAllowed: includeFinancial,
    range: activeRange,
    period,
    baseline,
    coverageSince,
    coveragePartial,
    baselineOutsideCoverage,
    kpis: {
      // RD-PAYMENT-05 B2 still holds: the organizer's revenue is reported on the TICKET
      // base, never the attendee charge. It lives in financial.confirmedRevenuePaise,
      // which reads `amount` (the ticket base) over confirmed registrations.
      registrations, confirmed, pending: pendingStatus, cancelled, rejected, waitlisted,
      paid, paidCharged, free, paymentPending, refunded, refundPending, checkedIn,
      conversionPct, capacity, capacityUsedPct, remaining,
    },
    registrationsByDay,
    cancellationsByDay,
    ...(includeFinancial ? {
      revenueByDay,
      passRevenue: passValue.complete ? toPoints(passRev).slice(0, 8) : [],
    } : {}),
    paymentStatus:      toPoints(payStatus),
    passSales:          toPoints(passCount).slice(0, 8),
    // Sourced from the coupon documents + one sum() aggregate, NOT from the capped scan
    // above — so these stay exact no matter how large the event grows.
    ...(couponPerformance ? {
      couponUsage: couponPerformance.rows.slice(0, 8).map(r => ({ label: r.code, value: r.uses })),
      couponPerformance,
    } : {}),
    checkInsByDay,
    funnel,
    ...(financial ? { financial } : {}),
    communication: commCounts
      ? {
          // Aggregate-derived and uncapped. `sent` is every ATTEMPT, so `delivered` and
          // `failed` are subsets of it and the rates taken against it mean something.
          // `failed` EXCLUDES transport timeouts, which are reported as `unknown` rather
          // than asserted as non-delivery.
          sent:      sumCounts(commCounts.email.sent,      commCounts.whatsapp.sent),
          failed:    sumCounts(commCounts.email.failed,    commCounts.whatsapp.failed),
          delivered: sumCounts(commCounts.email.delivered, commCounts.whatsapp.delivered),
        }
      : null,
    reminders: remOk
      ? { scheduled: remScheduled, sent: remSent, failed: remFailed, recipients: remRecipients }
      : null,
    certificates: certOk ? { issued: certIssued, downloaded: certDownloaded } : null,
    operationalCapabilities: capabilities,
    communicationCounts: commCounts,
    communicationSpend:  commSpend,
    registrationComposition,
    registrationIdentityRules,
    communicationIntelligence: buildCommunicationIntelligence({
      range:          activeRange,
      campaigns:      campaignCounts,
      signals:        commSignals,
      period:         commPeriod,
      baseline:       commBaseline,
      baselineReason: commBaselineOutsideCoverage ? 'outside_coverage'
                    : priorRange                  ? 'no_baseline'
                    : 'disabled',
      lifetimeEmail:    commCounts?.email    ?? null,
      lifetimeWhatsapp: commCounts?.whatsapp ?? null,
    }),
    identifierProgress,
    timingProgress,
    dataFlags: { trafficSources: 'no_data', certificateVerifications: 'no_data', sms: 'no_data' },
  }

  return { analytics, organizerUid }
}
