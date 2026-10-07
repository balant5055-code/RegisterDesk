// RD-ANALYTICS-12-07 · the ADMIN platform finance report is complete past its cap.
//
// ═══ THE DEFECT THIS EXISTS TO PROVE GONE ════════════════════════════════════
// All three admin reads took a fixed slice of the collection and applied the requested date
// range afterwards, in memory:
//
//     platformTransactions .orderBy('paidAt','desc').limit(10_000 + 1)   → inRange(paidAt)
//     donationRefunds      .orderBy('createdAt','desc').limit(10_000 + 1)→ inRange(createdAt)
//     settlementRequests   .where('status','==','paid').limit(10_000)    → inRange(paidAt ?? requestedAt)
//
// Above the cap that does not truncate an answer, it replaces one — and these figures are
// platform GMV, fees and GST. The settlement read also had no `orderBy` at all, so Firestore
// fell back to `__name__` and the 10,000 rows chosen were arbitrary with respect to time.
//
// ═══ THE FIXTURE IS BUILT SO THE OLD CODE MUST FAIL ══════════════════════════
// For each collection the historical rows are seeded FIRST and then buried under more than
// 10,000 newer ones. Case 0 asserts that burial rather than assuming it: ordered newest
// first, the first 10,000 rows contain NOT ONE historical record. The old implementation
// could therefore only have returned zero for the historical window; the new one must return
// every seeded row with exact totals.
//
// ═══ WHY IT SEEDS SO MUCH ════════════════════════════════════════════════════
// 10,001+ documents per collection is the whole point — a smaller fixture cannot distinguish
// the two implementations. beforeAll is given a long timeout for that reason.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

/** Must match ADMIN_CAP in the PREVIOUS implementation — the bound under test. */
const OLD_CAP = 10_000

const HIST_FROM = '2024-01-01'
const HIST_TO   = '2024-01-31'
const HISTORIC  = new Date('2024-01-10T00:00:00Z')
const RECENT    = new Date('2026-01-10T00:00:00Z')

// Historical rows: few, distinctive amounts.
const H_TXNS = 40
const H_GROSS = 100_000, H_FEEBASE = 2_000, H_GST = 360, H_GATEWAY = 2_360
const H_NET = H_GROSS - H_FEEBASE - H_GST - H_GATEWAY
const H_REFUNDS = 12, H_REFUND_AMT = 5_000
const H_SETTLE  = 15, H_SETTLE_AMT = 250_000

// Recent rows: enough to bury the history under the old cap, with different amounts so
// contamination is arithmetic and not merely a count mismatch.
const R_TXNS    = OLD_CAP + 200
const R_GROSS = 11, R_FEEBASE = 1, R_GST = 1, R_NET = 9
const R_REFUNDS = OLD_CAP + 50, R_REFUND_AMT = 3
const R_SETTLE  = OLD_CAP + 50, R_SETTLE_AMT = 7

