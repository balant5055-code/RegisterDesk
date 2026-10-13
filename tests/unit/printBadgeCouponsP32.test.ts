// RD-PRINT-BILL-P3.2 — badge coupon hardening (pure + source contracts). Real Firestore / routes /
// redemption: tests/emulator/badgeCoupons.emu.test.ts (P3.2 block).
//   1 strict ISO 8601 dates (explicit time zone), normalized to UTC
//   2 corrupt STORED dates fail closed ('invalid', never active, never thrown)
//   3 malformed restrictions fail closed (stored) / are refused (submitted)
//   4 an unreadable organizer counter ⇒ 'usage_unverified'
//   5 the route's [code] is validated like creation
//   6 state-change audit lists only REAL differences;  7 clone audit records the resulting definition

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  parseStrictIsoTimestamp, normalizeIsoTimestamp, deriveBadgeCouponLifecycle, validateBadgeCoupon,
  badgeCouponDefinitionErrors, isValidStoredRestrictions,
} from '@/lib/licensing/badgeCoupons/validate'
import { BADGE_COUPON_SCOPE, type BadgeCouponDoc } from '@/lib/licensing/badgeCoupons/types'
import { RELEASED_FOR_PURCHASE } from '@/lib/licensing/serviceAllowances'
import { PAID_BADGE_GENERATION_RELEASED } from '@/lib/licensing/printBadgeCommercial'

vi.mock('@/lib/config/businessConfigService', () => ({ businessConfig: {} }))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

