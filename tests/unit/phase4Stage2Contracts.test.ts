// RD-PHASE4-S2 — source contracts for global pricing authorization, the admin UI locks and the
// checkout-time fee snapshot. Behaviour is proved on the emulator (phase4Stage2.emu.test.ts,
// checkoutFeeSnapshot.emu.test.ts); these pin the WIRING that those runtime tests rely on.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CENTRAL_PRICING_FIELDS, changedCentralPricingFields, BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'
import { isCheckoutFeeInputs } from '@/lib/fees/types'

// Comments stripped: several of these files DOCUMENT the old behaviour in prose.
const code = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('RD-PHASE4-S2 · which settings are Super Admin only', () => {
  it('fees (every field), the payment provider, settlement fee/tax and media-credit enablement + refund bounds', () => {
    expect(CENTRAL_PRICING_FIELDS.fees).toBe('*')
    expect(CENTRAL_PRICING_FIELDS.payments).toEqual(['activeProvider'])
    // RD-PHASE4-S4 · D1 — the fund-release controls joined the Super Admin list (intentional).
    expect(CENTRAL_PRICING_FIELDS.settlements).toEqual([
      'settlementFeePercent', 'settlementFeeFlatPaise', 'settlementTaxPercent',
      'enabled', 'autoRelease', 'holdHours', 'frozen',
    ])
    expect(CENTRAL_PRICING_FIELDS.mediaStudio).toEqual(expect.arrayContaining([
      'creditsEnabled', 'minRefundablePaise', 'minRefundCredits', 'maxRefundPerRequestPaise', 'refundWindowDays',
    ]))
    for (const k of Object.keys(BUSINESS_CONFIG_DEFAULTS.fees)) {
      const cur = (BUSINESS_CONFIG_DEFAULTS.fees as Record<string, unknown>)[k]
      const next = typeof cur === 'boolean' ? !cur : typeof cur === 'number' ? cur + 1 : cur === null ? 1 : `${String(cur)}x`
      expect(changedCentralPricingFields('fees', BUSINESS_CONFIG_DEFAULTS.fees, { [k]: next }), k).toEqual(['fees'])
    }
  })
  it('non-pricing settings keep their existing permissions', () => {
    // RD-PHASE4-S4 — holdHours is now a fund-release control (Super Admin); a settlement LIMIT is not.
    expect(changedCentralPricingFields('settlements', BUSINESS_CONFIG_DEFAULTS.settlements, { maximumSettlementsPerRun: 99 })).toEqual([])
    expect(changedCentralPricingFields('settlements', BUSINESS_CONFIG_DEFAULTS.settlements, { holdHours: 99 })).toEqual(['holdHours'])
    expect(changedCentralPricingFields('mediaStudio', BUSINESS_CONFIG_DEFAULTS.mediaStudio, { refundsEnabled: !BUSINESS_CONFIG_DEFAULTS.mediaStudio.refundsEnabled })).toEqual([])
    // RD-WALLET-CFG-01 — only the wallet's FINANCIAL controls are Super Admin only; its other settings
    // (name, description, mode, refund routing…) keep their existing admin permission.
    expect(changedCentralPricingFields('wallet', BUSINESS_CONFIG_DEFAULTS.wallet, { displayName: 'Renamed', mode: 'wallet_only' })).toEqual([])
    expect(changedCentralPricingFields('wallet', BUSINESS_CONFIG_DEFAULTS.wallet, { frozen: !BUSINESS_CONFIG_DEFAULTS.wallet.frozen })).toEqual(['frozen'])
    expect(CENTRAL_PRICING_FIELDS.featureFlags).toBeUndefined()
  })
  it('the server gates are decided from the verified token', () => {
    expect(code('app/api/admin/business-config/route.ts')).toContain("const PRICING_SECTIONS: readonly BusinessConfigSectionKey[] = ['licensing', 'fees']")
    const ps = code('app/api/admin/platform-settings/route.ts')
    expect(ps.indexOf('resolveSuperAdminUid(')).toBeGreaterThan(-1)
    expect(ps.indexOf('resolveSuperAdminUid(')).toBeLessThan(ps.indexOf('updatePlatformSettings('))
    expect(code('lib/platform/pricing/service.ts')).toContain('runTransaction')
    for (const f of ['app/api/admin/license-coupons/route.ts', 'app/api/admin/license-coupons/[code]/route.ts', 'app/api/admin/events/[slug]/pricing-override/route.ts']) {
      expect(code(f), f).toContain("code: 'SUPER_ADMIN_REQUIRED'")
    }
  })
})

