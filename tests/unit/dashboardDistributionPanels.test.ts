// RD-DASH-04 · Registration Status and Pass Distribution.
//
// ═══ THE TWO DENOMINATORS, AND WHY THEY DIFFER ═══════════════════════════════
// These panels answer different questions, so they divide by different totals — and the
// whole point of this suite is that each one uses ITS OWN, exactly once:
//
//   Registration Status · share = status ÷ TOTAL registrations (every status)
//   Pass Distribution   · share = pass   ÷ TOTAL CONFIRMED
//
// Pass Distribution deliberately excludes cancelled: it describes who is coming, and a row
// whose share moved because somebody cancelled a different pass would be unreadable. The
// audit found the reverse of this — a share taken on confirmed-only while the same row
// printed a confirmed+cancelled total, two bases side by side.
//
// The arithmetic is exercised through the pure analytics builder; the rendering rules are
// asserted at the source level. Nothing here encodes a real event, a pass name or a total.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildDashboardAnalytics, DISPLAY_LIMIT, type EventAnalyticsInput } from '@/lib/analytics/dashboardAnalytics'

const src = (p: string) => readFileSync(p, 'utf8')
/** Comments carry the audit's prose, including words the CODE must not contain. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const CHARTS = src('components/dashboard/DashboardCharts.tsx')
const PAGE   = src('app/(dashboard)/dashboard/page.tsx')
const ANALYT = src('lib/analytics/dashboardAnalytics.ts')

/** A synthetic event. Every figure is invented; none mirrors a real one. */
const event = (over: Partial<EventAnalyticsInput> = {}): EventAnalyticsInput => ({
  slug: 'e1',
  eventName: 'Any Event',
  status: { total: 0, confirmed: 0, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
  passConfirmed: {},
  passCancelled: {},
  passNames: {},
  ...over,
})

// ═══ 1 – 3 · Registration Status counts ══════════════════════════════════════

describe('Registration Status counts come from the authoritative breakdown', () => {
  const a = buildDashboardAnalytics([event({
    status: { total: 63, confirmed: 55, pending: 0, cancelled: 8, waitlisted: 0, rejected: 0, checkedIn: 0 },
  })])

  it('confirmed and cancelled are carried through untouched', () => {
    expect(a.totals.confirmed).toBe(55)
    expect(a.totals.cancelled).toBe(8)
  })

  it('the total equals the sum of the statuses', () => {
    expect(a.totals.total).toBe(63)
    expect(a.totals.confirmed + a.totals.cancelled).toBe(a.totals.total)
  })

  it('a status that never occurred is not listed as a zero row', () => {
    const labels = a.registrationStatus.map(r => r.label)
    expect(labels).toEqual(['Confirmed', 'Cancelled'])
    expect(labels).not.toContain('Waitlisted')
  })

  it('every status that DID occur is listed, including ones beyond the two', () => {
    const b = buildDashboardAnalytics([event({
      status: { total: 20, confirmed: 10, pending: 4, cancelled: 3, waitlisted: 2, rejected: 1, checkedIn: 0 },
    })])
    expect(b.registrationStatus.map(r => r.label))
      .toEqual(['Confirmed', 'Pending', 'Waitlisted', 'Cancelled', 'Rejected'])
    expect(b.totals.total).toBe(20)
  })
})

// ═══ 4 – 6 · Registration Status shares ══════════════════════════════════════

describe('Registration Status shares use the total-registrations denominator', () => {
  const share = (count: number, total: number) => (count / total) * 100

  it('confirmed and cancelled are divided by the same total', () => {
    const a = buildDashboardAnalytics([event({
      status: { total: 63, confirmed: 55, pending: 0, cancelled: 8, waitlisted: 0, rejected: 0, checkedIn: 0 },
    })])
    expect(share(a.totals.confirmed, a.totals.total)).toBeCloseTo(87.3, 1)
    expect(share(a.totals.cancelled, a.totals.total)).toBeCloseTo(12.7, 1)
  })

  it('the shares sum to 100 within rounding tolerance', () => {
    for (const st of [
      { total: 63, confirmed: 55, pending: 0, cancelled: 8, waitlisted: 0, rejected: 0, checkedIn: 0 },
      { total: 20, confirmed: 10, pending: 4, cancelled: 3, waitlisted: 2, rejected: 1, checkedIn: 0 },
      { total: 3,  confirmed: 1,  pending: 1, cancelled: 1, waitlisted: 0, rejected: 0, checkedIn: 0 },
    ]) {
      const a = buildDashboardAnalytics([event({ status: st })])
      const summed = a.registrationStatus.reduce((t, r) => t + share(r.count, a.totals.total), 0)
      expect(summed).toBeCloseTo(100, 6)
      // And what the panel prints, to one decimal, still lands on 100 ± rounding.
      const printed = a.registrationStatus.reduce((t, r) => t + Number(share(r.count, a.totals.total).toFixed(1)), 0)
      expect(Math.abs(printed - 100)).toBeLessThanOrEqual(0.3)
    }
  })

  it('the panel divides by regTotals.total and by nothing else', () => {
    const panel = CHARTS.slice(CHARTS.indexOf('title="Registration status"'))
      .slice(0, CHARTS.slice(CHARTS.indexOf('title="Registration status"')).indexOf('</ChartPanel>'))
    // RD-DASH-13 §4 · the division moved to the builder. The RULE it enforced — one
    // denominator for the whole panel — is now enforced where the numerator lives, which
    // is a stronger guarantee than a component all of whose rows happened to use it.
    expect(panel).toContain('share={sRow.share}')
    expect(panel).not.toContain('/ regTotals.total')
    // RD-DASH-05B: the ring is handed that same total DIRECTLY rather than summing its own
    // segments, so the picture and the list beneath it cannot end up on different bases.
    expect(panel).toContain('<StatusRing rows={regStatus} total={regTotals.total} />')
    // No second base anywhere on the card.
    expect(panel).not.toMatch(/confirmed \+ cancelled/)
    expect(panel).not.toMatch(/regTotals\.confirmed \+/)
    expect(panel).not.toMatch(/passTotal/)
  })

  it('claims no percentage at all when the denominator is zero', () => {
    // RD-DASH-13 §4 · null-when-no-denominator is now decided server-side; the component
    // still refuses to render a pill for a null share, which is the half that is UI.
    const ANALYT = src('lib/analytics/dashboardAnalytics.ts')
    expect(ANALYT).toMatch(/totals\.total !== null && totals\.total > 0/)
    expect(ANALYT).toMatch(/\(s\.count \/ totals\.total\) \* 100/)
    expect(CHARTS).toContain('{share !== null && (')
  })

  it('names its denominator ONCE, in the middle of the ring', () => {
    // RD-DASH-05B. The same figure used to be stated three times on one card: in the
    // subtitle, again in a footer, and a third time implicitly as the full width of the
    // stacked bar. It is now stated where the reader is already looking — inside the ring,
    // beside the label saying what it counts — and the subtitle keeps only the scope, which
    // is the one thing it uniquely knows.
    expect(CHARTS).toContain('<StatusRing rows={regStatus} total={regTotals.total} />')
    expect(CHARTS).toContain('{n(total)}')
    expect(CHARTS).toContain('>Total registrations</span>')
    expect(CHARTS).toContain('subtitle={`Every status · ${scopeLabel}, all time`}')
    // Removed, not merely relocated — two of the three statements are gone.
    expect(CHARTS).not.toContain("{ label: 'Total registrations'")
    expect(CHARTS).not.toContain('total registrations · ')
  })
})

// ═══ 8 – 10 · Pass Distribution denominator ══════════════════════════════════

describe('Pass Distribution divides by total CONFIRMED', () => {
  it('the share is pass-confirmed over confirmed-total', () => {
    expect(CHARTS).toContain('share={passTotal > 0 ? (p.count / passTotal) * 100 : null}')
    expect(CHARTS).toContain('const passTotal = confirmedTotal ?? passDist.reduce')
    expect(PAGE).toContain('confirmedTotal={data.registrationTotals.confirmed}')
  })

  it('cancelled never enters the denominator', () => {
    const panel = CHARTS.slice(CHARTS.indexOf('title="Pass distribution"'))
      .slice(0, CHARTS.slice(CHARTS.indexOf('title="Pass distribution"')).indexOf('</ChartPanel>'))
    expect(panel).not.toMatch(/p\.total/)
    expect(panel).not.toMatch(/count \+ .*cancelled/)
    expect(panel).not.toMatch(/regTotals\.total/)
    // Cancelled is REPORTED, just never divided by.
    // RD-DASH-05: cancellations moved ONTO the row they belong to, and into the footer —
    // still reported, still never divided by.
    expect(panel).toContain('${n(p.cancelled)} cancelled')
    expect(panel).toContain("label: 'Total cancelled'")
  })

  it('the row values are confirmed counts, and they reconcile with the total', () => {
    const a = buildDashboardAnalytics([event({
      status: { total: 100, confirmed: 90, pending: 0, cancelled: 10, waitlisted: 0, rejected: 0, checkedIn: 0 },
      passConfirmed: { p1: 50, p2: 30, p3: 10 },
      passCancelled: { p1: 6, p2: 4 },
      passNames: { p1: 'Standard', p2: 'Early bird', p3: 'Student' },
    })])
    expect(a.passDistribution.map(r => r.count)).toEqual([50, 30, 10])
    expect(a.passDistribution.reduce((t, r) => t + r.count, 0)).toBe(a.totals.confirmed)
    const shares = a.passDistribution.map(r => (r.count / a.totals.confirmed) * 100)
    expect(shares.reduce((t, v) => t + v, 0)).toBeCloseTo(100, 6)
    // Cancelled is carried per row but plays no part in the share.
    expect(a.passDistribution.map(r => r.cancelled)).toEqual([6, 4, 0])
  })

  it('restates the confirmed denominator at the foot of the card', () => {
    expect(CHARTS).toContain("{ label: 'Total confirmed', text: n(passTotal), strong: true }")
  })
})

// ═══ 11 · Pass ORDER ═════════════════════════════════════════════════════════

describe('passes appear in the order the organizer configured', () => {
  it('follows pricing.passes, not the size of each pass', () => {
    const a = buildDashboardAnalytics([event({
      status: { total: 100, confirmed: 100, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
      // Deliberately ascending, so a size sort would reverse it.
      passConfirmed: { p1: 10, p2: 30, p3: 60 },
      passNames: { p1: 'First', p2: 'Second', p3: 'Third' },
    })])
    expect(a.passDistribution.map(r => r.label)).toEqual(['First', 'Second', 'Third'])
  })

  it('does not re-sort alphabetically either', () => {
    const a = buildDashboardAnalytics([event({
      status: { total: 30, confirmed: 30, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
      passConfirmed: { p1: 10, p2: 10, p3: 10 },
      passNames: { p1: 'Zulu', p2: 'Alpha', p3: 'Mike' },
    })])
    expect(a.passDistribution.map(r => r.label)).toEqual(['Zulu', 'Alpha', 'Mike'])
  })

  it('a pass known only to the counters still appears, after the configured ones', () => {
    // A pass since renamed or removed from pricing still holds registrations.
    const a = buildDashboardAnalytics([event({
      status: { total: 15, confirmed: 15, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
      passConfirmed: { ghost: 5, p1: 10 },
      passNames: { p1: 'Configured' },
    })])
    expect(a.passDistribution.map(r => r.label)).toEqual(['Configured', 'Unassigned'])
  })

  it('the builder performs no ordering of its own', () => {
    expect(ANALYT).toContain('const ranked = [...rows.values()]')
    expect(ANALYT).not.toMatch(/rows\.values\(\)\]\.sort/)
    expect(ANALYT).toContain('const orderedPassIds')
  })
})

// ═══ 12 + 13 · no pass data ══════════════════════════════════════════════════

describe('an event with no passes says so rather than inventing one', () => {
  it('passDataAvailable is false when nothing was configured', () => {
    const a = buildDashboardAnalytics([event({
      status: { total: 40, confirmed: 40, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
    })])
    expect(a.passDataAvailable).toBe(false)
  })

  it('the panel uses that flag for its empty state', () => {
    // `every` also covers the empty array, and catches the case the browser surfaced: rows
    // that exist only because a pass has CANCELLATIONS, with nothing confirmed to distribute.
    expect(CHARTS).toContain('empty={passRows.every(p => p.count === 0) || !passDataAvailable}')
    expect(CHARTS).toContain('No pass distribution available for this event.')
  })

  it('a pass with only cancellations is not rendered as a 0% row', () => {
    expect(CHARTS).toContain('{passRows.filter(p => p.count > 0).map(p => (')
  })

  it('no category is invented in the component', () => {
    for (const word of [/'Unassigned'/, /'Unknown'/, /'Miscellaneous'/, /"Other"/]) {
      expect(CHARTS).not.toMatch(word)
    }
  })

  it('"Unassigned" only ever names a real, unresolvable passId in the data', () => {
    // It is a label for a registration whose pass no longer exists — never a placeholder
    // manufactured to fill an empty panel.
    expect(ANALYT).toContain("ev.passNames[passId]?.trim() || 'Unassigned'")
    const a = buildDashboardAnalytics([event({
      status: { total: 5, confirmed: 5, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
      passConfirmed: {}, passNames: {},
    })])
    expect(a.passDistribution.every(r => r.label !== 'Unassigned' || r.count > 0)).toBe(true)
  })
})

// ═══ 14 + 15 · every event type ══════════════════════════════════════════════

describe('nothing here assumes a running event', () => {
  it('the panels name no distance, race or marathon concept', () => {
    for (const code of [CHARTS, ANALYT]) {
      for (const word of [/marathon/i, /\brunning\b/i, /\bdistance\b/i, /\bkm\b/i, /\brace\b/i, /\b\d+K\b/]) {
        expect(code).not.toMatch(word)
      }
    }
  })

  it('renders a conference, a workshop and a charity event identically', () => {
    for (const passNames of [
      { p1: 'Full conference', p2: 'Day pass', p3: 'Virtual' },
      { p1: 'Morning workshop', p2: 'Afternoon workshop' },
      { p1: 'Donor', p2: 'Volunteer' },
    ]) {
      const ids = Object.keys(passNames)
      const confirmed = Object.fromEntries(ids.map((id, i) => [id, (i + 1) * 5]))
      const total = Object.values(confirmed).reduce((t, v) => t + v, 0)
      const a = buildDashboardAnalytics([event({
        status: { total, confirmed: total, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
        passConfirmed: confirmed, passNames,
      })])
      expect(a.passDataAvailable).toBe(true)
      expect(a.passDistribution.map(r => r.label)).toEqual(Object.values(passNames))
      expect(a.passDistribution.reduce((t, r) => t + r.count, 0)).toBe(a.totals.confirmed)
    }
  })

  it('the labels the panels print come from event configuration, never a constant', () => {
    expect(ANALYT).toContain('passId → configured pass name, from draft.pricing.passes')
    expect(CHARTS).toContain('label={p.label}')
  })
})

// ═══ 17 · accessibility ══════════════════════════════════════════════════════

describe('the distribution is readable without seeing it', () => {
  it('every row carries name, count and share in one accessible label', () => {
    expect(CHARTS).toContain('role="group"')
    // The sentence is assembled in `spoken` so the money and cancellation lines join it —
    // a row now speaks every fact it shows, not just the first three.
    expect(CHARTS).toContain('aria-label={spoken}')
    expect(CHARTS).toContain('`${label}: ${n(value)} ${suffix}`')
    expect(CHARTS).toContain('...(money ?? []).map(m => `${m.label} ${m.text}`)')
  })

  it('the bars are decorative — the numbers are written out beside them', () => {
    // A bar announced separately would read as a bare number with no unit.
    expect(CHARTS).toMatch(/rounded-full" style=\{\{ background: TRACK \}\} aria-hidden/)
    expect(CHARTS).toContain('{share.toFixed(1)}%')
    expect(CHARTS).toContain('{n(value)}')
  })

  it('share is never carried by colour alone', () => {
    // Every arc of the ring has a written counterpart in the list below it, which is why
    // the ring itself is aria-hidden rather than labelled: it would otherwise announce the
    // same five facts a second time, as bare numbers with no unit.
    // RD-DASH-13 · the ring is still handed the authoritative total directly, but only
    // when one EXISTS: a null total means the waitlist was unreadable, and a ring drawn
    // without a whole would be a picture of a number nobody measured.
    expect(CHARTS).toContain(': <StatusRing rows={regStatus} total={regTotals.total} />}')
    expect(CHARTS).toContain('{statusRows.map(sRow => (')
    expect(CHARTS).toMatch(/viewBox=\{`0 0 \$\{SIZE\} \$\{SIZE\}`\} className="block w-full" aria-hidden/)
    expect(CHARTS).toContain('aria-label={spoken}')
  })

  it('colour is SEMANTIC, so cancelled can never render as a success tone', () => {
    // RD-DASH-05 made the tone a saturated gradient TOKEN. RD-DASH-05B collapsed the four
    // parallel colour tables into ONE label→tone map, which now feeds the ring arc, the row
    // rail, the share pill and its ink — so a status physically cannot be one colour on the
    // ring and a different one in the list. Still chosen by status NAME, never by position.
    expect(CHARTS).toContain('const TONE: Record<string, DistTone> = {')
    expect(CHARTS).toContain("Cancelled:  'cancelled'")
    expect(CHARTS).toContain('const toneOf = (label: string): DistTone => TONE[label] ??')
    expect(CHARTS).toContain('fill={distFill(toneOf(sRow.label))}')
    expect(CHARTS).toContain('tone={toneOf(sRow.label)}')
    // Nothing picks a colour off a rotating palette by index.
    expect(CHARTS).not.toMatch(/COLORS\[\s*i\s*%/)
  })
})

// ═══ 18 – 20 · layout and states ═════════════════════════════════════════════

describe('the panels share one height and state their own failures', () => {
  it('each card fills its grid track and lays its body out as a column', () => {
    // RD-DASH-15 · `min-w-0` joined it. A grid item defaults to `min-width: auto` and
    // refuses to shrink below its content, so an unbreakable Tamil event name in the
    // subtitle took the page 199px wide at 390px. The rest of the rule is unchanged.
    expect(CHARTS).toContain('className="flex h-full min-w-0 flex-col"')
    expect(CHARTS).toContain('break-words text-fs-sm text-muted-foreground')
    expect(CHARTS).toContain('<div className="flex flex-1 flex-col px-5 py-4">')
  })

  it('the footer is pushed to the bottom rather than pinned by a fixed height', () => {
    expect(CHARTS).toContain('mt-auto')
    // A `min-h` FLOOR on the empty states is fine — it stops them collapsing. What must not
    // exist is a fixed `h-[...]` ceiling, which would cap a panel below its row's height.
    expect(CHARTS).not.toMatch(/(^|[^-])\bh-\[\d+px\]/)
  })

  it('empty and unavailable states fill the panel instead of leaving a void', () => {
    expect(CHARTS).toContain('flex min-h-[132px] flex-1 flex-col items-center justify-center')
  })

  it('an unreadable counter is a FAILURE state, never a zero', () => {
    expect(CHARTS).toContain('role="alert"')
    expect(CHARTS).toContain('so this is not shown as zero')
    expect(CHARTS).toContain('unavailable={analyticsUnavailable}')
  })

  it('one panel failing does not take the others down', () => {
    // `unavailable` is a per-panel prop, so each renders its own outcome.
    expect((CHARTS.match(/unavailable=\{analyticsUnavailable\}/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

// ═══ 21 – 27 · safety ════════════════════════════════════════════════════════

describe('these panels write nothing and call nothing', () => {
  const all = [CHARTS, ANALYT, PAGE]

  it('perform no Firestore write', () => {
    for (const code of all) {
      expect(code).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
      expect(code).not.toMatch(/collection\([^)]*\)\s*\.\s*add\(/)
      expect(code).not.toMatch(/runTransaction|bulkWriter|\bFieldValue\b/)
    }
  })

  it('import no Razorpay client and carry no GATEWAY money', () => {
    // RD-DASH-05 gave these panels ticket VALUE — a registration figure. What must never
    // appear is a gateway or platform one: those belong to Finance and mean something else.
    for (const code of [CHARTS, ANALYT]) {
      expect(code.toLowerCase()).not.toContain("from 'razorpay'")
      expect(code).not.toMatch(/payments\s*\.\s*(refund|capture)/)
      for (const forbidden of [
        /gatewayFee/, /gatewayTax/, /platformFee/, /netSettlement/,
        /refundsPaise/, /refundAmount/, /walletBalance/, /organizerPayable/,
      ]) expect(code).not.toMatch(forbidden)
      // The ONLY money these panels know is the ticket value on the registration itself.
      const moneyFields = [...code.matchAll(/\b(\w+Paise)\b/g)].map(m => m[1])
      for (const f of moneyFields) expect(['salesPaise', 'cancelledPaise']).toContain(f)
    }
  })

  it('the analytics builder remains pure — no I/O of any kind', () => {
    expect(ANALYT).not.toMatch(/adminDb|fetch\(/)
    // Its ONE firebase reference is a type-only import, which disappears at runtime. A value
    // import from that path would mean the builder had grown a dependency on Firestore.
    // RD-DASH-13 · the builder now owns `EventStatusCounts` outright, so it imports
    // NOTHING from firebase — not even a type. Strictly purer than the rule this checked.
    const firebaseImports = ANALYT.match(/^import .*firebase.*$/gm) ?? []
    expect(firebaseImports).toHaveLength(0)
    expect(ANALYT).toContain('export interface EventStatusCounts')
    expect(ANALYT).toContain('PURE — no Firestore, no I/O')
  })

  it('hardcode no event identifier, pass name or total', () => {
    for (const code of [CHARTS, ANALYT]) {
      expect(code).not.toMatch(/noyyal/i)
      expect(code).not.toMatch(/2,?295|2,?329|\b34\b\s*cancelled/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// RD-DASH-05 · per-pass ticket value, and the gradients that carry the shares.
//
// ═══ WHY THIS NEEDED NEW PLUMBING AT ALL ══════════════════════════════════════
// Per-pass money did not exist. Every sum-by-pass shape fails FAILED_PRECONDITION on the
// deployed indexes — the finance module already documents its own per-pass money as
// `requires_index`. So rather than fabricate a figure, the aggregate was added, the index
// DECLARED (not deployed), and the panel taught to render nothing until it resolves.
//
// The line these tests defend hardest: ticket VALUE is a registration figure. It sums
// `registrations.amount`. It is not a gateway charge, not a platform fee, and above all
// "cancelled value" is NOT a refund — a cancellation may never have been refunded.
// ═══════════════════════════════════════════════════════════════════════════════

const AGG    = src('lib/analytics/registrationPassAggregates.ts')
const ROUTE  = src('app/api/organizer/dashboard/route.ts')
const TOKENS = src('styles/tokens.css')
const ROUTE_SRC = src('app/api/organizer/dashboard/route.ts')

describe('per-pass ticket value comes from the registration, not the gateway', () => {
  it('sums the amount ON THE REGISTRATION, split by status', () => {
    expect(AGG).toContain("AggregateField.sum('amount')")
    expect(AGG).toContain("sumFor(pid, 'confirmed')")
    expect(AGG).toContain("sumFor(pid, 'cancelled')")
    expect(AGG).toContain("adminDb.collection('registrations')")
  })

  it('touches no gateway, platform or refund figure', () => {
    // Asserted on CODE: the doc comment names those concepts precisely in order to exclude
    // them, so a raw match would flag the very sentence that makes the rule explicit.
    const code = AGG.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const forbidden of [
      /gatewayFee/, /gatewayTax/, /platformFee/, /netSettlement/, /grossAmount/,
      /refundAmount/, /registrationRefunds/, /razorpay/i, /wallet/i,
    ]) expect(code).not.toMatch(forbidden)
    // The only field it reads is the ticket amount on the registration.
    expect(code).toContain("AggregateField.sum('amount')")
  })

  it('says in the module that a cancellation is not a refund', () => {
    expect(AGG).toMatch(/a gateway refund answers "what money went back"/)
    expect(AGG).toMatch(/cancellation may never have been refunded/)
    // And the same distinction is restated where the value reaches the analytics contract.
    expect(ANALYT).toMatch(/NOT the amount refunded through the gateway/)
  })

  it('is bounded by the caller budget, charged for what it actually costs', () => {
    expect(AGG).toContain('const cost = passIds.length * 2')
    expect(AGG).toContain('if (cost > budget.remaining) return { values: {}, complete: false }')
  })

  it('returns an EMPTY map on failure, never zeros', () => {
    expect(AGG).toContain('return complete ? { values, complete: true } : { values: {}, complete: false }')
    expect(AGG).toMatch(/NULL IS NOT ZERO/)
  })

  it('the route reads it only for the scoped set, and never for the cross-event pass', () => {
    // RD-DASH-13 §2 · the scoped-set rule is unchanged; the loop that applied it is now a
    // budget PLAN, and the reads it authorises run concurrently afterwards.
    expect(ROUTE).toContain('for (const slug of scopedSlugs) {')
    expect(ROUTE).toContain('valuePlan.push(slug)')
    expect(ROUTE).toContain('mapWithConcurrency(valuePlan, EVENT_CONCURRENCY')
    // Event Performance counts registrations; it must not pay for money it does not show.
    expect(ROUTE).toContain('passValue:     {},')
  })

  it('the index it needs is DECLARED so the figure can resolve without new code', () => {
    const idx = JSON.parse(src('firestore.indexes.json')) as {
      indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>
    }
    const match = idx.indexes.find(i =>
      i.collectionGroup === 'registrations' &&
      i.fields.map(f => f.fieldPath).join(',') === 'organizerUid,eventSlug,passId,status,amount')
    expect(match).toBeDefined()
  })
})

describe('unmeasured money renders as nothing, never as zero', () => {
  const withValue = (passValue: EventAnalyticsInput['passValue']) => buildDashboardAnalytics([event({
    status: { total: 30, confirmed: 30, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
    passConfirmed: { p1: 20, p2: 10 },
    passNames: { p1: 'One', p2: 'Two' },
    passValue,
  })])

  it('a measured event carries the value onto its rows', () => {
    const a = withValue({ p1: { salesPaise: 200_000, cancelledPaise: 5_000 }, p2: { salesPaise: 100_000, cancelledPaise: 0 } })
    expect(a.passDistribution.map(r => r.salesPaise)).toEqual([200_000, 100_000])
    expect(a.passDistribution.map(r => r.cancelledPaise)).toEqual([5_000, 0])
    expect(a.passValueUnavailable).toBe(false)
  })

  it('an unmeasured event leaves null and raises the flag', () => {
    const a = withValue(null)
    expect(a.passValueUnavailable).toBe(true)
    expect(a.passDistribution.every(r => r.salesPaise === null)).toBe(true)
    // The crucial distinction: not zero.
    expect(a.passDistribution.some(r => r.salesPaise === 0)).toBe(false)
  })

  it('an unattributed bucket has no pass to value, so its money stays null', () => {
    const a = buildDashboardAnalytics([event({
      status: { total: 10, confirmed: 10, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
      passConfirmed: {}, passNames: {}, passValue: {},
    })])
    const un = a.passDistribution.find(r => r.label === 'Unattributed')
    expect(un?.salesPaise).toBeNull()
    expect(un?.cancelledPaise).toBeNull()
  })

  it('the panel omits the money lines entirely when unavailable', () => {
    expect(CHARTS).toContain('money={passValueUnavailable || p.salesPaise === null ? undefined : [')
    expect(CHARTS).toContain('{money && money.length > 0 && (')
  })

  it('a total is withheld the moment ANY row is unmeasured', () => {
    // RD-DASH-13 §4 · the rule moved to the builder, which applies it across EVERY pass
    // rather than the rows that survived the Top-N cut.
    const ANALYT2 = src('lib/analytics/dashboardAnalytics.ts')
    expect(ANALYT2).toMatch(/every\(p => p\.salesPaise !== null\)/)
    expect(CHARTS).toContain('const passSalesTotal = passValueUnavailable ? null : passTotals.salesPaise')
    expect(CHARTS).toContain('...(passSalesTotal !== null')
  })

  it('a pass with NO cancellations shows no cancelled-value line', () => {
    // Nothing cancelled, nothing to report.
    expect(CHARTS).toContain('...(p.cancelled > 0 && p.cancelledPaise !== null ? [{')
  })

  it('a pass whose cancellations were all FREE still shows the line, at zero', () => {
    // RD-DASH-05A. The gate was `p.cancelledPaise ? …`, a truthiness test, so a pass whose
    // cancellations were free registrations measured ₹0 and vanished — leaving "N cancelled"
    // above a row that silently was not there. Zero is a MEASUREMENT here, not an absence.
    expect(CHARTS).not.toContain('...(p.cancelledPaise ? [{')
    expect(CHARTS).toContain('p.cancelled > 0 && p.cancelledPaise !== null')

    // And the analytics carries that zero rather than dropping it.
    const a = buildDashboardAnalytics([event({
      status: { total: 10, confirmed: 5, pending: 0, cancelled: 5, waitlisted: 0, rejected: 0, checkedIn: 0 },
      passConfirmed: { p1: 5 },
      passCancelled: { p1: 5 },
      passNames:     { p1: 'Free entry' },
      passValue:     { p1: { salesPaise: 0, cancelledPaise: 0 } },
    })])
    const row = a.passDistribution[0]
    expect(row.cancelled).toBe(5)
    expect(row.cancelledPaise).toBe(0)        // measured
    expect(row.cancelledPaise).not.toBeNull() // and distinguishable from unmeasured
  })

  it('an UNMEASURED cancelled value still suppresses the line, even with cancellations', () => {
    const a = buildDashboardAnalytics([event({
      status: { total: 10, confirmed: 5, pending: 0, cancelled: 5, waitlisted: 0, rejected: 0, checkedIn: 0 },
      passConfirmed: { p1: 5 },
      passCancelled: { p1: 5 },
      passNames:     { p1: 'Standard' },
      passValue:     null,
    })])
    expect(a.passDistribution[0].cancelledPaise).toBeNull()
    expect(a.passValueUnavailable).toBe(true)
  })
})

describe('the footers reconcile the two cards', () => {
  it('total confirmed on Pass Distribution IS the Confirmed status count', () => {
    const a = buildDashboardAnalytics([event({
      status: { total: 100, confirmed: 90, pending: 4, cancelled: 6, waitlisted: 0, rejected: 0, checkedIn: 0 },
      passConfirmed: { p1: 60, p2: 30 },
      passCancelled: { p1: 4, p2: 2 },
      passNames: { p1: 'One', p2: 'Two' },
      passValue: { p1: { salesPaise: 600, cancelledPaise: 40 }, p2: { salesPaise: 300, cancelledPaise: 20 } },
    })])
    // The panel divides by `confirmedTotal`, which the page feeds from registrationTotals.
    expect(a.passDistribution.reduce((t, r) => t + r.count, 0)).toBe(a.totals.confirmed)
    expect(a.passDistribution.reduce((t, r) => t + r.cancelled, 0)).toBe(a.totals.cancelled)
    expect(a.passDistribution.reduce((t, r) => t + (r.salesPaise ?? 0), 0)).toBe(900)
  })

  it('the cancelled total is reported beside the confirmed one, never inside it', () => {
    // RD-DASH-13 §4 · a registration total, no longer reduced in a component.
    expect(CHARTS).toContain('const passCancelledTotal = passTotals.cancelled')
    expect(CHARTS).toContain('passCancelledTotal > 0 && !passCancelledUnavailable')
  })
})

describe('the share bars are saturated design tokens', () => {
  it('every fill is a --dist-* token, never an inline colour', () => {
    expect(CHARTS).not.toMatch(/#[0-9A-Fa-f]{6}/)
    // RD-DASH-05B addresses the six families through one tone helper instead of six literal
    // strings, so the check is: every family exists as a token, and every token the
    // component reads is built from that tone.
    for (const t of ['confirmed', 'pending', 'waitlisted', 'cancelled', 'rejected', 'pass']) {
      expect(CHARTS).toContain("'" + t + "'")
      expect(TOKENS).toContain('--dist-' + t + '-fill:')
    }
    for (const kind of ['fill', 'a', 'b', 'tint', 'ink']) {
      expect(CHARTS).toContain('var(--dist-${t}-' + kind + ')')
    }
  })

  it('the tokens are saturated two-stop gradients, defined for both themes', () => {
    for (const t of ['confirmed', 'pending', 'waitlisted', 'cancelled', 'rejected', 'pass']) {
      const defs = [...TOKENS.matchAll(new RegExp('--dist-' + t + '-fill:\\s*(linear-gradient\\([^;]+\\))', 'g'))]
      expect(defs.length).toBe(2)              // light + dark
      for (const d of defs) expect(d[1]).toMatch(/linear-gradient\(90deg, #[0-9A-F]{6} 0%, #[0-9A-F]{6} 100%\)/i)
    }
  })

  it('uses the specified saturated palette, not pastels', () => {
    expect(TOKENS).toContain('--dist-confirmed-fill:  linear-gradient(90deg, #2563EB 0%, #7C3AED 100%)')
    expect(TOKENS).toContain('--dist-cancelled-fill:  linear-gradient(90deg, #F43F5E 0%, #EF4444 100%)')
    expect(TOKENS).toContain('--dist-pending-fill:    linear-gradient(90deg, #F59E0B 0%, #F97316 100%)')
  })

  it('leaves the frozen KPI card fills untouched', () => {
    for (const k of ['capacity', 'people', 'money', 'fees']) {
      expect(TOKENS).toContain('--kpi-' + k + '-fill:')
    }
  })

  it('the track stays neutral so the card itself is not a gradient', () => {
    expect(TOKENS).toContain('--dist-track:')
    expect(CHARTS).toContain('style={{ background: TRACK }}')
    // No glow, no shadow on a data bar.
    expect(CHARTS).not.toMatch(/shadow-|drop-shadow|blur-/)
  })
})
// ═══════════════════════════════════════════════════════════════════════════════
// RD-DASH-05B · the two panels that stopped being bar charts.
//
// ═══ THE DESIGN ARGUMENT, PINNED ═════════════════════════════════════════════
// Pass Distribution KEPT its bars, and that is the point of the split: its values divide
// one confirmed population, so they are comparable and a length reads faster than a figure.
//
// The other two do not have that property.
//
//   Registration Status · a stacked bar spent the whole card width on a shape that is
//     ~98% one colour, and the total it divided had to be printed somewhere else. The ring
//     puts the denominator inside its own divisions.
//
//   Event Performance · proportional bars assume the values are within an order of
//     magnitude. Confirmed counts across a workspace are routinely not, and one full bar
//     beside two invisible ones says only "there is one event" — while making the tail
//     indistinguishable from zero, a claim the data never made. A ranking degrades
//     gracefully at any spread.
//
// Neither change touches a query, a denominator or a definition. Everything below is either
// a rendering rule or a token, which is exactly the scope this phase was allowed.
// ═══════════════════════════════════════════════════════════════════════════════

describe('the status ring is honest about small slices', () => {
  it('an arc is POSITIONED on the true cumulative share — only its length is floored', () => {
    // A slice worth a fraction of a percent is under a pixel of arc. Dropping it would read
    // as "none", which is a different fact from "a few" — so the drawn length has a floor.
    // The floor is taken out of the GAP beside the arc, never out of its neighbour, because
    // `at` is derived from the untouched cumulative share rather than from the drawn lengths.
    expect(CHARTS).toContain('const before = drawn.slice(0, i).reduce((t, x) => t + x.value, 0)')
    expect(CHARTS).toContain('at:    total > 0 ? (before / total) * C : 0')
    expect(CHARTS).toContain('dash:  Math.max(span - GAP, MIN)')
  })

  it('a status with no registrations draws no arc at all', () => {
    // Distinct from the floor above: zero is genuinely nothing, and a floored zero would be
    // a slice claiming a population that does not exist.
    expect(CHARTS).toContain('const drawn = rows.filter(r => r.value > 0)')
  })

  it('the ring carries no figure that is not also written out', () => {
    // The count and the share are text in the list; the total is text in the middle of the
    // ring. Nothing on this card is legible only to someone who can separate two hues.
    expect(CHARTS).toContain('{n(value)}</span>')
    expect(CHARTS).toContain('{share.toFixed(1)}%')
    expect(CHARTS).toContain('`${label}: ${n(value)} registrations`')
    expect(CHARTS).toContain('`${share.toFixed(1)} percent`')
  })

  it('claims no percentage when the denominator is zero', () => {
    // Unchanged rule, new component: null share ⇒ no pill, rather than 0.0%.
    // RD-DASH-13 §4 · the share arrives resolved; the component still refuses to paint a
    // pill for a null one, which is the half of the rule that is genuinely UI.
    expect(CHARTS).toContain('share={sRow.share}')
    expect((CHARTS.match(/\{share !== null && \(/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('Event Performance ranks rather than scales', () => {
  it('draws no proportional bar for a series that spans orders of magnitude', () => {
    expect(CHARTS).not.toContain('<HBars')
    // The ONE line still naming that module is a type-only import, which disappears at build
    // time — so the lazy chunk no longer carries the chart primitives at all. A value import
    // from that path would mean a bar chart had crept back in.
    const chartImports = CHARTS.match(/^import .*analytics\/Charts.*$/gm) ?? []
    expect(chartImports).toHaveLength(1)
    expect(chartImports[0].startsWith('import type ')).toBe(true)
  })

  it('renders the series in the order it arrives, and ranks by that order', () => {
    // The builder already ranks by confirmed count. Re-sorting here would be a second
    // ordering rule that could disagree with the first.
    expect(CHARTS).toContain('{eventPerf.map((e, i) => (')
    expect(CHARTS).toContain('rank={e.slug === null ? null : i + 1}')
    expect(CHARTS).toContain('lead={i === 0 && e.slug !== null}')
    expect(CHARTS).not.toMatch(/eventPerf[\s\S]{0,40}\.sort\(/)

    // RD-DASH-10 · keyed on the SLUG, never the display name. Two events may legitimately
    // share a name — the audited workspace has exactly that — and a name key makes React
    // reuse one's DOM for the other.
    expect(CHARTS).toContain("key={e.slug ?? '__remainder__'}")
    expect(CHARTS).not.toMatch(/key=\{e\.label\}/)

    // …and the builder is what does the ranking.
    expect(ANALYT).toContain('const evRanked = eventPerformance.sort((a, b) =>')
    expect(ANALYT).toContain('b.count - a.count')
  })

  it('the leader is emphasised, and only the leader', () => {
    expect(CHARTS).toContain("lead && 'border'")
    expect(CHARTS).toContain("background: 'var(--perf-lead-surface)'")
    expect(CHARTS).toContain("lead ? 'text-fs-xl' : 'text-fs-base'")
    expect(CHARTS).toContain("lead ? 'py-3.5' : 'py-2.5'")
  })

  it('centres its slack rather than pooling it above the footer', () => {
    // The bar chart left a void between its last bar and the footer in a stretched track — the
    // dead vertical space this phase was asked to remove. Stretching the ROWS was tried first
    // and read as a loose, half-empty tile, so the rows keep their natural height and the LIST
    // centres. Same treatment as the status ring, which is what makes the pair feel related.
    expect(CHARTS).toContain('<ol className="flex flex-1 flex-col justify-center gap-1.5">')
    expect(CHARTS).toContain('<div className="flex flex-1 items-center justify-center py-3">')
  })

  it('the badge palette is tiered and stops at the podium', () => {
    // Three brand-gradient tiers, then neutral. A workspace with six events must not render
    // as six unrelated hues, and past third place the position stops being the point.
    expect(CHARTS).toContain('rank <= 3')
    expect(CHARTS).toContain('backgroundImage: `var(--perf-rank${rank}-fill)`')
    expect(CHARTS).toContain("background: 'var(--perf-rest-tint)'")
    for (const r of [1, 2, 3]) {
      expect((TOKENS.match(new RegExp('--perf-rank' + r + '-fill:', 'g')) ?? []).length).toBe(2)
    }
    expect(TOKENS).not.toContain('--perf-rank4-fill')
  })

  it('prints NO share percentage — the denominator carries no meaning', () => {
    // RD-DASH-10. `event ÷ every event` is arithmetically valid and useless: on the audited
    // workspace it read 99.8 / 0.1 / 0.1, a restatement of the skew the ranking already
    // shows. A percentage printed because there was room for one is the same mistake as a
    // bar drawn because there was width for one.
    const panel = CHARTS.slice(CHARTS.indexOf('title="Event performance"'))
      .slice(0, CHARTS.slice(CHARTS.indexOf('title="Event performance"')).indexOf('</ChartPanel>'))
    expect(panel).not.toMatch(/toFixed\(1\)|%/)
    expect(CHARTS).not.toContain('share={perfTotal')
  })

  it('the total comes from the BUILDER, never from summing the rows on screen', () => {
    // A card that sums its own rows prints "all events" over whatever survived the Top-N
    // cut. The builder totals every compared event, including the ones it did not list.
    expect(CHARTS).toContain('const perfTotal = eventPerfMeta.confirmedTotal')
    expect(CHARTS).not.toContain('const perfTotal = sum(eventPerf)')
    expect(CHARTS).not.toMatch(/const sum = /)
    expect(ANALYT).toContain('const evTotal  = evRanked.reduce((s, e) => s + e.count, 0)')
    // Named "all events" rather than "total confirmed": Pass Distribution's footer carries a
    // SCOPED confirmed total, and two footers reading TOTAL CONFIRMED over two different
    // figures reads as a contradiction rather than as two scopes.
    expect(CHARTS).toContain("{ label: 'Confirmed · all events', text: n(perfTotal), strong: true }")
    const panel = CHARTS.slice(CHARTS.indexOf('title="Event performance"'))
    expect(panel.slice(0, panel.indexOf('</ChartPanel>'))).not.toMatch(/regTotals\./)
  })

  it('a truncated list SAYS it is truncated, with both figures from the builder', () => {
    expect(CHARTS).toContain('eventPerfMeta.eventCount > eventPerfMeta.shown')
    expect(CHARTS).toContain('${n(eventPerfMeta.shown)} shown · ${n(eventPerfMeta.eventCount)} total')
  })

  it('an event name is wrapped, never clipped', () => {
    // Two events sharing a prefix are indistinguishable once the name is truncated, and the
    // name is the first thing this card is for.
    expect(CHARTS).toContain('block break-words text-foreground')
    expect(CHARTS).not.toMatch(/truncate[\s\S]{0,80}\{label\}<\/span>\s*<span className="mt-1/)
  })

  it('each row speaks its rank, count and state — the badge stays decorative', () => {
    // RD-DASH-10 · the row carries an explicit sentence now. The <ol> alone announced a
    // position but never the unit, so "2,295" reached a screen reader as a bare number.
    expect(CHARTS).toContain('<ol className=')
    expect(CHARTS).toContain("{rank === null ? '+' : String(rank).padStart(2, '0')}")
    expect(CHARTS).toContain('`Rank ${rank}, ${label}`')
    expect(CHARTS).toContain('`${n(value)} confirmed registrations`')
    expect(CHARTS).toContain("current ? 'currently selected' : ''")
    expect(CHARTS).toContain('aria-label={spoken}')
  })

  it('the selected event is MARKED, and marking narrows nothing', () => {
    // The comparison is the whole point of this card; a comparison of one is not one.
    expect(CHARTS).toContain('current={e.slug !== null && e.slug === selectedSlug}')
    expect(CHARTS).toContain('>Selected</span>')
    // `selectedSlug` reaches the row and nothing else — never a filter, never a slice.
    expect(CHARTS).not.toMatch(/selectedSlug[^\n]*(filter|slice|===\s*e\.slug\s*\?)/)
    expect(PAGE).toContain('selectedSlug={data.scope.eventSlug}')
  })

  it('the remainder row is not an event: no rank, no state, no leader treatment', () => {
    expect(CHARTS).toContain('rank={e.slug === null ? null : i + 1}')
    expect(CHARTS).toContain('isRemainder={e.slug === null}')
    expect(ANALYT).toContain("{ slug: null, label: 'Other', count: evRest, statusLabel: null }")
  })
})

describe('the RD-DASH-05B tokens stay in step with the ones they were split from', () => {
  it('every ring stop IS an endpoint of its own gradient, in both themes', () => {
    // The stops are duplicated on purpose — an SVG <stop> takes a colour, not a gradient — so
    // this is what stops the two drifting the day somebody retunes one and not the other.
    for (const t of ['confirmed', 'pending', 'waitlisted', 'cancelled', 'rejected', 'pass']) {
      const fills = [...TOKENS.matchAll(new RegExp('--dist-' + t + '-fill:\\s*linear-gradient\\(90deg, (#[0-9A-Fa-f]{6}) 0%, (#[0-9A-Fa-f]{6}) 100%\\)', 'g'))]
      const as    = [...TOKENS.matchAll(new RegExp('--dist-' + t + '-a:\\s*(#[0-9A-Fa-f]{6})', 'g'))]
      const bs    = [...TOKENS.matchAll(new RegExp('--dist-' + t + '-b:\\s*(#[0-9A-Fa-f]{6})', 'g'))]
      expect(fills).toHaveLength(2)   // light + dark
      expect(as).toHaveLength(2)
      expect(bs).toHaveLength(2)
      for (let i = 0; i < 2; i++) {
        expect(as[i][1].toUpperCase()).toBe(fills[i][1].toUpperCase())
        expect(bs[i][1].toUpperCase()).toBe(fills[i][2].toUpperCase())
      }
    }
  })

  it('every share pill has a ground and an ink, in both themes', () => {
    for (const t of ['confirmed', 'pending', 'waitlisted', 'cancelled', 'rejected', 'pass']) {
      expect((TOKENS.match(new RegExp('--dist-' + t + '-tint:', 'g')) ?? []).length).toBe(2)
      expect((TOKENS.match(new RegExp('--dist-' + t + '-ink:', 'g')) ?? []).length).toBe(2)
    }
  })

  it('the rank badge keeps its bright stop OFF the two digits printed on it', () => {
    // A straight violet→pink ramp puts pink under the type, where white drops below AA. Each
    // gradient carries a mid stop and runs its bright end past 100%, so the brightest colour
    // lands outside the badge. Same rule the KPI card fills follow.
    for (const m of TOKENS.matchAll(/--perf-rank[123]-fill:\s*(linear-gradient\([^;]+\))/g)) {
      expect(m[1]).toMatch(/135deg/)
      expect((m[1].match(/#[0-9A-Fa-f]{6}/g) ?? []).length).toBe(3)
      expect(m[1]).toMatch(/1[0-9]{2}%\)$/)     // the bright end sits beyond the box
    }
    expect((TOKENS.match(/--perf-rank-ink:/g) ?? []).length).toBe(2)
  })

  it('the leader tile is a WASH, not a coloured panel', () => {
    // ~0.045 alpha, the same weight as the page ground. Any heavier and the card stops
    // being a white card.
    expect(TOKENS).toMatch(/--perf-lead-surface:\s*rgb\([^)]*\/ 0\.0[0-9]+\)/)
    expect((TOKENS.match(/--perf-lead-surface:/g) ?? []).length).toBe(2)
    expect((TOKENS.match(/--perf-lead-border:/g) ?? []).length).toBe(2)
  })

  it('neither redesign brought a glow, a shadow or a blur with it', () => {
    expect(CHARTS).not.toMatch(/shadow-|drop-shadow|blur-/)
    expect(TOKENS).not.toMatch(/--perf-[a-z0-9-]*:\s*[^;]*(box-shadow|blur)/)
  })

  it('leaves the frozen KPI card fills untouched', () => {
    for (const k of ['capacity', 'people', 'money', 'fees']) {
      expect(TOKENS).toContain('--kpi-' + k + '-fill:')
    }
  })
})
// ═══════════════════════════════════════════════════════════════════════════════
// RD-DASH-10 · Event Performance — identity, eligibility, and the classification that
// does not exist.
// ═══════════════════════════════════════════════════════════════════════════════

describe('no test/demo event is hidden, because nothing authoritative says which they are', () => {
  it('the codebase carries NO test/demo/sandbox classification on an event', () => {
    // Audited every field on every draft in production: zero candidates. The 29 top-level
    // draft fields contain nothing about environment, test, demo, sandbox or internal. So
    // there is nothing to filter ON, and a name-matching heuristic would be a fabrication
    // wearing the clothes of a data rule.
    // strip(): the route's comment NAMES the candidate pattern that was searched for, and
    // recording that search is the point. What must not exist is a field or a branch.
    for (const code of [strip(CHARTS), strip(ANALYT), strip(ROUTE_SRC)]) {
      for (const w of [/isTest/, /testEvent/, /isDemo/, /demoEvent/, /sandbox/i, /isInternal/]) {
        expect(code).not.toMatch(w)
      }
    }
  })

  it('no event is filtered by NAME, count, age or any other heuristic', () => {
    const code = strip(CHARTS) + strip(ANALYT)
    for (const w of [/'test'/i, /'demo'/i, /'lorem'/i, /includes\('test/i, /toLowerCase\(\)\.includes/]) {
      expect(code).not.toMatch(w)
    }
    // …and no volume or age threshold stands in for one.
    expect(code).not.toMatch(/count\s*[<>]=?\s*\d{2,}/)
  })

  it('eligibility is the EXISTING product rule, applied in the route', () => {
    // published (has a publishedAt) AND not filed under the Archived tab AND has a slug.
    // The same set every other workspace aggregate uses — not a second definition.
    expect(ROUTE_SRC).toContain("const dashboardDrafts = drafts.filter(d => d.publishedAt && !isArchivedTabEvent(d))")
    expect(ROUTE_SRC).toContain('const slugList = Array.from(new Set(')
  })

  it('the comparison spans slugList even when ONE event is selected', () => {
    // Scoping it would reduce the card to a single row and destroy the only thing it is for.
    expect(ROUTE_SRC).toContain('const crossEventAnalytics = scoped')
    expect(ROUTE_SRC).toContain('? buildDashboardAnalytics(slugList.map(slug => ({')
    expect(ROUTE_SRC).toContain('eventPerformance:         (crossEventAnalytics ?? analytics).eventPerformance')
    expect(ROUTE_SRC).toContain('eventPerformanceMeta:     (crossEventAnalytics ?? analytics).eventPerformanceMeta')
  })
})

describe('the ranked rows are built from authoritative data only', () => {
  const ev = (over: Partial<EventAnalyticsInput> = {}): EventAnalyticsInput => ({
    slug: 'e1', eventName: 'Any Event', statusLabel: 'Live',
    status: { total: 10, confirmed: 10, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
    passConfirmed: {}, passCancelled: {}, passNames: {}, ...over,
  })

  it('every row carries its slug, so two events sharing a NAME stay two rows', () => {
    const a = buildDashboardAnalytics([
      ev({ slug: 'a', eventName: 'Same Name' }),
      ev({ slug: 'b', eventName: 'Same Name', status: { total: 4, confirmed: 4, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 } }),
    ])
    expect(a.eventPerformance).toHaveLength(2)
    expect(a.eventPerformance.map(r => r.slug)).toEqual(['a', 'b'])
  })

  it('the metric is CONFIRMED, and only confirmed', () => {
    const a = buildDashboardAnalytics([ev({
      status: { total: 100, confirmed: 60, pending: 20, cancelled: 15, waitlisted: 3, rejected: 2, checkedIn: 40 },
    })])
    expect(a.eventPerformance[0].count).toBe(60)
    expect(ANALYT).toContain('count:       ev.status.confirmed,')
  })

  it('ties break deterministically, by name then by slug', () => {
    const same = { total: 5, confirmed: 5, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 }
    const rows = [ev({ slug: 'z', eventName: 'Dup', status: same }), ev({ slug: 'a', eventName: 'Dup', status: same })]
    const one = buildDashboardAnalytics(rows).eventPerformance.map(r => r.slug)
    const two = buildDashboardAnalytics([...rows].reverse()).eventPerformance.map(r => r.slug)
    expect(one).toEqual(two)
    expect(one).toEqual(['a', 'z'])
  })

  it('the state comes from the caller, resolved by the ONE shared presenter', () => {
    expect(buildDashboardAnalytics([ev({ statusLabel: 'Completed' })]).eventPerformance[0].statusLabel).toBe('Completed')
    // Never derived here — this module holds no clock and must not become a fourth surface
    // describing an event state in its own words.
    expect(ROUTE_SRC).toContain("import { presentEventStatus } from '@/lib/events/eventContext'")
    expect(strip(ANALYT)).not.toMatch(/lifecycleStatus|presentEventStatus|Date\.now/)
  })

  it('an unresolved state is absent, never guessed', () => {
    const a = buildDashboardAnalytics([ev({ statusLabel: null })])
    expect(a.eventPerformance[0].statusLabel).toBeNull()
    expect(CHARTS).toContain('{statusLabel && (')
  })

  it('the meta counts every compared event, not the rows that survived the cut', () => {
    const many = Array.from({ length: DISPLAY_LIMIT + 4 }, (_, i) =>
      ev({ slug: 's' + i, eventName: 'E' + i, status: { total: 1, confirmed: DISPLAY_LIMIT + 4 - i, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 } }))
    const a = buildDashboardAnalytics(many)
    expect(a.eventPerformanceMeta.eventCount).toBe(DISPLAY_LIMIT + 4)
    expect(a.eventPerformanceMeta.shown).toBe(DISPLAY_LIMIT)
    // Σ over ALL of them, remainder included.
    expect(a.eventPerformanceMeta.confirmedTotal)
      .toBe(a.eventPerformance.reduce((s, r) => s + r.count, 0))
    // …and the remainder row is present so nothing is silently dropped.
    expect(a.eventPerformance.filter(r => r.slug === null)).toHaveLength(1)
  })

  it('an event whose counters could not be read is EXCLUDED, never ranked as zero', () => {
    const a = buildDashboardAnalytics([ev({ status: null })])
    expect(a.eventPerformance).toHaveLength(0)
    expect(a.statusUnavailable).toBe(true)
  })

  it('a missing event name falls back without losing the row', () => {
    expect(ROUTE_SRC).toContain("eventNameBySlug.get(slug) ?? 'Untitled Event'")
  })
})

describe('the two absences are different messages', () => {
  it('no eligible event says so; eligible events with nothing confirmed say something else', () => {
    expect(CHARTS).toContain("? 'No published events yet.'")
    expect(CHARTS).toContain(": 'No confirmed registrations across your events yet.'")
    expect(CHARTS).toContain('eventPerfMeta.eventCount === 0')
  })

  it('an unreadable comparison is a FAILURE state, never an empty ranking', () => {
    expect(CHARTS).toContain('unavailable={analyticsUnavailable}')
    expect(CHARTS).toContain('so this is not shown as zero')
  })
})