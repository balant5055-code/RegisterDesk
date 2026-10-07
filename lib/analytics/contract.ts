// RD-ANALYTICS-04 · the shared Analytics response contract. TYPES ONLY — no runtime.
//
// ═══ WHAT THIS IS, AND WHAT IT IS NOT ════════════════════════════════════════
// This is the shape the future Analytics workspace consumes. It is NOT a rewrite of the
// two existing payloads, and declaring it does not change either of them:
//
//   DashboardData          (app/api/organizer/dashboard/route.ts)  — organizer-wide,
//                          rollup-based, finance-gated, coverage-aware
//   EventAnalytics         (lib/analytics/eventAnalytics.ts)       — per-event, aggregate-
//                          based since RD-ANALYTICS-03, finance-gated, limits-aware
//
// Both are correct and both are in production. The problem the audit identified is that
// they name the same concepts differently, so a page reading one cannot be pointed at the
// other. This file fixes the NAMES and the RULES; RD-ANALYTICS-05 maps the two producers
// onto it. Attempting that mapping now would mean rewriting two live APIs in a phase whose
// stated job is to establish boundaries.
//
// ═══ THE THREE RULES THIS CONTRACT ENFORCES IN ITS TYPES ═════════════════════
//
//   1. UNKNOWN IS NOT ZERO.      Every measured count is `number | null`. Null means the
//                                read failed or was not attempted. A consumer cannot
//                                accidentally render it as 0 because the type will not
//                                let it be one.
//   2. MONEY IS ABSENT, NOT ZEROED, WITHOUT PERMISSION. Financial sections are OPTIONAL
//                                properties, so a payload for a caller lacking
//                                `transactions` does not carry the key at all.
//   3. COMPLETENESS TRAVELS WITH THE DATA. `coverage` and `limits` say what the numbers
//                                do and do not cover, so a capped or partial figure can
//                                never present itself as a total.

import type { MaybeMoney } from '@/lib/finance/gatewayFee'
import type { AnalyticsDateRange } from '@/lib/analytics/dateRange'
import type { AnalyticsComparison, ComparedMetric, Delta } from '@/lib/analytics/comparison'
import type { AttentionSeverity } from '@/lib/dashboard/insights'
import type { AnalyticsModuleKey, AnalyticsPanelKey } from '@/lib/analytics/modules'

/** A count that may not have been measured. The single most important type here. */
export type Count = number | null

/** What the request asked for, echoed back so a stale response can be recognised. */
export interface AnalyticsScope {
  /** Null ⇒ the whole workspace. */
  eventId:   string | null
  eventSlug: string | null
  eventName: string | null
  /** The event's configured taxonomy id. Null when it has none — never inferred. */
  eventType: string | null
  range:      AnalyticsDateRange
  comparison: AnalyticsComparison
}

/**
 * How far back the day-series data actually goes.
 *
 * `organizerDailyStats` rows exist only from the day the rollups shipped, so a 90-day
 * window on an older workspace is genuinely partial. Reporting that is the difference
 * between "a quiet January" and "we have no January".
 */
export interface AnalyticsCoverage {
  /** Earliest day the rollups cover, `YYYY-MM-DD`. Null ⇒ unknown. */
  since:   string | null
  /** True when the requested range starts before `since`. */
  partial: boolean
  /** True when the rollups could not be read at all — distinct from `partial`. */
  unavailable: boolean
}

/**
 * Per-source completeness, carried forward from RD-ANALYTICS-03's `limits`.
 *
 * Each entry is TRUE when that source was read in full. A source with no aggregate form
 * keeps its cap and says so, rather than the payload carrying one event-wide flag that
 * cannot describe which figure to distrust.
 */
export interface AnalyticsLimits {
  registrations:  boolean
  communications: boolean
  certificates:   boolean
  ledger:         boolean
  passValue:      boolean
  /**
   * RD-ANALYTICS-12-28 · false when the reminder RECIPIENT sum could not cover every
   * reminder (its page overflowed). The reminder status counts are aggregates and are
   * unaffected; only the recipient figure is withheld.
   */
  reminders:      boolean
}

