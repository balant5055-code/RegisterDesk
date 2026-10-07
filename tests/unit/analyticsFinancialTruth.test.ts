// RD-ANALYTICS-02 — Analytics financial figures on RegisterDesk's canonical bases.
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// Four separate defects, all of them producing a plausible number:
//
//   REVENUE      Σ amount over paymentStatus 'paid'. That counts a CANCELLED registration
//                that was paid, and drops a CONFIRMED one that was later refunded — the
//                exact opposite of the canonical rule, which is refund-STABLE. The figure
//                was then overwritten by the payment ledger's gross whenever that read
//                succeeded, so the same KPI silently changed basis with nothing on screen
//                to say which one the organizer was looking at.
//   REFUNDS      `refundAmount ?? amount`, over registrations whose paymentStatus mentioned
//                a refund. For `refund_pending` — where refundAmount does not exist yet —
//                that booked the ENTIRE ticket price as refunded money.
//   IN FLIGHT    `refunded` and `refund_pending` were added into one counter, so a refund
//                that had not happened counted as one that had.
//   FREE/PENDING `pay === 'not_required' || amount === 0` sat in an else-if chain ABOVE the
//                'pending' arm, so a zero-amount registration awaiting payment was filed
//                as Free and vanished from Pending.
//
// ═══ HOW THIS SUITE WORKS ════════════════════════════════════════════════════
// The REAL canonical reader (sumConfirmedRevenueFromLedgerChecked) runs against a fake
// Firestore that honours `where` and `aggregate(sum)`. So "cancelled+paid is excluded" is
// decided by the shared helper Dashboard, Events and Finance all call — not by an
// expectation written here. That is also the reconciliation guarantee: Analytics cannot
// drift from the Dashboard without this suite failing.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { dayKeyRange } from '@/lib/dashboard/dailyStats'

const EVENT_ID = 'fin-event'
const OWNER    = 'ws-owner'

interface Row { status: string; paymentStatus: string; amount: number; [k: string]: unknown }
let ROWS: Row[] = []
let FAILING = new Set<string>()
/** Fails ONLY the sum() aggregate, so the canonical reader can be broken in isolation. */
let FAIL_AGGREGATE = false

const docs: Record<string, Record<string, unknown>> = {}

/** Honours equality filters and a sum() aggregate — enough for the canonical reader. */
class FakeQuery {
  constructor(
    readonly name: string,
    readonly rows: Record<string, unknown>[],
    readonly wheres: [string, unknown][] = [],
  ) {}
  where(field: string, _op: string, value: unknown) {
    return new FakeQuery(this.name, this.rows, [...this.wheres, [field, value]])
  }
  /**
   * RD-ANALYTICS-03 · Firestore's orderBy EXCLUDES documents missing the field, which is
   * exactly how aggregateRegistrationStatusCounts counts check-ins (orderBy('checkedInAt')).
   * Modelling that is the difference between counting the checked-in and counting everyone.
   */
  orderBy(field?: string) {
    return field
      ? new FakeQuery(this.name, this.rows.filter(r => r[field] !== undefined && r[field] !== null), this.wheres)
      : this
  }
  /** count() aggregate — zero documents, like the real one. */
  count() {
    const rows = this.matched()
    const failing = FAILING.has(this.name)
    return { async get() {
      if (failing) throw new Error('count failed')
      return { data: () => ({ count: rows.length }) }
    } }
  }
  /**
   * RD-ANALYTICS-09 · the fake now HONOURS limit.
   *
   * It used to ignore it, which made a truncated ledger read indistinguishable from a
   * complete one — so the defect where 5,001 platform transactions were summed as a total
   * could not be reproduced here at all. Modelling the bound is what lets a test prove the
   * producer refuses to publish a partial sum.
   */
  limit(n?: number) {
    return typeof n === 'number'
      ? new FakeQuery(this.name, this.rows.slice(0, n), this.wheres)
      : this
  }
  select() { return this }
  matched() {
    // registrations scope by eventSlug, platformTransactions by entityId, emailLogs and
    // the rest by eventId. Treat all three as "this event" so the fixtures stay readable.
    const EVENT_KEYS = new Set(['eventSlug', 'entityId', 'eventId'])
    return this.rows.filter(r => this.wheres.every(([f, v]) => (EVENT_KEYS.has(f) ? EVENT_ID : r[f]) === v))
  }
  /**
   * sum() over the requested FIELD.
   *
   * RD-ANALYTICS-11 · it used to sum `amount` whatever was asked for, which was true while
   * the ledger was the only aggregate on this path. Messaging spend is now
   * `sum('costPaise')`, and a fake that answered it with the ledger's field would have
   * reported every event's communications as free — a zero the producer would then have
   * published as a measurement.
   */
  aggregate(spec: Record<string, { _field?: string }>) {
    const rows = this.matched()
    const failing = FAILING.has(this.name) || FAIL_AGGREGATE
    return {
      async get() {
        if (failing) throw new Error('aggregate failed')
        return { data: () => Object.fromEntries(Object.entries(spec).map(([k, f]) => {
          const field = String(f?._field ?? 'amount')
          return [k, rows.reduce((s, r) => s + (typeof r[field] === 'number' ? r[field] as number : 0), 0)]
        })) }
      },
    }
  }
  async get() {
    if (FAILING.has(this.name)) throw new Error(`FAILED_PRECONDITION: ${this.name}`)
    const rows = this.matched()
    return {
      empty: rows.length === 0,
      size:  rows.length,
      docs:  rows.map((d, i) => ({ id: `${this.name}-${i}`, exists: true, data: () => d })),
    }
  }
}

