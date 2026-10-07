// RD-EVENT-COMMERCE-02 · What a DRAFT has paid for, and what it still owes. Server-only, READ-ONLY.
// (Split from draftCommerce.ts so read paths — the status/quote endpoints, publish — never load
// the Razorpay client.) See draftCommerce.ts for the add-on order lifecycle.

import { adminDb }  from '@/lib/firebase/admin'
import {
  LICENSE_ORDERS_COLLECTION, licenseOrderConverter, capacityChargeSnapshot,
  type LicenseOrderDoc, type CapacityChargeSnapshot,
} from './schema'
import { calculateCapacityIncreaseQuote } from './capacityPricing'
import { normalizeCommercialTerms, DEFAULT_COMMERCIAL_TERMS } from './capacityCommercial'
import {
  SERVICE_KINDS, sumServiceItems, priceServiceItem, serviceShortfall,
  type ServiceChargeItem, type ServiceSelection, type ServiceAllowancesConfig, type ServicePurchased,
} from './serviceAllowances'
import { ledgerRef, viewOf, type ServiceLedgerDoc } from './serviceAllowanceLedger'

export interface DraftCoverage {
  /** The activation order, whatever its state (null when none was ever created). */
  activation:     LicenseOrderDoc | null
  activationPaid: boolean
  /** Highest capacity a PAID order covers; null when no paid capacity order exists. */
  paidCapacity:   number | null
  purchased:      ServicePurchased
  consumed:       ServicePurchased
  remaining:      ServicePurchased
  /** The single payable add-on order, when one is outstanding. */
  pendingAddon:   LicenseOrderDoc | null
}

/** Reads coverage for a draft. The caller must already have established ownership. */
export async function readDraftCoverage(draftId: string, organizerUid: string): Promise<DraftCoverage> {
  const orders = adminDb.collection(LICENSE_ORDERS_COLLECTION).withConverter(licenseOrderConverter)
  const [licSnap, addonSnap, ledgerSnap] = await Promise.all([
    orders.doc(`lic_${draftId}`).get(),
    // Two equality filters — served by single-field indexes (no composite index required).
    orders.where('eventId', '==', draftId).where('purpose', '==', 'addon').get(),
    ledgerRef(draftId).get(),
  ])
  // RD-HIGH-2 — the draft id is a GLOBAL, client-choosable key: only records owned by THIS
  // organizer (server-derived uid) count. Another organizer's order or ledger under the same id,
  // or a record with no owner, is invisible here — it can never cover anything for the caller.
  const mine = (owner: unknown) => typeof owner === 'string' && owner !== '' && owner === organizerUid
  const activationDoc = licSnap.exists ? licSnap.data() ?? null : null
  const activation = activationDoc && mine(activationDoc.organizerUid) ? activationDoc : null
  const activationPaid = activation?.status === 'paid'
  const ledgerDoc = ledgerSnap.exists ? ledgerSnap.data() as ServiceLedgerDoc : undefined
  const ledger = ledgerDoc && mine(ledgerDoc.organizerUid) ? ledgerDoc : undefined

  let paidCapacity = activationPaid && activation?.capacityChange ? activation.capacityChange.capacity : null
  let pendingAddon: LicenseOrderDoc | null = null
  for (const d of addonSnap.docs) {
    const o = d.data()
    if (!mine(o.organizerUid)) continue
    if (o.status === 'paid' && o.capacityChange) paidCapacity = Math.max(paidCapacity ?? 0, o.capacityChange.capacity)
    if (o.status === 'created' && ledger?.pendingAddonOrderId === o.orderId) pendingAddon = o
  }
  const view = viewOf(ledger)
  return { activation, activationPaid, paidCapacity, ...view, pendingAddon }
}

// ─── Add-on pricing ───────────────────────────────────────────────────────────

export type AddonQuote =
  | { ok: true; capacityCharge: CapacityChargeSnapshot | null; serviceItems: ServiceChargeItem[]; totalPaise: number }
  | { ok: false; message: string }

/**
 * Prices what a draft still owes for `capacity` + `services` given its paid coverage.
 * `totalPaise === 0` ⇒ fully covered. Never prices a decrease (no refunds, no fee pre-publish:
 * a lower capacity is simply covered by the higher one already paid).
 */
export function quoteAddon(args: {
  coverage: Pick<DraftCoverage, 'activation' | 'paidCapacity' | 'purchased'>
  capacity: number
  services: ServiceSelection
  catalog:  ServiceAllowancesConfig
}): AddonQuote {
  const { coverage, capacity, services, catalog } = args
  let capacityCharge: CapacityChargeSnapshot | null = null
  const paid = coverage.paidCapacity
  if (paid !== null && capacity > paid) {
    // The activation's frozen terms — a later global rate change must not reprice this draft.
    const terms = normalizeCommercialTerms(coverage.activation?.capacityChange?.terms, DEFAULT_COMMERCIAL_TERMS)
    const q = calculateCapacityIncreaseQuote({ currentCapacity: paid, newCapacity: capacity, terms })
    if (!q.ok) return { ok: false, message: q.message }
    capacityCharge = capacityChargeSnapshot(q.quote)
  }
  const shortfall = serviceShortfall(services, coverage.purchased)
  const serviceItems: ServiceChargeItem[] = []
  for (const k of SERVICE_KINDS) {
    if (shortfall[k] > 0) serviceItems.push(priceServiceItem(k, shortfall[k], catalog[k]))
  }
  return { ok: true, capacityCharge, serviceItems, totalPaise: (capacityCharge?.totalPaise ?? 0) + sumServiceItems(serviceItems) }
}

