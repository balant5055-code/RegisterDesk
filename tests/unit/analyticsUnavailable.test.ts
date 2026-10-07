// RD-ANALYTICS-01 — a failed read must not surface as a real zero.
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// getEventAnalytics wrapped four collection reads in `try { … } catch { /* index */ }`
// with the counters initialised to 0. When a read failed — a missing index, a schema
// change, a transient error — the payload was byte-identical to a real, quiet event:
//
//     communication: { sent: 0, delivered: 0, failed: 0, costPaise: 0 }
//
// "No emails were sent" and "we could not find out" rendered as the same four zeros, and
// the second one is not something this endpoint was entitled to claim.
//
// ═══ HOW THIS TEST WORKS ═════════════════════════════════════════════════════
// It runs the REAL getEventAnalytics against a fake Firestore whose named collections
// genuinely throw. Nothing about the behaviour under test is mocked — only the database
// is, and it is made to fail exactly the way production does.

import { describe, it, expect, beforeEach, vi } from 'vitest'

/** Collections that throw on .get() for the current case. */
let FAILING = new Set<string>()
/** Far enough back that the whole default window sits inside recorded history. */
const COVERAGE_SINCE = '2000-01-01'

const EVENT_ID = 'scale-event'
const OWNER    = 'ws-owner'

const docs: Record<string, Record<string, unknown>> = {}

class FakeQuery {
  constructor(readonly name: string, readonly rows: Record<string, unknown>[] = []) {}
  /**
   * RD-ANALYTICS-11 · equality filters are HONOURED.
   *
   * They used to be ignored, which was harmless while every read was a document scan the
   * producer filtered again in memory. It stopped being harmless once the communication
   * counts became `count()` aggregates: an ignored `where` makes every status return the
   * whole collection, so the fake would answer questions Firestore never would and the
   * suite would assert arithmetic that cannot occur. A row MISSING the field is excluded,
   * which is also what Firestore does.
   */
  where(field?: string, op?: string, value?: unknown) {
    if (!field || op !== '==') return this
    return new FakeQuery(this.name, this.rows.filter(r => r[field] === value))
  }
  /**
   * RD-ANALYTICS-09 · limit is HONOURED, so a truncated read is reproducible.
   *
   * Ignoring it made an over-cap ledger indistinguishable from a complete one, which is
   * exactly the state the producer now has to refuse to publish.
   */
  limit(n?: number) {
    return typeof n === 'number' ? new FakeQuery(this.name, this.rows.slice(0, n)) : this
  }
  /** Firestore's orderBy excludes documents missing the field — see the sibling suite. */
  orderBy(field?: string) {
    return field ? new FakeQuery(this.name, this.rows.filter(r => r[field] != null)) : this
  }
  select() { return this }
  count() {
    const rows = this.rows
    const failing = FAILING.has(this.name)
    return { async get() {
      if (failing) throw new Error('count failed')
      return { data: () => ({ count: rows.length }) }
    } }
  }
  /** sum() over the filtered rows, so messaging spend has a source that can also FAIL. */
  aggregate(spec: Record<string, { _field?: string }>) {
    const rows = this.rows
    const failing = FAILING.has(this.name)
    return { async get() {
      if (failing) throw new Error('aggregate failed')
      const out: Record<string, number> = {}
      for (const [k, f] of Object.entries(spec)) {
        const field = String(f?._field ?? '')
        out[k] = rows.reduce((n, r) => n + (typeof r[field] === 'number' ? r[field] as number : 0), 0)
      }
      return { data: () => out }
    } }
  }
  async get() {
    if (FAILING.has(this.name)) throw new Error(`FAILED_PRECONDITION: ${this.name} needs an index`)
    return {
      empty: this.rows.length === 0,
      size:  this.rows.length,
      docs:  this.rows.map((d, i) => ({ id: `${this.name}-${i}`, exists: true, data: () => d })),
    }
  }
}

const COLLECTION_ROWS: Record<string, Record<string, unknown>[]> = {
  registrations: [{
    organizerUid: OWNER, eventSlug: EVENT_ID,
    status: 'confirmed', paymentStatus: 'paid', amount: 50_000, passName: 'General',
    eventName: 'Scale Event', ticketCode: 'TC-1', checkedIn: false,
    attendee: { name: 'A', email: 'a@b.c', formResponses: {} },
  }],
  platformTransactions: [],
  // RD-ANALYTICS-11 · these carry the keys the producer FILTERS on, now that the fake
  // honours equality. A row without `eventId` belongs to no event, in the fake exactly as
  // in Firestore, and would be invisible to every read here.
  emailLogs:            [{ eventId: EVENT_ID, status: 'sent', costPaise: 25, templateKey: 'welcome' }],
  scheduledReminders:   [{ eventId: EVENT_ID, status: 'sent', counts: { recipients: 3 } }],
  certificates:         [{ eventId: EVENT_ID, downloadCount: 2 }],
}

