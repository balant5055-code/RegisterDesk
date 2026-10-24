// RD-COUPON-SWITCH-01 — every path that APPLIES a coupon code goes through validateCoupon, and
// validateCoupon checks both switches first. A route that priced a code without it would bypass the
// platform flag and the Super Admin per-event switch (the platform flag used to be checked by the
// preview route alone — checkout and the fee preview bypassed it).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const APPLYING_ROUTES = [
  'app/api/registrations/validate-coupon/route.ts',
  'app/api/registrations/fee-preview/route.ts',
  'app/api/registrations/create-order/route.ts',
  'app/api/registrations/submit/route.ts',
]

describe('RD-COUPON-SWITCH-01 · coupon switches are enforced at the single chokepoint', () => {
  it('validateCoupon checks both switches BEFORE reading any coupon', () => {
    const v = read('lib/coupons/validate.ts')
    const gate = v.indexOf('await couponsAllowedForEvent(eventSlug)')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(v.indexOf(".collection('coupons')"))
    expect(v).toContain('if (!allowed.ok) return { valid: false, error: allowed.error }')
  })

  it('the gate reads the platform flag AND the event switch, and fails closed', () => {
    const g = read('lib/coupons/eventCouponSwitch.ts')
    expect(g).toContain('if (!flags.coupons) return')
    expect(g).toContain('if (ev.disabled)    return')
    expect(g).toMatch(/catch \{\s+return \{ ok: false/)
  })

  it.each(APPLYING_ROUTES)('%s applies codes only through validateCoupon', p => {
    const s = read(p)
    expect(s).toContain("from '@/lib/coupons/validate'")
    expect(s).toMatch(/validateCoupon\(/)
    // never prices a code by reading the coupons subcollection itself
    expect(s).not.toMatch(/collection\('coupons'\)/)
  })

  it('the switch lives in its own server-only document, written only by the Super Admin route', () => {
    const route = read('app/api/admin/events/[slug]/coupons/route.ts')
    expect(route).toContain('await requireSuperAdmin(req)')
    expect(route).toContain('parseFinancialReason(body.reason)')
    expect(route).toContain('stageAdminAudit(tx,')
    expect(read('lib/coupons/eventCouponSwitch.ts')).toContain("export const EVENT_ADMIN_CONTROLS = 'eventAdminControls'")
  })

  it('the organizer cannot CREATE a coupon while the event switch is off (server + both UI entry points)', () => {
    const route = read('app/api/organizer/events/[eventId]/coupons/route.ts')
    const post  = route.slice(route.indexOf('export async function POST'))
    const gate  = post.indexOf('await getEventCouponSwitch(slug)')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(post.indexOf('.add({'))                        // checked before any write
    expect(post).toContain("if (!couponSwitch) return err(")                     // unreadable ⇒ refused
    expect(post).toContain("code: 'COUPONS_DISABLED_FOR_EVENT' }, { status: 403 }")

    const tab = read('app/(dashboard)/dashboard/events/[eventId]/tabs/CouponsTab.tsx')
    // the empty state (no coupons yet) must not offer "Create the first coupon" while switched off
    const empty = tab.slice(tab.indexOf('id="coupons-empty"'), tab.indexOf('Create the first coupon <ArrowRight'))
    expect(empty).toContain('{couponsDisabledForEvent ? (')
    expect(empty).toContain('RegisterDesk has switched coupons off for this event')
    // the list toolbar hides "New coupon" too
    expect(tab).toContain('{!adding && !editingId && !couponsDisabledForEvent && (')
  })
})
