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

/**
 * RD-DASH-13 · the dashboard's OWN status shape, no longer the shared counters type.
 *
 * ═══ WHY IT DIVERGED ═════════════════════════════════════════════════════════
 * `RegistrationStatusCounts` is a flat all-or-nothing record shared with three other API
 * routes, and its `waitlisted` and `total` are plain numbers. The dashboard has to read
 * the waitlist with a SEPARATE aggregate (the counter document carries no waitlist field),
 * so when that one query failed the whole object had to be nulled — there was nowhere to
 * put "waitlist unknown, everything else fine".
 *
 * Measured consequence: one failed waitlist count took `registrationTotals.confirmed` to 0
 * and emptied Registration Status, Pass Distribution and Event Performance, while the
 * Confirmed-registrations KPI — fed straight from the counter — kept its real value. Two
 * contradictory answers on one screen, one of them a zero.
 *
 * Here `waitlisted` and `total` carry their own null. Confirmed, pending, cancelled and
 * rejected come from the counter document and stay authoritative whatever the waitlist
 * query did.
 *
 * ═══ AND `checkedIn` IS GONE ═════════════════════════════════════════════════
 * It was populated by folding each event's attendance shards — one subcollection read per
 * event — and read by nothing: this module never referenced it, and the Check-in card has
 * its own authoritative path. The shared type still carries it for the three routes that
 * do use it; the dashboard simply stops paying for a field it never renders.
 */
export interface EventStatusCounts {
  /** Σ of the parts. null exactly when `waitlisted` is null — a part is missing. */
  total:      number | null
  confirmed:  number
  pending:    number
  cancelled:  number
  rejected:   number
  /** null ⇒ the waitlist aggregate failed. NEVER 0, which would claim an empty waitlist. */
  waitlisted: number | null
}

/** One event's contribution. `null` anywhere means "could not be read" — never zero. */
export interface EventAnalyticsInput {
  slug:       string
  eventName:  string
  /** Authoritative status breakdown for this event. null ⇒ nothing at all could be read. */
  status:     EventStatusCounts | null
  /** passId → CONFIRMED count (registrationCounters.passCounts). */
  passConfirmed: Record<string, number>
  /** passId → CANCELLED count. null ⇒ not computed for this event (never treat as zero). */
  passCancelled: Record<string, number> | null
  /**
   * passId → ticket VALUE in paise, split by outcome. null ⇒ not measured for this event.
   *
   * Registration analytics, not finance: these sum the ticket amount on the registration
   * itself. No gateway fee, no platform fee, no settlement — and `cancelledPaise` is the
   * value of cancelled registrations, NOT the amount refunded through the gateway.
   */
  passValue: Record<string, { salesPaise: number; cancelledPaise: number }> | null
  /** passId → configured pass name, from draft.pricing.passes. */
  passNames:  Record<string, string>
  /**
   * RD-DASH-10 · the event's state, ALREADY RESOLVED by `presentEventStatus`.
   *
   * Resolved by the caller rather than derived here for two reasons: that function is the
   * ONE mapping the selector, the breadcrumb and the event overview all use — so a fourth
   * surface must not grow its own — and it needs a clock, which this module refuses to
   * hold. Null when the caller could not resolve one; the row then shows no state rather
   * than a guessed one.
   */
  statusLabel: string | null
}

export interface PassRow {
  label:     string
  /** Confirmed count. Kept as `count` so existing consumers and the bar chart still work. */
  count:     number
  cancelled: number
  total:     number
  /** Ticket value of the CONFIRMED registrations on this pass. null = not measured. */
  salesPaise:     number | null
  /** Ticket value of the CANCELLED registrations. Never a gateway refund. null = unmeasured. */
  cancelledPaise: number | null
}

/**
 * RD-DASH-10 · one ranked event.
 *
 * Identified by SLUG, not by name. Two events may legitimately carry the same name — the
 * audited workspace has exactly that — and a name-keyed row makes them one row, or makes
 * React reuse one's DOM for the other.
 */
export interface EventPerformanceRow {
  /** Stable identity. Null ONLY on the aggregate remainder row, which is not an event. */
  slug:  string | null
  label: string
  count: number
  /** From `presentEventStatus` — "Live", "Upcoming", "Completed"… Null when unresolved. */
  statusLabel: string | null
}

