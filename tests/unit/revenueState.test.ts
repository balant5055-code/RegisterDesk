// RD-ANALYTICS-12-21 · the canonical revenue STATE, and the F1 defect it exists to prevent.
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// The dashboard held confirmed revenue in a `Map<string, number | null>` where `null` means
// UNMEASURED — set by a self-healing aggregate's `.catch(() => null)`, written that way
// precisely so a failed read would not look like ₹0. It was then published as:
//
//     revenuePaise: financeAllowed ? (slug ? (revBySlug.get(slug) ?? 0) : 0) : null
//
// `null ?? 0` is 0. So an unmeasured event was serialized as a measured-looking zero, with
// no flag on `DashboardEvent` to say otherwise — while `totalRevPaise`, derived from the
// same map two hundred lines earlier, correctly reported the event as unavailable. One
// payload, two answers.
//
// These cases pin the pure state resolver and its wire encoding, which is where the defect
// actually lived; case 5 is the literal reproduction.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  revenueStateFromCounterMap, toLegacyRevenueFields,
  revenueMeasured, revenueUnmeasured, revenueWithheld, isRevenueMeasured,
  revenueStateFrom, toConfirmedRevenueFields,
  type RevenueState,
} from '@/lib/finance/revenueState'

const SLUG = 'chennai-marathon'
const map = (v: number | null) => new Map<string, number | null>([[SLUG, v]])

describe('RD-ANALYTICS-12-21 · the four revenue states', () => {
  it('1 · authorized + measured positive revenue → positive paise', () => {
    const s = revenueStateFromCounterMap(map(4_820_000), SLUG, true)
    expect(s).toEqual({ ok: true, paise: 4_820_000 })
    expect(toLegacyRevenueFields(s)).toEqual({ revenuePaise: 4_820_000, revenueUnavailable: false })
  })

  it('2 · authorized + measured ZERO → exactly 0, explicitly measured', () => {
    const s = revenueStateFromCounterMap(map(0), SLUG, true)
    expect(s).toEqual({ ok: true, paise: 0 })
    expect(isRevenueMeasured(s)).toBe(true)
    // The distinction the whole type exists for: this zero is the answer.
    expect(toLegacyRevenueFields(s)).toEqual({ revenuePaise: 0, revenueUnavailable: false })
  })

  it('3 · authorized + unavailable → unavailable, NEVER coerced to 0', () => {
    const s = revenueStateFromCounterMap(map(null), SLUG, true)
    expect(s).toEqual({ ok: false, reason: 'unavailable' })
    expect(isRevenueMeasured(s)).toBe(false)
    // The wire still carries a number for the eight consumers that read one — but the flag
    // disowns it, which is what makes it distinguishable from case 2.
    expect(toLegacyRevenueFields(s)).toEqual({ revenuePaise: 0, revenueUnavailable: true })
  })

  it('4 · unauthorized → withheld, and not reported as a platform failure', () => {
    const s = revenueStateFromCounterMap(map(4_820_000), SLUG, false)
    expect(s).toEqual({ ok: false, reason: 'unauthorized' })
    // null carries the denial; the failure flag stays false because nothing failed.
    expect(toLegacyRevenueFields(s)).toEqual({ revenuePaise: null, revenueUnavailable: false })
    // And the withheld amount never appears, whatever the map holds.
    expect(JSON.stringify(toLegacyRevenueFields(s))).not.toContain('4820000')
  })

  it('5 · F1 REPRODUCTION · a null counter never becomes 0-with-unavailable-false', () => {
    const s = revenueStateFromCounterMap(map(null), SLUG, true)
    const wire = toLegacyRevenueFields(s)
    // The exact forbidden combination from the audit.
    expect(wire).not.toEqual({ revenuePaise: 0, revenueUnavailable: false })
    expect(wire.revenueUnavailable).toBe(true)
    // And the old expression, run against the same map, produces exactly that forbidden pair.
    expect(map(null).get(SLUG) ?? 0).toBe(0)   // ← what the route used to publish
    expect(wire.revenuePaise === 0 && wire.revenueUnavailable === false).toBe(false)
  })

  it('6 · the two absences stay distinct from each other', () => {
    const failed = revenueStateFromCounterMap(map(null), SLUG, true)
    const denied = revenueStateFromCounterMap(map(null), SLUG, false)
    expect(failed).not.toEqual(denied)
    expect(toLegacyRevenueFields(failed)).not.toEqual(toLegacyRevenueFields(denied))
  })

  it('7 · measured paise is unreachable without narrowing — the union has no bare `paise`', () => {
    // tsconfig excludes tests from `tsc`, so a @ts-expect-error here would prove nothing.
    // The contract is asserted where it is actually enforced: on the declaration.
    const src = readFileSync(resolve(process.cwd(), 'lib/finance/revenueState.ts'), 'utf8')
    expect(src).toMatch(/export type RevenueState\s*=\s*\|\s*\{ ok: true;\s*paise: number \}/)
    expect(src).toMatch(/\|\s*\{ ok: false;\s*reason: RevenueMissingReason \}/)
    // `paise` exists on the ok arm ONLY, so every read must narrow first.
    const s: RevenueState = revenueUnmeasured()
    expect('paise' in s).toBe(false)
    expect(isRevenueMeasured(s) ? s.paise : 'narrowed').toBe('narrowed')
  })

  it('8 · the derived wire fields cannot contradict each other', () => {
    // Every state, exhaustively — no combination may claim "unavailable" alongside a real
    // figure, or claim measured while withholding one.
    for (const s of [revenueMeasured(1), revenueMeasured(0), revenueUnmeasured(), revenueWithheld()]) {
      const w = toLegacyRevenueFields(s)
      if (s.ok) {
        expect(w.revenueUnavailable).toBe(false)
        expect(w.revenuePaise).toBe(s.paise)
      } else {
        expect(w.revenueUnavailable).toBe(s.reason === 'unavailable')
        expect(w.revenuePaise).toBe(s.reason === 'unauthorized' ? null : 0)
      }
    }
  })

  it('9 · an unpublished event has no counter to read, and its zero is real', () => {
    const s = revenueStateFromCounterMap(new Map(), null, true)
    expect(s).toEqual({ ok: true, paise: 0 })
    // A slug that was never looked up keeps its pre-existing behaviour — deliberately NOT
    // folded in with the null case, because only one of the two was defective.
    expect(revenueStateFromCounterMap(new Map(), 'never-looked-up', true)).toEqual({ ok: true, paise: 0 })
  })
})