const COUNTER: Record<string, unknown> = { passCounts: { 'pass-a': 3 } }

const OTHER: Record<string, Record<string, unknown>[]> = {
  platformTransactions: [],
  emailLogs:            [{ status: 'sent', costPaise: 300, templateKey: 'welcome' }],
  scheduledReminders:   [],
  certificates:         [],
}

/** organizerDailyStats rows, keyed by the deterministic doc id. */
const DAILY: Record<string, Record<string, unknown>> = {}

const fakeDoc = (path: string) => ({
  async get() {
    const id = path.split('/').pop() ?? ''
    const d = path.startsWith('registrationCounters/') ? COUNTER : (docs[path] ?? DAILY[id])
    return { exists: !!d, data: () => d }
  },
  // getRegistrationCounter reads an attendance-shard subcollection.
  collection: (sub: string) => new FakeQuery(sub, []),
})

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (name: string) => Object.assign(
      new FakeQuery(name, name === 'registrations' ? (ROWS as unknown as Record<string, unknown>[]) : (OTHER[name] ?? [])),
      { doc: (id: string) => fakeDoc(`${name}/${id}`) },
    ),
    doc: fakeDoc,
    // readDailyStats reads the rollups with ONE getAll of computed ids — no query.
    getAll: async (...refs: { get(): Promise<unknown> }[]) => Promise.all(refs.map(r => r.get())),
  },
}))

vi.mock('@/lib/analytics/couponPerformance', () => ({
  EMPTY_COUPON_PERFORMANCE: { rows: [], totalRedemptions: 0, activeCoupons: 0, totalCoupons: 0, totalDiscountPaise: 0, discountUnavailable: true },
  getCouponPerformance: async () => ({ rows: [], totalRedemptions: 0, activeCoupons: 0, totalCoupons: 0, totalDiscountPaise: 500, discountUnavailable: false }),
}))

/** The refund LEDGER. Controlled per-test; never derived from a registration. */
let REFUNDS: { count: number | null; amount: { ok: true; paise: number } | { ok: false; reason: string } } =
  { count: 2, amount: { ok: true, paise: 15_000 } }

vi.mock('@/lib/finance/financeAnalytics', async orig => ({
  ...(await orig<typeof import('@/lib/finance/financeAnalytics')>()),
  // RE-ANCHORED (RD-ANALYTICS-12-32). The producer acquires the refund SOURCE once and
  // derives lifetime / window / baseline from it; the fixture still controls the totals.
  readRefundSource:     async () => ({ records: [], recovered: 0, ownedCount: 0, complete: true }),
  refundTotalsFromRead: () => ({ ...REFUNDS, unlinked: 0, recovered: 0, complete: true }),
}))

const reg = (status: string, paymentStatus: string, amount: number, extra: Record<string, unknown> = {}): Row => ({
  // organizerUid is REQUIRED: every canonical aggregate scopes on organizerUid +
  // eventSlug, so a fixture without it is invisible to the real readers.
  organizerUid: OWNER, eventSlug: EVENT_ID,
  status, paymentStatus, amount, passName: 'General', eventName: 'Fin Event',
  ticketCode: 'TC', checkedIn: false,
  attendee: { name: 'A', email: 'a@b.c', formResponses: {} }, ...extra,
})

