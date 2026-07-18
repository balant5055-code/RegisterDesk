// Shared construction of a registration's platform-ledger entry + revenue credit.
// Server-only.
//
// SINGLE source used by BOTH the verify-payment happy path AND the post-commit recovery
// sweep (RD-PAY-GA-01A), so the two can never build a divergent ledger and can never
// double-settle. Pure assembly over the existing fee engine + fee config — the same
// getFeePlanForOrganizer / resolveFeeConfig / calculateFee the verify path already runs.
// No writes here; the caller passes the result to the idempotent
// recordPlatformTransactionAndCredit (keyed on ptx_<registrationId>).

import { getFeePlanForOrganizer } from '@/lib/billing/feeEngine'
import { resolveFeeConfig }       from '@/lib/fees/resolveFeeConfig'
import { calculateFee }           from '@/lib/fees/engine'
import type { PlatformTransactionData, RevenueCreditInput } from '@/lib/firebase/firestore/platformTransactions'

export interface RegistrationLedgerSource {
  registrationId:   string
  organizerUid:     string
  eventSlug:        string
  attendeeName:     string
  attendeeEmail:    string
  grossAmountPaise: number   // paise — the authoritative server amount (intent.amount)
  paymentId:        string   // Razorpay payment id
  orderId:          string   // Razorpay order id
}

export interface RegistrationLedgerBundle {
  ledger: PlatformTransactionData
  credit: RevenueCreditInput
}

/**
 * Builds the exact `{ ledger, credit }` a paid event registration must post to the
 * platform ledger. Identical output for a given input, whether called at verify time or
 * during recovery — the ledger id is the deterministic `ptx_<registrationId>`.
 */
export async function buildRegistrationLedgerAndCredit(src: RegistrationLedgerSource): Promise<RegistrationLedgerBundle> {
  const feePlan   = await getFeePlanForOrganizer(src.organizerUid)
  const feeConfig = await resolveFeeConfig('event_registration', feePlan.planTier)
  const feeResult = calculateFee({
    transactionType:  'event_registration',
    grossAmountPaise: src.grossAmountPaise,
    feeModel:         'organizer_pays',
    config:           feeConfig,
  })
  const ledger: PlatformTransactionData = {
    id:                      `ptx_${src.registrationId}`,
    type:                    'event_registration',
    category:                'ticketed',
    organizerUid:            src.organizerUid,
    entityId:                src.eventSlug,
    entityType:              'event',
    sourceId:                src.registrationId,
    sourceType:              'registration',
    payerName:               src.attendeeName,
    payerEmail:              src.attendeeEmail,
    grossAmountPaise:        src.grossAmountPaise,
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
    grossAmountPaise:   src.grossAmountPaise,
    feesTotalPaise:     feeResult.platformFeeTotalPaise + feeResult.gatewayFeeEstimatePaise,
    netSettlementPaise: feeResult.netSettlementPaise,
  }
  return { ledger, credit }
}
