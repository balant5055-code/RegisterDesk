// RD-REG-COUPON — how a registration's price is explained to the organizer.
//
// ═══ THE DEFECT ══════════════════════════════════════════════════════════════
// The drawer rendered its whole payment block behind `hasPaymentRecord(reg)`, which is
// `amount > 0 || paymentId`. A coupon that takes a registration to ₹0 satisfies NEITHER: the
// amount is zero, and a free registration never reaches Razorpay so it has no payment id.
// Every coupon row — code, original amount, discount — therefore collapsed into the string
// "No payment required", in precisely the case the organizer most needed to read it. The data
// was on the client the whole time; a display gate hid it.
//
// ═══ THE PROPERTY THAT MATTERS MOST ══════════════════════════════════════════
// Everything shown is derived from what the registration STORED at registration time. The
// coupon document is never read, so editing or deleting a coupon cannot rewrite the history
// of an old registration. That is pinned by test, not by convention.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { summarizePricing, couponCellText, formatPaise } from '@/lib/registrations/couponDisplay'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

// ─────────────────────────────────────────────────────────────────────────────
describe('the four pricing cases are distinguishable', () => {
  it('CASE A — ordinary paid registration, no coupon', () => {
    const s = summarizePricing({ amount: 50000, paymentStatus: 'paid' })
    expect(s.kind).toBe('paid')
    expect(s.hasCoupon).toBe(false)
    expect(s.couponCode).toBeNull()
    expect(s.discountPaise).toBe(0)
    expect(s.originalPaise).toBe(50000)
    expect(s.finalPaise).toBe(50000)
    expect(s.label).toBe('No discount')
  })

  it('CASE B — a coupon takes the registration to zero', () => {
    const s = summarizePricing({
      amount: 0, originalAmount: 50000, discountAmount: 50000,
      couponCode: 'WELCOME500', paymentStatus: 'not_required',
    })
    expect(s.kind).toBe('free_by_coupon')
    expect(s.couponCode).toBe('WELCOME500')
    expect(s.originalPaise).toBe(50000)
    expect(s.discountPaise).toBe(50000)
    expect(s.finalPaise).toBe(0)
    expect(s.label).toBe('Free after coupon')
  })

  it('CASE C — genuinely free event, no coupon involved', () => {
    const s = summarizePricing({ amount: 0, paymentStatus: 'not_required' })
    expect(s.kind).toBe('free_event')
    expect(s.hasCoupon).toBe(false)
    expect(s.label).toBe('Free registration')
  })

  it('CASE D — coupon partially discounts', () => {
    const s = summarizePricing({
      amount: 40000, originalAmount: 50000, discountAmount: 10000,
      couponCode: 'EARLY100', paymentStatus: 'paid',
    })
    expect(s.kind).toBe('discounted')
    expect(s.originalPaise).toBe(50000)
    expect(s.discountPaise).toBe(10000)
    expect(s.finalPaise).toBe(40000)
    expect(s.label).toBe('₹100 off')
  })

  it('B and C are NOT the same value — the exact confusion being fixed', () => {
    const byCoupon = summarizePricing({ amount: 0, originalAmount: 50000, discountAmount: 50000, couponCode: 'X' })
    const genuine  = summarizePricing({ amount: 0 })
    expect(byCoupon.kind).not.toBe(genuine.kind)
    expect(byCoupon.label).not.toBe(genuine.label)
  })
})

describe('the coupon type is irrelevant to what is displayed', () => {
  // The registration stores only the resulting money, never the coupon's type. A 10% coupon
  // and a ₹50 coupon that both removed ₹50 are indistinguishable here — correctly so, since
  // the type could only be recovered from the live coupon document.
  it('a percentage coupon is reported by its actual money value', () => {
    const s = summarizePricing({ amount: 45000, originalAmount: 50000, discountAmount: 5000, couponCode: 'TEN' })
    expect(s.discountPaise).toBe(5000)
    expect(s.label).toBe('₹50 off')
  })

  it('a fixed coupon of the same value reads identically', () => {
    const s = summarizePricing({ amount: 45000, originalAmount: 50000, discountAmount: 5000, couponCode: 'FLAT50' })
    expect(s.label).toBe('₹50 off')
  })
})

