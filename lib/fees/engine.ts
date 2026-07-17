// Pure fee calculation engine. No I/O, no side effects, fully testable.
// All amounts are integer paise (no floats). All rates are basis points.

import type { FeeCalculationInput, FeeCalculationResult } from './types'

function zeroResult(grossAmountPaise: number): FeeCalculationResult {
  return {
    grossAmountPaise,
    platformFeeBasePaise:      0,
    platformFeeGstPaise:       0,
    platformFeeTotalPaise:     0,
    gatewayFeeEstimatePaise:   0,
    chargeAmountPaise:         grossAmountPaise,
    netSettlementPaise:        grossAmountPaise,
    customerBearsPlatformFee:  0,
    organizerBearsPlatformFee: 0,
    customerBearsGatewayFee:   0,
    organizerBearsGatewayFee:  0,
  }
}

export function calculateFee(input: FeeCalculationInput): FeeCalculationResult {
  const { grossAmountPaise, feeModel, config } = input

  if (feeModel === 'no_fee' || grossAmountPaise === 0) {
    return zeroResult(grossAmountPaise)
  }

  // Platform fee — percent component + fixed component, then clamp
  const rawFee = Math.round(grossAmountPaise * config.platformFeePercentBps / 10_000)
    + config.platformFeeFixedPaise

  const clampedBase = config.platformFeeMaxPaise > 0
    ? Math.min(config.platformFeeMaxPaise, Math.max(config.platformFeeMinPaise, rawFee))
    : Math.max(config.platformFeeMinPaise, rawFee)

  const platformFeeBase  = clampedBase
  const platformFeeGst   = Math.round(platformFeeBase * config.gstRatePercent / 100)
  const platformFeeTotal = platformFeeBase + platformFeeGst

  // Gateway fee estimate
  const gatewayFee = Math.round(grossAmountPaise * config.gatewayFeePercentBps / 10_000)
    + config.gatewayFeeFixedPaise

  switch (feeModel) {
    case 'customer_pays':
      return {
        grossAmountPaise,
        platformFeeBasePaise:      platformFeeBase,
        platformFeeGstPaise:       platformFeeGst,
        platformFeeTotalPaise:     platformFeeTotal,
        gatewayFeeEstimatePaise:   gatewayFee,
        // Customer pays gross + all fees on top → Razorpay order amount is higher
        chargeAmountPaise:         grossAmountPaise + platformFeeTotal + gatewayFee,
        netSettlementPaise:        grossAmountPaise,
        customerBearsPlatformFee:  platformFeeTotal,
        organizerBearsPlatformFee: 0,
        customerBearsGatewayFee:   gatewayFee,
        organizerBearsGatewayFee:  0,
      }

    case 'organizer_pays':
      return {
        grossAmountPaise,
        platformFeeBasePaise:      platformFeeBase,
        platformFeeGstPaise:       platformFeeGst,
        platformFeeTotalPaise:     platformFeeTotal,
        gatewayFeeEstimatePaise:   gatewayFee,
        // Customer pays gross → Razorpay order matches gross
        chargeAmountPaise:         grossAmountPaise,
        netSettlementPaise:        Math.max(0, grossAmountPaise - platformFeeTotal - gatewayFee),
        customerBearsPlatformFee:  0,
        organizerBearsPlatformFee: platformFeeTotal,
        customerBearsGatewayFee:   0,
        organizerBearsGatewayFee:  gatewayFee,
      }

    case 'hybrid': {
      const ratio             = Math.max(0, Math.min(1, input.hybridRatio ?? 0.5))
      const customerPlatform  = Math.round(platformFeeTotal * ratio)
      const organizerPlatform = platformFeeTotal - customerPlatform
      return {
        grossAmountPaise,
        platformFeeBasePaise:      platformFeeBase,
        platformFeeGstPaise:       platformFeeGst,
        platformFeeTotalPaise:     platformFeeTotal,
        gatewayFeeEstimatePaise:   gatewayFee,
        // Customer pays gross + their share of platform fee
        chargeAmountPaise:         grossAmountPaise + customerPlatform,
        netSettlementPaise:        Math.max(0, grossAmountPaise - organizerPlatform - gatewayFee),
        customerBearsPlatformFee:  customerPlatform,
        organizerBearsPlatformFee: organizerPlatform,
        customerBearsGatewayFee:   0,
        organizerBearsGatewayFee:  gatewayFee,
      }
    }

    default:
      return zeroResult(grossAmountPaise)
  }
}
