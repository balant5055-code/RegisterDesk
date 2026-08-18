// RD-DASHBOARD-03 · organizer-wide registration analytics. PURE — no Firestore, no I/O.
//
// ═══ WHY THIS IS A SEPARATE PURE MODULE ══════════════════════════════════════
// These numbers are the ones an organizer trusts to answer "how many people are coming".
// Deriving them inline in the route made them untestable without booting Firebase, and they
// had no test coverage at all. Everything below is a function of its inputs, so every rule
// — reconciliation, the Unassigned/Unattributed split, Top-N + Other — is pinned by tests
// that need no emulator.
//
// ═══ THE RULES, AND WHY EACH EXISTS ══════════════════════════════════════════
//
// RECONCILIATION IS THE POINT. Σ(confirmed over passes) must equal the confirmed total, and
// Σ(cancelled over passes) must equal the cancelled total. Any residue is surfaced, never
// absorbed — a chart that silently disagrees with the status card is worse than no chart.
//
// NOTHING IS DERIVED BY SUBTRACTION. Confirmed comes from `passCounts`, cancelled from its
// own count() aggregates, and the status totals from the authoritative status aggregate.
// Inferring one status by subtracting others assumes a closed world that registrations do
// not have (a status can be added tomorrow), and would silently mis-attribute the difference.
//
// MISSING DATA IS NEVER ZERO. An event whose counts could not be read sets an availability
// flag rather than contributing 0, because a confident zero is indistinguishable from "we
// could not tell" once it reaches a chart.
//
// TWO DIFFERENT KINDS OF "WE DON'T KNOW":
//   • Unassigned   — a LIVE registration carrying a passId the event no longer defines
//                    (renamed/removed pass). The registration is real and current.
//   • Unattributed — attribution that is permanently GONE. A historical dotted-key defect
//                    left `passCounts` empty on some older events, so their per-pass split
//                    cannot be recovered at any cost. Reporting it keeps the total honest.

import type { RegistrationStatusCounts } from '@/lib/firebase/firestore/registrationCounters'

/** One event's contribution. `null` anywhere means "could not be read" — never zero. */
export interface EventAnalyticsInput {
  slug:       string
  eventName:  string
  /** Authoritative status breakdown for this event. null ⇒ unavailable. */
  status:     RegistrationStatusCounts | null
  /** passId → CONFIRMED count (registrationCounters.passCounts). */
  passConfirmed: Record<string, number>
  /** passId → CANCELLED count. null ⇒ not computed for this event (never treat as zero). */
  passCancelled: Record<string, number> | null
  /** passId → configured pass name, from draft.pricing.passes. */
  passNames:  Record<string, string>
}

export interface PassRow {
  label:     string
  /** Confirmed count. Kept as `count` so existing consumers and the bar chart still work. */
  count:     number
  cancelled: number
  total:     number
}

export interface RegistrationTotals {
  total:      number
  confirmed:  number
  pending:    number
  waitlisted: number
  cancelled:  number
  rejected:   number
}

export interface DashboardAnalytics {
  totals:             RegistrationTotals
  registrationStatus: { label: string; count: number }[]
  passDistribution:   PassRow[]
  eventPerformance:   { label: string; count: number }[]
  /** At least one event's status counts could not be read — totals are incomplete. */
  statusUnavailable:  boolean
  /** Per-pass cancelled could not be computed for at least one event that HAS cancellations. */
  passCancelledUnavailable: boolean
}

/** Display cap for both breakdowns. The remainder is SUMMED into "Other", never dropped. */
export const DISPLAY_LIMIT = 6

/** Status rows, in the order an organizer reads them. `rejected` is never folded into cancelled. */
const STATUS_ORDER: Array<[string, keyof RegistrationTotals]> = [
  ['Confirmed',  'confirmed'],
  ['Pending',    'pending'],
  ['Waitlisted', 'waitlisted'],
  ['Cancelled',  'cancelled'],
  ['Rejected',   'rejected'],
]

