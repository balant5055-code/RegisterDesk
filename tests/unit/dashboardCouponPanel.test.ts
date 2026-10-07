// RD-DASH-07 · Coupon performance — definitions, states, limits and the card that shows them.
//
// ═══ THE AUDIT THIS SUITE ENCODES ════════════════════════════════════════════
// The card showed four figures. Two were wrong and one could not be computed at all:
//
//   "16 coupons"      correct — the coupon documents.
//   "1,826 redemptions" correct — Σ currentUses, the counter the validator enforces.
//   "16 active"       WRONG. It counted `active !== false`, ONE of the validator's four
//                     gates. Every coupon on the audited event was `active: true` AND past
//                     its `validUntil`, so the card claimed sixteen usable codes on a day
//                     the validator would have refused all sixteen.
//   "Discount —"      the sum() aggregate had no composite index, so it threw on every load.
//                     Correctly rendered as a dash rather than ₹0; the index was never
//                     declared, so the dash was permanent.
//
// And two silent ones behind them:
//   • `percentUsed` was clamped to 100, erasing coupons genuinely past a lowered cap.
//   • the organizer-wide discount aggregate had NO event filter, so in event mode it would
//     have shown one event's coupons above the whole workspace's discount.
//
// Arithmetic and state are exercised through the PURE functions; rendering rules are
// asserted at source level. Nothing here encodes a real workspace, event, code or total.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The analytics module imports the admin SDK for its reader half; these tests exercise the
// pure half, so the SDK is doubled rather than booted.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  resolveCouponState, couponToday, COUPON_STATE_LABEL, COUPON_STATE_ORDER,
} from '@/lib/coupons/couponState'
import {
  toPerformanceRow, rankCouponRows, countCouponStates, EMPTY_STATE_COUNTS,
  EMPTY_ORGANIZER_COUPON_PERFORMANCE,
} from '@/lib/analytics/couponPerformance'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments carry the audit's prose, including words the CODE must not use. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const STATE  = read('lib/coupons/couponState.ts')
const VALID  = read('lib/coupons/validate.ts')
const PERF   = read('lib/analytics/couponPerformance.ts')
const PANEL  = read('components/dashboard/CouponPanel.tsx')
const PAGE   = read('app/(dashboard)/dashboard/page.tsx')
const ROUTE  = read('app/api/organizer/dashboard/route.ts')
const TOKENS = read('styles/tokens.css')
const INDEXES = JSON.parse(read('firestore.indexes.json')) as {
  indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[]
}

const TODAY = '2026-06-15'

// ═══ 1 · the redemption definition ═══════════════════════════════════════════

describe('a redemption is the coupon\'s own counter, and the card says so', () => {
  it('uses come from currentUses, never from a registration scan', () => {
    expect(toPerformanceRow({ code: 'A', currentUses: 84 }, TODAY).uses).toBe(84)
    // The module reads coupon documents and ONE aggregate. A registration scan here is what
    // it was built to remove — it capped at 5,000 docs and under-reported silently.
    expect(strip(PERF)).not.toMatch(/\.limit\(\s*\d+\s*\)/)
    expect(strip(PERF)).not.toMatch(/couponCode/)
  })

  it('the counter is never decremented, so cancelled and refunded still count', () => {
    // This is the PRODUCT definition, not a choice made here: `currentUses` is what the
    // validator checks against `maxUses`, so "300 / 300 used" has to agree with what the
    // 301st attempt will be refused for. It is NOT "300 live registrations hold this code".
    expect(PERF).toMatch(/NEVER decremented|never decremented/i)
    expect(PERF).toContain('the same number the validator checks')
  })

  it('a missing, zero or negative counter degrades to zero, never NaN', () => {
    for (const c of [{ code: 'A' }, { code: 'B', currentUses: 0 }, { code: 'C', currentUses: -5 }]) {
      const r = toPerformanceRow(c, TODAY)
      expect(r.uses).toBe(0)
      expect(Number.isFinite(r.uses)).toBe(true)
    }
  })
})

// ═══ 2 · state mirrors the validator ═════════════════════════════════════════

