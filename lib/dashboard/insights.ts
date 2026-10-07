// RD-DASHBOARD-02 · Dashboard intelligence — PURE.
//
// Every rule the dashboard uses to decide "does this need attention?" and "how is
// this performing?" lives here as a pure function over plain data. No Firebase, no
// React — so each rule is asserted directly in vitest rather than inferred from a
// screenshot.
//
// ═══ THE ONE RULE THESE RULES FOLLOW ═════════════════════════════════════════
// Every signal is DERIVED FROM DATA THE PLATFORM ALREADY HOLDS. Nothing here
// estimates, predicts from a model, or invents a business threshold that RegisterDesk
// cannot observe. Where a signal needs a number the platform does not have, the rule
// returns nothing instead of guessing — an alert an organizer cannot act on is worse
// than no alert, because it teaches them to ignore the panel.

import type { DailyStatsPoint } from '@/lib/dashboard/dailyStats'

// ─── Severity ─────────────────────────────────────────────────────────────────

export type AttentionSeverity = 'critical' | 'warning' | 'info'

export interface AttentionSignal {
  id:        string
  severity:  AttentionSeverity
  title:     string
  detail:    string
  eventId:   string | null
  /** Where acting on this signal takes the organizer. */
  actionHref:  string | null
  actionLabel: string | null
}

/** The minimum an event must expose for the rules below. */
export interface EventSignalInput {
  draftId:         string
  name:            string
  slug:            string | null
  lifecycleStatus: string
  status:          'draft' | 'published'
  startDate:       string | null
  /** Registration close date, when the event configures one. */
  regCloseDate:    string | null
  registered:      number
  capacity:        number | null
  passCount:       number
  reviewStatus:    'rejected' | 'changes_requested' | null
}

const DAY_MS = 86_400_000

/** Whole days from `now` until `iso`, or null when the date is absent/unparseable. */
export function daysUntil(iso: string | null, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.ceil((t - now) / DAY_MS)
}

export function fillPct(registered: number, capacity: number | null): number | null {
  if (!capacity || capacity <= 0) return null
  return Math.min(100, Math.round((registered / capacity) * 100))
}

// ─── Thresholds ───────────────────────────────────────────────────────────────
// Named constants rather than inline numbers, so the product rule is visible in one
// place and a test can assert the boundary rather than a magic value.

export const NEARLY_FULL_PCT      = 85
export const CLOSING_SOON_DAYS    = 3
export const STARTING_SOON_DAYS   = 3
/** Below this projected fill an event is flagged as behind pace. */
export const BEHIND_PACE_PCT      = 60
/** Pace is meaningless on a brand-new event; require this much observed history. */
export const PACE_MIN_DAYS        = 7
/** An event this close to its start no longer benefits from a pace warning. */
export const PACE_MIN_DAYS_LEFT   = 3

// ─── Individual rules ─────────────────────────────────────────────────────────

/**
 * Registration pace, and the fill it projects by the event's start.
 *
 * Returns null rather than a guess when the platform cannot know the answer:
 * no capacity (nothing to be behind on), no start date (no deadline to project to),
 * too little history, or an event too close to start for the warning to be useful.
 *
 * The projection is deliberately the simplest defensible one — observed daily rate ×
 * days remaining. Anything fancier would imply a confidence the data does not carry.
 */
export interface PaceResult {
  perDay:        number
  daysObserved:  number
  daysLeft:      number
  projected:     number
  projectedPct:  number
  behind:        boolean
}

export function computePace(
  event: EventSignalInput,
  series: DailyStatsPoint[],
  now: number,
): PaceResult | null {
  if (!event.capacity || event.capacity <= 0) return null
  const daysLeft = daysUntil(event.startDate, now)
  if (daysLeft === null || daysLeft < PACE_MIN_DAYS_LEFT) return null
  if (series.length < PACE_MIN_DAYS) return null

  const observed = series.reduce((s, p) => s + p.confirmed, 0)
  const perDay   = observed / series.length
  const projected    = Math.round(event.registered + perDay * daysLeft)
  const projectedPct = Math.min(100, Math.round((projected / event.capacity) * 100))

  return {
    perDay: Math.round(perDay * 10) / 10,
    daysObserved: series.length,
    daysLeft,
    projected,
    projectedPct,
    behind: projectedPct < BEHIND_PACE_PCT,
  }
}