const fakeDoc = (path: string) => ({
  async get() {
    if (FAILING.has('__doc__')) throw new Error('doc read failed')
    const d = docs[path]
    return { exists: !!d, data: () => d }
  },
  collection: (sub: string) => new FakeQuery(sub, []),
})

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (name: string) => Object.assign(
      new FakeQuery(name, COLLECTION_ROWS[name] ?? []),
      { doc: (id: string) => fakeDoc(`${name}/${id}`) },
    ),
    doc: fakeDoc,
    getAll: async (...refs: { get(): Promise<unknown> }[]) => Promise.all(refs.map(r => r.get())),
  },
}))

vi.mock('@/lib/analytics/couponPerformance', () => ({
  EMPTY_COUPON_PERFORMANCE: {
    rows: [], totalRedemptions: 0, activeCoupons: 0, totalCoupons: 0,
    totalDiscountPaise: 0, discountUnavailable: true,
  },
  getCouponPerformance: async () => ({
    rows: [], totalRedemptions: 0, activeCoupons: 0, totalCoupons: 0,
    totalDiscountPaise: 0, discountUnavailable: false,
  }),
}))

// RD-ANALYTICS-02 · the canonical readers are exercised through their own suite
// (analyticsFinancialTruth.test.ts). Here they are stubbed so THIS file keeps testing one
// thing: that a failing source becomes null/gone rather than a zero.
// RD-ANALYTICS-03 · the counts now come from aggregates. They are stubbed here so THIS
// file keeps testing one thing — that a failing SOURCE becomes null/gone rather than a
// zero. Their real behaviour is exercised in analyticsFinancialTruth.test.ts (against a
// fake that runs the actual readers) and at 20k in printJobScale's sibling emulator suite.
vi.mock('@/lib/firebase/firestore/registrationCounters', () => ({
  sumConfirmedRevenueFromLedgerChecked: async () => ({ value: 12_345, ok: true }),
  aggregateRegistrationStatusCounts: async () => {
    if (FAILING.has('__status__')) throw new Error('status aggregate failed')
    return { total: 1, confirmed: 1, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 }
  },
  getRegistrationCounter: async () => ({ passCounts: { 'pass-a': 1 } }),
}))
vi.mock('@/lib/dashboard/dailyStatsAdmin', () => ({
  readDailyStats: async (_u: string, _e: string, days: string[]) => {
    if (FAILING.has('__daily__')) throw new Error('rollups unreadable')
    return days.map(d => ({ date: d, confirmed: 0, cancelled: 0, revenuePaise: 0, checkedIn: 0 }))
  },
  // RD-ANALYTICS-07 · the coverage floor. The real reader never throws — it degrades to the
  // rollup epoch — so a stub that could fail here would test a state the source cannot reach.
  readCoverage: async () => COVERAGE_SINCE,
}))
vi.mock('@/lib/analytics/registrationPassAggregates', () => ({
  aggregateValueByPass: async () => ({ values: { 'pass-a': { salesPaise: 50_000, cancelledPaise: 0 } }, complete: true }),
}))
vi.mock('@/lib/finance/financeAnalytics', async orig => ({
  ...(await orig<typeof import('@/lib/finance/financeAnalytics')>()),
  getRefundTotals: async () => ({
    count: 0, amount: { ok: true as const, paise: 0 }, unlinked: 0, recovered: 0, complete: true,
  }),
}))

const run = async () => {
  const { getEventAnalytics } = await import('@/lib/analytics/eventAnalytics')
  const out = await getEventAnalytics(EVENT_ID, { includeFinancial: true })
  if (!out) throw new Error('event not resolved')
  return out.analytics
}

beforeEach(() => {
  FAILING = new Set()
  docs[`events/${EVENT_ID}`] = { uid: OWNER, draftId: 'draft-A', totalCapacity: 100,
    eventDetails: { info: { name: 'Scale Event' } } }
})

