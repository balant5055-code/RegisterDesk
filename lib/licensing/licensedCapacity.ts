// RD-EVENT-COMMERCE-04A · the registration capacity a LICENCE DOCUMENT records — for surfaces
// (dashboard alerts, fill %) that already hold the licence doc and must not add a read per
// event. PURE: the caller supplies the doc and the (config-resolved) tier catalogs.
//
// It replaced `getFreeEventCapacity()` (the retired Free tier's 200) as the capacity of every
// free event. The rule, in order:
//
//   capacity licence (commercialModel 'capacity') → the capacity it BOUGHT (`capacity`)
//   legacy tier licence                             → that tier's limit AT ITS STORED VERSION
//   anything else (no licence, unrecognised tier,
//   malformed capacity, unlimited)                  → null: no finite capacity is KNOWN
//
// null is never replaced with a guess (100, 200, …): a surface that has no capacity shows no
// fill percentage and raises no "nearly full" alert, rather than an invented one.
// `events/{slug}.totalCapacity` stays the ENFORCED value; the capacity flows keep the licence's
// `capacity` in step with it, and an admin limit override is the one documented divergence.

import { isValidTierForVersion, isUnlimited } from './eventLicense'
import { resolveLicenseEntryForVersion } from './licenseCatalogShared'
import type { LicenseCatalog, LicenseCatalogV2 } from './resolveCatalog'

export function capacityFromLicenceDoc(
  doc: Record<string, unknown> | null | undefined,
  catalog: LicenseCatalog,
  catalogV2: LicenseCatalogV2,
): number | null {
  if (!doc) return null
  if (doc.commercialModel === 'capacity') {
    const cap = doc.capacity
    return typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : null
  }
  const version = typeof doc.version === 'number' && doc.version >= 1 ? doc.version : 1
  if (!isValidTierForVersion(doc.tier, version)) return null
  const limit = resolveLicenseEntryForVersion(catalog, catalogV2, doc.tier as string, version as 1 | 2).registrationLimit
  return isUnlimited(limit) || !Number.isFinite(limit) ? null : limit
}
