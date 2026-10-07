// RD-EVENT-COMMERCE-05 · an event's PAID licensing purchases, for the organizer's
// Licence & Services page. Server-only, read-only: no order is created, re-priced or changed.
//
// The activation order and pre-publish add-ons are keyed by the DRAFT id; capacity changes of a
// live event by its SLUG — both are read, deduplicated, and filtered to the owning workspace.
// Amounts and quantities are reported from each order's own snapshot, never recomputed, so the
// history cannot drift with configuration.

import { adminDb } from '@/lib/firebase/admin'
import { LICENSE_ORDERS_COLLECTION } from './schema'
import type { ServiceKind } from './serviceAllowances'

export interface PurchaseHistoryEntry {
  orderId:     string
  kind:        'activation' | 'addon' | 'capacity_change'
  paidAt:      string | null
  /** Capacity after this purchase (activation / add-on / change), when it set one. */
  capacity:    number | null
  previousCapacity: number | null
  services:    Array<{ service: ServiceKind; quantity: number }>
  totalPaise:  number
}

const MAX_ENTRIES = 25

const toIso = (v: unknown): string | null =>
  v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null

export async function readPurchaseHistory(input: { draftId: string; slug: string | null; organizerUid: string }): Promise<PurchaseHistoryEntry[]> {
  const ids = [...new Set([input.draftId, input.slug].filter((x): x is string => typeof x === 'string' && x.length > 0))]
  const snaps = await Promise.all(ids.map(id =>
    adminDb.collection(LICENSE_ORDERS_COLLECTION).where('eventId', '==', id).limit(MAX_ENTRIES).get()))
  const seen = new Set<string>()
  const out: Array<PurchaseHistoryEntry & { _t: number }> = []
  for (const d of snaps.flatMap(s => s.docs)) {
    if (seen.has(d.id)) continue
    seen.add(d.id)
    const o = d.data() as Record<string, unknown>
    if (o.status !== 'paid' || o.organizerUid !== input.organizerUid) continue
    const cc = (o.capacityChange ?? null) as { operation?: string; capacity?: number; previousCapacity?: number | null } | null
    const items = Array.isArray(o.serviceItems) ? o.serviceItems as Array<{ service: ServiceKind; quantity: number }> : []
    const purpose = typeof o.purpose === 'string' ? o.purpose : ''
    out.push({
      orderId: d.id,
      kind: purpose === 'addon' ? 'addon' : cc && cc.operation !== 'activation' ? 'capacity_change' : 'activation',
      paidAt: toIso(o.paidAt),
      capacity: typeof cc?.capacity === 'number' ? cc.capacity : null,
      previousCapacity: typeof cc?.previousCapacity === 'number' ? cc.previousCapacity : null,
      services: items.filter(i => i && typeof i.quantity === 'number' && i.quantity > 0).map(i => ({ service: i.service, quantity: i.quantity })),
      totalPaise: typeof o.razorpayAmountPaise === 'number' ? o.razorpayAmountPaise : typeof o.amountPaise === 'number' ? o.amountPaise : 0,
      _t: Date.parse(toIso(o.paidAt) ?? '') || 0,
    })
  }
  return out.sort((a, b) => b._t - a._t).slice(0, MAX_ENTRIES).map(({ _t: _drop, ...e }) => { void _drop; return e })
}
