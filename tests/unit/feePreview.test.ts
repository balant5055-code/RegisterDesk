// RD-PAYMENT-02 Phase 3 — the Event Builder fee preview now runs through the ONE canonical
// engine path (computeFeePreview → calculateFee), replacing the old divergent page-local
// calcFees. Pure; no Firebase.

import { describe, it, expect } from 'vitest'
import { computeFeePreview } from '@/lib/events/builder/feePreview'
import { calculateFee } from '@/lib/fees/engine'

const RATES = { platformPercent: 2, gatewayPercent: 2, gstPercent: 18 }
const ENGINE_CONFIG = {
  platformFeePercentBps: 200, platformFeeFixedPaise: 0, platformFeeMinPaise: 0,
  platformFeeMaxPaise: 0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18,
}

describe('computeFeePreview — canonical Event Builder fee preview', () => {
  it('organizer_absorbs: attendee pays only the ticket; organizer receives ticket − fees', () => {
    const b = computeFeePreview(500, 'organizer_absorbs', RATES)
    expect(b.ticketPrice).toBe(500)
    expect(b.attendeePays).toBe(500)      // organizer_pays → attendee charged the ticket only
    expect(b.platformFee).toBe(10)        // 2% of 500
    expect(b.gatewayFee).toBe(10)         // 2% of 500
    expect(b.gstOnFees).toBe(1.8)         // 18% of the PLATFORM fee only
    expect(b.totalFees).toBe(21.8)        // 10 (platform) + 1.8 (gst) + 10 (gateway)
    expect(b.organizerGets).toBe(478.2)   // 500 − 21.8
  })

  it('GST is platform-only (matches the engine), NOT the old platform+gateway base', () => {
    const b = computeFeePreview(500, 'organizer_absorbs', RATES)
    // The old divergent calcFees taxed platform+gateway: (10+10)*18% = 3.6.
    expect(b.gstOnFees).not.toBe(3.6)
    expect(b.gstOnFees).toBe(1.8)
  })

  it('is a faithful projection of calculateFee(organizer_pays)', () => {
    const r = calculateFee({ transactionType: 'event_registration', grossAmountPaise: 50000, feeModel: 'organizer_pays', config: ENGINE_CONFIG })
    const b = computeFeePreview(500, 'organizer_absorbs', RATES)
    expect(b.platformFee).toBe(r.platformFeeBasePaise / 100)
    expect(b.gstOnFees).toBe(r.platformFeeGstPaise / 100)
    expect(b.organizerGets).toBe(r.netSettlementPaise / 100)
    expect(b.attendeePays).toBe(r.chargeAmountPaise / 100)
  })

  it('honors the canonical mapping: attendee_pays → customer_pays (charge = ticket + fees)', () => {
    // Proves the mapping/resolution works end-to-end even though the UI keeps attendee_pays
    // non-selectable ("Coming Soon"). Not an active production path.
    const b = computeFeePreview(500, 'attendee_pays', RATES)
    expect(b.attendeePays).toBe(521.8)    // 500 + platformTotal(11.8) + gateway(10)
    expect(b.organizerGets).toBe(500)     // organizer receives the full ticket
  })
})
