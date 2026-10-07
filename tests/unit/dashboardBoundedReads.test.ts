// RD-DASH-15 · the four hardening fixes, asserted as rules.
//
// Each of these existed as a real defect measured against production or the emulator:
//
//   FIX 1 · `events/{slug}/coupons.get()` had no limit. Five events carrying 2,000 coupons
//           each produced 10,000 documents and a 1,993 KB response for a card that draws
//           five rows. Bounding it must NOT make any total dishonest.
//   FIX 2 · ChartPanel was a grid item without `min-w-0`, so an unbreakable Tamil event
//           name took the page 199px wide at 390px.
//   FIX 3 · a failed coupon resolver rendered "No coupons created yet", and a failed
//           activity read rendered "No recent activity yet" — both statements about the
//           workspace made on the strength of a failed call.
//   FIX 4 · three design tokens carried 35 strings below the 4.5:1 AA target.

import { describe, it, expect, vi } from 'vitest'

// The coupon resolver imports the Admin SDK. Stubbed so this suite stays a pure
// source/contract check and never tries to parse a service-account key.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  COUPON_DOC_BUDGET, COUPON_ROWS_SERIALIZED, COUPON_EVENT_BUDGET,
  EMPTY_ORGANIZER_COUPON_PERFORMANCE,
} from '@/lib/analytics/couponPerformance'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const PERF   = strip(read('lib/analytics/couponPerformance.ts'))
const ROUTE  = strip(read('app/api/organizer/dashboard/route.ts'))
const CHARTS = strip(read('components/dashboard/DashboardCharts.tsx'))
const PANEL  = strip(read('components/dashboard/CouponPanel.tsx'))
/** Read from source rather than imported — the panel is a client component. */
const COUPON_ROWS_SHOWN = Number(PANEL.match(/COUPON_ROWS_SHOWN = (\d+)/)?.[1])
const FEED   = strip(read('lib/dashboard/activityFeed.ts'))
const CARD   = strip(read('components/dashboard/RecentActivityCard.tsx'))
const TOKENS = read('styles/tokens.css')
/**
 * The organizer-wide resolver ALONE — the only coupon reader the dashboard calls.
 *
 * `getCouponPerformance` (single event) lives in the same file and is still unbounded,
 * but RD-DASH-14's production op inventory shows it is not on the dashboard path, and
 * this phase is scoped to the four audit findings. Asserting over the whole file would
 * quietly widen that scope.
 */
const ORG = PERF.slice(PERF.indexOf('export async function getOrganizerCouponPerformance'))

// ─── FIX 1 · bounded, and still exact ────────────────────────────────────────

