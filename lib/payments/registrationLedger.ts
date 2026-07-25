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
import { resolveFeeConfig, resolveEffectiveFeeModel } from '@/lib/fees/resolveFeeConfig'
import { calculateFee }           from '@/lib/fees/engine'
import { buildOrderPricingEvidence, resolveLedgerFinancials } from '@/lib/platform/pricing'
import type { FeeModel, FeeBreakdownRecord } from '@/lib/fees/types'
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
  // RD-PAYMENT-02 Phase 2 — the event's resolved ENGINE fee model, fed to the canonical
  // resolver as the Event-level candidate (legacy path only). OPTIONAL.
  feeModel?:        FeeModel
  // RD-PAYMENT-02 Phase 7 — the canonical breakdown persisted on the PaymentIntent at
  // checkout. When present, the ledger COPIES it directly (no recomputation). Absent for
  // legacy payments and whenever pricingEngineEnabled is off → legacy path (byte-identical).
  financials?:      FeeBreakdownRecord
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

  // ── RD-PAYMENT-02 Phase 7: canonical path — COPY the persisted breakdown directly ──
  // No recomputation, no second mapper. The ledger's gross is the ticket base (NOT the
  // attendee charge), fees + net come straight from what checkout charged, and the whole
  // FeeBreakdownRecord is preserved for the finance reader. Dormant until Phase 4 persists
  // financials (pricingEngineEnabled on); every current/legacy payment takes the path below.
  if (src.financials) {
    const f = src.financials
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
      grossAmountPaise:        f.ticketBasePaise,
      platformFeeBasePaise:    f.platformFeeBasePaise,
      platformFeeGstPaise:     f.platformFeeGstPaise,
      platformFeeTotalPaise:   f.platformFeeTotalPaise,
      gatewayFeeEstimatePaise: f.gatewayFeeEstimatePaise,
      netSettlementPaise:      f.netSettlementPaise,
      feeModel:                f.feeModel,
      planTier:                feePlan.planTier,
      feeConfigId:             feePlan.feeConfigId,
      currency:                'INR',
      gateway:                 'razorpay',
      gatewayPaymentId:        src.paymentId,
      gatewayOrderId:          src.orderId,
      financials:              f,
    }
    const credit: RevenueCreditInput = {
      organizerUid:       src.organizerUid,
      grossAmountPaise:   f.ticketBasePaise,
      // RD-PAYMENT-05 B2: the organizer wallet tracks the ORGANIZER's economics, so
      // lifetimeFees must be the fees the ORGANIZER bore (organizerFeeTotalPaise), not the
      // total platform+gateway fee. Under organizer_pays the organizer bears all fees, so
      // this equals platformFeeTotal + gatewayEstimate exactly (byte-identical to before).
      // Under customer_pays (attendee_pays) the organizer bore 0, so the wallet identity
      // lifetimeNet = lifetimeGross − lifetimeFees holds instead of double-counting
      // attendee-borne fees the organizer never paid.
      feesTotalPaise:     f.organizerFeeTotalPaise,
      netSettlementPaise: f.netSettlementPaise,
    }
    return { ledger, credit }
  }

  // ── Legacy path (Phase 2) — byte-identical to today ──
  const feeConfig = await resolveFeeConfig('event_registration', feePlan.planTier)
  // RD-PAYMENT-02 Phase 2: resolve the fee model canonically instead of hardcoding it.
  // With no candidate populated (today's universal case) this returns organizer_pays, so
  // the calculation, the persisted ledger, and settlement are byte-identical to before.
  const feeModel  = resolveEffectiveFeeModel({
    organizerUid:  src.organizerUid,
    eventId:       src.eventSlug,
    eventFeeModel: src.feeModel ?? null,
  })
  const feeResult = calculateFee({
    transactionType:  'event_registration',
    grossAmountPaise: src.grossAmountPaise,
    feeModel,
    config:           feeConfig,
  })
  // RD-PRICING-02B/02C: attach the pricing snapshot + shadow comparison, then resolve
  // the authoritative financials snapshot-first (lib/fees is the automatic fallback).
  // Additive + never-throws; the chosen values are provably equal to `feeResult` under
  // the current commercial model (snapshot used only when its shadow matched production).
  const evidence = await buildOrderPricingEvidence({
    grossAmountPaise: src.grossAmountPaise,
    planTier:         feePlan.planTier,
    feeConfig,
    transactionType:  'event_registration',
  })
  const fin = resolveLedgerFinancials(feeResult, evidence)
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
    grossAmountPaise:   src.grossAmountPaise,
    feesTotalPaise:     fin.platformFeeTotalPaise + fin.gatewayFeeEstimatePaise,
    netSettlementPaise: fin.netSettlementPaise,
  }
  return { ledger, credit }
}
