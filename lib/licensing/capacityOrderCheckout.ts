// RD-L6 D1 · ONE way to open a checkout for a capacity change — shared by the dashboard route
// (/api/licensing/capacity/order) and the wizard route (/api/licensing/published/purchase). Server-only.
//
// Invariant: a new request never leaves a second payable capacity order for the same event. The
// decision is made INSIDE the transaction that claims the sequence number
// (createCapacityChangeOrder with `reuse`); this module only does what cannot run in a transaction —
// the Razorpay calls — around it:
//
//   • identical pending order         → reused (same order, same Razorpay order; nothing new created)
//   • pending order still "starting"  → an identical one is awaited briefly (bounded), else 409 processing
//   • different pending order         → M3 capture lookup (captured / unknown ⇒ 409, never replaced);
//                                       "none" ⇒ M4 transactional supersede ⇒ ONE more decision (bounded)
//   • nothing pending                 → new order; Razorpay order created OUTSIDE the transaction and
//                                       attached only while the order is still untouched
//
// No refunds, no wallet, no money moved here.

import { razorpay } from '@/lib/razorpay/client'
import { adminDb } from '@/lib/firebase/admin'
import { LICENSE_ORDERS_COLLECTION } from './schema'
import type { CapacityQuote } from './capacityPricing'
import type { CapacityChargeSnapshot } from './schema'
import type { ServiceChargeItem } from './serviceAllowances'
import {
  createCapacityChangeOrder, attachCapacityRazorpayOrder, supersedeCapacityOrder,
} from './capacityChange'

/** RD-M3 — three-state capture lookup for a pending order: a response without `items` is unknown. */
export async function hasCapturedPayment(razorpayOrderId: string, amountPaise: number): Promise<boolean | 'unknown'> {
  try {
    const res = await razorpay.orders.fetchPayments(razorpayOrderId) as { items?: unknown } | null | undefined
    if (!res || !Array.isArray(res.items)) return 'unknown'
    return (res.items as Array<{ status?: string; amount?: number; currency?: string } | null>)
      .some(p => !!p && (p.status === 'captured' || p.status === 'authorized') && p.currency === 'INR' && p.amount === amountPaise)
  } catch { return 'unknown' }
}

/** How long (in total) a request waits for an identical "starting" order to receive its Razorpay id. */
const STARTING_WAIT_ATTEMPTS = 10
const STARTING_WAIT_MS       = 250

export const CAPACITY_ORDER_PROCESSING_MESSAGE = 'A payment for this event is already being processed. Refresh the status in a moment.'

export type OpenCapacityCheckout =
  | { kind: 'free'; quote: CapacityQuote; snapshot: CapacityChargeSnapshot }
  | { kind: 'checkout'; orderId: string; reused: boolean; quote: CapacityQuote; snapshot: CapacityChargeSnapshot
      razorpayOrderId: string; razorpayAmountPaise: number }
  | { kind: 'fail'; status: number; code: string; message: string }

async function awaitStartedOrder(orderId: string): Promise<string | null> {
  for (let i = 0; i < STARTING_WAIT_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, STARTING_WAIT_MS))
    const snap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(orderId).get()
    const o = snap.exists ? snap.data() as Record<string, unknown> : undefined
    if (!o || o.status !== 'created' || o.manualRefundHoldId != null) return null
    if (typeof o.razorpayOrderId === 'string' && o.razorpayOrderId) return o.razorpayOrderId
  }
  return null
}

