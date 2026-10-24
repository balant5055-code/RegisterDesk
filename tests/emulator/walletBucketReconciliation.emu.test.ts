// Phase 3.1 — PER-BUCKET wallet reconciliation (report-only), on REAL Firestore through the real credit,
// reversal, release and donation-refund paths. Each bucket is derived from the ledger; money in the wrong
// bucket is reported even when the total is right; open payout reservations (in-transit, held INSIDE
// available) are never a mismatch; a bucket that cannot be derived gets no verdict. Nothing is written.
//
// Payout requests are seeded in the exact shape the organizer settlement route writes (reserved: true,
// inTransitPaise += amount, availablePaise unchanged) — synthetic, documented.

import { describe, it, expect, beforeAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const DAY = 86_400_000

vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 3.1 · per-bucket wallet reconciliation', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let recon: typeof import('@/lib/reconciliation/wallets')
  let applyDonation: typeof import('@/lib/donations/refundService').applyDonationRefundAccounting
  let n = 0

  const org = () => `wbr2-org-${P}-${++n}`
  const walletDoc = async (uid: string) => (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!
  const check = async (uid: string) => recon.reconcileOneWallet(uid, await walletDoc(uid))
  const report = async (uid: string) => recon.reconcileWalletBuckets(uid, await walletDoc(uid))
  const age = (ptxId: string, d: number) => db.doc(`platformTransactions/${ptxId}`).update({ paidAt: new Date(Date.now() - d * DAY) })
  async function payment(uid: string, net: number, kind: 'registration' | 'donation' = 'registration') {
    const id = `wbr2-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed', organizerUid: uid,
      entityId: 'e', entityType: kind === 'donation' ? 'campaign' : 'event', sourceId: id, sourceType: kind, payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net,
      platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays',
      planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `p_${id}`, gatewayOrderId: `o_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    return { id, ptxId: `ptx_${id}` }
  }
  /** Mirrors the organizer settlement route: a reserved request; inTransit += amount, available unchanged. */
  async function payoutRequest(uid: string, amount: number, status: 'pending' | 'approved' | 'paid' = 'pending') {
    await db.collection('settlementRequests').doc(`wbr2-sr-${P}-${++n}`).set({ organizerUid: uid, amountPaise: amount, status, reserved: true, requestedAt: new Date() })
    if (status === 'paid') {
      await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: FS.FieldValue.increment(-amount), settledPaise: FS.FieldValue.increment(amount) })
    } else {
      await db.doc(`organizerRevenueWallets/${uid}`).update({ inTransitPaise: FS.FieldValue.increment(amount) })
    }
  }
  /** A pending-and-released organizer with an OPEN payout request — the state that used to read as a mismatch. */
  async function healthy() {
    const uid = org()
    const a = await payment(uid, 70_000); await age(a.ptxId, 20); await release({ limit: 500 })
    await payment(uid, 30_000)                                                 // unreleased
    await payoutRequest(uid, 20_000, 'paid')
    await payoutRequest(uid, 15_000, 'pending')                                 // open: in transit
    return uid
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    recon = await import('@/lib/reconciliation/wallets')
    applyDonation = (await import('@/lib/donations/refundService')).applyDonationRefundAccounting
  }, T)

  it('1 · a consistent wallet with an OPEN payout request reports NOTHING (in transit is inside available); the detailed report shows each bucket', async () => {
    const uid = await healthy()
    expect(await walletDoc(uid)).toMatchObject({ pendingPaise: 30_000, availablePaise: 50_000, inTransitPaise: 15_000, settledPaise: 20_000 })
    expect(await check(uid)).toEqual([])
    const r = await report(uid)
    expect(r.buckets).toEqual([
      { bucket: 'pendingPaise', expected: 30_000, stored: 30_000, variance: 0, verdict: 'ok' },
      { bucket: 'availablePaise', expected: 50_000, stored: 50_000, variance: 0, verdict: 'ok' },
      { bucket: 'inTransitPaise', expected: 15_000, stored: 15_000, variance: 0, verdict: 'ok' },
      { bucket: 'settledPaise', expected: 20_000, stored: 20_000, variance: 0, verdict: 'ok' },
    ])
    expect(r.inTransitExcessPaise).toBe(0)
  }, T)

  it('2 · each bucket is checked on its own: wrong bucket with a correct total, in-transit not matching reservations, in-transit above available, settled', async () => {
    // money moved pending → available (total unchanged — invisible to the sum check)
    const a = await healthy()
    await db.doc(`organizerRevenueWallets/${a}`).update({ pendingPaise: 25_000, availablePaise: 55_000 })
    expect((await check(a)).map(m => [m.field, m.expected, m.actual])).toEqual([['pendingPaise', 30_000, 25_000], ['availablePaise', 50_000, 55_000]])
    // in-transit drifted from the reservations
    const b = await healthy()
    await db.doc(`organizerRevenueWallets/${b}`).update({ inTransitPaise: 18_000 })
    expect((await check(b)).map(m => [m.field, m.expected, m.actual])).toEqual([['inTransitPaise', 15_000, 18_000]])
    // reservations above the available money (a payout no longer backed)
    const c = await healthy()
    await payoutRequest(c, 40_000, 'approved')                                 // 55,000 reserved > 50,000 available
    expect((await check(c)).map(m => [m.field, m.expected, m.actual])).toEqual([['inTransitWithinAvailable', 0, 5_000]])
    // settled drift: reported once (as before), plus where the money now sits
    const e = await healthy()
    await db.doc(`organizerRevenueWallets/${e}`).update({ settledPaise: 21_000, availablePaise: 49_000 })
    expect((await check(e)).map(m => m.field).sort()).toEqual(['availablePaise', 'settledPaise'])
    // a forged credit to pending (total too high) is reported by the sum AND the bucket
    const f = await healthy()
    await db.doc(`organizerRevenueWallets/${f}`).update({ pendingPaise: 31_000 })
    expect((await check(f)).map(m => m.field).sort()).toEqual(['balanceSum', 'pendingPaise'])
  }, T)

  it('3 · refunds and clawback recovery reconcile per bucket (pending reversal, released reversal with a clawback, release-time recovery)', async () => {
    const uid = org()
    const a = await payment(uid, 60_000); await age(a.ptxId, 30); await release({ limit: 500 })
    await payoutRequest(uid, 50_000, 'paid')                                    // 10,000 left available
    const p = await payment(uid, 8_000)
    await reverse(p.ptxId)                                                      // unreleased refund: from pending
    await reverse(a.ptxId)                                                      // released refund: 10,000 debited, 50,000 clawback
    expect(await check(uid)).toEqual([])
    const b = await payment(uid, 70_000); await age(b.ptxId, 2); await release({ limit: 500 })   // recovers the 50,000 at release
    expect(await walletDoc(uid)).toMatchObject({ pendingPaise: 0, availablePaise: 20_000, settledPaise: 50_000 })
    expect(await check(uid)).toEqual([])
  }, T)

  it('4 · a partially refunded, HELD donation: its reversal came out of pending — no false mismatch', async () => {
    const uid = org()
    const d = await payment(uid, 2_000, 'donation')
    await db.doc(`donations/${d.id}`).set({ amountPaise: 2_000, campaignSlug: 'c', campaignId: 'c', donorEmail: 'd@x.test', donorName: 'D', isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: `o_${d.id}`, organizerUid: uid })
    const refundId = `rfnd_wbr2_${P}_${++n}`
    await db.doc(`donationRefunds/${refundId}`).set({ id: refundId, donationId: d.id, campaignId: 'c', campaignSlug: 'c', organizerUid: uid, razorpayRefundId: refundId, razorpayPaymentId: `p_${d.id}`, amountPaise: 800, reason: 'test', status: 'pending', initiatedBy: 'webhook', createdAt: new Date() })
    await applyDonation(refundId)
    expect((await db.doc(`platformTransactions/${d.ptxId}`).get()).get('releaseStatus')).toBe('held')
    expect(await walletDoc(uid)).toMatchObject({ pendingPaise: 1_200 })
    expect(await check(uid)).toEqual([])
    expect((await report(uid)).buckets[0]).toMatchObject({ expected: 1_200, stored: 1_200 })
  }, T)

  it('5 · historical rows with no releaseStatus: pending/available get NO verdict (never a guessed mismatch); the sum and other buckets still report', async () => {
    const uid = await healthy()
    const legacy = await payment(uid, 5_000)
    await db.doc(`platformTransactions/${legacy.ptxId}`).update({ releaseStatus: FS.FieldValue.delete() })
    const r = await report(uid)
    expect(r.ledger).toMatchObject({ expectedPending: null, why: 'unknown_release_status', unknownReleaseStatus: { count: 1, sampleIds: [legacy.ptxId] } })
    expect(r.buckets.map(b => [b.bucket, b.verdict])).toEqual([['pendingPaise', 'unverifiable'], ['availablePaise', 'unverifiable'], ['inTransitPaise', 'ok'], ['settledPaise', 'ok']])
    // Phase 3.6A — no guessed mismatch, and no silent "clean" either: the wallet is UNVERIFIABLE, with the
    // legacy row named (an empty mismatch list used to read as clean)
    await expect(check(uid)).rejects.toBeInstanceOf(recon.WalletUnverifiableError)
    const v = await recon.verifyOneWallet(uid, await walletDoc(uid))
    expect(v).toMatchObject({ status: 'unverifiable', mismatches: [] })
    expect(v.unverifiable.map(u => u.check)).toEqual(expect.arrayContaining(['pendingPaise', 'availablePaise', 'legacy_rows']))
    expect(v.unverifiable.find(u => u.check === 'legacy_rows')!.reason).toContain(legacy.ptxId)
    // a wallet with no inTransitPaise / settledPaise fields at all (pre-payout era) reads them as 0
    const old = org()
    const x = await payment(old, 4_000)
    await db.doc(`organizerRevenueWallets/${old}`).update({ inTransitPaise: FS.FieldValue.delete(), settledPaise: FS.FieldValue.delete() })
    expect(await check(old)).toEqual([])
    expect(x).toBeTruthy()
  }, T)

  it('6 · reconciliation is READ-ONLY: wallets, requests and ledger are unchanged by a run', async () => {
    const uid = await healthy()
    await db.doc(`organizerRevenueWallets/${uid}`).update({ pendingPaise: 1 })   // a mismatch to report
    const before = JSON.stringify(await walletDoc(uid))
    const reqsBefore = (await db.collection('settlementRequests').where('organizerUid', '==', uid).get()).docs.map(d => JSON.stringify(d.data())).sort()
    await check(uid); await report(uid)
    expect(JSON.stringify(await walletDoc(uid))).toBe(before)
    expect((await db.collection('settlementRequests').where('organizerUid', '==', uid).get()).docs.map(d => JSON.stringify(d.data())).sort()).toEqual(reqsBefore)
  }, T)
})
