// useBranding — reads the shared BusinessConfigProvider (RD-CONF-10). The client
// counterpart to the server getBrandingConfig resolver; no direct fetch (the
// provider already loads /api/config/public once). Used outside the provider it
// returns the code defaults, so any caller keeps working unchanged.

import { useBusinessConfig } from '@/lib/config/BusinessConfigProvider'
import type { BrandingConfig } from '@/lib/config/businessConfig'

export function useBranding(): BrandingConfig {
  return useBusinessConfig().branding
}
