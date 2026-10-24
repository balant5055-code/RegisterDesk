// RD-REFUND-RECOVER-01 — a registration refund's ledger reversal can no longer be lost to a crash
// between "the refund is claimed / the registration is marked refunded" and "the ledger is reversed".
// REAL Firestore (private emulator), REAL ledger credit / reversal / release job / reversal drain;
// no gateway call is made (the refund records are written directly, as the webhook / route would).
//
// Before: the webhook claimed the refund record in one transaction and only THEN marked the
// registration refunded and reversed the ledger; a crash in between left the registration `paid`
// and the ledger `completed` behind a claim every redelivery found taken — the release job then paid
// the organizer money the attendee had already got back. The Super Admin route had the same window
// between finalize and its reversal call.
//
// Now the transaction that marks the registration refunded ALSO holds the unreleased settlement and
// queues the reversal, so after any crash: nothing is released, and the drain reverses exactly once.

import { describe, it, expect, beforeAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `rrc${process.pid}`
const DAY = 86_400_000

vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('RD-REFUND-RECOVER-01 · refund side effects are recoverable after a crash', () => {
  let db: import('firebase-admin/firestore').Firestore
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let refunds: typeof import('@/lib/refunds/registrationRefunds')
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let drain: typeof import('@/lib/payments/registrationReconciliation').retryPendingRefundLedgerReversals
  let n = 0

  /** A paid registration with its credited settlement (₹30 → ₹28.90 net) and a recorded, unclaimed refund. */
  async function paidWithRefund(opts: { paymentStatus?: string; released?: boolean } = {}) {
    const k = ++n
    const uid = `${P}-org-${k}`, regId = `${P}-reg-${k}`, refundId = `rfnd_${P}_${k}`, orderId = `order_${P}_${k}`
    await db.doc(`registrations/${regId}`).set({
      organizerUid: uid, eventSlug: `${P}-ev`, status: 'confirmed', paymentStatus: opts.paymentStatus ?? 'paid', amount: 3000,
      paymentId: `pay_${P}_${k}`, attendee: { name: 'A', email: `a${k}@rd.test` },
      ...(opts.paymentStatus === 'refund_pending' ? { refundClaim: { paymentId: `pay_${P}_${k}`, amountPaise: 3000 } } : {}),
    })
    await credit({
      id: `ptx_${regId}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: `${P}-ev`, entityType: 'event',
      sourceId: regId, sourceType: 'registration', payerName: 'A', payerEmail: `a${k}@rd.test`, grossAmountPaise: 3000,
      platformFeeBasePaise: 30, platformFeeGstPaise: 5, platformFeeTotalPaise: 35, gatewayFeeEstimatePaise: 75, netSettlementPaise: 2890,
      feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${P}_${k}`, gatewayOrderId: orderId,
    } as never, { organizerUid: uid, grossAmountPaise: 3000, feesTotalPaise: 110, netSettlementPaise: 2890 } as never)
    if (opts.released) {
      await db.doc(`platformTransactions/ptx_${regId}`).update({ paidAt: new Date(Date.now() - 30 * DAY) })
      await release({ limit: 500 })
    }
    await db.doc(`registrationRefunds/${refundId}`).set({
      id: refundId, razorpayRefundId: refundId, gatewayPaymentId: `pay_${P}_${k}`, gatewayOrderId: orderId,
      registrationId: regId, eventSlug: `${P}-ev`, organizerUid: uid, amountPaise: 3000,
      status: 'linked', origin: 'webhook', initiatedBy: 'webhook', reason: 'test', createdAt: new Date(),
    })
    return { uid, regId, refundId, ptxId: `ptx_${regId}` }
  }
  const doc = async (p: string) => (await db.doc(p).get()).data() as Record<string, unknown> | undefined
  const wallet = async (uid: string) => {
    const w = (await doc(`organizerRevenueWallets/${uid}`)) ?? {}
    return { pending: Number(w.pendingPaise ?? 0), available: Number(w.availablePaise ?? 0) }
  }
  /** Ages the settlement past the hold and runs the REAL release job. */
  const tryRelease = async (ptxId: string) => {
    await db.doc(`platformTransactions/${ptxId}`).update({ paidAt: new Date(Date.now() - 30 * DAY) })
    await release({ limit: 500 })
  }
  /** Makes the queued reversal due now (skips the grace period) and runs the REAL drain. */
  const drainNow = async (regId: string) => {
    await db.doc(`refundLedgerReconciliation/${regId}`).update({ nextAttemptAt: new Date(Date.now() - 1000) })
    await drain(500)
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    credit = (await import('@/lib/firebase/firestore/platformTransactions')).recordPlatformTransactionAndCredit
    refunds = await import('@/lib/refunds/registrationRefunds')
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    drain = (await import('@/lib/payments/registrationReconciliation')).retryPendingRefundLedgerReversals
  }, T)

  it('webhook claim, then CRASH before the reversal: registration refunded, settlement held, reversal queued; nothing released; the drain reverses exactly once', async () => {
    const r = await paidWithRefund()
    const c = await refunds.claimRefundSideEffects(r.refundId, { markRegistration: { registrationId: r.regId, refundAmountPaise: 3000 } })
    expect(c.claimed).toBe(true)
    // — the process dies here: no regRef.update, no reversal call —
    expect(await doc(`registrations/${r.regId}`)).toMatchObject({ paymentStatus: 'refunded', refundId: r.refundId, refundAmount: 3000 })
    expect(await doc(`registrationRefunds/${r.refundId}`)).toMatchObject({ status: 'processed' })
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ status: 'completed', releaseStatus: 'held', releaseHold: { reason: 'refund_reversal_pending', refundIds: [r.refundId] } })
    expect(await doc(`refundLedgerReconciliation/${r.regId}`)).toMatchObject({ status: 'pending', ptxId: r.ptxId, organizerUid: r.uid })

    await tryRelease(r.ptxId)
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ releaseStatus: 'held' })      // refunded money is NOT released
    expect(await wallet(r.uid)).toEqual({ pending: 2890, available: 0 })

    // a redelivery finds the claim taken — and that is now safe: the reversal is already owed
    expect((await refunds.claimRefundSideEffects(r.refundId, { markRegistration: { registrationId: r.regId, refundAmountPaise: 3000 } })).claimed).toBe(false)

    await drainNow(r.regId)
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ status: 'refunded' })
    expect(await doc(`refundLedgerReconciliation/${r.regId}`)).toMatchObject({ status: 'resolved' })
    expect(await wallet(r.uid)).toEqual({ pending: 0, available: 0 })                                  // debited exactly once
    await drainNow(r.regId).catch(() => undefined)                                                  // replay: no second debit
    expect(await wallet(r.uid)).toEqual({ pending: 0, available: 0 })
  }, T)

  it('route / webhook finalize of a refund_pending registration, then CRASH: the same guarantees', async () => {
    const r = await paidWithRefund({ paymentStatus: 'refund_pending' })
    const fin = await refunds.finalizePendingRegistrationRefund(r.regId, { refundId: r.refundId, amountPaise: 3000, gatewayPaymentId: `pay_${P}_${n}` })
    expect(fin).toBe('won')
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ releaseStatus: 'held', releaseHold: { reason: 'refund_reversal_pending' } })
    expect(await doc(`refundLedgerReconciliation/${r.regId}`)).toMatchObject({ status: 'pending' })
    await tryRelease(r.ptxId)
    expect(await wallet(r.uid)).toEqual({ pending: 2890, available: 0 })
    await drainNow(r.regId)
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ status: 'refunded' })
    expect(await wallet(r.uid)).toEqual({ pending: 0, available: 0 })
  }, T)

  it('the normal path: inline reversal succeeds and resolves the queued record; the drain then has nothing to do', async () => {
    const r = await paidWithRefund()
    expect((await refunds.claimRefundSideEffects(r.refundId, { markRegistration: { registrationId: r.regId, refundAmountPaise: 3000 } })).claimed).toBe(true)
    const { reversePlatformTransactionAndDebit } = await import('@/lib/firebase/firestore/platformTransactions')
    expect(await reversePlatformTransactionAndDebit(r.ptxId)).toMatchObject({ reversed: true, debited: 2890 })
    await refunds.resolveQueuedRefundReversal(r.regId)
    expect(await doc(`refundLedgerReconciliation/${r.regId}`)).toMatchObject({ status: 'resolved' })
    expect(await wallet(r.uid)).toEqual({ pending: 0, available: 0 })
  }, T)

  it('an ALREADY-released settlement is not held (nothing left to release) — the queued reversal debits available', async () => {
    const r = await paidWithRefund({ released: true })
    expect(await wallet(r.uid)).toEqual({ pending: 0, available: 2890 })
    expect((await refunds.claimRefundSideEffects(r.refundId, { markRegistration: { registrationId: r.regId, refundAmountPaise: 3000 } })).claimed).toBe(true)
    const ptx = (await doc(`platformTransactions/${r.ptxId}`))!
    expect(ptx.releaseStatus).toBe('released')
    expect(ptx.releaseHold).toBeUndefined()
    await drainNow(r.regId)
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ status: 'refunded' })
    expect(await wallet(r.uid)).toEqual({ pending: 0, available: 0 })
  }, T)

  it('the claim refuses a registration that moved to refund_pending / refunded meanwhile (no re-marking, nothing staged)', async () => {
    const r = await paidWithRefund({ paymentStatus: 'refund_pending' })
    const c = await refunds.claimRefundSideEffects(r.refundId, { markRegistration: { registrationId: r.regId, refundAmountPaise: 3000 } })
    expect(c.claimed).toBe(false)
    expect(await doc(`registrationRefunds/${r.refundId}`)).toMatchObject({ status: 'linked' })      // claim not taken
    expect(await doc(`refundLedgerReconciliation/${r.regId}`)).toBeUndefined()
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ releaseStatus: 'pending' })
  }, T)

  it('an existing refund-review hold is kept as it is (never overwritten by the reversal hold)', async () => {
    const r = await paidWithRefund()
    await db.doc(`platformTransactions/${r.ptxId}`).update({ releaseStatus: 'held', releaseHold: { reason: 'refund_review', refundIds: ['rfnd_partial'], heldAt: new Date() } })
    expect((await refunds.claimRefundSideEffects(r.refundId, { markRegistration: { registrationId: r.regId, refundAmountPaise: 3000 } })).claimed).toBe(true)
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ releaseHold: { reason: 'refund_review', refundIds: ['rfnd_partial'] } })
    expect(await doc(`refundLedgerReconciliation/${r.regId}`)).toMatchObject({ status: 'pending' })
  }, T)
})
