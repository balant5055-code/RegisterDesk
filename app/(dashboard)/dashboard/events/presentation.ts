// RD-EVENT-02 · Events landing — the presentation decisions, as pure functions.
//
// No React, no Firebase, no DOM. Everything here answers "what should this event's card
// SAY", which is precisely the part worth testing and precisely the part that used to be
// buried inside a 810-line client component. Business rules are imported from their
// existing owners (the lifecycle state machine, the dashboard accent scale) and never
// re-stated here — this module decides wording and tone, never policy.

import { accent, capacityTone, type AccentTone } from '@/lib/dashboard/accents'
import { isValidTransition } from '@/lib/events/lifecycleStateMachine'
import { eventLifecycleMeta } from '@/lib/ui/statusColors'
import type { EventListItem } from '@/app/api/organizer/events/route'
import type { EventLifecycleStatus } from '@/types/events'

/** The one glyph for "we could not read this". Never a zero. */
export const UNAVAILABLE = '—'

// ─── Formatting ───────────────────────────────────────────────────────────────

export function fmtDate(iso: string | null): string {
  if (!iso) return 'TBD'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'TBD'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Rupees, in full. No "34.4L" abbreviation: the design system does not use one, and a
 * cards-are-small argument is not worth making an organizer guess at their own revenue
 * (RD-EVENT-02 §11). Long values are handled by wrapping, not by losing digits.
 */
export function fmtINR(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100)
}

export function fmtCount(n: number): string {
  return n.toLocaleString('en-IN')
}

