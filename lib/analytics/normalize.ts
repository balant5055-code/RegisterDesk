// RD-ANALYTICS-05 · the adapter boundary. PURE — no Firestore, no auth, no React.
//
// ═══ WHAT THIS IS ════════════════════════════════════════════════════════════
//
//   existing trusted producers  →  THIS FILE  →  AnalyticsResponse  →  future pages
//
// RegisterDesk has two analytics producers, both correct and both in production:
//
//   DashboardData    organizer-wide (or scoped to one event), rollup- and counter-based,
//                    finance-gated, coverage-aware. Consumed by /dashboard, the analytics
//                    dashboard at /dashboard/reports, the welcome page and campaigns.
//   EventAnalytics   per-event, aggregate-based since RD-ANALYTICS-03, finance-gated,
//                    limits-aware. Consumed by /dashboard/analytics and Admin Event360.
//
// They compute the same concepts under different names. That is the whole defect: a page
// written against one cannot be pointed at the other. This file fixes the NAMES at a
// boundary — it does NOT recompute anything, and it is not a third analytics engine.
//
// ═══ THE RULES THESE ADAPTERS MUST NOT BREAK ═════════════════════════════════
//
//   NO READS.          Both functions are total over their inputs. If an adapter ever
//                      needed a read, the producer was missing a field and the producer
//                      is where it should be added.
//   NO AUTHORIZATION.  `financialAllowed` is an INPUT, decided upstream by the route from
//                      the `transactions` permission. An adapter that could decide it
//                      would be a second place to get it wrong.
//   NO FALSE ZEROS.    `number | null` in, `number | null` out. `?? 0` does not appear in
//                      this file and a test asserts that.
//   MONEY IS ABSENT.   Without the permission the `revenue` KEY is not written at all —
//                      not written as null, which would still disclose that money exists.

import type {
  AnalyticsResponse, AnalyticsScope, AnalyticsCoverage, AnalyticsLimits,
  AnalyticsCapabilities, RegistrationAnalytics, RevenueAnalytics, OperationsAnalytics,
  CommunicationsAnalytics, OverviewAnalytics, Count, ParticipantAnalytics,
} from '@/lib/analytics/contract'
import type { AnalyticsDateRange } from '@/lib/analytics/dateRange'
import {
  type AnalyticsComparison, type ComparisonUnavailable,
  COMPARISON_OFF, compareMetric,
} from '@/lib/analytics/comparison'
import {
  availableAnalyticsModules, availableAnalyticsPanels, ANALYTICS_MODULES,
  type AnalyticsModuleContext, type AnalyticsPanelKey,
} from '@/lib/analytics/modules'
import type { EventAnalytics, DayPoint, Point } from '@/lib/analytics/eventAnalytics'
import { unmeasuredCommunicationIntelligence } from '@/lib/analytics/communicationIntelligence'
import { passMix, statusMix } from '@/lib/analytics/participantsModel'

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** A day series in contract shape, or null. Never an empty array standing in for null. */
function daySeries(points: DayPoint[] | null | undefined): { date: string; value: number }[] | null {
  if (!points) return null
  return points.map(p => ({ date: p.date, value: p.value }))
}

/** A money day series. Same null discipline. */
function moneySeries(points: DayPoint[] | null | undefined): { date: string; valuePaise: number }[] | null {
  if (!points) return null
  return points.map(p => ({ date: p.date, valuePaise: p.value }))
}

/** `{label,value}` → contract label rows. */
const labelled = (points: readonly Point[] | undefined): { label: string; value: number }[] =>
  (points ?? []).map(p => ({ label: p.label, value: p.value }))

const labelledMoney = (points: readonly Point[] | undefined): { label: string; valuePaise: number }[] =>
  (points ?? []).map(p => ({ label: p.label, valuePaise: p.value }))

/**
 * Percentage of one count against another.
 *
 * Null-preserving on BOTH sides and on a zero denominator: a rate with nothing to divide
 * into is unknown, not 0%. This is the one arithmetic helper here, and it is written out
 * rather than inlined so the null rule is stated once.
 */
function pct(numerator: Count, denominator: Count): Count {
  if (numerator === null || denominator === null) return null
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 100)
}