describe('RD-PHASE4-S2 · the admin UI reflects the server (which stays authoritative)', () => {
  const D = 'app/(admin)/admin/business-configuration/'
  it('fees, gateway and settlement fee fields lock without the server-decided capability', () => {
    const page = code(D + 'PageClient.tsx')
    expect(page.match(/canEditPricing=\{data\.permissions\?\.canEditPricing === true\}/g)?.length).toBeGreaterThanOrEqual(6)
    expect(code(D + 'FeesEditor.tsx')).toContain('<fieldset disabled={!canEditPricing}')
    expect(code(D + 'FeesEditor.tsx')).toContain('disabled={!canEditPricing || !dirty || !validation.valid || publishing}')
    expect(code(D + 'PaymentGatewayEditor.tsx')).toContain('disabled={!canEditPricing || !dirty || !validation.valid || publishing || confirming}')
    expect(code(D + 'SectionEditor.tsx')).toContain('lockedKeys.has(def.key)')
  })
  it('the pricing-engine switch is Super Admin only and needs a confirmation AND a reason', () => {
    const ops = code('app/(admin)/admin/pricing-ops/PageClient.tsx')
    expect(ops).toContain("disabled={saving || data.permissions?.canEditPricing !== true}")
    expect(ops).toMatch(/await confirm\(\{/)
    expect(ops).toMatch(/await prompt\(\{ title: 'Reason required'/)
    expect(ops).toContain('pricingEngineEnabled: next }, reason }')
    expect(ops).not.toContain('read-only.')
    expect(code('app/api/admin/pricing-ops/route.ts')).toContain('permissions: { canEditPricing }')
  })
  it('licence coupon controls appear only with the capability', () => {
    const lc = code('app/(admin)/admin/license-center/PageClient.tsx')
    expect(lc).toContain('{canEdit && <button onClick={() => setCreating(true)}')
    expect(lc).toContain("{data.permissions?.canEditPricing === true && <ActionGroup title=\"Edit (audited)\">")
  })
})

describe('RD-PHASE4-S2 · the checkout-time fee snapshot reaches every settlement path', () => {
  it('create-order captures it (engine off only) and writes it once, on the new intent', () => {
    const co = code('app/api/registrations/create-order/route.ts')
    expect(co).toContain('if (!financials) {')
    // RD-PHASE4-S3 — the inputs are the EVENT-resolved terms (its own percentage, or inherited global).
    expect(co).toContain('const eventFees = await resolveEventFeeConfig(slug)')
    expect(co).toContain('feeConfig: JSON.parse(JSON.stringify(eventFees.config)) as FeeConfig')
    expect(co).toContain('...(feeInputs ? { feeInputs } : {}),')
  })
  it('settlement (verify / webhook / capture sweep) and the ledger sweep pass the intent’s snapshot', () => {
    expect(code('lib/payments/settleCapturedRegistration.ts')).toContain('feeInputs:        intent.feeInputs,')
    expect(code('lib/payments/registrationReconciliation.ts')).toContain('feeInputs:        intent.feeInputs,')
    const led = code('lib/payments/registrationLedger.ts')
    expect(led).toContain('const frozen    = isCheckoutFeeInputs(src.feeInputs) ? src.feeInputs : null')
    expect(led).toContain("const feeConfig = frozen ? frozen.feeConfig : await resolveFeeConfig('event_registration', planTier)")
  })
  it('only a complete, well-formed snapshot is accepted', () => {
    const good = { version: 1, planTier: 'starter', feeConfigId: 'plan:starter', capturedAt: '2026-09-30T00:00:00Z', feeConfig: {
      platformFeePercentBps: 250, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise: 0,
      gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 } }
    expect(isCheckoutFeeInputs(good)).toBe(true)
    expect(isCheckoutFeeInputs({ ...good, version: 2 })).toBe(false)
    expect(isCheckoutFeeInputs({ ...good, feeConfig: { ...good.feeConfig, gstRatePercent: -1 } })).toBe(false)
    expect(isCheckoutFeeInputs({ ...good, feeConfig: { ...good.feeConfig, platformFeePercentBps: Number.NaN } })).toBe(false)
    expect(isCheckoutFeeInputs(null)).toBe(false)
  })
})
