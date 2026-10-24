// Financial Integrity Phase 1 — a refund reversal debits the revenue-wallet bucket that holds THAT
// transaction's net, on REAL Firestore, through the real credit path (recordPlatformTransactionAndCredit),
// the real release job (releaseEligibleFunds), the real reversal (reversePlatformTransactionAndDebit) and
// the real donation refund accounting (applyDonationRefundAccounting).
//
//   pending / held transaction → pendingPaise      released transaction → availablePaise
//   unknown releaseStatus → fail closed (throws before any write; the callers' durable retry keeps it)
//   a shortfall in the right bucket → clamped + clawback, NEVER taken from the other bucket
// No gateway is involved: nothing here can move money.

import { describe, it, expect, beforeAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const NET = 1_000

vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))
// Phase 1 (donation holds) — the Super Admin hold review reads refunds from the gateway; creating one is never allowed.
const gw = vi.hoisted(() => ({ refundCalls: 0 }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_wbr', RAZORPAY_KEY_SECRET: 'wbr',
  razorpay: { payments: {
    refund: async () => { gw.refundCalls++; throw new Error('no refund may be created in this suite') },
    fetchMultipleRefund: async () => ({ entity: 'collection', count: 0, items: [] }),
  } },
}))

describeEmu('Financial Integrity Phase 1 · refund reversal debits the bucket holding the transaction', () => {
  let db: import('firebase-admin/firestore').Firestore
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let applyDonation: typeof import('@/lib/donations/refundService').applyDonationRefundAccounting
  let reconcileWallet: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
  let n = 0

  const org = () => `wbr-org-${P}-${++n}`
  const wallet = async (uid: string) => {
    const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data() ?? {}
    return { pending: w.pendingPaise as number, available: w.availablePaise as number, inTransit: (w.inTransitPaise ?? 0) as number }
  }
  const ptx = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data() ?? {}
  const clawbacks = async (uid: string) => (await db.collection('walletClawbacks').where('organizerUid', '==', uid).get()).docs.map(d => d.data())
  const backdate = (id: string) => db.doc(`platformTransactions/${id}`).update({ paidAt: new Date(Date.now() - 10 * 86_400_000) })
  /** The sum check (existing reconciliation) AND the per-bucket invariant it cannot see: pendingPaise is exactly the
   *  net of this organizer's unreversed transactions that were never released (pending / held), and availablePaise
   *  (+ in transit + settled) exactly the net of the released ones. */
  const walletClean = async (uid: string) => {
    expect(await reconcileWallet(uid, (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!)).toEqual([])
    const live = (await db.collection('platformTransactions').where('organizerUid', '==', uid).get()).docs.map(d => d.data()).filter(t => t.status === 'completed')
    const sum = (xs: Record<string, unknown>[]) => xs.reduce((s, t) => s + Number(t.netSettlementPaise ?? 0), 0)
    const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!
    expect(w.pendingPaise).toBe(sum(live.filter(t => t.releaseStatus === 'pending' || t.releaseStatus === 'held')))
    expect((w.availablePaise ?? 0) + (w.settledPaise ?? 0)).toBe(sum(live.filter(t => t.releaseStatus === 'released')))
  }

  /** A credited registration payment (ledger + wallet via the real, atomic credit path). */
  async function payment(uid: string, net = NET, kind: 'registration' | 'donation' = 'registration') {
    const id = `wbr-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed',
      organizerUid: uid, entityId: `wbr-ev-${P}`, entityType: kind === 'donation' ? 'campaign' : 'event',
      sourceId: id, sourceType: kind, payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0,
      platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x',
      currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `p_${id}`, gatewayOrderId: `o_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    return { id, ptxId: `ptx_${id}` }
  }
  /** Release ONE transaction through the real job (backdated so it is eligible). */
  async function releaseOne(ptxId: string) {
    await backdate(ptxId)
    await release({ limit: 500 })
    expect((await ptx(ptxId)).releaseStatus).toBe('released')
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    applyDonation = (await import('@/lib/donations/refundService')).applyDonationRefundAccounting
    reconcileWallet = (await import('@/lib/reconciliation/wallets')).reconcileOneWallet
  }, T)

  it('1 · an UNRELEASED transaction is reversed from pendingPaise', async () => {
    const uid = org()
    const a = await payment(uid)
    expect(await wallet(uid)).toMatchObject({ pending: NET, available: 0 })
    expect(await reverse(a.ptxId)).toMatchObject({ reversed: true, debited: NET, insolvent: false })
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 0 })
    expect((await ptx(a.ptxId)).status).toBe('refunded')
    expect(await clawbacks(uid)).toHaveLength(0)
    await walletClean(uid)
  }, T)

  it('2+3 · a RELEASED transaction is reversed from availablePaise; an unrelated pending transaction keeps its funds and still releases', async () => {
    const uid = org()
    const a = await payment(uid, 1_000)
    await releaseOne(a.ptxId)
    const b = await payment(uid, 700)                                      // unreleased, not yet eligible
    expect(await wallet(uid)).toMatchObject({ pending: 700, available: 1_000 })
    expect(await reverse(a.ptxId)).toMatchObject({ reversed: true, debited: 1_000, insolvent: false })
    expect(await wallet(uid)).toMatchObject({ pending: 700, available: 0 })   // B's 700 untouched
    await releaseOne(b.ptxId)                                              // B is still releasable
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 700 })
    expect(await clawbacks(uid)).toHaveLength(0)
    await walletClean(uid)
  }, T)

  it('3b · a HELD (refund-review) transaction is reversed from pendingPaise — its net never left pending', async () => {
    const uid = org()
    const a = await payment(uid, 800)
    const released = await payment(uid, 500)
    await releaseOne(released.ptxId)
    await db.doc(`platformTransactions/${a.ptxId}`).update({ releaseStatus: 'held', releaseHold: { reason: 'refund_review', refundIds: ['r'] } })
    expect(await reverse(a.ptxId)).toMatchObject({ reversed: true, debited: 800 })
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 500 })
    await walletClean(uid)
  }, T)

  it('4 · duplicate and concurrent reversals of one transaction debit exactly once', async () => {
    const uid = org()
    const a = await payment(uid, 1_000)
    await releaseOne(a.ptxId)
    const b = await payment(uid, 300)
    const rs = await Promise.all([0, 1, 2].map(() => reverse(a.ptxId)))
    expect(rs.filter(r => r.reversed)).toHaveLength(1)
    expect(await reverse(a.ptxId)).toMatchObject({ reversed: false, debited: 0 })        // sequential replay
    expect(await wallet(uid)).toMatchObject({ pending: 300, available: 0 })
    expect(b).toBeTruthy()
    await walletClean(uid)
  }, T)

  it('5 · a release and a reversal of the SAME transaction racing: whichever commits first, the right bucket is debited and nothing else moves', async () => {
    for (let round = 0; round < 4; round++) {
      const uid = org()
      const other = await payment(uid, 250)                                // unrelated, not eligible
      const a = await payment(uid, 1_000)
      await backdate(a.ptxId)
      const order = round % 2 === 0 ? [release({ limit: 500 }), reverse(a.ptxId)] : [reverse(a.ptxId), release({ limit: 500 })]
      await Promise.all(order)
      const t = await ptx(a.ptxId)
      expect(t.status).toBe('refunded')
      const w = await wallet(uid)
      expect(w.pending).toBe(250)                                          // the unrelated net, whatever the order
      expect(w.available).toBe(0)                                          // released then reversed, or never released
      expect(w.pending).toBeGreaterThanOrEqual(0); expect(w.available).toBeGreaterThanOrEqual(0)
      expect(await clawbacks(uid)).toHaveLength(0)
      expect((await ptx(other.ptxId)).releaseStatus).toBe('pending')
      await walletClean(uid)
    }
  }, T)

  it('6a · an UNKNOWN releaseStatus fails closed: throws before any write — wallet, ledger and clawbacks unchanged', async () => {
    const uid = org()
    const a = await payment(uid, 600)
    await db.doc(`platformTransactions/${a.ptxId}`).update({ releaseStatus: (await import('firebase-admin/firestore')).FieldValue.delete() })
    const before = await wallet(uid)
    await expect(reverse(a.ptxId)).rejects.toThrow(/REVERSAL_BUCKET_UNKNOWN/)
    expect(await wallet(uid)).toEqual(before)
    expect((await ptx(a.ptxId)).status).toBe('completed')
    expect(await clawbacks(uid)).toHaveLength(0)
  }, T)

  it('6b · a released transaction whose available funds were already paid out: debits available only, the shortfall is a clawback — pending is NEVER taken', async () => {
    const uid = org()
    const a = await payment(uid, 1_000)
    await releaseOne(a.ptxId)
    const b = await payment(uid, 900)
    // the organizer withdrew 600 of the released 1,000 (settled out of available)
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: 400, settledPaise: 600 })
    expect(await reverse(a.ptxId)).toMatchObject({ reversed: true, debited: 400, insolvent: true })
    expect(await wallet(uid)).toMatchObject({ pending: 900, available: 0 })
    const cw = await clawbacks(uid)
    expect(cw).toHaveLength(1)
    expect(cw[0]).toMatchObject({ transactionId: a.ptxId, outstandingAmountPaise: 600 })
    expect(b).toBeTruthy()
  }, T)

  // ═══ 7 · donation refunds share the bucket rule ═══════════════════════════════════════════════════
  async function donation(uid: string, gross: number) {
    const p = await payment(uid, gross, 'donation')
    const slug = `wbr-camp-${P}-${n}`
    await db.doc(`donations/${p.id}`).set({ amountPaise: gross, campaignSlug: slug, donorEmail: `d${n}@x.test`, donorName: 'D', isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: `o_${p.id}`, organizerUid: uid })
    return { ...p, slug }
  }
  async function donationRefund(d: { id: string; slug: string }, uid: string, amount: number) {
    const refundId = `rfnd_wbr_${P}_${++n}`
    await db.doc(`donationRefunds/${refundId}`).set({ id: refundId, donationId: d.id, campaignId: d.slug, campaignSlug: d.slug, organizerUid: uid, razorpayRefundId: refundId, razorpayPaymentId: `p_${d.id}`, amountPaise: amount, reason: 'test', status: 'pending', initiatedBy: 'webhook', createdAt: new Date() })
    return refundId
  }

  it('7a · a donation refund of a RELEASED donation debits available (proportionally); an unrelated pending registration keeps its funds and releases', async () => {
    const uid = org()
    const d = await donation(uid, 2_000)
    await releaseOne(d.ptxId)
    const reg = await payment(uid, 500)
    const refundId = await donationRefund(d, uid, 1_000)                   // half: 1,000 of 2,000 net
    expect(await applyDonation(refundId)).toMatchObject({ applied: true, reversedPaise: 1_000, insolvent: false })
    expect(await wallet(uid)).toMatchObject({ pending: 500, available: 1_000 })
    expect(await applyDonation(refundId)).toMatchObject({ applied: false })  // replay: no second debit
    expect(await wallet(uid)).toMatchObject({ pending: 500, available: 1_000 })
    expect((await ptx(d.ptxId)).releaseHold).toBeUndefined()              // already released: never held
    expect((await ptx(d.ptxId)).releaseStatus).toBe('released')
    await releaseOne(reg.ptxId)
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 1_500 })
  }, T)

  it('7b · a donation refund of an UNRELEASED donation debits pending; an unknown original releaseStatus fails closed with nothing written', async () => {
    const uid = org()
    const d = await donation(uid, 1_200)
    const released = await payment(uid, 400)
    await releaseOne(released.ptxId)
    const full = await donationRefund(d, uid, 1_200)
    expect(await applyDonation(full)).toMatchObject({ applied: true, fullRefund: true, reversedPaise: 1_200 })
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 400 })
    expect((await ptx(d.ptxId)).status).toBe('refunded')

    const u2 = org()
    const d2 = await donation(u2, 1_000)
    await db.doc(`platformTransactions/${d2.ptxId}`).update({ releaseStatus: (await import('firebase-admin/firestore')).FieldValue.delete() })
    const before = await wallet(u2)
    const r2 = await donationRefund(d2, u2, 500)
    await expect(applyDonation(r2)).rejects.toThrow(/REVERSAL_BUCKET_UNKNOWN/)
    expect(await wallet(u2)).toEqual(before)
    expect((await db.doc(`donationRefunds/${r2}`).get()).get('status')).toBe('pending')
    expect((await db.doc(`platformTransactions/ptx_refund_${r2}`).get()).exists).toBe(false)
    expect((await db.doc(`donations/${d2.id}`).get()).get('refundedAmountPaise')).toBe(0)
  }, T)

  // ═══ 8 · Phase 1 — a PARTIAL refund of an UNRELEASED donation holds its settlement ═══════════════════
  it('8a · partial refund of an unreleased donation ⇒ held (never auto-released for the full net); duplicates and a second partial keep ONE hold; the unrelated payment still releases from its own funds', async () => {
    const { getOperationsHealth } = await import('@/lib/operations/healthMetrics')
    const uid = org()
    const d = await donation(uid, 2_000)
    const b = await payment(uid, 500)                                      // unrelated, unreleased
    const h0 = (await getOperationsHealth()).financial.settlementsHeldForRefundReview
    const r1 = await donationRefund(d, uid, 800)
    expect(await applyDonation(r1)).toMatchObject({ applied: true, fullRefund: false, reversedPaise: 800 })
    expect(await wallet(uid)).toMatchObject({ pending: 1_700, available: 0 })   // 2,000 − 800 + 500
    const held = await ptx(d.ptxId)
    expect(held).toMatchObject({ status: 'completed', releaseStatus: 'held', netSettlementPaise: 2_000,
      releaseHold: { reason: 'refund_review', source: 'donation_partial_refund', refundIds: [r1] } })
    expect(held.releaseHold.heldAt).toBeTruthy()
    const heldAt = held.releaseHold.heldAt.toMillis()
    // duplicate delivery: nothing changes
    expect(await applyDonation(r1)).toMatchObject({ applied: false })
    expect((await ptx(d.ptxId)).releaseHold.refundIds).toEqual([r1])
    expect(await wallet(uid)).toMatchObject({ pending: 1_700, available: 0 })
    // a second partial refund joins the SAME hold (first heldAt kept); still not a full refund
    const r2 = await donationRefund(d, uid, 200)
    expect(await applyDonation(r2)).toMatchObject({ applied: true, fullRefund: false, reversedPaise: 200 })
    const held2 = await ptx(d.ptxId)
    expect(held2).toMatchObject({ releaseStatus: 'held' })
    expect([...held2.releaseHold.refundIds].sort()).toEqual([r1, r2].sort())
    expect(held2.releaseHold.heldAt.toMillis()).toBe(heldAt)
    expect(await wallet(uid)).toMatchObject({ pending: 1_500, available: 0 })   // 2,000 − 1,000 + 500
    // the release job — however old the rows — never takes the held donation; B releases from its OWN funds
    await backdate(d.ptxId); await backdate(b.ptxId)
    await release({ limit: 500 })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    expect((await db.collection('settlementReleases').where('transactionId', '==', d.ptxId).get()).size).toBe(0)
    expect((await ptx(b.ptxId)).releaseStatus).toBe('released')
    expect(await wallet(uid)).toMatchObject({ pending: 1_000, available: 500 })  // the donation's remaining 1,000 stays pending
    // a stale-query bypass (status back to 'pending' while the hold is still there) is refused in-transaction
    await db.doc(`platformTransactions/${d.ptxId}`).update({ releaseStatus: 'pending' })
    expect((await release({ limit: 500 })).held ?? 0).toBeGreaterThanOrEqual(1)
    expect((await ptx(d.ptxId)).releaseStatus).toBe('pending')
    expect(await wallet(uid)).toMatchObject({ pending: 1_000, available: 500 })
    await db.doc(`platformTransactions/${d.ptxId}`).update({ releaseStatus: 'held' })
    // visible to the Super Admin hold review and the health metric; the evidence-gated lift REFUSES it
    const rh = await import('@/lib/settlements/refundHoldReview')
    expect(await rh.getRefundHold(d.ptxId)).toMatchObject({ releaseStatus: 'held', hold: { refundIds: [r1, r2].sort() } })
    expect((await getOperationsHealth()).financial.settlementsHeldForRefundReview).toBe(h0 + 1)
    const lift = await rh.resolveRefundHold({ ptxId: d.ptxId, outcome: 'lift_hold_no_refund', reason: 'test lift attempt', adminUid: 'wbr-super', expectedRefundIds: [r1, r2], requestId: `wbrlift${P}x${n}` })
    expect(lift).toMatchObject({ ok: false, code: 'HOLD_NOT_LIFTABLE' })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    expect(gw.refundCalls).toBe(0)
  }, T)

  it('8b · a later FULL refund closes the partial-refund hold (evidence kept); the row is refunded and never released; nothing else moves', async () => {
    const uid = org()
    const d = await donation(uid, 2_000)
    const b = await payment(uid, 300)
    const r1 = await donationRefund(d, uid, 500)
    await applyDonation(r1)
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    const r2 = await donationRefund(d, uid, 1_500)                         // the remainder: now fully refunded
    expect(await applyDonation(r2)).toMatchObject({ applied: true, fullRefund: true, reversedPaise: 1_500 })
    const t = await ptx(d.ptxId)
    expect(t.status).toBe('refunded')
    expect(t.releaseHold).toBeUndefined()
    expect(t.releaseStatus).toBe('pending')
    expect(t.releaseHoldHistory?.[`full_refund_${r2}`]).toMatchObject({
      hold: { reason: 'refund_review', source: 'donation_partial_refund', refundIds: [r1] },
      outcome: 'closed_full_refund', by: 'system:donation_full_refund',
      evidence: { grossPaise: 2_000, refundedGrossPaise: 2_000, ledgerStatus: 'refunded' },
    })
    expect(await wallet(uid)).toMatchObject({ pending: 300, available: 0 })    // only B's own net remains
    await backdate(d.ptxId); await backdate(b.ptxId)
    await release({ limit: 500 })
    expect((await ptx(d.ptxId)).status).toBe('refunded')
    expect((await db.collection('settlementReleases').where('transactionId', '==', d.ptxId).get()).size).toBe(0)
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 300 })
    expect(gw.refundCalls).toBe(0)
  }, T)

  it('8c · a donation fully refunded in ONE refund is never held', async () => {
    const uid = org()
    const d = await donation(uid, 900)
    const r = await donationRefund(d, uid, 900)
    expect(await applyDonation(r)).toMatchObject({ applied: true, fullRefund: true })
    const t = await ptx(d.ptxId)
    expect(t).toMatchObject({ status: 'refunded', releaseStatus: 'pending' })
    expect(t.releaseHold).toBeUndefined(); expect(t.releaseHoldHistory).toBeUndefined()
    await walletClean(uid)
  }, T)
})
