// RD-PRINT-BILL-P2 · The GLOBAL print-badge terms, read from Business Configuration. Server-only.
//
//   unit price + GST rate  ← licensing.serviceAllowances.print_badges, through the per-service
//                            catalog resolver (a corrupt stored value fails CLOSED: no price, no rate)
//   paid generation switch ← licensing.printBadgeBilling.paidGenerationEnabled
//
// A configuration that cannot be read yields `ok: false` — callers report it; nothing is charged.

import { businessConfig } from '@/lib/config/businessConfigService'
import { getServiceCatalog } from './serviceAllowanceConfig'
import type { ServiceSaleState } from './serviceAllowances'
import type { GlobalPrintBadgeTerms } from './printBadgeCommercial'

export type GlobalPrintBadgeTermsRead =
  | { ok: true; terms: GlobalPrintBadgeTerms; saleState: ServiceSaleState }
  | { ok: false; reason: 'unavailable' }

export async function getGlobalPrintBadgeTerms(): Promise<GlobalPrintBadgeTermsRead> {
  try {
    const [catalog, licensing] = await Promise.all([getServiceCatalog(), businessConfig.getSection('licensing')])
    if (catalog.state.print_badges === 'unavailable') return { ok: false, reason: 'unavailable' }
    const cfg = catalog.config.print_badges
    return {
      ok: true,
      terms: {
        paidGenerationEnabled: licensing.printBadgeBilling?.paidGenerationEnabled === true,
        unitPricePaise:        cfg.unitPricePaise,
        gstRatePercent:        cfg.gstRatePercent,
      },
      saleState: catalog.state.print_badges,
    }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
