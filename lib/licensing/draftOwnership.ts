// RD-HIGH-2 — every paid entitlement keyed by a DRAFT ID belongs to exactly one organizer.
//
// The activation order (`licenseOrders/lic_{draftId}`), pre-publish add-on orders (`eventId ==
// draftId`), the prepaid-services ledger (`eventServiceAllowances/{draftId}`) and a live event's
// `draftId` are GLOBAL keys. A draft id is client-chosen (the rules let an organizer create
// `users/{uid}/eventDrafts/{anyId}`) and every live event's draft id is visible on its public
// staff-login page, so the id alone proves nothing. Before a draft id is used to buy, confirm,
// publish or read coverage, every record under it must carry the AUTHENTICATED organizer as its
// owner. A record with a missing owner fails CLOSED — never assumed, never reassigned.
//
// The organizer is always the server-derived workspace uid (verifyCaller / authorizeWorkspace),
// never a value from the request.

import { adminDb } from '@/lib/firebase/admin'
import { LICENSE_ORDERS_COLLECTION } from './schema'
import { ledgerRef } from './serviceAllowanceLedger'

export type OwnershipVerdict = 'own' | 'foreign' | 'unknown'

/** Whose record is this? A missing / non-string owner is 'unknown' (fails closed). */
export function ownerVerdict(owner: unknown, uid: string): OwnershipVerdict {
  if (typeof owner !== 'string' || owner === '') return 'unknown'
  return owner === uid ? 'own' : 'foreign'
}

export type DraftCommerceOwnership =
  | { ok: true }
  | { ok: false; verdict: 'foreign' | 'unknown'; record: string }

/** PURE — the first record not owned by `uid` decides. No records ⇒ nothing to protect ⇒ ok. */
export function judgeDraftCommerceOwnership(
  records: ReadonlyArray<{ record: string; owner: unknown }>,
  uid: string,
): DraftCommerceOwnership {
  for (const r of records) {
    const v = ownerVerdict(r.owner, uid)
    if (v !== 'own') return { ok: false, verdict: v, record: r.record }
  }
  return { ok: true }
}

/** Non-disclosing: never says whose record it is or that it exists elsewhere. */
export const DRAFT_COMMERCE_FORBIDDEN_MESSAGE =
  'This event’s payment records could not be validated for your account, so nothing was changed. Please create a new event.'

/**
 * Reads every global commerce record keyed by `draftId` — activation order, all orders for the
 * draft (add-ons), the services ledger and any live event bound to it — and checks each one's
 * owner against `uid`.
 */
export async function checkDraftCommerceOwnership(draftId: string, uid: string): Promise<DraftCommerceOwnership> {
  const orders = adminDb.collection(LICENSE_ORDERS_COLLECTION)
  const [lic, ledger, draftOrders, events] = await Promise.all([
    orders.doc(`lic_${draftId}`).get(),
    ledgerRef(draftId).get(),
    orders.where('eventId', '==', draftId).limit(50).get(),
    adminDb.collection('events').where('draftId', '==', draftId).limit(10).get(),
  ])
  const records: Array<{ record: string; owner: unknown }> = []
  if (lic.exists)    records.push({ record: 'activation order', owner: lic.get('organizerUid') })
  if (ledger.exists) records.push({ record: 'service allowance', owner: ledger.get('organizerUid') })
  for (const d of draftOrders.docs) records.push({ record: 'order', owner: d.get('organizerUid') })
  for (const d of events.docs)      records.push({ record: 'event', owner: d.get('uid') })
  return judgeDraftCommerceOwnership(records, uid)
}
