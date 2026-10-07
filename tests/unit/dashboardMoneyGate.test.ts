// RD-DASH-12 · The finance permission gate, asserted as an INVARIANT.
//
// ═══ WHY THIS FILE EXISTS BESIDE dashboardFinanceGate.test.ts ════════════════
// That suite proves the gate exists and names three fields it covers: `settlement`,
// `walletBalancePaise`, `totalRevenuePaise`. All three were and are correct.
//
// An enumeration only defends the items in it. Between RD-DASH-02 and RD-DASH-07 four more
// money surfaces were added to this payload and none of them joined the list, so all four
// shipped outside the gate. Measured against production, a role holding no `transactions`
// permission received:
//
//   fees.netPayoutPaise                     ₹3,34,011   — and the tile RENDERED it
//   fees.platformFeePaise / gatewayFeePaise / gatewayTaxPaise / totalFeesPaise
//   passDistribution[].salesPaise           ₹1,18,973   — rendered as "Ticket sales"
//   couponPerformance.totalDiscountPaise    ₹8,50,086   — rendered as "Discount given"
//   events[].revenuePaise                   ₹3,44,737   — payload only
//
// `admin` and `manager` are ordinary organizer roles that hold no finance permission and
// pass this endpoint's authorization, so this was reachable by design, not by accident.
//
// The guards below therefore assert the RULE — every money-shaped key in the response type
// is either inside the gated block or explicitly accounted for here — so the next money
// field to be added fails this file until someone decides which side of the gate it is on.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROLE_PERMISSIONS, type TeamRole } from '@/lib/team/types'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments are prose ABOUT the rule; they must never satisfy or break a guard. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROUTE_RAW = read('app/api/organizer/dashboard/route.ts')
const ROUTE     = strip(ROUTE_RAW)
const PAGE      = strip(read('app/(dashboard)/dashboard/page.tsx'))
const COUPONS   = strip(read('lib/analytics/couponPerformance.ts'))
const COUPON_UI = strip(read('components/dashboard/CouponPanel.tsx'))

/** The one block money is allowed to live in. */
function gatedBlock(src: string): string {
  /** The balanced `{ … }` that follows a `...(financeAllowed ? ` at `at`. */
  const blockAt = (at: number): string => {
    const open = src.indexOf('{', at + '...(financeAllowed ?'.length)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1) }
    }
    throw new Error('unbalanced financeAllowed block')
  }
  // The MONEY block, identified by its CONTENTS — `deltas` carries its own smaller
  // `...(financeAllowed ? { revenue })` spread a few lines above, and a positional
  // "first match" or a fixed look-ahead window both pick that one instead.
  for (let i = src.indexOf('...(financeAllowed ? {'); i > -1; i = src.indexOf('...(financeAllowed ? {', i + 1)) {
    const b = blockAt(i)
    if (b.includes('settlement:')) return b
  }
  throw new Error('no financeAllowed block containing `settlement:`')
}

