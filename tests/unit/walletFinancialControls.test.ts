// RD-WALLET-CFG-01 — wallet financial controls are Super Admin only (to change AND to see). The pure
// rules the save transaction and the routes use, plus the structural wiring. The behaviour through
// the real routes on real Firestore is tests/emulator/walletFinancialControls.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  WALLET_FINANCIAL_CONTROL_FIELDS, SUPER_ADMIN_ONLY_FIELDS, CENTRAL_PRICING_FIELDS, BUSINESS_CONFIG_DEFAULTS,
  CONFIG_SECTION_REGISTRY, redactSuperAdminOnlyFields, toPublicWalletConfig, diffCentralPricingFields,
  firestoreMergePatch, resolveSection, changedCentralPricingFields, type BusinessConfigSections,
} from '@/lib/config/businessConfig'

const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const W = BUSINESS_CONFIG_DEFAULTS.wallet
const RESTRICTED = [
  'allowNegativeBalance', 'frozen', 'allowWalletRefunds',
  'minimumTopupPaise', 'maximumTopupPaise', 'maximumBalancePaise', 'minimumRequiredBalancePaise',
  'lowBalanceThresholdPaise', 'autoTopupThresholdPaise', 'autoTopupAmountPaise',
]

/** Exactly what the save transaction decides (lib/config/businessConfigService.ts). */
const refused = (stored: Record<string, unknown>, patch: Record<string, unknown>) => {
  const before = resolveSection('wallet', { wallet: stored } as never)
  const after  = resolveSection('wallet', { wallet: firestoreMergePatch(stored, patch) } as never)
  return diffCentralPricingFields('wallet', before, after)
}

describe('the restricted wallet fields', () => {
  it('are exactly the financial controls — gated on write and hidden on read', () => {
    expect([...WALLET_FINANCIAL_CONTROL_FIELDS]).toEqual(RESTRICTED)
    expect(CENTRAL_PRICING_FIELDS.wallet).toBe(WALLET_FINANCIAL_CONTROL_FIELDS)
    expect(SUPER_ADMIN_ONLY_FIELDS.wallet).toBe(WALLET_FINANCIAL_CONTROL_FIELDS)
    for (const f of RESTRICTED) expect(W, f).toHaveProperty(f)
  })
})

describe('the save transaction’s per-field check (what a non-Super Admin is refused)', () => {
  const stored = { ...W } as Record<string, unknown>
  it.each(RESTRICTED.map(f => [f]))('a change to %s is refused', f => {
    const v = (W as unknown as Record<string, unknown>)[f]
    const changed = typeof v === 'boolean' ? !v : (v as number) + 100
    expect(refused(stored, { [f]: changed })).toEqual([f])
  })
  it('a MIXED patch cannot smuggle a restricted change through permitted fields', () => {
    expect(refused(stored, { displayName: 'Wallet X', description: 'new', allowNegativeBalance: !W.allowNegativeBalance })).toEqual(['allowNegativeBalance'])
  })
  it('clearing a restricted value (null REPLACES in Firestore) is a change too', () => {
    const s = { ...stored, maximumTopupPaise: W.maximumTopupPaise + 500 }
    expect(refused(s, { maximumTopupPaise: null })).toEqual(['maximumTopupPaise'])
  })
  it('unrestricted fields, re-sending unchanged values, and the redacted draft the editor sends are all permitted', () => {
    expect(refused(stored, { displayName: 'Renamed', description: 'x', enabled: !W.enabled, mode: 'wallet_only', refundDestination: 'original' })).toEqual([])
    expect(refused(stored, { frozen: W.frozen, minimumTopupPaise: W.minimumTopupPaise })).toEqual([])
    const redacted = (redactSuperAdminOnlyFields({ wallet: W } as unknown as BusinessConfigSections) as unknown as { wallet: Record<string, unknown> }).wallet
    expect(refused(stored, { ...redacted, displayName: 'Edited by an admin' })).toEqual([])
    expect(changedCentralPricingFields('wallet', W, { frozen: !W.frozen })).toEqual(['frozen'])
  })
})

describe('reading', () => {
  it('non-Super Admins get the config WITHOUT the restricted wallet fields; nothing else changes; input untouched', () => {
    const cfg = { ...BUSINESS_CONFIG_DEFAULTS } as unknown as BusinessConfigSections
    const out = redactSuperAdminOnlyFields(cfg) as unknown as Record<string, Record<string, unknown>>
    for (const f of RESTRICTED) expect(out.wallet, f).not.toHaveProperty(f)
    for (const f of ['enabled', 'mode', 'displayName', 'description', 'currency', 'precision', 'allowWalletPayments', 'refundDestination']) expect(out.wallet).toHaveProperty(f)
    expect(out.fees).toBe((cfg as unknown as Record<string, unknown>).fees)
    expect((cfg as unknown as Record<string, Record<string, unknown>>).wallet).toHaveProperty('frozen')    // not mutated
  })
  it('the public feed carries only the organizer-facing wallet fields', () => {
    expect(Object.keys(toPublicWalletConfig(W)).sort()).toEqual([
      'currency', 'description', 'displayName', 'enabled', 'lowBalanceThresholdPaise', 'maximumTopupPaise',
      'minimumTopupPaise', 'mode', 'precision', 'showLowBalanceWarning',
    ])
    for (const f of ['allowNegativeBalance', 'frozen', 'allowWalletRefunds', 'maximumBalancePaise', 'minimumRequiredBalancePaise', 'autoTopupThresholdPaise', 'autoTopupAmountPaise']) {
      expect(toPublicWalletConfig(W), f).not.toHaveProperty(f)
    }
  })
})

describe('validation is unchanged', () => {
  const validate = CONFIG_SECTION_REGISTRY.wallet.validate
  it('valid defaults pass; invalid values are still rejected', () => {
    expect(validate(W).valid).toBe(true)
    expect(validate({ ...W, minimumTopupPaise: -1 }).valid).toBe(false)
    expect(validate({ ...W, minimumTopupPaise: 500, maximumTopupPaise: 100 }).valid).toBe(false)
    expect(validate({ ...W, frozen: 'yes' }).valid).toBe(false)
  })
})

describe('structural wiring', () => {
  const route = code('app/api/admin/business-config/route.ts')
  const editor = code('app/(admin)/admin/business-configuration/SectionEditor.tsx')
  it('the admin route decides from the verified token (ADMIN_UIDS) — redacts the read, gates the write', () => {
    expect(route).toContain('config: superUid === null ? redactSuperAdminOnlyFields(config) : config')
    expect(route).toContain("const isSuperAdmin = (await resolveSuperAdminUid(req.headers.get('authorization'))) !== null")
    expect(route).toContain('canEditPricing: isSuperAdmin')
    expect(route).toContain("code: 'SUPER_ADMIN_REQUIRED'")
  })
  it('the editor hides the fields from non-Super Admins and never re-inserts them (Defaults)', () => {
    expect(editor).toContain('SUPER_ADMIN_ONLY_FIELDS[sectionKey]')
    expect(editor).toContain('.filter(def => !hiddenKeys.has(def.key))')
    expect(editor).toContain('withoutHidden(toDraft(BUSINESS_CONFIG_DEFAULTS[sectionKey]))')
  })
  it('the public feed sends the projection; the client fills the rest from code defaults', () => {
    expect(code('app/api/config/public/route.ts')).toContain('wallet: toPublicWalletConfig(wallet)')
    expect(code('lib/config/BusinessConfigProvider.tsx')).toContain('c.wallet ? { ...CODE_DEFAULTS.wallet, ...c.wallet } : CODE_DEFAULTS.wallet')
  })
})
