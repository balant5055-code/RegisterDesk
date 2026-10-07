// RD-PHASE4-S3 — event-specific pricing and inheritance: the resolver rules (Q2), the read-failure
// refusal (Q3), organizer-pays (Q1) and the retired override layers (Q4). Business Configuration and the
// event read are mocked so each precedence rule is exercised exactly; the checkout/settlement wiring is
// proved on the emulator (tests/emulator/phase4Stage3.emu.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const cfg = vi.hoisted(() => ({
  fees:      { platformFeeEnabled: true, platformFeePercent: null as number | null, donationPlatformFee: null as number | null,
               gstEnabled: true, gstPercent: 18, gatewayFeeEnabled: true, gatewayFeePercent: 2 },
  licensing: { commercial: { attendeeTransactionFeePercent: 2.5 } },
  event:     { mode: 'ok' as 'ok' | 'throw' | 'missing', data: {} as Record<string, unknown> },
}))
vi.mock('@/lib/config/businessConfigService', () => ({
  businessConfig: { getSection: async (k: 'fees' | 'licensing') => cfg[k] },
}))
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { collection: () => ({ doc: () => ({ get: async () => {
    if (cfg.event.mode === 'throw') throw new Error('simulated Firestore outage')
    return { exists: cfg.event.mode === 'ok', data: () => cfg.event.data }
  } }) }) },
}))
vi.mock('@/lib/monitoring/sentry', () => ({ captureFinancialError: vi.fn(), captureError: () => {}, captureWebhookError: () => {} }))

const code = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

beforeEach(() => {
  cfg.fees.platformFeeEnabled = true; cfg.fees.platformFeePercent = null; cfg.fees.gstPercent = 18; cfg.fees.gatewayFeePercent = 2
  cfg.licensing.commercial.attendeeTransactionFeePercent = 2.5
  cfg.event.mode = 'ok'; cfg.event.data = { uid: 'org1' }
})