describe('legacy and partial records degrade sensibly', () => {
  it('a discount with no stored originalAmount reconstructs it from final + discount', () => {
    const s = summarizePricing({ amount: 40000, discountAmount: 10000, couponCode: 'OLD' })
    expect(s.originalPaise).toBe(50000)
  })

  it('a code with no discount still counts as a coupon', () => {
    const s = summarizePricing({ amount: 50000, couponCode: 'TRACKED' })
    expect(s.hasCoupon).toBe(true)
    expect(s.kind).toBe('discounted')
  })

  it('a discount with no code still counts as a coupon', () => {
    const s = summarizePricing({ amount: 40000, discountAmount: 10000 })
    expect(s.hasCoupon).toBe(true)
    expect(s.couponCode).toBeNull()
  })

  it('blank / whitespace codes are treated as absent, not printed', () => {
    expect(summarizePricing({ amount: 50000, couponCode: '   ' }).couponCode).toBeNull()
    expect(summarizePricing({ amount: 50000, couponCode: '' }).hasCoupon).toBe(false)
  })

  it('missing, null and NaN amounts never produce NaN output', () => {
    for (const reg of [{}, { amount: null }, { amount: Number.NaN }, { amount: 0, discountAmount: null }]) {
      const s = summarizePricing(reg)
      expect(Number.isFinite(s.finalPaise)).toBe(true)
      expect(Number.isFinite(s.originalPaise)).toBe(true)
      expect(Number.isFinite(s.discountPaise)).toBe(true)
      expect(s.label).not.toMatch(/NaN|undefined|null/)
    }
  })

  it('a negative discount is clamped rather than shown as a surcharge', () => {
    expect(summarizePricing({ amount: 50000, discountAmount: -100 }).discountPaise).toBe(0)
  })
})

describe('currency formatting', () => {
  it('formats whole rupees without decimals and paise with them', () => {
    expect(formatPaise(50000)).toBe('₹500')
    expect(formatPaise(50050)).toBe('₹500.50')
    expect(formatPaise(0)).toBe('₹0')
  })

  it('groups in the Indian system', () => {
    expect(formatPaise(1_00_00_000)).toBe('₹1,00,000')
  })
})

describe('the table cell stays quiet unless there is something to say', () => {
  it('an ordinary paid registration renders nothing', () => {
    expect(couponCellText({ amount: 50000, paymentStatus: 'paid' })).toBeNull()
  })

  it('a coupon shows the code and the money off', () => {
    const cell = couponCellText({ amount: 40000, originalAmount: 50000, discountAmount: 10000, couponCode: 'EARLY100' })
    expect(cell).toEqual({ code: 'EARLY100', note: '₹100 off' })
  })

  it('a coupon-funded free registration reads Free with its code', () => {
    const cell = couponCellText({ amount: 0, originalAmount: 50000, discountAmount: 50000, couponCode: 'WELCOME500' })
    expect(cell).toEqual({ code: 'WELCOME500', note: 'Free' })
  })

  it('a genuinely free registration reads Free with no code', () => {
    expect(couponCellText({ amount: 0 })).toEqual({ code: null, note: 'Free' })
  })
})

