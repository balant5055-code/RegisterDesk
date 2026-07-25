// RD-PAYMENT-05 B1 — the ONE place that turns a canonical FeeBreakdownRecord into the
// attendee-facing fee line items. PURE, client-safe (no SDK, no I/O). Every attendee
// surface (checkout confirmation, success page, receipt) renders from this so the
// breakdown is identical everywhere and never recomputed — the numbers are the exact
// paise the engine produced at checkout.

import type { FeeBreakdownRecord } from './types'

export interface FeeLine {
  label: string
  paise: number
}

export interface AttendeeFeeBreakdown {
  lines:      FeeLine[]
  totalPaise: number   // === FeeBreakdownRecord.chargeAmountPaise === the Razorpay order amount
}

// The subset of the canonical record needed to itemize the attendee charge.
export type AttendeeFinancials = Pick<FeeBreakdownRecord,
  | 'ticketBasePaise'
  | 'platformFeeBasePaise'
  | 'platformFeeGstPaise'
  | 'gatewayFeeEstimatePaise'
  | 'chargeAmountPaise'
  | 'attendeeFeeTotalPaise'>

/**
 * Build the attendee fee breakdown from a canonical record, or return null when the
 * attendee bore no fees (organizer_absorbs / free) — nothing to itemize, existing
 * ticket-only display is correct. Lines come straight from the stored paise; the total is
 * chargeAmountPaise, which equals the create-order / Razorpay / ledger amount by construction.
 */
export function buildAttendeeFeeBreakdown(f: AttendeeFinancials | null | undefined): AttendeeFeeBreakdown | null {
  if (!f || f.attendeeFeeTotalPaise <= 0) return null
  const lines: FeeLine[] = [
    { label: 'Ticket price', paise: f.ticketBasePaise },
    { label: 'Platform fee', paise: f.platformFeeBasePaise },
  ]
  if (f.platformFeeGstPaise > 0)     lines.push({ label: 'GST',                 paise: f.platformFeeGstPaise })
  if (f.gatewayFeeEstimatePaise > 0) lines.push({ label: 'Payment gateway fee', paise: f.gatewayFeeEstimatePaise })
  return { lines, totalPaise: f.chargeAmountPaise }
}

// Shared paise → ₹ formatter for breakdown rows (2 decimals only when needed).
export function formatPaise(paise: number): string {
  const rupees = paise / 100
  const hasPaise = paise % 100 !== 0
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  })}`
}
