// RD-CAPACITY-DEFAULT — the registration capacity the License & Services step shows, persisted.
//
// The step opens on the free allowance (100) and quotes it, and the Pay / Publish action is offered
// for that quote. The publish route requires the draft to CARRY a capacity (RD-LICENSE-E2E-03 —
// never inferred), and assumes the wizard's Continue writes one. But License is the FINAL step
// (RD-EVENT-COMMERCE-05B) with no Continue; the selection was saved only when the organizer CHANGED
// it, so a capacity left at its default was shown, quoted and "selected" but never saved — and
// publishing failed with CAPACITY_NOT_CONFIGURED.
//
// This decides the missing write: when the step is open for a draft that does
// not yet carry a valid capacity, the displayed one is persisted (it is INTENT, re-quoted and, if
// chargeable, payment-checked by the server). A capacity the draft already carries — the free
// default or one the organizer chose or paid for — is never overwritten, and a submitted event's
// capacity is never touched here (it changes only through the capacity-change flow).
//
// Nor is a draft whose capacity is still governed by a VERIFIED historical paid tier order
// (lib/licensing/legacyEntitlement — the publish route's own rule, reported by the quote): writing
// 100 there would move it off its paid tier capacity. Until the quote has answered, nothing is
// written; Pay and Publish both wait for that quote, so the write still lands before them.

import { isSubmittedDraftStatus } from './stepRegistry'

/** A stored capacity the publish route will quote: a positive whole number. */
export function isPersistedCapacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * The capacity to write to the draft now, or `null` when nothing should be written.
 *
 * @param draft     the loaded draft (`null` while loading)
 * @param onLicense the License & Services step is the one on screen
 * @param displayed the capacity the step shows (the draft's own, else the free allowance)
 * @param legacy    the quote's verdict for THIS draft: true = verified legacy paid tier,
 *                  false = none, null = not known yet
 */
export function capacityIntentToPersist(
  draft: { id?: unknown; status?: unknown; registrationCapacity?: unknown } | null | undefined,
  onLicense: boolean,
  displayed: number,
  legacy: boolean | null,
): number | null {
  if (legacy !== false) return null
  if (!onLicense || !draft || typeof draft.id !== 'string' || !draft.id) return null
  if (isSubmittedDraftStatus(draft.status)) return null
  if (isPersistedCapacity(draft.registrationCapacity)) return null
  return isPersistedCapacity(displayed) ? displayed : null
}
