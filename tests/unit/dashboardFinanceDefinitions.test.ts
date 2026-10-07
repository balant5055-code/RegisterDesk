// RD-DASH-02 · The Overview dashboard is a VIEW over authoritative finance figures.
//
// The audit found the Finance Summary card computing `platformFee = gross − netSettlement`.
// Under an attendee-pays model the attendee bore the fees, so the organizer receives the full
// gross and that subtraction is structurally ZERO — a real event charged ₹3,941.34 in platform
// fees and the card reported ₹0. The wallet rollup consulted in all-events mode stored the
// same subtraction, materialised, so it was ₹0 there too.
//
// What these tests defend is the RULE, not any figure: every money value on this screen is a
// named field from the resolver that owns it, and no arithmetic on money happens in the route's
// assembly, in page.tsx, or in a chart component. No event id, slug or total appears here.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildDashboardAnalytics } from '@/lib/analytics/dashboardAnalytics'

const src = (p: string) => readFileSync(p, 'utf8')

const ROUTE  = src('app/api/organizer/dashboard/route.ts')
const PAGE   = src('app/(dashboard)/dashboard/page.tsx')
const CHARTS = src('components/dashboard/DashboardCharts.tsx')

/** The settlement assembly block — where every Finance Summary field is produced. */
const settlement = (() => {
  const i = ROUTE.indexOf('      settlement: {')
  return ROUTE.slice(i, ROUTE.indexOf('      },', i) + 8)
})()

/** The Finance Summary card body in the page. */
const financeCard = (() => {
  const i = PAGE.indexOf('{data.settlement && (() => {')
  return PAGE.slice(i, PAGE.indexOf('})()}', i) + 5)
})()

// ═══ 1 + 2 · platform fee is a field, not a subtraction ══════════════════════

describe('the Finance Summary never derives platform fee', () => {
  it('does not subtract net from gross anywhere in the route', () => {
    expect(ROUTE).not.toMatch(/scopedGross\s*-\s*scopedNet/)
    expect(ROUTE).not.toMatch(/grossPaise\s*-\s*net\w*Paise/)
    expect(ROUTE).not.toMatch(/const usingLedger/)
  })

  it('reads platformFeeTotal from the resolver', () => {
    expect(settlement).toContain('platformFeeTotalPaise:  ledger ? ledgerMoney(ledger.platformFeeTotal)')
  })

  it('publishes the platform components separately from the total', () => {
    expect(settlement).toContain('platformFeeBasePaise:   ledger ? ledgerMoney(ledger.platformFeeBase)')
    expect(settlement).toContain('platformFeeGstPaise:    ledger ? ledgerMoney(ledger.platformFeeGst)')
  })

  it('no longer falls back to the wallet rollup, which stored the same subtraction', () => {
    expect(ROUTE).not.toMatch(/lifetimeFeesPaise/)
    expect(ROUTE).not.toMatch(/lifetimeGrossPaise/)
    expect(ROUTE).not.toMatch(/lifetimeNetPaise/)
    expect(ROUTE).not.toMatch(/organizerRevenueWallets\/\$\{uid\}/)
  })
})

// ═══ 3 · attendee paid ═══════════════════════════════════════════════════════

describe('attendee-paid comes from the canonical reader', () => {
  it('uses getAttendeePaid, not a locally summed amount', () => {
    // RD-FIN-02 · the card's own population (event scope, or every owned event in all-events mode).
    expect(ROUTE).toContain('getAttendeePaid(settlementSlugs, ATTENDEE_PAID_STATUSES)')
    expect(settlement).toContain('attendeePaidPaise:      attendeePaidRead ? ledgerMoney(attendeePaidRead.totalPaise)')
  })

  it('covers the same statuses the finance page measures', () => {
    expect(ROUTE).toContain("const ATTENDEE_PAID_STATUSES = ['confirmed', 'cancelled'] as const")
  })

  it('ticket value is published as its own field, not as "collected"', () => {
    expect(settlement).toContain('ticketValuePaise:       ledger ? ledgerMoney(ledger.grossPaise)')
    expect(PAGE).not.toContain('Collected (gateway)')
    expect(financeCard).toContain('label="Attendee paid"')
    expect(financeCard).toContain('label="Ticket value"')
  })
})

