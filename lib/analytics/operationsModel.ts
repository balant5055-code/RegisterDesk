// RD-ANALYTICS-10 · the Operations module's derivations. PURE — no Firestore, no React.
//
// ═══ THE QUESTION THIS MODULE SERVES ═════════════════════════════════════════
// "How is the event operationally progressing?" — not how it sold, and not how it is
// growing. Arrivals against expectations, capacity against configuration, and credentials
// against the roster.
//
// ═══ THE TWO RULES THAT SHAPE EVERY FUNCTION HERE ════════════════════════════
//
//   1. A CAPABILITY IS CONFIGURATION, NEVER A TAXONOMY. Nothing in this file reads
//      `eventType`. Whether an event has identifiers or timing chips is decided by that
//      event's own `identifierConfigs` document, and the WORD it uses for them comes from
//      the same place — "Bib", "Badge", "Token", "Wristband". Hardcoding "BIB" would put a
//      running-race noun on a conference badge desk.
//
//   2. AN IMPOSSIBLE NUMBER IS A FINDING, NOT AN ERROR TO HIDE. More people checked in
//      than the event counts as confirmed is a real operational state — a cancellation
//      after admission, a walk-in, a reconciliation gap. Clamping it to 100% and "0
//      remaining" makes an oversubscribed event indistinguishable from a full one.

import type { AnalyticsResponse, Count, OperationsAnalytics } from '@/lib/analytics/contract'

/** A percentage, or null when it cannot be taken. Never 0 for "unknown". */
export function rate(value: Count, total: Count): number | null {
  if (value === null || total === null || total <= 0) return null
  return Math.round((value / total) * 100)
}

/**
 * What the attendance figures MEAN, resolved once.
 *
 * `state` is the load-bearing field. It separates three situations a single percentage
 * cannot distinguish:
 *
 *   unmeasured — a source did not read. No percentage, no shortfall, and no claim.
 *   normal     — checked in ≤ confirmed. `awaited` is how many are still expected.
 *   over       — checked in > confirmed. `excess` is by how many, and it is stated rather
 *                than absorbed, because the organizer needs to reconcile it.
 */
export interface AttendanceReading {
  state:     'unmeasured' | 'normal' | 'over'
  confirmed: Count
  checkedIn: Count
  pct:       Count
  /** Still expected. Present only in the `normal` state. */
  awaited:   Count
  /** Checked in beyond confirmed. Present only in the `over` state. */
  excess:    Count
}

export function readAttendance(o: OperationsAnalytics): AttendanceReading {
  const { confirmed, checkedIn, pct, awaited, over } = o.attendance
  if (confirmed === null || checkedIn === null) {
    return { state: 'unmeasured', confirmed, checkedIn, pct, awaited: null, excess: null }
  }
  return over
    ? { state: 'over',   confirmed, checkedIn, pct, awaited: null, excess: checkedIn - confirmed }
    : { state: 'normal', confirmed, checkedIn, pct, awaited, excess: null }
}

/**
 * The capacity reading, or null when the event has no configured capacity.
 *
 * Absence is the honest answer for an uncapped event: a "0%" meter reads as "nobody has
 * registered", and a capacity inferred from a pass maximum or a venue note would be a
 * different quantity wearing the same label.
 */
export interface CapacityReading {
  configured: number
  confirmed:  Count
  /** TRUE percentage — 104 for 1,040 of 1,000. Never clamped. */
  usedPct:    Count
  /** Places left. NEGATIVE when oversubscribed. */
  remaining:  Count
  over:       boolean
  /** Width for a bar, clamped to the track. The FIGURE above stays truthful. */
  barPct:     number
}

export function readCapacity(o: OperationsAnalytics): CapacityReading | null {
  const c = o.capacity
  if (!c) return null
  return {
    configured: c.configured,
    confirmed:  c.confirmed,
    usedPct:    c.usedPct,
    remaining:  c.remaining,
    over:       c.over,
    // The ONE place a clamp belongs: a bar cannot be drawn past its track.
    barPct:     c.usedPct === null ? 0 : Math.min(100, Math.max(0, c.usedPct)),
  }
}

/**
 * Credential progress, in the event's own vocabulary.
 *
 * `unrecorded` is a third state, not a rounding error: a confirmed registration created
 * before the tracking field existed is neither assigned nor waiting, and folding it into
 * "without" would claim those people are queued for a number nobody has promised them.
 */
export interface CredentialReading {
  label:      string
  eligible:   Count
  assigned:   Count
  unassigned: Count
  unrecorded: Count
  pct:        number | null
}

export function readIdentifiers(o: OperationsAnalytics): CredentialReading | null {
  const i = o.identifiers
  if (!i) return null
  return {
    label: i.label, eligible: i.eligible, assigned: i.assigned,
    unassigned: i.unassigned, unrecorded: i.unrecorded,
    pct: rate(i.assigned, i.eligible),
  }
}

export interface TimingReading {
  label:    string
  attached: Count
  replaced: Count
  removed:  Count
  /** Attached against the confirmed roster — how much of the field is chipped. */
  pct:      number | null
}

export function readTiming(o: OperationsAnalytics): TimingReading | null {
  const t = o.timing
  if (!t) return null
  return {
    label: t.label, attached: t.attached, replaced: t.replaced, removed: t.removed,
    // Deliberately against CONFIRMED, not against attached+replaced+removed: the question
    // is how much of the field carries a chip, not how many chips the event has handled.
    pct: rate(t.attached, o.attendance.confirmed),
  }
}

/**
 * The period check-in figure and its comparison — from the SHARED overview metric.
 *
 * `overview.checkedIn` is already period-against-preceding-period, both sides summed from
 * the same `organizerDailyStats` rows the trend is drawn from. Re-deriving it here would
 * create a second attendance comparison that could disagree with the Overview's.
 */
export function periodCheckIns(data: AnalyticsResponse) {
  return data.overview.checkedIn
}

/**
 * Which conditional panels this event actually has.
 *
 * Read from the resolved capability panels rather than from the payload sections, so the
 * module cannot disagree with the gate that decided whether a panel exists at all — the
 * same rule the Registrations module follows for the waitlist.
 */
export function operationalPanels(data: AnalyticsResponse): {
  identifiers: boolean
  timing:      boolean
  waitlist:    boolean
} {
  const p = data.capabilities.panels
  return {
    identifiers: p.includes('identifiers'),
    timing:      p.includes('timing'),
    waitlist:    p.includes('waitlist'),
  }
}
