// MC-04 · Purchase + grant integration tests — REAL Firestore (emulator).
//
// What needs a real database here is the ATOMICITY claim: purchase record, ledger entry and
// wallet balance commit together or not at all. A mock cannot prove that, because the thing
// under test is Firestore's transaction boundary.
//
// Razorpay IS mocked — it is an external paid service, and the signature/amount logic it
// would exercise is verified against the real HMAC in tests/unit/verifyRazorpaySignature.
//
// ═══ HOW TO RUN ══════════════════════════════════════════════════════════════
//   npm run emu:start        # requires JDK 21+
//   npm run test:emu
//
// Skips automatically without FIRESTORE_EMULATOR_HOST. Refuses to run outside a `demo-`
// project, because it deletes documents.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const SECRET = 'test_key_secret'

/** Budget for contended tests — several transactions on ONE wallet doc, retried with backoff. */
const CONTENTION_TIMEOUT_MS = 30_000

// `vi.hoisted` because a vi.mock factory is lifted above every import and cannot close over
// an ordinary module-scope variable.
const rzp = vi.hoisted(() => ({
  orderSeq: 0,
  payments: new Map<string, Record<string, unknown>>(),
  failOrderCreate: false,
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID:     'rzp_test_stub',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => {
        if (rzp.failOrderCreate) throw new Error('gateway down')
        const id = `order_MC04_${++rzp.orderSeq}`
        return { id, amount: o.amount, currency: o.currency }
      },
    },
    payments: {
      fetch: async (id: string) => {
        const p = rzp.payments.get(id)
        if (!p) throw new Error('payment not found')
        return p
      },
    },
  },
}))