/** Which modules and panels this scope supports. Resolved by lib/analytics/modules. */
export interface AnalyticsCapabilities {
  modules: AnalyticsModuleKey[]
  panels:  AnalyticsPanelKey[]
}

// ─── Domain sections ──────────────────────────────────────────────────────────
//
// Sectioned by domain rather than flattened into one object, because the sections have
// different authorization and different availability. A flat payload cannot express
// "revenue is absent because you lack a permission" without a sentinel, and a sentinel is
// how a zero gets in.

/**
 * RD-ANALYTICS-08 · what the SELECTED window contains, with its previous-period comparison.
 *
 * Separate from the lifetime counts below because they answer different questions and must
 * never be read as one another. Both series come from `organizerDailyStats`, so both are
 * clipped at the coverage floor and both are null when the rollups could not be read.
 */
export interface RegistrationPeriodAnalytics {
  /** Net confirmed registrations that STARTED inside the window. */
  confirmed: ComparedMetric
  /** Cancellations RECORDED inside the window, of registrations from any day. */
  cancelled: ComparedMetric
}

/**
 * What `byPass` counts.
 *
 * Only one value exists today, and it is stated rather than assumed: `registrationCounters
 * .passCounts` is a lifetime confirmed tally maintained at write time. There is no per-pass
 * daily rollup, so a per-pass figure for the selected window cannot be produced without a
 * per-registration aggregation this architecture refuses. Naming the basis in the payload
 * is what stops a consumer captioning a lifetime distribution with a period label.
 */
export type RegistrationPassBasis = 'lifetime_confirmed'

export interface RegistrationAnalytics {
  total:      Count
  confirmed:  Count
  pending:    Count
  cancelled:  Count
  rejected:   Count
  waitlisted: Count
  /** By paymentStatus — a different population from the registration statuses above. */
  paid:           Count
  free:           Count
  paymentPending: Count
  refunded:       Count
  refundPending:  Count
  /** Confirmed registrations per day over the range. Null ⇒ rollups unreadable. */
  byDay: { date: string; value: number }[] | null
  /** RD-ANALYTICS-08 · cancellations per day over the range. Null ⇒ rollups unreadable. */
  cancelledByDay: { date: string; value: number }[] | null
  /** RD-ANALYTICS-08 · window totals + previous-period comparison. */
  period: RegistrationPeriodAnalytics
  /** Per-pass CONFIRMED counts, from the counter document. */
  byPass: { label: string; value: number }[]
  /** RD-ANALYTICS-08 · the basis `byPass` is measured on. Never a period figure. */
  byPassBasis: RegistrationPassBasis
  capacity:        Count
  capacityUsedPct: Count
  remaining:       Count
}

/** Financial. This whole section is ABSENT without `transactions`. */
export interface RevenueAnalytics {
  /** Σ amount over CONFIRMED — the canonical, refund-stable ticket revenue. */
  confirmedRevenue: MaybeMoney
  /**
   * RD-ANALYTICS-09 · confirmed revenue LESS completed refunds.
   *
   * A separate field, not a redefinition: `confirmedRevenue` is refund-stable by design and
   * answers "what did this event sell"; this answers "what did it keep". Present only when
   * both inputs were measured.
   */
  netRevenue:       MaybeMoney
  /** What the payment ledger collected. A different population; never a substitute. */
  grossCollected:   MaybeMoney
  platformFee:      MaybeMoney
  gst:              MaybeMoney
  gatewayFee:       MaybeMoney
  netSettlement:    MaybeMoney
  /** Completed refunds, from the refund ledger — never from a registration's status. */
  refunds:          MaybeMoney
  refundCount:      Count
  communicationCost: MaybeMoney
  /** Published only when every input was measured on a compatible basis. */
  profitEstimate:   MaybeMoney
  byDay:            { date: string; valuePaise: number }[] | null
  byPass:           { label: string; valuePaise: number }[]
  /**
   * RD-ANALYTICS-09 · what `byPass` measures. Confirmed ticket value per pass, ALL TIME —
   * there is no per-pass daily rollup, so it can never be a selected-period figure, and
   * naming the basis in the payload is what stops a consumer captioning it as one.
   */
  byPassBasis:      RegistrationPassBasis
  /**
   * RD-ANALYTICS-12-26 · derived revenue intelligence. Every figure declares its basis in
   * the payload, so no consumer can caption one as something it is not.
   */
  intelligence:     RevenueIntelligence
}

