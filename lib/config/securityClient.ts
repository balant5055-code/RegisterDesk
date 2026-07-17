// useSecurity — reads the shared BusinessConfigProvider (RD-CONF-11). The client
// counterpart to the server getSecurityConfig resolver; no direct fetch (the
// provider already loads /api/config/public once). Used outside the provider it
// returns the code defaults, so any caller keeps working unchanged.
//
// POLICY ONLY — carries no secrets (the public config endpoint never serves them).

import { useBusinessConfig } from '@/lib/config/BusinessConfigProvider'
import type { SecurityConfig } from '@/lib/config/businessConfig'

export function useSecurity(): SecurityConfig {
  return useBusinessConfig().security
}
