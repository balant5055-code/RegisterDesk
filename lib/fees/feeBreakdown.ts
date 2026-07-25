// RD-PAYMENT-02 Phase 1 — canonical projection of the fee engine's result into the
// persisted FeeBreakdownRecord. PURE, no I/O, no SDK deps. This is the ONE place that
// maps calculateFee output → the persisted breakdown, so intent + transaction records
// are always shaped identically. Nothing consumes it yet (foundation only); Phase 2
// wires it into the ledger/intent writers.

import type { FeeBreakdownRecord, FeeCalculationResult, FeeModel } from './types'

// Schema version of FeeBreakdownRecord. Bump when the breakdown's shape/semantics change
// so persisted records can be interpreted against the version that produced them.
export const FINANCIAL_VERSION = 1

/**
 * Project a canonical FeeCalculationResult into the persisted FeeBreakdownRecord.
 * Lossless — every persisted field derives directly from the engine output. Under
 * organizer_pays this yields chargeAmountPaise === ticketBasePaise and
 * attendeeFeeTotalPaise === 0; under customer_pays the attendee-borne totals populate.
 */
export function toFeeBreakdownRecord(
  feeModel: FeeModel,
  r: FeeCalculationResult,
): FeeBreakdownRecord {
  return {
    financialVersion:        FINANCIAL_VERSION,
    feeModel,
    ticketBasePaise:         r.grossAmountPaise,
    chargeAmountPaise:       r.chargeAmountPaise,
    platformFeeBasePaise:    r.platformFeeBasePaise,
    platformFeeGstPaise:     r.platformFeeGstPaise,
    platformFeeTotalPaise:   r.platformFeeTotalPaise,
    gatewayFeeEstimatePaise: r.gatewayFeeEstimatePaise,
    attendeeFeeTotalPaise:   r.customerBearsPlatformFee + r.customerBearsGatewayFee,
    organizerFeeTotalPaise:  r.organizerBearsPlatformFee + r.organizerBearsGatewayFee,
    netSettlementPaise:      r.netSettlementPaise,
  }
}