const read = (f: string) => readFileSync(f, 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const coupon = (over: Partial<BadgeCouponDoc> | Record<string, unknown> = {}): BadgeCouponDoc => ({
  code: 'X', scope: BADGE_COUPON_SCOPE, description: '', type: 'percentage', value: 20, maxDiscountPaise: null, minPurchasePaise: null,
  activatesAt: null, expiresAt: null, usageLimit: null, perOrganizerLimit: null, currentUses: 0,
  restrictions: { eventIds: [], organizerUids: [] }, enabled: true, paused: false, archived: false, campaign: '', internalNotes: '',
  version: 1, createdBy: 'sa', createdAt: null, updatedAt: null, ...over,
} as BadgeCouponDoc)
const ctx = { organizerUid: 'o', eventId: 'e', purchasePaise: 2000, organizerRedemptions: 0, eventCouponsAllowed: true, allowFreeCoupons: false }

describe('1 · strict ISO 8601 dates with an explicit time zone', () => {
  it.each([
    ['2026-11-01T09:00:00Z',           '2026-11-01T09:00:00.000Z'],
    ['2026-11-01T09:00Z',              '2026-11-01T09:00:00.000Z'],
    ['2026-11-01T09:00:00.5Z',         '2026-11-01T09:00:00.500Z'],
    ['2026-11-01T09:00:00+05:30',      '2026-11-01T03:30:00.000Z'],
    ['2026-11-01T00:15:00-08:00',      '2026-11-01T08:15:00.000Z'],
    ['2026-02-28T23:59:59.999+00:00',  '2026-02-28T23:59:59.999Z'],
    ['2028-02-29T00:00:00Z',           '2028-02-29T00:00:00.000Z'],   // leap year
  ])('accepts %s → normalized %s (UTC)', (input, utc) => {
    expect(normalizeIsoTimestamp(input)).toBe(utc)
  })
  it.each([
    '2026-11-01', '2026-11-01T09:00:00', '2026-11-01 09:00:00Z', 'Nov 1 2026', '11/01/2026', '1', '2026', '',
    '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-11-01T24:00:00Z', '2026-11-01T09:60:00Z',
    '2026-11-01T09:00:00+15:00', '2026-11-01T09:00:00+0530', '2026-11-01T09:00:00.1234Z', ' 2026-11-01T09:00:00Z',
  ])('rejects %j', input => {
    expect(parseStrictIsoTimestamp(input)).toBeNull()
    expect(normalizeIsoTimestamp(input)).toBeNull()
  })
  it('non-strings are never timestamps', () => {
    for (const v of [null, undefined, 0, 1793577600000, {}, { toMillis: () => 1 }]) expect(parseStrictIsoTimestamp(v)).toBeNull()
  })
  it('admin input: permissive dates are refused (never read as null); null stays "no bound"; order checked on the instant', () => {
    const base = { type: 'percentage', value: 20, maxDiscountPaise: null, minPurchasePaise: null, activatesAt: null, expiresAt: null,
      usageLimit: null, perOrganizerLimit: null, eventIds: [], organizerUids: [], enabled: true, description: '', campaign: '', internalNotes: '' }
    const errs = (o: Record<string, unknown>) => badgeCouponDefinitionErrors({ ...base, ...o }, { allowFreeCoupons: false })
    expect(errs({})).toEqual([])
    for (const bad of ['2026-11-01', 'Nov 1 2026', '1', '', '2026-11-01T09:00:00']) {
      expect(errs({ activatesAt: bad }), bad).toEqual(['The start date must be an ISO 8601 date-time with a time zone, e.g. 2026-11-01T09:00:00+05:30.'])
      expect(errs({ expiresAt: bad }), bad).toEqual(['The expiry date must be an ISO 8601 date-time with a time zone, e.g. 2026-11-01T09:00:00+05:30.'])
    }
    // 09:00+05:30 is 03:30Z — so an expiry of 04:00Z is AFTER the start even though "09:00" > "04:00".
    expect(errs({ activatesAt: '2026-11-01T09:00:00+05:30', expiresAt: '2026-11-01T04:00:00Z' })).toEqual([])
    expect(errs({ activatesAt: '2026-11-01T09:00:00+05:30', expiresAt: '2026-11-01T03:30:00Z' })).toEqual(['The expiry date must be after the start date.'])
  })
  it('the service stores dates normalized, on create and update', () => {
    const svc = code(read('lib/admin/badgeCouponService.ts'))
    expect(svc).toContain('activatesAt: normalizeIsoTimestamp(def.activatesAt), expiresAt: normalizeIsoTimestamp(def.expiresAt),')
    expect(svc).toContain('if (input.activatesAt !== undefined) patch.activatesAt = normalizeIsoTimestamp(def.activatesAt)')
    expect(svc).toContain('if (input.expiresAt !== undefined) patch.expiresAt = normalizeIsoTimestamp(def.expiresAt)')
  })
})

describe('2 · corrupt STORED dates fail closed', () => {
  it('missing / null / valid bounds behave as before', () => {
    expect(deriveBadgeCouponLifecycle(coupon({ activatesAt: null, expiresAt: null }), NOW)).toBe('active')
    const noDates = coupon(); delete (noDates as Partial<BadgeCouponDoc>).activatesAt; delete (noDates as Partial<BadgeCouponDoc>).expiresAt
    expect(deriveBadgeCouponLifecycle(noDates, NOW)).toBe('active')
    expect(deriveBadgeCouponLifecycle(coupon({ expiresAt: '2026-10-10T12:00:00.000Z' }), NOW)).toBe('expired')       // exclusive
    expect(deriveBadgeCouponLifecycle(coupon({ activatesAt: '2026-10-10T12:00:00.000Z' }), NOW)).toBe('active')       // inclusive
  })
  it.each([['garbage'], ['2026-11-01'], ['Nov 1 2026'], [''], [12345], [{ seconds: 1 }], [true]])('stored date %j ⇒ invalid — never active, never thrown', bad => {
    for (const field of ['activatesAt', 'expiresAt'] as const) {
      const c = coupon({ [field]: bad })
      expect(deriveBadgeCouponLifecycle(c, NOW)).toBe('invalid')
      expect(validateBadgeCoupon(c, ctx, NOW)).toEqual({ ok: false, failure: 'invalid_configuration', message: 'This coupon can’t be used right now.' })
    }
  })
  it('archived stays archived; paused/draft never mask a corrupt coupon', () => {
    expect(deriveBadgeCouponLifecycle(coupon({ expiresAt: 'garbage', archived: true }), NOW)).toBe('archived')
    expect(deriveBadgeCouponLifecycle(coupon({ expiresAt: 'garbage', paused: true }), NOW)).toBe('invalid')
    expect(deriveBadgeCouponLifecycle(coupon({ expiresAt: 'garbage', enabled: false }), NOW)).toBe('invalid')
  })
})

describe('3 · malformed restrictions fail closed — no TypeError', () => {
  it.each([
    [{ eventIds: 'ev-1', organizerUids: [] }], [{}], [{ eventIds: [], organizerUids: null }], [null], [undefined], [[]], ['all'],
    [{ eventIds: [1], organizerUids: [] }], [{ eventIds: ['bad id!'], organizerUids: [] }],
  ])('stored restrictions %j ⇒ invalid_configuration', bad => {
    const c = coupon({ restrictions: bad })
    expect(isValidStoredRestrictions(bad)).toBe(false)
    expect(() => validateBadgeCoupon(c, ctx, NOW)).not.toThrow()
    expect(validateBadgeCoupon(c, ctx, NOW)).toMatchObject({ ok: false, failure: 'invalid_configuration' })
    expect(deriveBadgeCouponLifecycle(c, NOW)).toBe('invalid')
  })
  it('valid restrictions still apply (empty ⇒ everyone)', () => {
    expect(isValidStoredRestrictions({ eventIds: [], organizerUids: [] })).toBe(true)
    expect(validateBadgeCoupon(coupon({ restrictions: { eventIds: ['e'], organizerUids: ['o'] } }), ctx, NOW).ok).toBe(true)
    expect(validateBadgeCoupon(coupon({ restrictions: { eventIds: ['other'], organizerUids: [] } }), ctx, NOW)).toMatchObject({ failure: 'event_not_allowed' })
  })
  it('submitted malformed restrictions are refused with a clear message (never discarded)', () => {
    const base = { type: 'percentage', value: 20, maxDiscountPaise: null, minPurchasePaise: null, activatesAt: null, expiresAt: null,
      usageLimit: null, perOrganizerLimit: null, eventIds: [], organizerUids: [], enabled: true, description: '', campaign: '', internalNotes: '' }
    expect(badgeCouponDefinitionErrors({ ...base, eventIds: 'ev-1' }, { allowFreeCoupons: false })).toEqual(['The event restriction must be a list of up to 200 valid event ids.'])
    expect(badgeCouponDefinitionErrors({ ...base, organizerUids: ['ok', 7] }, { allowFreeCoupons: false })).toEqual(['The organizer restriction must be a list of up to 200 valid organizer ids.'])
  })
})

describe('4–7 · contracts', () => {
  it('4 · an unreadable counter refuses with usage_unverified BEFORE any write (helper and preview)', () => {
    const redeem = code(read('lib/licensing/badgeCoupons/redeem.ts'))
    const refusal = redeem.indexOf("return { ok: false, failure: 'usage_unverified'")
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(redeem.indexOf('tx.update(read.coupon.ref'))
    expect(code(read('lib/admin/badgeCouponService.ts'))).toContain("if (!count.ok) return { ok: false, failure: 'usage_unverified'")
  })
  it('5 · the route validates [code] like creation and answers not-found before building a path', () => {
    const route = code(read('app/api/admin/badge-coupons/[code]/route.ts'))
    expect(route).toContain('return BADGE_COUPON_CODE_RE.test(c) ? c : null')
    expect(route.match(/const code = routeCode\(\(await params\)\.code\)\n\s+if \(!code\) return NOT_FOUND\(\)/g)).toHaveLength(2)
  })
  it('6 · state-change audit lists only real differences', () => {
    expect(code(read('lib/admin/badgeCouponService.ts'))).toContain('const changedFields = (Object.keys(after) as (keyof typeof after)[]).filter(k => before[k] !== after[k])')
  })
  it('7 · clone audit records the source and the resulting definition (no notes/actors)', () => {
    const svc = code(read('lib/admin/badgeCouponService.ts'))
    expect(svc).toContain('after: cloneDefinition(next),')
    const def = svc.slice(svc.indexOf('function cloneDefinition'))
    expect(def).not.toMatch(/internalNotes|createdBy|createdAt|updatedAt/)
  })
  it('the Phase 4 one-coupon-per-order requirement is recorded beside the helper; still no caller', () => {
    expect(read('lib/licensing/badgeCoupons/redeem.ts')).toContain('PHASE 4 DESIGN REQUIREMENT — ONE COUPON PER ORDER')
  })
  it('release gates stay locked', () => {
    expect(RELEASED_FOR_PURCHASE.print_badges).toBe(false)
    expect(PAID_BADGE_GENERATION_RELEASED).toBe(false)
  })
})