describe('RD-DASH-12 · the money gate is an invariant, not a list', () => {
  it('roles that can open the dashboard but hold no finance permission genuinely exist', () => {
    // If this ever became empty the gate would be theoretical and every guard below moot.
    const exposed = (Object.keys(ROLE_PERMISSIONS) as TeamRole[])
      .filter(r => !ROLE_PERMISSIONS[r].includes('transactions'))
      .filter(r => ROLE_PERMISSIONS[r].length > 1 || ROLE_PERMISSIONS[r][0] !== 'checkin')
    expect(exposed).toContain('admin')
    expect(exposed).toContain('manager')
  })

  it('`fees` is inside the gated block, not beside it', () => {
    const gated = gatedBlock(ROUTE)
    expect(gated).toMatch(/^\s*fees,\s*$/m)
    // …and the response type must not promise it unconditionally, or the client would be
    // free to render it without checking.
    expect(ROUTE).toMatch(/fees\?:\s*DashboardFees/)
    expect(ROUTE).not.toMatch(/^\s*fees:\s+DashboardFees\s*$/m)
  })

  it('the Fees & payout tile is not rendered without the permission', () => {
    expect(PAGE).toMatch(/finance\.allowed && data\.fees/)
    // The restricted state must be the SAME affordance the revenue tiles use — a lock, not
    // a zero and not a blank space where a card used to be.
    expect(PAGE).toMatch(/label="Fees & payout"[\s\S]{0,200}restricted/)
    // Rendered in exactly ONE place, and that place is behind the guard.
    expect(PAGE.match(/<FeesPayoutTile/g)?.length).toBe(1)
    expect(PAGE).toMatch(/finance\.allowed && data\.fees[\s\S]{0,120}<FeesPayoutTile/)
  })

  it('per-pass ticket money is not aggregated for a restricted caller', () => {
    // Gating the READ is what makes `salesPaise` null, which is what makes the panel omit
    // its money rows. Filtering after the fact would still have spent the aggregates.
    // RD-DASH-13 · the gate still wraps the whole per-pass VALUE pass; what it now wraps
    // is the budget PLAN, and the reads that plan authorises. A restricted caller still
    // never issues one, which is the property this guards.
    expect(ROUTE).toMatch(/if \(financeAllowed\) \{[\s\S]{0,600}valuePlan\.push\(slug\)/)
    expect(ROUTE).toContain('mapWithConcurrency(valuePlan, EVENT_CONCURRENCY')
  })

  it('the coupon discount total is gated, and says PERMISSION rather than missing index', () => {
    expect(ROUTE).toMatch(/\{ scoped, slug: selectedSlug, financeAllowed \}/)
    expect(COUPONS).toMatch(/scope\.financeAllowed === false/)
    expect(COUPONS).toMatch(/discountRestricted\s*=\s*true/)
    // The two states must stay distinguishable in the contract AND on screen.
    expect(COUPONS).toMatch(/discountRestricted\?:\s*boolean/)
    expect(COUPON_UI).toContain('Not available to your role')
    expect(COUPON_UI).toMatch(/discountRestricted \?/)
  })

  it('per-event revenue is null for a restricted caller, never zero', () => {
    // RD-ANALYTICS-12-21 · the gate moved but did NOT weaken. It used to be an inline
    // ternary in the response literal; it is now a state derivation, because that inline
    // `?? 0` also turned an UNMEASURED figure into a measured-looking zero (F1). The
    // invariant this case defends is unchanged and is asserted at its new home.
    // RD-ANALYTICS-12-25 · the field this invariant is about now carries its canonical name;
    // the deprecated `revenuePaise` alias was removed. Same gate, same field, same rule.
    expect(ROUTE).toMatch(/confirmedRevenuePaise:\s*number \| null/)
    // `financeAllowed` still decides this field, and still before the value is shaped.
    expect(ROUTE).toContain('revenueStateFromCounterMap(revBySlug, slug, financeAllowed)')

    // The denial branch still ends in null, never 0 — now provable in one pure function
    // instead of inferred from the tail of a ternary.
    const STATE = readFileSync(resolve(process.cwd(), 'lib/finance/revenueState.ts'), 'utf8')
    expect(STATE).toMatch(/if \(!financeAllowed\) return revenueWithheld\(\)/)
    expect(STATE).toMatch(/reason === 'unauthorized'\s*\n?\s*\?\s*\{ revenuePaise: null/)
    // And an unauthorized caller is never given the failure flag, which would say the
    // platform broke when it simply refused.
    expect(STATE).toMatch(/revenuePaise: null,\s*revenueUnavailable: false/)
  })

  it('no money-shaped key sits outside the gate in the response literal', () => {
    // The response object literal, minus the gated block: nothing in it may look like money.
    const gated = gatedBlock(ROUTE)
    const start = ROUTE.indexOf('const data: DashboardData = {')
    expect(start).toBeGreaterThan(-1)
    const literal  = ROUTE.slice(start, ROUTE.indexOf('return NextResponse.json(data)'))
    const ungated  = literal.replace(gated, '')
    const suspects = [...ungated.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9_]*)\s*[:,]/gm)].map(m => m[1])
    const money    = suspects.filter(k => /paise|revenue|payout|settlement|fee|wallet|discount/i.test(k))
    // `couponPerformance` and `passDistribution` carry money INSIDE them, but the route now
    // withholds those figures at the source, so the containers themselves stay ungated.
    expect(money).toEqual([])
  })
})

