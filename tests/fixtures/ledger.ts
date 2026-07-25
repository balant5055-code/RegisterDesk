// RD-GA-HARDEN-01 — platform-transaction ledger fixture derived from a PricingSummary,
// so the stored ledger fields and the attached snapshot are internally consistent.

import type { PricingSummary } from '@/lib/platform/pricing/types'
import { createOrderPricingSnapshot, serializeOrderPricingSnapshot } from '@/lib/platform/pricing/orderSnapshot'

export function ledgerFromSummary(summary: PricingSummary, opts?: { withSnapshot?: boolean }): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    grossAmountPaise:        summary.ticketPrice.paise,
    platformFeeBasePaise:    summary.platformFee.paise,
    platformFeeGstPaise:     summary.platformGst.paise,
    platformFeeTotalPaise:   summary.platformFeeTotal.paise,
    gatewayFeeEstimatePaise: summary.gatewayFee.paise,
    netSettlementPaise:      summary.organizerReceives.paise,
  }
  if (opts?.withSnapshot !== false) {
    doc.pricingSnapshot = serializeOrderPricingSnapshot(createOrderPricingSnapshot(summary))
  }
  return doc
}