const run = async (includeFinancial = true) => {
  const { getEventAnalytics } = await import('@/lib/analytics/eventAnalytics')
  const out = await getEventAnalytics(EVENT_ID, { includeFinancial })
  if (!out) throw new Error('event not resolved')
  return out.analytics
}

beforeEach(() => {
  FAILING = new Set()
  FAIL_AGGREGATE = false
  for (const k of Object.keys(DAILY)) delete DAILY[k]
  // Rollup coverage reaching back further than any window under test, so these cases
  // measure reporting fidelity rather than the coverage clip (which test 14c owns).
  DAILY[`${OWNER}__meta`] = { organizerUid: OWNER, since: '2000-01-01', backfilledAt: null }
  ROWS = []
  REFUNDS = { count: 2, amount: { ok: true, paise: 15_000 } }
  OTHER.platformTransactions = []
  docs[`events/${EVENT_ID}`] = { uid: OWNER, draftId: 'draft-A',
    pricing: { passes: [{ id: 'pass-a', name: 'General' }] },
    eventDetails: { info: { name: 'Fin Event' } } }
})

// ─── 1–6, 19 · Canonical confirmed ticket revenue ────────────────────────────

describe('RD-ANALYTICS-02 · canonical confirmed ticket revenue', () => {
  /** One fixture exercising every status against the canonical rule. */
  const mixed = () => [
    reg('confirmed', 'paid',           10_000),   // ✓ counted
    reg('confirmed', 'refunded',       20_000),   // ✓ counted — the rule is refund-STABLE
    reg('cancelled', 'paid',           50_000),   // ✗
    reg('pending',   'pending',        30_000),   // ✗
    reg('waitlisted','pending',        40_000),   // ✗
    reg('rejected',  'paid',           60_000),   // ✗
    reg('confirmed', 'refund_pending', 70_000),   // ✓ still confirmed
  ]
  const EXPECTED = 10_000 + 20_000 + 70_000

  it('1 · a confirmed + paid registration contributes', async () => {
    ROWS = [reg('confirmed', 'paid', 10_000)]
    expect((await run()).financial!.confirmedRevenuePaise).toEqual({ ok: true, paise: 10_000 })
  })

  it('2 · a confirmed + REFUNDED registration remains part of confirmed revenue', async () => {
    // The canonical definition is refund-stable on purpose: a refund leaves the status
    // 'confirmed' and does not rewrite `amount`, so the ticket revenue figure does not move.
    ROWS = [reg('confirmed', 'refunded', 20_000)]
    expect((await run()).financial!.confirmedRevenuePaise).toEqual({ ok: true, paise: 20_000 })
  })

  it('3 · a CANCELLED + paid registration does NOT contribute', async () => {
    // This is the one the old `paymentStatus === 'paid'` rule got backwards.
    ROWS = [reg('cancelled', 'paid', 50_000)]
    expect((await run()).financial!.confirmedRevenuePaise).toEqual({ ok: true, paise: 0 })
  })

  it('4 · a pending registration does NOT contribute', async () => {
    ROWS = [reg('pending', 'pending', 30_000)]
    expect((await run()).financial!.confirmedRevenuePaise).toEqual({ ok: true, paise: 0 })
  })

  it('5 · a waitlisted registration does NOT contribute', async () => {
    ROWS = [reg('waitlisted', 'pending', 40_000)]
    expect((await run()).financial!.confirmedRevenuePaise).toEqual({ ok: true, paise: 0 })
  })

  it('6 · a rejected registration does NOT contribute', async () => {
    ROWS = [reg('rejected', 'paid', 60_000)]
    expect((await run()).financial!.confirmedRevenuePaise).toEqual({ ok: true, paise: 0 })
  })

  it('6b · the whole mixed fixture resolves to exactly the confirmed rows', async () => {
    ROWS = mixed()
    expect((await run()).financial!.confirmedRevenuePaise).toEqual({ ok: true, paise: EXPECTED })
  })

  it('19 · Analytics and the Dashboard/Finance reader return the SAME figure', async () => {
    // Reconciliation, proven by calling the ONE shared helper — not by re-implementing its
    // rule here. If Analytics ever grows its own revenue sum again, these diverge.
    ROWS = mixed()
    const { sumConfirmedRevenueFromLedgerChecked } =
      await import('@/lib/firebase/firestore/registrationCounters')
    const canonical = await sumConfirmedRevenueFromLedgerChecked(EVENT_ID)
    const analytics = (await run()).financial!.confirmedRevenuePaise

    expect(canonical).toEqual({ value: EXPECTED, ok: true })
    expect(analytics.ok && analytics.paise).toBe(canonical.value)
  })

  it('19b · the gateway gross is a SEPARATE figure, never a substitute for it', async () => {
    ROWS = mixed()
    OTHER.platformTransactions = [{ grossAmountPaise: 999_999, platformFeeBasePaise: 1_000,
      platformFeeGstPaise: 180, gatewayFeeEstimatePaise: 900, netSettlementPaise: 997_919 }]
    const f = (await run()).financial!
    expect(f.grossPaise).toEqual({ ok: true, paise: 999_999 })
    expect(f.confirmedRevenuePaise).toEqual({ ok: true, paise: EXPECTED })
    // The two must not be the same number by construction.
    expect(f.grossPaise).not.toEqual(f.confirmedRevenuePaise)
  })

  it('12 · a failed canonical read is unavailable, NOT ₹0', async () => {
    ROWS = [reg('confirmed', 'paid', 10_000)]
    FAIL_AGGREGATE = true
    const f = (await run()).financial!
    expect(f.confirmedRevenuePaise.ok).toBe(false)
  })
})

