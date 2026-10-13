// RD-PRINT-BILL-P2 — Print Badges billing, Phase 2 (Super Admin controls). Pure + source contracts.
// Real routes / Firestore / Auth: tests/emulator/printBadgeCommercial.emu.test.ts.
//
//   1. precedence: global off → free; event disabled → free; complimentary; event price ⟶ global
//   2. event overrides: whole paise 1–1,000, never 0 / "inherit by zero"; patch semantics
//   3. GST null / invalid; invalid badge settings never touch other service prices
//   4. the HARD purchase release gate at selection, quantity, catalog state and activation
//   5. badge-settings change detection, validation and locks (for-sale + paid generation)
//   6. public exposure: the override never leaves admin endpoints

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  SERVICE_KINDS, RELEASED_FOR_PURCHASE, isServicePurchaseReleased, DEFAULT_SERVICE_ALLOWANCES,
  parseServiceSelection, validateServiceQuantity, validateServiceAllowances, priceServiceItem,
  type PrepaidServiceConfig,
} from '@/lib/licensing/serviceAllowances'
import {
  PRINT_BADGE_CHARGEABLE_ASSET_TYPES, PAID_BADGE_GENERATION_RELEASED, DEFAULT_PRINT_BADGE_BILLING,
  BADGE_OVERRIDE_PRICE_MIN_PAISE, BADGE_OVERRIDE_PRICE_MAX_PAISE, EVENT_PRINT_BADGE_FIELD,
  validatePrintBadgeBilling, validatePrintBadgeOverride, readStoredPrintBadgeOverride,
  parsePrintBadgeOverridePatch, applyPrintBadgeOverridePatch, changedPrintBadgeOverrideFields,
  isFreeOrComplimentarySetting, resolveEffectivePrintBadgeTerms, printBadgePrecedence, isChargeableBadgeAssetType,
  type GlobalPrintBadgeTerms,
} from '@/lib/licensing/printBadgeCommercial'
import {
  badgeSettingsOf, badgeSettingsChanged, badgeSettingsProblems, defaultBadgeSettings,
} from '@/lib/licensing/printBadgeSettings'
import { resolveServiceCatalogFromStored } from '@/lib/licensing/serviceAllowanceConfig'
import { resolveSection, BUSINESS_CONFIG_DEFAULTS, CONFIG_SECTION_REGISTRY } from '@/lib/config/businessConfig'

vi.mock('@/lib/config/businessConfigService', () => ({ businessConfig: {} }))

