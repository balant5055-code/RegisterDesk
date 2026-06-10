// Server-only: uses Firebase Admin SDK.
// Never import from client components or pages.

import { getEventBySlug }          from '@/lib/firebase/firestore/events'
import { getRegistrationCounter }  from '@/lib/firebase/firestore/registrationCounters'
import { computePassAvailability, resolveTotalCapacity } from './capacity'
import type {
  RegistrationGateResult, RegistrationBlockReason, CapacityPlan,
} from './types'
import type { EventDetailsDraft, EventSchedule } from '@/components/wizard/eventDetailsConfig'

// ─── Internal pass shape (matches EventPassFull subset) ───────────────────────

interface PassRecord {
  id:             string
  unlimited:      boolean
  quantity:       number | null
  status?:        string   // 'active' | 'inactive'
  salesStartDate?: string  // 'YYYY-MM-DD'
  salesEndDate?:   string  // 'YYYY-MM-DD'
}

// ─── Timezone-aware date helpers ──────────────────────────────────────────────

/**
 * Returns today's date as 'YYYY-MM-DD' in the given IANA timezone.
 * Falls back to UTC when tz is empty or unrecognised.
 */
function todayISOInTz(tz: string): string {
  const zone = tz || 'UTC'
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
  } catch {
    // Unknown timezone string — degrade to UTC
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
  }
}

/**
 * Converts a naive date + time string (stored in Firestore without tz info)
 * to the correct UTC Date by treating them as being in `tz`.
 *
 * Method: approximate the UTC offset at the target moment using the Intl API,
 * then shift the naively-parsed UTC timestamp by that offset.  Accurate to
 * within ±1 h near DST transitions — sufficient for open/close window checks
 * whose granularity is minutes, not seconds.
 */
function toTzUtc(dateStr: string, timeStr: string, tz: string): Date {
  const zone   = tz || 'UTC'
  const time   = timeStr || '23:59'
  // Parse as if UTC (just for arithmetic — the zone is wrong at this point)
  const approx = new Date(`${dateStr}T${time}:00.000Z`)

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(approx)

    const p: Record<string, string> = {}
    for (const { type, value } of parts) p[type] = value

    // hour can be '24' at midnight rollover in some implementations
    const h = p.hour === '24' ? 0 : +p.hour

    // What UTC timestamp corresponds to those tz-local values?
    const tzAsUtcMs = Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second)

    // offsetMs = approx - tzAsUtcMs  (negative for zones east of UTC)
    return new Date(approx.getTime() + (approx.getTime() - tzAsUtcMs))
  } catch {
    // Fallback: interpret naively as UTC
    return approx
  }
}

// ─── Gate ────────────────────────────────────────────────────────────────────

/**
 * Validates whether a registration attempt is allowed.
 *
 * Checks in order:
 *  1. Event exists
 *  2. Event is published and not cancelled/postponed
 *  3. Event has not ended
 *  4. Registration window is open (event-level and pass-level sales dates)
 *  5. Pass exists and is active
 *  6. Event-level capacity not exhausted
 *  7. Pass-level capacity not exhausted
 *
 * All date comparisons use the event's stored IANA timezone so that
 * server deployment timezone (UTC on Vercel/GCP) does not affect behaviour.
 *
 * This function is designed to be called from API routes and server components.
 * It does NOT write anything to Firestore.
 */
