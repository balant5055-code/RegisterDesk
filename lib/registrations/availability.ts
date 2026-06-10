import type { RegistrationCounter, PassAvailability, CapacityPlan } from './types'
import { computePassAvailability, resolveTotalCapacity } from './capacity'

// Minimal pass shape needed to compute availability.
// Matches the subset used from EventPassFull (components/wizard/AddPassEditor).
interface PassLike {
  id:        string
  unlimited: boolean
  quantity:  number | null
}

/**
 * Computes a per-pass availability map for an entire event.
 *
 * @param passes        Pass list from event.pricing.passes
 * @param capacityPlan  Event-level capacity plan (defaults to 'free' = 100)
 * @param counter       Live registration counter from Firestore (null if no registrations yet)
 *
 * @returns  Map<passId, PassAvailability> — call `.get(passId)` on the result
 */
export function computeEventAvailability(
  passes:       PassLike[],
  capacityPlan: CapacityPlan,
  counter:      RegistrationCounter | null,
): Map<string, PassAvailability> {
  const eventCapacity    = resolveTotalCapacity(capacityPlan)
  const eventTotalCount  = counter?.totalCount ?? 0

  const map = new Map<string, PassAvailability>()

  for (const pass of passes) {
    const passCapacity = pass.unlimited || pass.quantity == null ? null : pass.quantity
    const passCount    = counter?.passCounts?.[pass.id] ?? 0

    map.set(
      pass.id,
      computePassAvailability({ passId: pass.id, passCapacity, passCount, eventCapacity, eventTotalCount }),
    )
  }

  return map
}