describe('RD-ANALYTICS-01 · a healthy event still reports numbers', () => {
  it('1 · every block is present and populated when every read succeeds', async () => {
    const a = await run()
    expect(a.communication).not.toBeNull()
    expect(a.communication!.sent).toBe(1)
    expect(a.financial!.communicationCostPaise).toEqual({ ok: true, paise: 25 })
    expect(a.reminders).not.toBeNull()
    expect(a.reminders!.sent).toBe(1)
    expect(a.certificates).not.toBeNull()
    expect(a.certificates!.issued).toBe(1)
    expect(a.certificates!.downloaded).toBe(1)
  })

  it('2 · a genuinely empty collection is 0, NOT null — the distinction is the point', async () => {
    COLLECTION_ROWS.emailLogs = []
    try {
      const a = await run()
      expect(a.communication).not.toBeNull()
      expect(a.communication!.sent).toBe(0)          // measured zero
    } finally {
      COLLECTION_ROWS.emailLogs = [{ eventId: EVENT_ID, status: 'sent', costPaise: 25, templateKey: 'welcome' }]
    }
  })
})

describe('RD-ANALYTICS-01 · a failed read is null, never zero', () => {
  it('3 · a failed emailLogs read nulls communication instead of reporting "none sent"', async () => {
    FAILING = new Set(['emailLogs'])
    const a = await run()
    expect(a.communication).toBeNull()
    // and it did not take the rest of the payload down with it
    expect(a.reminders).not.toBeNull()
    expect(a.kpis.registrations).toBe(1)
  })

  it('4 · a failed scheduledReminders read nulls reminders only', async () => {
    FAILING = new Set(['scheduledReminders'])
    const a = await run()
    expect(a.reminders).toBeNull()
    expect(a.communication).not.toBeNull()
  })

  it('5 · a failed certificates read nulls certificates AND drops the funnel step', async () => {
    FAILING = new Set(['certificates'])
    const a = await run()
    expect(a.certificates).toBeNull()
    // A "Certificate downloaded: 0" bar would assert that nobody downloaded one.
    expect(a.funnel.map(f => f.label)).not.toContain('Certificate downloaded')
    expect(a.funnel.map(f => f.label)).toContain('Registered')
  })

  it('6 · every failure at once still yields a usable, honest payload', async () => {
    FAILING = new Set(['emailLogs', 'scheduledReminders', 'certificates', 'platformTransactions'])
    const a = await run()
    expect(a.communication).toBeNull()
    expect(a.reminders).toBeNull()
    expect(a.certificates).toBeNull()
    expect(a.financial!.grossPaise.ok).toBe(false)
    expect(a.financial!.communicationCostPaise.ok).toBe(false)
    // …and with a failed input, no profit is invented from the survivors.
    expect(a.financial!.profitEstimatePaise.ok).toBe(false)
    expect(a.kpis.registrations).toBe(1)           // the parts that DID read still report
  })
})

describe('RD-ANALYTICS-01 · the ledger declares whether it read', () => {
  it('7 · a failed platformTransactions read makes every ledger figure UNAVAILABLE', async () => {
    // RE-ANCHORED: the zeros are gone from the payload entirely. There is no longer a
    // number for a consumer to render by mistake — `ok: false` is all it can see.
    FAILING = new Set(['platformTransactions'])
    const a = await run()
    for (const k of ['grossPaise', 'platformFeePaise', 'gstPaise', 'gatewayFeePaise', 'netPaise'] as const) {
      expect(a.financial![k].ok, k).toBe(false)
    }
  })

  it('8 · an EMPTY ledger IS a measurement — a real ₹0, not "unavailable"', async () => {
    // ═══ RE-ANCHORED (RD-ANALYTICS-09), AND THE OLD ASSERTION WAS WRONG ════════
    // This used to require `ok: false` for an event with no platform transactions, on the
    // reasoning that an empty result proves nothing. It does not follow. The rule this
    // architecture enforces is "a FAILED read must not become a zero" — the converse,
    // "a successful read of nothing must become a failure", is a different claim and an
    // untrue one. The query ran; zero captures is the answer.
    //
    // Keeping the old behaviour meant a free event, and any event before its first
    // payment, showed every gateway figure as unreadable — which reads as "something is
    // broken" for an event where nothing is. Test 7 above still pins the case that
    // actually matters: a read that THREW yields `ok: false` for every figure.
    const a = await run()
    expect(a.financial!.grossPaise).toEqual({ ok: true, paise: 0 })
    expect(a.financial!.platformFeePaise).toEqual({ ok: true, paise: 0 })
    expect(a.financial!.netPaise).toEqual({ ok: true, paise: 0 })
  })

  it('8b · a TRUNCATED ledger is not a measurement, and says which', async () => {
    // Over the bounded read the sum would be partial, so nothing is published — and the
    // reason distinguishes it from a failure, because retrying cannot help.
    COLLECTION_ROWS.platformTransactions = Array.from({ length: 5_001 }, () => ({
      entityId: EVENT_ID,
      grossAmountPaise: 100, platformFeeBasePaise: 1, platformFeeGstPaise: 0,
      gatewayFeeActualPaise: 0, netSettlementPaise: 99,
    }))
    try {
      const a = await run()
      expect(a.financial!.grossPaise).toEqual({ ok: false, reason: 'out_of_budget' })
      expect(a.financial!.netPaise).toEqual({ ok: false, reason: 'out_of_budget' })
      // …and the completeness flag agrees with the figures.
      expect(a.limits.ledger).toBe(false)
      // A partial sum must not appear anywhere.
      expect(JSON.stringify(a.financial)).not.toContain('500000')
    } finally { COLLECTION_ROWS.platformTransactions = [] }
  })

  it('9 · a ledger that actually read publishes real figures', async () => {
    COLLECTION_ROWS.platformTransactions = [{
      entityId: EVENT_ID,
      grossAmountPaise: 50_000, platformFeeBasePaise: 1_000, platformFeeGstPaise: 180,
      gatewayFeeActualPaise: 900, netSettlementPaise: 47_920,
    }]
    try {
      const a = await run()
      expect(a.financial!.grossPaise).toEqual({ ok: true, paise: 50_000 })
      expect(a.financial!.platformFeePaise).toEqual({ ok: true, paise: 1_000 })
      expect(a.financial!.netPaise).toEqual({ ok: true, paise: 47_920 })
    } finally { COLLECTION_ROWS.platformTransactions = [] }
  })
})

