// RD-RT3.2.2 BUG 3 — the ONE canonical age-eligibility check.
//
// The pass editor (components/wizard/AddPassEditor.tsx) stores `raceDetails.minAge` and
// `raceDetails.maxAge` per pass, but registration never enforced them: any date of birth
// was accepted, so a 9-year-old could register for a 12+ race.
//
// Two things this gets right that a naive check does not:
//
//   1. Age is measured on the EVENT DATE, not today. A runner who turns 12 the week
//      after the race is 11 on race day and is not eligible, however close it is.
//   2. The date maths is calendar-based, never millisecond division. Dividing by
//      365.25 days drifts across leap years and can report the wrong age by a day
//      either side of a birthday.
//
// Pure and dependency-free (one type import) so the client form and the server validator
// can share it — the same arrangement resolveAttendeeIdentity uses for identity.

import type { FieldType } from '@/components/wizard/registrationFormConfig'

export interface AgeLimits {
  minAge: number | null
  maxAge: number | null
}

export interface DobField {
  id:    string
  type:  FieldType
  label: string
}

// A date field that asks for the participant's birth date. The registration-form builder
// labels its own field "Date of Birth"; organisers commonly write "DOB" or "Birth date".
// Deliberately narrow — a generic "date" field (travel date, preferred slot) must never
// be treated as a birth date and blocked.
const DOB_LABEL = /\b(date\s*of\s*birth|dob|birth\s*date|birthdate|d\.o\.b)\b/i

/**
 * The birth-date field, or null when the form has none.
 * Deterministic and order-stable: the first matching field in field order wins.
 */
export function resolveDobField<T extends DobField>(fields: T[]): T | null {
  for (const f of fields) {
    if (f.type === 'date' && DOB_LABEL.test(f.label)) return f
  }
  return null
}

/**
 * Whole years completed on `onDate`. Calendar arithmetic — no millisecond division —
 * so leap years and birthdays either side of the date are exact.
 *
 * Returns null when either date is missing or unparseable, so callers can distinguish
 * "cannot tell" from "too young".
 */
export function ageOn(dob: string, onDate: string): number | null {
  const b = parseYmd(dob)
  const e = parseYmd(onDate)
  if (!b || !e) return null

  let age = e.y - b.y
  // Not yet had the birthday in the event year → one year younger.
  if (e.m < b.m || (e.m === b.m && e.d < b.d)) age -= 1
  return age
}

function parseYmd(value: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  // Reject impossible calendar dates (31 Feb, 30 Feb in a leap year, …).
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  return { y, m: mo, d }
}

/**
 * The eligibility message for a submitted date of birth, or null when it is acceptable
 * (including when there is nothing to check against).
 *
 * `eventDate` absent → no message: an event without a date cannot have a race-day age,
 * and a registration must never be blocked by data the organiser did not provide.
 */
export function ageEligibilityError(
  dob:       string,
  eventDate: string | null | undefined,
  limits:    AgeLimits,
): string | null {
  const { minAge, maxAge } = limits
  if (minAge == null && maxAge == null) return null
  if (!dob?.trim() || !eventDate?.trim()) return null

  const age = ageOn(dob, eventDate)
  if (age == null) return null
  if (age < 0) return 'Enter a date of birth on or before the event date.'

  const outOfRange = (minAge != null && age < minAge) || (maxAge != null && age > maxAge)
  if (!outOfRange) return null

  // RD-RT3.2.3: the message names the WINDOW, not just the bound that failed — an
  // attendee who is too young for a 12–17 pass needs to know the upper bound too, or
  // they cannot tell which pass to switch to. The parenthetical explains the rejection,
  // and says "on the event date" because that is what makes the number surprising.
  const why = `(you would be ${age} on the event date)`

  if (minAge != null && maxAge != null) {
    return `This pass is only available for participants aged ${minAge}–${maxAge} years ${why}.`
  }
  if (minAge != null) {
    return `Minimum age for this pass is ${minAge} years ${why}.`
  }
  return `Maximum age for this pass is ${maxAge} years ${why}.`
}

/**
 * RD-RT4.0 — build the eligibility context from the SERVER-loaded event and pass.
 *
 * The client derives the same three values from props; this derives them from the
 * Firestore documents the route already holds, so the rule is enforced against data the
 * browser cannot influence. Both sides then call the identical `ageEligibilityError`.
 *
 * Everything is read defensively: a pass with no `raceDetails`, or an event with no
 * start date, yields null limits and the age rule is skipped — exactly the behaviour
 * events without age restrictions had before.
 */
export function resolveServerEligibility(
  eventDetails: Record<string, unknown> | null | undefined,
  pass:         Record<string, unknown> | null | undefined,
): { eventDate: string | null; minAge: number | null; maxAge: number | null } {
  const schedule  = eventDetails?.schedule as Record<string, unknown> | null | undefined
  const eventDate = typeof schedule?.startDate === 'string' ? schedule.startDate : null

  const rd = pass?.raceDetails as Record<string, unknown> | null | undefined
  return {
    eventDate,
    minAge: typeof rd?.minAge === 'number' ? rd.minAge : null,
    maxAge: typeof rd?.maxAge === 'number' ? rd.maxAge : null,
  }
}

/**
 * The human label for a pass's age window, or null when it is unrestricted.
 *
 *   12–17  → '12–17 years'      18 / no max → '18+'
 *   no min → 'Up to 60 years'   neither     → null (caller hides the row entirely)
 *
 * One definition, used by the pass selector, the pass picker and the review — so a
 * range can never be phrased three different ways.
 */
export function ageRangeLabel({ minAge, maxAge }: AgeLimits): string | null {
  if (minAge == null && maxAge == null) return null
  if (minAge != null && maxAge != null) return `${minAge}–${maxAge} years`
  if (minAge != null) return `${minAge}+`
  return `Up to ${maxAge} years`
}
