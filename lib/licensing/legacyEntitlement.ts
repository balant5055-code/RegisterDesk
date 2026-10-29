// RD-LEGACY-01 · the ONE historical tier entitlement, in one place. SERVER-ONLY.
//
// Licence tiers are retired: a new event is priced only by the capacity model. The single tier
// entitlement that survives is a HISTORICAL paid tier order — a server-written, PAID
// `lic_{draftId}` order that is NOT a capacity order and names a paid tier of the current version.
// Such orders can no longer be created (/api/licensing/purchase refuses any activation without a
// capacity, and checkout/confirm settles only an existing tier order), so this can only ever
// honour money paid before retirement. It reads the ORDER, never the draft's client-writable
// `licenseTier`, and never a catalog price.
//
// The publish route decides with `resolveLegacyTier`. The License & Services quote reports the
// same verdict (`readLegacyEntitlement`) so the wizard does not persist the free default over a
// draft whose capacity is still governed by its paid tier (RD-CAPACITY-DEFAULT).

import { adminDb } from '@/lib/firebase/admin'
import {
  CURRENT_LICENSE_VERSION, isValidTierForVersion, defaultLicenseTierForVersion,
  type AnyEventLicenseTier, type LicenseVersion,
} from '@/lib/licensing/eventLicense'
import { LICENSE_ORDERS_COLLECTION } from '@/lib/licensing/schema'
import { getLicenseCatalog, getLicenseCatalogV2 } from '@/lib/licensing/resolveCatalog'
import { pickVersionedDefinition } from '@/lib/licensing/licenseCatalogShared'
import { ownerVerdict } from '@/lib/licensing/draftOwnership'
import { capacityPlanForRegistrationLimit, resolveTotalCapacity } from '@/lib/registrations/capacity'

/** The fields of a `lic_{draftId}` order the verdict reads. */
export interface LegacyTierOrderFields {
  tier?: unknown
  status?: unknown
  commercialModel?: unknown
}

/** PURE — the paid historical tier this order entitles, or null. */
export function resolveLegacyTier(order: LegacyTierOrderFields | null | undefined, version: LicenseVersion): AnyEventLicenseTier | null {
  return !!order && order.status === 'paid' && order.commercialModel !== 'capacity'
    && isValidTierForVersion(order.tier, version) && order.tier !== defaultLicenseTierForVersion(version)
    ? order.tier : null
}

export interface LegacyEntitlement {
  tier:          AnyEventLicenseTier
  /** The capacity publish grants on the legacy path (null = unlimited) — same formula as the route. */
  totalCapacity: number | null
}

/**
 * The draft's verified legacy entitlement, or null. Verified = the paid historical tier order
 * above AND owned by `uid` (the publish route refuses a foreign order outright), so a forged or
 * stale `licenseTier` on the draft, or an unpaid / foreign / capacity order, is never one.
 */
export async function readLegacyEntitlement(draftId: string, uid: string): Promise<LegacyEntitlement | null> {
  const snap  = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${draftId}`).get()
  const order = snap.exists ? (snap.data() as LegacyTierOrderFields & { organizerUid?: unknown }) : null
  const tier  = resolveLegacyTier(order, CURRENT_LICENSE_VERSION)
  if (!tier || ownerVerdict(order?.organizerUid, uid) !== 'own') return null
  const [v1, v2] = await Promise.all([getLicenseCatalog(), getLicenseCatalogV2()])
  const max = pickVersionedDefinition(v1, v2, tier, CURRENT_LICENSE_VERSION).limits.maxRegistrations
  return { tier, totalCapacity: resolveTotalCapacity(capacityPlanForRegistrationLimit(max)) }
}