describe('coupon state is the validator\'s answer, not a new vocabulary', () => {
  const base = { active: true, currentUses: 0, maxUses: undefined, validFrom: undefined, validUntil: undefined }

  it('each gate produces its own state', () => {
    expect(resolveCouponState({ ...base, active: false }, TODAY)).toBe('inactive')
    expect(resolveCouponState({ ...base, validFrom: '2026-12-01' }, TODAY)).toBe('scheduled')
    expect(resolveCouponState({ ...base, validUntil: '2026-01-01' }, TODAY)).toBe('expired')
    expect(resolveCouponState({ ...base, maxUses: 10, currentUses: 10 }, TODAY)).toBe('exhausted')
    expect(resolveCouponState(base, TODAY)).toBe('redeemable')
  })

  it('the gates are applied in the validator\'s ORDER, because the order decides the answer', () => {
    // Expired AND at its cap ⇒ "expired", since that is the error the attendee would meet.
    expect(resolveCouponState({ ...base, validUntil: '2026-01-01', maxUses: 5, currentUses: 5 }, TODAY))
      .toBe('expired')
    // Switched off beats everything.
    expect(resolveCouponState({ ...base, active: false, validUntil: '2026-01-01' }, TODAY))
      .toBe('inactive')
  })

  it('the ORDER matches lib/coupons/validate.ts — pinned, not assumed', () => {
    // If the validator's precedence changes and this module does not follow, the card starts
    // reporting a different refusal reason than the attendee is shown. That must fail here.
    const gateOrder = (src: string) =>
      [...strip(src).matchAll(/\b(active|validFrom|validUntil|maxUses)\b/g)]
        .map(m => m[1])
        .filter((g, i, a) => a.indexOf(g) === i)
    expect(gateOrder(STATE.slice(STATE.indexOf('export function resolveCouponState'))))
      .toEqual(gateOrder(VALID.slice(VALID.indexOf('if (!coupon.active)'))))
  })

  it('a coupon exactly AT its cap is already spent', () => {
    // `>=`, matching the validator: it refuses the redemption that would take it to the cap.
    expect(resolveCouponState({ ...base, maxUses: 10, currentUses: 10 }, TODAY)).toBe('exhausted')
    expect(resolveCouponState({ ...base, maxUses: 10, currentUses: 9 }, TODAY)).toBe('redeemable')
    expect(VALID).toContain('coupon.currentUses >= coupon.maxUses')
    expect(STATE).toContain('c.currentUses >= c.maxUses')
  })

  it('an unlimited coupon can never be exhausted', () => {
    expect(resolveCouponState({ ...base, maxUses: undefined, currentUses: 99999 }, TODAY)).toBe('redeemable')
  })

  it('the date is the validator\'s UTC calendar day, taken as a parameter', () => {
    // A clock inside a pure function is untestable; a DIFFERENT clock from the validator's
    // makes the card disagree with enforcement on exactly the coupons expiring tonight.
    expect(couponToday(new Date('2026-06-15T23:30:00Z'))).toBe('2026-06-15')
    expect(VALID).toContain("new Date().toISOString().slice(0, 10)")
    expect(STATE).toContain("now.toISOString().slice(0, 10)")
    expect(strip(STATE)).not.toMatch(/Date\.now\(\)|new Date\(\)/)
  })

  it('every state has exactly one label, and the card uses it', () => {
    for (const s of COUPON_STATE_ORDER) expect(COUPON_STATE_LABEL[s]).toBeTruthy()
    expect(new Set(Object.values(COUPON_STATE_LABEL)).size).toBe(COUPON_STATE_ORDER.length)
    expect(PANEL).toContain('COUPON_STATE_LABEL[row.state]')
    // No second wording anywhere in the component.
    expect(strip(PANEL)).not.toMatch(/'Expired'|'Inactive'|'Scheduled'/)
  })
})

// ═══ 3 · "active" is not "usable" ════════════════════════════════════════════

