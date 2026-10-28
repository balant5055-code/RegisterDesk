// RD-EVENT-06 · Event Home — the operations-overview decisions, as pure functions.
//
// ═══ THE DISTINCTION THIS MODULE EXISTS TO ENFORCE ═══════════════════════════
// The registrations payload carries TWO different things:
//
//   `stats`         — whole-dataset, counter-backed (with a count()-aggregate
//                     fallback). Authoritative. `stats.checkedIn` comes from
//                     `getEventStats`, which folds the attendance shards, so it is
//                     the RD-DASH-11B path and never the stale base counter.
//   `registrations` — ONE PAGE. 51 documents at most.
//
// Home previously computed headline counts by filtering that page — so an event with
// 500 registrations reported "3 refunds pending" when it meant "3 among the 51 most
// recent". A number derived from a page must never be presented as a total.
//
// Rule: `stats` for every COUNT. `registrations` for LISTS only, always labelled as
// the latest rather than as everything.
//
// Pure — no React, no Firebase, no DOM.

import { accent, type AccentTone } from '@/lib/dashboard/accents'
import { readiness } from '@/lib/eventSetup/readiness'
import { eventHasWaitlist } from './eventCapabilities'
import { eventEditorPath } from './editorPath'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type {
  RegistrationsApiResponse, SerializedRegistration,
} from '@/app/api/organizer/events/[eventId]/registrations/route'

export const UNAVAILABLE = '—'

/** How many documents the registrations endpoint returns in one page. */
export const REGISTRATION_PAGE_SIZE = 50

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface HomeMetric {
  key:   string
  label: string
  text:  string
  sub:   string | null
  unavailable: boolean
}

const n = (v: number) => v.toLocaleString('en-IN')

/**
 * The registration status breakdown, from the AUTHORITATIVE whole-dataset stats.
 *
 * `regData === null` is not zero — it means the dataset has not been read (or could
 * not be), and every figure derived from it is unavailable.
 */
export function statusMetrics(
  event: EventDetailResponse,
  regData: RegistrationsApiResponse | null,
): HomeMetric[] {
  const s = regData?.stats
  const un = (key: string, label: string): HomeMetric =>
    ({ key, label, text: UNAVAILABLE, sub: null, unavailable: true })

  if (!s) {
    return [
      un('confirmed', 'Confirmed'),
      un('pending', 'Pending'),
      un('checkedIn', 'Checked in'),
      un('cancelled', 'Cancelled'),
    ]
  }

  return [
    {
      key: 'confirmed', label: 'Confirmed', text: n(s.confirmed), unavailable: false,
      sub: s.total > 0 ? `${Math.round((s.confirmed / s.total) * 100)}% of all registrations` : 'No registrations yet',
    },
    {
      key: 'pending', label: 'Pending', text: n(s.pending), unavailable: false,
      sub: s.pending > 0 ? 'Awaiting approval' : 'Nothing waiting',
    },
    {
      // Shard-folded server-side. Never `registrationCounters.checkedInCount` directly.
      key: 'checkedIn', label: 'Checked in', text: n(s.checkedIn), unavailable: false,
      sub: s.confirmed > 0 ? `${Math.round((s.checkedIn / s.confirmed) * 100)}% of confirmed` : 'Nobody checked in yet',
    },
    {
      key: 'cancelled', label: 'Cancelled', text: n(s.cancelled), unavailable: false,
      // RD-EVENT-09 · The fallback used to be "None cancelled" regardless of the value
      // above it, so an event with 15 cancellations and no rejections rendered
      // "Cancelled 15 / None cancelled" — a line contradicting the figure it sits under.
      // Browser QA caught it. The sub-line now only ever qualifies, never contradicts.
      sub: s.rejected > 0
        ? `${n(s.rejected)} also rejected`
        : s.cancelled > 0 ? 'None rejected' : 'Nothing cancelled',
    },
  ]
}

/** Not-yet-checked-in, only where both halves are authoritative. */
export function remainingToCheckIn(regData: RegistrationsApiResponse | null): number | null {
  const s = regData?.stats
  if (!s) return null
  return Math.max(0, s.confirmed - s.checkedIn)
}

// ─── Readiness ────────────────────────────────────────────────────────────────

export interface HomeReadiness {
  known:     boolean
  canPublish: boolean
  headline:  string
  detail:    string
  tone:      AccentTone
}

/**
 * Setup readiness, from the SAME evaluator the Setup Center and the publish flow use.
 *
 * Home used to run the legacy `SETUP_MODULES` registry, which RD-EVENT-04 replaced
 * precisely because it disagreed with `evaluatePublishRequirements` — so Home and Setup
 * gave contradictory readings of one question on adjacent tabs.
 */
export function homeReadiness(event: EventDetailResponse): HomeReadiness {
  const r = readiness(event)
  if (!r.known) {
    return {
      known: false, canPublish: false, tone: 'neutral',
      headline: 'Setup status unknown',
      detail: "Setup checks couldn't be run, so readiness is not claimed either way.",
    }
  }
  if (r.canPublish) {
    return {
      known: true, canPublish: true, tone: 'verify',
      headline: 'Ready to publish',
      detail: r.warningOpen > 0
        ? `${r.criticalPassed} of ${r.criticalTotal} required checks ready · ${r.warningOpen} recommended open`
        : `${r.criticalPassed} of ${r.criticalTotal} required checks ready`,
    }
  }
  return {
    known: true, canPublish: false, tone: 'critical',
    headline: `${r.blockers.length} ${r.blockers.length === 1 ? 'item blocks' : 'items block'} publishing`,
    detail: `${r.criticalPassed} of ${r.criticalTotal} required checks ready`,
  }
}