/** The module/panel availability for a scope. */
function capabilitiesOf(ctx: AnalyticsModuleContext): AnalyticsCapabilities {
  const modules = availableAnalyticsModules(ctx)
  const panels: AnalyticsPanelKey[] = []
  for (const m of ANALYTICS_MODULES) {
    for (const p of availableAnalyticsPanels(m.key, ctx)) panels.push(p.key)
  }
  return { modules: modules.map(m => m.key), panels }
}

// ─── Event Analytics → AnalyticsResponse ──────────────────────────────────────

export interface NormalizeEventInput {
  analytics:  EventAnalytics
  range:      AnalyticsDateRange
  comparison?: AnalyticsComparison
  /** Capability context, resolved upstream from the event + the caller's permissions. */
  capabilities: AnalyticsModuleContext
  /** Echoed into the scope. The producer knows the slug; the draft id comes from the route. */
  eventId:      string | null
  eventSubtype?: string | null
}

/**
 * Map one event's analytics onto the shared contract.
 *
 * Every field below already exists on `EventAnalytics` in the same units — RD-ANALYTICS-02
 * and -03 having already made them canonical. This is renaming and re-grouping, and where
 * a contract field has no producer behind it (see `operations.byDay`) it is null rather
 * than derived from something that is not it.
 */
