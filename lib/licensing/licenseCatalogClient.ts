// useLicenseCatalog — reads the shared BusinessConfigProvider (RD-CONF-09.2). Same
// signature and return value as before; no direct fetch. The pure catalog helpers
// (defaultLicenseCatalog / reviveCatalog) live in ./licenseCatalogShared and are
// imported directly by the provider — this hook only needs the type.

import { useBusinessConfig } from '@/lib/config/BusinessConfigProvider'
import type { LicenseCatalog } from './licenseCatalogShared'

export function useLicenseCatalog(): LicenseCatalog {
  return useBusinessConfig().licenseCatalog
}