/**
 * RD-ANALYTICS-12-26 · figures DERIVED from the canonical money above. Nothing here is a
 * new source: each is arithmetic over quantities already measured, and each inherits the
 * absence of its inputs — an unmeasured input is an unmeasured result, never a zero.
 *
 * ═══ THE FIVE, AND WHAT EACH ONE IS NOT ══════════════════════════════════════
 *   velocity         period revenue ÷ days in the window. It is NOT lifetime revenue and it
 *                    is NOT registration velocity, which the Reports hub also calls
 *                    "velocity" and which counts people, not money.
 *   averageOrderValue confirmed revenue ÷ PAID registrations. The denominator is named in
 *                    the payload because "average per registration" would divide by free
 *                    registrations and understate what a paying customer is worth.
 *   refundRate       completed refunds ÷ confirmed revenue, as a share of MONEY. A count-
 *                    based rate would be a different metric with a different denominator.
 *   refundsInPeriod  completed refunds whose refund date falls in the window — NOT the
 *                    period revenue less something. Refunds are lifetime elsewhere in this
 *                    payload; this is the one place they are windowed.
 *   beforeDiscount   confirmed revenue PLUS the discount given. It is the ticket value at
 *                    list price and is deliberately not called "revenue": revenue is what
 *                    was charged, and this is what would have been.
 */
export interface RevenueIntelligence {
  velocity: {
    /** Integer paise per day over the selected window. Unmeasured when period revenue is. */
    perDayPaise: MaybeMoney
    /** Days in the window the figure was divided by. Null when the window is not resolvable. */
    windowDays:  Count
    basis: 'period_rollup_revenue_per_day'
  }
  averageOrderValue: {
    /** confirmedRevenue ÷ paid registrations, integer paise. Lifetime, like both inputs. */
    paise:       MaybeMoney
    /** The denominator actually used. Zero ⇒ `paise` is unmeasured, never Infinity. */
    denominator: Count
    basis: 'confirmed_revenue_per_paid_registration'
  }
  refundRate: {
    /** refunds ÷ confirmedRevenue × 100, one decimal. Null when either side is unmeasured or revenue is 0. */
    pct:   number | null
    basis: 'completed_refunds_over_confirmed_revenue'
  }
  refundsInPeriod: {
    /** Completed refunds dated inside the selected window, from the refund ledger. */
    amount:     MaybeMoney
    count:      Count
    /** Against the preceding window. Omitted (no delta) when the baseline is outside coverage. */
    comparison: ComparedMetric
    basis: 'refund_ledger_by_refund_date'
  }
  beforeDiscount: {
    /** confirmedRevenue + discount given. Unmeasured when either is. */
    paise:    MaybeMoney
    /** The discount given, from the registrations' `discountAmount`. */
    discount: MaybeMoney
    basis: 'confirmed_revenue_plus_discount_given'
  }
}

/**
 * RD-ANALYTICS-10 · capacity, present ONLY when the organizer configured one.
 *
 * `events/{slug}.totalCapacity` is an explicit setting. A registration-category maximum, a
 * venue capacity and a waitlist threshold are different things and none of them stands in
 * for it, so an event without the setting gets no capacity section at all rather than a
 * "0%" that would read as "nobody has registered".
 */
export interface CapacityAnalytics {
  configured: number
  confirmed:  Count
  /**
   * The TRUE percentage — 104 for 1,040 confirmed against 1,000. Not clamped.
   *
   * A bar may clamp its rendered width; the figure may not. RD-ANALYTICS-10 moved that
   * clamp out of the producer, where it was destroying the measurement.
   */
  usedPct:    Count
  /** capacity − confirmed. NEGATIVE when oversubscribed; consumers floor it if they must. */
  remaining:  Count
  /** True when confirmed exceeds capacity — an operational state, not an error. */
  over:       boolean
}