export interface RegistrationTotals {
  /** null ⇒ at least one event's waitlist was unreadable, so no whole can be stated. */
  total:      number | null
  confirmed:  number
  pending:    number
  /** null ⇒ unmeasured for at least one event in scope. Never 0 on failure. */
  waitlisted: number | null
  cancelled:  number
  rejected:   number
}

/**
 * RD-DASH-13 §4 · one status row, with its share RESOLVED.
 *
 * The panel used to divide `count / regTotals.total` itself. That is a business
 * percentage, and it also had to guess what to do when the denominator was unavailable.
 * Both decisions now live here, beside the numerator.
 */
export interface StatusRow {
  label: string
  count: number
  /** Percent of all registrations. null ⇒ no denominator exists (waitlist unreadable). */
  share: number | null
}

export interface DashboardAnalytics {
  totals:             RegistrationTotals
  registrationStatus: StatusRow[]
  passDistribution:   PassRow[]
  /**
   * RD-DASH-13 §4 · figures the Pass Distribution footer used to reduce for itself.
   * A card that sums its own rows is one refactor away from summing a truncated list.
   */
  passTotals: {
    confirmed: number
    cancelled: number
    /** Σ ticket sales across every pass. null ⇒ any pass was unmeasured. */
    salesPaise: number | null
  }
  /** True when the waitlist could not be read for at least one event in scope. */
  waitlistUnavailable: boolean
  eventPerformance:   EventPerformanceRow[]
  /**
   * Facts about the comparison that the SURFACE must not compute for itself.
   *
   * A card that sums its own rows to print a total is one refactor away from summing a
   * truncated list and calling it "all events".
   */
  eventPerformanceMeta: {
    /** Events compared, BEFORE the Top-N cut. */
    eventCount:     number
    /** Σ confirmed across every compared event — never just the rows on screen. */
    confirmedTotal: number
    /** Individual events listed, excluding the remainder row. */
    shown:          number
  }
  /** At least one event's status counts could not be read — totals are incomplete. */
  statusUnavailable:  boolean
  /**
   * Whether ANY event in scope contributed a genuinely configured pass.
   *
   * RegisterDesk supports event types that have no passes at all. For those, every
   * registration falls into the "Unattributed" bucket and the panel used to render a
   * single unnamed bar — which reads as a pass distribution rather than as the absence of
   * one. False here lets the surface say so instead of inventing a category.
   */
  passDataAvailable:  boolean
  /** Per-pass ticket value could not be measured for at least one event in scope. */
  passValueUnavailable: boolean
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
  // RD-DASH-13 · tracked separately from `statusUnavailable`, which means "an event
  // contributed nothing at all". A missing waitlist loses ONE row, not the event.
  let waitlistUnavailable = false
  let passCancelledUnavailable = false
  let passValueUnavailable = false

  // label → row. Passes with the SAME NAME across different events intentionally merge:
  // the card is organizer-wide, so a pass name means the same thing across every event.
  const rows = new Map<string, PassRow>()
  const bump = (
    label: string, confirmed: number, cancelled: number,
    value?: { salesPaise: number; cancelledPaise: number } | null,
  ) => {
    const r = rows.get(label)
      ?? { label, count: 0, cancelled: 0, total: 0, salesPaise: null, cancelledPaise: null }
    r.count     += confirmed
    r.cancelled += cancelled
    r.total      = r.count + r.cancelled
    // Money accumulates ONLY where it was measured. A pass whose value could not be read
    // keeps null rather than inheriting a 0 that would read as "sold nothing".
    if (value) {
      r.salesPaise     = (r.salesPaise     ?? 0) + value.salesPaise
      r.cancelledPaise = (r.cancelledPaise ?? 0) + value.cancelledPaise
    }
    rows.set(label, r)
  }

  let unattributedConfirmed = 0
  let unattributedCancelled = 0
  const eventPerformance: EventPerformanceRow[] = []

