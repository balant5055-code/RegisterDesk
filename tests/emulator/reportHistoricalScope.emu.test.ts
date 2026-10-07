// RD-ANALYTICS-12-01 · a historical report is COMPLETE past the row cap. REAL Firestore.
//
// ═══ THE DEFECT THIS EXISTS TO PROVE GONE ════════════════════════════════════
// `fetchCapped` read the newest REPORT_ROW_CAP rows in the WORKSPACE and the builders then
// applied `from`/`to` in memory. Above the cap that does not truncate an answer, it replaces
// it: the requested period's rows were never fetched, so a report for any earlier period came
// back empty or short while still presenting as the report that was asked for. `gst` and
// `payout-statement` are filed with tax authorities and used to pay organizers.
//
// ═══ WHY THIS NEEDS A REAL DATABASE ══════════════════════════════════════════
// The bug lives entirely in what Firestore is asked for. A fake that returns whatever it was
// handed cannot tell a query that excluded the period from one that included it — the unit
// suite can only assert the SHAPE of the fix. This asserts the behaviour: 6,000 rows in, of
// which 500 sit in a historical month, and the historical report must find all 500 with exact
// totals and no contamination from the 5,500 newer rows that bury them.
//
// ═══ THE FIXTURE IS BUILT SO THE OLD CODE MUST FAIL ══════════════════════════
// 5,500 recent rows are seeded AFTER the 500 historical ones in time order. Ordered newest
// first, the newest 5,000 therefore contain NOT ONE historical row. The old implementation
// could only return an empty historical report; the new one must return all 500.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID = process.pid
const UID = `a1201-org-${PID}`
const EVENT_A = `a1201-event-a-${PID}`
const EVENT_B = `a1201-event-b-${PID}`

/** Must match REPORT_ROW_CAP in lib/reports/types.ts — the bound under test. */
const CAP = 5000

const HISTORIC_ROWS = 500     // all in Jan 2025, all on EVENT_A
const RECENT_ROWS   = 5_500   // all in Jan 2026 — more than CAP, so they bury the history

// Money per historical row. Distinct from the recent rows so contamination is arithmetic,
// not just a count mismatch.
const H_GROSS = 100_000, H_FEE = 2_000, H_GST = 360, H_GATEWAY = 2_360
const H_NET = H_GROSS - H_FEE - H_GST - H_GATEWAY
const R_GROSS = 777, R_FEE = 7, R_GST = 1, R_NET = 700

const HISTORIC_FROM = '2025-01-01'
const HISTORIC_TO   = '2025-01-31'

