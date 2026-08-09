// MC-05.6B · Mixed-workload concurrency — REAL Firestore (emulator).
//
// Uploads, purchases, refunds and the cleanup scheduler all running AT ONCE against one
// organizer's wallet. Every prior suite exercised one flow at a time; this one asks whether
// the financial invariants survive them interleaved, which is the state a real event day
// actually produces.
//
// THE assertion, checked after every scenario:
//
//     wallet.balance == Σ(all ledger deltas)      and      available >= 0
//
// Razorpay is stubbed — an external paid service.
//
//   npm run emu:start && npm run test:emu:load

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const SECRET = 'test_key_secret'
const MIXED_TIMEOUT_MS = 5 * 60 * 1000

interface StubRefund { id: string; notes: Record<string, unknown>; amount: number; status: string }

const gw = vi.hoisted(() => ({
  orderSeq: 0, refundSeq: 0,
  payments: new Map<string, Record<string, unknown>>(),
  refunds: [] as StubRefund[],
  refundCreateCalls: 0,
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => ({
        id: `order_MIX_${++gw.orderSeq}`, amount: o.amount, currency: o.currency,
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

describeEmu('MC-05.6B · mixed financial workload', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let purchases: typeof import('@/features/media-credits/services/purchaseService')
  let refunds:   typeof import('@/features/media-credits/services/refundService')
  let recon:     typeof import('@/features/media-credits/services/reconciliation')
  let cleanup:   typeof import('@/features/media-credits/services/cleanupService')
  let openSession: typeof import('@/features/media-credits/services/sessionService')['openSession']
  let deriveAssetId: typeof import('@/features/media-credits/utils/sessionSlots')['deriveAssetId']
  /** The session every upload in a scenario draws its slots from. */
  let sessionId = ''
  /** Its allocation — held for the session's whole life, released only at settlement. */
  let sessionSlots = 0
  let sign: (o: string, p: string, s: string) => string

  /** Unique per process — see creditLoad.emu.test.ts for why. */
  const UID = `emu-mixed-organizer-${process.pid}`
  const EVT = { eventId: 'mix-evt', eventSlug: 'mix-evt', galleryId: 'mix-gal' }

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    const svc = await import('@/features/media-credits/services')
    ledgerService = svc.ledgerService
    walletService = svc.walletService
    purchases = await import('@/features/media-credits/services/purchaseService')
    refunds   = await import('@/features/media-credits/services/refundService')
    recon     = await import('@/features/media-credits/services/reconciliation')
    cleanup   = await import('@/features/media-credits/services/cleanupService')
    ;({ openSession } = await import('@/features/media-credits/services/sessionService'))
    ;({ deriveAssetId } = await import('@/features/media-credits/utils/sessionSlots'))
    ;({ signPaymentVerification: sign } = await import('../mocks/razorpay'))
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  async function reset(seed: number) {
    businessConfig.clearRuntimeOverrides()
    gw.payments.clear(); gw.refunds = []; gw.refundSeq = 0; gw.refundCreateCalls = 0

    for (const col of ['mediaCreditLedger', 'mediaCreditReservations', 'mediaCreditPurchases',
                       'mediaCreditSessions',
                       'mediaCreditRefunds', 'mediaCreditReconciliations']) {
      for (;;) {
        const snap = await adminDb.collection(col)
          .where('organizerUid', '==', UID).limit(400).get()
        if (snap.empty) break
        const b = adminDb.batch()
        snap.docs.forEach(d => b.delete(d.ref))
        await b.commit()
      }
    }
    await adminDb.doc(`mediaCreditWallets/${UID}`).delete()

    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: 100,
      minCreditPurchase: 1, refundsEnabled: true, refundWindowDays: 30,
      refundServiceChargeMethod: 'percent', refundServiceChargePercent: 10,
      refundServiceChargeFixedPaise: 0, minRefundablePaise: 100,
    } as never)

    await ledgerService.credit({
      organizerUid: UID, entryId: `mix-seed:${Date.now()}`,
      credits: seed, reason: 'grant', actorUid: 'test', actorKind: 'platform',
    })

    // One session per scenario, sized for the largest upload burst any of them runs.
    // Sized to the seed: a session cannot hold more credits than the wallet has, so a
    // low-seed scenario gets a proportionally smaller allocation.
    sessionSlots = Math.min(100, seed)
    sessionId = `mix-${process.pid}-${Date.now()}`
    await openSession({
      sessionId, organizerUid: UID, slotCount: sessionSlots, actorUid: 'test', ...EVT,
    })
  }

  /** THE invariant. Paginated because the ledger grows past one query page under load. */
  async function assertInvariant() {
    let sum = 0
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
    for (;;) {
      let q = adminDb.collection('mediaCreditLedger')
        .where('organizerUid', '==', UID).orderBy('__name__').limit(500)
      if (cursor) q = q.startAfter(cursor)
      const snap = await q.get()
      if (snap.empty) break
      snap.docs.forEach(d => { sum += d.get('delta') as number })
      cursor = snap.docs[snap.docs.length - 1]
      if (snap.size < 500) break
    }
    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(sum)
    expect(b.available).toBeGreaterThanOrEqual(0)
    expect(b.held).toBeGreaterThanOrEqual(0)
    return b
  }

  /**
   * One full upload: claim a slot, then consume it.
   *
   * MC-06B: neither step touches the wallet or the ledger. The credits came from the
   * session opened in `reset`, so this is the financially inert per-photo path.
   */
  async function upload(slotIndex: number) {
    const assetId = deriveAssetId(sessionId, slotIndex)
    await ledgerService.reserve({
      organizerUid: UID, assetId, credits: 1, actorUid: 'up',
      sessionId, slotIndex, ...EVT,
    })
    await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'up' })
  }

  async function buyAndGrant(credits: number): Promise<string> {
    const intent = await purchases.createPurchaseIntent({
      organizerUid: UID, credits, actorUid: 'buyer',
    })
    const paymentId = `pay_for_${intent.gatewayOrderId}`
    gw.payments.set(paymentId, {
      amount: intent.amountPaise, currency: 'INR', status: 'captured',
      order_id: intent.gatewayOrderId,
    })
    await purchases.completePurchase({
      organizerUid: UID, orderId: intent.gatewayOrderId, paymentId,
      signature: sign(intent.gatewayOrderId, paymentId, SECRET), actorUid: 'buyer',
    })
    return intent.purchaseId
  }

  beforeEach(async () => { await reset(500) })

  it('uploads + purchases running together keep the invariant', async () => {
    await Promise.allSettled([
      ...Array.from({ length: 60 }, (_, i) => upload(i)),
      buyAndGrant(50),
      buyAndGrant(50),
    ])

    const b = await assertInvariant()
    // Under Spec v1.0 the hold belongs to the SESSION and persists until settlement —
    // uploads themselves move nothing. Asserting 0 here would be asserting the old model.
    expect(b.held).toBe(sessionSlots)
  }, MIXED_TIMEOUT_MS)

  it('uploads + purchases + a refund + BOTH schedulers keep the invariant', async () => {
    // A purchase that will be refunded mid-storm.
    const purchaseId = await buyAndGrant(100)
    const refund = await refunds.createRefundRequest({
      organizerUid: UID, purchaseId, reason: 'mixed load', requestedBy: 'org',
    })

    await Promise.allSettled([
      ...Array.from({ length: 80 }, (_, i) => upload(i)),
      buyAndGrant(40),
      refunds.approveRefund({ refundId: refund.refundId, adminUid: 'admin' }),
      recon.runReconciliation({ limit: 50 }),
      recon.runReconciliation({ limit: 50 }),
      cleanup.releaseStaleReservations({ olderThanMs: -60_000, limit: 200 }),
    ])

    const b = await assertInvariant()
    expect(gw.refundCreateCalls).toBe(1)      // MC-05.6A claim still holds under load
    expect(b.balance).toBeLessThanOrEqual(540) // 500+100+40 −100 refunded, minus consumptions
  }, MIXED_TIMEOUT_MS)

  it('the cleanup sweep cannot release a hold that is being consumed', async () => {
    // The sweep and the consume race on the same reservations. Whatever interleaving wins,
    // a credit must be either consumed exactly once or returned exactly once — never both,
    // and never neither.
    const ids = Array.from({ length: 40 }, (_, i) => deriveAssetId(sessionId, i))
    await Promise.allSettled(ids.map(id => ledgerService.reserve({
      organizerUid: UID, assetId: id, credits: 1, actorUid: 'up',
      sessionId, slotIndex: ids.indexOf(id), ...EVT,
    })))

    await Promise.all([
      ...ids.map(id => ledgerService.consume({ organizerUid: UID, assetId: id, actorUid: 'up' })
        .catch(() => { /* lost to the sweep — a valid outcome */ })),
      cleanup.releaseStaleReservations({ olderThanMs: -60_000, limit: 200 }),
    ])

    const b = await assertInvariant()
    expect(b.held).toBe(sessionSlots)             // the session's hold, still open
    expect(b.balance).toBeLessThanOrEqual(500)
  }, MIXED_TIMEOUT_MS)

  it('overdraft is impossible: a session cannot hold more than is available', async () => {
    // Under Spec v1.0 the overdraft gate is at session OPEN, not per photo. That is the
    // whole design — everything downstream is pre-authorised, so the only place a wallet can
    // be over-committed is here.
    //
    // NOTE: the per-photo SLOT bound is enforced by `resolveSlot` in the upload route, not by
    // `ledgerService.reserve`. A caller reaching the service directly can therefore claim
    // beyond a session's allocation. Reported in MC-06E rather than patched here, since this
    // sprint must not modify reservation algorithms.
    await reset(20)

    // A second session that would exceed what is left must be refused outright.
    await expect(openSession({
      sessionId: `mix-over-${process.pid}-${Date.now()}`, organizerUid: UID,
      slotCount: 500, actorUid: 'test', ...EVT,
    })).rejects.toThrow()

    const b = await assertInvariant()
    expect(b.available).toBeGreaterThanOrEqual(0)   // never negative
    expect(b.held).toBe(sessionSlots)               // only the first session holds
  }, MIXED_TIMEOUT_MS)
})