/**
 * Is this event's configuration incomplete in a way the organizer must fix?
 *
 * Only conditions the platform can OBSERVE:
 *   • a published event with no passes cannot be registered for
 *   • a published event with no slug has no public page
 *   • a draft whose start date is near has run out of time to be published
 *
 * Deliberately NOT "no banner" or "no description" — those are quality opinions, not
 * blockers, and putting them here would dilute a panel that must stay actionable.
 */
export function setupIssue(event: EventSignalInput, now: number): string | null {
  if (event.status === 'published') {
    if (event.passCount === 0) return 'Published with no passes — nobody can register.'
    if (!event.slug)           return 'Published but has no public page URL.'
    return null
  }
  const daysLeft = daysUntil(event.startDate, now)
  if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 14) {
    return `Still a draft and starts in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`
  }
  return null
}

// ─── The attention engine ─────────────────────────────────────────────────────

/** Lifecycle states where operational alerts are meaningful. */
const LIVE_STATES = new Set(['published', 'registration_closed'])
const DEAD_STATES = new Set(['cancelled', 'archived', 'completed'])

export interface AttentionInput {
  events:      EventSignalInput[]
  /** Per-event recent series, keyed by draftId. Absent ⇒ pace is skipped, not guessed. */
  seriesByEvent?: Map<string, DailyStatsPoint[]>
  /** Unresolved payment-recovery cases across the workspace. */
  paymentIssues?: number
  now: number
}

/**
 * Produces the Attention Center's list, most urgent first.
 *
 * Ordering is by severity then by urgency (soonest deadline), because a panel that
 * lists a 30-day-away problem above a tomorrow problem is a panel nobody trusts.
 */