// ═══ 4 + 5 + 6 · gateway fee, its basis, and its tax ═════════════════════════

describe('the gateway fee carries its basis and contains its tax', () => {
  it('uses the resolved gateway fee rather than either raw field', () => {
    expect(settlement).toContain('gatewayFeePaise:        ledgerGateway ? ledgerMoney(ledgerGateway.fee)')
    expect(settlement).not.toMatch(/gatewayFeeEstimatePaise/)
  })

  it('ships the basis so the client never infers it', () => {
    expect(settlement).toContain('gatewayFeeBasis:        ledgerGateway ? ledgerGateway.basis')
    expect(financeCard).toContain('s.gatewayFeeBasis')
  })

  it('names all three basis states, and never labels an estimate "actual"', () => {
    expect(financeCard).toMatch(/'Actual'/)
    expect(financeCard).toMatch(/'Part actual'/)
    expect(financeCard).toMatch(/'Estimated'/)
    // The label is derived from the basis alone; the amount from the resolved field alone.
    // The basis is a NOTE beside the figure rather than glued into the label, so the row
    // reads as one fee with a qualifier instead of two different fee names.
    expect(financeCard).toContain('label="Razorpay fee" note={basisLabel}')
    expect(financeCard).toContain('money(s.gatewayFeePaise)')
  })

  it('never adds the tax to the fee, on the server or in the card', () => {
    expect(ROUTE).not.toMatch(/gatewayFeePaise\s*\+\s*\w*[Tt]ax/)
    expect(ROUTE).not.toMatch(/[Tt]ax\w*\s*\+\s*gatewayFee/)
    expect(PAGE).not.toMatch(/gatewayTaxPaise\s*\+/)
    expect(PAGE).not.toMatch(/\+\s*s\.gatewayTaxPaise/)
  })

  it('says in the UI that the tax is contained, not additional', () => {
    expect(financeCard).toMatch(/contained WITHIN/i)
  })
})

// ═══ 7 · total fees ══════════════════════════════════════════════════════════

describe('total fees is read, not assembled', () => {
  it('comes from the resolver', () => {
    expect(settlement).toContain('totalFeesPaise:         ledger ? ledgerMoney(ledger.totalFees)')
  })

  it('is not recomputed in the route or the page', () => {
    expect(ROUTE).not.toMatch(/platformFeeTotalPaise\s*\+\s*gatewayFeePaise/)
    expect(PAGE).not.toMatch(/platformFee\w*\s*\+\s*gateway/)
    expect(financeCard).toContain('money(s.totalFeesPaise)')
  })
})

// ═══ 8 · refunds ═════════════════════════════════════════════════════════════

describe('refunds come from the canonical refund reader', () => {
  it('uses getRefundTotals with the same scope object as the ledger', () => {
    expect(ROUTE).toContain('getRefundTotals({')
    expect(ROUTE).toMatch(/eventSlug:\s+scoped \? selectedSlug : null/)
  })

  it('publishes both the amount and the count', () => {
    expect(settlement).toContain('refundsPaise:           refundRead ? ledgerMoney(refundRead.amount)')
    expect(settlement).toContain('refundCount:            refundRead ? refundRead.count')
  })

  it('is never derived from registration or payment status', () => {
    expect(settlement).not.toMatch(/paymentStatus/)
    expect(settlement).not.toMatch(/cancelled/)
  })
})

// ═══ 9 · organizer payable ═══════════════════════════════════════════════════

describe('organizer payable is the stored settlement', () => {
  it('is read straight from the resolver', () => {
    expect(settlement).toContain('organizerPayablePaise:  ledger ? ledgerMoney(ledger.organizerPayable)')
  })

  it('is not reconstructed from gross and fees in the card', () => {
    expect(financeCard).toContain('money(s.organizerPayablePaise)')
    expect(financeCard).not.toMatch(/attendeePaidPaise\s*-\s*/)
    expect(financeCard).not.toMatch(/totalFeesPaise\s*-\s*/)
  })

  it('communication cost states its scope instead of implying the event', () => {
    expect(ROUTE).toContain("const communicationCostScope: CommunicationCostScope = 'workspace'")
    expect(financeCard).toContain("label=\"Communication cost\"")
    expect(financeCard).toContain("note={s.communicationCostScope === 'workspace' ? 'workspace' : undefined}")
  })
})

