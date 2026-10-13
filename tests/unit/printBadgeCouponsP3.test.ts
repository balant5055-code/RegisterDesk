// RD-PRINT-BILL-P3 — ID-badge purchase coupons: pure validation, discount maths, admin-input rules,
// the global free-coupon switch, and source contracts (authorization, separation from licence
// coupons, release gates). Real Firestore / Auth / routes / concurrency:
// tests/emulator/badgeCoupons.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeBadgeCouponCode, BADGE_COUPON_CODE_RE, deriveBadgeCouponLifecycle, validateBadgeCoupon, isFreeShape,
  badgeCouponDefinitionErrors, unknownBadgeCouponKeys, uniqueIds,
} from '@/lib/licensing/badgeCoupons/validate'
import { BADGE_COUPON_SCOPE, BADGE_COUPONS_COLLECTION, type BadgeCouponDoc, type BadgeCouponContext } from '@/lib/licensing/badgeCoupons/types'
import { normalizeCouponCode } from '@/lib/licensing/coupons'
import {
  DEFAULT_PRINT_BADGE_BILLING, validatePrintBadgeBilling, PAID_BADGE_GENERATION_RELEASED,
} from '@/lib/licensing/printBadgeCommercial'
import { badgeSettingsChanged, badgeSettingsOf, describeBadgeSettingsIssue } from '@/lib/licensing/printBadgeSettings'
import { RELEASED_FOR_PURCHASE, parseServiceSelection } from '@/lib/licensing/serviceAllowances'

vi.mock('@/lib/config/businessConfigService', () => ({ businessConfig: {} }))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