export async function checkRegistrationGate(
  slug:   string,
  passId: string,
): Promise<RegistrationGateResult> {
  // ── 1. Load event ───────────────────────────────────────────────────────
  const event = await getEventBySlug(slug)
  if (!event) {
    return { allowed: false, reason: 'EVENT_NOT_FOUND' }
  }

  // ── 2a. Lifecycle status (authoritative — set by organizer actions) ─────────
  const ls = event.lifecycleStatus
  if (ls === 'cancelled') return { allowed: false, reason: 'EVENT_CANCELLED' }
  if (ls === 'registration_closed' || ls === 'completed' || ls === 'archived') {
    return { allowed: false, reason: 'REGISTRATION_CLOSED' }
  }

  // ── 2b. Legacy eventDetails.status.status (informal cancelled/postponed) ──
  const ed        = event.eventDetails as unknown as EventDetailsDraft
  const evStatus  = ed.status?.status

  if (evStatus === 'cancelled') return { allowed: false, reason: 'EVENT_CANCELLED' }
  if (evStatus === 'postponed') return { allowed: false, reason: 'EVENT_POSTPONED' }

  // ── 3. Event end datetime (in event timezone) ────────────────────────────
  const schedule = ed.schedule as EventSchedule | undefined
  const tz       = schedule?.timezone?.trim() || 'UTC'
  const today    = todayISOInTz(tz)

  if (schedule?.endDate && today > schedule.endDate) {
    return { allowed: false, reason: 'REGISTRATION_CLOSED' }
  }
  if (schedule?.endDate && today === schedule.endDate && schedule.endTime) {
    if (new Date() > toTzUtc(schedule.endDate, schedule.endTime, tz)) {
      return { allowed: false, reason: 'REGISTRATION_CLOSED' }
    }
  }

  // ── 4. Event-level registration window (dates live in pricing data) ─────
  const pricing         = event.pricing as Record<string, unknown> | null
  const regOpenDate     = (pricing?.registrationOpenDate  as string | undefined) || ''
  const regEndDate      = (pricing?.registrationEndDate   as string | undefined) || ''
  if (regOpenDate && today < regOpenDate) {
    return { allowed: false, reason: 'REGISTRATION_NOT_OPEN' }
  }
  if (regEndDate && today > regEndDate) {
    return { allowed: false, reason: 'REGISTRATION_CLOSED' }
  }

  // ── 5. Find pass ─────────────────────────────────────────────────────────
  const rawPasses = (event.pricing as Record<string, unknown> | null)?.passes
  const passes    = Array.isArray(rawPasses) ? (rawPasses as PassRecord[]) : []
  const pass      = passes.find(p => p.id === passId)

  if (!pass) return { allowed: false, reason: 'PASS_NOT_FOUND' }

  if (pass.status === 'inactive') return { allowed: false, reason: 'PASS_INACTIVE' }

  // Per-pass sales window (date-only; event timezone for consistency)
  if (pass.salesStartDate && today < pass.salesStartDate) {
    return { allowed: false, reason: 'PASS_SALES_NOT_OPEN' }
  }
  if (pass.salesEndDate && today > pass.salesEndDate) {
    return { allowed: false, reason: 'PASS_SALES_ENDED' }
  }

  // ── 6 + 7. Capacity ──────────────────────────────────────────────────────
  const plan          = (event.capacityPlan ?? 'free') as CapacityPlan
  const eventCapacity = resolveTotalCapacity(plan)
  const counter       = await getRegistrationCounter(slug)
  const eventCount    = counter?.totalCount ?? 0
  const passCount     = counter?.passCounts?.[passId] ?? 0

  if (eventCapacity !== null && eventCount >= eventCapacity) {
    return { allowed: false, reason: 'EVENT_CAPACITY_FULL' }
  }

  const passCapacity = pass.unlimited || pass.quantity == null ? null : pass.quantity
  if (passCapacity !== null && passCount >= passCapacity) {
    return { allowed: false, reason: 'PASS_CAPACITY_FULL' }
  }

  // ── All checks passed ────────────────────────────────────────────────────
  const availability = computePassAvailability({
    passId,
    passCapacity,
    passCount,
    eventCapacity,
    eventTotalCount: eventCount,
  })

  return { allowed: true, availability }
}

// ─── Human-readable reason labels ────────────────────────────────────────────
// Used by the gate API route and the registration form to surface errors.

export const GATE_REASON_LABELS: Record<RegistrationBlockReason, string> = {
  EVENT_NOT_FOUND:       'This event could not be found.',
  EVENT_NOT_PUBLISHED:   'This event is not yet published.',
  EVENT_CANCELLED:       'This event has been cancelled.',
  EVENT_POSTPONED:       'This event has been postponed. Registration is paused.',
  REGISTRATION_NOT_OPEN: 'Registration has not opened yet.',
  REGISTRATION_CLOSED:   'Registration for this event is now closed.',
  EVENT_CAPACITY_FULL:   'This event has reached its maximum capacity.',
  PASS_CAPACITY_FULL:    'This ticket type is sold out.',
  PASS_NOT_FOUND:        'This ticket type could not be found.',
  PASS_INACTIVE:         'This ticket type is no longer available.',
  PASS_SALES_NOT_OPEN:   'Sales for this ticket have not started yet.',
  PASS_SALES_ENDED:      'Sales for this ticket have ended.',
}
