// MC-05.6A · The refund settlement CLAIM — REAL Firestore (emulator).
//
// ONE assertion underlies every test here: **at most one gateway refund may ever be issued
// per refundId**, no matter how many callers race, in what order, or where one of them dies.
//
// `gw.refundCreateCalls` counts calls that reached the stub gateway's create endpoint. It is
// the number that would be real money in production, so it is asserted directly rather than
// inferred from the resulting document state.
//
// The claim is a Firestore transaction, so proving it needs a real Firestore. A mock would
// serialise the callers for us and prove nothing.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const SECRET = 'test_key_secret'
const CONTENTION_TIMEOUT_MS = 30_000

interface StubRefund { id: string; notes: Record<string, unknown>; amount: number; status: string }

const gw = vi.hoisted(() => ({
  orderSeq: 0,
  refundSeq: 0,
  payments: new Map<string, Record<string, unknown>>(),
  refunds: [] as StubRefund[],
  /** Calls that reached create(). THE number under test. */
  refundCreateCalls: 0,
  failRefund: false,
  /** Milliseconds the gateway takes, so a race has a real window to happen in. */
  latencyMs: 0,
  /** Simulates a call that never returns — the process died mid-payout. */
  hangForever: false,
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => ({
        id: `order_MC056A_${++gw.orderSeq}`, amount: o.amount, currency: o.currency,
      }),
    },
    payments: {
      fetch: async (id: string) => {
        const p = gw.payments.get(id)
        if (!p) throw new Error('payment not found')
        return p
      },
      fetchMultipleRefund: async (paymentId: string) => ({
        items: gw.refunds.filter(r => r.notes.paymentId === paymentId),
      }),
      refund: async (paymentId: string, params: { amount: number; notes: Record<string, unknown> }) => {
        gw.refundCreateCalls++
        if (gw.hangForever) await new Promise(() => { /* never resolves */ })
        if (gw.latencyMs) await new Promise(r => setTimeout(r, gw.latencyMs))
        if (gw.failRefund) throw new Error('gateway declined')
        const r: StubRefund = {
          id: `rfnd_${++gw.refundSeq}`, notes: { ...params.notes, paymentId },
          amount: params.amount, status: 'processed',
        }
        gw.refunds.push(r)
        return r
      },
    },
  },
}))