  for (const ev of events) {
    if (!ev.status) { statusUnavailable = true; continue }
    if (ev.passValue === null) passValueUnavailable = true

    // These four are the counter document's own fields. They are authoritative whatever
    // the waitlist aggregate did, so they accumulate unconditionally.
    totals.confirmed  += ev.status.confirmed
    totals.pending    += ev.status.pending
    totals.cancelled  += ev.status.cancelled
    totals.rejected   += ev.status.rejected

    // …and these two are poisoned by a single missing part, which is the whole point:
    // a waitlist that could not be read makes the WAITLIST unknown and therefore the
    // TOTAL unknown, and leaves every other figure standing.
    if (ev.status.waitlisted === null || ev.status.total === null) {
      waitlistUnavailable = true
      totals.waitlisted = null
      totals.total      = null
    } else {
      if (totals.waitlisted !== null) totals.waitlisted += ev.status.waitlisted
      if (totals.total      !== null) totals.total      += ev.status.total
    }

    // Event Performance uses the SAME event set and the SAME confirmed figure as the two
    // breakdowns. They diverged before — one keyed on "ever published", the other on the
    // current lifecycle status — so an unpublished event's registrations counted toward the
    // totals while its row was invisible, and the cards could not be reconciled by eye.
    eventPerformance.push({
      slug:        ev.slug,
      label:       ev.eventName,
      count:       ev.status.confirmed,
      statusLabel: ev.statusLabel,
    })

    const label = (passId: string) => ev.passNames[passId]?.trim() || 'Unassigned'

    /**
     * RD-DASH-04 · the ORGANIZER'S order, not ours.
     *
     * `passNames` is built by walking `draft.pricing.passes`, so its key order IS the order
     * the organizer arranged their passes in. `passCounts` is a Firestore map whose key order
     * is not meaningful, so iterating it decided the display order by accident.
     *
     * Configured passes come first, in their configured order; a passId that appears only in
     * the counters (a pass since renamed or removed) follows, so it is still surfaced rather
     * than dropped.
     */
    const orderedPassIds = (() => {
      const seen = new Set<string>()
      const out: string[] = []
      for (const id of Object.keys(ev.passNames)) { seen.add(id); out.push(id) }
      for (const id of [...Object.keys(ev.passConfirmed), ...Object.keys(ev.passCancelled ?? {})]) {
        if (!seen.has(id)) { seen.add(id); out.push(id) }
      }
      return out
    })()

    // ── Confirmed by pass ────────────────────────────────────────────────────
    const confirmedAttributed = sumValues(ev.passConfirmed)
    if (confirmedAttributed === 0 && ev.status.confirmed > 0) {
      unattributedConfirmed += ev.status.confirmed
    } else {
      for (const passId of orderedPassIds) {
        const n = ev.passConfirmed[passId] ?? 0
        if (n > 0) bump(label(passId), n, 0, ev.passValue?.[passId] ?? null)
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
    for (const passId of orderedPassIds) {
      const n = ev.passCancelled[passId] ?? 0
      if (n > 0) bump(label(passId), 0, n)
    }
    const missingCancelled = ev.status.cancelled - cancelledAttributed
    if (missingCancelled > 0) unattributedCancelled += missingCancelled
  }

  // ── Rank, then fold the tail into a REAL sum ───────────────────────────────
  // RD-DASH-04: NO sort. `rows` is a Map, so it already holds the organizer's CONFIGURED
  // pass order; re-sorting by size replaced their arrangement with ours, and a distribution
  // that reorders itself as registrations arrive is much harder to read week over week.
  const ranked = [...rows.values()]
  const head   = ranked.slice(0, DISPLAY_LIMIT)
  const tail   = ranked.slice(DISPLAY_LIMIT)

  const passDistribution: PassRow[] = [...head]
  if (tail.length > 0) {
    const other = tail.reduce(
      (acc, r) => ({ ...acc, count: acc.count + r.count, cancelled: acc.cancelled + r.cancelled }),
      { label: 'Other', count: 0, cancelled: 0, total: 0 } as PassRow,
    )
    other.total = other.count + other.cancelled
    // "Other" carries money only when EVERY row folded into it was measured; one
    // unmeasured pass makes the bucket unmeasurable rather than understated.
    other.salesPaise     = tail.every(r => r.salesPaise !== null)
      ? tail.reduce((t, r) => t + (r.salesPaise ?? 0), 0) : null
    other.cancelledPaise = tail.every(r => r.cancelledPaise !== null)
      ? tail.reduce((t, r) => t + (r.cancelledPaise ?? 0), 0) : null
    passDistribution.push(other)
  }
  if (unattributedConfirmed > 0 || unattributedCancelled > 0) {
    passDistribution.push({
      label:     'Unattributed',
      count:     unattributedConfirmed,
      cancelled: unattributedCancelled,
      total:     unattributedConfirmed + unattributedCancelled,
      // Unattributed registrations have no pass to aggregate value against, so their
      // money is genuinely unknown rather than zero.
      salesPaise:     null,
      cancelledPaise: null,
    })
  }

  // ── Status rows, WITH their share ─────────────────────────────────────────
  // RD-DASH-13 §4 · the share used to be `count / regTotals.total` inside the panel.
  // It is a business percentage over an authoritative denominator, and when that
  // denominator went unavailable the panel had to invent a rule. Both now live here.
  //
  // A row whose own count is unmeasured (Waitlisted, when its aggregate failed) is not
  // rendered as 0 — it is dropped from the rows and announced by `waitlistUnavailable`,
  // because a status list is read as a partition and a false 0 silently changes the shape
  // of the whole.
  const registrationStatus: StatusRow[] = STATUS_ORDER
    .map(([label, key]) => ({ label, count: totals[key] }))
    .filter((s): s is { label: string; count: number } => s.count !== null && s.count > 0)
    .map(s => ({
      ...s,
      share: totals.total !== null && totals.total > 0 ? (s.count / totals.total) * 100 : null,
    }))

  // ── Pass totals, resolved once ────────────────────────────────────────────
  // Summed over EVERY pass row including the folded "Other" and "Unattributed", so the
  // footer states the whole rather than the visible part. Money stays null unless every
  // contributing row was measured.
  const passTotals = {
    confirmed: passDistribution.reduce((t, p) => t + p.count, 0),
    cancelled: passDistribution.reduce((t, p) => t + p.cancelled, 0),
    salesPaise: passDistribution.filter(p => p.count > 0).every(p => p.salesPaise !== null)
      ? passDistribution.filter(p => p.count > 0).reduce((t, p) => t + (p.salesPaise ?? 0), 0)
      : null,
  }

  // Event Performance gets the same Top-N + real remainder treatment; `.slice(0, 6)` used
  // to discard the tail outright, so the chart could not be reconciled with the totals.
  //
  // RD-DASH-10 · the tie-break is by SLUG, not by name. Two events sharing a name would
  // otherwise order differently between two loads, and the audited workspace has two.
  const evRanked = eventPerformance.sort((a, b) =>
    b.count - a.count
    || a.label.localeCompare(b.label)
    || (a.slug ?? '').localeCompare(b.slug ?? ''))
  const evHead   = evRanked.slice(0, DISPLAY_LIMIT)
  const evRest   = evRanked.slice(DISPLAY_LIMIT).reduce((s, e) => s + e.count, 0)
  // Σ over EVERY compared event, not over the rows that survived the cut.
  const evTotal  = evRanked.reduce((s, e) => s + e.count, 0)

  return {
    totals,
    registrationStatus,
    passDistribution,
    eventPerformance: evRest > 0
      // The remainder is NOT an event: no slug, no state. Both nulls are what the surface
      // reads to give it a rank-less, state-less row.
      ? [...evHead, { slug: null, label: 'Other', count: evRest, statusLabel: null }]
      : evHead,
    eventPerformanceMeta: {
      eventCount:     evRanked.length,
      confirmedTotal: evTotal,
      shown:          evHead.length,
    },
    passTotals,
    waitlistUnavailable,
    statusUnavailable,
    // `rows` holds only bars built from a real passId. An event type with no passes leaves
    // it empty and everything lands in "Unattributed", which is not a distribution.
    passDataAvailable: rows.size > 0,
    passValueUnavailable,
    passCancelledUnavailable,
  }
}

function sumValues(m: Record<string, number>): number {
  let s = 0
  for (const v of Object.values(m)) if (typeof v === 'number' && v > 0) s += v
  return s
}
