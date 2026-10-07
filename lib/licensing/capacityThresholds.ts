// RD-CAPACITY-01 · Capacity threshold detection. PURE + client-safe.
//
// An organizer whose event fills up needs to know before registrations start being refused,
// and needs to know at 100% that the only way to keep accepting them is to buy more capacity.
//
// ═══ WHY THE STATE IS "THE HIGHEST ALREADY SENT" ═════════════════════════════
// The obvious model is a set of thresholds already notified. The problem is that
// registrations arrive in bursts: a sweep can see an event jump from 45% to 97% between two
// runs, which has crossed 50, 70, 85 and 95 at once. Sending four messages for one burst is
// worse than useless, so the state is a single number — the highest percentage already
// announced — and a crossing emits only the HIGHEST newly-crossed threshold. One event, one
// message, whatever the burst size.
//
// ═══ WHY THE STATE IS CAPACITY-STAMPED ══════════════════════════════════════
// Thresholds are relative to capacity, and capacity moves. An event that hit 100% of 500 and
// then bought 500 more is at 50% of 1,000 — and must become eligible to be warned again as it
// fills. So the stored state records the capacity it was computed against; when the capacity
// changes, the state is stale and resets. Without that stamp, buying more capacity would
// permanently silence every future warning for that event.

/** The percentages an organizer is told about, ascending. */
export const CAPACITY_THRESHOLDS = [50, 70, 85, 95, 100] as const

export type CapacityThreshold = typeof CAPACITY_THRESHOLDS[number]

/** The field on events/{slug} that remembers what has already been announced. */
export const CAPACITY_ALERT_FIELD = 'capacityAlert'

/** What the event document remembers. Absent ⇒ nothing has ever been announced. */
export interface CapacityAlertState {
  /** The highest threshold already announced, or 0. */
  lastNotified: number
  /** The capacity `lastNotified` was computed against. A change makes the state stale. */
  capacity:     number
}

/** Coerce a stored value into usable state. Anything unrecognisable reads as "nothing sent". */
export function readAlertState(stored: unknown): CapacityAlertState {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return { lastNotified: 0, capacity: 0 }
  }
  const s = stored as { lastNotified?: unknown; capacity?: unknown }
  return {
    lastNotified: typeof s.lastNotified === 'number' && Number.isFinite(s.lastNotified) ? s.lastNotified : 0,
    capacity:     typeof s.capacity === 'number' && Number.isFinite(s.capacity) ? s.capacity : 0,
  }
}

/** Utilisation as a percentage, 0 when there is no finite capacity to measure against. */
export function utilisationPercent(count: number, capacity: number | null): number {
  if (capacity === null || !Number.isFinite(capacity) || capacity <= 0) return 0
  if (!Number.isFinite(count) || count < 0) return 0
  return (count / capacity) * 100
}

export interface ThresholdDecision {
  /** The single threshold to announce now, or null. */
  threshold:   CapacityThreshold | null
  /** The state to persist. Always returned, so a capacity change is recorded even with no
   *  message to send — that is what re-arms the lower thresholds after an increase. */
  nextState:   CapacityAlertState
  /** True when the stored state was discarded because the capacity moved. */
  reset:       boolean
  percent:     number
}

/**
 * Decide what (if anything) to announce for one event.
 *
 * Deterministic and side-effect free: the same inputs always give the same answer, so the
 * sweep that calls it can be re-run safely and the decision can be unit-tested without a
 * database. Idempotency lives in `nextState.lastNotified` — a second run with the state the
 * first run persisted returns `threshold: null`.
 */
export function decideCapacityAlert(input: {
  count:        number
  capacity:     number | null
  storedState:  unknown
}): ThresholdDecision {
  const { count, capacity } = input
  const stored = readAlertState(input.storedState)

  // An uncapped event can never cross a percentage of infinity.
  if (capacity === null || !Number.isFinite(capacity) || capacity <= 0) {
    return { threshold: null, nextState: stored, reset: false, percent: 0 }
  }

  // The capacity moved ⇒ the stored high-water mark was measured against a different scale
  // and is meaningless. Reset to 0 so the event can be warned again as it refills.
  const reset = stored.capacity !== capacity
  const lastNotified = reset ? 0 : stored.lastNotified

  const percent = utilisationPercent(count, capacity)

  // The highest threshold this event has reached and not yet been told about. Highest, not
  // lowest: a burst that crosses several must produce one message, and it should be the most
  // urgent one, not the most stale.
  let due: CapacityThreshold | null = null
  for (const t of CAPACITY_THRESHOLDS) {
    if (percent >= t && t > lastNotified) due = t
  }

  return {
    threshold: due,
    nextState: { lastNotified: due ?? lastNotified, capacity },
    reset,
    percent,
  }
}

/** The organizer-facing message for a threshold. The 100% case is the one that asks for an
 *  action, because at 100% registrations are being refused. */
export function capacityAlertCopy(threshold: CapacityThreshold, capacity: number): { subject: string; body: string } {
  const cap = capacity.toLocaleString('en-IN')
  if (threshold === 100) {
    return {
      subject: 'Your registration capacity has been reached',
      body: `Your event has reached its registration capacity of ${cap}. New registrations are no longer being accepted. Increase your capacity to continue accepting registrations.`,
    }
  }
  return {
    subject: `Your event is ${threshold}% full`,
    body: `${threshold}% of your ${cap} registration capacity has been used. You can increase your capacity at any time from the event's settings.`,
  }
}
