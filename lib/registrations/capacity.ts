import type { CapacityPlan, CapacityPlanMeta, PassAvailability, AvailabilityStatus } from './types'

// ─── Plan definitions ─────────────────────────────────────────────────────────

export const CAPACITY_PLANS: Record<CapacityPlan, CapacityPlanMeta> = {
  free:      { label: 'Free Plan',    limit: 100   },
  pack_500:  { label: '500 Pack',     limit: 500   },
  pack_1000: { label: '1,000 Pack',   limit: 1000  },
  pack_5000: { label: '5,000 Pack',   limit: 5000  },
  unlimited: { label: 'Unlimited',    limit: null  },
}

// Number of remaining seats below which a pass shows "Low Availability".
export const LOW_AVAILABILITY_THRESHOLD = 10

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the total registrations allowed for a plan. null = unlimited. */
export function resolveTotalCapacity(plan: CapacityPlan): number | null {
  return CAPACITY_PLANS[plan]?.limit ?? CAPACITY_PLANS.free.limit
}

/**
 * Computes the effective availability for a single pass, taking both
 * pass-level and event-level capacity into account.
 *
 * Remaining seats = min(passRemaining, eventRemaining).
 * Either dimension being unlimited (null) means only the other dimension binds.
 * Both unlimited → truly unlimited (remaining = null).
 */
export function computePassAvailability({
  passId,
  passCapacity,
  passCount,
  eventCapacity,
  eventTotalCount,
}: {
  passId:          string
  passCapacity:    number | null   // null = pass is unlimited
  passCount:       number
  eventCapacity:   number | null   // null = event plan is unlimited
  eventTotalCount: number
}): PassAvailability {
  const passRemaining  = passCapacity  === null ? null : Math.max(0, passCapacity  - passCount)
  const eventRemaining = eventCapacity === null ? null : Math.max(0, eventCapacity - eventTotalCount)

  let remaining: number | null
  if (passRemaining === null && eventRemaining === null) {
    remaining = null
  } else if (passRemaining === null) {
    remaining = eventRemaining
  } else if (eventRemaining === null) {
    remaining = passRemaining
  } else {
    remaining = Math.min(passRemaining, eventRemaining)
  }

  let status: AvailabilityStatus
  if (remaining !== null && remaining <= 0) {
    status = 'sold_out'
  } else if (remaining !== null && remaining <= LOW_AVAILABILITY_THRESHOLD) {
    status = 'low'
  } else {
    status = 'available'
  }

  return {
    passId,
    passCapacity,
    passCount,
    eventCapacity,
    eventTotalCount,
    remaining,
    status,
  }
}