// ─── RD-ANALYTICS-12-22 · the two Organizer event routes, through the same serializer ──

describe('RD-ANALYTICS-12-22 · the Organizer event routes serialize through one state', () => {
  const st = (financeAllowed: boolean, unavailable: boolean, paise: number) =>
    toConfirmedRevenueFields(revenueStateFrom({ financeAllowed, unavailable, paise }))

  it('A · authorized + positive revenue → the figure, not flagged', () => {
    expect(st(true, false, 4_820_000))
      .toEqual({ confirmedRevenuePaise: 4_820_000, revenueUnavailable: false })
  })

  it('B · authorized + measured zero → 0, and still distinguishable from unavailable', () => {
    expect(st(true, false, 0)).toEqual({ confirmedRevenuePaise: 0, revenueUnavailable: false })
    expect(st(true, false, 0)).not.toEqual(st(true, true, 0))
  })

  it('C · authorized + unavailable → flagged, and NEVER a silent measured zero', () => {
    const w = st(true, true, 0)
    expect(w.revenueUnavailable).toBe(true)
    expect(w).not.toEqual({ confirmedRevenuePaise: 0, revenueUnavailable: false })
  })

  it('D · unauthorized → withheld, never flagged, and the amount never appears', () => {
    // Entitlement outranks failure: a denied caller is not told the platform broke.
    expect(st(false, true,  4_820_000)).toEqual({ confirmedRevenuePaise: null, revenueUnavailable: false })
    expect(st(false, false, 4_820_000)).toEqual({ confirmedRevenuePaise: null, revenueUnavailable: false })
    expect(JSON.stringify(st(false, false, 4_820_000))).not.toContain('4820000')
  })

  it('E · the serializer is the ONLY constructor of the legacy pair', () => {
    const STATE = readFileSync(resolve(process.cwd(), 'lib/finance/revenueState.ts'), 'utf8')
    // The key-renaming adapter delegates rather than re-encoding, so the pair has one author.
    expect(STATE).toMatch(/const \{ revenuePaise, revenueUnavailable \} = toLegacyRevenueFields\(s\)/)
    // Exactly one place decides the encoding.
    expect((STATE.match(/revenueUnavailable: true/g) ?? [])).toHaveLength(1)
  })

  it('F · no combination of inputs yields a contradictory pair', () => {
    for (const allowed of [true, false]) {
      for (const unavail of [true, false]) {
        for (const paise of [0, 1, 4_820_000]) {
          const f = st(allowed, unavail, paise)
          if (!allowed) {
            expect(f).toEqual({ confirmedRevenuePaise: null, revenueUnavailable: false })
          } else if (unavail) {
            // A flagged figure must never carry a number anyone could mistake for a reading.
            expect(f).toEqual({ confirmedRevenuePaise: 0, revenueUnavailable: true })
          } else {
            expect(f).toEqual({ confirmedRevenuePaise: paise, revenueUnavailable: false })
          }
        }
      }
    }
  })

  it('G · neither route hand-builds the pair any more', () => {
    const s = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
    for (const f of ['app/api/organizer/events/route.ts',
                     'app/api/organizer/events/[eventId]/route.ts']) {
      expect(s(f), f).toContain('toConfirmedRevenueFields(')
      expect(s(f), f).not.toMatch(/confirmedRevenuePaise: financeAllowed \?/)
      expect(s(f), f).not.toMatch(/revenueUnavailable: financeAllowed \?/)
    }
  })
})