describe('Q2 · the event attendee percentage replaces the EFFECTIVE GLOBAL percentage only', () => {
  it('no event value ⇒ the existing global precedence (fees.platformFeePercent ?? commercial rate) is unchanged', async () => {
    const { resolveEventFeeConfig } = await import('@/lib/fees/resolveEventFeeConfig')
    const a = await resolveEventFeeConfig('ev')
    expect(a).toMatchObject({ ok: true, source: 'global', eventAttendeeFeePercent: null })
    expect(a.ok && a.config.platformFeePercentBps).toBe(250)                  // commercial 2.5%
    cfg.fees.platformFeePercent = 3                                           // the legacy global override still wins
    const b = await resolveEventFeeConfig('ev')
    expect(b.ok && b.config.platformFeePercentBps).toBe(300)
  })
  it('an explicit event value wins over BOTH global sources; GST, gateway, fixed and minimum stay global', async () => {
    const { resolveEventFeeConfig } = await import('@/lib/fees/resolveEventFeeConfig')
    const { resolveFeeConfig } = await import('@/lib/fees/resolveFeeConfig')
    const globalCfg = await resolveFeeConfig('event_registration', 'starter')
    cfg.fees.platformFeePercent = 3
    cfg.event.data = { uid: 'org1', commercial: { attendeeTransactionFeePercent: 1.25 } }
    const r = await resolveEventFeeConfig('ev')
    expect(r).toMatchObject({ ok: true, source: 'event', eventAttendeeFeePercent: 1.25 })
    if (!r.ok) throw new Error('unreachable')
    expect(r.config.platformFeePercentBps).toBe(125)
    expect(r.config.gstRatePercent).toBe(globalCfg.gstRatePercent)
    expect(r.config.gatewayFeePercentBps).toBe(globalCfg.gatewayFeePercentBps)
    expect(r.config.platformFeeFixedPaise).toBe(globalCfg.platformFeeFixedPaise)   // the ₹5 constant
    expect(r.config.platformFeeMinPaise).toBe(globalCfg.platformFeeMinPaise)
  })
  it('zero binds (a 0% event); null / missing inherit; an INVALID stored value is ignored (inherits) and reported', async () => {
    const { resolveEventFeeConfig } = await import('@/lib/fees/resolveEventFeeConfig')
    const { captureFinancialError } = await import('@/lib/monitoring/sentry')
    cfg.event.data = { uid: 'o', commercial: { attendeeTransactionFeePercent: 0 } }
    const zero = await resolveEventFeeConfig('ev')
    expect(zero.ok && zero.config.platformFeePercentBps).toBe(0)
    expect(zero.ok && zero.source).toBe('event')
    for (const v of [null, undefined]) {
      cfg.event.data = { uid: 'o', commercial: { attendeeTransactionFeePercent: v } }
      const r = await resolveEventFeeConfig('ev')
      expect(r.ok && r.source).toBe('global')
    }
    for (const bad of [-1, 101, Number.NaN, '2', true]) {
      vi.mocked(captureFinancialError).mockClear()
      cfg.event.data = { uid: 'o', commercial: { attendeeTransactionFeePercent: bad } }
      const r = await resolveEventFeeConfig('ev')
      expect(r.ok && r.source, String(bad)).toBe('global')
      expect(r.ok && r.config.platformFeePercentBps, String(bad)).toBe(250)
      expect(captureFinancialError).toHaveBeenCalled()
    }
  })
  it('the global platform-fee SWITCH still zeroes it; donations ignore any event value', async () => {
    const { resolveEventFeeConfig } = await import('@/lib/fees/resolveEventFeeConfig')
    const { resolveFeeConfig } = await import('@/lib/fees/resolveFeeConfig')
    cfg.fees.platformFeeEnabled = false
    cfg.event.data = { uid: 'o', commercial: { attendeeTransactionFeePercent: 4 } }
    const r = await resolveEventFeeConfig('ev')
    expect(r.ok && r.config.platformFeePercentBps).toBe(0)
    cfg.fees.platformFeeEnabled = true
    const d1 = await resolveFeeConfig('donation', 'starter')
    const d2 = await resolveFeeConfig('donation', 'starter', undefined, { attendeeTransactionFeePercent: 9 })
    expect(d2).toEqual(d1)
  })
  it('legacy adminOverride / organizerOverride on the event are NOT read', async () => {
    const { resolveEventFeeConfig } = await import('@/lib/fees/resolveEventFeeConfig')
    cfg.event.data = { uid: 'o', adminOverride: { platformFeeAmount: 99, convenienceFee: 50 }, organizerOverride: { convenienceFee: 40 } }
    const r = await resolveEventFeeConfig('ev')
    expect(r).toMatchObject({ ok: true, source: 'global' })
    expect(r.ok && r.config.platformFeePercentBps).toBe(250)
  })
})

describe('Q3 · a failed event read REFUSES (never a silent fall-back to global)', () => {
  it('read throws ⇒ EVENT_READ_FAILED (reported); missing event / no slug ⇒ EVENT_CONTEXT_MISSING', async () => {
    const { resolveEventFeeConfig, PRICING_UNAVAILABLE } = await import('@/lib/fees/resolveEventFeeConfig')
    const { captureFinancialError } = await import('@/lib/monitoring/sentry')
    vi.mocked(captureFinancialError).mockClear()
    cfg.event.mode = 'throw'
    expect(await resolveEventFeeConfig('ev')).toEqual({ ok: false, reason: 'EVENT_READ_FAILED' })
    expect(captureFinancialError).toHaveBeenCalled()
    cfg.event.mode = 'missing'
    expect(await resolveEventFeeConfig('ev')).toEqual({ ok: false, reason: 'EVENT_CONTEXT_MISSING' })
    expect(await resolveEventFeeConfig('')).toEqual({ ok: false, reason: 'EVENT_CONTEXT_MISSING' })
    // the public message says nothing about Firestore, stacks or configuration
    expect(PRICING_UNAVAILABLE.code).toBe('PRICING_UNAVAILABLE')
    expect(PRICING_UNAVAILABLE.message).not.toMatch(/firestore|stack|error:|config/i)
  })
  it('create-order and fee-preview refuse with that stable code (503) and derive no fee from the client', () => {
    for (const f of ['app/api/registrations/create-order/route.ts', 'app/api/registrations/fee-preview/route.ts']) {
      const src = code(f)
      expect(src, f).toContain('await resolveEventFeeConfig(slug)')
      expect(src, f).toContain('if (!eventFees.ok) {')
      expect(src, f).toContain('code: PRICING_UNAVAILABLE.code }, { status: 503 })')
      expect(src, f).not.toMatch(/body\.(fee|platformFee|feeModel|convenience|attendeeTransactionFee)/)
    }
  })
})