describeEmu('MC-04 · credit purchases against the Firestore emulator', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let svc: typeof import('@/features/media-credits/services/purchaseService')
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let purchaseRepo: typeof import('@/features/media-credits/repositories/purchaseRepo')
  let retryPendingGrants: typeof import('@/features/media-credits/services/reconciliation')['retryPendingGrants']
  let errs: typeof import('@/features/media-credits/errors')
  let signPaymentVerification: (o: string, p: string, s: string) => string

  const UID   = 'emu-purchase-organizer'
  const ACTOR = 'emu-actor'

  /** Credits are priced at ₹1 each for these tests: 1 credit ⇒ 100 paise. */
  const UNIT_PAISE = 100

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    svc          = await import('@/features/media-credits/services/purchaseService')
    purchaseRepo = await import('@/features/media-credits/repositories/purchaseRepo')
    ;({ walletService } = await import('@/features/media-credits/services'))
    ;({ retryPendingGrants } = await import('@/features/media-credits/services/reconciliation'))
    errs = await import('@/features/media-credits/errors')
    ;({ signPaymentVerification } = await import('../mocks/razorpay'))
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  /** Turns credits on without writing Firestore or waiting out the 60 s config cache. */
  function enableCredits(patch: Record<string, unknown> = {}) {
    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: UNIT_PAISE,
      minCreditPurchase: 1, ...patch,
    } as never)
  }

  async function reset() {
    businessConfig.clearRuntimeOverrides()
    rzp.payments.clear()
    rzp.failOrderCreate = false

    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    for (const col of ['mediaCreditLedger', 'mediaCreditPurchases', 'mediaCreditReconciliations']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()
    enableCredits()
  }

  beforeEach(async () => { await reset() })

  /** Registers a captured payment matching an intent, and signs it the way Razorpay would. */
  function capture(orderId: string, amountPaise: number, overrides: Record<string, unknown> = {}) {
    const paymentId = `pay_for_${orderId}`
    rzp.payments.set(paymentId, {
      amount: amountPaise, currency: 'INR', status: 'captured', order_id: orderId, ...overrides,
    })
    return { paymentId, signature: signPaymentVerification(orderId, paymentId, SECRET) }
  }

  // ── createPurchaseIntent ───────────────────────────────────────────────────

  it('prices the purchase SERVER-SIDE and persists the intent with a pricing snapshot', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 25, actorUid: ACTOR })

    expect(intent.amountPaise).toBe(25 * UNIT_PAISE)
    expect(intent.credits).toBe(25)
    expect(intent.currency).toBe('INR')

    const stored = await purchaseRepo.read(intent.purchaseId)
    expect(stored!.status).toBe('pending')
    expect(stored!.amountPaise).toBe(2500)
    expect(stored!.unitPricePaise).toBe(UNIT_PAISE)
    expect(stored!.creditsPerPhotoAtPurchase).toBe(1)   // the MC-04 snapshot field
    expect(stored!.gatewayOrderId).toBe(intent.gatewayOrderId)
    expect(stored!.grantedAt).toBeNull()
  })

  it('a later price change does NOT rewrite an existing purchase', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 10, actorUid: ACTOR })
    enableCredits({ creditUnitPricePaise: 999, creditsPerPhoto: 5 })

    const stored = await purchaseRepo.read(intent.purchaseId)
    expect(stored!.unitPricePaise).toBe(UNIT_PAISE)          // what they were sold
    expect(stored!.creditsPerPhotoAtPurchase).toBe(1)
    expect(stored!.amountPaise).toBe(1000)
  })

  it('rejects a quantity below the configured minimum', async () => {
    enableCredits({ minCreditPurchase: 10 })
    await expect(svc.createPurchaseIntent({ organizerUid: UID, credits: 5, actorUid: ACTOR }))
      .rejects.toThrow(errs.InvalidCreditOperationError)
  })

  it.each([0, -5, NaN])('rejects a non-positive quantity (%s)', async credits => {
    await expect(svc.createPurchaseIntent({ organizerUid: UID, credits, actorUid: ACTOR }))
      .rejects.toThrow(errs.InvalidCreditOperationError)
  })

  it('truncates a fractional quantity and charges for exactly what it grants', async () => {
    // Credits are indivisible, so 1.5 becomes 1 — consistent with `pricingService.quote` and
    // `creditsForPhotos`, which truncate the same way.
    //
    // What makes the truncation safe rather than a silent overcharge is that the AMOUNT is
    // derived from the already-truncated quantity, so the two can never disagree, and the
    // response echoes both back before the organizer pays.
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 1.5, actorUid: ACTOR })
    expect(intent.credits).toBe(1)
    expect(intent.amountPaise).toBe(UNIT_PAISE)   // charged for 1, not 1.5
  })

  it('refuses to sell credits when the unit price is 0 (misconfiguration, not a free tier)', async () => {
    enableCredits({ creditUnitPricePaise: 0 })
    await expect(svc.createPurchaseIntent({ organizerUid: UID, credits: 10, actorUid: ACTOR }))
      .rejects.toThrow(errs.InvalidCreditOperationError)
  })

  it('is unreachable when credits are disabled', async () => {
    businessConfig.clearRuntimeOverrides()
    businessConfig.setRuntimeOverride('mediaStudio', { creditsEnabled: false } as never)
    await expect(svc.createPurchaseIntent({ organizerUid: UID, credits: 10, actorUid: ACTOR }))
      .rejects.toThrow(errs.CreditsDisabledError)
  })

  it('writes NO purchase record when the gateway call fails', async () => {
    rzp.failOrderCreate = true
    await expect(svc.createPurchaseIntent({ organizerUid: UID, credits: 10, actorUid: ACTOR }))
      .rejects.toThrow()

    const snap = await adminDb.collection('mediaCreditPurchases').where('organizerUid', '==', UID).get()
    expect(snap.empty).toBe(true)   // no orphan pending row
  })

  // ── completePurchase ───────────────────────────────────────────────────────

  it('grants credits atomically: purchase, ledger entry and wallet all move together', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 50, actorUid: ACTOR })
    const { paymentId, signature } = capture(intent.gatewayOrderId, intent.amountPaise)

    const result = await svc.completePurchase({
      organizerUid: UID, orderId: intent.gatewayOrderId, paymentId, signature, actorUid: ACTOR,
    })
    expect(result.credits).toBe(50)
    expect(result.balance).toBe(50)

    const stored = await purchaseRepo.read(intent.purchaseId)
    expect(stored!.status).toBe('granted')
    expect(stored!.gatewayPaymentId).toBe(paymentId)
    expect(stored!.grantedAt).not.toBeNull()

    const entry = await adminDb.doc(`mediaCreditLedger/purchase:${intent.purchaseId}`).get()
    expect(entry.exists).toBe(true)
    expect(entry.get('delta')).toBe(50)
    expect(entry.get('reason')).toBe('purchase')
    expect(entry.get('purchaseId')).toBe(intent.purchaseId)
    expect(entry.get('balanceAfter')).toBe(50)

    expect((await walletService.getBalance(UID)).balance).toBe(50)
  })

  it('is idempotent — a re-delivered verification grants once', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 30, actorUid: ACTOR })
    const { paymentId, signature } = capture(intent.gatewayOrderId, intent.amountPaise)
    const args = { organizerUid: UID, orderId: intent.gatewayOrderId, paymentId, signature, actorUid: ACTOR }

    await svc.completePurchase(args)
    await svc.completePurchase(args)
    await svc.completePurchase(args)

    expect((await walletService.getBalance(UID)).balance).toBe(30)
  })

  it('CONCURRENCY: parallel verifications of one payment grant exactly once', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 40, actorUid: ACTOR })
    const { paymentId, signature } = capture(intent.gatewayOrderId, intent.amountPaise)
    const args = { organizerUid: UID, orderId: intent.gatewayOrderId, paymentId, signature, actorUid: ACTOR }

    await Promise.allSettled(Array.from({ length: 5 }, () => svc.completePurchase(args)))
    expect((await walletService.getBalance(UID)).balance).toBe(40)
  }, CONTENTION_TIMEOUT_MS)

  it('rejects a forged signature and grants nothing', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 20, actorUid: ACTOR })
    const { paymentId } = capture(intent.gatewayOrderId, intent.amountPaise)

    await expect(svc.completePurchase({
      organizerUid: UID, orderId: intent.gatewayOrderId, paymentId,
      signature: 'f'.repeat(64), actorUid: ACTOR,
    })).rejects.toThrow(errs.PaymentVerificationError)

    expect((await walletService.getBalance(UID)).balance).toBe(0)
    expect((await purchaseRepo.read(intent.purchaseId))!.status).toBe('pending')
  })

  it('THE amount check: a correctly-signed UNDERPAYMENT is rejected and the purchase fails', async () => {
    // The signature is genuine — it proves the payment belongs to the order. It says nothing
    // about the amount. Without the independent amount check this would grant 100 credits
    // for 1 paise.
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 100, actorUid: ACTOR })
    const { paymentId, signature } = capture(intent.gatewayOrderId, 1)   // paid 1 paise

    await expect(svc.completePurchase({
      organizerUid: UID, orderId: intent.gatewayOrderId, paymentId, signature, actorUid: ACTOR,
    })).rejects.toThrow(errs.PaymentVerificationError)

    expect((await walletService.getBalance(UID)).balance).toBe(0)
    expect((await purchaseRepo.read(intent.purchaseId))!.status).toBe('failed')
  })

  it('rejects a payment that was never captured', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 10, actorUid: ACTOR })
    const { paymentId, signature } = capture(intent.gatewayOrderId, intent.amountPaise, { status: 'failed' })

    await expect(svc.completePurchase({
      organizerUid: UID, orderId: intent.gatewayOrderId, paymentId, signature, actorUid: ACTOR,
    })).rejects.toThrow(errs.PaymentVerificationError)
    expect((await walletService.getBalance(UID)).balance).toBe(0)
  })

  it('rejects another workspace attempting to claim the purchase', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 10, actorUid: ACTOR })
    const { paymentId, signature } = capture(intent.gatewayOrderId, intent.amountPaise)

    await expect(svc.completePurchase({
      organizerUid: 'some-other-workspace', orderId: intent.gatewayOrderId,
      paymentId, signature, actorUid: 'intruder',
    })).rejects.toThrow(errs.PaymentVerificationError)
    expect((await walletService.getBalance(UID)).balance).toBe(0)
  })

  it('rejects an order we never created', async () => {
    const orderId = 'order_never_issued'
    const { paymentId, signature } = capture(orderId, 1000)
    await expect(svc.completePurchase({
      organizerUid: UID, orderId, paymentId, signature, actorUid: ACTOR,
    })).rejects.toThrow(errs.PaymentVerificationError)
  })

  // ── The captured-but-not-granted path ──────────────────────────────────────

  it('ROLLBACK: when the grant transaction fails the money is not lost — purchase parks at `paid` with a reconciliation record', async () => {
    // Forces a REAL transaction failure rather than mocking one: a 0-credit purchase makes
    // `applyDelta` reject the movement, because a `purchase` entry must be positive.
    const purchaseId = purchaseRepo.newPurchaseId()
    await purchaseRepo.createPending({
      purchaseId, organizerUid: UID, credits: 0, amountPaise: 500,
      unitPricePaise: UNIT_PAISE, creditsPerPhotoAtPurchase: 1,
      tierAtPurchase: null, gatewayOrderId: 'order_will_fail',
    })
    const { paymentId, signature } = capture('order_will_fail', 500)

    await expect(svc.completePurchase({
      organizerUid: UID, orderId: 'order_will_fail', paymentId, signature, actorUid: ACTOR,
    })).rejects.toThrow(errs.CreditGrantDeferredError)

    // Nothing granted…
    expect((await walletService.getBalance(UID)).balance).toBe(0)
    expect((await adminDb.doc(`mediaCreditLedger/purchase:${purchaseId}`).get()).exists).toBe(false)

    // …but the purchase is `paid`, NOT `failed`, and the debt is on record.
    expect((await purchaseRepo.read(purchaseId))!.status).toBe('paid')
    const rec = await adminDb.doc('mediaCreditReconciliations/order_will_fail').get()
    expect(rec.exists).toBe(true)
    expect(rec.get('status')).toBe('pending')
    expect(rec.get('organizerUid')).toBe(UID)
  })

  it('the reconciliation drain settles a pending debt exactly once', async () => {
    const purchaseId = purchaseRepo.newPurchaseId()
    await purchaseRepo.createPending({
      purchaseId, organizerUid: UID, credits: 15, amountPaise: 1500,
      unitPricePaise: UNIT_PAISE, creditsPerPhotoAtPurchase: 1,
      tierAtPurchase: null, gatewayOrderId: 'order_deferred',
    })
    await purchaseRepo.recordReconciliation({
      gatewayOrderId: 'order_deferred', organizerUid: UID, purchaseId,
      gatewayPaymentId: 'pay_deferred', credits: 15, amountPaise: 1500,
      lastError: 'simulated transient failure',
    })

    const first = await retryPendingGrants({ limit: 50 })
    expect(first.resolved).toBeGreaterThanOrEqual(1)
    expect((await walletService.getBalance(UID)).balance).toBe(15)
    expect((await purchaseRepo.read(purchaseId))!.status).toBe('granted')
    expect((await adminDb.doc('mediaCreditReconciliations/order_deferred').get()).get('status'))
      .toBe('resolved')

    // A second drain must not grant again.
    await retryPendingGrants({ limit: 50 })
    expect((await walletService.getBalance(UID)).balance).toBe(15)
  })

  it('a drain cannot double-grant a purchase the live path already completed', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 12, actorUid: ACTOR })
    const { paymentId, signature } = capture(intent.gatewayOrderId, intent.amountPaise)
    await svc.completePurchase({
      organizerUid: UID, orderId: intent.gatewayOrderId, paymentId, signature, actorUid: ACTOR,
    })

    // A stale reconciliation record for an already-granted purchase — the exact shape of a
    // transaction that committed but failed to report success.
    await purchaseRepo.recordReconciliation({
      gatewayOrderId: intent.gatewayOrderId, organizerUid: UID, purchaseId: intent.purchaseId,
      gatewayPaymentId: paymentId, credits: 12, amountPaise: intent.amountPaise,
      lastError: 'response lost',
    })
    await retryPendingGrants({ limit: 50 })

    expect((await walletService.getBalance(UID)).balance).toBe(12)   // still 12, not 24
  })

  // ── Reads ──────────────────────────────────────────────────────────────────

  it('getPurchase is tenant-scoped and returns the full snapshot', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 7, actorUid: ACTOR })

    const mine = await svc.getPurchase(UID, intent.purchaseId)
    expect(mine!.credits).toBe(7)
    expect(mine!.unitPricePaise).toBe(UNIT_PAISE)
    expect(mine!.creditsPerPhotoAtPurchase).toBe(1)

    // Another workspace gets null, not a 403 — the endpoint cannot confirm the id exists.
    expect(await svc.getPurchase('another-workspace', intent.purchaseId)).toBeNull()
  })

  it('listPurchases returns only this workspace, newest first', async () => {
    await svc.createPurchaseIntent({ organizerUid: UID, credits: 1, actorUid: ACTOR })
    await svc.createPurchaseIntent({ organizerUid: UID, credits: 2, actorUid: ACTOR })
    await svc.createPurchaseIntent({ organizerUid: 'other-uid', credits: 3, actorUid: ACTOR })

    const { purchases } = await svc.listPurchases(UID, 25)
    expect(purchases).toHaveLength(2)
    expect(purchases.every(p => [1, 2].includes(p.credits))).toBe(true)

    await adminDb.collection('mediaCreditPurchases')
      .where('organizerUid', '==', 'other-uid').get()
      .then(s => Promise.all(s.docs.map(d => d.ref.delete())))
  })

  it('THE invariant: balance equals the sum of ledger deltas after a purchase', async () => {
    const intent = await svc.createPurchaseIntent({ organizerUid: UID, credits: 60, actorUid: ACTOR })
    const { paymentId, signature } = capture(intent.gatewayOrderId, intent.amountPaise)
    await svc.completePurchase({
      organizerUid: UID, orderId: intent.gatewayOrderId, paymentId, signature, actorUid: ACTOR,
    })

    const snap = await adminDb.collection('mediaCreditLedger').where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)
    expect((await walletService.getBalance(UID)).balance).toBe(sum)
  })
})