const read = (f: string) => readFileSync(f, 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const coupon = (over: Partial<BadgeCouponDoc> = {}): BadgeCouponDoc => ({
  code: 'BADGES20', scope: BADGE_COUPON_SCOPE, description: '', type: 'percentage', value: 20, maxDiscountPaise: null,
  minPurchasePaise: null, activatesAt: null, expiresAt: null, usageLimit: null, perOrganizerLimit: null, currentUses: 0,
  restrictions: { eventIds: [], organizerUids: [] }, enabled: true, paused: false, archived: false, campaign: '', internalNotes: '',
  version: 1, createdBy: 'sa', createdAt: null, updatedAt: null, ...over,
})
const ctx = (over: Partial<BadgeCouponContext> = {}): BadgeCouponContext => ({
  organizerUid: 'org-1', eventId: 'ev-1', purchasePaise: 2000, organizerRedemptions: 0, eventCouponsAllowed: true, allowFreeCoupons: false, ...over,
})

describe('1 · code normalization and the shared namespace convention', () => {
  it('trim + uppercase — identical to licence coupons', () => {
    for (const raw of ['  badges20 ', 'Badges20', 'BADGES20']) {
      expect(normalizeBadgeCouponCode(raw)).toBe('BADGES20')
      expect(normalizeBadgeCouponCode(raw)).toBe(normalizeCouponCode(raw))
    }
    expect(BADGE_COUPON_CODE_RE.test('AB')).toBe(false)
    expect(BADGE_COUPON_CODE_RE.test('BADGE_20-X')).toBe(true)
    expect(BADGE_COUPON_CODE_RE.test('HAS SPACE')).toBe(false)
    expect(BADGE_COUPON_CODE_RE.test('A'.repeat(41))).toBe(false)
  })
})

describe('2 · discounts (GST-inclusive purchase amount, whole paise)', () => {
  it('percentage, capped percentage, fixed (clamped to the purchase)', () => {
    expect(validateBadgeCoupon(coupon({ value: 25 }), ctx(), NOW)).toMatchObject({ ok: true, discountPaise: 500, finalPricePaise: 1500, free: false })
    expect(validateBadgeCoupon(coupon({ value: 50, maxDiscountPaise: 300 }), ctx(), NOW)).toMatchObject({ ok: true, discountPaise: 300, finalPricePaise: 1700 })
    expect(validateBadgeCoupon(coupon({ value: 33 }), ctx({ purchasePaise: 1001 }), NOW)).toMatchObject({ ok: true, discountPaise: 330 })   // floor
    expect(validateBadgeCoupon(coupon({ type: 'fixed', value: 450 }), ctx(), NOW)).toMatchObject({ ok: true, discountPaise: 450, finalPricePaise: 1550 })
  })
  it('a discount that rounds to nothing is refused', () => {
    expect(validateBadgeCoupon(coupon({ value: 1 }), ctx({ purchasePaise: 20 }), NOW)).toMatchObject({ ok: false, failure: 'no_discount' })
  })
  it('FREE (any route to ₹0) is valid ONLY while free coupons are allowed', () => {
    for (const c of [coupon({ type: 'free', value: 0 }), coupon({ value: 100 }), coupon({ type: 'fixed', value: 5000 })]) {
      expect(validateBadgeCoupon(c, ctx({ allowFreeCoupons: false }), NOW)).toMatchObject({ ok: false, failure: 'free_not_allowed' })
      expect(validateBadgeCoupon(c, ctx({ allowFreeCoupons: true }), NOW)).toMatchObject({ ok: true, discountPaise: 2000, finalPricePaise: 0, free: true })
    }
    // A capped 100% coupon that leaves something to pay is not free.
    expect(validateBadgeCoupon(coupon({ value: 100, maxDiscountPaise: 500 }), ctx(), NOW)).toMatchObject({ ok: true, finalPricePaise: 1500, free: false })
  })
  it('isFreeShape: free, or uncapped 100%', () => {
    expect(isFreeShape({ type: 'free', value: 0, maxDiscountPaise: null })).toBe(true)
    expect(isFreeShape({ type: 'percentage', value: 100, maxDiscountPaise: null })).toBe(true)
    expect(isFreeShape({ type: 'percentage', value: 100, maxDiscountPaise: 500 })).toBe(false)
    expect(isFreeShape({ type: 'fixed', value: 99999, maxDiscountPaise: null })).toBe(false)
  })
})

describe('3 · lifecycle, dates, limits and eligibility', () => {
  it('start / expiry boundaries (expiry is exclusive; start is inclusive)', () => {
    const at = '2026-10-10T12:00:00.000Z'
    expect(validateBadgeCoupon(coupon({ activatesAt: at }), ctx(), NOW).ok).toBe(true)
    expect(validateBadgeCoupon(coupon({ activatesAt: at }), ctx(), NOW - 1)).toMatchObject({ ok: false, failure: 'not_started' })
    expect(validateBadgeCoupon(coupon({ expiresAt: at }), ctx(), NOW)).toMatchObject({ ok: false, failure: 'expired' })
    expect(validateBadgeCoupon(coupon({ expiresAt: at }), ctx(), NOW - 1).ok).toBe(true)
  })
  it('draft, paused, archived are never applied', () => {
    expect(deriveBadgeCouponLifecycle(coupon({ enabled: false }), NOW)).toBe('draft')
    expect(validateBadgeCoupon(coupon({ enabled: false }), ctx(), NOW)).toMatchObject({ ok: false, failure: 'not_active' })
    expect(validateBadgeCoupon(coupon({ paused: true }), ctx(), NOW)).toMatchObject({ ok: false, failure: 'not_active' })
    expect(validateBadgeCoupon(coupon({ archived: true, paused: true }), ctx(), NOW)).toMatchObject({ ok: false, failure: 'not_active' })
  })
  it('minimum spend boundary', () => {
    expect(validateBadgeCoupon(coupon({ minPurchasePaise: 2000 }), ctx({ purchasePaise: 2000 }), NOW).ok).toBe(true)
    expect(validateBadgeCoupon(coupon({ minPurchasePaise: 2000 }), ctx({ purchasePaise: 1999 }), NOW)).toMatchObject({ ok: false, failure: 'below_minimum' })
  })
  it('exhausted: total and per-organizer', () => {
    expect(validateBadgeCoupon(coupon({ usageLimit: 3, currentUses: 3 }), ctx(), NOW)).toMatchObject({ ok: false, failure: 'usage_limit_reached' })
    expect(validateBadgeCoupon(coupon({ usageLimit: 3, currentUses: 2 }), ctx(), NOW).ok).toBe(true)
    expect(validateBadgeCoupon(coupon({ perOrganizerLimit: 1 }), ctx({ organizerRedemptions: 1 }), NOW)).toMatchObject({ ok: false, failure: 'per_organizer_limit_reached' })
  })
  it('event and organizer restrictions; the event’s own coupon switch', () => {
    const r = coupon({ restrictions: { eventIds: ['ev-1'], organizerUids: ['org-1'] } })
    expect(validateBadgeCoupon(r, ctx(), NOW).ok).toBe(true)
    expect(validateBadgeCoupon(r, ctx({ eventId: 'ev-2' }), NOW)).toMatchObject({ ok: false, failure: 'event_not_allowed' })
    expect(validateBadgeCoupon(r, ctx({ organizerUid: 'org-2' }), NOW)).toMatchObject({ ok: false, failure: 'organizer_not_allowed' })
    expect(validateBadgeCoupon(coupon(), ctx({ eventCouponsAllowed: false }), NOW)).toMatchObject({ ok: false, failure: 'event_coupons_disabled' })
  })
  it('not found, wrong scope, nothing to discount', () => {
    expect(validateBadgeCoupon(null, ctx(), NOW)).toMatchObject({ ok: false, failure: 'not_found' })
    expect(validateBadgeCoupon({ ...coupon(), scope: 'license' as never }, ctx(), NOW)).toMatchObject({ ok: false, failure: 'wrong_scope' })
    for (const p of [0, -5, 1.5, NaN]) expect(validateBadgeCoupon(coupon(), ctx({ purchasePaise: p }), NOW)).toMatchObject({ ok: false, failure: 'invalid_purchase' })
  })
})

describe('4 · admin input validation', () => {
  const base = { type: 'percentage', value: 20, maxDiscountPaise: null, minPurchasePaise: null, activatesAt: null, expiresAt: null,
    usageLimit: null, perOrganizerLimit: null, eventIds: [], organizerUids: [], enabled: true, description: '', campaign: '', internalNotes: '' }
  const errs = (over: Record<string, unknown>, allowFreeCoupons = false) => badgeCouponDefinitionErrors({ ...base, ...over }, { allowFreeCoupons })
  it('a valid coupon has no errors', () => expect(errs({})).toEqual([]))
  it('malformed discounts, dates, limits and restrictions are refused', () => {
    expect(errs({ type: 'bogus' })).toHaveLength(1)
    for (const v of [0, 101, 12.5, '20']) expect(errs({ value: v }).length).toBeGreaterThan(0)
    expect(errs({ type: 'fixed', value: 0 }).length).toBeGreaterThan(0)
    expect(errs({ type: 'fixed', value: 500, maxDiscountPaise: 100 })).toContain('A maximum discount applies only to percentage coupons.')
    expect(errs({ activatesAt: 'not a date' })).toContain('The start date must be an ISO 8601 date-time with a time zone, e.g. 2026-11-01T09:00:00+05:30.')   // P3.2 wording
    expect(errs({ activatesAt: '2026-11-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z' })).toContain('The expiry date must be after the start date.')
    expect(errs({ usageLimit: 0 }).length).toBeGreaterThan(0)
    expect(errs({ usageLimit: 2, perOrganizerLimit: 3 })).toContain('The per-organizer limit cannot exceed the total-use limit.')
    expect(errs({ eventIds: ['ok', 'bad id!'] }).length).toBeGreaterThan(0)
    expect(errs({ minPurchasePaise: -1 }).length).toBeGreaterThan(0)
  })
  it('free shapes need the global switch', () => {
    expect(errs({ type: 'free', value: 0 })[0]).toMatch(/Free \(100%\) badge coupons are not allowed/)
    expect(errs({ value: 100 })[0]).toMatch(/not allowed/)
    expect(errs({ type: 'free', value: 0 }, true)).toEqual([])
    expect(errs({ value: 100, maxDiscountPaise: 500 })).toEqual([])                       // capped ⇒ not a free shape
  })
  it('unknown fields are reported; restrictions are de-duplicated', () => {
    expect(unknownBadgeCouponKeys({ code: 'X', currentUses: 0, scope: 'x' })).toEqual(['currentUses', 'scope'])
    expect(uniqueIds(['a', 'b', 'a', 3])).toEqual(['a', 'b'])
  })
})

describe('5 · the global free-coupon switch (licensing.printBadgeBilling.allowFreeCoupons)', () => {
  it('defaults off; validated when present; absent is valid (pre-P3 stored groups)', () => {
    expect(DEFAULT_PRINT_BADGE_BILLING).toEqual({ paidGenerationEnabled: false, allowFreeCoupons: false })
    expect(validatePrintBadgeBilling({ paidGenerationEnabled: false })).toEqual([])
    expect(validatePrintBadgeBilling({ paidGenerationEnabled: false, allowFreeCoupons: true })).toEqual([])
    expect(validatePrintBadgeBilling({ paidGenerationEnabled: false, allowFreeCoupons: 'yes' })).toEqual(['licensing.printBadgeBilling.allowFreeCoupons must be a boolean'])
    expect(describeBadgeSettingsIssue('licensing.printBadgeBilling.allowFreeCoupons must be a boolean')).toMatchObject({ field: 'allowFreeCoupons' })
  })
  it('a stored group WITHOUT the new key is not a change; switching it on is', () => {
    const stored = { printBadgeBilling: { paidGenerationEnabled: false } }
    expect(badgeSettingsChanged(badgeSettingsOf(stored), badgeSettingsOf({ printBadgeBilling: { paidGenerationEnabled: false, allowFreeCoupons: false } }))).toBe(false)
    expect(badgeSettingsChanged(badgeSettingsOf(stored), badgeSettingsOf({ printBadgeBilling: { paidGenerationEnabled: false, allowFreeCoupons: true } }))).toBe(true)
  })
})

describe('6 · contracts: authorization, separation, no usage on validate, release gates', () => {
  const list = code(read('app/api/admin/badge-coupons/route.ts'))
  const one = code(read('app/api/admin/badge-coupons/[code]/route.ts'))
  it('every handler is Super Admin only (ADMIN_UIDS); every change needs a 3–500 reason', () => {
    expect(list.match(/const gate = await requireSuperAdmin\(req\)/g)).toHaveLength(2)
    expect(one.match(/const gate = await requireSuperAdmin\(req\)/g)).toHaveLength(2)
    expect(list).toContain('const reason = parseFinancialReason(body.reason)')
    expect(one).toContain('const reason = parseFinancialReason(body.reason)')
    // Preview is answered BEFORE the reason check and writes nothing.
    expect(one.indexOf("if (action === 'preview')")).toBeLessThan(one.indexOf('const reason = parseFinancialReason(body.reason)'))
    expect(list + one).not.toMatch(/resolveAdminUid/)
  })
  it('the admin service stages an audit row in each mutation transaction; preview never writes', () => {
    const svc = code(read('lib/admin/badgeCouponService.ts'))
    for (const a of ['created', 'updated', 'cloned']) expect(svc).toContain(`'badge_coupon.${a}'`)
    expect(svc).toContain("action === 'pause' ? 'badge_coupon.paused' : action === 'resume' ? 'badge_coupon.resumed' : 'badge_coupon.archived'")
    const preview = svc.slice(svc.indexOf('export async function previewBadgeCoupon'))
    expect(preview).not.toMatch(/runTransaction|\.set\(|\.update\(|\.create\(|increment/)
    expect(svc).toContain("throw new BadgeCouponAdminError('This coupon has been redeemed, so its discount type and value can no longer change.")
  })
  it('licence coupons are untouched except the namespace read; licence checkout cannot see badge coupons', () => {
    // The licence validator and store are unchanged and never mention badge coupons.
    for (const f of ['lib/licensing/coupons/validate.ts', 'lib/licensing/coupons/store.ts', 'lib/licensing/coupons/types.ts',
      'app/api/licensing/purchase/route.ts', 'app/api/licensing/coupons/validate/route.ts']) {
      expect(read(f), f).not.toMatch(/badgeCoupon|BADGE_COUPON|badge_coupon/)
    }
    // The licence admin service reads the badge namespace in create and clone — and never writes it.
    const lic = code(read('lib/admin/licenseCouponService.ts'))
    expect(lic.match(/tx\.get\(badgeNamespaceRef\(/g)).toHaveLength(2)
    expect(lic).not.toMatch(/badgeNamespaceRef\([^)]*\)\s*,\s*\{|tx\.(set|create|update)\(badgeNamespaceRef/)
    // The badge validator never reads licence coupons.
    expect(read('lib/licensing/badgeCoupons/validate.ts')).not.toMatch(/licenseCoupon|lib\/licensing\/coupons/)
    expect(BADGE_COUPONS_COLLECTION).toBe('badgeCoupons')
  })
  // RD-PRINT-BILL-P4 — Phase 4 adds exactly ONE caller: the badge purchase activation transaction.
  it('the redemption primitive has exactly one caller — the Phase 4 activation transaction', () => {
    const hits: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) { if (n !== 'node_modules' && !n.startsWith('.next')) walk(p); continue }
        if (/\.(ts|tsx)$/.test(n) && /txnRedeemBadgeCoupon|txnReadBadgeCouponRedemption/.test(read(p))) hits.push(p.replace(/\\/g, '/'))
      }
    }
    for (const d of ['app', 'lib', 'components', 'features']) walk(d)
    expect(hits.sort()).toEqual(['lib/licensing/badgeCoupons/redeem.ts', 'lib/licensing/printBadgePurchase/settle.ts'])
  })
  it('badge coupons are reachable only through Super Admin APIs (no public route)', () => {
    const hits: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (/\.(ts|tsx)$/.test(n) && /badgeCouponService|lib\/licensing\/badgeCoupons\/store/.test(read(p))) hits.push(p.replace(/\\/g, '/'))
      }
    }
    walk('app')
    for (const h of hits) expect(h.startsWith('app/api/admin/badge-coupons/'), h).toBe(true)
  })
  it('paid badge purchase and paid generation stay LOCKED', () => {
    expect(RELEASED_FOR_PURCHASE.print_badges).toBe(false)
    expect(PAID_BADGE_GENERATION_RELEASED).toBe(false)
    expect(parseServiceSelection({ print_badges: 100 })).toMatchObject({ ok: false })
  })
})