/** Event-type slugs are stored lowercase; the chip shows them title-cased. */
export function capitalizeType(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ─── Metric resolution — the zero-vs-unavailable contract (H1) ────────────────

export interface MetricDisplay {
  /** Ready to render. `UNAVAILABLE` when the number was never actually read. */
  text: string
  /** True ⇒ `text` is the em dash and the card must caption it, not style it as data. */
  unavailable: boolean
  /**
   * RD-ANALYTICS-12-20 · WHY the figure is missing. Only meaningful when `unavailable`.
   *
   * The two reasons need different words and must not share one caption:
   *   'unreadable' · the platform tried and failed — "try again" is honest advice.
   *   'restricted' · the caller is not entitled to the figure — retrying changes nothing,
   *                  and telling them the platform failed is simply false.
   */
  reason?: 'unreadable' | 'restricted'
}

/**
 * Registrations, and whether the count is real.
 *
 * `statsUnavailable` is the server telling us its counter read failed. The wire still
 * carries `totalRegistrations: 0` for the eight other consumers of that endpoint, so the
 * flag — not the number — is what decides between "nobody has registered" and "we do not
 * know". Conflating them is the defect this function exists to prevent.
 */
export function registrationsDisplay(e: EventListItem): MetricDisplay {
  if (e.statsUnavailable) return { text: UNAVAILABLE, unavailable: true, reason: 'unreadable' }
  const total = fmtCount(e.totalRegistrations)
  return {
    text: e.totalCapacity !== null ? `${total} / ${fmtCount(e.totalCapacity)}` : total,
    unavailable: false,
  }
}

/**
 * Ticket revenue, and whether the figure is real.
 *
 * "Ticket revenue" is the platform's established name for this resolver (the same words
 * the dashboard uses for the same number) — counter `revenuePaise`, or the confirmed
 * ledger sum. It is deliberately NOT "Collected": nothing here is gateway-settled.
 */
export function revenueDisplay(e: EventListItem): MetricDisplay {
  if (e.isFreeEvent) return { text: 'Free', unavailable: false }
  /**
   * RD-ANALYTICS-12-17/19 · `null` means the caller lacks `transactions`, and the API sent no
   * figure at all — it is not a read failure and not a zero.
   *
   * Checked BEFORE `revenueUnavailable` so the entitlement case is decided on its own terms.
   *
   * RD-ANALYTICS-12-20 · both cases still render the same dash — the value is never hinted
   * at — but they now carry different `reason`s, because the card captioned every dash as a
   * failed read and told denied callers to "try again shortly" for a figure they will never
   * be entitled to see.
   */
  if (e.confirmedRevenuePaise === null) {
    return { text: UNAVAILABLE, unavailable: true, reason: 'restricted' }
  }
  if (e.revenueUnavailable) return { text: UNAVAILABLE, unavailable: true, reason: 'unreadable' }
  return { text: fmtINR(e.confirmedRevenuePaise), unavailable: false }
}

// ─── Capacity ─────────────────────────────────────────────────────────────────

export interface CapacityDisplay {
  pct:  number
  tone: AccentTone
  /** Bar fill class from the shared accent scale. */
  bar:  string
  /** What the tone MEANS, for the accessible label — colour is never the only channel. */
  label: string
}

/**
 * Capacity fill → tone, delegated to `capacityTone` in the dashboard accent scale.
 *
 * That function is the platform's existing capacity semantics (its thresholds are pinned
 * to NEARLY_FULL_PCT in the insights engine), and reusing it fixes the inversion the audit
 * found: the old card painted 90%-full RED, telling an organizer that a nearly-sold-out
 * event was in danger. Under the shared scale a filling event reads healthy → approaching
 * → full, and the Events card now agrees with every other surface that draws this number.
 */
export function capacityDisplay(e: EventListItem): CapacityDisplay | null {
  if (e.statsUnavailable) return null          // an unknown fill is not a 0% fill
  if (e.totalCapacity === null || e.totalCapacity <= 0) return null
  const pct  = Math.min(Math.round((e.totalRegistrations / e.totalCapacity) * 100), 100)
  const tone = capacityTone(pct)
  return { pct, tone, bar: accent(tone).bar, label: capacityLabel(pct) }
}

function capacityLabel(pct: number): string {
  if (pct >= 100) return 'Full'
  if (pct >= 85)  return 'Approaching capacity'
  return 'Places available'
}

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * Lifecycle status → accent tone.
 *
 * The VOCABULARY (which statuses exist, what they are called) stays owned by
 * `eventLifecycleMeta`; this only chooses a restrained tone from the shared accent scale
 * so the badge is token-driven and correct in dark mode, which the raw `bg-emerald-100`
 * pairs in that file are not. No status is invented, renamed, or dropped.
 */
const LIFECYCLE_TONE: Record<EventLifecycleStatus, AccentTone> = {
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

export function lifecycleTone(ls: EventLifecycleStatus): AccentTone {
  return LIFECYCLE_TONE[ls] ?? 'neutral'
}

export function lifecycleLabel(ls: EventLifecycleStatus): string {
  return (eventLifecycleMeta[ls] ?? eventLifecycleMeta.draft).label
}

// ─── Action availability ──────────────────────────────────────────────────────
//
// Every predicate below mirrors a rule the SERVER already enforces and re-derives none of
// them. The UI is not the security boundary: hiding an action only avoids offering
// something that would come back 403/409, and each endpoint re-checks ownership and state
// independently.

export interface EventActionAvailability {
  duplicate: boolean
  archive:   boolean
  restore:   boolean
  /** Draft delete — the existing `onDelete` affordance. */
  deleteDraft: boolean
  /** Permanent delete of an archived event. */
  deleteForever: boolean
  edit: boolean
}

/** Read-only lifecycle states: nothing about the event can still be changed. */
export function isReadOnlyLifecycle(ls: EventLifecycleStatus): boolean {
  return ls === 'archived' || ls === 'completed' || ls === 'cancelled'
}

export function actionAvailability(
  e: EventListItem,
  opts: { canDeleteDraft: boolean },
): EventActionAvailability {
  const ls = e.lifecycleStatus
  // `licenseUnavailable` means the licence read failed, so "is this event paid for?" is
  // UNKNOWN. Permanent delete is irreversible, so an unknown is treated as "may be paid"
  // and the action is withheld — the delete route would refuse it anyway.
  const licenceKnown = !e.licenseUnavailable

  return {
    // The duplicate endpoint has no lifecycle restriction — any owned event can be copied.
    duplicate: true,
    // Exactly the state machine's own answer, not a second opinion about it.
    archive:   isValidTransition(ls, 'archived'),
    // The restore route accepts an ARCHIVED event and 409s anything else.
    restore:   ls === 'archived',
    deleteDraft:   ls === 'draft' && opts.canDeleteDraft && licenceKnown && !e.hasPaidLicense,
    deleteForever: ls === 'archived' && licenceKnown && !e.hasPaidLicense,
    edit:      !isReadOnlyLifecycle(ls),
  }
}

/** The event was returned by an admin and can be resubmitted for review. */
export function needsResubmit(e: EventListItem): boolean {
  return e.reviewStatus === 'rejected' || e.lifecycleStatus === 'changes_requested'
}

// ─── Card navigation ──────────────────────────────────────────────────────────

export function manageHref(e: EventListItem): string {
  return `/dashboard/events/${e.draftId}`
}

export function publicHref(e: EventListItem): string | null {
  if (!e.slug || e.lifecycleStatus === 'draft') return null
  return e.campaignType === 'donation_only' ? `/campaign/${e.slug}` : `/events/${e.slug}`
}

/** The primary action's wording follows what the organizer can actually do next. */
export function primaryActionLabel(e: EventListItem): string {
  if (isReadOnlyLifecycle(e.lifecycleStatus)) return 'View'
  if (e.lifecycleStatus === 'draft') return 'Continue setup'
  return 'Manage'
}