export function normalizeEventAnalytics(input: NormalizeEventInput): AnalyticsResponse {
  const { analytics: a, range, capabilities } = input
  const k = a.kpis

  const scope: AnalyticsScope = {
    eventId:   input.eventId,
    eventSlug: a.eventId,          // the producer keys on the slug
    eventName: a.eventName,
    eventType: capabilities.eventType,
    range,
    comparison: input.comparison ?? COMPARISON_OFF,
  }

  /**
   * RD-ANALYTICS-07 · the producer now reports where the analytics record begins.
   *
   * `since` means exactly "daily analytics coverage starts here" — it is the rollup
   * marker, not the event's creation date and not its first registration. `partial` is
   * true when the requested window reaches back past it, which is the case the UI has to
   * explain rather than fill with zeros.
   */
  const coverage: AnalyticsCoverage = {
    since:       a.coverageSince,
    partial:     a.coveragePartial,
    unavailable: a.registrationsByDay === null,
  }

  const limits: AnalyticsLimits = {
    registrations:  a.limits.registrations,
    communications: a.limits.communications,
    certificates:   a.limits.certificates,
    ledger:         a.limits.ledger,
    passValue:      a.limits.passValue,
    reminders:      a.limits.reminders,
  }

  // RD-ANALYTICS-07 · the reason comes from the PRODUCER, which knows why it refused the
  // baseline. Deriving it here from `coveragePartial` described the wrong window: a 7-day
  // range can sit inside recorded history while the 7 days before it do not.
  //
  // Resolved before the sections because RD-ANALYTICS-08 gives `registrations.period` its
  // own comparison, and both it and `overview` must explain an absent baseline the same way.
  const baselineReason: ComparisonUnavailable =
    a.baselineOutsideCoverage ? 'outside_coverage' : 'no_baseline'

  const registrations: RegistrationAnalytics = {
    total: k.registrations, confirmed: k.confirmed, pending: k.pending,
    cancelled: k.cancelled, rejected: k.rejected, waitlisted: k.waitlisted,
    paid: k.paid, free: k.free, paymentPending: k.paymentPending,
    refunded: k.refunded, refundPending: k.refundPending,
    byDay:          daySeries(a.registrationsByDay),
    cancelledByDay: daySeries(a.cancellationsByDay),
    /**
     * RD-ANALYTICS-08 · the window, compared with the window before it.
     *
     * Both metrics come from the SAME rollup rows the series is drawn from, so a reader who
     * sums the chart gets the number printed beside it. `cancelled` is reported alongside
     * `confirmed` rather than netted into it — see `PeriodTotals`.
     */
    period: {
      confirmed: compareMetric(a.period.confirmed, a.baseline?.confirmed ?? null, baselineReason),
      cancelled: compareMetric(a.period.cancelled, a.baseline?.cancelled ?? null, baselineReason),
    },
    byPass: labelled(a.passSales),
    // Stated, not inferred: `passSales` is the counter's lifetime confirmed tally.
    byPassBasis: 'lifetime_confirmed',
    capacity: k.capacity, capacityUsedPct: k.capacityUsedPct, remaining: k.remaining,
  }

  /**
   * RD-ANALYTICS-10 · attendance, unclamped on both halves.
   *
   * `pct` uses the same denominator it always has — CONFIRMED, not every registration,
   * because a cancelled or waitlisted row was never expected to attend. What is new is
   * that neither the percentage nor the shortfall is floored: 1,050 checked in against
   * 1,000 confirmed reports 105% and −50 awaited, with `over` set so a consumer can say
   * what that means instead of showing a comfortable 100% / 0.
   */
  const attendance = {
    confirmed: k.confirmed,
    checkedIn: k.checkedIn,
    pct:     pct(k.checkedIn, k.confirmed),
    awaited: k.confirmed === null || k.checkedIn === null ? null : k.confirmed - k.checkedIn,
    over:    k.confirmed !== null && k.checkedIn !== null && k.checkedIn > k.confirmed,
  }

  const operations: OperationsAnalytics = {
    checkedIn: k.checkedIn,
    attendancePct: attendance.pct,
    byDay: daySeries(a.checkInsByDay),
    attendance,
    /**
     * Capacity is present only when the organizer CONFIGURED one. A missing capacity is
     * not a capacity of zero, and a "0%" meter would read as "nobody has registered".
     */
    ...(k.capacity !== null && k.capacity > 0 ? {
      capacity: {
        configured: k.capacity,
        confirmed:  k.confirmed,
        usedPct:    k.capacityUsedPct,
        remaining:  k.remaining,
        over:       k.confirmed !== null && k.confirmed > k.capacity,
      },
    } : {}),
    /**
     * The two conditional sections. Each is written only when the EVENT'S OWN
     * configuration turned the capability on — never inferred from `eventType` — and each
     * carries that event's own word for the thing. `identifierProgress` is null when the
     * capability is off, so the key is absent rather than an empty object.
     */
    ...(a.operationalCapabilities.identifiersEnabled && a.identifierProgress ? {
      identifiers: {
        label:      a.operationalCapabilities.identifierLabel ?? 'Identifier',
        eligible:   a.identifierProgress.eligible,
        assigned:   a.identifierProgress.withIdentifier,
        unassigned: a.identifierProgress.withoutIdentifier,
        unrecorded: a.identifierProgress.unrecorded,
      },
    } : {}),
    ...(a.operationalCapabilities.timingEnabled && a.timingProgress ? {
      timing: {
        label:    a.operationalCapabilities.timingLabel ?? 'Timing Chip',
        attached: a.timingProgress.attached,
        replaced: a.timingProgress.replaced,
        removed:  a.timingProgress.removed,
      },
    } : {}),
  }

  const cc = a.communicationCounts
  const communications: CommunicationsAnalytics = {
    sent:      a.communication?.sent      ?? null,
    delivered: a.communication?.delivered ?? null,
    failed:    a.communication?.failed    ?? null,
    remindersScheduled: a.reminders?.scheduled ?? null,
    remindersSent:      a.reminders?.sent      ?? null,
    certificatesIssued:     a.certificates?.issued     ?? null,
    certificatesDownloaded: a.certificates?.downloaded ?? null,
    /**
     * Every channel the product NAMES, with its support state.
     *
     * SMS and Push are listed so the reader can see they exist as concepts and are not
     * being reported on — `delivery` is absent for them rather than a row of zeros, which
     * would read as "we sent no SMS" on a platform that cannot send SMS at all.
     */
    channels: [
      { key: 'email',    label: 'Email',    support: 'supported',
        ...(cc ? { delivery: cc.email } : {}) },
      { key: 'whatsapp', label: 'WhatsApp', support: 'supported',
        ...(cc ? { delivery: cc.whatsapp } : {}) },
      { key: 'sms',      label: 'SMS',      support: 'not_implemented' },
      { key: 'push',     label: 'Push',     support: 'not_implemented' },
    ],
    totalMessages: cc?.total ?? null,
    /**
     * Spend rides the SAME gate as every other money field: the producer only carries it
     * when the route passed `includeFinancial`, so its absence here is that refusal being
     * carried forward rather than a second decision.
     */
    ...(a.communicationSpend ? { spend: a.communicationSpend } : {}),
    /** RD-ANALYTICS-12-28 · assembled by the producer from aggregates; passed through. */
    intelligence: a.communicationIntelligence,
  }

  /**
   * RD-ANALYTICS-07 · the comparison, from the producer's two windows.
   *
   * ═══ WHAT IS COMPARED AGAINST WHAT ═══════════════════════════════════════
   * PERIOD totals, not lifetime totals. `kpis.confirmed` is every confirmed registration
   * the event has ever taken; `period.confirmed` is how many arrived inside the selected
   * window. Only the second has a meaningful predecessor — comparing a lifetime total
   * against a 30-day window would report growth that is mostly just age.
   *
   * A missing baseline yields no delta and says why. It is never treated as zero.
   */
  const overview: OverviewAnalytics = {
    registrations: compareMetric(a.period.confirmed, a.baseline?.confirmed ?? null, baselineReason),
    checkedIn:     compareMetric(a.period.checkedIn, a.baseline?.checkedIn ?? null, baselineReason),
    fillPct:       k.capacityUsedPct,
  }

  const response: AnalyticsResponse = {
    scope,
    capabilities: capabilitiesOf(capabilities),
    coverage,
    limits,
    financialAllowed: a.financialAllowed,
    overview,
    registrations,
    operations,
    communications,
  }

  // The `revenue` KEY is written only when the producer itself carried money — which it
  // does only when the route passed `includeFinancial`. An unauthorized response does not
  // gain a `revenue: null`, because the presence of the key is itself a disclosure.
  if (a.financial) {
    const f = a.financial
    const revenue: RevenueAnalytics = {
      confirmedRevenue: f.confirmedRevenuePaise,
      netRevenue:       f.netRevenuePaise,
      grossCollected:   f.grossPaise,
      platformFee:      f.platformFeePaise,
      gst:              f.gstPaise,
      gatewayFee:       f.gatewayFeePaise,
      netSettlement:    f.netPaise,
      refunds:          f.refundsPaise,
      refundCount:      f.refundCount,
      communicationCost: f.communicationCostPaise,
      profitEstimate:   f.profitEstimatePaise,
      byDay:  moneySeries(a.revenueByDay),
      byPass: labelledMoney(a.passRevenue),
      // Stated, not inferred: `passRevenue` is a lifetime confirmed-value tally.
      byPassBasis: 'lifetime_confirmed',
      // RD-ANALYTICS-12-26 · derived by the producer from the figures above; passed through
      // unchanged so the wire carries exactly what was computed, basis and all.
      intelligence: f.intelligence,
    }
    response.revenue = revenue
    /**
     * The revenue comparison is PERIOD revenue against the preceding period, both summed
     * from the same rollup rows — so the two sides share one definition. It is deliberately
     * NOT the lifetime `confirmedRevenue` headline compared against a windowed baseline,
     * which would divide two different quantities and call the result growth.
     *
     * `period.revenuePaise` is undefined for a caller without `transactions`, so this
     * block cannot produce a financial comparison for one.
     */
    if (a.period.revenuePaise !== undefined) {
      response.overview.revenuePaise = compareMetric(
        a.period.revenuePaise, a.baseline?.revenuePaise ?? null, baselineReason)
    }
  }

  /**
   * RD-ANALYTICS-12-29 · `participants` is written ONLY when the producer measured the
   * registration composition — never as a shell of nulls, because the module's availability
   * gate (`hasParticipantData`) is literally "is this block here". Its content is seats by
   * source and by status; the demographic keys the interface still declares stay ABSENT
   * (audit F-1), and so does `returning` (audit F-3). See the boundary note at the foot.
   */
  const comp = a.registrationComposition
  if (comp) {
    const participants: ParticipantAnalytics = {
      composition: {
        source:         comp.lifetime,
        sourceByStatus: comp.byStatus,
        passMix:        passMix(registrations),
        statusMix:      statusMix(registrations),
        identityRules:  a.registrationIdentityRules,
        basis: 'registration_source_field_and_status_counts',
      },
    }
    response.participants = participants
  }
  return response
}

