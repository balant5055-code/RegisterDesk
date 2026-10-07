// RD-EVENT-03 · Event Overview — the presentation decisions, as pure functions.
//
// No React, no Firebase, no DOM. Every rule here either delegates to an existing owner
// (the lifecycle state machine, the status presenter, the accent scale) or decides
// wording. Nothing in this file invents a status, a metric or a permission.

import { accent, capacityTone, type AccentTone } from '@/lib/dashboard/accents'
import { presentEventStatus } from '@/lib/events/eventContext'
import { eventLifecycleMeta } from '@/lib/ui/statusColors'
import type { EventDetailResponse, EventSetupIssue } from '@/app/api/organizer/events/[eventId]/route'
import type { EventLifecycleStatus } from '@/types/events'

/** The one glyph for "we could not read this". Never a zero. */
export const UNAVAILABLE = '—'

// ─── Status ───────────────────────────────────────────────────────────────────

export interface OverviewStatus {
  label: string
  tone:  AccentTone
}

/**
 * Lifecycle status → label + tone, composing the two SSOTs that already exist.
 *
 * `presentEventStatus` owns the one distinction nothing else can make: a PUBLISHED event
 * is "Live" or "Upcoming" depending on the clock. But its `default` branch collapses
 * `pending_review`, `changes_requested` and `unpublished` into "Draft" — so an event
 * waiting on an admin, or one an admin sent back, looked identical to an untouched draft
 * on this page while the events LIST correctly called it "Pending Approval".
 *
 * `eventLifecycleMeta` already carries the right word for all nine states, so it supplies
 * the label everywhere except the published/time-sensitive case. Neither SSOT is modified
 * — `presentEventStatus` is read by the frozen dashboard, and changing it would move
 * chart labels there.
 */
const TONE: Record<EventLifecycleStatus, AccentTone> = {
  draft:               'neutral',
  pending_review:      'pending',
  changes_requested:   'pending',
  published:           'verify',
  registration_closed: 'pending',
  completed:           'people',
  cancelled:           'critical',
  archived:            'neutral',
  unpublished:         'neutral',
}

export function overviewStatus(event: EventDetailResponse, now: number): OverviewStatus {
  const ls = event.lifecycleStatus

  if (ls === 'published') {
    // Live vs Upcoming is a clock question; only this resolver answers it.
    const presented = presentEventStatus({
      draftId: event.draftId, name: event.name, slug: event.slug,
      status: event.status, lifecycleStatus: ls,
      startDate: event.startDate, endDate: event.endDate,
      totalRegistrations: event.totalRegistrations,
      totalCapacity: event.totalCapacity,
      updatedAt: event.updatedAt,
    }, now)
    return { label: presented.label, tone: 'verify' }
  }

  return {
    label: (eventLifecycleMeta[ls] ?? eventLifecycleMeta.draft).label,
    tone:  TONE[ls] ?? 'neutral',
  }
}

export function statusChipClass(tone: AccentTone): string {
  return accent(tone).tile
}

// ─── Metrics — the zero-vs-unavailable contract ───────────────────────────────

export interface MetricValue {
  /** Ready to render. `UNAVAILABLE` when the figure was never actually read. */
  text: string
  unavailable: boolean
  /** Secondary line. Suppressed whenever the primary value is unavailable — a
   *  denominator under an em dash reads as though the em dash were a number. */
  sub: string | null
}

const n = (v: number) => v.toLocaleString('en-IN')

/** Rupees in full. No abbreviation: the design system has none, and an organizer
 *  should never have to guess at their own revenue. */