// ─── 7–9 · Refunds ───────────────────────────────────────────────────────────

describe('RD-ANALYTICS-02 · refunds come from the refund ledger', () => {
  it('8 · the refunded amount is the canonical reader\'s, not a registration-derived sum', async () => {
    ROWS = [reg('confirmed', 'refunded', 20_000)]
    REFUNDS = { count: 2, amount: { ok: true, paise: 15_000 } }
    const f = (await run()).financial!
    // 15,000 is the LEDGER's figure. A registration-derived sum would have said 20,000.
    expect(f.refundsPaise).toEqual({ ok: true, paise: 15_000 })
    expect(f.refundCount).toBe(2)
  })

  it('7 · refund_pending is NOT counted as a completed refund', async () => {
    ROWS = [reg('confirmed', 'refund_pending', 70_000)]
    REFUNDS = { count: 0, amount: { ok: true, paise: 0 } }
    const a = await run()
    expect(a.financial!.refundsPaise).toEqual({ ok: true, paise: 0 })
    expect(a.kpis.refundPending).toBe(1)
    expect(a.kpis.refunded).toBe(0)          // the two counters are no longer added together
  })

  it('9 · refund_pending with NO refundAmount does not book the whole ticket as refunded', async () => {
    // The precise old bug: `refundAmount ?? amount` on a row that has no refundAmount yet.
    ROWS = [reg('confirmed', 'refund_pending', 70_000)]   // deliberately no refundAmount
    REFUNDS = { count: 0, amount: { ok: true, paise: 0 } }
    const f = (await run()).financial!
    expect(f.refundsPaise).toEqual({ ok: true, paise: 0 })
    expect(f.refundsPaise.ok && f.refundsPaise.paise).not.toBe(70_000)
  })

  it('9b · a registration-level refundAmount is ignored entirely', async () => {
    ROWS = [reg('confirmed', 'refunded', 20_000, { refundAmount: 18_000 })]
    REFUNDS = { count: 1, amount: { ok: true, paise: 12_000 } }
    const f = (await run()).financial!
    expect(f.refundsPaise).toEqual({ ok: true, paise: 12_000 })   // the ledger, not 18,000
  })

  it('9c · refunded and refund_pending are counted separately', async () => {
    ROWS = [
      reg('confirmed', 'refunded', 10_000),
      reg('confirmed', 'refund_pending', 20_000),
      reg('confirmed', 'refund_pending', 30_000),
    ]
    const k = (await run()).kpis
    expect(k.refunded).toBe(1)
    expect(k.refundPending).toBe(2)
  })

  it('a failed refund ledger read is unavailable, not zero refunds', async () => {
    ROWS = [reg('confirmed', 'paid', 10_000)]
    REFUNDS = { count: null, amount: { ok: false, reason: 'query_failed' } }
    const f = (await run()).financial!
    expect(f.refundsPaise.ok).toBe(false)
    expect(f.refundCount).toBeNull()
  })
})