describe('RD-ANALYTICS-12-21 · the defect is gone from the route and honoured by its consumer', () => {
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
  const DASH   = 'app/api/organizer/dashboard/route.ts'
  const REPORT = 'app/(dashboard)/dashboard/reports/page.tsx'

  it('10 · the dashboard no longer coerces its counter map with `?? 0` when emitting events', () => {
    const s = src(DASH)
    expect(s).not.toContain('revenuePaise:    financeAllowed ? (slug ? (revBySlug.get(slug) ?? 0) : 0) : null')
    // RD-ANALYTICS-12-24/25 · the state is resolved into a local and serialized once, under
    // the canonical name. The property this case defends is unchanged — one state, no `?? 0`
    // at the emission site — and case E below proves the single source exhaustively.
    expect(s).toMatch(/const revenue\s+= revenueStateFromCounterMap\(revBySlug, slug, financeAllowed\)/)
    expect(s).toContain('...toConfirmedRevenueFields(revenue)')
    // The KPI total's own (correct) unavailable rule is untouched.
    expect(s).toContain('const revenueUnavailable = scopedSlugs.some(slug => revBySlug.get(slug) === null)')
  })

  it('11 · DashboardEvent can now express the state it is being sent', () => {
    expect(src(DASH)).toMatch(/revenueUnavailable\?: boolean/)
  })

  it('12 · the reports consumer treats an unreadable figure as unknown, not as zero', () => {
    const s = src(REPORT)
    // RD-ANALYTICS-12-24 · the RULE is unchanged; only the field it reads was renamed to the
    // canonical name. Both halves still refuse to treat a placeholder as a measurement.
    expect(s).toContain('e.confirmedRevenuePaise !== null && !e.revenueUnavailable')
    // And the row renders a dash rather than "₹0".
    expect(s).toMatch(/event\.confirmedRevenuePaise === null \|\| event\.revenueUnavailable \? '—'/)
  })
})