export async function openCapacityCheckout(input: {
  eventId:       string            // the live event slug
  organizerUid:  string
  newCapacity:   unknown
  serviceItems?: ServiceChargeItem[]
  draftId?:      string
  /** Extra Razorpay order notes (kind/eventId/organizerUid/orderId/operation/capacity are always set here). */
  notes?:        Record<string, string>
  logTag:        string
}): Promise<OpenCapacityCheckout> {
  const processing = { kind: 'fail' as const, status: 409, code: 'PAYMENT_PROCESSING', message: CAPACITY_ORDER_PROCESSING_MESSAGE }

  // At most TWO decisions: the first, and one more after a successful supersede. Never a loop.
  for (let attempt = 0; attempt < 2; attempt++) {
    const created = await createCapacityChangeOrder({
      eventId: input.eventId, organizerUid: input.organizerUid, newCapacity: input.newCapacity,
      serviceItems: input.serviceItems, draftId: input.draftId, reuse: true,
    })

    if (!created.ok) {
      if (created.code === 'ORDER_STARTING' && 'pending' in created) {
        // Another request is between its order transaction and its Razorpay call. An IDENTICAL order
        // is awaited (bounded) and then reused; anything else is told to retry. Never a second order.
        if (!created.pending.identical) return processing
        const rzp = await awaitStartedOrder(created.pending.orderId)
        if (!rzp) return processing
        const again = await createCapacityChangeOrder({
          eventId: input.eventId, organizerUid: input.organizerUid, newCapacity: input.newCapacity,
          serviceItems: input.serviceItems, draftId: input.draftId, reuse: true,
        })
        if (again.ok && again.result.reused && again.result.razorpayOrderId) {
          return { kind: 'checkout', orderId: again.result.orderId, reused: true, quote: again.result.quote, snapshot: again.result.snapshot,
            razorpayOrderId: again.result.razorpayOrderId, razorpayAmountPaise: again.result.razorpayAmountPaise }
        }
        return processing
      }
      if (created.code === 'ORDER_PENDING' && 'pending' in created) {
        if (attempt > 0 || !created.pending.razorpayOrderId) return processing
        // RD-M3 — only a verified "nothing captured" may replace it; captured / authorised / unknown block.
        const captured = await hasCapturedPayment(created.pending.razorpayOrderId, created.pending.razorpayAmountPaise)
        if (captured !== false) return processing
        // RD-M4 — transactional re-check: never supersede an order that was settled or held meanwhile.
        if (!(await supersedeCapacityOrder(created.pending.orderId, created.pending.razorpayOrderId))) return processing
        continue
      }
      const status = created.code === 'FORBIDDEN' ? 403 : created.code === 'EVENT_NOT_FOUND' ? 404 : 422
      return { kind: 'fail', status, code: created.code, message: created.message }
    }

    const r = created.result
    if (!r.orderId) return { kind: 'free', quote: r.quote, snapshot: r.snapshot }
    if (r.reused && r.razorpayOrderId) {
      return { kind: 'checkout', orderId: r.orderId, reused: true, quote: r.quote, snapshot: r.snapshot,
        razorpayOrderId: r.razorpayOrderId, razorpayAmountPaise: r.razorpayAmountPaise }
    }

    // A NEW order. The Razorpay call stays OUTSIDE the transaction; its id is attached only while the
    // order is untouched. Any failure ⇒ no checkout: the order rests `created` without a Razorpay id,
    // which the next request treats as "starting" and, after the window, abandons and replaces.
    let rzpId: string
    try {
      const rzp = await razorpay.orders.create({
        amount: r.razorpayAmountPaise, currency: 'INR', receipt: r.orderId.slice(0, 40),
        notes: {
          kind: 'license_capacity', eventId: input.eventId, organizerUid: input.organizerUid, orderId: r.orderId,
          operation: r.quote.kind, capacity: String(r.quote.capacity), ...(input.notes ?? {}),
        },
      })
      rzpId = rzp.id
    } catch (err) {
      console.error(`[${input.logTag}] failed to create the Razorpay order · orderId=${r.orderId}`, err)
      return { kind: 'fail', status: 502, code: 'GATEWAY', message: 'Could not start the payment. Nothing was charged — please try again.' }
    }
    let attached = false
    try { attached = await attachCapacityRazorpayOrder(r.orderId, rzpId) }
    catch (err) { console.error(`[${input.logTag}] failed to persist the Razorpay order id · orderId=${r.orderId} razorpayOrderId=${rzpId}`, err) }
    if (!attached) {
      console.error(`[${input.logTag}] Razorpay order NOT attached (order changed or write failed) — no checkout returned · orderId=${r.orderId} razorpayOrderId=${rzpId}`)
      return { kind: 'fail', status: 502, code: 'GATEWAY', message: 'Could not start the payment. Nothing was charged — please try again.' }
    }
    return { kind: 'checkout', orderId: r.orderId, reused: false, quote: r.quote, snapshot: r.snapshot,
      razorpayOrderId: rzpId, razorpayAmountPaise: r.razorpayAmountPaise }
  }
  return processing
}