// ── HISTORICAL CORRECTNESS ──────────────────────────────────────────────────
describe('history is never recalculated from current coupon configuration', () => {
  // Comments are stripped first: the header deliberately DOCUMENTS that it touches no
  // Firebase and stores no coupon type, and that prose is worth keeping. What must never
  // appear is an actual import or field.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('MUTATION: the module cannot read a coupon document — it has no Firebase import', () => {
    const code = strip(read('lib/registrations/couponDisplay.ts'))
    expect(code).not.toMatch(/firebase|firestore|adminDb|getDoc|collection\(/i)
  })

  it('the function accepts ONLY stored registration fields — a coupon doc cannot be passed in', () => {
    // If the input shape ever grew a coupon type/value field, today's configuration could
    // leak into a historical row. The interface is the guard.
    const code  = strip(read('lib/registrations/couponDisplay.ts'))
    const iface = code.slice(code.indexOf('export interface PricingInput'), code.indexOf('export type PricingKind'))
    expect(iface).toMatch(/amount\?/)                                   // not vacuously empty
    expect(iface).not.toMatch(/\b(type|value|currentUses|maxUses|description)\b/)
  })

  it('two registrations with identical stored values render identically, whatever the coupon is now', () => {
    const a = summarizePricing({ amount: 40000, originalAmount: 50000, discountAmount: 10000, couponCode: 'SAME' })
    const b = summarizePricing({ amount: 40000, originalAmount: 50000, discountAmount: 10000, couponCode: 'SAME' })
    expect(a).toEqual(b)
  })

  it('the drawer reads the stored discount, never a recomputed one', () => {
    const client = read('app/(dashboard)/dashboard/events/[eventId]/registrations/RegistrationsClient.tsx')
    // No percentage arithmetic against a coupon value anywhere in the drawer.
    expect(client).not.toMatch(/coupon\.(value|type)|currentUses|applicablePassIds/)
  })
})

// ── UI WIRING ───────────────────────────────────────────────────────────────
describe('the drawer surfaces coupon facts outside the payment gate', () => {
  const client = read('app/(dashboard)/dashboard/events/[eventId]/registrations/RegistrationsClient.tsx')

  it('the coupon section renders INDEPENDENTLY of hasPaymentRecord', () => {
    const couponAt = client.indexOf('pricing.hasCoupon')
    const gateAt   = client.indexOf('hasPaymentRecord(reg) ? (')
    expect(couponAt).toBeGreaterThan(-1)
    expect(couponAt).toBeLessThan(gateAt)          // appears before the payment gate…

    // …and, decisively, its own condition must not depend on the gate. Position alone is not
    // enough: re-adding `&& hasPaymentRecord(reg)` to this condition would restore the exact
    // production bug while leaving the ordering intact.
    const condition = client.slice(couponAt, client.indexOf('(', couponAt) + 1)
    expect(condition).not.toMatch(/hasPaymentRecord/)
  })

  it('the free branch states WHY it is free', () => {
    expect(client).toMatch(/Free after coupon/)
    expect(client).toMatch(/Free registration/)
  })

  it('still renders payment id and order id for reconciliation', () => {
    expect(client).toMatch(/Razorpay Payment ID/)
    expect(client).toMatch(/Razorpay Order ID/)
  })

  it('the discount column derives from the already-loaded row — no per-row query', () => {
    expect(client).toMatch(/couponCellText\(reg\)/)
    // The requirement is that RENDERING A ROW issues no request. A single mount-time fetch
    // for the coupon-filter dropdown is legitimate and deliberately bounded, so the check is
    // scoped to the table body rather than to the whole file.
    const body = client.slice(client.indexOf('{visible.map(reg =>'), client.indexOf('</tbody>'))
    expect(body).not.toMatch(/fetch\(|await /)
  })

  it('custom form responses are still rendered with their configured labels', () => {
    expect(client).toMatch(/fieldLabels\[id\] \?\? id/)
  })

  it('hasPaymentRecord itself is unchanged — the CSV export depends on it', () => {
    const pd = read('lib/registrations/paymentDisplay.ts')
    expect(pd).toMatch(/return \(typeof reg\.amount === 'number' && reg\.amount > 0\) \|\| Boolean\(reg\.paymentId\)/)
  })
})

describe('no new reads, no new endpoint, no weakened access', () => {
  const route = read('app/api/organizer/events/[eventId]/registrations/route.ts')

  it('the list route still authorizes the workspace and verifies ownership', () => {
    expect(route).toMatch(/authorizeWorkspace\(/)
    expect(route).toMatch(/users\/\$\{uid\}\/eventDrafts\/\$\{eventId\}/)
  })

  it('the list route was not modified to fetch coupons', () => {
    expect(route).not.toMatch(/coupons/)
  })

  it('pagination remains cursor-based and bounded', () => {
    expect(route).toMatch(/\.limit\(pageSize \+ 1\)/)
    expect(route).toMatch(/startAfter\(cursorDoc\)/)
  })
})