/**
 * RD-ANALYTICS-10 · attendance, with the over-attendance case made explicit.
 *
 * `pct` is deliberately unclamped: 105% is a real reading, and it means people were admitted
 * who this event does not count as confirmed — a cancellation after check-in, a walk-in, a
 * reconciliation gap. Reporting it as 100% with "0 remaining" would hide an operational
 * fact behind a comfortable number.
 */
export interface AttendanceAnalytics {
  confirmed: Count
  checkedIn: Count
  /** checkedIn ÷ confirmed, unclamped. Null when either side is unmeasured. */
  pct:       Count
  /** confirmed − checkedIn. Null when either side is unmeasured; NEGATIVE when over. */
  awaited:   Count
  /** True when more people checked in than the event counts as confirmed. */
  over:      boolean
}

/**
 * RD-ANALYTICS-10 · identifier assignment progress. ABSENT unless this event issues them.
 *
 * `label` is the event's OWN word — "Bib", "Badge", "Token", "Volunteer number". It is
 * configuration and prints verbatim; nothing in this module hardcodes "BIB".
 */
export interface IdentifierAnalytics {
  label:      string
  eligible:   Count
  assigned:   Count
  unassigned: Count
  /** Confirmed registrations predating the tracking field — neither assigned nor waiting. */
  unrecorded: Count
}

/** RD-ANALYTICS-10 · timing-chip progress. ABSENT unless this event uses chips. */
export interface TimingAnalytics {
  /** The event's own word for the device. Defaults to "Timing Chip" when unset. */
  label:    string
  attached: Count
  replaced: Count
  removed:  Count
}

export interface OperationsAnalytics {
  checkedIn:  Count
  /** Checked in ÷ confirmed. Null when either side is unmeasured. */
  attendancePct: Count
  byDay: { date: string; value: number }[] | null
  /** RD-ANALYTICS-10 · the operational snapshot, with its over-attendance state. */
  attendance: AttendanceAnalytics
  /** ABSENT when the event has no configured capacity. */
  capacity?:    CapacityAnalytics
  /** ABSENT when `identifierConfigs/{slug}.enabled` is not true. */
  identifiers?: IdentifierAnalytics
  /** ABSENT when `identifierConfigs/{slug}.tagMapping.enabled` is not true. */
  timing?:      TimingAnalytics
}

/**
 * RD-ANALYTICS-11 · one channel's delivery position.
 *
 * `sent` counts messages that LEFT, including those since confirmed delivered — a delivered
 * message was necessarily sent. `delivered` is only ever a positive confirmation from the
 * provider and is NEVER inferred from `sent`.
 *
 * `failed` and `unknown` are separate on purpose: a provider rejection and a transport
 * timeout are different facts, and the platform records the difference
 * (`emailLogs.deliveryUnknown`). Counting them together asserts non-delivery nobody
 * established.
 */
export interface ChannelDelivery {
  sent:      Count
  delivered: Count
  failed:    Count
  unknown:   Count
  queued:    Count
  skipped:   Count
}

/** Whether a channel can be reported on at all, and why not when it cannot. */
export type ChannelSupport = 'supported' | 'not_implemented'

export interface CommunicationChannelAnalytics {
  key:     'email' | 'whatsapp' | 'sms' | 'push'
  label:   string
  support: ChannelSupport
  /** ABSENT for a channel with no transport — never a set of zeros. */
  delivery?: ChannelDelivery
}

export interface CommunicationsAnalytics {
  /** Across every supported channel. `failed` excludes transport timeouts. */
  sent:      Count
  delivered: Count
  failed:    Count
  remindersScheduled: Count
  remindersSent:      Count
  certificatesIssued:     Count
  certificatesDownloaded: Count
  /** RD-ANALYTICS-11 · per channel, including the ones with no transport. */
  channels: CommunicationChannelAnalytics[]
  /** Every logged message for this event, whatever its channel or state. */
  totalMessages: Count
  /**
   * RD-ANALYTICS-11 · messaging spend. ABSENT without `transactions` — the aggregate is
   * never even issued for a caller who may not see money.
   *
   * RD-ANALYTICS-12-28 · what it measures: the wallet charge RECORDED ON SENT ROWS of the
   * communication log. It is not the ledger debit (a broadcast is charged for every
   * recipient up front and a failed recipient is not credited back), so on a campaign with
   * failures this figure is LOWER than what the wallet paid. Reconciling the two is a
   * billing decision, deferred; the label must say "recorded on sent messages".
   */
  spend?: MaybeMoney
  /** RD-ANALYTICS-12-28 · the intelligence layer. Operational only — no money in it. */
  intelligence: CommunicationIntelligence
}

