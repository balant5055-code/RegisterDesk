import type { RegistrationCounter, PassAvailability } from './types'
import { computePassAvailability } from './capacity'

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
 * RD-CAPACITY-02 · takes the event's EFFECTIVE capacity, not its capacity PLAN.
 *
 * It used to take a `CapacityPlan` and expand it through `resolveTotalCapacity`. That was
 * wrong the moment capacities stopped being bucket-shaped: an event with
 * `totalCapacity = 437` carries the legacy plan `pack_500`, so this function reported 500 and
 * the public page advertised 63 seats that did not exist. The gate still refused at 437, so
 * nothing oversold — the attendee was simply told there was room and then refused at checkout.
 *
 * Callers pass `deriveStoredEventCapacity(event)`, which is the same canonical derivation the
 * registration gate and the atomic registration transaction use. All three now agree by
 * construction instead of by coincidence.
 *
 * @param passes         Pass list from event.pricing.passes
 * @param eventCapacity  The event's effective capacity; `null` = unlimited
 * @param counter        Live registration counter from Firestore (null if no registrations yet)
 *
 * @returns  Map<passId, PassAvailability> — call `.get(passId)` on the result
 */
export function computeEventAvailability(
  passes:        PassLike[],
  eventCapacity: number | null,
  counter:       RegistrationCounter | null,
): Map<string, PassAvailability> {
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