export function buildDashboardAnalytics(events: EventAnalyticsInput[]): DashboardAnalytics {
  const totals: RegistrationTotals = {
    total: 0, confirmed: 0, pending: 0, waitlisted: 0, cancelled: 0, rejected: 0,
  }
  let statusUnavailable = false
  let passCancelledUnavailable = false

  // label → row. Passes with the SAME NAME across different events intentionally merge:
  // the card is organizer-wide, so "5 KM Marathon" means the same thing everywhere.
  const rows = new Map<string, PassRow>()
  const bump = (label: string, confirmed: number, cancelled: number) => {
    const r = rows.get(label) ?? { label, count: 0, cancelled: 0, total: 0 }
    r.count     += confirmed
    r.cancelled += cancelled
    r.total      = r.count + r.cancelled
    rows.set(label, r)
  }

  let unattributedConfirmed = 0
  let unattributedCancelled = 0
  const eventPerformance: { label: string; count: number }[] = []

  for (const ev of events) {
    if (!ev.status) { statusUnavailable = true; continue }

    totals.total      += ev.status.total
    totals.confirmed  += ev.status.confirmed
    totals.pending    += ev.status.pending
    totals.waitlisted += ev.status.waitlisted
    totals.cancelled  += ev.status.cancelled
    totals.rejected   += ev.status.rejected

    // Event Performance uses the SAME event set and the SAME confirmed figure as the two
    // breakdowns. They diverged before — one keyed on "ever published", the other on the
    // current lifecycle status — so an unpublished event's registrations counted toward the
    // totals while its row was invisible, and the cards could not be reconciled by eye.
    eventPerformance.push({ label: ev.eventName, count: ev.status.confirmed })

    const label = (passId: string) => ev.passNames[passId]?.trim() || 'Unassigned'

    // ── Confirmed by pass ────────────────────────────────────────────────────
    const confirmedAttributed = sumValues(ev.passConfirmed)
    if (confirmedAttributed === 0 && ev.status.confirmed > 0) {
      unattributedConfirmed += ev.status.confirmed
    } else {
      for (const [passId, n] of Object.entries(ev.passConfirmed)) {
        if (n > 0) bump(label(passId), n, 0)
      }
      // A counter that drifted BELOW the authoritative confirmed total leaves a remainder
      // that belongs to no pass. Surfacing it is what keeps the column reconciled.
      const missing = ev.status.confirmed - confirmedAttributed
      if (missing > 0) unattributedConfirmed += missing
    }

    // ── Cancelled by pass ────────────────────────────────────────────────────
    if (ev.status.cancelled === 0) continue          // nothing to attribute
    if (ev.passCancelled === null) {
      // Not computed for this event. Reporting 0 here would invent a fact.
      passCancelledUnavailable = true
      continue
    }
    const cancelledAttributed = sumValues(ev.passCancelled)
    for (const [passId, n] of Object.entries(ev.passCancelled)) {
      if (n > 0) bump(label(passId), 0, n)
    }
    const missingCancelled = ev.status.cancelled - cancelledAttributed
    if (missingCancelled > 0) unattributedCancelled += missingCancelled
  }

  // ── Rank, then fold the tail into a REAL sum ───────────────────────────────
  const ranked = [...rows.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
  const head   = ranked.slice(0, DISPLAY_LIMIT)
  const tail   = ranked.slice(DISPLAY_LIMIT)

  const passDistribution: PassRow[] = [...head]
  if (tail.length > 0) {
    const other = tail.reduce(
      (acc, r) => ({ ...acc, count: acc.count + r.count, cancelled: acc.cancelled + r.cancelled }),
      { label: 'Other', count: 0, cancelled: 0, total: 0 } as PassRow,
    )
    other.total = other.count + other.cancelled
    passDistribution.push(other)
  }
  if (unattributedConfirmed > 0 || unattributedCancelled > 0) {
    passDistribution.push({
      label:     'Unattributed',
      count:     unattributedConfirmed,
      cancelled: unattributedCancelled,
      total:     unattributedConfirmed + unattributedCancelled,
    })
  }

  const registrationStatus = STATUS_ORDER
    .map(([label, key]) => ({ label, count: totals[key] }))
    .filter(s => s.count > 0)

  // Event Performance gets the same Top-N + real Other treatment; `.slice(0, 6)` used to
  // discard the tail outright, so the chart could not be reconciled with the totals either.
  const evRanked = eventPerformance.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const evHead   = evRanked.slice(0, DISPLAY_LIMIT)
  const evRest   = evRanked.slice(DISPLAY_LIMIT).reduce((s, e) => s + e.count, 0)

  return {
    totals,
    registrationStatus,
    passDistribution,
    eventPerformance: evRest > 0 ? [...evHead, { label: 'Other', count: evRest }] : evHead,
    statusUnavailable,
    passCancelledUnavailable,
  }
}

function sumValues(m: Record<string, number>): number {
  let s = 0
  for (const v of Object.values(m)) if (typeof v === 'number' && v > 0) s += v
  return s
}
