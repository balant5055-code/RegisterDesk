// RD-PAYMENT-02 Phase 5 (CERT-D5) — the donation refund reversal records the ORIGINAL
// transaction's fee model, never a hardcoded 'organizer_pays'. refundService imports
// adminDb, so it is stubbed per the repo's per-file pattern.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import { reversalFeeModel } from '@/lib/donations/refundService'

describe('reversalFeeModel — canonical refund fee model (CERT-D5)', () => {
  it('legacy transaction (no stored feeModel) → organizer_pays, byte-identical to the old hardcode', () => {
    expect(reversalFeeModel(null)).toBe('organizer_pays')
    expect(reversalFeeModel(undefined)).toBe('organizer_pays')
  })

  it('preserves the parent transaction’s organizer_pays model', () => {
    expect(reversalFeeModel({ feeModel: 'organizer_pays' })).toBe('organizer_pays')
  })

  it('preserves the parent transaction’s customer_pays model (attendee-pays refund-aware)', () => {
    expect(reversalFeeModel({ feeModel: 'customer_pays' })).toBe('customer_pays')
  })
})
