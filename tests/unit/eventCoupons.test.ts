// RD-EVENT-14 · the Coupons workspace.
//
// ═══ WHAT THESE PIN ══════════════════════════════════════════════════════════
//
// 1. MONEY. PATCH used to write `value` with no validation at all
//    (`if (body.value !== undefined) updates.value = body.value`), while POST checked
//    percentage ∈ 1..100 and fixed > 0. So the same authenticated organizer could set a
//    percentage to 500 or to a NEGATIVE number. `computeDiscount` has no clamp and
//    `finalPaise = max(0, original - discount)` guards only the floor — a negative discount
//    makes the final price HIGHER than the ticket. Both routes now validate the WHOLE
//    coupon through one function, so a partial edit is checked against what it will be
//    stored beside.
//
// 2. STATUS. The tab rendered `active ? 'Active' : 'Inactive'` — one of the validator's
//    four gates — so expired, scheduled and spent codes all wore a green "Active" pill
//    while every attendee typing them was refused. Exactly RD-DASH-07's defect, on a
//    second surface. `resolveCouponState` is now the only answer.
//
// 3. ZERO vs UNKNOWN. `currentUses` was printed raw; a document without the counter showed
//    a blank "Used" and "NaN left". It is `number | null` on the wire now, and every
//    derived figure is null rather than 0.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  validateCouponInput, normalizeCouponCode, isIsoDate, COUPON_CODE_RE, MAX_DESCRIPTION,
  type CouponInput,
} from '@/lib/coupons/couponInput'
import {
  couponStateOf, couponUsage, couponUsageLabel, couponsSummary, couponScopeLabel,
  couponWindowLabel, couponStateNote, formatCouponValue, formatRupees, filterCoupons, couponScope,
  sortCoupons, couponMatches, couponEmptyMessage, COUPON_STATE_TONE, UNAVAILABLE,
  type CouponRow,
} from '@/lib/coupons/couponView'
import { resolveCouponState, COUPON_STATE_LABEL } from '@/lib/coupons/couponState'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

const TAB    = read('app/(dashboard)/dashboard/events/[eventId]/tabs/CouponsTab.tsx')
const LIST   = read('app/api/organizer/events/[eventId]/coupons/route.ts')
const ITEM   = read('app/api/organizer/events/[eventId]/coupons/[couponId]/route.ts')
const SHELL  = read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx')

