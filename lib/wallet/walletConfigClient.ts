// useWalletConfig — reads the shared BusinessConfigProvider (RD-CONF-09.2). Same
// signature/return as before; no direct fetch.

import { useBusinessConfig } from '@/lib/config/BusinessConfigProvider'
import type { WalletConfig } from '@/lib/config/businessConfig'

export function useWalletConfig(): WalletConfig {
  return useBusinessConfig().wallet
}