describeEmu('MC-05.6A · refund settlement claim', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let purchases: typeof import('@/features/media-credits/services/purchaseService')
  let refunds:   typeof import('@/features/media-credits/services/refundService')
  let recon:     typeof import('@/features/media-credits/services/reconciliation')
  let refundRepo: typeof import('@/features/media-credits/repositories/refundRepo')
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let errs: typeof import('@/features/media-credits/errors')
  let sign: (o: string, p: string, s: string) => string

  const UID = 'emu-claim-organizer'
  const ACTOR = 'emu-actor'
  const ADMIN = 'emu-admin'
  const UNIT = 100

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    purchases  = await import('@/features/media-credits/services/purchaseService')
    refunds    = await import('@/features/media-credits/services/refundService')
    recon      = await import('@/features/media-credits/services/reconciliation')
    refundRepo = await import('@/features/media-credits/repositories/refundRepo')
    ;({ walletService } = await import('@/features/media-credits/services'))
    errs = await import('@/features/media-credits/errors')
    ;({ signPaymentVerification: sign } = await import('../mocks/razorpay'))
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  async function reset() {
    businessConfig.clearRuntimeOverrides()
    gw.payments.clear(); gw.refunds = []; gw.refundSeq = 0
    gw.refundCreateCalls = 0; gw.failRefund = false
    gw.latencyMs = 0; gw.hangForever = false

    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    for (const col of ['mediaCreditLedger', 'mediaCreditPurchases', 'mediaCreditReservations',
                       'mediaCreditReconciliations', 'mediaCreditRefunds']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()

    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: UNIT,
      minCreditPurchase: 1, refundsEnabled: true, refundWindowDays: 30,
      refundServiceChargeMethod: 'percent', refundServiceChargePercent: 10,
      refundServiceChargeFixedPaise: 0, minRefundablePaise: 100,
    } as never)
  }

  beforeEach(async () => { await reset() })

  /** An organizer with 100 credits and an open refund request for them. */
  async function requestedRefund(): Promise<string> {
    const intent = await purchases.createPurchaseIntent({
      organizerUid: UID, credits: 100, actorUid: ACTOR,
    })
    const paymentId = `pay_for_${intent.gatewayOrderId}`
    gw.payments.set(paymentId, {
      amount: intent.amountPaise, currency: 'INR', status: 'captured',
      order_id: intent.gatewayOrderId,
    })
    await purchases.completePurchase({
      organizerUid: UID, orderId: intent.gatewayOrderId, paymentId,
      signature: sign(intent.gatewayOrderId, paymentId, SECRET), actorUid: ACTOR,
    })
    const r = await refunds.createRefundRequest({
      organizerUid: UID, purchaseId: intent.purchaseId,
      reason: 'claim test', requestedBy: ACTOR,
    })
    return r.refundId
  }

  /** Approves, then leaves the refund at `approved` awaiting a payout. */
  async function approvedRefund(): Promise<string> {
    const refundId = await requestedRefund()
    gw.failRefund = true
    await refunds.approveRefund({ refundId, adminUid: ADMIN }).catch(() => { /* deferred */ })
    gw.failRefund = false
    gw.refundCreateCalls = 0          // reset the counter to isolate the settlement under test
    return refundId
  }

  // ── The claim itself ───────────────────────────────────────────────────────

  it('claims approved → settling for exactly one caller', async () => {
    const refundId = await approvedRefund()

    const first  = await refundRepo.claimForSettlement(refundId)
    const second = await refundRepo.claimForSettlement(refundId)

    expect(first.claimed).toBe(true)
    expect(second.claimed).toBe(false)
    expect(second.claimed === false && second.reason).toBe('in_progress')
    expect((await refundRepo.read(refundId))!.status).toBe('settling')
  })

  it('CONCURRENCY: of 8 simultaneous claims, exactly one wins', async () => {
    const refundId = await approvedRefund()

    const results = await Promise.all(
      Array.from({ length: 8 }, () => refundRepo.claimForSettlement(refundId)),
    )
    expect(results.filter(r => r.claimed).length).toBe(1)
  }, CONTENTION_TIMEOUT_MS)

  // ── The seven required scenarios ───────────────────────────────────────────

  it('ADMIN DOUBLE-CLICK issues exactly one gateway refund', async () => {
    const refundId = await requestedRefund()
    gw.latencyMs = 150      // a real window for the second click to land inside

    const [a, b] = await Promise.allSettled([
      refunds.approveRefund({ refundId, adminUid: ADMIN }),
      refunds.approveRefund({ refundId, adminUid: ADMIN }),
    ])

    expect(gw.refundCreateCalls).toBe(1)
    expect(gw.refunds).toHaveLength(1)
    // One caller settles; the other is told the payout is already in progress.
    const outcomes = [a, b].map(r => r.status)
    expect(outcomes).toContain('fulfilled')
    expect((await refundRepo.read(refundId))!.status).toBe('settled')
    expect((await walletService.getBalance(UID)).balance).toBe(0)   // debited once
  }, CONTENTION_TIMEOUT_MS)

  it('ADMIN + SCHEDULER race issues exactly one gateway refund', async () => {
    const refundId = await requestedRefund()
    gw.latencyMs = 150

    await Promise.allSettled([
      refunds.approveRefund({ refundId, adminUid: ADMIN }),
      recon.retryPendingRefunds({ limit: 50 }),
      recon.retryPendingRefunds({ limit: 50 }),
    ])

    expect(gw.refundCreateCalls).toBe(1)
    expect((await refundRepo.read(refundId))!.status).toBe('settled')
  }, CONTENTION_TIMEOUT_MS)

  it('TWO SCHEDULERS running together issue exactly one gateway refund', async () => {
    const refundId = await approvedRefund()
    gw.latencyMs = 150

    const [r1, r2] = await Promise.all([
      recon.retryPendingRefunds({ limit: 50 }),
      recon.retryPendingRefunds({ limit: 50 }),
    ])

    expect(gw.refundCreateCalls).toBe(1)
    expect((await refundRepo.read(refundId))!.status).toBe('settled')

    // A benign collision must never be reported as a failure — that would raise a financial
    // alert every time two drains overlap.
    expect(r1.failed + r2.failed).toBe(0)

    // Deliberately NOT asserted: that resolved === 1. The loser's outcome depends on WHEN it
    // arrives, and both answers are correct — mid-payout it is told `in_progress` and skips;
    // arriving after the winner finished it is told `already_settled`, which is an idempotent
    // success. Pinning the split would make the test fail on timing rather than on safety.
    expect(r1.resolved + r2.resolved + r1.skipped + r2.skipped).toBeGreaterThanOrEqual(1)
  }, CONTENTION_TIMEOUT_MS)

  it('GATEWAY TIMEOUT releases the claim so the refund can be retried', async () => {
    const refundId = await approvedRefund()
    gw.failRefund = true

    await expect(refunds.settleApprovedRefund(refundId))
      .rejects.toThrow(errs.RefundSettlementDeferredError)

    const after = await refundRepo.read(refundId)
    expect(after!.status).toBe('approved')          // handed back, not stuck at settling
    expect(after!.settlingSince).toBeNull()
    expect(after!.gatewayAttempts).toBeGreaterThanOrEqual(1)
    expect(after!.gatewayError).toContain('declined')
  })

  it('GATEWAY RETRY after a failure settles, and still only one refund exists', async () => {
    const refundId = await approvedRefund()
    gw.failRefund = true
    await refunds.settleApprovedRefund(refundId).catch(() => { /* released */ })

    gw.failRefund = false
    const out = await refunds.settleApprovedRefund(refundId)

    expect(out.settled).toBe(true)
    // The failed attempt reached create() but produced nothing; the retry created the one.
    expect(gw.refunds).toHaveLength(1)
    expect((await refundRepo.read(refundId))!.status).toBe('settled')
  })

  it('CRASH AFTER CLAIM: a stale claim is retaken and settled, still only one refund', async () => {
    const refundId = await approvedRefund()

    // Claim it, then abandon it — the holder died before calling the gateway.
    const claim = await refundRepo.claimForSettlement(refundId)
    expect(claim.claimed).toBe(true)

    // A FRESH claim is invisible to the scheduler: it must not interrupt a live payout.
    expect((await recon.retryPendingRefunds({ limit: 50 })).scanned).toBe(0)
    expect((await refundRepo.read(refundId))!.status).toBe('settling')

    // Age the claim past its TTL, exactly as a crash would leave it.
    await adminDb.doc(`mediaCreditRefunds/${refundId}`).update({
      settlingSince: new Date(Date.now() - refundRepo.SETTLING_CLAIM_TTL_MS - 60_000),
    })

    const report = await recon.retryPendingRefunds({ limit: 50 })
    expect(report.resolved).toBe(1)
    expect(gw.refundCreateCalls).toBe(1)
    expect((await refundRepo.read(refundId))!.status).toBe('settled')
  }, CONTENTION_TIMEOUT_MS)

  it('CRASH AFTER GATEWAY PAID: the retry adopts the existing refund, never a second', async () => {
    const refundId = await approvedRefund()

    // The gateway created the refund and the process died before Firestore was updated.
    const refund = await refundRepo.read(refundId)
    gw.refunds.push({
      id: 'rfnd_orphan',
      notes: { mediaCreditRefundId: refundId, paymentId: refund!.gatewayPaymentId },
      amount: refund!.refundAmountPaise, status: 'processed',
    })
    await adminDb.doc(`mediaCreditRefunds/${refundId}`).update({
      status: 'settling',
      settlingSince: new Date(Date.now() - refundRepo.SETTLING_CLAIM_TTL_MS - 60_000),
    })

    const report = await recon.retryPendingRefunds({ limit: 50 })
    expect(report.resolved).toBe(1)
    expect(gw.refundCreateCalls).toBe(0)            // adopted, never created
    const settled = await refundRepo.read(refundId)
    expect(settled!.status).toBe('settled')
    expect(settled!.gatewayRefundId).toBe('rfnd_orphan')
  }, CONTENTION_TIMEOUT_MS)

  it('REPLAY: settling an already-settled refund is a no-op that reports success', async () => {
    const refundId = await approvedRefund()
    const first = await refunds.settleApprovedRefund(refundId)

    const second = await refunds.settleApprovedRefund(refundId)
    const third  = await refunds.settleApprovedRefund(refundId)

    expect(second.settled).toBe(true)
    expect(second.gatewayRefundId).toBe(first.gatewayRefundId)
    expect(third.gatewayRefundId).toBe(first.gatewayRefundId)
    expect(gw.refundCreateCalls).toBe(1)
    expect((await walletService.getBalance(UID)).balance).toBe(0)
  })

  it('a live claim blocks the scheduler but never blocks it forever', async () => {
    const refundId = await approvedRefund()
    await refundRepo.claimForSettlement(refundId)

    // Fresh claim → skipped entirely.
    expect((await recon.retryPendingRefunds({ limit: 50 })).scanned).toBe(0)

    // Aged past the TTL → picked up.
    await adminDb.doc(`mediaCreditRefunds/${refundId}`).update({
      settlingSince: new Date(Date.now() - refundRepo.SETTLING_CLAIM_TTL_MS - 60_000),
    })
    expect((await recon.retryPendingRefunds({ limit: 50 })).scanned).toBe(1)
  }, CONTENTION_TIMEOUT_MS)

  it('a settling refund blocks a second refund request for the same purchase', async () => {
    const refundId = await requestedRefund()
    const purchaseId = (await refundRepo.read(refundId))!.purchaseId
    await refunds.approveRefund({ refundId, adminUid: ADMIN })

    await expect(refunds.createRefundRequest({
      organizerUid: UID, purchaseId, reason: 'again', requestedBy: ACTOR,
    })).rejects.toThrow(errs.RefundNotAllowedError)
  })

  it('THE invariant still holds: balance equals the sum of ledger deltas', async () => {
    const refundId = await requestedRefund()
    gw.latencyMs = 100
    await Promise.allSettled([
      refunds.approveRefund({ refundId, adminUid: ADMIN }),
      refunds.approveRefund({ refundId, adminUid: ADMIN }),
      recon.retryPendingRefunds({ limit: 50 }),
    ])

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)
    expect((await walletService.getBalance(UID)).balance).toBe(sum)
    expect(gw.refundCreateCalls).toBe(1)
  }, CONTENTION_TIMEOUT_MS)
})
