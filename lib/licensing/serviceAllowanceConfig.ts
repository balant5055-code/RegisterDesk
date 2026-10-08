// RD-EVENT-COMMERCE-02 · the prepaid service catalog, resolved from Business Configuration.
// Server-only. Kept apart from the ledger so the consumption paths (WhatsApp, certificates),
// which never need prices, do not load the configuration service.
//
// RD-EVENT-COMMERCE-04A — resolved PER SERVICE from the raw stored group, so one corrupt service
// cannot disturb its siblings.
// RD-EVENT-COMMERCE-05  — each service also carries WHY it is or is not for sale.
// RD-EVENT-COMMERCE-05A — an ABSENT service / field takes the APPROVED default (₹0.20 WhatsApp,
// ₹1.50 certificate, ₹1.60 photo — RD-PRICE-01; 18% GST, on sale); a STORED value always wins (never
// overwritten). But a stored configuration that is UNUSABLE — or a config that cannot be READ —
// resolves to NOT_FOR_SALE, never to the defaults: a broken setting fails closed. Read-only.

import { businessConfig } from '@/lib/config/businessConfigService'
import {
  DEFAULT_SERVICE_ALLOWANCES, SERVICE_KINDS, NOT_FOR_SALE, normalizeServiceAllowances, validateServiceAllowances,
  serviceSaleState,
  type ServiceAllowancesConfig, type ServiceKind, type ServiceSaleState,
} from './serviceAllowances'

export interface ServiceCatalogResolution {
  config: ServiceAllowancesConfig
  state:  Record<ServiceKind, ServiceSaleState>
}

const allOf = <T,>(v: T) => Object.fromEntries(SERVICE_KINDS.map(k => [k, v])) as Record<ServiceKind, T>
const notForSale = (state: ServiceSaleState): ServiceCatalogResolution => ({
  config: Object.fromEntries(SERVICE_KINDS.map(k => [k, { ...NOT_FOR_SALE }])) as ServiceAllowancesConfig,
  state:  allOf(state),
})

/** Pure: the raw stored group → catalog + per-service sale state, one service at a time. */
export function resolveServiceCatalogFromStored(rawGroup: unknown): ServiceCatalogResolution {
  if (rawGroup !== undefined && (typeof rawGroup !== 'object' || rawGroup === null || Array.isArray(rawGroup))) {
    return notForSale('invalid')                          // the whole group is unusable
  }
  const raw = (rawGroup ?? {}) as Record<string, unknown>
  const config = normalizeServiceAllowances(undefined)   // approved defaults for everything absent
  const state  = allOf<ServiceSaleState>('not_configured')
  for (const kind of SERVICE_KINDS) {
    // Judge THIS service alone (its stored fields over its defaults); siblings are unaffected.
    const stored = raw[kind]
    // A stored service that is not an object ('on', 5, [...], null) is corrupt. It must NOT be
    // spread over the defaults (a string would spread its characters and inherit a valid,
    // sellable default) — it is invalid, full stop.
    const malformed = stored !== undefined && (typeof stored !== 'object' || stored === null || Array.isArray(stored))
    const candidate = normalizeServiceAllowances({ ...DEFAULT_SERVICE_ALLOWANCES, [kind]: stored })
    if (!malformed && (stored === undefined || validateServiceAllowances(candidate).length === 0)) {
      config[kind] = candidate[kind]
      state[kind]  = serviceSaleState(candidate[kind])
    } else {
      config[kind] = { ...NOT_FOR_SALE }                  // stored, but unusable — never sold
      state[kind]  = 'invalid'
    }
  }
  return { config, state }
}

/** Pure: the raw stored group → catalog (per-service). Exported for tests / existing callers. */
export function resolveServiceAllowancesFromStored(rawGroup: unknown): ServiceAllowancesConfig {
  return resolveServiceCatalogFromStored(rawGroup).config
}

/** Business Configuration → catalog + per-service sale state. A read failure sells NOTHING. */
export async function getServiceCatalog(): Promise<ServiceCatalogResolution> {
  try {
    const { stored, loadFailed } = await businessConfig.getStoredLayer()
    if (loadFailed) return notForSale('unavailable')
    return resolveServiceCatalogFromStored((stored.licensing as Record<string, unknown> | undefined)?.serviceAllowances)
  } catch {
    return notForSale('unavailable')
  }
}

/** Business Configuration → normalized catalog. */
export async function getServiceAllowancesConfig(): Promise<ServiceAllowancesConfig> {
  return (await getServiceCatalog()).config
}
