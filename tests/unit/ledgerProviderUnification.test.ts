// Phase A — the payment ledger says ONE true thing about which gateway took the money.
//
// ═══ THE CONTRADICTION THIS REMOVES ═════════════════════════════════════════
// `PlatformTransactionDocument` carried BOTH `provider` (added with the provider contract)
// and `gateway` (typed as the literal 'razorpay'). The writers set them independently, so a
// Cashfree registration produced one document asserting `provider: 'cashfree'` and
// `gateway: 'razorpay'` — a financial record disagreeing with itself about where the money
// went, and the row a future settlement flow would have to trust.
//
// Both now come from a single `readProvider(src.provider)`, which also means disagreement
// is not merely unlikely — there is no code path that can produce it.
//
// Historical rows are untouched: they say 'razorpay' and they were Razorpay. Nothing was
// migrated.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

// The builder pulls in the fee/pricing graph, all of which reaches Firestore. Every stub
// below is inert — these cases are about WHICH PROVIDER is recorded, not about pricing, and
// the arithmetic has its own suites.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('@/lib/billing/feeEngine', () => ({
  getFeePlanForOrganizer: async () => ({ planTier: 'starter', feeConfigId: 'fallback' }),
}))
vi.mock('@/lib/fees/resolveFeeConfig', () => ({
  resolveFeeConfig:        async () => ({}),
  resolveEffectiveFeeModel: () => 'organizer_pays',
}))
vi.mock('@/lib/fees/engine', () => ({
  calculateFee: () => ({
    platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
    gatewayFeeEstimatePaise: 0, netSettlementPaise: 10000,
  }),
}))
vi.mock('@/lib/platform/pricing', () => ({
  buildOrderPricingEvidence: async () => ({}),
  resolveLedgerFinancials:   () => ({
    platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
    gatewayFeeEstimatePaise: 0, netSettlementPaise: 10000,
  }),
}))

const SRC = {
  registrationId: 'reg_1',
  organizerUid:   'org_1',
  eventSlug:      'evt',
  attendeeName:   'A',
  attendeeEmail:  'a@b.test',
  grossAmountPaise: 10000,
  paymentId:      'pay_1',
  orderId:        'order_1',
}

/**
 * The builder has TWO write paths — the canonical one that copies a persisted
 * `financials` breakdown, and the computed one for every payment that has none. Both
 * write provider/gateway, so both are exercised: covering only one let a reinstated
 * literal survive on the other during a mutation check.
 */
const FINANCIALS = {
  ticketBasePaise: 10000, platformFeeBasePaise: 0, platformFeeGstPaise: 0,
  platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0, netSettlementPaise: 10000,
  feeModel: 'organizer_pays',
}

async function build(provider?: unknown, withFinancials = false) {
  const { buildRegistrationLedgerAndCredit } = await import('@/lib/payments/registrationLedger')
  const { ledger } = await buildRegistrationLedgerAndCredit({
    ...SRC, provider, ...(withFinancials ? { financials: FINANCIALS } : {}),
  } as never)
  return ledger as unknown as { provider?: string; gateway?: string }
}

/** Runs a case against BOTH write paths. */
async function bothPaths(provider?: unknown) {
  return { computed: await build(provider, false), canonical: await build(provider, true) }
}

describe('Phase A · a new ledger row names the real gateway', () => {
  beforeEach(() => { vi.resetModules() })

  it('a RAZORPAY payment writes razorpay in both fields, on BOTH paths', async () => {
    const { computed, canonical } = await bothPaths('razorpay')
    for (const l of [computed, canonical]) {
      expect(l.provider).toBe('razorpay')
      expect(l.gateway).toBe('razorpay')
    }
  })

  it('a CASHFREE payment writes cashfree in both fields, on BOTH paths', async () => {
    const { computed, canonical } = await bothPaths('cashfree')
    for (const l of [computed, canonical]) {
      expect(l.provider).toBe('cashfree')
      // The specific defect: the row used to claim Razorpay for Cashfree money.
      expect(l.gateway).toBe('cashfree')
      expect(l.gateway).not.toBe('razorpay')
    }
  })

  it('the two fields can never disagree, for any input, on either path', async () => {
    for (const p of ['razorpay', 'cashfree', undefined, null, '', 'stripe', 0, {}]) {
      const { computed, canonical } = await bothPaths(p)
      expect(computed.provider, `computed path disagreed for ${JSON.stringify(p)}`).toBe(computed.gateway)
      expect(canonical.provider, `canonical path disagreed for ${JSON.stringify(p)}`).toBe(canonical.gateway)
    }
  })
})

describe('Phase A · historical and invalid data stay safe', () => {
  beforeEach(() => { vi.resetModules() })

  it('a caller that supplies NO provider records razorpay explicitly', async () => {
    // Legacy behaviour preserved: every payment before the discriminator existed was
    // Razorpay. It is now written rather than left absent, so the row states its own fact.
    const l = await build(undefined)
    expect(l.provider).toBe('razorpay')
    expect(l.gateway).toBe('razorpay')
  })

  it('an INVALID provider never becomes cashfree', async () => {
    // The dangerous direction. Unrecognised input must fall back to the provider that all
    // history belongs to, never to the one being introduced.
    for (const bad of ['stripe', 'CASHFREE ', '', null, 0, {}, []]) {
      const l = await build(bad)
      expect(l.provider, `${JSON.stringify(bad)} must not read as cashfree`).toBe('razorpay')
    }
  })

  it('resolution goes through readProvider rather than a hand-rolled check', async () => {
    const src = readFileSync('lib/payments/registrationLedger.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(src).toContain('readProvider(src.provider)')
    // No literal survives on either write path.
    expect(src).not.toMatch(/gateway:\s*'razorpay'/)
  })
})

describe('Phase A · the type no longer permits the contradiction', () => {
  it('PlatformTransactionDocument.gateway is PaymentProvider, not a razorpay literal', () => {
    const src = readFileSync('lib/fees/types.ts', 'utf8')
    expect(src).toMatch(/gateway:\s+PaymentProvider/)
    expect(src).not.toMatch(/gateway:\s+'razorpay'\s*$/m)
  })

  it('DONATIONS keep writing razorpay, because that is true for them', () => {
    // Donations are a Razorpay-ONLY domain. The widened type still accepts the literal, and
    // neutralising these would delete accurate information.
    for (const f of ['lib/donations/donationLedger.ts', 'lib/donations/donationService.ts']) {
      expect(readFileSync(f, 'utf8')).toMatch(/gateway:\s*'razorpay'/)
    }
  })
})