export function formatINR(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`
}

export function registrationsMetric(e: EventDetailResponse): MetricValue {
  if (e.statsUnavailable) return { text: UNAVAILABLE, unavailable: true, sub: null }
  return {
    text: n(e.totalRegistrations),
    unavailable: false,
    sub: e.totalCapacity && e.totalCapacity > 0
      ? `of ${n(e.totalCapacity)} capacity`
      : 'Unlimited capacity',
  }
}

/**
 * Checked in. The count folds the distributed attendance shards (RD-DASH-11/11B) —
 * `getEventStats` does that server-side, so this never reads the stale base counter.
 */
export function checkedInMetric(e: EventDetailResponse): MetricValue {
  if (e.statsUnavailable) return { text: UNAVAILABLE, unavailable: true, sub: null }
  return {
    text: n(e.checkedInCount),
    unavailable: false,
    sub: e.totalRegistrations > 0
      ? `${Math.round((e.checkedInCount / e.totalRegistrations) * 100)}% of registrations`
      : 'No registrations yet',
  }
}

export function revenueMetric(e: EventDetailResponse): MetricValue {
  if (e.isFreeEvent) return { text: 'Free event', unavailable: false, sub: 'No ticket revenue' }
  /**
   * RD-ANALYTICS-12-17/19 · `null` means the caller lacks `transactions`.
   *
   * Distinct from `revenueUnavailable` below, which means the platform tried and could not
   * read the figure. Telling a manager "—" with no reason invites a bug report about missing
   * data; the `sub` line says which of the two it is, which is what the field is for.
   */
  if (e.confirmedRevenuePaise === null) {
    return { text: UNAVAILABLE, unavailable: true, sub: 'Requires finance access' }
  }
  if (e.revenueUnavailable) return { text: UNAVAILABLE, unavailable: true, sub: null }
  return { text: formatINR(e.confirmedRevenuePaise), unavailable: false, sub: 'Confirmed registrations' }
}

export interface CapacityView {
  pct:   number
  tone:  AccentTone
  bar:   string
  label: string
  remaining: number
}

/**
 * Capacity fill → tone via `capacityTone`, the platform's existing capacity semantics
 * (thresholds pinned to NEARLY_FULL_PCT in the insights engine). Nearly-full is
 * "approaching", not "danger" — a filling event is good news for an organizer.
 */
export function capacityView(e: EventDetailResponse): CapacityView | null {
  if (e.statsUnavailable) return null           // an unknown fill is not a 0% fill
  if (!e.totalCapacity || e.totalCapacity <= 0) return null
  const pct  = Math.min(100, Math.round((e.totalRegistrations / e.totalCapacity) * 100))
  const tone = capacityTone(pct)
  return {
    pct, tone, bar: accent(tone).bar,
    remaining: Math.max(0, e.totalCapacity - e.totalRegistrations),
    label: pct >= 100 ? 'Full' : pct >= 85 ? 'Approaching capacity' : 'Places available',
  }
}

// ─── Attention ────────────────────────────────────────────────────────────────

export type AttentionTone = 'critical' | 'warning'

export interface AttentionItem {
  id:     string
  tone:   AttentionTone
  title:  string
  detail?: string | null
  action?: { label: string; href: string }
}

/**
 * What genuinely needs the organizer's attention, in severity order.
 *
 * Every signal comes from an authoritative source already on the payload — the
 * lifecycle status, the admin review outcome, and `evaluatePublishRequirements` (run
 * server-side over the draft this page already loaded). No heuristics, no thresholds
 * invented here, and no second Attention Center: this is the event-scoped subset.
 *
 * Returns an EMPTY array when nothing is wrong. The UI must then render nothing at all
 * rather than a card announcing that everything is fine.
 */
export function attentionItems(e: EventDetailResponse, setupHref: string): AttentionItem[] {
  const items: AttentionItem[] = []

  if (e.lifecycleStatus === 'cancelled') {
    items.push({
      id: 'cancelled', tone: 'critical',
      title: 'This event is cancelled',
      detail: e.cancelReason ?? null,
    })
  }

  if (e.reviewStatus === 'rejected' || e.reviewStatus === 'changes_requested') {
    items.push({
      id: 'review', tone: 'critical',
      title: e.reviewStatus === 'rejected' ? 'Not approved by review' : 'Changes requested by review',
      detail: e.rejectionReason ?? e.changesComment ?? null,
      action: { label: 'Open setup', href: setupHref },
    })
  }

  // Publish requirements only matter while the event can still be published. Telling an
  // organizer their completed event is missing a banner is noise, not attention.
  const stillPublishable = e.lifecycleStatus === 'draft'
    || e.lifecycleStatus === 'pending_review'
    || e.lifecycleStatus === 'changes_requested'
    || e.lifecycleStatus === 'unpublished'

  if (stillPublishable) {
    const issues = e.setupIssues ?? []
    const critical = issues.filter(i => i.severity === 'critical')
    const shown = (critical.length > 0 ? critical : issues).slice(0, 3)
    for (const issue of shown) {
      items.push({
        id: `setup:${issue.id}`,
        tone: issue.severity,
        title: issue.title,
        detail: `Complete this in ${issue.stepName}.`,
        action: { label: 'Open setup', href: setupHref },
      })
    }
  }

  return items
}

/** How many unmet requirements exist beyond the ones listed. */
export function hiddenSetupCount(e: EventDetailResponse, shown: AttentionItem[]): number {
  const listed = shown.filter(i => i.id.startsWith('setup:')).length
  return Math.max(0, (e.setupIssueCount ?? 0) - listed)
}

export type { EventSetupIssue }

// ─── Schedule + location ──────────────────────────────────────────────────────

export function formatDateRange(start: string | null, end: string | null): string | null {
  if (!start) return null
  const s = new Date(start)
  if (Number.isNaN(s.getTime())) return null
  const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  if (!end) return fmt(s)
  const e = new Date(end)
  if (Number.isNaN(e.getTime()) || fmt(e) === fmt(s)) return fmt(s)
  return `${fmt(s)} — ${fmt(e)}`
}

export function locationLabel(e: EventDetailResponse): string | null {
  if (e.venueName) return e.venueCity ? `${e.venueName}, ${e.venueCity}` : e.venueName
  if (e.venueCity) return e.venueCity
  if (e.onlinePlatform) return `Online · ${e.onlinePlatform}`
  if (e.venueType === 'online') return 'Online'
  return null
}

/** The public page, when there is one to show. */
export function publicEventHref(e: EventDetailResponse): string | null {
  if (!e.slug || e.status !== 'published') return null
  return e.campaignType === 'donation_only' ? `/campaign/${e.slug}` : `/events/${e.slug}`
}