describe('the card reports what can actually be redeemed', () => {
  const rows = [
    toPerformanceRow({ code: 'A', currentUses: 5, active: true, validUntil: '2026-01-01' }, TODAY),
    toPerformanceRow({ code: 'B', currentUses: 5, active: true, validUntil: '2026-01-01' }, TODAY),
    toPerformanceRow({ code: 'C', currentUses: 1, active: true }, TODAY),
  ]

  it('a coupon can be active and still unusable', () => {
    expect(rows[0].active).toBe(true)
    expect(rows[0].state).toBe('expired')
  })

  it('the two figures are both exposed and never conflated', () => {
    expect(PERF).toContain('activeCoupons:     rows.filter(r => r.active).length')
    expect(PERF).toContain("redeemableCoupons: rows.filter(r => r.state === 'redeemable').length")
    // The card leads with the one an organizer can act on.
    expect(PANEL).toContain('redeemableCoupons')
    expect(strip(PANEL)).not.toMatch(/activeCoupons/)
  })

  it('the state counts tally every coupon exactly once', () => {
    const counts = countCouponStates(rows)
    expect(counts.expired).toBe(2)
    expect(counts.redeemable).toBe(1)
    expect(COUPON_STATE_ORDER.reduce((n, s) => n + counts[s], 0)).toBe(rows.length)
  })

  it('the empty tally is a fresh object, so a caller cannot corrupt the next one', () => {
    const a = EMPTY_STATE_COUNTS()
    a.expired = 99
    expect(EMPTY_STATE_COUNTS().expired).toBe(0)
  })

  it('when nothing is redeemable the card says WHY, using the dominant state', () => {
    expect(PANEL).toContain('None can be redeemed right now')
    expect(PANEL).toContain("expired:   'have expired'")
    expect(PANEL).toContain("exhausted: 'have reached their limit'")
  })
})

// ═══ 4 · limits ══════════════════════════════════════════════════════════════

