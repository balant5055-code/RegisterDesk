// useFeesConfig — reads the shared BusinessConfigProvider (RD-CONF-06 / GA-3 S4B).
// Returns the PUBLIC, non-secret fee terms for display previews. Used outside the
// provider it falls back to the code defaults, so any caller keeps working.

import { useBusinessConfig } from '@/lib/config/BusinessConfigProvider'
import type { PublicFeesConfig } from '@/lib/fees/publicFeesShared'

export function useFeesConfig(): PublicFeesConfig {
  return useBusinessConfig().fees
}