export function buildAttention(input: AttentionInput): AttentionSignal[] {
  const { events, now } = input
  const out: AttentionSignal[] = []

  for (const e of events) {
    if (DEAD_STATES.has(e.lifecycleStatus)) continue
    const manage = `/dashboard/events/${encodeURIComponent(e.draftId)}`

    // Admin returned the event — the organizer cannot publish until they act.
    if (e.reviewStatus) {
      out.push({
        id: `review:${e.draftId}`, severity: 'critical',
        title: e.name,
        detail: e.reviewStatus === 'rejected'
          ? 'Rejected in review — changes are required before it can go live.'
          : 'Changes requested in review.',
        eventId: e.draftId, actionHref: manage, actionLabel: 'Review',
      })
      continue
    }

    const setup = setupIssue(e, now)
    if (setup) {
      out.push({
        id: `setup:${e.draftId}`, severity: 'critical',
        title: e.name, detail: setup,
        eventId: e.draftId, actionHref: `${manage}?tab=setup`, actionLabel: 'Finish setup',
      })
    }

    if (!LIVE_STATES.has(e.lifecycleStatus)) continue

    // Capacity.
    const pct = fillPct(e.registered, e.capacity)
    if (pct !== null && pct >= NEARLY_FULL_PCT) {
      out.push({
        id: `full:${e.draftId}`,
        severity: pct >= 100 ? 'critical' : 'warning',
        title: e.name,
        detail: pct >= 100
          ? 'At full capacity — registrations can no longer be accepted.'
          : `${pct}% full — ${(e.capacity ?? 0) - e.registered} place(s) left.`,
        eventId: e.draftId, actionHref: manage, actionLabel: 'Manage',
      })
    }

    // Registration closing.
    const closeIn = daysUntil(e.regCloseDate, now)
    if (closeIn !== null && closeIn >= 0 && closeIn <= CLOSING_SOON_DAYS && e.lifecycleStatus === 'published') {
      out.push({
        id: `closing:${e.draftId}`, severity: 'warning',
        title: e.name,
        detail: closeIn === 0 ? 'Registration closes today.' : `Registration closes in ${closeIn} day${closeIn === 1 ? '' : 's'}.`,
        eventId: e.draftId, actionHref: manage, actionLabel: 'Manage',
      })
    }

    // Event starting.
    const startIn = daysUntil(e.startDate, now)
    if (startIn !== null && startIn >= 0 && startIn <= STARTING_SOON_DAYS) {
      out.push({
        id: `starting:${e.draftId}`, severity: 'info',
        title: e.name,
        detail: startIn === 0 ? 'Starts today — check gate readiness.' : `Starts in ${startIn} day${startIn === 1 ? '' : 's'}.`,
        eventId: e.draftId, actionHref: `${manage}?tab=attendance`, actionLabel: 'Check-in',
      })
    }

    // Pace — only when the rollups can actually support it.
    const series = input.seriesByEvent?.get(e.draftId)
    if (series) {
      const pace = computePace(e, series, now)
      if (pace?.behind) {
        out.push({
          id: `pace:${e.draftId}`, severity: 'warning',
          title: e.name,
          detail: `Tracking to ~${pace.projectedPct}% of capacity at ${pace.perDay}/day with ${pace.daysLeft} day(s) left.`,
          eventId: e.draftId, actionHref: `${manage}?tab=communications`, actionLabel: 'Promote',
        })
      }
    }
  }

  // Workspace-level.
  if (input.paymentIssues && input.paymentIssues > 0) {
    out.push({
      id: 'payment-issues', severity: 'critical',
      title: 'Unresolved payment issues',
      detail: `${input.paymentIssues} captured payment(s) have no registration.`,
      eventId: null, actionHref: '/dashboard/finance/payment-issues', actionLabel: 'Resolve',
    })
  }

  const rank: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

// ─── Period comparison ────────────────────────────────────────────────────────

export interface Delta {
  /** Percentage change, rounded. Null when the previous period had nothing to compare. */
  pct:       number | null
  direction: 'up' | 'down' | 'flat'
}

/**
 * Change between two periods.
 *
 * A zero previous period yields `pct: null`, not Infinity and not 100%: "up from
 * nothing" is not a percentage, and rendering one would be a fabricated statistic.
 * The UI shows the raw figures in that case.
 */
export function computeDelta(current: number, previous: number): Delta {
  if (previous <= 0) return { pct: null, direction: current > 0 ? 'up' : 'flat' }
  const change = ((current - previous) / previous) * 100
  const pct = Math.round(change)
  return { pct, direction: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' }
}

// ─── Upcoming events ──────────────────────────────────────────────────────────

export interface UpcomingEvent {
  draftId:    string
  name:       string
  startDate:  string | null
  daysLeft:   number | null
  registered: number
  capacity:   number | null
  fillPct:    number | null
  lifecycleStatus: string
}

/**
 * The next N events by start date.
 *
 * Excludes ended/cancelled/archived events and anything already past — an "upcoming"
 * list containing last month's marathon is noise. Events with no start date sort last
 * rather than being dropped: an undated event is still real work.
 */
export function buildUpcoming(events: EventSignalInput[], now: number, limit = 5): UpcomingEvent[] {
  return events
    .filter(e => !DEAD_STATES.has(e.lifecycleStatus))
    .map(e => ({
      draftId: e.draftId, name: e.name, startDate: e.startDate,
      daysLeft: daysUntil(e.startDate, now),
      registered: e.registered, capacity: e.capacity,
      fillPct: fillPct(e.registered, e.capacity),
      lifecycleStatus: e.lifecycleStatus,
    }))
    .filter(e => e.daysLeft === null || e.daysLeft >= 0)
    .sort((a, b) => {
      if (a.daysLeft === null && b.daysLeft === null) return 0
      if (a.daysLeft === null) return 1
      if (b.daysLeft === null) return -1
      return a.daysLeft - b.daysLeft
    })
    .slice(0, limit)
}

// ─── Performance insights (RD-ANALYTICS-04) ───────────────────────────────────
//
// ═══ WHY THESE MOVED HERE ════════════════════════════════════════════════════
// These four rules lived in a `useMemo` inside app/(dashboard)/dashboard/reports/page.tsx.
// They were correct — they read server-resolved values rather than reducing client arrays,
// and they guard `trendUnavailable` and a null `pct` — but they were a SECOND insight
// engine, in a component, untested, beside this pure and tested one. A rule that decides
// what an organizer is told about their event does not belong in a render function.
//
// ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
// Not AI, not statistics, not a model. Four deterministic rules over data the platform
// already holds — the same standard `buildAttention` above is held to. Nothing here
// estimates or predicts.
//
// ═══ HOW THIS DIFFERS FROM buildAttention ════════════════════════════════════
// `buildAttention` answers "what needs attention" and returns severities and actions.
// These answer "how is it performing" and return narration. They are deliberately separate
// families with separate outputs; merging them would make every attention signal compete
// with a performance sentence for the same panel.

export type PerformanceInsightTone = 'positive' | 'neutral' | 'warning'

/**
 * One rendered insight.
 *
 * `kind` is a stable identifier the UI maps to an icon — the rules do not import React or
 * name an icon, which is what let them live in a component before and is what keeps this
 * module pure now.
 */
export interface PerformanceInsight {
  kind: 'top_event' | 'velocity_up' | 'velocity_down' | 'velocity_flat' | 'velocity_total'
      | 'empty_published' | 'nearly_full'
  text: string
  tone: PerformanceInsightTone
}

/** One event, as these rules need it. A strict subset of the dashboard's event row. */
export interface PerformanceEventInput {
  name:            string
  lifecycleStatus: string
  registered:      number
  capacity:        number | null
  /** Server-resolved. These rules never divide to obtain it. */
  fillPct:         number
}

export interface PerformanceInsightInput {
  events: PerformanceEventInput[]
  /**
   * The 7-day window with its delta against the preceding 7 days, already resolved by the
   * server from the daily rollups. Null when unavailable — no claim is then made.
   */
  week: { total: number; delta: Delta } | null
  /** True when the rollups could not be read; suppresses every velocity claim. */
  trendUnavailable: boolean
}

/**
 * The capacity threshold at which an event is called out as nearly full.
 *
 * 80, NOT the 85 that `NEARLY_FULL_PCT` uses for the attention panel. The two are
 * deliberately different and are left different: the attention signal is a warning that
 * wants to fire late, this is narration that wants to fire early. Unifying them would have
 * silently changed what organizers already see on one of the two surfaces.
 */
export const PERFORMANCE_NEARLY_FULL_PCT = 80

/** Maximum insights returned, preserving the panel's existing cap. */
export const MAX_PERFORMANCE_INSIGHTS = 4

const inr = (n: number) => n.toLocaleString('en-IN')

export function buildPerformanceInsights(input: PerformanceInsightInput): PerformanceInsight[] {
  const out: PerformanceInsight[] = []
  const { events, week, trendUnavailable } = input

  // 1 · The leading event, over EVERY event in scope.
  const best = [...events].sort((a, b) => b.registered - a.registered)[0]
  if (best && best.registered > 0) {
    out.push({
      kind: 'top_event',
      text: `"${best.name}" leads with ${inr(best.registered)} registration${best.registered !== 1 ? 's' : ''}`,
      tone: 'positive',
    })
  }

  // 2 · Week-over-week velocity, READ from the server's delta and never recomputed.
  //     The sign is carried by the WORD, so the number is absolute — `delta.pct` is
  //     negative on a decline, and "-14% fewer" would read as a rise.
  if (week && !trendUnavailable) {
    const { total, delta } = week
    if (delta.pct !== null && delta.direction === 'up') {
      out.push({ kind: 'velocity_up',   tone: 'positive', text: `${Math.abs(delta.pct)}% more registrations in the last 7 days vs the prior week` })
    } else if (delta.pct !== null && delta.direction === 'down') {
      out.push({ kind: 'velocity_down', tone: 'warning',  text: `${Math.abs(delta.pct)}% fewer registrations in the last 7 days vs the prior week` })
    } else if (delta.direction === 'flat' && total > 0) {
      out.push({ kind: 'velocity_flat', tone: 'neutral',  text: 'Registration pace is steady week-over-week' })
    } else if (total > 0) {
      out.push({ kind: 'velocity_total', tone: 'positive', text: `${inr(total)} new registration${total !== 1 ? 's' : ''} in the last 7 days` })
    }
  }

  // 3 · Published events nobody has registered for.
  const emptyPublished = events.filter(e => e.lifecycleStatus !== 'draft' && e.registered === 0)
  if (emptyPublished.length > 0) {
    out.push({
      kind: 'empty_published', tone: 'warning',
      text: emptyPublished.length === 1
        ? `"${emptyPublished[0].name}" has no registrations yet — consider promoting it`
        : `${emptyPublished.length} published events have no registrations yet`,
    })
  }

  // 4 · Events approaching their real capacity. `fillPct` is server-resolved; an event
  //     with no capacity has nothing to be a percentage OF and is excluded.
  const highFill = events.filter(e => e.capacity !== null && e.capacity > 0 && e.fillPct >= PERFORMANCE_NEARLY_FULL_PCT)
  if (highFill.length > 0) {
    out.push({
      kind: 'nearly_full', tone: 'positive',
      text: `${highFill.length} event${highFill.length !== 1 ? 's are' : ' is'} at ${PERFORMANCE_NEARLY_FULL_PCT}%+ capacity — consider opening a waitlist`,
    })
  }

  return out.slice(0, MAX_PERFORMANCE_INSIGHTS)
}