// ─── 10–11 · Free vs pending ─────────────────────────────────────────────────

describe('RD-ANALYTICS-02 · free vs pending classification', () => {
  it('10 · a ZERO-amount payment-pending registration is Pending, not Free', async () => {
    // The regression the else-if chain caused: `amount === 0` matched the Free arm first.
    //
    // RE-ANCHORED (RD-ANALYTICS-03): the counts now come from two different aggregates, so
    // `pending` is REGISTRATION status and `paymentPending` is payment status. This row is
    // status-confirmed / payment-pending, and the field carrying the rule under test is
    // `paymentPending` — which is what the UI's "Pending" card reads.
    ROWS = [reg('confirmed', 'pending', 0)]
    const k = (await run()).kpis
    expect(k.paymentPending).toBe(1)
    expect(k.free).toBe(0)
    expect(k.pending).toBe(0)          // no registration is in the pending STATUS
  })

  it('11 · a genuine not_required registration is Free', async () => {
    ROWS = [reg('confirmed', 'not_required', 0)]
    const k = (await run()).kpis
    expect(k.free).toBe(1)
    expect(k.pending).toBe(0)
  })

  it('11b · a PAID registration that happens to cost 0 is Paid, not Free', async () => {
    // A fully discounted ticket on a paid event. What was owed is not what was paid.
    ROWS = [reg('confirmed', 'paid', 0)]
    const k = (await run()).kpis
    expect(k.paid).toBe(1)
    expect(k.free).toBe(0)
  })

  it('11c · every arm is exclusive — the counters sum to the population', async () => {
    ROWS = [
      reg('confirmed', 'paid', 100), reg('confirmed', 'not_required', 0),
      reg('pending', 'pending', 0),  reg('confirmed', 'refunded', 100),
      reg('confirmed', 'refund_pending', 100),
    ]
    const k = (await run()).kpis
    expect(k.paid + k.free + k.pending + k.refunded + k.refundPending).toBe(5)
  })

  it('11d · an unrecognised paymentStatus is claimed by no counter', async () => {
    ROWS = [reg('confirmed', 'weird_new_status', 100)]
    const k = (await run()).kpis
    expect((k.paid ?? 0) + (k.free ?? 0) + (k.paymentPending ?? 0) + (k.refunded ?? 0) + (k.refundPending ?? 0)).toBe(0)
    // …and it is still ACCOUNTED FOR. RE-ANCHORED: a count() aggregate can only count the
    // statuses it was asked for, so an unrecognised value can no longer appear under its own
    // name. It appears as the residual instead, which keeps the breakdown summing to the
    // event — the alternative was letting it vanish.
    const breakdown = (await run()).paymentStatus
    expect(breakdown.map(p => p.label)).toContain('other')
    expect(breakdown.find(p => p.label === 'other')!.value).toBe(1)
  })
})

// ─── 20 · Profit estimate ────────────────────────────────────────────────────

