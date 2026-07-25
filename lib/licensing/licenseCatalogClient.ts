// useLicenseCatalog — reads the shared BusinessConfigProvider (RD-CONF-09.2). Same
// signature and return value as before; no direct fetch. The pure catalog helpers
// (defaultLicenseCatalog / reviveCatalog) live in ./licenseCatalogShared and are
// imported directly by the provider — this hook only needs the type.

import { useBusinessConfig } from '@/lib/config/BusinessConfigProvider'
import {
  buildLicenseCatalogView, buildCurrentLicenseCatalogView, resolveLicenseEntryForVersion,
  type LicenseCatalog, type LicenseCatalogV2, type LicenseCatalogEntryView, type LicenseDisplayEntry,
} from './licenseCatalogShared'
import { CURRENT_LICENSE_VERSION, type LicenseVersion } from './eventLicense'

export function useLicenseCatalog(): LicenseCatalog {
  return useBusinessConfig().licenseCatalog
}

// ─── RD-LICENSE-01B Phase 3A — V2 hooks (additive; no existing consumer changes) ────

/** The effective V2 catalog (config-overlaid) from the shared provider. */
export function useLicenseCatalogV2(): LicenseCatalogV2 {
  return useBusinessConfig().licenseCatalogV2
}

/** The ordered, display-ready V2 catalog view (version, limit, regular/offer, purchasable…). */
export function useLicenseCatalogView(): LicenseCatalogEntryView[] {
  return buildLicenseCatalogView(useBusinessConfig().licenseCatalogV2)
}

/**
 * The CURRENT-version catalog view — for WRITE-COUPLED surfaces (event-builder license
 * selector, admin dialogs). Renders the tiers the write layer currently validates against:
 * V1 today, V2 after the cutover. This is what a purchase/grant selector must use so the
 * chosen tier is always valid for CURRENT_LICENSE_VERSION.
 */
export function useCurrentLicenseCatalogView(): LicenseCatalogEntryView[] {
  const { licenseCatalog, licenseCatalogV2 } = useBusinessConfig()
  return buildCurrentLicenseCatalogView(licenseCatalog, licenseCatalogV2, CURRENT_LICENSE_VERSION)
}

/**
 * A resolver that renders an OWNED license's display fields by its stored `version`
 * (Phase 3C). Bound to both the V1 and V2 catalogs from the shared provider, so a screen
 * can resolve any license row — V1 today, V2 after cutover — without crashing on a tier
 * absent from the other version's catalog.
 */
export function useLicenseEntryResolver(): (tier: string, version: LicenseVersion) => LicenseDisplayEntry {
  const { licenseCatalog, licenseCatalogV2 } = useBusinessConfig()
  return (tier, version) => resolveLicenseEntryForVersion(licenseCatalog, licenseCatalogV2, tier, version)
}