/**
 * RD-ANALYTICS-12-28 · one channel's position for messages written inside a window.
 *
 * `notDelivered` is the RAW failed count and includes transport timeouts: no declared
 * index carries `deliveryUnknown` beside `createdAt`, so the lifetime subtraction cannot be
 * made inside a window. It is named for what it is and must never be labelled "failed".
 * There is deliberately no `unknown` here.
 */
export interface WindowedChannelDelivery {
  attempted:    Count
  delivered:    Count
  notDelivered: Count
  queued:       Count
  skipped:      Count
}

/**
 * RD-ANALYTICS-12-28 · Communication Intelligence.
 *
 * Every figure is an aggregate over a persisted field — nothing is inferred from a name, a
 * body or a UI label — and every group states its basis so the reader knows which
 * collection and which field answered. Money is absent from this object by construction;
 * the only money the module carries is `spend`, on its own gate.
 */
export interface CommunicationIntelligence {
  /** From `broadcastCampaigns` documents — one per campaign, whatever its size. */
  campaigns: {
    /** Every campaign created for this event, any status (lifetime). */
    created:   Count
    /** Ran to completion: `sent` + `partial` (lifetime). */
    completed: Count
    /** Waiting for the cron (lifetime, current state). */
    scheduled: Count
    /** Campaigns CREATED inside the selected window, against the window before it. */
    period:    ComparedMetric
    basis:     'broadcast_campaign_documents'
  }
  /** Lifetime split of the message log by its persisted `templateKey` discriminator. */
  composition: {
    broadcast: Count
    /**
     * Everything the platform sent on its own: confirmations, approvals, reminders,
     * certificates — AND alerts addressed to the organizer about this event, because the
     * log does not record a message's direction.
     */
    automatic: Count
    basis:     'template_key_broadcast_vs_rest'
  }
  /** Email provider verdicts, as the webhook wrote them. Bounce type is not distinguished. */
  email: {
    bounces:    Count
    complaints: Count
    basis:      'provider_webhook_error_reason'
  }
  /** WhatsApp-only states. `read` is Meta's delivery state, never an email open. */
  whatsapp: {
    read:          Count
    /** Never attempted because the wallet could not cover it. Not failed, not unknown. */
    walletSkipped: Count
    basis:         'meta_status_and_wallet_skip_reason'
  }
  /**
   * The selected window, by `createdAt` in the reporting zone (IST).
   *
   * `baseline` is null when no comparison was requested, when the preceding window could
   * not be read, or when it predates the event — `unavailable` on the compared metrics
   * says which. `attempted` and `delivered` compare across both supported channels.
   */
  window: {
    range:    AnalyticsDateRange
    period:   { email: WindowedChannelDelivery; whatsapp: WindowedChannelDelivery }
    baseline: { email: WindowedChannelDelivery; whatsapp: WindowedChannelDelivery } | null
    attempted:    ComparedMetric
    delivered:    ComparedMetric
    notDelivered: ComparedMetric
    /**
     * Messages attempted per day of the window, across supported channels. Integer,
     * truncated. Null when the window's attempted figure is unmeasured. Not a delivery rate
     * and not the registration or revenue velocity — same denominator, different numerator.
     */
    velocity: { perDay: Count; windowDays: number | null; basis: 'attempted_in_window_per_day' }
  }
  /**
   * Share of lifetime ATTEMPTED messages by channel, supported channels only. Null when
   * either channel is unmeasured or nothing was attempted; an unsupported channel is not
   * in the list — a channel with no transport has no share, not a share of 0.
   */
  channelMix: { key: 'email' | 'whatsapp'; label: string; attempted: number; sharePct: number }[] | null
}

