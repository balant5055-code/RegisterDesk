// RD-EVENT-COMMERCE-02 · the activation-payment status the wizard's Payment step shows.
//
// PURE. It turns the singleton activation order (`licenseOrders/lic_{draftId}`) into the
// four states the organizer needs to see — nothing to pay yet, checkout started, paid, or
// failed — without exposing the order itself (Razorpay ids, coupon snapshots, ownership).
//
// It is DISPLAY ONLY. Whether a payment covers the capacity at submit time is still decided by
// /api/licensing/purchase (the `alreadyPaid` retry path) and by the publish route's re-quote;
// nothing here is consulted by either.

import type { LicenseOrderDoc } from './schema'

export type ActivationPaymentState = 'none' | 'pending' | 'paid' | 'failed' | 'refunded'

export interface ActivationStatus {
  state:       ActivationPaymentState
  /** Capacity the order was priced for; null for a legacy tier order or no order. */
  capacity:    number | null
  /** The final charged amount on the order, in paise; null when there is no order. */
  amountPaise: number | null
}

export const NO_ACTIVATION: ActivationStatus = { state: 'none', capacity: null, amountPaise: null }

/**
 * Summarise an activation order for `workspaceUid`.
 *
 * An order that belongs to a different organizer reads as `none`: the caller learns nothing
 * about an event it does not own, not even that an order exists.
 */
export function summarizeActivationOrder(
  order: Pick<LicenseOrderDoc, 'organizerUid' | 'status' | 'amountPaise' | 'capacityChange'> | null | undefined,
  workspaceUid: string,
): ActivationStatus {
  if (!order || order.organizerUid !== workspaceUid) return NO_ACTIVATION
  const state: ActivationPaymentState =
    order.status === 'paid'     ? 'paid'
    : order.status === 'created'  ? 'pending'
    : order.status === 'refunded' ? 'refunded'
    : 'failed'
  const capacity = typeof order.capacityChange?.capacity === 'number' ? order.capacityChange.capacity : null
  const amountPaise = typeof order.amountPaise === 'number' ? order.amountPaise : null
  return { state, capacity, amountPaise }
}

/**
 * Does a PAID order already cover `capacity`? Mirrors the purchase route's retry rule
 * (a paid capacity order is the same purchase when it bought AT LEAST the capacity now
 * requested) so the Payment step's label agrees with what the server will do.
 */
export function activationCovers(status: ActivationStatus, capacity: number): boolean {
  return status.state === 'paid' && status.capacity !== null && status.capacity >= capacity
}