describe('limits are honoured, never invented', () => {
  it('an unlimited coupon claims no denominator and no percentage', () => {
    const r = toPerformanceRow({ code: 'OPEN', currentUses: 12 }, TODAY)
    expect(r.maxUses).toBeNull()
    expect(r.remaining).toBeNull()
    expect(r.percentUsed).toBeNull()   // a share of unlimited is meaningless, not 0
    expect(r.exceeded).toBe(false)
  })

  it('maxUses of 0 is treated as unlimited, not as a cap of zero', () => {
    // A cap of zero would make every coupon instantly exhausted and divide by zero.
    const r = toPerformanceRow({ code: 'Z', currentUses: 3, maxUses: 0 }, TODAY)
    expect(r.maxUses).toBeNull()
    expect(r.percentUsed).toBeNull()
  })

  it('the percentage is the TRUE ratio, past 100 included', () => {
    expect(toPerformanceRow({ code: 'A', currentUses: 120, maxUses: 100 }, TODAY).percentUsed).toBe(120)
    expect(toPerformanceRow({ code: 'B', currentUses: 1126, maxUses: 1200 }, TODAY).percentUsed).toBe(94)
    expect(strip(PERF)).not.toMatch(/Math\.min\(100/)
  })

  it('no percentage is ever NaN, Infinity or negative', () => {
    for (const c of [
      { code: 'A', currentUses: 5, maxUses: 0 },
      { code: 'B', currentUses: -1, maxUses: 10 },
      { code: 'C', currentUses: 0, maxUses: 10 },
      { code: 'D' },
    ]) {
      const p = toPerformanceRow(c, TODAY).percentUsed
      if (p === null) continue
      expect(Number.isFinite(p)).toBe(true)
      expect(p).toBeGreaterThanOrEqual(0)
    }
  })

  it('remaining is floored at zero but the overage is still reported', () => {
    const r = toPerformanceRow({ code: 'OVER', currentUses: 130, maxUses: 100 }, TODAY)
    expect(r.remaining).toBe(0)      // a negative remaining is not a quantity
    expect(r.exceeded).toBe(true)    // …so the fact is carried by its own field
    expect(r.percentUsed).toBe(130)
  })

  it('the meter width is clamped where it is DRAWN, not at the source', () => {
    expect(PANEL).toMatch(/width: `\$\{Math\.min\(100, Math\.max\(row\.percentUsed \?\? 0/)
    // A non-zero usage always paints something, so "a few" never renders as "none".
    expect(PANEL).toContain('row.uses > 0 ? 2 : 0')
  })

  it('no meter is drawn at all without a real denominator', () => {
    expect(PANEL).toContain('{row.maxUses !== null && (')
    expect(PANEL).toContain("if (row.maxUses === null)  return 'No limit'")
    expect(PANEL).toContain("if (row.uses === 0)        return 'Unused'")
  })
})

// ═══ 5 · usage level is a separate axis from lifecycle ═══════════════════════

describe('how FULL a coupon is, and whether it WORKS, are two different questions', () => {
  it('the two are computed independently', () => {
    // A coupon can be 94% used and expired. Collapsing them is how "16 active" survived.
    expect(PANEL).toContain('type UsageLevel')
    expect(PANEL).toContain('Deliberately separate from `CouponState`')
  })

  it('an idle level covers both kinds of "nothing to show"', () => {
    expect(PANEL).toContain("if (row.maxUses === null || row.uses === 0) return 'idle'")
  })

  it('the levels are wide steps, so the card is a gauge and not a rainbow', () => {
    expect(PANEL).toContain("if (row.exceeded) return 'over'")
    expect(PANEL).toContain("if (pct >= 100) return 'exhausted'")
    expect(PANEL).toContain("if (pct >= 75)  return 'high'")
    expect(PANEL).toContain("return 'normal'")
  })

  it('the lifecycle is written in WORDS, never left to the meter colour', () => {
    expect(PANEL).toContain('COUPON_STATE_LABEL[row.state]')
  })

  it('the state label appears only when it tells the rows apart', () => {
    // Measured in the browser: five rows each captioned "Expired", under a headline already
    // reading "16 of 16 have expired", is five repetitions of one fact.
    expect(PANEL).toContain('showState={new Set(shown.map(r => r.state)).size > 1}')
    expect(PANEL).toContain('showState ? [{ text: COUPON_STATE_LABEL[row.state]')
  })

  it('"Over limit" REPLACES "Limit reached" rather than joining it', () => {
    // A coupon past its cap has necessarily reached it; printing both says one thing twice.
    expect(PANEL).toContain("row.exceeded ? [{ text: 'Over limit', strong: true }]")
  })

  it('being over a limit survives whatever the state is, and outranks a suppressed label', () => {
    // Expired AND over is two facts; the overage is the one an organizer must not miss, so it
    // is first in the list and does not depend on `showState`.
    const notes = PANEL.slice(PANEL.indexOf('const notes:'), PANEL.indexOf('return (', PANEL.indexOf('const notes:')))
    expect(notes.indexOf('Over limit')).toBeGreaterThan(-1)
    expect(notes.indexOf('Over limit')).toBeLessThan(notes.indexOf('showState ?'))
    expect(PANEL).toContain("row.exceeded && showState && row.state !== 'exhausted'")
  })

  it('adjacent labels are separated, never run together', () => {
    // Two labels with only whitespace between them read as one phrase.
    expect(PANEL).toContain('{i > 0 && <span aria-hidden>·</span>}')
  })

  it('a coupon code wraps rather than truncating', () => {
    // Measured at 390px: a 25-character code needs 176px into a 171px column. A truncated
    // code is one the organizer cannot read back or type.
    expect(PANEL).toContain('break-all font-mono')
    expect(PANEL).not.toMatch(/truncate font-mono/)
  })
})

// ═══ 6 · discount ════════════════════════════════════════════════════════════

describe('discount is measured or it is absent — never zero', () => {
  it('the aggregate sums the registration\'s own discountAmount and nothing else', () => {
    expect(PERF).toContain("AggregateField.sum('discountAmount')")
    // Coupon analytics stays independent of finance: no gateway, platform, refund or wallet
    // figure may enter this number.
    for (const forbidden of [
      /gatewayFee/, /platformFee/, /netSettlement/, /refundAmount/, /refundsPaise/,
      /walletBalance/, /organizerPayable/,
    ]) expect(PERF).not.toMatch(forbidden)
  })

  it('a failed aggregate is flagged, never defaulted to a rupee value', () => {
    expect(PERF).toContain('discountUnavailable = true')
    expect(PANEL).toContain('discountUnavailable ? (')
    expect(PANEL).toMatch(/>\s*Unavailable\s*</)
    expect(PANEL).not.toMatch(/discountUnavailable\s*\?\s*(0|'₹0')/)
  })

  it('the aggregation index carries the SUMMED field, in both scopes', () => {
    // The RD-FIN-13 rule. Without it the query throws FAILED_PRECONDITION and the total is
    // permanently unavailable — which is exactly why the card showed a dash.
    const shapes = INDEXES.indexes
      .filter(i => i.collectionGroup === 'registrations')
      .map(i => i.fields.map(f => f.fieldPath).join(','))
    expect(shapes).toContain('organizerUid,discountAmount')
    expect(shapes).toContain('organizerUid,eventSlug,discountAmount')
  })

  it('money stays secondary to the redemption activity above it', () => {
    // This is an analytics card, not the finance page.
    const impact = PANEL.indexOf('{n(totalRedemptions)}')
    const money  = PANEL.indexOf('Discount given')
    expect(impact).toBeGreaterThan(-1)
    expect(money).toBeGreaterThan(impact)
    expect(PANEL).toContain('text-fs-2xl font-semibold tabular-nums tracking-tight text-foreground')
  })
})

// ═══ 7 · scope ═══════════════════════════════════════════════════════════════

describe('the card covers the selected event and says which', () => {
  it('the discount aggregate takes the same scope as the rows', () => {
    // It had NO event filter, so one event's coupons would have sat above the workspace's
    // discount total. Invisible only because the aggregate was failing anyway.
    expect(PERF).toContain("const q = scope.slug ? base.where('eventSlug', '==', scope.slug) : base")
    expect(ROUTE).toContain('{ scoped, slug: selectedSlug }')
  })

  it('a scoped event with no slug reads NOTHING rather than the workspace', () => {
    // An event can be selected while unpublished, and an unpublished event has no slug.
    expect(PERF).toContain('if (scope.scoped && !scope.slug) {')
    const guard = PERF.indexOf('if (scope.scoped && !scope.slug)')
    const query = PERF.indexOf("AggregateField.sum('discountAmount')", guard)
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(query)
  })

  it('the rows follow the caller\'s event list and this module never enumerates events', () => {
    expect(PERF).toContain('const considered = events.slice(0, COUPON_EVENT_BUDGET)')
    expect(strip(PERF)).not.toMatch(/collection\('users'\)|eventDrafts/)
  })

  it('the card names its scope and its window', () => {
    expect(PANEL).toContain('{scopeLabel} · all time')
    expect(PAGE).toContain("scopeLabel={scoped && scopeName ? scopeName : 'all events'}")
  })

  it('the event name is shown per row ONLY when the card spans more than one', () => {
    // RD-DASH-15 · the SAME question, answered before the rows are capped for the wire.
    // Deriving it from a truncated `rows` would drop the per-row event label on a
    // workspace whose most-redeemed coupons happen to share one event.
    expect(PANEL).toContain('const showEvent = spansEvents')
    expect(PERF).toContain('const spansEvents  = new Set(allRows.map(r => r.eventSlug)).size > 1')
  })

  it('a truncated event set is disclosed, never silently dropped', () => {
    expect(PERF).toContain('const partial    = events.length > COUPON_EVENT_BUDGET')
    expect(PANEL).toContain("partial ? 'most recent events'")
  })
})

// ═══ 8 · ordering and top-N ══════════════════════════════════════════════════

describe('ordering answers the question the card asks', () => {
  it('ranked by redemptions, descending, with a stable tie-break', () => {
    const rows = [
      toPerformanceRow({ code: 'BBB', currentUses: 10 }, TODAY),
      toPerformanceRow({ code: 'AAA', currentUses: 10 }, TODAY),
      toPerformanceRow({ code: 'TOP', currentUses: 99 }, TODAY),
      toPerformanceRow({ code: 'ZERO', currentUses: 0 }, TODAY),
    ]
    expect(rankCouponRows(rows).map(r => r.code)).toEqual(['TOP', 'AAA', 'BBB', 'ZERO'])
  })

  it('the component does NOT re-sort — one ordering rule, in one place', () => {
    // Two orderings eventually disagree, and then the card contradicts its own footer.
    // (It does sort STATE KEYS when picking the dominant reason nothing is redeemable —
    // that is a different collection entirely, so the guard names `rows`.)
    expect(strip(PANEL)).not.toMatch(/\brows\b[^\n]*\.sort\(/)
    expect(strip(PANEL)).not.toMatch(/\bshown\b[^\n]*\.sort\(/)
    expect(PANEL).toContain('const shown = rows.slice(0, COUPON_ROWS_SHOWN)')
    // The ONE place the order is decided.
    expect(PERF).toContain('export function rankCouponRows')
  })

  it('a top-N list admits that it is one', () => {
    expect(PANEL).toContain('Top ${shown.length} by redemptions')
    // RD-DASH-15 · `rows` is capped for the wire, so it can no longer be the denominator.
    // `totalCoupons` is exact — a count() answers it — and is what the footer states.
    expect(PANEL).not.toContain('of {n(rows.length)}')
    expect(PANEL).toContain('${n(totalCoupons)} total')
  })
})

// ═══ 9 · states of the card itself ═══════════════════════════════════════════

describe('empty, unavailable and populated are all distinct', () => {
  it('no coupons is an absence, not a failure and not a zero', () => {
    expect(PANEL).toContain('totalCoupons === 0 ?')
    expect(PANEL).toContain('No coupons created yet')
    expect(EMPTY_ORGANIZER_COUPON_PERFORMANCE.totalCoupons).toBe(0)
    expect(EMPTY_ORGANIZER_COUPON_PERFORMANCE.redeemableCoupons).toBe(0)
    expect(EMPTY_ORGANIZER_COUPON_PERFORMANCE.stateCounts).toEqual(EMPTY_STATE_COUNTS())
  })

  it('coupons that exist but have never been used still render', () => {
    // Zero redemptions is a real answer, not an empty state.
    const r = toPerformanceRow({ code: 'NEW', currentUses: 0, maxUses: 100 }, TODAY)
    expect(r.uses).toBe(0)
    expect(r.percentUsed).toBe(0)
    expect(r.state).toBe('redeemable')
  })

  it('one unreadable event does not remove the other events\' coupons', () => {
    expect(PERF).toContain('rows: [] as OrganizerCouponRow[], complete: false, count: 0, uses: 0')
    expect(PERF).toContain('readFailed = true')
  })

  it('the section shell still provides loading and error states', () => {
    expect(PANEL).toContain("from '@/components/dashboard/SectionCard'")
  })
})

// ═══ 10 · accessibility ══════════════════════════════════════════════════════

describe('every figure is text, and no meaning rests on colour', () => {
  it('a row speaks the whole sentence the brief asks for', () => {
    expect(PANEL).toContain('role="group"')
    expect(PANEL).toContain('aria-label={spoken}')
    expect(PANEL).toContain('`Coupon ${row.code}`')
    expect(PANEL).toContain('${n(row.uses)} redemptions out of ${n(row.maxUses)}, ${row.percentUsed} percent used')
    expect(PANEL).toContain('no usage limit')
    expect(PANEL).toContain("row.exceeded ? 'over its limit' : ''")
  })

  it('the meter is decorative, because every figure it encodes is written beside it', () => {
    expect(PANEL).toMatch(/style=\{\{ background: TRACK \}\} aria-hidden/)
  })

  it('the code is monospaced so it can be read character by character', () => {
    expect(PANEL).toContain('font-mono')
  })

  it('the glyph carries no unique meaning', () => {
    expect(PANEL).toMatch(/<TicketPercent className="size-3.5" \/>/)
    expect(PANEL).toMatch(/accent\('pending'\)\.tile\)} aria-hidden/)
  })
})

// ═══ 11 · design system ══════════════════════════════════════════════════════

describe('the card belongs to the dashboard design system', () => {
  it('carries no inline colour — every value is a token, in both themes', () => {
    expect(PANEL).not.toMatch(/#[0-9A-Fa-f]{6}/)
    for (const l of ['normal', 'high', 'exhausted', 'over', 'idle']) {
      for (const kind of ['fill', 'tint', 'ink']) {
        expect((TOKENS.match(new RegExp('--coupon-' + l + '-' + kind + ':', 'g')) ?? []).length).toBe(2)
      }
    }
    for (const kind of ['fill', 'tint', 'ink']) {
      expect(PANEL).toContain('var(--coupon-${l}-' + kind + ')')
    }
  })

  it('the levels escalate rather than rotating — over is deeper than exhausted', () => {
    expect(TOKENS).toMatch(/--coupon-normal-fill:\s*linear-gradient\(90deg, #2563EB/)
    expect(TOKENS).toMatch(/--coupon-high-fill:\s*linear-gradient\(90deg, #F59E0B/)
    expect(TOKENS).toMatch(/--coupon-exhausted-fill:\s*linear-gradient\(90deg, #EA580C/)
    expect(TOKENS).toMatch(/--coupon-over-fill:\s*linear-gradient\(90deg, #BE123C/)
  })

  it('fills its grid track and pushes its footer to the bottom, with no fixed height', () => {
    expect(PANEL).toContain('className="h-full"')
    expect(PANEL).toContain('bodyClassName="flex flex-col"')
    expect(PANEL).toContain('flex flex-1 flex-col')
    expect(PANEL).toContain('mt-auto')
    expect(PANEL).not.toMatch(/(^|[^-])\bh-\[\d+px\]/)
  })

  it('brings no glow, shadow or blur', () => {
    expect(PANEL).not.toMatch(/shadow-|drop-shadow|blur-/)
  })
})

// ═══ 12 · safety ═════════════════════════════════════════════════════════════

describe('this card reads, and does nothing else', () => {
  const all = [STATE, PANEL, PERF]

  it('performs no Firestore write', () => {
    for (const code of all) {
      expect(code).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
      expect(code).not.toMatch(/collection\([^)]*\)\s*\.\s*add\(/)
      expect(code).not.toMatch(/runTransaction|bulkWriter|\bbatch\(\)|FieldValue/)
    }
  })

  it('changes no coupon APPLICATION logic', () => {
    // The validator is READ by a test above and imported by nothing here — this phase
    // mirrors its rules, it does not alter them.
    expect(strip(STATE)).not.toMatch(/from '\.\/validate'/)
    expect(strip(PERF)).not.toMatch(/validateCoupon|computeDiscount/)
    expect(VALID).toContain('Never increments currentUses')
  })

  it('imports no Razorpay client and carries no payment logic', () => {
    for (const code of all) {
      expect(code.toLowerCase()).not.toContain("from 'razorpay'")
      expect(code).not.toMatch(/payments\s*\.\s*(refund|capture)/)
    }
  })

  it('the state resolver is PURE — no I/O, no clock', () => {
    expect(strip(STATE)).not.toMatch(/adminDb|fetch\(|await|Date\.now/)
  })

  it('the client never value-imports the server-only analytics module', () => {
    // couponPerformance.ts imports firebase-admin; a value import drags the Admin SDK into
    // the browser bundle. Only the TYPE may cross.
    const imports = PANEL.match(/^import .*couponPerformance.*$/gm) ?? []
    expect(imports).toHaveLength(1)
    expect(imports[0].startsWith('import type ')).toBe(true)
  })

  it('hardcodes no workspace, event, coupon code or total', () => {
    for (const code of [strip(STATE), strip(PANEL), strip(PERF)]) {
      expect(code).not.toMatch(/noyyal/i)
      expect(code).not.toMatch(/SKL2949|GANAPATHY|RUNFREE/i)
      expect(code).not.toMatch(/1,?826|1,?126/)
    }
  })
})
