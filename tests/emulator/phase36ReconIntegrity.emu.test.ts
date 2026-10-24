// Phase 3.6A — reconciliation integrity, REPORT-ONLY, on REAL Firestore (synthetic emulator data only):
//   A · a wallet check that cannot complete is UNVERIFIABLE — never clean — and that reaches the global run,
//       the persisted reports and operations health (the Phase 3.5 false-clean: a real 777-paisa discrepancy
//       vanished once one input became unreadable)
//   B · per-donation refund integrity over records written by the REAL refund accounting
// Nothing here changes financial behaviour; the only writes are test fixtures and reconciliation reports.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000

const probe = vi.hoisted(() => ({ failReversedRead: false }))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))
// The in-place-reversal read is the input the Phase 3.5 probe made unreadable; everything else stays real.
vi.mock('@/lib/finance/financeAnalytics', async orig => {
  const real = await orig<typeof import('@/lib/finance/financeAnalytics')>()
  return { ...real, getInPlaceReversedNet: async (...a: Parameters<typeof real.getInPlaceReversedNet>) => (probe.failReversedRead ? { ok: false, reason: 'query_failed' } : real.getInPlaceReversedNet(...a)) }
})

describeEmu('Phase 3.6A · reconciliation integrity (report-only)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let wallets: typeof import('@/lib/reconciliation/wallets')
  let dons: typeof import('@/lib/reconciliation/donationRefunds')
  let svc: typeof import('@/lib/donations/refundService')
  let n = 0

  const walletDoc = async (uid: string) => (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!
  async function payment(uid: string, gross: number, net: number, kind: 'registration' | 'donation', id = `p36-${P}-${++n}`) {
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed', organizerUid: uid,
      entityId: 'e', entityType: kind === 'donation' ? 'campaign' : 'event', sourceId: id, sourceType: kind, payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: gross,
      platformFeeBasePaise: gross - net, platformFeeGstPaise: 0, platformFeeTotalPaise: gross - net, gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays',
      planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `p_${id}`, gatewayOrderId: `o_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: gross, feesTotalPaise: gross - net, netSettlementPaise: net } as never)
    if (kind === 'donation') {
      await db.doc(`donations/${id}`).set({ amountPaise: gross, campaignId: 'c', campaignSlug: `p36-camp-${P}`, organizerUid: uid, donorEmail: `d${n}@x.test`, donorName: 'D', isAnonymous: false,
        status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: `o_${id}`, razorpayPaymentId: `p_${id}` })
    }
    return { id, ptxId: `ptx_${id}` }
  }
  const releaseNow = async (ptxId: string) => { await db.doc(`platformTransactions/${ptxId}`).update({ paidAt: new Date(Date.now() - 40 * DAY) }); await release({ limit: 500 }) }
  /** A refund accounted by the REAL accounting (record + applyDonationRefundAccounting). */
  async function accounted(donationId: string, uid: string, refundId: string, amount: number) {
    await svc.ensureRefundRecord({ refundId, donationId, campaignId: 'c', campaignSlug: `p36-camp-${P}`, organizerUid: uid, razorpayPaymentId: `p_${donationId}`, amountPaise: amount, reason: 'test', initiatedBy: 'webhook' })
    await svc.applyDonationRefundAccounting(refundId)
  }
  const fields = (v: { mismatches: Array<{ field: string }> }) => v.mismatches.map(m => m.field)

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    credit = (await import('@/lib/firebase/firestore/platformTransactions')).recordPlatformTransactionAndCredit
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    wallets = await import('@/lib/reconciliation/wallets')
    dons = await import('@/lib/reconciliation/donationRefunds')
    svc = await import('@/lib/donations/refundService')
  }, T)

  // The open-attempt fixture (B1) sits in shared lists (open attempts, held settlements): removed afterwards.
  afterAll(async () => {
    if (!db) return
    const id = `p36don-${P}-b1x`
    await Promise.all([db.doc(`donations/${id}`).delete(), db.doc(`platformTransactions/ptx_${id}`).delete()])
  }, T)

  // ═══ A · wallets ═══

  it('A1 · the 777-paisa discrepancy: reported as a mismatch while readable; UNVERIFIABLE (not clean) once an input is unreadable; a clean wallet stays clean', async () => {
    const uid = `p36-org-${P}-a1`
    const a = await payment(uid, 5_000, 5_000, 'registration'); await releaseNow(a.ptxId)
    expect(await wallets.verifyOneWallet(uid, await walletDoc(uid))).toEqual({ status: 'clean', mismatches: [], unverifiable: [] })
    expect(await wallets.reconcileOneWallet(uid, await walletDoc(uid))).toEqual([])
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: FS.FieldValue.increment(777) })
    const readable = await wallets.verifyOneWallet(uid, await walletDoc(uid))
    expect(readable.status).toBe('mismatch')
    expect(readable.mismatches.map(m => ({ field: m.field, expected: m.expected, actual: m.actual }))).toEqual(expect.arrayContaining([
      { field: 'balanceSum', expected: 5_000, actual: 5_777 }, { field: 'availablePaise', expected: 5_000, actual: 5_777 },
    ]))
    probe.failReversedRead = true
    try {
      const unreadable = await wallets.verifyOneWallet(uid, await walletDoc(uid))
      expect(unreadable.status).toBe('unverifiable')                                     // the Phase 3.5 probe returned [] here
      expect(unreadable.unverifiable).toEqual(expect.arrayContaining([
        { entityType: 'wallet', entityId: uid, check: 'balanceSum', reason: 'in_place_reversals_query_failed' },
        expect.objectContaining({ check: 'availablePaise', reason: 'total_unverifiable' }),
      ]))
      expect(fields(unreadable)).not.toContain('balanceSum')                             // no guessed verdict
      await expect(wallets.reconcileOneWallet(uid, await walletDoc(uid))).rejects.toBeInstanceOf(wallets.WalletUnverifiableError)
    } finally { probe.failReversedRead = false }
  }, T)

  it('A2 · legacy shapes are unverifiable, never read as zero — except a payout-era field whose own source corroborates 0; a ledger row without releaseStatus', async () => {
    // pending / available have no independent source: absent ⇒ unverifiable
    const uid = `p36-org-${P}-a2`
    await payment(uid, 3_000, 3_000, 'registration')
    await db.doc(`organizerRevenueWallets/${uid}`).update({ pendingPaise: FS.FieldValue.delete() })
    const v = await wallets.verifyOneWallet(uid, await walletDoc(uid))
    expect(v.status).toBe('unverifiable')
    expect(v.unverifiable).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'stored:pendingPaise', reason: 'field_missing' })]))
    // settled absent while a PAID payout request exists: not corroborated ⇒ unverifiable
    const uidS = `p36-org-${P}-a2s`
    const s1 = await payment(uidS, 4_000, 4_000, 'registration'); await releaseNow(s1.ptxId)
    await db.collection('settlementRequests').doc(`p36-sr-${P}-${++n}`).set({ organizerUid: uidS, amountPaise: 1_000, status: 'paid', reserved: true })
    await db.doc(`organizerRevenueWallets/${uidS}`).update({ availablePaise: 3_000, settledPaise: FS.FieldValue.delete() })
    expect((await wallets.verifyOneWallet(uidS, await walletDoc(uidS))).unverifiable).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'stored:settledPaise', reason: 'field_missing' })]))
    // a pre-payout-era wallet (no inTransit / settled fields, and no payout requests at all): corroborated 0 ⇒ clean
    const uidO = `p36-org-${P}-a2o`
    await payment(uidO, 2_500, 2_500, 'registration')
    await db.doc(`organizerRevenueWallets/${uidO}`).update({ inTransitPaise: FS.FieldValue.delete(), settledPaise: FS.FieldValue.delete() })
    expect(await wallets.verifyOneWallet(uidO, await walletDoc(uidO))).toEqual({ status: 'clean', mismatches: [], unverifiable: [] })
    const uid2 = `p36-org-${P}-a2b`
    const b = await payment(uid2, 2_000, 2_000, 'registration')
    await db.doc(`platformTransactions/${b.ptxId}`).update({ releaseStatus: FS.FieldValue.delete() })
    const v2 = await wallets.verifyOneWallet(uid2, await walletDoc(uid2))
    expect(v2.status).toBe('unverifiable')
    expect(v2.unverifiable.map(u => u.check)).toEqual(expect.arrayContaining(['pendingPaise', 'legacy_rows']))
    expect(v2.unverifiable.find(u => u.check === 'legacy_rows')!.reason).toContain(b.ptxId)
  }, T)

  it('A3 · the status reaches the aggregate run, the persisted reports and operations health (with an alert)', async () => {
    const { runGlobalReconciliation } = await import('@/lib/reconciliation')
    const { getOperationsHealth, evaluateAlerts } = await import('@/lib/operations/healthMetrics')
    probe.failReversedRead = true
    let r: Awaited<ReturnType<typeof runGlobalReconciliation>>
    try { r = await runGlobalReconciliation({ limit: 5_000 }) } finally { probe.failReversedRead = false }
    expect(r.scanned.wallets).toBeGreaterThan(0)
    expect(r.unverifiableByType.wallet).toBeGreaterThanOrEqual(r.scanned.wallets)         // every wallet: its total could not be checked
    expect(r.totalUnverifiable).toBeGreaterThan(0)
    const reports = (await db.collection('reconciliationReports').where('kind', '==', 'unverifiable').where('entityType', '==', 'wallet').get()).docs.map(d => d.data())
    expect(reports.length).toBeGreaterThan(0)
    expect(reports[0]).toMatchObject({ kind: 'unverifiable', repaired: false, field: expect.any(String), reason: expect.any(String) })
    const h = await getOperationsHealth()
    expect(h.dataIntegrity.walletUnverifiable).toBeGreaterThan(0)
    expect(evaluateAlerts(h).map(a => a.id)).toContain('wallet_unverifiable')
    // nothing financial was written: wallets are untouched by the run
    const uid = `p36-org-${P}-a1`
    expect((await walletDoc(uid)).availablePaise).toBe(5_777)
  }, T)

  // ═══ B · per-donation refund integrity (records from the real accounting) ═══

  it('B1 · partial, then full (three parts), accounted by the real engine: clean; amounts kept apart; an open attempt + its reservation: clean', async () => {
    const uid = `p36-org-${P}-b1`
    const d = await payment(uid, 100_000, 95_000, 'donation', `p36don-${P}-b1`)
    await accounted(d.id, uid, `rfnd_p36_b1a_${P}`, 33_333)
    const partial = await dons.verifyDonationRefunds(d.id)
    expect(partial).toMatchObject({ status: 'clean', amounts: { accountedPaise: 33_333, reversedNetPaise: 31_666 } })
    await accounted(d.id, uid, `rfnd_p36_b1b_${P}`, 33_333)
    await accounted(d.id, uid, `rfnd_p36_b1c_${P}`, 33_334)
    expect(await dons.verifyDonationRefunds(d.id)).toMatchObject({ status: 'clean', amounts: { accountedPaise: 100_000, reversedNetPaise: 95_000 } })
    // an organizer request in flight: reserved + open attempt
    const d2 = await payment(uid, 5_000, 5_000, 'donation', `p36don-${P}-b1x`)
    expect(await svc.reserveRefund(d2.id, 1_200)).toMatchObject({ ok: true })
    expect(await svc.beginDonationRefundAttempt({ donationId: d2.id, attemptId: `att_p36b1${P}xxxx`, amountPaise: 1_200, paymentId: `p_${d2.id}`, by: 'org' })).toMatchObject({ ok: true })
    expect(await dons.verifyDonationRefunds(d2.id)).toMatchObject({ status: 'clean', amounts: { reservedPaise: 1_200 } })
  }, T)

  it('B2 · drift is reported — refunded / reserved fields, a missing reversal row, a missing linked record — and a legacy rounding residue as its own kind', async () => {
    const uid = `p36-org-${P}-b2`
    const d = await payment(uid, 10_000, 9_500, 'donation', `p36don-${P}-b2`)
    const rid = `rfnd_p36_b2_${P}`
    await accounted(d.id, uid, rid, 4_000)
    await db.doc(`donations/${d.id}`).update({ refundedAmountPaise: 4_001, pendingRefundPaise: 5, [`refundAttempts.att_p36b2${P}zzzz`]: { status: 'linked', amountPaise: 900, refundId: 'rfnd_missing', paymentId: 'p', by: 'o', startedAt: FS.Timestamp.now() } })
    const v = await dons.verifyDonationRefunds(d.id)
    expect(v.status).toBe('mismatch')
    expect(fields(v)).toEqual(expect.arrayContaining(['refundedAmountPaise', 'pendingRefundPaise', `attemptLink:att_p36b2${P}zzzz`]))
    await db.doc(`platformTransactions/ptx_refund_${rid}`).delete()
    expect(fields(await dons.verifyDonationRefunds(d.id))).toContain(`reversalRow:${rid}`)
    // legacy: three 333-paisa refunds of a 999/950 donation reversed 317 each (old per-refund rounding)
    const L = await payment(uid, 999, 950, 'donation', `p36don-${P}-lg`)
    for (const s of ['a', 'b', 'c']) {
      const id = `rfnd_p36_lg${s}_${P}`
      await svc.ensureRefundRecord({ refundId: id, donationId: L.id, campaignId: 'c', campaignSlug: `p36-camp-${P}`, organizerUid: uid, razorpayPaymentId: `p_${L.id}`, amountPaise: 333, reason: 'legacy', initiatedBy: 'webhook' })
      await db.doc(`donationRefunds/${id}`).update({ status: 'processed', ledgerReversedPaise: 317 })
      await db.doc(`platformTransactions/ptx_refund_${id}`).set({ organizerUid: uid, parentTransactionId: L.ptxId, refundId: id, status: 'refunded', grossAmountPaise: -333, netSettlementPaise: -317, sourceType: 'donation' })
    }
    await db.doc(`donations/${L.id}`).update({ refundedAmountPaise: 999, status: 'refunded' })
    const lv = await dons.verifyDonationRefunds(L.id)
    expect(lv.mismatches.map(m => ({ field: m.field, expected: m.expected, actual: m.actual }))).toEqual([{ field: 'legacyRoundingResidue', expected: 950, actual: 951 }])
  }, T)

  it('B3 · the donation pass of the global run is bounded, cursor-resumed and report-only', async () => {
    const page1 = await dons.reconcileDonationRefunds({ limit: 2 })
    expect(page1).toMatchObject({ entityType: 'donation', repaired: 0 })
    expect(page1.scanned).toBeLessThanOrEqual(2)
    const page2 = await dons.reconcileDonationRefunds({ limit: 5_000 })
    expect(page2.scanned).toBeGreaterThan(0)
    const all = [...page1.mismatches, ...page2.mismatches].map(m => `${m.entityId}:${m.field}`)
    expect(all).toContain(`p36don-${P}-lg:legacyRoundingResidue`)
    expect(all.filter(x => x.startsWith(`p36don-${P}-b1:`))).toEqual([])                      // the clean donation reports nothing
  }, T)
})