describe('the coupon read is bounded on BOTH axes', () => {
  it('no unbounded coupon get() remains on the dashboard path', () => {
    // The defect, exactly: `.collection('coupons')` followed by a bare `.get()`.
    expect(ORG).not.toMatch(/\.collection\('coupons'\)\s*\.get\(\)/)
    expect(ORG).toMatch(/\.limit\(COUPON_DOC_BUDGET \+ 1\)/)
  })

  it('caps documents per event as well as events', () => {
    expect(COUPON_EVENT_BUDGET).toBe(60)          // unchanged, as required
    expect(COUPON_DOC_BUDGET).toBeGreaterThan(0)
    expect(COUPON_DOC_BUDGET).toBeLessThanOrEqual(200)
    // Worst case is bounded by the product of the two, not by how many coupons exist.
    expect(COUPON_EVENT_BUDGET * COUPON_DOC_BUDGET).toBeLessThanOrEqual(6000)
  })

  it('serialises fewer rows than it reads, and more than it shows', () => {
    expect(COUPON_ROWS_SERIALIZED).toBeGreaterThan(COUPON_ROWS_SHOWN)
    expect(COUPON_ROWS_SERIALIZED).toBeLessThan(COUPON_DOC_BUDGET)
    expect(PERF).toContain('const rows = allRows.slice(0, COUPON_ROWS_SERIALIZED)')
  })

  it('takes the two headline totals from AGGREGATES, never from the truncated rows', () => {
    // This is the rule that keeps a bounded read honest: `rows.reduce` over a capped slice
    // would silently under-report both figures.
    expect(ORG).toContain('totalRedemptions:  exactUses')
    expect(ORG).toContain('totalCoupons:      exactCount')
    expect(ORG).not.toMatch(/totalRedemptions:\s+rows\.reduce/)
    expect(ORG).not.toMatch(/totalCoupons:\s+rows\.length/)
    expect(ORG).toMatch(/AggregateField\.sum\('currentUses'\)/)
    expect(ORG).toMatch(/col\.count\(\)\.get\(\)/)
  })

  it('does not add a read per coupon', () => {
    // Bounded work per EVENT: one read, plus three only when the cap bites.
    expect(PERF).not.toMatch(/for \([^)]*of (rows|allRows|coupons)\)[\s\S]{0,120}await/)
  })

  it('flags the figures a bounded read cannot answer exactly', () => {
    // stateCounts / activeCoupons / redeemableCoupons need the validator gates evaluated
    // per document; no aggregate expresses them, so past the cap they are partial.
    expect(PERF).toContain('const statesPartial = perEvent.some(e => !e.complete)')
    expect(PERF).toMatch(/statesPartial: boolean/)
    expect(PERF).toContain('stateCounts:       countCouponStates(allRows)')
  })

  it('the card refuses to turn a partial state breakdown into a claim about the whole', () => {
    expect(PANEL).toContain('if (statesPartial) return')
    expect(PANEL).toMatch(/most redeemed of \$\{n\(totalCoupons\)\} coupons/)
  })

  it('the per-row event label survives the wire cap', () => {
    expect(PERF).toContain('const spansEvents  = new Set(allRows.map(r => r.eventSlug)).size > 1')
    expect(PANEL).toContain('const showEvent = spansEvents')
  })

  it('the read stays inside its event scope and its organizer', () => {
    // Unchanged by this phase: the caller supplies the slug list, and the discount
    // aggregate is always organizer-filtered.
    expect(PERF).toContain("adminDb.collection('events').doc(ev.slug).collection('coupons')")
    expect(PERF).toMatch(/\.where\('organizerUid', '==', organizerUid\)/)
    expect(PERF).toContain('const considered = events.slice(0, COUPON_EVENT_BUDGET)')
  })

  it('the first read is UNORDERED, so a coupon missing currentUses cannot vanish', () => {
    // `orderBy` excludes documents lacking the field. `toPerformanceRow` still defends
    // against a legacy coupon without `currentUses`, so the complete-case read must not
    // depend on it. The ORDERED read is only used past the cap, where count() supplies
    // the total anyway.
    const firstRead = ORG.slice(ORG.indexOf('const first = await col'), ORG.indexOf('const [cnt, sum, top]'))
    expect(firstRead).not.toMatch(/orderBy/)
    expect(PERF).toMatch(/col\.orderBy\('currentUses', 'desc'\)\.limit\(COUPON_DOC_BUDGET\)/)
  })
})

// ─── FIX 2 · the grid may shrink ─────────────────────────────────────────────

