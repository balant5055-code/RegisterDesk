// Client-safe fee terms (RD-CONF-06 / GA-3 S4B). No SDK imports — importable from
// client and server. The PUBLIC, non-secret subset of the `fees` config that client
// previews (e.g. the event wizard) need so they never hardcode a rate. The
// AUTHORITATIVE per-transaction charge is always computed server-side via
// resolveFeeConfig — this shape is for display estimates only.

import { BUSINESS_CONFIG_DEFAULTS, type FeeCollectionMethod } from '@/lib/config/businessConfig'

export interface PublicFeesConfig {
  platformFeePercent:     number   // effective representative % (starter registration)
  gatewayFeeEnabled:      boolean
  gatewayFeePercent:      number
  gstEnabled:             boolean
  gstPercent:             number
  gstInclusive:           boolean
  feeCollectionMethod:    FeeCollectionMethod
  platformFeeDisplayName: string
  gstDescription:         string
}

// Representative starter platform rate used when no global override is set — mirrors
// the starter registration row of lib/fees/config.ts (2%). The authoritative charge
// is always computed server-side per license tier.
const REPRESENTATIVE_PLATFORM_PERCENT = 2

/** Code-default snapshot for hooks used before the live config resolves. */
export function defaultPublicFeesConfig(): PublicFeesConfig {
  const f = BUSINESS_CONFIG_DEFAULTS.fees
  return {
    platformFeePercent:     f.platformFeePercent ?? REPRESENTATIVE_PLATFORM_PERCENT,
    gatewayFeeEnabled:      f.gatewayFeeEnabled,
    gatewayFeePercent:      f.gatewayFeePercent,
    gstEnabled:             f.gstEnabled,
    gstPercent:             f.gstPercent,
    gstInclusive:           f.gstInclusive,
    feeCollectionMethod:    f.feeCollectionMethod,
    platformFeeDisplayName: f.platformFeeDisplayName,
    gstDescription:         f.gstDescription,
  }
}