describeEmu('RD-ANALYTICS-12-01 · historical reports are complete past the cap', () => {
  let adminDb: FirebaseFirestore.Firestore
  let buildTransactions: typeof import('@/lib/reports/builders').buildTransactions
  let buildGst:          typeof import('@/lib/reports/builders').buildGst
  let buildPayoutStatement: typeof import('@/lib/reports/builders').buildPayoutStatement

  const ids: string[] = []

  const seed = async (
    count: number, prefix: string, when: Date, entityId: string,
    money: { gross: number; fee: number; gst: number; net: number },
  ) => {
    let batch = adminDb.batch()
    for (let i = 0; i < count; i++) {
      const id = `${prefix}-${i}`
      ids.push(id)
      batch.set(adminDb.collection('platformTransactions').doc(id), {
        organizerUid: UID, entityId, entityType: 'event',
        // Spread across the month so ordering is well defined and deterministic.
        paidAt: new Date(when.getTime() + i * 1000),
        type: 'registration', category: 'event', status: 'paid',
        grossAmountPaise: money.gross,
        platformFeeBasePaise: money.fee,
        platformFeeGstPaise: money.gst,
        gatewayFeeActualPaise: H_GATEWAY,
        netSettlementPaise: money.net,
      })
      if ((i + 1) % 450 === 0) { await batch.commit(); batch = adminDb.batch() }
    }
    await batch.commit()
  }

  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ buildTransactions, buildGst, buildPayoutStatement } =
      await import('@/lib/reports/builders'))

    // History first, then enough newer rows to push it entirely out of the newest CAP.
    await seed(HISTORIC_ROWS, `${UID}-h`, new Date('2025-01-10T00:00:00Z'), EVENT_A,
               { gross: H_GROSS, fee: H_FEE, gst: H_GST, net: H_NET })
    await seed(RECENT_ROWS, `${UID}-r`, new Date('2026-01-05T00:00:00Z'), EVENT_B,
               { gross: R_GROSS, fee: R_FEE, gst: R_GST, net: R_NET })
  }, 900_000)

  afterAll(async () => {
    for (let i = 0; i < ids.length; i += 450) {
      const batch = adminDb.batch()
      for (const id of ids.slice(i, i + 450)) {
        batch.delete(adminDb.collection('platformTransactions').doc(id))
      }
      await batch.commit()
    }
  }, 900_000)

  it('0 · the fixture actually buries the history — the old code could not have passed', async () => {
    // Newest-first, the first CAP rows must be entirely recent. If this ever stops holding,
    // every assertion below becomes vacuous, so it is checked rather than assumed.
    const snap = await adminDb.collection('platformTransactions')
      .where('organizerUid', '==', UID).orderBy('paidAt', 'desc').limit(CAP).get()
    expect(snap.size).toBe(CAP)
    const anyHistoric = snap.docs.some(d => String(d.id).includes('-h-'))
    expect(anyHistoric, 'a historical row leaked into the newest CAP').toBe(false)
    expect(RECENT_ROWS).toBeGreaterThan(CAP)
  })

  it('1 · the historical transactions report returns EVERY historical row', async () => {
    const t = await buildTransactions(UID, { from: HISTORIC_FROM, to: HISTORIC_TO })
    // The whole defect in one assertion: the old implementation returned 0 rows here.
    expect(t.rows.length).toBe(HISTORIC_ROWS)
    expect(t.rows.length).toBeGreaterThan(0)
  })

  it('2 · its totals are exact, not approximate', async () => {
    const t = await buildTransactions(UID, { from: HISTORIC_FROM, to: HISTORIC_TO })
    const gross = t.summary?.find(s => s.label === 'Gross Total')?.value
    const net   = t.summary?.find(s => s.label === 'Net Settlement')?.value
    expect(gross).toBe(H_GROSS * HISTORIC_ROWS)
    expect(net).toBe(H_NET * HISTORIC_ROWS)
  })

  it('3 · newer rows do not contaminate the historical period', async () => {
    const t = await buildTransactions(UID, { from: HISTORIC_FROM, to: HISTORIC_TO })
    // Not one row may carry the recent amount, and not one may belong to the recent event.
    expect(t.rows.some(r => r.gross === R_GROSS)).toBe(false)
    expect(t.rows.every(r => r.entity === EVENT_A)).toBe(true)
  })

  it('4 · a complete historical report does NOT claim to be truncated', async () => {
    const t = await buildTransactions(UID, { from: HISTORIC_FROM, to: HISTORIC_TO })
    // 500 rows is far inside every bound, so `truncated` here would be a lie — and it is the
    // specific lie the old implementation told while returning nothing at all.
    expect(t.truncated).toBe(false)
  })

  it('5 · event scope is honoured within the period', async () => {
    const mine  = await buildTransactions(UID, { from: HISTORIC_FROM, to: HISTORIC_TO, event: EVENT_A })
    const other = await buildTransactions(UID, { from: HISTORIC_FROM, to: HISTORIC_TO, event: EVENT_B })
    expect(mine.rows.length).toBe(HISTORIC_ROWS)
    expect(other.rows.length).toBe(0)          // EVENT_B has no rows in this period
  })

  it('6 · the date boundary is inclusive on both ends and excludes the outside', async () => {
    const inside  = await buildTransactions(UID, { from: HISTORIC_FROM, to: HISTORIC_TO })
    const before  = await buildTransactions(UID, { from: '2024-01-01', to: '2024-12-31' })
    const after   = await buildTransactions(UID, { from: '2025-02-01', to: '2025-12-31' })
    expect(inside.rows.length).toBe(HISTORIC_ROWS)
    expect(before.rows.length).toBe(0)
    expect(after.rows.length).toBe(0)
  })

  it('7 · GST aggregates the whole period — an aggregation is never row-capped', async () => {
    // The recent month holds 5,500 transactions, MORE than CAP. Because GST folds each row
    // into a month bucket and retains nothing, it must still count every one of them.
    const g = await buildGst(UID, { from: '2026-01-01', to: '2026-01-31' })
    const jan = g.rows.find(r => r.month === '2026-01')
    expect(jan).toBeDefined()
    expect(jan!.invoices).toBe(RECENT_ROWS)                 // > CAP, and exact
    expect(jan!.taxable).toBe(R_FEE * RECENT_ROWS)
    expect(jan!.gst).toBe(R_GST * RECENT_ROWS)
    expect(g.truncated).toBe(false)
  })

  it('8 · GST for the historical month is exact and uncontaminated', async () => {
    const g = await buildGst(UID, { from: HISTORIC_FROM, to: HISTORIC_TO })
    expect(g.rows.length).toBe(1)
    expect(g.rows[0].month).toBe('2025-01')
    expect(g.rows[0].invoices).toBe(HISTORIC_ROWS)
    expect(g.rows[0].gst).toBe(H_GST * HISTORIC_ROWS)
  })

  it('9 · the payout statement covers a period larger than the cap, exactly', async () => {
    const p = await buildPayoutStatement(UID, { from: '2026-01-01', to: '2026-01-31' })
    expect(p.transactionCount).toBe(RECENT_ROWS)            // > CAP
    expect(p.grossRevenuePaise).toBe(R_GROSS * RECENT_ROWS)
    expect(p.netSettlementPaise).toBe(R_NET * RECENT_ROWS)
    expect(p.truncated).toBe(false)
  })

  it('10 · the payout statement for the historical period is not the recent one', async () => {
    const p = await buildPayoutStatement(UID, { from: HISTORIC_FROM, to: HISTORIC_TO })
    expect(p.transactionCount).toBe(HISTORIC_ROWS)
    expect(p.grossRevenuePaise).toBe(H_GROSS * HISTORIC_ROWS)
    expect(p.netSettlementPaise).toBe(H_NET * HISTORIC_ROWS)
  })

  it('11 · an unfiltered row report is bounded and says so, rather than lying', async () => {
    // 6,000 rows exist in total. A row-listing report retains at most CAP, so this one IS
    // genuinely truncated — and that is now the ONLY circumstance in which it says so.
    const t = await buildTransactions(UID, {})
    expect(t.rows.length).toBe(CAP)
    expect(t.truncated).toBe(true)
  })

  it('12 · one workspace never sees another\'s rows', async () => {
    const other = await buildTransactions(`${UID}-stranger`, { from: HISTORIC_FROM, to: HISTORIC_TO })
    expect(other.rows.length).toBe(0)
  })
})
