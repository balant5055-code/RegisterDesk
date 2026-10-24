// Phase 3 (Option C) — clawback debt is recovered INSIDE the settlement-release transaction, from the
// amount being released, oldest debt first — never from pendingPaise at credit time. On REAL Firestore
// through the real credit path (recordPlatformTransactionAndCredit), the real reversal
// (reversePlatformTransactionAndDebit), the real release job (releaseEligibleFunds) and the real
// Super Admin clawback actions (waiveClawback / markClawbackRecovered).
//
// Every assertion is per bucket / per record (integer paise) — never only the total.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const DAY = 86_400_000

vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 3 · release-time clawback recovery (Option C)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let claw: typeof import('@/lib/clawbacks/clawbackService')
  let reconcileWallet: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
  let n = 0
  let failClawbackRead = 0

  const org = () => `cbr-org-${P}-${++n}`
  const wallet = async (uid: string) => {
    const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data() ?? {}
    return { pending: w.pendingPaise as number, available: w.availablePaise as number, inTransit: (w.inTransitPaise ?? 0) as number, settled: (w.settledPaise ?? 0) as number }
  }
  const ptx = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data() ?? {}
  const clawbacks = async (uid: string) => (await db.collection('walletClawbacks').where('organizerUid', '==', uid).get()).docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }))
  const releaseRec = async (ptxId: string) => {
    const s = await db.collection('settlementReleases').where('transactionId', '==', ptxId).get()
    return s.docs.map(d => d.data())
  }
  /** Releases ONLY this organizer's eligible rows in a deterministic order (oldest paidAt first). */
  const age = (ptxId: string, daysAgo: number) => db.doc(`platformTransactions/${ptxId}`).update({ paidAt: new Date(Date.now() - daysAgo * DAY) })
  /** pendingPaise must equal the nets of this organizer's unreleased, unreversed transactions. */
  const pendingInvariant = async (uid: string) => {
    const rows = (await db.collection('platformTransactions').where('organizerUid', '==', uid).get()).docs.map(d => d.data())
    const expected = rows.filter(t => t.status === 'completed' && (t.releaseStatus === 'pending' || t.releaseStatus === 'held')).reduce((s, t) => s + Number(t.netSettlementPaise), 0)
    expect((await wallet(uid)).pending).toBe(expected)
  }
  const reconClean = async (uid: string) =>
    expect(await reconcileWallet(uid, (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!)).toEqual([])

  async function payment(uid: string, net: number) {
    const id = `cbr-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: `cbr-ev-${P}`, entityType: 'event',
      sourceId: id, sourceType: 'registration', payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0,
      platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays',
      planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `p_${id}`, gatewayOrderId: `o_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    return `ptx_${id}`
  }
  /** A paid payout of `amount` out of available (the shape the admin mark-paid path leaves). */
  async function paidOut(uid: string, amount: number) {
    const w = await wallet(uid)
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: w.available - amount, settledPaise: w.settled + amount })
    await db.collection('settlementRequests').doc(`cbr-sr-${P}-${++n}`).set({ organizerUid: uid, amountPaise: amount, status: 'paid' })
  }
  /**
   * Outstanding clawbacks of exactly these amounts, through the REAL reversal path, created in this order
   * (so the first is the oldest). All payments are credited and released BEFORE any debt exists (no
   * recovery in between), the available money is paid out, then each payment is refunded: nothing is
   * left to debit, so each clawback carries its whole net.
   */
  async function withDebts(uid: string, debts: number[]) {
    const pays: string[] = []
    for (const d of debts) pays.push(await payment(uid, d))
    for (const a of pays) await age(a, 40)
    await release({ limit: 500 })
    await paidOut(uid, (await wallet(uid)).available)
    const ids: string[] = []
    for (const a of pays) {
      expect(await reverse(a)).toMatchObject({ reversed: true, debited: 0, insolvent: true })
      ids.push(claw.clawbackId(a))
    }
    return ids
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    claw = await import('@/lib/clawbacks/clawbackService')
    reconcileWallet = (await import('@/lib/reconciliation/wallets')).reconcileOneWallet
  }, T)
  beforeEach(() => {
    vi.restoreAllMocks()
    failClawbackRead = 0
    const orig = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) =>
      orig(async tx => {
        const get = tx.get.bind(tx) as (q: unknown) => unknown
        ;(tx as unknown as { get: unknown }).get = (q: unknown) => {
          const isClawQuery = !!q && typeof q === 'object' && !(q as { path?: unknown }).path
            && String((q as { _queryOptions?: { collectionId?: unknown } })._queryOptions?.collectionId) === 'walletClawbacks'
          if (failClawbackRead > 0 && isClawQuery) { failClawbackRead--; throw new Error('simulated transient failure reading clawbacks') }
          return get(q)
        }
        return fn(tx)
      }, opts)) as never)
  })

  it('1 · the original scenario: ₹600 debt, then ₹500 and ₹800 credits — credit never recovers; BOTH release; pending always matches; ledgers exact', async () => {
    const uid = org()
    const A = await payment(uid, 100_000)                                   // ₹1,000
    await age(A, 20); await release({ limit: 500 })
    expect(await wallet(uid)).toEqual({ pending: 0, available: 100_000, inTransit: 0, settled: 0 })
    await paidOut(uid, 60_000)                                              // ₹600 paid out
    expect(await reverse(A)).toMatchObject({ reversed: true, debited: 40_000, insolvent: true })
    const clawbackId = claw.clawbackId(A)
    expect((await clawbacks(uid))[0]).toMatchObject({ id: clawbackId, outstandingAmountPaise: 60_000, recoveredAmountPaise: 40_000, status: 'partially_recovered' })
    expect(await wallet(uid)).toEqual({ pending: 0, available: 0, inTransit: 0, settled: 60_000 })
    await reconClean(uid)
    // credits: pending grows by the FULL nets; the debt is untouched
    const B = await payment(uid, 50_000)
    expect(await wallet(uid)).toMatchObject({ pending: 50_000, available: 0 })
    expect((await clawbacks(uid))[0]).toMatchObject({ outstandingAmountPaise: 60_000, recoveredAmountPaise: 40_000, status: 'partially_recovered' })
    const C = await payment(uid, 80_000)
    expect(await wallet(uid)).toMatchObject({ pending: 130_000, available: 0 })
    await pendingInvariant(uid)
    // releases (B older than C)
    await age(B, 10); await age(C, 9)
    const run = await release({ limit: 500 })
    expect(run.failures).toBe(0)
    expect((await ptx(B)).releaseStatus).toBe('released')
    expect((await ptx(C)).releaseStatus).toBe('released')
    expect(await wallet(uid)).toEqual({ pending: 0, available: 70_000, inTransit: 0, settled: 60_000 })
    expect(await releaseRec(B)).toEqual([expect.objectContaining({ amountPaise: 50_000, recoveredClawbackPaise: 50_000, creditedAvailablePaise: 0, clawbackRecoveries: [{ clawbackId, amountPaise: 50_000 }] })])
    expect(await releaseRec(C)).toEqual([expect.objectContaining({ amountPaise: 80_000, recoveredClawbackPaise: 10_000, creditedAvailablePaise: 70_000, clawbackRecoveries: [{ clawbackId, amountPaise: 10_000 }] })])
    expect((await clawbacks(uid))[0]).toMatchObject({ outstandingAmountPaise: 0, recoveredAmountPaise: 100_000, status: 'recovered', resolvedBy: 'system', lastRecovery: { transactionId: C, amountPaise: 10_000 } })
    await pendingInvariant(uid)
    await reconClean(uid)
    const events = (await db.collection('adminAuditLogs').where('entityId', '==', clawbackId).get()).docs.map(d => d.data().action).sort()
    expect(events).toEqual(['clawback.created', 'clawback.partially_recovered', 'clawback.recovered'])
    // repeated / concurrent release runs change nothing
    await Promise.all([release({ limit: 500 }), release({ limit: 500 }), release({ limit: 500 })])
    expect(await wallet(uid)).toEqual({ pending: 0, available: 70_000, inTransit: 0, settled: 60_000 })
    expect((await releaseRec(B)).length + (await releaseRec(C)).length).toBe(2)
    expect((await clawbacks(uid))[0]).toMatchObject({ recoveredAmountPaise: 100_000 })
  }, T)

  it('2 · zero debt: the release credits its full amount (recoveredClawbackPaise 0)', async () => {
    const uid = org()
    const X = await payment(uid, 12_345)
    await age(X, 5); await release({ limit: 500 })
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 12_345 })
    expect(await releaseRec(X)).toEqual([expect.objectContaining({ amountPaise: 12_345, recoveredClawbackPaise: 0, creditedAvailablePaise: 12_345 })])
    expect((await releaseRec(X))[0].clawbackRecoveries).toBeUndefined()
    await reconClean(uid)
  }, T)

  it('3 · several debts: oldest first, partial recovery, debt larger than a release; waived and manually recovered debts are never taken', async () => {
    const uid = org()
    // creation order = age: manual (oldest), waived, old, newer
    const [manualId, waivedId, oldId, newerId] = await withDebts(uid, [7_000, 5_000, 30_000, 40_000])
    const old = { clawbackId: oldId }, newer = { clawbackId: newerId }, waived = { clawbackId: waivedId }, manual = { clawbackId: manualId }
    expect((await claw.waiveClawback(waived.clawbackId, 'cbr-super', 'organizer settled offline')).ok).toBe(true)
    expect((await claw.markClawbackRecovered(manual.clawbackId, 'cbr-super', 'collected by bank transfer')).ok).toBe(true)
    const before = await wallet(uid)
    const X = await payment(uid, 50_000)
    await age(X, 3); await release({ limit: 500 })
    // 30,000 clears the older debt, 20,000 goes to the newer (debt larger than what is left of the release)
    expect(await releaseRec(X)).toEqual([expect.objectContaining({ recoveredClawbackPaise: 50_000, creditedAvailablePaise: 0,
      clawbackRecoveries: [{ clawbackId: old.clawbackId, amountPaise: 30_000 }, { clawbackId: newer.clawbackId, amountPaise: 20_000 }] })])
    const cs = new Map((await clawbacks(uid)).map(c => [c.id, c]))
    expect(cs.get(old.clawbackId)).toMatchObject({ outstandingAmountPaise: 0, status: 'recovered' })
    expect(cs.get(newer.clawbackId)).toMatchObject({ outstandingAmountPaise: 20_000, status: 'partially_recovered' })
    expect(cs.get(waived.clawbackId)).toMatchObject({ status: 'waived', outstandingAmountPaise: 5_000 })
    expect(cs.get(manual.clawbackId)).toMatchObject({ status: 'recovered', outstandingAmountPaise: 0 })
    expect(await wallet(uid)).toMatchObject({ pending: before.pending, available: before.available })
    const Y = await payment(uid, 30_000)
    await age(Y, 2); await release({ limit: 500 })
    expect(await releaseRec(Y)).toEqual([expect.objectContaining({ recoveredClawbackPaise: 20_000, creditedAvailablePaise: 10_000 })])
    expect((await clawbacks(uid)).find(c => c.id === newer.clawbackId)).toMatchObject({ outstandingAmountPaise: 0, status: 'recovered' })
    expect(await wallet(uid)).toMatchObject({ available: before.available + 10_000 })
    await pendingInvariant(uid)
  }, T)

  it('4 · payout commitments: money available and promised to a payout (in transit) is never taken; only the release pays the debt', async () => {
    const uid = org()
    const R = await payment(uid, 30_000)                                   // released revenue the organizer keeps
    await age(R, 50); await release({ limit: 500 })
    await withDebts(uid, [50_000])                                         // pays out the 30,000 too…
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: 30_000, settledPaise: FS.FieldValue.increment(-30_000), inTransitPaise: 25_000 })
    // …so put the 30,000 back as available with a 25,000 payout reserved against it (synthetic payout state)
    const X = await payment(uid, 20_000)
    await age(X, 3); await release({ limit: 500 })
    expect(await releaseRec(X)).toEqual([expect.objectContaining({ recoveredClawbackPaise: 20_000, creditedAvailablePaise: 0 })])
    expect(await wallet(uid)).toMatchObject({ available: 30_000, inTransit: 25_000 })     // untouched
    expect((await clawbacks(uid))[0]).toMatchObject({ outstandingAmountPaise: 30_000 })
  }, T)

  it('5 · a failed release transaction changes NOTHING; the retry recovers exactly once', async () => {
    const uid = org()
    const [clawbackId] = await withDebts(uid, [15_000])
    const X = await payment(uid, 40_000)
    await age(X, 3)
    const w0 = await wallet(uid)
    failClawbackRead = 1
    const r1 = await release({ limit: 500 })
    expect(r1.failures).toBeGreaterThanOrEqual(1)
    expect((await ptx(X)).releaseStatus).toBe('pending')
    expect(await wallet(uid)).toEqual(w0)
    expect(await releaseRec(X)).toEqual([])
    expect((await clawbacks(uid))[0]).toMatchObject({ outstandingAmountPaise: 15_000 })
    await release({ limit: 500 })
    expect(await releaseRec(X)).toEqual([expect.objectContaining({ recoveredClawbackPaise: 15_000, creditedAvailablePaise: 25_000 })])
    expect(await wallet(uid)).toMatchObject({ pending: w0.pending - 40_000, available: w0.available + 25_000 })
    expect((await clawbacks(uid)).find(c => c.id === clawbackId)).toMatchObject({ outstandingAmountPaise: 0, status: 'recovered' })
    await pendingInvariant(uid)
  }, T)

  it('6 · an unaccountable clawback value fails the release CLOSED (nothing moves); once corrected it releases', async () => {
    const uid = org()
    const [clawbackId] = await withDebts(uid, [9_000])
    await db.doc(`walletClawbacks/${clawbackId}`).update({ outstandingAmountPaise: 'nine thousand' })
    const X = await payment(uid, 10_000)
    await age(X, 3)
    const w0 = await wallet(uid)
    expect((await release({ limit: 500 })).failures).toBeGreaterThanOrEqual(1)
    expect((await ptx(X)).releaseStatus).toBe('pending')
    expect(await wallet(uid)).toEqual(w0)
    await db.doc(`walletClawbacks/${clawbackId}`).update({ outstandingAmountPaise: 9_000 })
    await release({ limit: 500 })
    expect(await releaseRec(X)).toEqual([expect.objectContaining({ recoveredClawbackPaise: 9_000, creditedAvailablePaise: 1_000 })])
  }, T)

  it('7 · concurrent: release vs waive, release vs manual recovery, release vs a new credit — every record agrees', async () => {
    for (const action of ['waive', 'manual'] as const) {
      const uid = org()
      const [clawbackId] = await withDebts(uid, [20_000])
      const X = await payment(uid, 15_000)
      await age(X, 3)
      const w0 = await wallet(uid)
      const [, r] = await Promise.all([
        release({ limit: 500 }),
        action === 'waive' ? claw.waiveClawback(clawbackId, 'cbr-super', 'forgiven by finance') : claw.markClawbackRecovered(clawbackId, 'cbr-super', 'collected offline'),
      ])
      expect(r.ok).toBe(true)
      const rel = (await releaseRec(X))[0]
      const c = (await clawbacks(uid)).find(x => x.id === clawbackId)!
      // whichever committed first, the release's recovery is exactly what the clawback received, never more
      expect(rel.recoveredClawbackPaise + rel.creditedAvailablePaise).toBe(15_000)
      expect(await wallet(uid)).toMatchObject({ pending: w0.pending - 15_000, available: w0.available + rel.creditedAvailablePaise })
      if (rel.recoveredClawbackPaise > 0) expect(c.lastRecovery).toMatchObject({ transactionId: X, amountPaise: 15_000 })
      expect(c.status).toBe(action === 'waive' ? 'waived' : 'recovered')
      await pendingInvariant(uid)
    }
    // a credit racing a release: pending stays exact
    const uid = org()
    await withDebts(uid, [5_000])
    const X = await payment(uid, 8_000)
    await age(X, 3)
    const [, Y] = await Promise.all([release({ limit: 500 }), payment(uid, 4_000)])
    expect(await releaseRec(X)).toEqual([expect.objectContaining({ recoveredClawbackPaise: 5_000, creditedAvailablePaise: 3_000 })])
    expect((await ptx(Y)).releaseStatus).toBe('pending')
    await pendingInvariant(uid)
  }, T)
})