/**
 * Participant analytics.
 *
 * Every field is optional AND nullable, because availability is per-EVENT: age, gender and
 * geography exist only where the organizer added a typed registration-form field for them.
 * An absent key means the event has no such field; a null means it has one that could not
 * be read. Neither is zero.
 */
export interface ParticipantAnalytics {
  /**
   * RD-ANALYTICS-12-29 · REGISTRATION composition — seats, never people.
   *
   * The audit proved a registration is not a participant: one person may hold several
   * (family, team, walk-in, import) and the platform holds no identity it could count them
   * by. Every figure here is therefore a count of registrations, and the module says so.
   * Nothing in this block reads `attendee.*`, `formResponses` or the CRM.
   */
  composition: RegistrationComposition
  /**
   * Contacts with more than one registration, from the CRM contact records.
   *
   * RD-ANALYTICS-12-29 · STILL ABSENT. The CRM's live feed misses the paid path (audit
   * F-3), so its repeat figure is not a fact until that emit and a backfill exist.
   */
  returning?: Count
  /**
   * RD-ANALYTICS-12-29 · STILL ABSENT. Age, gender and geography live in untyped
   * `formResponses` under per-event field ids with no semantic mapping (audit F-1); an
   * absent key means "not collected in a form this platform can read", never zero.
   */
  ageBuckets?:    { label: string; value: number }[] | null
  genderBuckets?: { label: string; value: number }[] | null
  cityBuckets?:   { label: string; value: number }[] | null
}

/** One source's position: the rows that SAY online, the rows that say walk-in, and the rest. */
export interface RegistrationSourceCounts {
  online:     Count
  walkin:     Count
  /** Written before `registrationSource` existed. Named for what it is — never folded into online. */
  unrecorded: Count
}

/**
 * RD-ANALYTICS-12-29 · how this event's seats were created, and what they are.
 *
 * LIFETIME throughout — `registrationSource` has no windowed index, and a lifetime figure
 * presented under a date-range control would be the exact misreading the audit forbids.
 * The screen says "all time" beside every figure in this block.
 */
export interface RegistrationComposition {
  /** Every registration, by the persisted `registrationSource` field. */
  source:   RegistrationSourceCounts
  /** The same split inside each registration status — statuses are never merged. */
  sourceByStatus: Record<'confirmed' | 'pending' | 'cancelled' | 'rejected' | 'waitlisted', RegistrationSourceCounts>
  /**
   * Shares of confirmed registrations by pass, derived from `registrations.byPass` — the
   * same counter-backed figures, not a second count. Null when the pass figures are not
   * complete (`byPassBasis` says why) or when nothing is confirmed.
   */
  passMix:   { label: string; value: number; sharePct: number }[] | null
  /** Shares of all registrations by status, from the status counts. Null when unmeasured. */
  statusMix: { key: 'confirmed' | 'pending' | 'cancelled' | 'rejected' | 'waitlisted'; label: string; value: number; sharePct: number }[] | null
  /**
   * The event's own duplicate rules, as facts: whether a second registration with the same
   * email / mobile is refused. Null when the rules could not be read. These are the ONLY
   * identity statements the module makes, and they describe the gate, not the data.
   */
  identityRules: { limitPerEmail: boolean; limitPerMobile: boolean } | null
  basis: 'registration_source_field_and_status_counts'
}

/** Headline figures, each optionally carrying its comparison. */
export interface OverviewAnalytics {
  registrations: ComparedMetric
  checkedIn:     ComparedMetric
  /** Absent without `transactions`. */
  revenuePaise?: ComparedMetric
  fillPct:       Count
}

// ─── The envelope ─────────────────────────────────────────────────────────────

export interface AnalyticsResponse {
  scope:        AnalyticsScope
  capabilities: AnalyticsCapabilities
  coverage:     AnalyticsCoverage
  limits:       AnalyticsLimits
  /** True when the caller holds `transactions`. Mirrors the dashboard's `finance.allowed`. */
  financialAllowed: boolean

  overview:       OverviewAnalytics
  registrations:  RegistrationAnalytics
  operations:     OperationsAnalytics
  communications: CommunicationsAnalytics
  /** ABSENT — not zeroed — without the finance permission. */
  revenue?:       RevenueAnalytics
  /** ABSENT when the event has no typed participant fields. */
  participants?:  ParticipantAnalytics
}