// ─── RD-ANALYTICS-12-24 · the DashboardEvent field convergence ────────────────

describe('RD-ANALYTICS-12-24 · DashboardEvent converges on the canonical name', () => {
  const DASH = 'app/api/organizer/dashboard/route.ts'
  const REPORTS = 'app/(dashboard)/dashboard/reports/page.tsx'
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
  const raw = src

  /**
   * The wire fields as the dashboard emits them, from ONE state.
   *
   * RD-ANALYTICS-12-25 · this used to spread both serializers, because the contract carried
   * the canonical name and a deprecated alias. The alias is gone, so the helper now mirrors
   * what the route actually emits: `toConfirmedRevenueFields` alone.
   */
  const wire = (s: RevenueState) => ({ ...toConfirmedRevenueFields(s) })

  it('A · authorized + measured · the canonical name carries the figure', () => {
    const w = wire(revenueStateFromCounterMap(map(4_820_000), SLUG, true))
    expect(w.confirmedRevenuePaise).toBe(4_820_000)
    expect(w.revenueUnavailable).toBe(false)
  })

  it('B · authorized + measured zero · exactly 0, and measured', () => {
    const w = wire(revenueStateFromCounterMap(map(0), SLUG, true))
    expect(w.confirmedRevenuePaise).toBe(0)
    expect(w.revenueUnavailable).toBe(false)
  })

  it('C · authorized + unavailable · flagged, and never a silent measured zero', () => {
    const w = wire(revenueStateFromCounterMap(map(null), SLUG, true))
    // The platform's established encoding, LOCKED by RD-ANALYTICS-12-24.5: the number on the
    // wire is a placeholder the FLAG disowns. It is deliberately not `null`.
    expect(w.revenueUnavailable).toBe(true)
    expect(w.confirmedRevenuePaise).toBe(0)
    expect(w).not.toEqual({ confirmedRevenuePaise: 0, revenueUnavailable: false })
  })

  it('D · unauthorized · denial preserved, never flagged as a failure', () => {
    const w = wire(revenueStateFromCounterMap(map(4_820_000), SLUG, false))
    expect(w.confirmedRevenuePaise).toBeNull()
    expect(w.revenueUnavailable).toBe(false)
    // The withheld amount never appears on the wire.
    expect(JSON.stringify(w)).not.toContain('4820000')
  })

  it('D2 · the financial read is still not issued for an unauthorized caller', () => {
    // The gate precedes the aggregate; this phase renamed a field and moved no read.
    expect(src(DASH)).toContain("financeAllowed = authz.permissions.includes('transactions')")
    expect(src(DASH)).toMatch(/revenueStateFromCounterMap\(revBySlug, slug, financeAllowed\)/)
  })

  it('E · the wire fields come from ONE state, computed once, under one name', () => {
    const s = src(DASH)
    // A single local holds the state; one serializer is spread from that one value.
    expect(s).toMatch(/const revenue\s+= revenueStateFromCounterMap\(revBySlug, slug, financeAllowed\)/)
    expect(s).toContain('...toConfirmedRevenueFields(revenue)')
    // RD-ANALYTICS-12-25 · the deprecated alias is GONE — neither declared nor emitted.
    expect(s).not.toContain('...toLegacyRevenueFields(revenue)')
    expect(s).not.toMatch(/^\s*revenuePaise:\s+number \| null/m)
    // The state is resolved exactly once for the event mapping — not once per field.
    expect((s.match(/revenueStateFromCounterMap\(/g) ?? [])).toHaveLength(1)
    // And no third encoder was introduced.
    expect(s).not.toMatch(/function .*RevenueFields|dashboardRevenueFields/)
  })

  it('E2 · exhaustively, every state serializes to the canonical name alone', () => {
    for (const s of [
      revenueMeasured(1), revenueMeasured(0), revenueUnmeasured(), revenueWithheld(),
      revenueStateFrom({ financeAllowed: true, unavailable: false, paise: 4_820_000 }),
      revenueStateFrom({ financeAllowed: false, unavailable: true, paise: 9 }),
    ]) {
      const w = wire(s)
      expect(Object.keys(w).sort()).toEqual(['confirmedRevenuePaise', 'revenueUnavailable'])
      expect(w).not.toHaveProperty('revenuePaise')
    }
  })

  it('F · the PERSISTED counter field was not renamed or migrated', () => {
    // `registrationCounters.revenuePaise` is a stored Firestore key. It shares a spelling
    // with the old wire field and is a different artifact entirely.
    const counters = src('lib/firebase/firestore/registrationCounters.ts')
    expect(counters).toContain('revenuePaise')
    expect(counters).not.toContain('confirmedRevenuePaise')
    // The dashboard still READS the stored key under its real name.
    expect(src(DASH)).toMatch(/d\.revenuePaise \?\? 0/)
  })

  it('G · the Analytics financial contract is untouched', () => {
    // Analytics publishes MaybeMoney and its own windowed `revenuePaise`; neither converged.
    const analytics = src('lib/analytics/eventAnalytics.ts')
    expect(analytics).toMatch(/confirmedRevenuePaise:\s+MaybeMoney/)
    const normalize = src('lib/analytics/normalize.ts')
    expect(normalize).toContain('revenuePaise')
    expect(normalize).not.toContain('confirmedRevenuePaise: number')
  })

  it('H · Admin Event360 counter-only revenue is untouched', () => {
    const e360 = src('lib/admin/event360Types.ts')
    expect(e360).toMatch(/revenuePaise:\s+number/)
    expect(e360).not.toContain('confirmedRevenuePaise')
  })

  it('H2 · platform LICENCE revenue is untouched — it is not ticket revenue', () => {
    const org360 = src('lib/admin/organizer360Types.ts')
    expect(org360).toContain('revenuePaise')
    expect(org360).not.toContain('confirmedRevenuePaise')
  })

  it('I · the migrated consumer reads the canonical name', () => {
    const s = src(REPORTS)
    expect(s).toContain('e.confirmedRevenuePaise !== null && !e.revenueUnavailable')
    expect(s).toContain('event.confirmedRevenuePaise > 0')
    // The DashboardEvent revenue sites no longer read the alias.
    expect(s).not.toContain('event.revenuePaise')
    expect(s).not.toContain('e.revenuePaise')
  })

  it('I2 · the DAILY rollup revenue in the same file was deliberately NOT renamed', () => {
    // `trendDays[].revenuePaise` is day-attributed revenue — a different quantity that
    // RD-12-23 proved is not this figure. It keeps its name.
    const s = raw(REPORTS)
    // RD-PREPROD · D1 — `| null` (withheld without the 'transactions' permission); the NAME is unchanged.
    expect(s).toMatch(/trendDays: \{ date: string; count: number; revenuePaise: number \| null \}\[\]/)
    expect(s).toContain('revenue: d.revenuePaise')
  })

  /*
    Case J — "the deprecated alias is still emitted during this phase" — was deleted by
    RD-ANALYTICS-12-25. It existed to pin a temporary state, and its removal is the signal
    that the compatibility window closed. The absence it leaves behind is now asserted by
    case E, which is where the emission shape is already defended.
  */

  it('K · unavailable revenue cannot become a measured zero through `?? 0`', () => {
    // The consumer's `?? 0` is reachable only after the guard proves every figure is real.
    const s = src(REPORTS)
    const sum = s.slice(s.indexOf('const revenueKnown'), s.indexOf('const withCap'))
    expect(sum).toContain('!e.revenueUnavailable')
    expect(sum).toMatch(/revenueKnown[\s\S]*confirmedRevenuePaise \?\? 0/)
    // And at the producer, an unmeasured counter is never coerced at the emission site.
    expect(src(DASH)).not.toMatch(/revenuePaise:\s+financeAllowed \? \(slug \? \(revBySlug\.get\(slug\) \?\? 0\)/)
  })
})