const read = (f: string) => readFileSync(f, 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const G: GlobalPrintBadgeTerms = { paidGenerationEnabled: true, unitPricePaise: 20, gstRatePercent: 18 }
const PRINT_READY: PrepaidServiceConfig = { enabled: true, unitPricePaise: 20, gstRatePercent: 18, minQuantity: 100, maxQuantity: null, presets: [], onExhausted: 'block' }
const STORED_WA = { enabled: true, unitPricePaise: 25, gstRatePercent: 18, minQuantity: 10, maxQuantity: null, presets: [100], onExhausted: 'block' }

describe('1 · precedence (rules, ungated) and the gated resolver', () => {
  it('global paid generation off ⇒ FREE, whatever the event says', () => {
    for (const ov of [undefined, { complimentary: true }, { enabled: true, unitPricePaise: 900 }]) {
      expect(printBadgePrecedence({ ...G, paidGenerationEnabled: false }, ov)).toMatchObject({ mode: 'free', reason: 'global_disabled', chargeable: false, sources: { mode: 'global' } })
    }
  })
  it('event enabled:false ⇒ FREE for that event (not blocked); outranks complimentary', () => {
    expect(printBadgePrecedence(G, { enabled: false })).toMatchObject({ mode: 'free', reason: 'event_disabled', chargeable: false, sources: { mode: 'event' } })
    expect(printBadgePrecedence(G, { enabled: false, complimentary: true })).toMatchObject({ mode: 'free', reason: 'event_disabled' })
  })
  it('complimentary ⇒ COMPLIMENTARY, never chargeable', () => {
    expect(printBadgePrecedence(G, { complimentary: true, unitPricePaise: 500 })).toMatchObject({ mode: 'complimentary', reason: 'complimentary', chargeable: false })
  })
  it('paid: the event price, else the global price — with the source of each value', () => {
    expect(printBadgePrecedence(G, undefined)).toMatchObject({ mode: 'paid', chargeable: true, unitPricePaise: 20, sources: { unitPricePaise: 'global', couponsAllowed: 'default' }, couponsAllowed: true, priceConfigured: true })
    expect(printBadgePrecedence(G, { unitPricePaise: 35 })).toMatchObject({ mode: 'paid', unitPricePaise: 35, sources: { unitPricePaise: 'event' } })
    expect(printBadgePrecedence(G, { unitPricePaise: 1000 })).toMatchObject({ unitPricePaise: 1000 })      // may exceed the global price
    expect(printBadgePrecedence(G, { couponsAllowed: false })).toMatchObject({ couponsAllowed: false, sources: { couponsAllowed: 'event' } })
    expect(printBadgePrecedence(G, { enabled: true })).toMatchObject({ mode: 'paid', unitPricePaise: 20 })
  })
  it('a corrupt stored override never charges (fails toward FREE, reported)', () => {
    for (const bad of [{ unitPricePaise: 0 }, { unitPricePaise: 1001 }, { complimentary: 'yes' }, { surprise: 1 }, 'on', [1]]) {
      expect(printBadgePrecedence(G, bad)).toMatchObject({ mode: 'free', reason: 'override_invalid', chargeable: false })
    }
  })
  it('GST null / invalid ⇒ priceConfigured false (no price is ever assumed)', () => {
    expect(printBadgePrecedence({ ...G, gstRatePercent: null }, undefined).priceConfigured).toBe(false)
    expect(printBadgePrecedence({ ...G, gstRatePercent: 150 }, undefined).priceConfigured).toBe(false)
    expect(printBadgePrecedence({ ...G, unitPricePaise: null }, undefined).priceConfigured).toBe(false)
  })
  it('the GATED resolver (what callers use) is FREE in every case while paid generation is unreleased', () => {
    expect(PAID_BADGE_GENERATION_RELEASED).toBe(false)
    for (const ov of [undefined, { enabled: true }, { unitPricePaise: 50 }, { complimentary: true }]) {
      expect(resolveEffectivePrintBadgeTerms(G, ov)).toMatchObject({ mode: 'free', reason: 'global_disabled', chargeable: false })
    }
  })
  it('chargeable asset types are a code constant: ID_CARD and BADGE only', () => {
    expect([...PRINT_BADGE_CHARGEABLE_ASSET_TYPES]).toEqual(['ID_CARD', 'BADGE'])
    expect(isChargeableBadgeAssetType('ID_CARD') && isChargeableBadgeAssetType('BADGE')).toBe(true)
    for (const t of ['BIB', 'VIP_PASS', 'CUSTOM', 'id_card', null]) expect(isChargeableBadgeAssetType(t)).toBe(false)
  })
})

describe('2 · event overrides: values and patches', () => {
  it('unit price: whole paise 1–1,000 inclusive; 0, fractions, strings and out-of-range refused', () => {
    expect([BADGE_OVERRIDE_PRICE_MIN_PAISE, BADGE_OVERRIDE_PRICE_MAX_PAISE]).toEqual([1, 1000])
    for (const ok of [1, 20, 999, 1000]) expect(validatePrintBadgeOverride({ unitPricePaise: ok })).toEqual([])
    for (const bad of [0, -1, 1001, 1.5, '20', NaN, null]) expect(validatePrintBadgeOverride({ unitPricePaise: bad }).length).toBe(1)
    expect(validatePrintBadgeOverride({ enabled: 'false' })).toEqual(['printBadgeCommercial.enabled must be true or false'])
    expect(validatePrintBadgeOverride({ discount: 5 })).toEqual(['printBadgeCommercial.discount is not a recognised setting'])
  })
  it('a patch: value sets, null removes (inherit), absent keeps; zero is never "inherit"', () => {
    const p = parsePrintBadgeOverridePatch({ unitPricePaise: 30, couponsAllowed: null })
    expect(p).toEqual({ ok: true, patch: { unitPricePaise: 30, couponsAllowed: null } })
    expect(applyPrintBadgeOverridePatch({ couponsAllowed: false, complimentary: true }, p.ok ? p.patch : {}, false))
      .toEqual({ complimentary: true, unitPricePaise: 30 })
    expect(parsePrintBadgeOverridePatch({ unitPricePaise: 0 })).toMatchObject({ ok: false })
    expect(parsePrintBadgeOverridePatch({ evil: 1 })).toEqual({ ok: false, error: 'Unknown setting: evil' })
    expect(parsePrintBadgeOverridePatch({})).toMatchObject({ ok: false })
    expect(applyPrintBadgeOverridePatch({ enabled: false }, { enabled: null }, false)).toBeNull()      // nothing left ⇒ no override
    expect(applyPrintBadgeOverridePatch({ enabled: false }, {}, true)).toBeNull()                       // clear
    expect(changedPrintBadgeOverrideFields({ enabled: false }, { enabled: false, unitPricePaise: 5 })).toEqual(['unitPricePaise'])
    expect(changedPrintBadgeOverrideFields({ enabled: false }, { enabled: false })).toEqual([])         // no-op
  })
  it('free / complimentary settings are flagged for the audit', () => {
    expect(isFreeOrComplimentarySetting({ enabled: false })).toBe(true)
    expect(isFreeOrComplimentarySetting({ complimentary: true })).toBe(true)
    expect(isFreeOrComplimentarySetting({ unitPricePaise: 30 })).toBe(false)
    expect(isFreeOrComplimentarySetting(null)).toBe(false)
  })
  it('a stored override is read strictly', () => {
    expect(readStoredPrintBadgeOverride(undefined)).toEqual({ ok: true, override: null })
    expect(readStoredPrintBadgeOverride({})).toEqual({ ok: true, override: null })
    expect(readStoredPrintBadgeOverride({ unitPricePaise: 30 })).toEqual({ ok: true, override: { unitPricePaise: 30 } })
    expect(readStoredPrintBadgeOverride({ unitPricePaise: 0 }).ok).toBe(false)
  })
})

describe('3 · global configuration: GST null/invalid, isolation from other services', () => {
  it('printBadgeBilling: default off; validated strictly', () => {
    expect(DEFAULT_PRINT_BADGE_BILLING).toEqual({ paidGenerationEnabled: false, allowFreeCoupons: false })   // + P3
    expect(BUSINESS_CONFIG_DEFAULTS.licensing.printBadgeBilling).toEqual({ paidGenerationEnabled: false, allowFreeCoupons: false })
    expect(validatePrintBadgeBilling({ paidGenerationEnabled: false })).toEqual([])
    expect(validatePrintBadgeBilling({ paidGenerationEnabled: 'no' })).toHaveLength(1)
    expect(validatePrintBadgeBilling({ paidGenerationEnabled: false, rate: 1 })).toHaveLength(1)
  })
  it('the GST rate stays NULL by default (no rate assumed)', () => {
    expect(DEFAULT_SERVICE_ALLOWANCES.print_badges.gstRatePercent).toBeNull()
    expect(BUSINESS_CONFIG_DEFAULTS.licensing.serviceAllowances!.print_badges.gstRatePercent).toBeNull()
  })
  it('an INVALID stored print_badges never reverts the other services to defaults (Business Configuration)', () => {
    for (const bad of [{ ...PRINT_READY, gstRatePercent: 150 }, { unitPricePaise: -5 }, 'corrupt', { ...PRINT_READY, unitPricePaise: 'x' }]) {
      const lic = resolveSection('licensing', { licensing: { serviceAllowances: { whatsapp: STORED_WA, certificates: DEFAULT_SERVICE_ALLOWANCES.certificates, media: DEFAULT_SERVICE_ALLOWANCES.media, print_badges: bad } } } as never)
      expect(lic.serviceAllowances!.whatsapp).toEqual(STORED_WA)                   // the stored WhatsApp price survives
      expect(CONFIG_SECTION_REGISTRY.licensing.validate(lic).valid).toBe(true)     // and the group validates
    }
  })
  it('an INVALID stored print_badges is failed closed per service (catalog) — siblings unchanged', () => {
    const r = resolveServiceCatalogFromStored({ whatsapp: STORED_WA, print_badges: { ...PRINT_READY, gstRatePercent: 150 } })
    expect(r.state.print_badges).toBe('invalid')
    expect(r.config.print_badges.unitPricePaise).toBeNull()
    expect(r.config.whatsapp).toEqual(STORED_WA)
    expect(r.state.whatsapp).toBe('available')
  })
  it('an invalid printBadgeBilling group falls back to its own default alone', () => {
    const lic = resolveSection('licensing', { licensing: { printBadgeBilling: { paidGenerationEnabled: 'yes' }, serviceAllowances: { whatsapp: STORED_WA, certificates: DEFAULT_SERVICE_ALLOWANCES.certificates, media: DEFAULT_SERVICE_ALLOWANCES.media } } } as never)
    expect(lic.printBadgeBilling).toEqual({ paidGenerationEnabled: false, allowFreeCoupons: false })   // + P3
    expect(lic.serviceAllowances!.whatsapp).toEqual(STORED_WA)
  })
  it('group validation excludes catalog-only services; full validation still reports them', () => {
    const sa = { ...DEFAULT_SERVICE_ALLOWANCES, print_badges: { unitPricePaise: -1 } }
    expect(validateServiceAllowances(sa, 'x', { catalogOnly: 'exclude' })).toEqual([])
    expect(validateServiceAllowances(sa, 'x').some(e => e.startsWith('x.print_badges'))).toBe(true)
  })
})

describe('4 · the HARD purchase release gate — every layer', () => {
  it('a code constant: print_badges not released; the original services are', () => {
    expect(RELEASED_FOR_PURCHASE).toEqual({ whatsapp: true, certificates: true, media: true, print_badges: false })
    expect(Object.isFrozen(RELEASED_FOR_PURCHASE)).toBe(true)
    for (const k of SERVICE_KINDS) expect(isServicePurchaseReleased(k)).toBe(true)
    for (const k of ['print_badges', 'unknown', undefined, 1]) expect(isServicePurchaseReleased(k)).toBe(false)
  })
  it('selection: refused by name', () => {
    expect(parseServiceSelection({ print_badges: 100 })).toEqual({ ok: false, message: 'Prepaid badges aren’t available for purchase yet.' })
    expect(parseServiceSelection({ whatsapp: 1, print_badges: 0 })).toMatchObject({ ok: false })
  })
  it('quantity: NOT_PURCHASABLE even when FULLY configured and switched "for sale"; 0 is still "none"', () => {
    expect(validateServiceQuantity('print_badges', 100, PRINT_READY)).toEqual({ ok: false, code: 'NOT_PURCHASABLE', message: 'Prepaid badges aren’t available for purchase yet.' })
    expect(validateServiceQuantity('print_badges', 0, PRINT_READY)).toEqual({ ok: true, quantity: 0 })
    expect(validateServiceQuantity('whatsapp', 5, DEFAULT_SERVICE_ALLOWANCES.whatsapp)).toEqual({ ok: true, quantity: 5 })   // unchanged
  })
  it('catalog state: not_released even when fully configured and "for sale"; corrupt stays invalid', () => {
    expect(resolveServiceCatalogFromStored({ print_badges: PRINT_READY }).state.print_badges).toBe('not_released')
    expect(resolveServiceCatalogFromStored(undefined).state.print_badges).toBe('not_released')
    expect(resolveServiceCatalogFromStored({ print_badges: { unitPricePaise: 'x' } }).state.print_badges).toBe('invalid')
    expect(resolveServiceCatalogFromStored(undefined).state).toMatchObject({ whatsapp: 'available', certificates: 'available', media: 'available' })
  })
  it('activation: txnApplyServiceItems refuses an unreleased line before any write (source contract; emulator proves it)', () => {
    const src = code(read('lib/licensing/serviceAllowanceLedger.ts'))
    const gate = src.indexOf("if (items.some(i => !isServicePurchaseReleased(i.service))) throw new Error('SERVICE_NOT_RELEASED')")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(src.indexOf('txn.set(ledgerRef(args.draftId), patch, { merge: true })'))
    // The line it would refuse is a perfectly consistent GST-inclusive line (it is the gate, not arithmetic, that stops it).
    expect(priceServiceItem('print_badges', 100, PRINT_READY)).toMatchObject({ totalPaise: 2000, priceMode: 'inclusive' })
  })
  it('the gate is never read from configuration or the Admin UI', () => {
    for (const f of ['lib/config/businessConfig.ts', 'lib/config/businessConfigService.ts', 'app/api/admin/business-config/route.ts',
      'app/(admin)/admin/business-configuration/LicensingEditor.tsx', 'components/admin/AdminPrintBadgePanel.tsx']) {
      expect(code(read(f)), f).not.toMatch(/RELEASED_FOR_PURCHASE\s*[=:]|PAID_BADGE_GENERATION_RELEASED\s*=/)
    }
    expect(code(read('lib/licensing/serviceAllowances.ts'))).toMatch(/export const RELEASED_FOR_PURCHASE: Readonly<Record<CatalogServiceKind, boolean>> = Object\.freeze\(\{/)
  })
})

describe('5 · global badge settings — change detection, validation, locks', () => {
  const pubSection = { serviceAllowances: { whatsapp: STORED_WA } }      // production-shaped: no print_badges, no printBadgeBilling
  it('absent ⇔ defaults: an untouched draft is NOT a badge change', () => {
    expect(badgeSettingsChanged(badgeSettingsOf(pubSection), badgeSettingsOf({ ...pubSection, serviceAllowances: { ...pubSection.serviceAllowances, print_badges: { ...DEFAULT_SERVICE_ALLOWANCES.print_badges } }, printBadgeBilling: { paidGenerationEnabled: false } }))).toBe(false)
    expect(badgeSettingsChanged(badgeSettingsOf(pubSection), badgeSettingsOf({ serviceAllowances: { whatsapp: { ...STORED_WA, unitPricePaise: 30 } } }))).toBe(false)   // a WhatsApp-only change
  })
  it('a real badge change is detected; key order never matters', () => {
    const changed = { serviceAllowances: { print_badges: { ...DEFAULT_SERVICE_ALLOWANCES.print_badges, gstRatePercent: 18 } } }
    expect(badgeSettingsChanged(badgeSettingsOf(pubSection), badgeSettingsOf(changed))).toBe(true)
    const reordered = { serviceAllowances: { print_badges: Object.fromEntries(Object.entries(DEFAULT_SERVICE_ALLOWANCES.print_badges).reverse()) } }
    expect(badgeSettingsChanged(badgeSettingsOf(pubSection), badgeSettingsOf(reordered))).toBe(false)
  })
  it('problems: invalid values are errors; for-sale and paid generation are LOCKED', () => {
    expect(badgeSettingsProblems(badgeSettingsOf({ serviceAllowances: { print_badges: { ...DEFAULT_SERVICE_ALLOWANCES.print_badges, unitPricePaise: -1 } } })).errors.length).toBe(1)
    expect(badgeSettingsProblems(badgeSettingsOf({ serviceAllowances: { print_badges: { ...DEFAULT_SERVICE_ALLOWANCES.print_badges, enabled: true, gstRatePercent: 18 } } })).locked.length).toBe(1)
    expect(badgeSettingsProblems(badgeSettingsOf({ printBadgeBilling: { paidGenerationEnabled: true } })).locked.length).toBe(1)
    expect(badgeSettingsProblems(badgeSettingsOf({ serviceAllowances: { print_badges: { ...DEFAULT_SERVICE_ALLOWANCES.print_badges, gstRatePercent: 18 } } }))).toEqual({ errors: [], locked: [] })
    expect(badgeSettingsProblems(badgeSettingsOf({}))).toEqual({ errors: [], locked: [] })
  })
  it('reset to defaults writes the approved, locked-off values', () => {
    expect(defaultBadgeSettings()).toEqual({
      printBadges: { enabled: false, unitPricePaise: 20, gstRatePercent: null, minQuantity: 100, maxQuantity: null, presets: [], onExhausted: 'block' },
      printBadgeBilling: { paidGenerationEnabled: false, allowFreeCoupons: false },   // + P3
      printBadgePilot: { enforced: true, organizerUids: [] },                          // + RD-PRINT-P8: nobody listed
    })
    expect(badgeSettingsProblems(badgeSettingsOf({ serviceAllowances: { print_badges: defaultBadgeSettings().printBadges }, printBadgeBilling: defaultBadgeSettings().printBadgeBilling }))).toEqual({ errors: [], locked: [] })
  })
  it('the route guard: only for licensing, inside the save transaction; 3–500 reason; audit row per version', () => {
    const route = code(read('app/api/admin/business-config/route.ts'))
    expect(route).toContain("...(body.section === 'licensing' ? { stageInTransaction: badgeSettingsGuard(adminUid, body.reason) } : {}),")
    expect(route).toContain('if (!badgeSettingsChanged(before, after)) return')
    expect(route).toContain('const reason = parseFinancialReason(rawReason)')
    expect(route).toContain("txn.set(info.db.collection('adminAuditLogs').doc(`badge_settings_v${info.version}`), audit)")
    // Readiness for the SELLABLE services only.
    expect(route).toContain('Object.entries(candidate.serviceAllowances).filter(([k]) => (SERVICE_KINDS as readonly string[]).includes(k))')
    // The non-badge reason rule is unchanged (non-empty).
    expect(route).toContain("if (!reason) return NextResponse.json({ error: 'A reason is required to publish' }")
  })
})

describe('6 · authorization, audit and public exposure (source contracts)', () => {
  const ROUTE = 'app/api/admin/events/[slug]/print-badges/route.ts'
  it('the event route: Super Admin on both methods, 3–500 reason, one transaction with both audit rows', () => {
    const src = code(read(ROUTE))
    expect(src.match(/const gate = await requireSuperAdmin\(req\)/g)).toHaveLength(2)
    expect(src).toContain('const reason = parseFinancialReason(body.reason)')
    expect(src).toContain('if (!reason.ok) return reasonErrorResponse(reason)')
    expect(src).toContain('adminDb.runTransaction<Outcome>(async txn =>')
    expect(src).toContain("action:       'print_badge_override',")
    expect(src).toContain("action: a.after === null ? 'print_badge_commercial.cleared' : 'print_badge_commercial.set',")
    expect(src).not.toMatch(/resolveAdminUid/)
  })
  it('the ungated precedence function is used only by its own module (and tests)', () => {
    const hits: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) { if (!['node_modules', '.next'].includes(n) && !n.startsWith('.next')) walk(p); continue }
        if (/\.(ts|tsx)$/.test(n) && read(p).includes('printBadgePrecedence')) hits.push(p.replace(/\\/g, '/'))
      }
    }
    for (const d of ['app', 'lib', 'components', 'features']) walk(d)
    expect(hits).toEqual(['lib/licensing/printBadgeCommercial.ts'])
  })
  it('the override field is referenced only by admin/server code — never by public event paths', () => {
    // + P3: the Super Admin badge-coupon service reads the event's couponsAllowed for previews (server-only).
    // + P5: the generation billing mode resolver reads it (server-only) to decide paid / complimentary / free.
    const allowed = new Set(['lib/licensing/printBadgeCommercial.ts', 'lib/admin/badgeCouponService.ts', 'lib/printAssets/badgeBilling/store.ts'])
    const hits: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) { if (!['node_modules'].includes(n) && !n.startsWith('.next')) walk(p); continue }
        if (/\.(ts|tsx)$/.test(n) && (read(p).includes(`'${EVENT_PRINT_BADGE_FIELD}'`) || read(p).includes('EVENT_PRINT_BADGE_FIELD'))) hits.push(p.replace(/\\/g, '/'))
      }
    }
    for (const d of ['app', 'lib', 'components', 'features']) walk(d)
    for (const h of hits) expect(allowed.has(h) || h.startsWith('app/api/admin/'), h).toBe(true)
  })
  it('public event serializers project explicit fields — never the raw document', () => {
    const cards = code(read('lib/firebase/firestore/publicEvents.ts'))
    expect(cards).toContain('events.push(toPublicEventCard(doc, counterMap.get(doc.id) ?? 0))')
    expect(cards).not.toMatch(/\.\.\.raw\b|\.\.\.doc\.data\(\)/)
    const api = code(read('app/api/public/events/route.ts'))
    expect(api).not.toMatch(/\.\.\.e\b|\.\.\.doc\.data\(\)|json\(\s*pageDocs/)
    for (const f of ['app/api/public/events/route.ts', 'lib/firebase/firestore/publicEvents.ts', 'app/events/[slug]/page.tsx', 'app/events/[slug]/register/page.tsx']) {
      expect(read(f), f).not.toMatch(/printBadgeCommercial|\bcommercial\b\s*:/)
    }
  })
  it('the existing capacity `commercial` route is untouched by badge billing', () => {
    expect(read('app/api/admin/events/[slug]/commercial/route.ts')).not.toMatch(/printBadge|print_badge/)
  })
})