// ─── Dashboard → AnalyticsResponse ────────────────────────────────────────────
//
// Typed structurally rather than by importing DashboardData, because that type lives in a
// route module (app/api/organizer/dashboard/route.ts) whose import would drag server code
// into anything that touches this adapter — including the client pages that are its whole
// point. The structural shape is a strict subset and is checked against the real type at
// the one call site.

export interface DashboardAnalyticsSource {
  scope: {
    mode:      'all' | 'event'
    eventId:   string | null
    eventSlug: string | null
    eventName: string | null
    eventType?:    string | null
    eventSubtype?: string | null
  }
  registrationTotals: {
    total: Count; confirmed: number; pending: number
    waitlisted: Count; cancelled: number; rejected: number
  }
  events: { registered: number; capacity: number | null; fillPct: number; revenuePaise: number | null }[]
  trendDays:   { date: string; count: number; revenuePaise: number }[]
  trendRanges: { days: number; registrations: { total: number; delta: unknown }; revenue?: { totalPaise: number; delta: unknown } }[]
  trendUnavailable: boolean
  coverage?: { since: string | null; partial: boolean }
  checkIn?:  { checkedIn: Count }
}

export interface NormalizeDashboardInput {
  data:        DashboardAnalyticsSource
  range:       AnalyticsDateRange
  comparison?: AnalyticsComparison
  capabilities: AnalyticsModuleContext
}