describe('a long unbreakable event name cannot widen the page', () => {
  it('the chart panel is a shrinkable grid item', () => {
    expect(CHARTS).toContain('className="flex h-full min-w-0 flex-col"')
    expect(CHARTS).toContain('grid min-w-0 gap-4 lg:grid-cols-3')
  })

  it('the subtitle wraps rather than setting the card width', () => {
    expect(CHARTS).toContain('break-words text-fs-sm text-muted-foreground')
    // Wrapping, not truncation — the event name is the scope statement.
    expect(CHARTS).not.toMatch(/truncate[^"]*text-fs-sm text-muted-foreground/)
  })
})

// ─── FIX 3 · a failure is never an empty ─────────────────────────────────────

describe('a failed read never renders as empty', () => {
  it('the coupon resolver failure sets the unavailable flag', () => {
    expect(ROUTE).toContain('.catch(() => ({ ...EMPTY_ORGANIZER_COUPON_PERFORMANCE, unavailable: true }))')
    // The constant itself stays false — it is also the honest answer for an organizer
    // with no events, which is a measured empty rather than a failure.
    expect(EMPTY_ORGANIZER_COUPON_PERFORMANCE.unavailable).toBe(false)
    expect(PANEL).toContain('Coupon data unavailable')
    expect(PANEL).toContain('unavailable && totalCoupons === 0')
  })

  it('the activity feed carries a failure signal, and the card renders it', () => {
    expect(FEED).toMatch(/unavailable: boolean/)
    expect(ROUTE).toContain('exact: true, unavailable: true,')
    expect(ROUTE).toContain('unavailable: activityPageResult.unavailable,')
    expect(CARD).toContain('Recent activity unavailable')
    expect(CARD).toContain('items.length === 0 && initialUnavailable && index === 0')
    // …and a genuinely quiet feed still says so.
    expect(CARD).toContain('No recent activity yet.')
  })

  it('the reader itself still reports a measured empty as measured', () => {
    // `readActivityPage` never throws; both of its own results are `unavailable: false`.
    expect((FEED.match(/unavailable: false/g) ?? []).length).toBe(2)
    expect(FEED).not.toMatch(/unavailable: true/)
  })

  it('paging semantics are untouched', () => {
    expect(FEED).toContain('const fetchLimit = pageSize + 1 + TIE_BUFFER')
    expect(FEED).toContain('compareDesc(a._key, b._key)')
    expect(FEED).toContain('nextCursor: last ? encodeActivityCursor(last._key) : null')
  })
})

// ─── FIX 4 · the tokens, not the strings ─────────────────────────────────────

/** WCAG relative luminance / contrast, on the same maths the browser audit used. */
const hex = (h: string): [number, number, number] => {
  const v = h.replace('#', '')
  return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16)) as [number, number, number]
}
const lum = (rgb: [number, number, number]) => {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(hex(a)), lum(hex(b))]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const token = (name: string, from: number) => {
  const at = TOKENS.indexOf(`--${name}:`, from)
  return TOKENS.slice(at).match(/#[0-9A-Fa-f]{6}/)?.[0] ?? ''
}

describe('the muted and link tokens meet AA for normal text', () => {
  const LIGHT_CARD = '#FFFFFF'
  const DARK_CARD  = '#1E293B'          // --card in the .dark block
  const darkAt = TOKENS.indexOf('.dark {')

  it('brand-pink TEXT has its own token, and the FILL is untouched', () => {
    // `--primary` still drives every CTA, gradient, ring and shadow.
    // 2026-09-29 owner decision: the product theme left magenta for the logo's indigo (#e5277e → #4F46E5).
    expect(token('primary', 0).toLowerCase()).toBe('#4f46e5')
    expect(ratio(token('primary-text', 0), LIGHT_CARD)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(token('primary-text', darkAt), DARK_CARD)).toBeGreaterThanOrEqual(4.5)
  })

  it('muted foreground clears AA in both themes', () => {
    expect(ratio(token('muted-foreground', 0), LIGHT_CARD)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(token('muted-foreground', darkAt), DARK_CARD)).toBeGreaterThanOrEqual(4.5)
  })

  it('the fix is at the token, not on the strings', () => {
    // Two component seams point at the new token; nothing else changed.
    expect(strip(read('components/dashboard/DashboardCard.tsx'))).toContain('text-primary-text')
    expect(strip(read('components/dashboard/WorkspaceHealthPanel.tsx'))).toContain('text-primary-text')
    expect(read('app/globals.css')).toContain('--color-primary-text:       var(--primary-text)')
  })
})

// ─── RD-DASH-16 · the licence-plan chip ──────────────────────────────────────
//
// The chip carries WHITE type on the filled licence card. It used `bg-white/20`, a wash
// that moves its ground TOWARDS the ink — measured from rendered pixels at 4.32:1 in light
// and 3.83:1 in dark, both under the 4.5 AA threshold for normal text.
//
// It now deepens its own ground with `--kpi-on-fill-chip` instead. The authoritative
// figures are pixel measurements of the real component (7.06:1 light, 7.32:1 dark); this
// suite guards the TREATMENT so the chip cannot quietly return to a white wash.

/** `rgb(R G B / A)` → the composite over an opaque backdrop. */
const over = (translucent: string, backdrop: string): [number, number, number] => {
  const m = translucent.match(/rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)/)
  if (!m) throw new Error(`not an rgb(/alpha) token: ${translucent}`)
  const [r, g, b, a] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  const back = hex(backdrop)
  return [0, 1, 2].map(i => Math.round([r, g, b][i] * a + back[i] * (1 - a))) as [number, number, number]
}
const ratioRgb = (fg: [number, number, number], bg: [number, number, number]) => {
  const [x, y] = [lum(fg), lum(bg)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const rgbToken = (name: string, from: number) => {
  const at = TOKENS.indexOf(`--${name}:`, from)
  return TOKENS.slice(at, at + 200).match(/rgb\([^)]*\)/)?.[0] ?? ''
}

describe('the licence-plan chip meets AA on the filled card', () => {
  const darkAt = TOKENS.indexOf('.dark {')
  const WHITE: [number, number, number] = [255, 255, 255]
  // The type end of the capacity gradient — the stop the chip actually sits over.
  const LIGHT_GRADIENT_STOP = '#E11D48'
  const DARK_GRADIENT_STOP  = '#E8324F'

  it('deepens its ground instead of washing it white', () => {
    const TILE = strip(read('components/dashboard/LicenseTile.tsx'))
    expect(TILE).toContain('bg-[color:var(--kpi-on-fill-chip)]')
    // The regression this guards: the old treatment must not come back.
    expect(TILE).not.toContain('bg-white/20 ring-1 ring-inset ring-white/25')
    // Compact, undecorated, and still a raised badge rather than a punched hole.
    // Scoped to the CHIP: the tile legitimately uses shadow elsewhere.
    const chip = TILE.slice(TILE.indexOf('inline-flex shrink-0 items-center gap-1 rounded-control'))
      .slice(0, 500)
    expect(chip).toContain('ring-1 ring-inset ring-white/25')
    expect(chip).not.toMatch(/shadow-|blur-|drop-shadow/)
    expect(chip).toContain('px-2 py-1 text-fs-2xs font-medium')   // spacing + type unchanged
  })

  it('is defined in BOTH themes, from the palette the token file already uses', () => {
    const light = rgbToken('kpi-on-fill-chip', 0)
    const dark  = rgbToken('kpi-on-fill-chip', darkAt)
    expect(light).toMatch(/rgb\(\s*15\s+23\s+42\s*\//)   // slate-900, as --bg-overlay uses
    expect(dark).toMatch(/rgb\(\s*15\s+23\s+42\s*\//)
    // A deepening layer, not a lightening one, and not opaque black.
    for (const t of [light, dark]) {
      const alpha = Number(t.match(/\/\s*([\d.]+)/)?.[1])
      expect(alpha).toBeGreaterThan(0)
      expect(alpha).toBeLessThan(0.6)
    }
  })

  it('clears 4.5:1 for white type in both themes', () => {
    expect(ratioRgb(WHITE, over(rgbToken('kpi-on-fill-chip', 0), LIGHT_GRADIENT_STOP)))
      .toBeGreaterThanOrEqual(4.5)
    expect(ratioRgb(WHITE, over(rgbToken('kpi-on-fill-chip', darkAt), DARK_GRADIENT_STOP)))
      .toBeGreaterThanOrEqual(4.5)
  })

  it('leaves every frozen KPI token alone', () => {
    // The chip is a new, additive token. Nothing it sits on may have moved.
    // (2026-09-29 owner decision: the product theme left magenta for the logo's indigo; the KPI fills below are untouched.)
    expect(token('primary', 0).toLowerCase()).toBe('#4f46e5')
    expect(TOKENS).toContain('--kpi-capacity-fill: linear-gradient(135deg, #E11D48 0%, #E11D48 52%, #FFB07C 128%)')
    expect(TOKENS).toContain('--kpi-capacity-fill: linear-gradient(135deg, #E8324F 0%, #E8324F 52%, #FF9E6C 128%)')
    expect(TOKENS).toContain('--kpi-on-fill:        #FFFFFF')
    expect(TOKENS).toContain('--kpi-on-fill-tile:   rgb(255 255 255 / 0.22)')
    expect(TOKENS).toContain('--kpi-on-fill-rule:   rgb(255 255 255 / 0.26)')
    expect(TOKENS).toContain('--kpi-capacity-ink: #FFFFFF')
  })
})