describe('RD-ANALYTICS-02 · the profit estimate is basis-compatible or absent', () => {
  const ledger = () => [{ grossAmountPaise: 100_000, platformFeeBasePaise: 2_000,
    platformFeeGstPaise: 360, gatewayFeeEstimatePaise: 1_800, netSettlementPaise: 95_840 }]

  it('20 · published only when net, refunds and comms all read — and equals net − refunds − comms', async () => {
    ROWS = [reg('confirmed', 'paid', 100_000)]
    OTHER.platformTransactions = ledger()
    REFUNDS = { count: 1, amount: { ok: true, paise: 5_000 } }
    const f = (await run()).financial!
    expect(f.netPaise).toEqual({ ok: true, paise: 95_840 })
    expect(f.communicationCostPaise).toEqual({ ok: true, paise: 300 })
    expect(f.profitEstimatePaise).toEqual({ ok: true, paise: 95_840 - 5_000 - 300 })
  })

  it('20b · an unavailable NET makes profit unavailable, not a partial subtraction', async () => {
    // RE-ANCHORED (RD-ANALYTICS-09). The fixture used to express "net is unknown" as an
    // EMPTY ledger, which worked only because a successful empty read was misreported as
    // unavailable. That was a defect: the query ran, and zero captures is an answer. The
    // unknown case is now expressed as what it actually is — a read that FAILED.
    ROWS = [reg('confirmed', 'paid', 100_000)]
    FAILING.add('platformTransactions')
    REFUNDS = { count: 0, amount: { ok: true, paise: 0 } }
    const f = (await run()).financial!
    expect(f.netPaise.ok).toBe(false)
    expect(f.profitEstimatePaise.ok).toBe(false)
  })

  it('20b2 · an event with NO captures reports a measured ₹0, not "unavailable"', async () => {
    // ═══ THE DEFECT THIS CLOSES ════════════════════════════════════════════════
    // `ledgerAvailable` required a non-empty page, so an event that genuinely collected
    // nothing — a free event, or one before its first payment — showed every gateway
    // figure as unreadable. That is the mirror image of the rule this architecture
    // enforces: a failed read must not become a zero, and a successful read of nothing
    // must not become a failure.
    ROWS = [reg('confirmed', 'not_required', 0)]
    OTHER.platformTransactions = []
    REFUNDS = { count: 0, amount: { ok: true, paise: 0 } }
    const f = (await run()).financial!
    expect(f.grossPaise).toEqual({ ok: true, paise: 0 })
    expect(f.netPaise).toEqual({ ok: true, paise: 0 })
    // …and the profit estimate is therefore computable rather than withheld.
    expect(f.profitEstimatePaise.ok).toBe(true)
  })

  it('20c · an unavailable REFUND total makes profit unavailable', async () => {
    ROWS = [reg('confirmed', 'paid', 100_000)]
    OTHER.platformTransactions = ledger()
    REFUNDS = { count: null, amount: { ok: false, reason: 'out_of_budget' } }
    const f = (await run()).financial!
    expect(f.netPaise.ok).toBe(true)
    expect(f.profitEstimatePaise.ok).toBe(false)   // never net − 0
  })

  it('20d · an unavailable COMMS cost makes profit unavailable', async () => {
    ROWS = [reg('confirmed', 'paid', 100_000)]
    OTHER.platformTransactions = ledger()
    REFUNDS = { count: 0, amount: { ok: true, paise: 0 } }
    FAILING = new Set(['emailLogs'])
    const f = (await run()).financial!
    expect(f.communicationCostPaise.ok).toBe(false)
    expect(f.profitEstimatePaise.ok).toBe(false)
  })
})

// ─── 13 · The service does not compute money it was not asked for ────────────