describe('RD-DASH-12 · a failed attendance fold is not an unavailable event', () => {
  it('only the waitlist read can make an event breakdown unavailable', () => {
    // Measured: failing ONE attendanceShards read took registrationTotals.confirmed to 0 and
    // emptied Registration Status, Pass Distribution and Event Performance — while the
    // Confirmed-registrations KPI, fed from a different source, kept its real value.
    // RD-DASH-13 · narrowed AGAIN, and for the same reason. RD-DASH-12 stopped a shard
    // failure from nulling the event; this phase stops the WAITLIST failure from doing it
    // too. `waitlisted` and `total` carry their own null now, so confirmed, pending,
    // cancelled and rejected — all read from the counter document — survive intact.
    expect(ROUTE).not.toMatch(/if \(waitlisted === null\) \{ eventStatus\.set\(slug, null\); return \}/)
    expect(ROUTE).not.toMatch(/if \(waitlisted === null \|\| shards === null\)/)
    expect(ROUTE).toMatch(/total: waitlisted === null \? null :/)
    const AN = strip(read('lib/analytics/dashboardAnalytics.ts'))
    expect(AN).toMatch(/waitlisted: number \| null/)
    expect(AN).toMatch(/totals\.waitlisted = null/)
  })

  it('the route folds nothing — the card owns the only fold left', () => {
    // RD-DASH-13 · `eventStatus.checkedIn` is gone (nothing read it), so the route stopped
    // folding entirely and stopped paying one attendanceShards read per event for it.
    // ONE read survives, for the selected event, consumed by the Check-in card.
    expect(ROUTE).not.toMatch(/foldAttendanceShards\(/)
    expect(ROUTE.match(/getAttendanceShardSums\(/g)?.length).toBe(1)
    expect(ROUTE).toContain('const shardSlugs = scoped && selectedSlug ? [selectedSlug] : []')
  })

  it('the Check-in card still reports unavailable for that same failure', () => {
    // The card is the ONLY surface that renders check-ins, and it is fed separately — which
    // is why the breakdowns no longer need to be sacrificed to disclose the failure.
    const ADMIN = strip(read('lib/dashboard/checkInStatusAdmin.ts'))
    expect(ADMIN).toMatch(/if \(shards === null\) return \{ \.\.\.EMPTY_CHECK_IN, state: 'unavailable' \}/)
  })
})

describe('RD-DASH-12 · a malformed eventId is refused, not thrown', () => {
  it('validates the id as a document name before building a path with it', () => {
    expect(ROUTE).toMatch(/const validDocId = \(id: string\)/)
    expect(ROUTE).toMatch(/!id\.includes\('\/'\)/)
    expect(ROUTE).toMatch(/requestedEventId !== null && !validDocId\(requestedEventId\)/)
    // Refused with the SAME answer an unknown id gets, so the response cannot be used to
    // tell "does not exist" from "is not a legal id".
    const guard = ROUTE.slice(ROUTE.indexOf('!validDocId(requestedEventId)'))
    expect(guard.slice(0, 300)).toContain('EVENT_NOT_IN_WORKSPACE')
    expect(guard.slice(0, 300)).toContain('status: 404')
  })

  it('the check happens BEFORE the document read it protects', () => {
    const guardAt = ROUTE.indexOf('!validDocId(requestedEventId)')
    const readAt  = ROUTE.indexOf('adminDb.doc(`users/${uid}/eventDrafts/${requestedEventId}`)')
    expect(guardAt).toBeGreaterThan(-1)
    expect(readAt).toBeGreaterThan(guardAt)
  })
})
