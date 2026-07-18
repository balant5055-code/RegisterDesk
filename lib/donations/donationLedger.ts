// Shared construction of a donation's platform-ledger entry + revenue credit. Server-only.
//
// SINGLE source used by BOTH completeDonation's happy path AND the post-commit recovery
// sweep (RD-PAY-GA-01B), so the two can never build a divergent ledger and can never
// double-settle. Mirrors lib/payments/registrationLedger.ts. Pure assembly over the same
// fee engine + fee config; the caller passes the result to the idempotent
// recordPlatformTransactionAndCredit (keyed on the deterministic ptx_<donationId>).

import { getFeePlanForOrganizer } from '@/lib/billing/feeEngine'
import { resolveFeeConfig }       from '@/lib/fees/resolveFeeConfig'
import { calculateFee }           from '@/lib/fees/engine'
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
  const feeResult = calculateFee({
    transactionType:  'donation',
    grossAmountPaise: src.amountPaise,
    feeModel:         'organizer_pays',
    config:           feeConfig,
  })
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
    platformFeeBasePaise:    feeResult.platformFeeBasePaise,
    platformFeeGstPaise:     feeResult.platformFeeGstPaise,
    platformFeeTotalPaise:   feeResult.platformFeeTotalPaise,
    gatewayFeeEstimatePaise: feeResult.gatewayFeeEstimatePaise,
    netSettlementPaise:      feeResult.netSettlementPaise,
    feeModel:                'organizer_pays',
    planTier:                feePlan.planTier,
    feeConfigId:             feePlan.feeConfigId,
    currency:                'INR',
    gateway:                 'razorpay',
    gatewayPaymentId:        src.paymentId,
    gatewayOrderId:          src.orderId,
  }
  const credit: RevenueCreditInput = {
    organizerUid:       src.organizerUid,
    grossAmountPaise:   src.amountPaise,
    feesTotalPaise:     feeResult.platformFeeTotalPaise + feeResult.gatewayFeeEstimatePaise,
    netSettlementPaise: feeResult.netSettlementPaise,
  }
  return { ledger, credit }
}