// ─── Attention ────────────────────────────────────────────────────────────────

export interface HomeAttention {
  id:     string
  tone:   'critical' | 'warning'
  title:  string
  detail: string | null
  href:   string
}

export interface AttentionSignals {
  /** Certificate issuance, from setup-signals. `'unavailable'` is a first-class value. */
  certificates: { generated: number; pending: number } | 'unavailable'
  waitlist:     { count: number } | 'unavailable'
}

/**
 * What genuinely needs the organizer's attention.
 *
 * Every count here comes from an authoritative whole-dataset source. Nothing is derived
 * by filtering the registration page — that is what made the old refund and approval
 * rows silently wrong past 51 registrations.
 *
 * Returns an EMPTY array when nothing is wrong; the UI then renders nothing rather than
 * a card announcing that all is well.
 */
export function homeAttention(
  event: EventDetailResponse,
  regData: RegistrationsApiResponse | null,
  signals: AttentionSignals,
  tab: (k: string) => string,
): HomeAttention[] {
  const items: HomeAttention[] = []
  const s = regData?.stats

  if (event.lifecycleStatus === 'cancelled') {
    items.push({
      id: 'cancelled', tone: 'critical', title: 'This event is cancelled',
      detail: event.cancelReason ?? null, href: tab('settings'),
    })
  }

  if (event.reviewStatus === 'rejected' || event.reviewStatus === 'changes_requested') {
    items.push({
      id: 'review', tone: 'critical',
      title: event.reviewStatus === 'rejected' ? 'Not approved by review' : 'Changes requested by review',
      detail: event.rejectionReason ?? event.changesComment ?? null,
      // RD-REVIEW-03 — requested changes are made and resubmitted in the editor, which shows the request.
      href: event.reviewStatus === 'changes_requested' ? eventEditorPath(event.draftId) : tab('setup'),
    })
  }

  // Whole-dataset, counter-backed — not a filter over the loaded page.
  if (s && s.pending > 0) {
    items.push({
      id: 'pending', tone: 'warning',
      title: `${n(s.pending)} registration${s.pending === 1 ? '' : 's'} awaiting approval`,
      detail: null, href: tab('registrations'),
    })
  }

  if (signals.waitlist !== 'unavailable' && signals.waitlist.count > 0) {
    // RD-EVENT-16 · the Waitlist tab is hidden when the event's waitlist is switched off,
    // so this must not link there — it would land on the command center the reader is
    // already looking at. People CAN still be queued from before the switch was turned
    // off, which is exactly when this item fires and is worth saying out loud.
    const on = eventHasWaitlist(event.registrationRules)
    items.push({
      id: 'waitlist', tone: 'warning',
      title: `${n(signals.waitlist.count)} waiting for a place`,
      detail: on ? null : 'The waitlist is switched off, so nobody new can join.',
      href: on ? tab('waitlist') : tab('settings'),
    })
  }

  if (signals.certificates !== 'unavailable'
      && signals.certificates.generated === 0 && signals.certificates.pending > 0) {
    items.push({
      id: 'certs', tone: 'warning',
      title: 'No certificates issued yet',
      detail: `${n(signals.certificates.pending)} attendees are eligible.`,
      href: tab('certificates'),
    })
  }

  return items
}

export function attentionTone(tone: 'critical' | 'warning'): AccentTone {
  return tone === 'critical' ? 'critical' : 'pending'
}

export function toneClass(tone: AccentTone): string {
  return accent(tone).tile
}

// ─── Recent registrations ─────────────────────────────────────────────────────

export interface RecentEntry {
  id:     string
  name:   string
  email:  string | null
  pass:   string | null
  bib:    string | null
  when:   string | null
  checkedIn: boolean
}

/**
 * The latest registrations — a LIST, drawn from the page, and presented as such.
 *
 * The old "Today's activity" timeline was built the same way but titled as though it
 * covered the day: it actually covered whatever fell inside the 51 most recent
 * registrations, which on a busy event is an hour and on a quiet one is a year.
 */
export function recentRegistrations(
  regData: RegistrationsApiResponse | null, limit = 6,
): RecentEntry[] {
  const rows: SerializedRegistration[] = regData?.registrations ?? []
  return [...rows]
    .sort((a, b) => (b.registeredAt ?? '').localeCompare(a.registeredAt ?? ''))
    .slice(0, limit)
    .map(r => ({
      id: r.id,
      name:  r.attendee?.name ?? 'Unknown',
      email: r.attendee?.email ?? null,
      pass:  r.passName ?? null,
      bib:   r.bibNumber ?? null,
      when:  r.registeredAt ?? null,
      checkedIn: Boolean(r.checkedIn),
    }))
}

/** True when the list is a window over a larger set, so the UI can say so. */
export function hasMoreThanPage(regData: RegistrationsApiResponse | null): boolean {
  const total = regData?.stats?.total ?? 0
  return total > (regData?.registrations?.length ?? 0)
}

export function relativeTime(iso: string | null, now: number): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const mins = Math.floor((now - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
