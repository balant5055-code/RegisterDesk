// RD-PRICING-CALC · Server-only. THE one place the PUBLIC pricing is assembled.
//
// Used by BOTH the /pricing page (server-rendered plan cards, facts and metadata, regenerated
// about once a minute) and GET /api/public/pricing (the calculator's fallback fetch), so every
// customer-facing figure on the page comes from one function over one configuration document.
//
// Sources — the same resolvers the charging paths use:
//   terms     resolveGlobalCommercialTerms()            businessConfig.licensing.commercial
//   services  getServiceCatalog()                       businessConfig.licensing.serviceAllowances
//   ticketFee getFeePlanForOrganizer → resolveFeeConfig  the fee a NEW ticket sale is charged
//                                                        (businessConfig.fees + licensing.commercial)
//
// FAILS CLOSED: an unreadable or invalid commercial configuration returns null — the page then
// shows "unavailable", never the code defaults. A service not on sale carries no price.

import { resolveGlobalCommercialTerms } from './resolveCommercialTerms'
import { getServiceCatalog } from './serviceAllowanceConfig'
import { SERVICE_KINDS, type ServiceKind } from './serviceAllowances'
import { getFeePlanForOrganizer } from '@/lib/billing/feeEngine'
import { resolveFeeConfig } from '@/lib/fees/resolveFeeConfig'
import type { PublicPricingConfig, PublicServicePricing, PublicTicketFee } from './publicPricing'

export async function getPublicPricing(): Promise<PublicPricingConfig | null> {
  try {
    const [commercial, catalog] = await Promise.all([resolveGlobalCommercialTerms(), getServiceCatalog()])
    if (!commercial.ok) return null

    const services = Object.fromEntries(SERVICE_KINDS.map(kind => {
      const state = catalog.state[kind]
      const c = catalog.config[kind]
      const entry: PublicServicePricing = state === 'available'
        ? { available: true, config: {
            enabled: c.enabled, unitPricePaise: c.unitPricePaise, gstRatePercent: c.gstRatePercent,
            minQuantity: c.minQuantity, maxQuantity: c.maxQuantity, presets: [...c.presets], onExhausted: c.onExhausted,
          } }
        : { available: false, state }
      return [kind, entry]
    })) as Record<ServiceKind, PublicServicePricing>

    // The ticket checkout's own path for a new sale (lib/fees/resolveEventFeeConfig): the fee plan,
    // then resolveFeeConfig for it. No per-event override applies to a not-yet-created event.
    const plan = await getFeePlanForOrganizer('')
    const fee  = await resolveFeeConfig('event_registration', plan.planTier)
    const ticketFee: PublicTicketFee = {
      percent:        fee.platformFeePercentBps / 100,
      fixedPaise:     fee.platformFeeFixedPaise,
      minPaise:       fee.platformFeeMinPaise,
      maxPaise:       fee.platformFeeMaxPaise,
      gstRatePercent: fee.gstRatePercent,
    }

    const t = commercial.terms
    return {
      // Explicit field copy: only the six commercial terms, never whatever else the group may hold.
      terms: {
        freeRegistrationCapacity:      t.freeRegistrationCapacity,
        activationRatePaise:           t.activationRatePaise,
        gstRatePercent:                t.gstRatePercent,
        attendeeTransactionFeePercent: t.attendeeTransactionFeePercent,
        capacityDecreaseFeePercent:    t.capacityDecreaseFeePercent,
        maximumEventCapacity:          t.maximumEventCapacity,
      },
      services,
      ticketFee,
    }
  } catch {
    return null
  }
}
