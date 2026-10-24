// Phase 3.8 — read-only integrity coverage on REAL Firestore (synthetic emulator data only). The checks are
// report-only; the only writes are test fixtures (built through the real engine where one exists: credit,
// release, donation accounting, registration refund counting / reversal).
//   A · row-driven donation ledger / refund-record checks
//   B · stuck settlement releases — and the real release job refuses exactly the row the report calls stuck
//   C · registration refund reconciliation, including the known M4 gap

import { describe, it, expect, beforeAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000

vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 3.8 · read-only integrity coverage', () => {
  let db: import('firebase-admin/firestore').Firestore
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let svc: typeof import('@/lib/donations/refundService')
  let regRefunds: typeof import('@/lib/refunds/registrationRefunds')
  let rows: typeof import('@/lib/reconciliation/donationLedgerRows')
  let stuck: typeof import('@/lib/reconciliation/stuckReleases')
  let regRecon: typeof import('@/lib/reconciliation/registrationRefunds')
  let n = 0

  async function payment(uid: string, net: number, kind: 'registration' | 'donation', id = `p38-${P}-${++n}`) {
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed', organizerUid: uid,
      entityId: 'e', entityType: kind === 'donation' ? 'campaign' : 'event', sourceId: id, sourceType: kind, payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net,
      platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays',
      planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    if (kind === 'donation') {
      await db.doc(`donations/${id}`).set({ amountPaise: net, campaignId: 'c', campaignSlug: `p38-camp-${P}`, organizerUid: uid, donorEmail: `d${n}@x.test`, donorName: 'D', isAnonymous: false,
        status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: `order_${id}`, razorpayPaymentId: `pay_${id}` })
    } else {
      await db.doc(`paymentIntents/order_${id}`).set({ orderId: `order_${id}`, amount: net, registrationId: id, paymentId: `pay_${id}`, currency: 'INR', status: 'paid' })
      await db.doc(`registrations/${id}`).set({ paymentStatus: 'paid', organizerUid: uid, eventSlug: 'e' })
    }
    return { id, ptxId: `ptx_${id}`, orderId: `order_${id}`, paymentId: `pay_${id}` }
  }
  const age = (ptxId: string, days: number) => db.doc(`platformTransactions/${ptxId}`).update({ paidAt: new Date(Date.now() - days * DAY) })
  const regRefund = async (p: { id: string; orderId: string; paymentId: string }, refundId: string, amount: number) => {
    await regRefunds.ensureRegistrationRefundRecord({ razorpayRefundId: refundId, gatewayPaymentId: p.paymentId, gatewayOrderId: p.orderId, amountPaise: amount,
      origin: 'webhook', initiatedBy: 'webhook', reason: 'gateway_refund', registrationId: p.id, eventSlug: 'e', organizerUid: null } as never)
    return regRefunds.accumulatePaymentRefund(p.orderId, refundId, amount)
  }
  const regVerdict = async (orderId: string) => regRecon.evaluateRegistrationRefunds(await regRecon.readRegistrationRefundFacts(orderId))
  const fields = (v: { mismatches: Array<{ field: string }> }) => v.mismatches.map(m => m.field)

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    svc = await import('@/lib/donations/refundService')
    regRefunds = await import('@/lib/refunds/registrationRefunds')
    rows = await import('@/lib/reconciliation/donationLedgerRows')
    stuck = await import('@/lib/reconciliation/stuckReleases')
    regRecon = await import('@/lib/reconciliation/registrationRefunds')
  }, T)

  it('A · rows and records are checked from THEIR side: a missing donation, an orphan row on an inactive donation, a refund record naming no donation; consistent rows report nothing', async () => {
    const uid = `p38-org-${P}-a`
    const good = await payment(uid, 4_000, 'donation')
    const rid = `rfnd_p38_good_${P}`
    await svc.ensureRefundRecord({ refundId: rid, donationId: good.id, campaignId: 'c', campaignSlug: `p38-camp-${P}`, organizerUid: uid, razorpayPaymentId: good.paymentId, amountPaise: 1_000, reason: 't', initiatedBy: 'webhook' })
    await svc.applyDonationRefundAccounting(rid)
    // a donation deleted after its refund was accounted
    const gone = await payment(uid, 3_000, 'donation')
    const rid2 = `rfnd_p38_gone_${P}`
    await svc.ensureRefundRecord({ refundId: rid2, donationId: gone.id, campaignId: 'c', campaignSlug: `p38-camp-${P}`, organizerUid: uid, razorpayPaymentId: gone.paymentId, amountPaise: 500, reason: 't', initiatedBy: 'webhook' })
    await svc.applyDonationRefundAccounting(rid2)
    await db.doc(`donations/${gone.id}`).delete()
    // an orphan reversal row on a donation with no refund activity
    const idle = await payment(uid, 2_000, 'donation')
    await db.doc(`platformTransactions/ptx_refund_rfnd_p38_orphan_${P}`).set({ organizerUid: uid, parentTransactionId: idle.ptxId, status: 'refunded', sourceType: 'donation', grossAmountPaise: -100, netSettlementPaise: -100 })
    // a refund record naming no donation
    await db.doc(`donationRefunds/rfnd_p38_nodon_${P}`).set({ donationId: `p38-missing-${P}`, amountPaise: 10, status: 'pending', initiatedBy: 'webhook' })

    const ledger = await rows.reconcileDonationLedgerRows({ limit: 5_000 })
    const lf = ledger.mismatches.map(m => `${m.entityId}|${m.field}`)
    expect(lf).toContain(`${gone.id}|ledgerRowDonationMissing:ptx_refund_${rid2}`)
    expect(lf).toContain(`${idle.id}|ledgerRowOnInactiveDonation:ptx_refund_rfnd_p38_orphan_${P}`)
    expect(lf.filter(x => x.startsWith(`${good.id}|`))).toEqual([])                    // the consistent row reports nothing
    const recs = await rows.reconcileDonationRefundRecords({ limit: 5_000 })
    expect(recs.mismatches.map(m => `${m.entityId}|${m.field}`)).toContain(`p38-missing-${P}|refundRecordDonationMissing:rfnd_p38_nodon_${P}`)
    // the scan is cursor-resumed: a page of 1 resumes after it, and a time budget of 0 reports the page as unchecked
    const one = await rows.reconcileDonationRefundRecords({ limit: 1 })
    expect(one.scanned).toBe(1)
    const cut = await rows.reconcileDonationLedgerRows({ limit: 5_000, budgetMs: -1 })
    expect(cut.scanned).toBe(0)
    expect(cut.unverifiable).toEqual([expect.objectContaining({ check: 'scan:recon:donation-ledger-rows', reason: expect.stringMatching(/^budget_exhausted_after:/) })])
  }, T)

  it('B · a row the organizer\'s pending cannot cover is reported STUCK — and the real release job refuses exactly that row; nothing is retried or changed by the report', async () => {
    const uid = `p38-org-${P}-b`
    const a = await payment(uid, 8_000, 'registration')
    const b = await payment(uid, 5_000, 'registration')
    await age(a.ptxId, 40); await age(b.ptxId, 39)
    // historical credit-time recovery left pending short of the unreleased nets (13,000 owed to release, 9,000 there)
    await db.doc(`organizerRevenueWallets/${uid}`).update({ pendingPaise: 9_000 })
    const before = JSON.stringify((await db.doc(`organizerRevenueWallets/${uid}`).get()).data())
    const report = (await stuck.reportStuckReleases()).entries.filter(e => e.organizerUid === uid)
    expect(report.map(e => [e.ptxId, e.verdict, e.reason, e.amountPaise])).toEqual([
      [a.ptxId, 'unverifiable', 'no_failure_evidence', 8_000],
      [b.ptxId, 'stuck', 'pending_below_release', 5_000],
    ])
    expect(report[1].evidence).toMatchObject({ pendingBeforeTurnPaise: 1_000, failureEvidencePersisted: false })
    expect(JSON.stringify((await db.doc(`organizerRevenueWallets/${uid}`).get()).data())).toBe(before)   // read-only
    const g = await stuck.reconcileStuckReleases()
    expect(g.mismatches).toEqual(expect.arrayContaining([expect.objectContaining({ entityType: 'release', entityId: b.ptxId, field: 'stuckRelease:pending_below_release', expected: 5_000, actual: 1_000 })]))
    // fidelity: the real job releases a and refuses b (INSUFFICIENT) — the report predicted exactly that
    await release({ limit: 500 })
    expect((await db.doc(`platformTransactions/${a.ptxId}`).get()).get('releaseStatus')).toBe('released')
    expect((await db.doc(`platformTransactions/${b.ptxId}`).get()).get('releaseStatus')).toBe('pending')
    // the deliberately stuck fixture is removed: left in place it would take part in (and fail) every later
    // release run on this emulator — exactly the effect the report exists to surface
    await db.doc(`platformTransactions/${b.ptxId}`).delete()
  }, T)

  it('C · registration refunds: partial held (clean), partial on RELEASED money (the M4 gap), full without its ledger reversal, a reversal with no refund', async () => {
    const uid = `p38-org-${P}-c`
    // partial on an unreleased payment: counted + held by the real engine → clean
    const p1 = await payment(uid, 10_000, 'registration')
    expect(await regRefund(p1, `rf_p38_p1_${P}`, 3_000)).toMatchObject({ kind: 'partial', settlementHeld: true })
    expect(await regVerdict(p1.orderId)).toEqual({ mismatches: [], unverifiable: [] })
    // partial on RELEASED money: the marker is there, and the known M4 gap is reported
    const p2 = await payment(uid, 10_000, 'registration')
    await age(p2.ptxId, 40); await release({ limit: 500 })
    expect(await regRefund(p2, `rf_p38_p2_${P}`, 2_500)).toMatchObject({ kind: 'partial', settlementAlreadyReleased: true })
    expect((await regVerdict(p2.orderId)).mismatches).toEqual([expect.objectContaining({ entityId: p2.id, field: 'm4PartialRefundOnReleasedFunds', actual: 2_500 })])
    // full refund counted but the ledger reversal never happened (and the registration still 'paid')
    const p3 = await payment(uid, 6_000, 'registration')
    expect(await regRefund(p3, `rf_p38_p3_${P}`, 6_000)).toMatchObject({ kind: 'full' })
    expect(fields(await regVerdict(p3.orderId))).toEqual(['missingLedgerReversal', 'registrationNotRefunded'])
    await reverse(p3.ptxId)
    await db.doc(`registrations/${p3.id}`).update({ paymentStatus: 'refunded' })
    expect(await regVerdict(p3.orderId)).toEqual({ mismatches: [], unverifiable: [] })
    // a ledger reversal with no refund at all
    const p4 = await payment(uid, 4_000, 'registration')
    await reverse(p4.ptxId)
    expect(fields(await regVerdict(p4.orderId))).toEqual(['reversalWithoutRefund'])
    // the paged pass reaches them from both drivers
    const g = await regRecon.reconcileRegistrationRefunds({ limit: 5_000 })
    const gf = g.mismatches.map(m => `${m.entityId}|${m.field}`)
    expect(gf).toEqual(expect.arrayContaining([`${p2.id}|m4PartialRefundOnReleasedFunds`, `${p4.id}|reversalWithoutRefund`]))
    expect(gf.filter(x => x.startsWith(`${p1.id}|`) || x.startsWith(`${p3.id}|`))).toEqual([])
  }, T)
})