/**
 * Map the organizer dashboard payload onto the shared contract.
 *
 * SCOPE NOTE. `DashboardData` is workspace-wide by default and event-scoped when the
 * client asks. Both map cleanly, because the contract's scope carries `eventId: null` for
 * the workspace case rather than pretending an event.
 *
 * WHAT IS DELIBERATELY ABSENT. The dashboard producer has no payment-status breakdown, no
 * per-pass split on this payload, and no check-in day series. Those fields are null here
 * rather than derived — the per-event producer is the one that measures them, and a
 * workspace-wide figure under an event heading is the exact defect the dashboard's own
 * scope work removed.
 */
export function normalizeDashboardAnalytics(input: NormalizeDashboardInput): AnalyticsResponse {
  const { data: d, range, capabilities } = input
  const t = d.registrationTotals

  // Fill rate over events that HAVE a capacity — an uncapped event has nothing to be a
  // percentage of, and including it as 0 would drag the workspace rate down for a reason
  // that is not a fill rate. This mirrors the rule the reports page already applies.
  const withCap = d.events
    .filter((e): e is typeof e & { capacity: number } => e.capacity !== null && e.capacity > 0)
  const cap = withCap.reduce((s, e) => s + e.capacity, 0)
  const reg = withCap.reduce((s, e) => s + e.registered, 0)
  const fillPct: Count = cap > 0 ? Math.round((reg / cap) * 100) : null

  const inRange = d.trendDays.filter(p => p.date >= range.from && p.date <= range.to)

  const scope: AnalyticsScope = {
    eventId:   d.scope.eventId,
    eventSlug: d.scope.eventSlug,
    eventName: d.scope.eventName,
    eventType: d.scope.eventType ?? null,
    range,
    comparison: input.comparison ?? COMPARISON_OFF,
  }

  const registrations: RegistrationAnalytics = {
    total: t.total, confirmed: t.confirmed, pending: t.pending,
    cancelled: t.cancelled, rejected: t.rejected, waitlisted: t.waitlisted,
    // The dashboard payload carries no payment-status split. Null, not zero.
    paid: null, free: null, paymentPending: null, refunded: null, refundPending: null,
    byDay:  d.trendUnavailable ? null : inRange.map(p => ({ date: p.date, value: p.count })),
    /**
     * RD-ANALYTICS-08 · the dashboard payload carries no cancellation series and no
     * period/baseline registration totals of its own — its `trendRanges` are a
     * week-over-week model built for a different surface. Reporting them as null and
     * `not_measured` is the honest mapping; synthesising them from `trendDays` would put
     * a number here that the dashboard never actually computed.
     */
    cancelledByDay: null,
    period: {
      confirmed: compareMetric(null, null),
      cancelled: compareMetric(null, null),
    },
    byPass: [],
    byPassBasis: 'lifetime_confirmed',
    capacity: cap > 0 ? cap : null,
    capacityUsedPct: fillPct,
    remaining: cap > 0 ? Math.max(0, cap - reg) : null,
  }

  const checkedIn = d.checkIn?.checkedIn ?? null
  const operations: OperationsAnalytics = {
    checkedIn,
    attendancePct: pct(checkedIn, t.confirmed),
    // No daily attendance series exists on this payload — see the boundary note.
    byDay: null,
    /**
     * RD-ANALYTICS-10 · the workspace-wide payload has no per-event capability document and
     * no capacity of its own, so the conditional sections are ABSENT rather than empty. The
     * attendance snapshot is still published, because both its inputs exist here.
     */
    attendance: {
      confirmed: t.confirmed,
      checkedIn,
      pct:     pct(checkedIn, t.confirmed),
      awaited: t.confirmed === null || checkedIn === null ? null : t.confirmed - checkedIn,
      over:    t.confirmed !== null && checkedIn !== null && checkedIn > t.confirmed,
    },
  }

  const communications: CommunicationsAnalytics = {
    sent: null, delivered: null, failed: null,
    remindersScheduled: null, remindersSent: null,
    certificatesIssued: null, certificatesDownloaded: null,
    /**
     * The workspace-wide payload carries no communication data at all, so every supported
     * channel reports its delivery as unmeasured rather than zero, and the unsupported ones
     * are unsupported here for the same reason they are everywhere.
     */
    channels: [
      { key: 'email',    label: 'Email',    support: 'supported' },
      { key: 'whatsapp', label: 'WhatsApp', support: 'supported' },
      { key: 'sms',      label: 'SMS',      support: 'not_implemented' },
      { key: 'push',     label: 'Push',     support: 'not_implemented' },
    ],
    totalMessages: null,
    intelligence: unmeasuredCommunicationIntelligence(range),
  }

  // The 7-day window with its server-resolved delta is the ONE comparison this producer
  // already computes. It is passed through, never recomputed.
  const week = d.trendRanges.find(r => r.days === 7) ?? null

  const overview: OverviewAnalytics = {
    registrations: week
      ? { value: week.registrations.total, baseline: null, delta: week.registrations.delta as never }
      : compareMetric(t.confirmed, null),
    checkedIn: compareMetric(checkedIn, null),
    fillPct,
  }

  const response: AnalyticsResponse = {
    scope,
    capabilities: capabilitiesOf(capabilities),
    coverage: {
      since:       d.coverage?.since ?? null,
      partial:     d.coverage?.partial ?? false,
      unavailable: d.trendUnavailable,
    },
    // This producer has no capped secondary reads — its figures come from counters,
    // aggregates and rollups, none of which has a document ceiling.
    limits: {
      registrations: true, communications: true, certificates: true,
      ledger: true, passValue: true, reminders: true,
    },
    financialAllowed: capabilities.financeAllowed,
    overview,
    registrations,
    operations,
    communications,
  }

  // Revenue rides the SAME gate the dashboard route already applies: `revenue` is present
  // on a trend range only when the caller holds `transactions`, so its absence here is the
  // producer's own refusal being carried forward rather than a second decision.
  if (capabilities.financeAllowed && week?.revenue) {
    response.overview.revenuePaise = {
      value: week.revenue.totalPaise, baseline: null, delta: week.revenue.delta as never,
    }
  }

  return response
}

// ═══ BOUNDARIES THIS FILE DOES NOT CROSS ═════════════════════════════════════
//
// PARTICIPANTS — never written, by either adapter. A registration carries
// `attendee.{name,email,phone}` and an untyped `formResponses` map; age, gender and
// geography exist only where an organizer happened to add a typed field for them, and
// nothing in the data model guarantees what a field called "Category" means. Manufacturing
// buckets out of arbitrary form JSON would be inventing demographics. The missing piece is
// a form-field → semantic-type mapping, which is a schema decision, not an adapter.
//
// OPERATIONS.byDay ON THE DASHBOARD PATH — null, because no daily attendance series
// exists. `organizerDailyStats` does carry a `checkedIn` counter per day, which is why the
// EVENT adapter can fill this and the dashboard one cannot: the dashboard payload does not
// surface that column. Deriving a "series" by spreading one total across the window would
// be inventing attendance history.
//
// COMPARISON — only the 7-day window the dashboard already resolves is passed through. No
// adapter computes a baseline, because computing one requires a second read and these
// functions do not read. Everything else reports `delta: null`, which `compareMetric`
// guarantees whenever either side is unmeasured.