describe('RD-ANALYTICS-02 · the financial half is skipped, not stripped', () => {
  it('13 · without the entitlement the payload carries no financial fields at all', async () => {
    ROWS = [reg('confirmed', 'paid', 100_000)]
    OTHER.platformTransactions = [{ grossAmountPaise: 100_000, netSettlementPaise: 95_000,
      platformFeeBasePaise: 2_000, platformFeeGstPaise: 300, gatewayFeeEstimatePaise: 1_800 }]
    const a = await run(false)

    expect(a.financialAllowed).toBe(false)
    expect(a.financial).toBeUndefined()
    expect(a.revenueByDay).toBeUndefined()
    expect(a.passRevenue).toBeUndefined()
    expect(a.couponPerformance).toBeUndefined()
    expect(a.couponUsage).toBeUndefined()
    // Nothing money-shaped anywhere in the serialised payload.
    expect(JSON.stringify(a)).not.toMatch(/Paise/)
  })

  it('13b · the non-financial half is entirely intact', async () => {
    ROWS = [reg('confirmed', 'paid', 100_000), reg('pending', 'pending', 0)]
    const a = await run(false)
    expect(a.kpis.registrations).toBe(2)
    expect(a.kpis.paid).toBe(1)
    // RE-ANCHORED: registration-status pending (the second fixture row is status pending).
    expect(a.kpis.pending).toBe(1)
    expect(a.kpis.paymentPending).toBe(1)
    expect(a.registrationsByDay).not.toBeNull()
    // RE-ANCHORED (RD-ANALYTICS-03): passSales now comes from the registrationCounters
    // document rather than a tallied scan, so the counter is what the fixture seeds.
    expect(a.passSales.length).toBe(1)
    expect(a.passSales[0]).toEqual({ label: 'General', value: 3 })
    expect(a.paymentStatus.length).toBeGreaterThan(0)
    expect(a.funnel.length).toBeGreaterThan(0)
  })

  it('14 · with the entitlement the financial fields are present', async () => {
    ROWS = [reg('confirmed', 'paid', 100_000)]
    const a = await run(true)
    expect(a.financialAllowed).toBe(true)
    expect(a.financial).toBeDefined()
    expect(a.revenueByDay).toBeDefined()
    expect(a.passRevenue).toBeDefined()
    expect(a.couponPerformance).toBeDefined()
  })

  it('the per-day series is READ from the rollups, not re-derived', async () => {
    // RE-ANCHORED (RD-ANALYTICS-03). This used to assert that the in-memory bucket
    // accumulated on confirmed rather than paid. That accumulation is gone: the series is
    // now the organizerDailyStats rows, whose confirmed/revenue semantics are guaranteed by
    // the WRITE path the dashboard already depends on. What is left to prove here is that
    // Analytics reports those rows faithfully and does not re-derive anything.
    const days = dayKeyRange(Date.now(), 30)
    const last = days[days.length - 1]
    DAILY[`${OWNER}__${EVENT_ID}__${last}`] = { day: last, confirmed: 7, cancelled: 2, revenuePaise: 20_000, checkedIn: 3 }
    ROWS = [reg('confirmed', 'paid', 100_000)]

    const a = await run(true)
    expect(a.registrationsByDay!.at(-1)!.value).toBe(7)
    expect(a.revenueByDay!.at(-1)!.value).toBe(20_000)
    expect(a.checkInsByDay!.at(-1)!.value).toBe(3)
    // Every other day inside the window is a real zero (no rollup row was written).
    expect(a.registrationsByDay!.length).toBe(30)
    expect(a.registrationsByDay!.slice(0, -1).every(p => p.value === 0)).toBe(true)
    // Fully covered, so nothing is withheld and the reader is told nothing is missing.
    expect(a.coveragePartial).toBe(false)
  })

  it('14c · days before the rollup coverage floor are WITHHELD, not reported as zero', async () => {
    // ═══ WHY THIS MATTERS ══════════════════════════════════════════════════════
    // organizerDailyStats only exists from the day the rollup writer started. A day before
    // that has no row — which is indistinguishable, at the storage layer, from a day on
    // which nothing happened. Emitting it as a 0 would draw a flat line through the history
    // of an event that was in fact busy, and would make a period comparison against that
    // stretch report a collapse that never occurred.
    const days = dayKeyRange(Date.now(), 30)
    const floor = days[days.length - 10]           // history begins 10 days into the window
    DAILY[`${OWNER}__meta`] = { organizerUid: OWNER, since: floor, backfilledAt: null }
    const last = days[days.length - 1]
    DAILY[`${OWNER}__${EVENT_ID}__${last}`] = { day: last, confirmed: 7, cancelled: 2, revenuePaise: 20_000, checkedIn: 3 }
    ROWS = [reg('confirmed', 'paid', 100_000)]

    const a = await run(true)
    expect(a.registrationsByDay!.length).toBe(10)
    expect(a.registrationsByDay![0].date).toBe(floor)
    // The gap is DECLARED rather than silently absorbed…
    expect(a.coveragePartial).toBe(true)
    expect(a.coverageSince).toBe(floor)
    // …and the baseline window, which lies wholly before the floor, is refused outright
    // instead of being summed to zero and compared against.
    expect(a.baseline).toBeNull()
    expect(a.baselineOutsideCoverage).toBe(true)
  })

  it('14d · a covered window with an UNCOVERED baseline is reported as exactly that', async () => {
    // ═══ THE DISTINCTION ═══════════════════════════════════════════════════════
    // These two facts are independent, and the common case is the one where they differ: a
    // short window sitting entirely inside recorded history whose preceding window does
    // not. Collapsing them told the reader "no earlier period on record" — which reads as
    // "this event has never run before" — about an event whose earlier months simply
    // predate the rollups.
    const days = dayKeyRange(Date.now(), 30)
    // Coverage starts exactly at the window's first day: nothing is clipped, but the whole
    // preceding 30 days lie before it.
    DAILY[`${OWNER}__meta`] = { organizerUid: OWNER, since: days[0], backfilledAt: null }
    ROWS = [reg('confirmed', 'paid', 100_000)]

    const a = await run(true)
    expect(a.registrationsByDay!.length).toBe(30)     // the window itself is intact…
    expect(a.coveragePartial).toBe(false)             // …so there is no gap to disclose…
    expect(a.baseline).toBeNull()                     // …but the comparison still cannot run
    expect(a.baselineOutsideCoverage).toBe(true)      // and says why
  })
})