// ═══ MAPPING BOUNDARY — deliberately NOT crossed in RD-ANALYTICS-04 ═══════════
//
// The two producers are not migrated onto this contract here, and that is a decision
// rather than an omission. Both are live, both are covered by tests written against their
// current shapes, and RD-ANALYTICS-03 has just changed one of them. Rewriting both in the
// same phase that introduces the target shape would mean the contract and its only two
// implementations all move at once, with nothing stable to check them against.
//
// What each producer already supplies, so RD-ANALYTICS-05 can map rather than invent:
//
//   registrations.*        EventAnalytics.kpis            (already Count-typed)
//   registrations.byDay    EventAnalytics.registrationsByDay / DashboardData.trendDays
//   registrations.byPass   EventAnalytics.passSales
//   revenue.*              EventAnalytics.financial       (already MaybeMoney)
//   operations.checkedIn   EventAnalytics.kpis.checkedIn
//   communications.*       EventAnalytics.communication / reminders / certificates
//   overview.*             DashboardData.trendRanges      (already carries Delta)
//   coverage               DashboardData.trendUnavailable + resolveCoverage
//   limits                 EventAnalytics.limits          (already exists, same names)
//
// The gaps that need real work, not renaming: `operations.attendancePct` (no daily
// attendance series exists — only totals), and every `participants` field (needs the
// form-field → semantic-type mapping this phase does not build).

// ─── RD-ANALYTICS-12-31 · Insights ────────────────────────────────────────────
//
// An insight is an INTERPRETATION of the payload above, produced by a pure function over it
// (lib/analytics/insightsRules.ts). It carries no figure the payload does not, and it says
// which field it read: `evidence.field` is a JSON path into AnalyticsResponse, so "why did
// RegisterDesk show me this?" is answered by the payload itself.

/**
 * Severity shares the Dashboard's vocabulary (`critical | warning | info`) so the two
 * surfaces cannot disagree about what a word means; `positive` is the one addition — a
 * strong change in the good direction — and it ranks with `info`, never above `warning`.
 */
export type InsightSeverity = AttentionSeverity | 'positive'

export type InsightRuleId =
  | 'registrations_growth' | 'registrations_decline' | 'cancellations_rise'
  | 'checkins_growth'      | 'checkins_decline'
  | 'capacity_approaching' | 'capacity_reached' | 'capacity_exceeded'
  | 'attendance_low'       | 'attendance_over'  | 'awaiting_large'
  | 'revenue_growth'       | 'revenue_decline'  | 'refunds_rise' | 'refund_rate_high' | 'discount_heavy'
  | 'comm_volume_growth'   | 'comm_volume_decline' | 'comm_delivery_low' | 'comm_unconfirmed_high'
  | 'comm_bounces'         | 'comm_wallet_held'
  | 'source_walkin_share'  | 'pass_concentration' | 'pending_backlog' | 'day_concentration'

/** What the rule read, and what it passed. Every field is a fact of the payload. */
export interface InsightEvidence {
  /** JSON path into AnalyticsResponse, e.g. `registrations.period.confirmed`. */
  field:    string
  /** The module's own basis literal when the cited field carries one. */
  basis?:   string
  unit:     'count' | 'paise' | 'pct'
  /** `period` cites a windowed figure (and says so); `lifetime` cites an all-time one. */
  window:   'lifetime' | 'period'
  range:    AnalyticsDateRange
  value:    number | null
  baseline?: number | null
  delta?:    Delta | null
  coverage: { partial: boolean; since: string | null }
  /** The named floors this rule passed, with the values it was measured against. */
  thresholds: Record<string, number>
}

export interface Insight {
  /** Stable for a given payload: rule + event + range. */
  id:       string
  rule:     InsightRuleId
  severity: InsightSeverity
  title:    string
  summary:  string
  evidence: InsightEvidence
  /** Where "View analytics" goes. */
  module:   AnalyticsModuleKey
  /** Informational. Never performs anything. */
  action?:  { label: string; href: string }
  scope:    { eventSlug: string; eventId: string | null }
}