// ═══ THE ARCHITECTURE RULE ═══════════════════════════════════════════════════

describe('no money arithmetic survives in the view layer', () => {
  it('the Finance Summary card only formats what it is given', () => {
    // Every money expression in the card must be `money(s.<field>)` or rupees(...).
    const exprs = financeCard.match(/value=\{[^}]*\}/g) ?? []
    expect(exprs.length).toBeGreaterThan(5)
    for (const e of exprs) {
      expect(e).not.toMatch(/[+\-*/]\s*s\./)
      expect(e).toMatch(/money\(s\.|rupees\(s\./)
    }
  })

  it('the page defines no fee rate or fee formula', () => {
    expect(PAGE).not.toMatch(/platformFeeRateBps/)
    expect(ROUTE).not.toMatch(/platformFeeRateBps/)
    expect(PAGE).not.toMatch(/\*\s*10_000/)
  })
})

// ═══ 10 · the registration KPI ═══════════════════════════════════════════════

describe('confirmed registrations is distinct from total registrations', () => {
  it('the KPI names what counter.totalCount actually counts', () => {
    expect(PAGE).toContain('label="Confirmed registrations"')
    expect(PAGE).not.toContain('label="Total registrations"')
  })

  it('the Registration Status panel names the all-status total', () => {
    // RD-DASH-05B moved the figure out of the subtitle and into the middle of the status
    // ring, next to the label saying what it counts — one statement instead of three. The
    // subtitle keeps the scope, which is the only thing it uniquely knows.
    expect(CHARTS).toContain('>Total registrations</span>')
    expect(CHARTS).toContain('subtitle={`Every status · ${scopeLabel}, all time`}')
  })

  it('the underlying counter figure is unchanged', () => {
    expect(PAGE).toContain("value={overview.totalRegistrations.toLocaleString('en-IN')}")
  })
})

// ═══ 11 + 12 · pass distribution ═════════════════════════════════════════════

describe('pass distribution uses one denominator and invents no categories', () => {
  it('the share denominator is the authoritative confirmed total', () => {
    expect(CHARTS).toContain('const passTotal = confirmedTotal ?? passDist.reduce')
    expect(PAGE).toContain('confirmedTotal={data.registrationTotals.confirmed}')
  })

  it('a row no longer prints a confirmed+cancelled total beside a confirmed share', () => {
    expect(CHARTS).not.toMatch(/\{n\(p\.total\)\} total/)
    expect(CHARTS).toContain('cancelled')
  })

  it('an event type with no passes gets a neutral empty state', () => {
    expect(CHARTS).toContain('passDataAvailable')
    expect(CHARTS).toContain('No pass distribution available for this event.')
  })

  it('the flag is computed from real configured passes, never guessed', () => {
    // No pass configured anywhere ⇒ everything lands in Unattributed ⇒ not a distribution.
    const none = buildDashboardAnalytics([{
      slug: 'e1', eventName: 'Any Event',
      status: { total: 5, confirmed: 5, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
      passConfirmed: {}, passCancelled: {}, passNames: {},
    }])
    expect(none.passDataAvailable).toBe(false)
    expect(none.passDistribution.every(r => r.label === 'Unattributed')).toBe(true)

    const some = buildDashboardAnalytics([{
      slug: 'e1', eventName: 'Any Event',
      status: { total: 5, confirmed: 5, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 },
      passConfirmed: { p1: 5 }, passCancelled: {}, passNames: { p1: 'Standard entry' },
    }])
    expect(some.passDataAvailable).toBe(true)
  })

  it('carries no running-, distance- or marathon-specific assumption', () => {
    const code = src('lib/analytics/dashboardAnalytics.ts')
    for (const word of [/marathon/i, /\brunning\b/i, /\bdistance\b/i, /\bkm\b/i]) {
      expect(code).not.toMatch(word)
      expect(CHARTS).not.toMatch(word)
    }
  })
})

// ═══ 13 + 14 · event performance ═════════════════════════════════════════════

describe('event performance stays workspace-wide', () => {
  it('is built from the full slug set even when an event is selected', () => {
    expect(ROUTE).toContain('const crossEventAnalytics = scoped')
    expect(ROUTE).toContain('? buildDashboardAnalytics(slugList.map(slug => ({')
    expect(ROUTE).toContain('eventPerformance:         (crossEventAnalytics ?? analytics).eventPerformance')
  })

  it('selecting an event cannot narrow it to scopedSlugs', () => {
    const i = ROUTE.indexOf('eventPerformance:         (crossEventAnalytics')
    expect(ROUTE.slice(i, i + 120)).not.toContain('scopedSlugs')
  })

  it('records the test-event gap rather than inventing a flag for it', () => {
    expect(ROUTE).toMatch(/TODO \(RD-DASH-02 finding/)
    expect(ROUTE).toContain('carries NO authoritative test / internal /')
    // RD-DASH-10 re-verified the finding against production and recorded HOW.
    expect(ROUTE).toContain('RE-VERIFIED empirically by RD-DASH-10')
    expect(ROUTE).toContain('correlation is not a classification')
  })

  it('compares confirmed registrations only', () => {
    // RD-DASH-10 gave the row its slug and its resolved state; the METRIC is unchanged.
    const analyt = src('lib/analytics/dashboardAnalytics.ts')
    expect(analyt).toContain('count:       ev.status.confirmed,')
    expect(analyt).toContain('slug:        ev.slug,')
    expect(analyt).toContain('label:       ev.eventName,')
  })
})

// ═══ Recent activity ═════════════════════════════════════════════════════════

describe('the activity feed halves share one definition of recent', () => {
  it('both queries apply the same time boundary', () => {
    // RD-DASH-03: ONE window, applied to both streams by the shared reader. That is the
    // strongest form of "the same definition of recent" — there is only one place to set it,
    // so the two halves cannot drift apart again.
    const feed = src('lib/dashboard/activityFeed.ts') + src('lib/dashboard/activityCursor.ts')
    expect(feed).toContain("scoped.where(field, '>=', Timestamp.fromDate(scope.since))")
    expect(ROUTE).toContain('since:          cutoff90,')
  })

  it('both are scoped server-side, not filtered after a broad read', () => {
    // RD-DASH-03: both streams are scoped by ONE helper that pushes the event set into the
    // query, so there is no longer a pair of hand-written scoped queries to count.
    const feed = src('lib/dashboard/activityFeed.ts') + src('lib/dashboard/activityCursor.ts')
    expect(feed).toContain("function applyScope(")
    expect(feed).toContain("where('eventSlug', '==', scope.eventSlug)")
    expect(feed).toContain("where('eventSlug', 'in', scope.dashboardSlugs)")
  })

  it('keeps stable sorting, per-row isolation and skipped-row disclosure', () => {
    const feed = src('lib/dashboard/activityFeed.ts') + src('lib/dashboard/activityCursor.ts')
    const card = src('components/dashboard/RecentActivityCard.tsx')
    expect(feed).toContain('|| a.type.localeCompare(b.type)')
    expect(feed).toContain('skipped++')
    expect(card).toContain('could not be read and')
  })
})

// ═══ Safety ══════════════════════════════════════════════════════════════════

describe('the dashboard writes nothing and calls nothing', () => {
  it('performs no Firestore write', () => {
    for (const code of [ROUTE, PAGE, CHARTS]) {
      expect(code).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
      expect(code).not.toMatch(/collection\([^)]*\)\s*\.\s*add\(/)
      expect(code).not.toMatch(/runTransaction|bulkWriter|\bFieldValue\b/)
    }
  })

  it('imports no Razorpay client', () => {
    for (const code of [ROUTE, PAGE, CHARTS]) {
      expect(code.toLowerCase()).not.toContain("from 'razorpay'")
      expect(code).not.toMatch(/lib\/razorpay\/client/)
      expect(code).not.toMatch(/payments\s*\.\s*(refund|capture)/)
    }
  })

  it('hardcodes no event identifier or reconciled total', () => {
    for (const code of [ROUTE, PAGE, CHARTS, src('lib/analytics/dashboardAnalytics.ts')]) {
      expect(code).not.toMatch(/noyyal/i)
      expect(code).not.toMatch(/\bpay_[A-Za-z0-9]{8,}/)
      expect(code).not.toMatch(/\brfnd_[A-Za-z0-9]{8,}/)
      expect(code).not.toMatch(/3,?44,?737|3,?34,?011|3,?941\.34|8,?162\.65/)
    }
  })
})
