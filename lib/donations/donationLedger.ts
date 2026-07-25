// Shared construction of a donation's platform-ledger entry + revenue credit. Server-only.
//
// SINGLE source used by BOTH completeDonation's happy path AND the post-commit recovery
// sweep (RD-PAY-GA-01B), so the two can never build a divergent ledger and can never
// double-settle. Mirrors lib/payments/registrationLedger.ts. Pure assembly over the same
// fee engine + fee config; the caller passes the result to the idempotent
// recordPlatformTransactionAndCredit (keyed on the deterministic ptx_<donationId>).

import { getFeePlanForOrganizer } from '@/lib/billing/feeEngine'
import { resolveFeeConfig, resolveEffectiveFeeModel } from '@/lib/fees/resolveFeeConfig'
import { calculateFee }           from '@/lib/fees/engine'
import { buildOrderPricingEvidence, resolveLedgerFinancials } from '@/lib/platform/pricing'
import type { PlatformTransactionData, RevenueCreditInput } from '@/lib/firebase/firestore/platformTransactions'

export interface DonationLedgerSource {
  donationId:   string
  organizerUid: string
  campaignSlug: string
  donorName:    string
  donorEmail:   string
  isAnonymous:  boolean
  amountPaise:  number
  paymentId:    string   // Razorpay payment id
  orderId:      string   // Razorpay order id
}

export interface DonationLedgerBundle {
  ledger: PlatformTransactionData
  credit: RevenueCreditInput
}

/** Builds the exact `{ ledger, credit }` a successful donation must post to the platform
 *  ledger — identical whether called at verify time or during recovery. */
export async function buildDonationLedgerAndCredit(src: DonationLedgerSource): Promise<DonationLedgerBundle> {
  const feePlan   = await getFeePlanForOrganizer(src.organizerUid)
  const feeConfig = await resolveFeeConfig('donation', feePlan.planTier)
  // RD-PAYMENT-02 Phase 2: resolve the fee model canonically instead of hardcoding it.
  // Donations carry no fee-model candidate, so this resolves to organizer_pays — the
  // calculation and persisted ledger are byte-identical to before.
  const feeModel  = resolveEffectiveFeeModel({
    organizerUid: src.organizerUid,
    eventId:      src.campaignSlug,
  })
  const feeResult = calculateFee({
    transactionType:  'donation',
    grossAmountPaise: src.amountPaise,
    feeModel,
    config:           feeConfig,
  })
  // RD-PRICING-02B/02C: attach the pricing snapshot + shadow comparison, then resolve
  // the authoritative financials snapshot-first (lib/fees is the automatic fallback).
  // Additive + never-throws; the chosen values are provably equal to `feeResult` under
  // the current commercial model (snapshot used only when its shadow matched production).
  const evidence = await buildOrderPricingEvidence({
    grossAmountPaise: src.amountPaise,
    planTier:         feePlan.planTier,
    feeConfig,
    transactionType:  'donation',
  })
  const fin = resolveLedgerFinancials(feeResult, evidence)
  const ledger: PlatformTransactionData = {
    id:                      `ptx_${src.donationId}`,
    type:                    'donation',
    category:                'donation',
    organizerUid:            src.organizerUid,
    entityId:                src.campaignSlug,
    entityType:              'campaign',
    sourceId:                src.donationId,
    sourceType:              'donation',
    payerName:               src.isAnonymous ? 'Anonymous' : src.donorName,
    payerEmail:              src.donorEmail,
    grossAmountPaise:        src.amountPaise,
    platformFeeBasePaise:    fin.platformFeeBasePaise,
    platformFeeGstPaise:     fin.platformFeeGstPaise,
    platformFeeTotalPaise:   fin.platformFeeTotalPaise,
    gatewayFeeEstimatePaise: fin.gatewayFeeEstimatePaise,
    netSettlementPaise:      fin.netSettlementPaise,
    feeModel,
    planTier:                feePlan.planTier,
    feeConfigId:             feePlan.feeConfigId,
    currency:                'INR',
    gateway:                 'razorpay',
    gatewayPaymentId:        src.paymentId,
    gatewayOrderId:          src.orderId,
    pricingSource:           fin.source,
    ...evidence,
  }
  const credit: RevenueCreditInput = {
    organizerUid:       src.organizerUid,
    grossAmountPaise:   src.amountPaise,
    feesTotalPaise:     fin.platformFeeTotalPaise + fin.gatewayFeeEstimatePaise,
    netSettlementPaise: fin.netSettlementPaise,
  }
  return { ledger, credit }
}
