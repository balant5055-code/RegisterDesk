// RD-DASH-03 · How an activity's instant is written. PURE — no clock read, no I/O.
//
// ═══ BOTH HALVES, ALWAYS ═════════════════════════════════════════════════════
// A feed row carries a RELATIVE age ("4d ago") and an EXACT instant ("21 Aug 2026 · 9:13 PM").
// The relative half is what an organizer scans; the exact half is what they need the moment
// a gate dispute turns into "when exactly did this person check in". The exact instant used
// to live only in a `title` attribute — invisible on touch, invisible in a screenshot — so it
// is now rendered.
//
// ═══ ONE CLOCK, PASSED IN ════════════════════════════════════════════════════
// `now` is a parameter. Reading the clock inside a formatter makes it impure (React 19
// rejects that during render) and gives every row a slightly different "now", so two
// activities a second apart could both read "1m ago".
//
// ═══ TIMEZONE ════════════════════════════════════════════════════════════════
// Deliberately the viewer's own, formatted with the `en-IN` conventions this dashboard
// already uses everywhere else. There is no app-wide timezone utility to reuse —
// `resolveBroadcastTimezone` resolves a SEND timezone per event/organizer, which is a
// different question — and pinning the feed to a fixed zone would misreport the instant for
// an organizer working outside it.

/** Same shape `Intl` gives us, kept together so a row renders both halves from one call. */
export interface ActivityInstant {
  /** "Today · 9:13 PM" · "Yesterday · 9:13 PM" · "21 Aug 2026 · 9:13 PM" */
  exact:    string
  /** "just now" · "12m ago" · "5h ago" · "4d ago" · "21 Aug" */
  relative: string
  /** Full machine-readable instant for `<time dateTime>` and assistive tech. */
  iso:      string
  /** False when the timestamp could not be parsed — the row still renders, without a time. */
  valid:    boolean
}

const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true }

/** Calendar days between two instants, in LOCAL time — not a 24-hour division. */
function calendarDaysApart(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate())
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

export function formatActivityInstant(iso: string, now: number): ActivityInstant {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) {
    return { exact: '', relative: '', iso, valid: false }
  }
  const nowDate = new Date(now)
  const time    = then.toLocaleTimeString('en-IN', TIME)
  const days    = calendarDaysApart(then, nowDate)

  // "Today" and "Yesterday" are CALENDAR facts: an event at 11pm is still yesterday at 1am,
  // even though only two hours have passed. Dividing elapsed milliseconds by 86,400,000 gets
  // that wrong every night.
  const exact =
    days === 0 ? `Today · ${time}`
    : days === 1 ? `Yesterday · ${time}`
    : `${then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · ${time}`

  return { exact, relative: relativeAge(then.getTime(), now), iso, valid: true }
}

/**
 * The relative half.
 *
 * A future timestamp reads "just now" rather than a negative age: clock skew between a
 * writer and a reader is normal, and "in -3m" is not a thing an organizer should ever see.
 */
export function relativeAge(thenMs: number, now: number): string {
  const diff = now - thenMs
  if (diff < 0) return 'just now'
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(thenMs).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