describe('Q1 · fee collection is fixed to organizer-pays at every trusted boundary', () => {
  it('organizerPaysPricing overwrites any stored fee model and keeps everything else', async () => {
    const { organizerPaysPricing, SUPPORTED_FEE_MODEL } = await import('@/lib/events/builder/types')
    const p = { feeModel: 'attendee_pays', passes: [{ id: 'a', price: 500 }], advancedSettings: { taxes: [] } }
    expect(organizerPaysPricing(p)).toEqual({ ...p, feeModel: SUPPORTED_FEE_MODEL })
    expect(organizerPaysPricing(null)).toBeNull()
  })
  it('publish and duplicate store organizer-pays; checkout charges by SUPPORTED_FEE_MODEL (pins kept)', () => {
    // RD-CE-FIX H3 — still organizer-pays; passes additionally carry sport details only for sport types.
    expect(code('app/api/events/publish/route.ts')).toContain('const p = organizerPaysPricing(draft.pricing ?? null) as Record<string, unknown> | null')
    expect(code('app/api/organizer/events/[eventId]/duplicate/route.ts')).toContain('organizerPaysPricing({ ...srcPricing, passes: newPasses })')
    const order = code('app/api/registrations/create-order/route.ts')
    expect(order).toContain('eventFeeModel: pinnedFeeModel ?? builderFeeModelToEngine(SUPPORTED_FEE_MODEL),')
    expect(order).not.toContain('normalizeFeeModel(rawPricing?.feeModel')
    expect(code('app/api/registrations/fee-preview/route.ts')).toContain('eventFeeModel: builderFeeModelToEngine(SUPPORTED_FEE_MODEL),')
  })
  it('feeModel is not an organizer edit key; the route refuses it with a stable 403', async () => {
    const { SAFE_EDIT_KEYS } = await import('@/lib/events/editing/fieldClassification')
    expect(SAFE_EDIT_KEYS).not.toContain('feeModel')
    expect(code('app/api/organizer/events/[eventId]/edit/route.ts')).toContain("code: 'PRICING_NOT_ORGANIZER_EDITABLE'")
  })
})

describe('Q4 · events/{slug}.commercial is the single event pricing layer', () => {
  it('the platform configuration resolver no longer reads override MONEY fields (registrationLimit kept)', () => {
    const api = code('lib/platform/pricing/api.ts')
    for (const f of ['admin?.platformFeeAmount', 'admin?.platformGstPercent', 'admin?.gatewayPercent', 'admin?.gatewayGstPercent', 'admin?.convenienceFee', 'organizer?.convenienceFee']) {
      expect(api, f).not.toContain(f)
    }
    expect(api).toContain('admin?.registrationLimit, organizer?.registrationLimit,')
  })
  it('organizer override: pricing fields 403 PRICING_NOT_ORGANIZER_EDITABLE; admin override money fields 410 PRICING_LAYER_RETIRED', () => {
    const org = code('app/api/organizer/events/[eventId]/pricing-override/route.ts')
    expect(org).toContain("const ALLOWED_FIELDS = new Set(['registrationLimit'])")
    expect(org).toContain("code: 'PRICING_NOT_ORGANIZER_EDITABLE'")
    const adm = code('app/api/admin/events/[slug]/pricing-override/route.ts')
    expect(adm).toContain("code:  'PRICING_LAYER_RETIRED'")
    expect(adm).toContain('{ status: 410 }')
  })
  it('the only resolver reading event pricing is resolveEventFeeConfig, and it reads only `commercial`', () => {
    const r = code('lib/fees/resolveEventFeeConfig.ts')
    expect(r).toContain('readEventAttendeeFeePercent(data.commercial)')
    expect(r).not.toMatch(/adminOverride|organizerOverride/)
  })
})