/** Strips comments, so a contract can never be satisfied by prose about it. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function row(o: Partial<CouponRow> = {}): CouponRow {
  return {
    id: 'c1', code: 'SAVE20', description: 'Twenty off', type: 'percentage', value: 20,
    active: true, validFrom: null, validUntil: null, maxUses: null, currentUses: 0,
    applicablePassIds: [], ...o,
  }
}

const VALID: Partial<CouponInput> = {
  code: 'SAVE20', description: 'Twenty off', type: 'percentage', value: 20,
  active: true, validFrom: null, validUntil: null, maxUses: null, applicablePassIds: [],
}

// ═══ 1 · The money hole PATCH used to have ═══════════════════════════════════

describe('validateCouponInput · percentage bounds', () => {
  it('accepts a normal percentage', () => {
    const r = validateCouponInput(VALID)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.value).toBe(20)
  })

  // The exact values PATCH used to write straight through.
  it.each([500, 101, 0, -20, NaN, Infinity])('refuses percentage %s', v => {
    const r = validateCouponInput({ ...VALID, value: v })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('value')
  })

  it('accepts the boundaries 1 and 100', () => {
    expect(validateCouponInput({ ...VALID, value: 1 }).ok).toBe(true)
    expect(validateCouponInput({ ...VALID, value: 100 }).ok).toBe(true)
  })

  // POST always allowed a fractional percentage, so rejecting one now would lock an
  // organizer out of editing a 12.5% coupon that has been working for months.
  it('accepts a fractional percentage, as the create route always did', () => {
    expect(validateCouponInput({ ...VALID, value: 12.5 }).ok).toBe(true)
  })

  it('refuses a non-numeric value rather than storing NaN', () => {
    const r = validateCouponInput({ ...VALID, value: undefined })
    expect(r.ok).toBe(false)
  })
})

describe('validateCouponInput · fixed amounts are paise', () => {
  it('accepts a positive whole number of paise', () => {
    const r = validateCouponInput({ ...VALID, type: 'fixed', value: 50000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.value).toBe(50000)
  })

  it.each([0, -1, -50000, 12.5])('refuses fixed value %s', v => {
    expect(validateCouponInput({ ...VALID, type: 'fixed', value: v }).ok).toBe(false)
  })

  // A negative discount is the case that raises the price above the ticket.
  it('a negative fixed amount cannot reach the document', () => {
    const r = validateCouponInput({ ...VALID, type: 'fixed', value: -100000 })
    expect(r.ok).toBe(false)
  })
})

describe('validateCouponInput · type and value are checked TOGETHER', () => {
  // The old PATCH accepted `{ type: 'fixed' }` alone, leaving the 20 behind as 20 PAISE —
  // a 20% coupon silently became ₹0.20 off. Twenty paise is a legal fixed amount, so no
  // value rule can catch it; the route refuses a type change that carries no new amount.
  it('a type change must carry its own amount', () => {
    expect(strip(ITEM)).toMatch(/body\.type !== stored\.type/)
    expect(strip(ITEM)).toMatch(/'value' in body/)
  })

  it('free normalises its stored value to 100 whatever it inherited', () => {
    const r = validateCouponInput({ ...VALID, type: 'free', value: 500 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.value).toBe(100)
  })

  it('refuses an unknown type', () => {
    const r = validateCouponInput({ ...VALID, type: 'bogus' as CouponInput['type'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('type')
  })
})

describe('validateCouponInput · codes', () => {
  it('normalises case and surrounding space', () => {
    const r = validateCouponInput({ ...VALID, code: '  save20 ' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.code).toBe('SAVE20')
  })

  it.each(['', 'A', 'has space', 'lower!', 'X'.repeat(31)])('refuses code %j', c => {
    expect(validateCouponInput({ ...VALID, code: c }).ok).toBe(false)
  })

  it('normalizeCouponCode tolerates a non-string', () => {
    expect(normalizeCouponCode(undefined)).toBe('')
    expect(normalizeCouponCode(42)).toBe('')
  })

  it('the regex is anchored at both ends', () => {
    expect(COUPON_CODE_RE.test('OK-1')).toBe(true)
    expect(COUPON_CODE_RE.test('OK 1')).toBe(false)
  })
})

describe('validateCouponInput · dates', () => {
  it('accepts ISO calendar dates', () => {
    const r = validateCouponInput({ ...VALID, validFrom: '2026-01-01', validUntil: '2026-12-31' })
    expect(r.ok).toBe(true)
  })

  // The validator compares these LEXICALLY, so a free-form string is not merely untidy —
  // it silently decides comparisons.
  it.each(['tomorrow', '01/01/2026', '2026-1-1', '2026-01-01T00:00:00Z'])('refuses %j', d => {
    expect(validateCouponInput({ ...VALID, validFrom: d }).ok).toBe(false)
  })

  it('refuses an end date before its start date', () => {
    const r = validateCouponInput({ ...VALID, validFrom: '2026-06-01', validUntil: '2026-05-01' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('validUntil')
  })

  it('an empty string means "unset", not an invalid date', () => {
    const r = validateCouponInput({ ...VALID, validFrom: '', validUntil: '' })
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.value.validFrom).toBeNull(); expect(r.value.validUntil).toBeNull() }
  })

  it('isIsoDate is exported for the surfaces that need it', () => {
    expect(isIsoDate('2026-02-30')).toBe(true)   // shape only — the validator compares strings
    expect(isIsoDate(20260101)).toBe(false)
  })
})

describe('validateCouponInput · limits, description and scope', () => {
  it.each([0, -5, 2.5])('refuses a usage limit of %s', v => {
    expect(validateCouponInput({ ...VALID, maxUses: v }).ok).toBe(false)
  })

  it('null means unlimited', () => {
    const r = validateCouponInput({ ...VALID, maxUses: null })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.maxUses).toBeNull()
  })

  it('requires a description and caps its length', () => {
    expect(validateCouponInput({ ...VALID, description: '   ' }).ok).toBe(false)
    expect(validateCouponInput({ ...VALID, description: 'x'.repeat(MAX_DESCRIPTION + 1) }).ok).toBe(false)
  })

  it('refuses a coupon restricted to a pass that does not exist', () => {
    const r = validateCouponInput({ ...VALID, applicablePassIds: ['ghost'] }, ['p1', 'p2'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('applicablePassIds')
  })

  it('accepts real pass ids and de-duplicates them', () => {
    const r = validateCouponInput({ ...VALID, applicablePassIds: ['p1', 'p1'] }, ['p1'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.applicablePassIds).toEqual(['p1'])
  })

  it('an empty scope is valid and means every pass', () => {
    const r = validateCouponInput({ ...VALID, applicablePassIds: [] }, ['p1'])
    expect(r.ok).toBe(true)
  })
})

// ═══ 2 · Status is the validator's answer, never `active` ════════════════════

describe('couponStateOf mirrors the validator', () => {
  const today = '2026-06-15'

  it('an ACTIVE but expired coupon is not "Active"', () => {
    const s = couponStateOf(row({ active: true, validUntil: '2026-06-14' }), today)
    expect(s).toBe('expired')
    expect(COUPON_STATE_LABEL[s]).not.toBe(COUPON_STATE_LABEL.redeemable)
  })

  it('an ACTIVE but not-yet-open coupon is scheduled', () => {
    expect(couponStateOf(row({ validFrom: '2026-07-01' }), today)).toBe('scheduled')
  })

  it('an ACTIVE coupon at its cap is exhausted', () => {
    expect(couponStateOf(row({ maxUses: 50, currentUses: 50 }), today)).toBe('exhausted')
  })

  it('the switch still wins over everything', () => {
    expect(couponStateOf(row({ active: false, validUntil: '2026-06-14' }), today)).toBe('inactive')
  })

  it('a working coupon is redeemable', () => {
    expect(couponStateOf(row({ validFrom: '2026-01-01', validUntil: '2026-12-31', maxUses: 10, currentUses: 3 }), today))
      .toBe('redeemable')
  })

  it('the window is INCLUSIVE at both ends, as the validator has it', () => {
    expect(couponStateOf(row({ validFrom: today }), today)).toBe('redeemable')
    expect(couponStateOf(row({ validUntil: today }), today)).toBe('redeemable')
  })

  // The view must not invent a second definition of the same thing.
  it('agrees with resolveCouponState on every row', () => {
    const rows = [
      row(), row({ active: false }), row({ validUntil: '2020-01-01' }),
      row({ validFrom: '2030-01-01' }), row({ maxUses: 1, currentUses: 9 }),
    ]
    for (const r of rows) {
      expect(couponStateOf(r, today)).toBe(resolveCouponState({
        active: r.active, validFrom: r.validFrom ?? undefined, validUntil: r.validUntil ?? undefined,
        maxUses: r.maxUses ?? undefined, currentUses: r.currentUses ?? 0,
      }, today))
    }
  })

  it('every state has a tone', () => {
    for (const s of ['redeemable', 'exhausted', 'expired', 'scheduled', 'inactive'] as const) {
      expect(COUPON_STATE_TONE[s]).toBeTruthy()
    }
  })
})

// ═══ 3 · An unreadable counter is not a zero ═════════════════════════════════

describe('couponUsage · zero vs unknown', () => {
  it('a null counter yields NO figures at all', () => {
    const u = couponUsage(row({ currentUses: null, maxUses: 100 }))
    expect(u.known).toBe(false)
    expect(u.used).toBeNull()
    expect(u.remaining).toBeNull()
    expect(u.percent).toBeNull()
  })

  it('a genuine zero is a number, and stays distinguishable', () => {
    const u = couponUsage(row({ currentUses: 0, maxUses: 100 }))
    expect(u.known).toBe(true)
    expect(u.used).toBe(0)
    expect(u.percent).toBe(0)
  })

  it('the label says unavailable rather than "0 used"', () => {
    expect(couponUsageLabel(couponUsage(row({ currentUses: null })))).toContain(UNAVAILABLE)
    expect(couponUsageLabel(couponUsage(row({ currentUses: null })))).not.toMatch(/\b0\b/)
  })

  it('renders "NaN" nowhere, whatever the shape', () => {
    for (const r of [row({ currentUses: null, maxUses: 10 }), row({ currentUses: null, maxUses: null })]) {
      expect(couponUsageLabel(couponUsage(r))).not.toContain('NaN')
    }
  })

  // The badge must agree with enforcement, and validate.ts finds `undefined >= n` false.
  it('an unreadable counter does not make a coupon LOOK spent', () => {
    expect(couponStateOf(row({ currentUses: null, maxUses: 1 }), '2026-06-15')).toBe('redeemable')
  })

  it('percent is NOT clamped, so a lowered cap stays visible', () => {
    const u = couponUsage(row({ currentUses: 120, maxUses: 100 }))
    expect(u.percent).toBe(120)
    expect(u.exceeded).toBe(true)
    expect(u.remaining).toBe(0)
  })

  it('an unlimited coupon has no proportion to draw', () => {
    const u = couponUsage(row({ currentUses: 7, maxUses: null }))
    expect(u.percent).toBeNull()
    expect(couponUsageLabel(u)).toBe('7 redemptions')
  })
})

describe('couponsSummary', () => {
  const today = '2026-06-15'

  it('counts states, not the switch', () => {
    const s = couponsSummary([
      row({ id: 'a' }),
      row({ id: 'b', active: true, validUntil: '2020-01-01' }),
      row({ id: 'c', active: false }),
    ], today)
    expect(s.total).toBe(3)
    expect(s.redeemable).toBe(1)
    expect(s.stateCounts.expired).toBe(1)
    expect(s.stateCounts.inactive).toBe(1)
  })

  it('sums when every counter is readable', () => {
    const s = couponsSummary([row({ id: 'a', currentUses: 5 }), row({ id: 'b', currentUses: 2 })], today)
    expect(s.totalRedemptions).toBe(7)
    expect(s.countersUnknown).toBe(0)
  })

  // One legacy document must not erase the figure for the whole event — permanently.
  it('sums what it can and states what it left out', () => {
    const s = couponsSummary([row({ id: 'a', currentUses: 5 }), row({ id: 'b', currentUses: null })], today)
    expect(s.totalRedemptions).toBe(5)
    expect(s.countersUnknown).toBe(1)
  })

  it('when NOTHING is readable the total is absent, never zero', () => {
    const s = couponsSummary([row({ id: 'a', currentUses: null }), row({ id: 'b', currentUses: null })], today)
    expect(s.totalRedemptions).toBeNull()
    expect(s.countersUnknown).toBe(2)
  })

  it('an empty event is a genuine set of zeroes', () => {
    const s = couponsSummary([], today)
    expect(s.total).toBe(0)
    expect(s.totalRedemptions).toBe(0)
    expect(s.countersUnknown).toBe(0)
  })
})

// ═══ 4 · Words ═══════════════════════════════════════════════════════════════

describe('display vocabulary', () => {
  it('formats each discount type the way an organizer reads it', () => {
    expect(formatCouponValue({ type: 'percentage', value: 20 })).toBe('20% off')
    expect(formatCouponValue({ type: 'fixed', value: 50000 })).toBe('₹500 off')
    expect(formatCouponValue({ type: 'free', value: 100 })).toBe('Free entry')
  })

  it('keeps part-rupee amounts honest', () => {
    expect(formatRupees(50)).toBe('₹0.50')
    expect(formatRupees(100)).toBe('₹1')
  })

  it('an empty scope is ALL passes, never "0 passes"', () => {
    expect(couponScopeLabel([], [{ id: 'p1', name: 'Standard' }])).toBe('All passes')
  })

  it('names the passes it can, and reports the ones that were removed', () => {
    const passes = [{ id: 'p1', name: 'Standard' }, { id: 'p2', name: 'VIP' }]
    expect(couponScopeLabel(['p1'], passes)).toBe('Standard')
    expect(couponScopeLabel(['p1', 'p2'], passes)).toBe('Standard · VIP')
    expect(couponScopeLabel(['p1', 'gone'], passes)).toBe('Standard + 1 removed')
  })

  // The validator refuses EVERY attempt on such a coupon, so "Active" alone would be a lie.
  it('a coupon whose every pass was deleted is flagged broken', () => {
    const passes = [{ id: 'p1', name: 'Standard' }]
    const s = couponScope(['gone', 'also-gone'], passes)
    expect(s.broken).toBe(true)
    expect(s.missing).toBe(2)
    expect(s.label).toBe('No existing pass')
  })

  // RegisterDesk is not a marathon product. A conference sells tickets, an exhibition
  // sells entries; `passNoun` is the SSOT and this surface follows it like Passes does.
  it('speaks the event type\'s own word for a pass', () => {
    const passes = [{ id: 'p1', name: 'Delegate' }]
    const tickets = { one: 'ticket', many: 'tickets' }
    expect(couponScope([], passes, tickets).label).toBe('All tickets')
    expect(couponScope(['gone'], passes, tickets).label).toBe('No existing ticket')
  })

  it('the workspace takes that word from passNoun, not from a literal', () => {
    expect(strip(TAB)).toMatch(/passNoun\(event\.eventType\)/)
    expect(strip(TAB)).not.toMatch(/>All passes</)
    expect(strip(TAB)).not.toMatch(/Which passes it applies to/)
  })

  it('an unrestricted coupon is never broken', () => {
    expect(couponScope([], [{ id: 'p1', name: 'Standard' }])).toEqual(
      { label: 'All passes', missing: 0, broken: false })
  })

  it('states the window, or that there is none', () => {
    expect(couponWindowLabel({ validFrom: null, validUntil: null })).toBe('No date limit')
    expect(couponWindowLabel({ validFrom: '2026-09-14', validUntil: null })).toContain('From')
    expect(couponWindowLabel({ validFrom: null, validUntil: '2026-09-14' })).toContain('Until')
  })

  // A date is a UTC calendar date because that is what the validator compares.
  it('renders a calendar date without shifting it', () => {
    expect(couponWindowLabel({ validFrom: '2026-09-14', validUntil: null })).toMatch(/14 Sept? 2026/)
  })

  it('explains why a coupon is not working, and says nothing about one that is', () => {
    expect(couponStateNote(row(), 'redeemable')).toBeNull()
    expect(couponStateNote(row({ validUntil: '2026-01-31' }), 'expired')).toContain('31 Jan 2026')
    expect(couponStateNote(row({ maxUses: 50 }), 'exhausted')).toContain('50')
  })
})

// ═══ 5 · Filter and order ════════════════════════════════════════════════════

describe('filter, search and order', () => {
  const today = '2026-06-15'
  const rows = [
    row({ id: 'a', code: 'ALPHA',  description: 'first',  currentUses: 1 }),
    row({ id: 'b', code: 'BRAVO',  description: 'second', currentUses: 9 }),
    row({ id: 'c', code: 'CHARLIE', active: false }),
  ]

  it('matches code and description as a substring, case-insensitively', () => {
    expect(couponMatches(rows[0], 'lph')).toBe(true)
    expect(couponMatches(rows[0], 'FIRST')).toBe(true)
    expect(couponMatches(rows[0], 'zzz')).toBe(false)
    expect(couponMatches(rows[0], '  ')).toBe(true)
  })

  it('filters by the resolved state', () => {
    expect(filterCoupons(rows, 'inactive', '', today).map(r => r.id)).toEqual(['c'])
    expect(filterCoupons(rows, 'redeemable', '', today).map(r => r.id)).toEqual(['a', 'b'])
  })

  it('combines a filter with a query', () => {
    expect(filterCoupons(rows, 'redeemable', 'bravo', today).map(r => r.id)).toEqual(['b'])
  })

  it('puts working codes first, then the most used', () => {
    expect(sortCoupons(rows, today).map(r => r.id)).toEqual(['b', 'a', 'c'])
  })

  it('does not mutate its input', () => {
    const before = rows.map(r => r.id)
    sortCoupons(rows, today)
    expect(rows.map(r => r.id)).toEqual(before)
  })

  it('an empty filter never claims there are no coupons', () => {
    expect(couponEmptyMessage('expired', '')).not.toMatch(/^No coupons/)
    expect(couponEmptyMessage('all', 'zzz')).toContain('zzz')
  })
})

// ═══ 6 · Source contracts ════════════════════════════════════════════════════

describe('the workspace cannot regress to `active` as a status', () => {
  it('uses the canonical resolver', () => {
    expect(TAB).toMatch(/from '@\/lib\/coupons\/couponView'/)
    expect(strip(TAB)).toMatch(/couponStateOf\(/)
  })

  it('no longer renders the two-way Active/Inactive pill', () => {
    expect(strip(TAB)).not.toMatch(/active\s*\?\s*'Active'\s*:\s*'Inactive'/)
    expect(strip(TAB)).not.toMatch(/\?\s*'Active'\s*:/)
  })

  it('never prints "∞" — unlimited is a word', () => {
    expect(TAB).not.toContain('∞')
  })

  // Four metrics reading 0 · 0 · 0 above an empty list measure nothing and make an event
  // that simply has no coupons look like one whose figures failed.
  it('an event with no coupons returns BEFORE the overview renders', () => {
    const s = strip(TAB)
    const guard = s.indexOf('if (coupons.length === 0)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(s.indexOf('id="coupons-summary"'))
  })
})

describe('the write routes share ONE validator', () => {
  it('both import it', () => {
    expect(strip(LIST)).toMatch(/validateCouponInput/)
    expect(strip(ITEM)).toMatch(/validateCouponInput/)
  })

  it('PATCH no longer writes `value` unchecked', () => {
    expect(strip(ITEM)).not.toMatch(/updates\.value\s*=\s*body\.value/)
    expect(strip(ITEM)).not.toMatch(/body\.value\s*!==\s*undefined/)
  })

  it('PATCH validates the MERGED coupon, not the patch', () => {
    expect(strip(ITEM)).toMatch(/merged/)
    expect(strip(ITEM)).toMatch(/validateCouponInput\(merged/)
  })

  it('`currentUses` is not patchable', () => {
    const patchable = strip(ITEM).match(/const PATCHABLE = \[([\s\S]*?)\]/)
    expect(patchable).toBeTruthy()
    expect(patchable![1]).not.toContain('currentUses')
  })

  it('deleting a redeemed coupon needs an explicit acknowledgement', () => {
    expect(strip(ITEM)).toMatch(/confirmUsed/)
    expect(strip(ITEM)).toMatch(/requiresConfirmation/)
  })
})

describe('the list route is bounded and honest', () => {
  it('caps the read and reports when it had to', () => {
    expect(strip(LIST)).toMatch(/\.limit\(COUPON_DOC_BUDGET \+ 1\)/)
    expect(strip(LIST)).toMatch(/truncated/)
  })

  it('an unpublished event is a STATE, not a 404', () => {
    expect(strip(LIST)).toMatch(/eventPublished/)
  })

  it('sends the SERVER\'s validator date, so the badge cannot drift by a timezone', () => {
    expect(strip(LIST)).toMatch(/couponToday\(new Date\(\)\)/)
    expect(strip(TAB)).toMatch(/json\.today/)
  })

  it('leaks no Firestore message, index URL or digest', () => {
    expect(strip(LIST)).toMatch(/catch \{[\s\S]*?Please try again/)
    expect(strip(LIST)).not.toMatch(/e\.message|error\.message|String\(e\)/)
    expect(strip(ITEM)).not.toMatch(/e\.message|error\.message|String\(e\)/)
  })

  it('an unset optional field is DELETED, never stored as null', () => {
    expect(strip(ITEM)).toMatch(/FieldValue\.delete\(\)/)
  })
})

describe('controls do not lie about what happened', () => {
  it('the swallow-and-pretend handlers are gone', () => {
    expect(strip(TAB)).not.toContain('non-critical')
  })

  it('every mutation checks the response before changing the list', () => {
    const s = strip(TAB)
    expect((s.match(/if \(!res\.ok\)/g) ?? []).length).toBeGreaterThanOrEqual(4)
    // The toggle's state change is guarded: the setter must come after the check.
    const toggle = s.slice(s.indexOf('handleToggle'))
    expect(toggle.indexOf('if (!res.ok)')).toBeLessThan(toggle.indexOf('setCoupons'))
  })

  it('a failed action says the coupon is unchanged', () => {
    expect(TAB).toMatch(/is unchanged/)
  })

  it('the platform-wide switch is surfaced rather than silently ignored', () => {
    expect(strip(TAB)).toMatch(/couponsEnabled/)
    expect(strip(LIST)).toMatch(/getFeatureFlags/)
  })
})

describe('the shell passes the event, not a slice of it', () => {
  it('mounts CouponsTab with the loaded event', () => {
    expect(strip(SHELL)).toMatch(/<CouponsTab event=\{event\} token=\{token\} \/>/)
  })

  it('coupons still issue no registration read', () => {
    expect(strip(SHELL)).not.toMatch(/TABS_NEEDING_REGISTRATIONS[\s\S]{0,200}'coupons'/)
  })
})