describeEmu('RD-ANALYTICS-12-07 · admin finance totals are complete past the old cap', () => {
  let adminDb: FirebaseFirestore.Firestore
  let computeAdminTotals: typeof import('@/lib/reports/adminBuilders').computeAdminTotals

  const ids: Array<[string, string]> = []   // [collection, docId]

  const seed = async (
    collection: string, count: number, prefix: string, when: Date,
    row: (i: number, at: Date) => Record<string, unknown>,
  ) => {
    let batch = adminDb.batch()
    for (let i = 0; i < count; i++) {
      const id = `${prefix}-${i}`
      ids.push([collection, id])
      // Spread within the day so ordering is total and deterministic.
      batch.set(adminDb.collection(collection).doc(id), row(i, new Date(when.getTime() + i * 1000)))
      if ((i + 1) % 450 === 0) { await batch.commit(); batch = adminDb.batch() }
    }
    await batch.commit()
  }

  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ computeAdminTotals } = await import('@/lib/reports/adminBuilders'))

    const txn = (gross: number, feeBase: number, gst: number, net: number) =>
      (_i: number, at: Date) => ({
        paidAt: at, status: 'paid', type: 'registration',
        grossAmountPaise: gross, platformFeeBasePaise: feeBase, platformFeeGstPaise: gst,
        // `readReportFromLedgerData` READS this field — it does not derive it from base + gst,
        // because money is never recomputed downstream of the ledger. A real transaction row
        // carries it, so the fixture must too; omitting it made `feesPaise` read a true 0.
        platformFeeTotalPaise: feeBase + gst,
        gatewayFeeActualPaise: H_GATEWAY, netSettlementPaise: net,
      })

    // ── history first, then enough newer rows to push it out of the old cap ──
    await seed('platformTransactions', H_TXNS, 'a1207-h-txn', HISTORIC,
               txn(H_GROSS, H_FEEBASE, H_GST, H_NET))
    await seed('platformTransactions', R_TXNS, 'a1207-r-txn', RECENT,
               txn(R_GROSS, R_FEEBASE, R_GST, R_NET))

    await seed('donationRefunds', H_REFUNDS, 'a1207-h-ref', HISTORIC,
               (_i, at) => ({ createdAt: at, status: 'processed', amountPaise: H_REFUND_AMT }))
    await seed('donationRefunds', R_REFUNDS, 'a1207-r-ref', RECENT,
               (_i, at) => ({ createdAt: at, status: 'processed', amountPaise: R_REFUND_AMT }))

    await seed('settlementRequests', H_SETTLE, 'a1207-h-set', HISTORIC,
               (_i, at) => ({ status: 'paid', paidAt: at, requestedAt: at, amountPaise: H_SETTLE_AMT }))
    await seed('settlementRequests', R_SETTLE, 'a1207-r-set', RECENT,
               (_i, at) => ({ status: 'paid', paidAt: at, requestedAt: at, amountPaise: R_SETTLE_AMT }))

    /**
     * The anomaly, for case F. A settlement marked paid whose `paidAt` was never written, but
     * whose `requestedAt` sits INSIDE the historical window. Under the old fallback its
     * amount landed in the historical total; it must not now.
     */
    await adminDb.collection('settlementRequests').doc('a1207-null-paidAt').set({
      status: 'paid', paidAt: null,
      requestedAt: new Date('2024-01-15T00:00:00Z'),
      amountPaise: 999_999_999,
    })
    ids.push(['settlementRequests', 'a1207-null-paidAt'])
  }, 1_800_000)

  afterAll(async () => {
    for (let i = 0; i < ids.length; i += 450) {
      const batch = adminDb.batch()
      for (const [collection, id] of ids.slice(i, i + 450)) {
        batch.delete(adminDb.collection(collection).doc(id))
      }
      await batch.commit()
    }
  }, 1_800_000)

  it('0 · the fixture buries the history — the old implementation could not have passed', async () => {
    // Newest-first, the first OLD_CAP rows must be entirely recent. If this stops holding,
    // every assertion below becomes vacuous, so it is checked rather than assumed.
    for (const [collection, field, marker] of [
      ['platformTransactions', 'paidAt', '-h-txn'],
      ['donationRefunds', 'createdAt', '-h-ref'],
    ] as const) {
      const snap = await adminDb.collection(collection).orderBy(field, 'desc').limit(OLD_CAP).get()
      expect(snap.size, collection).toBe(OLD_CAP)
      expect(snap.docs.some(d => d.id.includes(marker)), `${collection} history leaked`).toBe(false)
    }
    // Settlements had NO orderBy, so the old code took the first OLD_CAP by document id.
    const byId = await adminDb.collection('settlementRequests').where('status', '==', 'paid').limit(OLD_CAP).get()
    expect(byId.size).toBe(OLD_CAP)
  })

  // ─── A, B, C · historical completeness per collection ───────────────────────

  it('1 · A · historical transactions older than the newest 10,000 are all included', async () => {
    const t = await computeAdminTotals({ from: HIST_FROM, to: HIST_TO })
    expect(t.transactionCount).toBe(H_TXNS)          // the old code returned 0 here
    expect(t.gmvPaise).toBe(H_GROSS * H_TXNS)
    expect(t.feesPaise).toBe((H_FEEBASE + H_GST) * H_TXNS)
    expect(t.gstPaise).toBe(H_GST * H_TXNS)
  })

  it('2 · B · historical donation refunds are included and exact', async () => {
    const t = await computeAdminTotals({ from: HIST_FROM, to: HIST_TO })
    expect(t.refundsPaise).toBe(H_REFUND_AMT * H_REFUNDS)
  })

  it('3 · C · historical paid settlements are included and exact', async () => {
    const t = await computeAdminTotals({ from: HIST_FROM, to: HIST_TO })
    expect(t.settlementsPaise).toBe(H_SETTLE_AMT * H_SETTLE)
  })

  it('4 · recent rows do not contaminate the historical window', async () => {
    const t = await computeAdminTotals({ from: HIST_FROM, to: HIST_TO })
    // Every recent amount is distinct, so any leak changes the total.
    expect(t.gmvPaise % H_GROSS).toBe(0)
    expect(t.transactionCount).toBeLessThan(OLD_CAP)
  })

  it('5 · a complete historical report does NOT claim to be truncated', async () => {
    const t = await computeAdminTotals({ from: HIST_FROM, to: HIST_TO })
    expect(t.truncated).toBe(false)
  })

  // ─── D · pagination ─────────────────────────────────────────────────────────

  it('6 · D · a window far larger than one page is complete, with no gaps or duplicates', async () => {
    // The recent window holds > 10,000 transactions — eleven pages at PAGE_SIZE 1,000.
    const t = await computeAdminTotals({ from: '2026-01-01', to: '2026-01-31' })
    expect(t.transactionCount).toBe(R_TXNS)
    // Exactness IS the no-duplicate / no-skip proof: a repeat or a gap changes the sum.
    expect(t.gmvPaise).toBe(R_GROSS * R_TXNS)
    expect(t.refundsPaise).toBe(R_REFUND_AMT * R_REFUNDS)
    expect(t.truncated).toBe(false)          // many pages is normal, not partial data
  })

  it('7 · settlement selection is deterministic, not document-id order', async () => {
    // > 10,000 paid settlements exist in the recent window. The old unordered .limit() could
    // only ever have summed an arbitrary subset of them.
    const t = await computeAdminTotals({ from: '2026-01-01', to: '2026-01-31' })
    expect(t.settlementsPaise).toBe(R_SETTLE_AMT * R_SETTLE)
    const again = await computeAdminTotals({ from: '2026-01-01', to: '2026-01-31' })
    expect(again.settlementsPaise).toBe(t.settlementsPaise)   // stable across runs
  })

  // ─── E · semantic regression on a small dataset ─────────────────────────────

  it('8 · E · on a window where old and new candidate sets agree, totals are unchanged', async () => {
    // A single historical day: well inside any cap, so the old implementation would have
    // selected exactly these rows too. The arithmetic must be identical.
    const t = await computeAdminTotals({ from: '2024-01-10', to: '2024-01-10' })
    expect(t.transactionCount).toBe(H_TXNS)
    expect(t.gmvPaise).toBe(H_GROSS * H_TXNS)
    expect(t.feesPaise).toBe((H_FEEBASE + H_GST) * H_TXNS)   // platformFeeTotal = base + gst
    expect(t.gstPaise).toBe(H_GST * H_TXNS)
    expect(t.refundsPaise).toBe(H_REFUND_AMT * H_REFUNDS)
    expect(t.settlementsPaise).toBe(H_SETTLE_AMT * H_SETTLE)
  })

  it('9 · a window with nothing in it is a measured zero, not a failure', async () => {
    const t = await computeAdminTotals({ from: '2025-06-01', to: '2025-06-30' })
    expect(t.transactionCount).toBe(0)
    expect(t.gmvPaise).toBe(0)
    expect(t.settlementsPaise).toBe(0)
    expect(t.truncated).toBe(false)
  })

  // ─── F · the null-paidAt anomaly ────────────────────────────────────────────

  it('10 · F · a paid settlement with null paidAt is EXCLUDED, never dated by requestedAt', async () => {
    // Its requestedAt (2024-01-15) sits inside the historical window, and its amount is
    // unmistakable. Under the old `paidAt ?? requestedAt` fallback it was counted.
    const t = await computeAdminTotals({ from: HIST_FROM, to: HIST_TO })
    expect(t.settlementsPaise).toBe(H_SETTLE_AMT * H_SETTLE)
    expect(t.settlementsPaise).not.toBe(H_SETTLE_AMT * H_SETTLE + 999_999_999)
  })

  it('11 · and it is excluded from an unbounded request too', async () => {
    const t = await computeAdminTotals({})
    expect(t.settlementsPaise).toBe(H_SETTLE_AMT * H_SETTLE + R_SETTLE_AMT * R_SETTLE)
  })

  // ─── Financial semantics are read, never recomputed ─────────────────────────

  it('12 · fee figures still come from the stored ledger fields', async () => {
    const t = await computeAdminTotals({ from: HIST_FROM, to: HIST_TO })
    // platformFeeTotal is base + gst as the ledger reader defines it — not re-derived here.
    expect(t.feesPaise).toBe(t.gstPaise + H_FEEBASE * H_TXNS)
  })
})