describe('RD-ANALYTICS-01 · the workspace wallet is not read at all', () => {
  it('10 · no settlement field is published, and no wallet document is touched', async () => {
    const a = await run() as unknown as { financial: Record<string, unknown> }
    expect(a.financial).not.toHaveProperty('settlement')
    expect(Object.keys(a.financial)).not.toContain('availablePaise')
  })

  it('11 · a wallet read failure cannot break analytics, because there is none', async () => {
    // Previously the wallet was read inside its own try/catch on every call. Nothing here
    // should depend on it any more.
    FAILING = new Set(['organizerRevenueWallets'])
    const a = await run()
    expect(a.kpis.registrations).toBe(1)
    expect(a.financial!.confirmedRevenuePaise.ok).toBe(true)
  })
})

describe('RD-ANALYTICS-01 · identity resolution for authorization', () => {
  it('12 · resolves the owning workspace and the draft id from the bridge document', async () => {
    const { resolveAnalyticsEventIdentity } = await import('@/lib/analytics/eventAnalytics')
    // RE-ANCHORED (RD-ANALYTICS-06): the resolver now ALSO returns the two capability
    // signals the Overview needs, read off the same document. The invariant under test —
    // that it resolves the owning workspace and the draft id — is unchanged, so this
    // matches on those rather than pinning the whole shape against future additions.
    expect(await resolveAnalyticsEventIdentity(EVENT_ID))
      .toMatchObject({ organizerUid: OWNER, draftId: 'draft-A' })
  })

  it('13 · a missing event resolves to null so the route can refuse without computing', async () => {
    const { resolveAnalyticsEventIdentity } = await import('@/lib/analytics/eventAnalytics')
    expect(await resolveAnalyticsEventIdentity('no-such-event')).toBeNull()
  })

  it('14 · an event with no owner is treated as unresolvable, never as ownerless-and-open', async () => {
    docs['events/ownerless'] = { totalCapacity: 10 }
    const { resolveAnalyticsEventIdentity } = await import('@/lib/analytics/eventAnalytics')
    expect(await resolveAnalyticsEventIdentity('ownerless')).toBeNull()
  })

  it('15 · a draft id is optional — the route falls back rather than crashing', async () => {
    docs['events/no-draft'] = { uid: OWNER }
    const { resolveAnalyticsEventIdentity } = await import('@/lib/analytics/eventAnalytics')
    const identity = await resolveAnalyticsEventIdentity('no-draft')
    expect(identity).toMatchObject({ organizerUid: OWNER, draftId: null })
    // RD-ANALYTICS-06 · the capability signals fail CLOSED on a document that carries
    // neither — an unreadable event type must not offer a type-exclusive analytics panel.
    expect(identity!.eventType).toBeNull()
    expect(identity!.registrationRules).toBeNull()
  })
})
