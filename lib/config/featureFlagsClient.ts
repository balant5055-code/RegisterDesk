// useFeatureFlags — reads the shared BusinessConfigProvider (RD-CONF-09.2). Same
// signature/return as before; no direct fetch.

import { useBusinessConfig } from '@/lib/config/BusinessConfigProvider'
import type { FeatureFlagsConfig } from '@/lib/config/businessConfig'

export function useFeatureFlags(): FeatureFlagsConfig {
  return useBusinessConfig().featureFlags
}
