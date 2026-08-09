// MC-05 · Refund + reconciliation integration tests — REAL Firestore (emulator).
//
// What needs a real database: the approval transaction's atomicity (refund decision + ledger
// entry + wallet debit commit together or not at all), and the reconciler's idempotency
// across repeated runs. Neither can be proven against a mock.
//
// Razorpay is stubbed — an external paid service. Its duplicate-safety contract is verified
// separately in tests/unit/gatewayRefund.test.ts.
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
  failRefund: false,
  refundCreateCalls: 0,
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => ({
        id: `order_MC05_${++gw.orderSeq}`, amount: o.amount, currency: o.currency,
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

describeEmu('MC-05 · refunds and reconciliation against the Firestore emulator', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let purchases: typeof import('@/features/media-credits/services/purchaseService')
  let refunds:   typeof import('@/features/media-credits/services/refundService')
  let recon:     typeof import('@/features/media-credits/services/reconciliation')
  let refundRepo: typeof import('@/features/media-credits/repositories/refundRepo')
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let errs: typeof import('@/features/media-credits/errors')
  let sign: (o: string, p: string, s: string) => string
  // RD-MC-REFUND-V2-P2 · partial refunds need credits to have been SPENT, which means real
  // sessions. Bound here rather than in a second suite so the gateway mock above is not
  // duplicated — a second copy of it would be a second definition of how Razorpay behaves.
  let sessions:      typeof import('@/features/media-credits/services/sessionService')
  let settlement:    typeof import('@/features/media-credits/services/sessionSettlementService')
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let slots:         typeof import('@/features/media-credits/utils/sessionSlots')

  const UID   = 'emu-refund-organizer'
  const ACTOR = 'emu-actor'
  const ADMIN = 'emu-admin'
  const UNIT  = 100      // ₹1 per credit

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
    ;({ walletService, ledgerService } = await import('@/features/media-credits/services'))
    errs = await import('@/features/media-credits/errors')
    ;({ signPaymentVerification: sign } = await import('../mocks/razorpay'))
    sessions   = await import('@/features/media-credits/services/sessionService')
    settlement = await import('@/features/media-credits/services/sessionSettlementService')
    slots      = await import('@/features/media-credits/utils/sessionSlots')
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  function configure(patch: Record<string, unknown> = {}) {
    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: UNIT,
      minCreditPurchase: 1, refundsEnabled: true, refundWindowDays: 30,
      refundServiceChargeMethod: 'percent', refundServiceChargePercent: 10,
      refundServiceChargeFixedPaise: 0, minRefundablePaise: 100,
      ...patch,
    } as never)
  }

  async function reset() {
    businessConfig.clearRuntimeOverrides()
    gw.payments.clear(); gw.refunds = []; gw.refundSeq = 0
    gw.failRefund = false; gw.refundCreateCalls = 0

    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    // `mediaCreditReservations` belongs here too: the held-credits test creates one, and a
    // reservation id is permanent — a leftover from a previous run makes the hold
    // un-recreatable and the test fails for a reason that has nothing to do with refunds.
    for (const col of ['mediaCreditLedger', 'mediaCreditPurchases', 'mediaCreditReservations',
                       'mediaCreditSessions',
                       'mediaCreditReconciliations', 'mediaCreditRefunds']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()
    configure()
  }

  beforeEach(async () => { await reset() })

  /** Buys `credits` and grants them, returning the completed purchase id. */
  async function buy(credits: number): Promise<string> {
    const intent = await purchases.createPurchaseIntent({
      organizerUid: UID, credits, actorUid: ACTOR,
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
    return intent.purchaseId
  }

  const request = (purchaseId: string) => refunds.createRefundRequest({
    organizerUid: UID, purchaseId, reason: 'no longer needed', requestedBy: ACTOR,
  })

  // ── Request + validation ───────────────────────────────────────────────────

  it('snapshots the wallet, the pricing and the service charge, and moves nothing', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)

    expect(r.status).toBe('requested')
    expect(r.credits).toBe(100)
    expect(r.purchaseAmountPaise).toBe(10_000)
    expect(r.serviceCharge).toMatchObject({ method: 'percent', percent: 10, amountPaise: 1_000 })
    expect(r.refundAmountPaise).toBe(9_000)
    expect(r.unitPricePaise).toBe(UNIT)
    expect(r.walletAtRequest).toEqual({ balance: 100, held: 0, available: 100 })
    expect(r.refundMethod).toBe('razorpay')

    // A request is a record, not a movement.
    expect((await walletService.getBalance(UID)).balance).toBe(100)
  })

  it('a later service-charge change does NOT re-price an open request', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)
    configure({ refundServiceChargePercent: 50 })

    const reread = await refunds.getRefundRequest(UID, r.refundId)
    expect(reread!.refundAmountPaise).toBe(9_000)          // the terms they were shown
    expect(reread!.serviceCharge.percent).toBe(10)
  })

  it('rejects a refund for another workspace\'s purchase', async () => {
    const purchaseId = await buy(10)
    await expect(refunds.createRefundRequest({
      organizerUid: 'someone-else', purchaseId, reason: 'mine now', requestedBy: 'intruder',
    })).rejects.toThrow(errs.RefundNotAllowedError)
  })

  it('rejects a purchase that was never granted', async () => {
    const intent = await purchases.createPurchaseIntent({
      organizerUid: UID, credits: 10, actorUid: ACTOR,
    })
    await expect(request(intent.purchaseId)).rejects.toThrow(errs.RefundNotAllowedError)
  })

  it('rejects credits that have been SPENT', async () => {
    const purchaseId = await buy(10)
    // Spend them via a real debit, so `available` genuinely drops.
    const { ledgerService } = await import('@/features/media-credits/services')
    await ledgerService.debit({
      organizerUid: UID, entryId: 'spend:1', credits: 5, reason: 'consume',
      actorUid: ACTOR, actorKind: 'organizer',
    })
    await expect(request(purchaseId)).rejects.toThrow(errs.InsufficientCreditsError)
  })

  it('rejects credits that are HELD by an open upload session', async () => {
    // MC-06B: holds are placed by SESSIONS, not by individual reservations.
    const purchaseId = await buy(10)
    const { openSession } = await import('@/features/media-credits/services/sessionService')
    await openSession({
      sessionId: `hold-${process.pid}-${Date.now()}`, organizerUid: UID, slotCount: 5,
      actorUid: ACTOR, eventId: 'e', eventSlug: 's', galleryId: 'g',
    })
    // The balance is still 10, but only 5 are available — a hold is not refundable.
    expect((await walletService.getBalance(UID)).balance).toBe(10)
    await expect(request(purchaseId)).rejects.toThrow(errs.InsufficientCreditsError)
  })

  it('rejects a duplicate request while one is open', async () => {
    const purchaseId = await buy(10)
    await request(purchaseId)
    await expect(request(purchaseId)).rejects.toThrow(errs.RefundNotAllowedError)
  })

  it('rejects a request outside the refund window', async () => {
    const purchaseId = await buy(10)
    configure({ refundWindowDays: 0 })
    await expect(request(purchaseId)).rejects.toThrow(errs.RefundNotAllowedError)
  })

  it('rejects when the net refund is below the minimum worth processing', async () => {
    const purchaseId = await buy(1)                      // ₹1 purchase
    configure({ refundServiceChargePercent: 100 })       // nets ₹0
    await expect(request(purchaseId)).rejects.toThrow(errs.RefundNotAllowedError)
  })

  it('is unreachable when refunds — or credits — are disabled', async () => {
    const purchaseId = await buy(10)
    configure({ refundsEnabled: false })
    await expect(request(purchaseId)).rejects.toThrow(errs.RefundNotAllowedError)

    configure({ creditsEnabled: false })
    await expect(request(purchaseId)).rejects.toThrow(errs.CreditsDisabledError)
  })

  // ── Rejection ──────────────────────────────────────────────────────────────

  it('REJECTION touches no wallet and no ledger', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)
    const ledgerBefore = (await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()).size

    await refunds.rejectRefund({ refundId: r.refundId, adminUid: ADMIN, note: 'not eligible' })

    expect((await refundRepo.read(r.refundId))!.status).toBe('rejected')
    expect((await walletService.getBalance(UID)).balance).toBe(100)
    expect((await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()).size).toBe(ledgerBefore)
    expect(gw.refundCreateCalls).toBe(0)
  })

  it('a rejected purchase can be asked about again', async () => {
    const purchaseId = await buy(10)
    const first = await request(purchaseId)
    await refunds.rejectRefund({ refundId: first.refundId, adminUid: ADMIN, note: null })
    await expect(request(purchaseId)).resolves.toBeTruthy()
  })

  it('cannot reject an already-approved refund', async () => {
    const purchaseId = await buy(10)
    const r = await request(purchaseId)
    await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })
    await expect(refunds.rejectRefund({ refundId: r.refundId, adminUid: ADMIN }))
      .rejects.toThrow(errs.RefundNotAllowedError)
  })

  // ── Approval ───────────────────────────────────────────────────────────────

  it('APPROVAL debits, appends the ledger entry and pays out — atomically', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)

    const out = await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN, note: 'ok' })
    expect(out.settled).toBe(true)
    expect(out.refundAmountPaise).toBe(9_000)
    expect(out.gatewayRefundId).toMatch(/^rfnd_/)

    expect((await walletService.getBalance(UID)).balance).toBe(0)

    const entry = await adminDb.doc(`mediaCreditLedger/refund:${r.refundId}`).get()
    expect(entry.exists).toBe(true)
    expect(entry.get('delta')).toBe(-100)
    expect(entry.get('reason')).toBe('refund')
    expect(entry.get('refundId')).toBe(r.refundId)
    expect(entry.get('balanceAfter')).toBe(0)

    const stored = await refundRepo.read(r.refundId)
    expect(stored!.status).toBe('settled')
    expect(stored!.gatewayRefundId).toBe(out.gatewayRefundId)
    expect(stored!.decidedBy).toBe(ADMIN)
  })

  it('is idempotent — approving twice debits once and pays once', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)

    await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })
    await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })

    expect((await walletService.getBalance(UID)).balance).toBe(0)
    expect(gw.refundCreateCalls).toBe(1)
  })

  it('CONCURRENCY: parallel approvals debit once and pay once', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)

    await Promise.allSettled(Array.from({ length: 4 }, () =>
      refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })))

    expect((await walletService.getBalance(UID)).balance).toBe(0)
    expect(gw.refundCreateCalls).toBeLessThanOrEqual(1)
  }, CONTENTION_TIMEOUT_MS)

  it('RD-MC-REFUND-V2-P3 · the credits can no longer BE spent while queued', async () => {
    // Before P3 this test spent the credits mid-queue and asserted the approval then failed
    // whole. P3 makes the spend itself impossible, which is the stronger guarantee: the
    // refused debit is the hold doing its job, and the approval never has to roll back.
    const purchaseId = await buy(100)
    const r = await request(purchaseId)

    // Balance untouched, availability gone — the P3 workflow, exactly.
    const held = await walletService.getBalance(UID)
    expect(held.balance).toBe(100)
    expect(held.refundHeld).toBe(100)
    expect(held.available).toBe(0)

    await expect(ledgerService.debit({
      organizerUid: UID, entryId: `spend:late:${process.pid}`, credits: 60, reason: 'consume',
      actorUid: ACTOR, actorKind: 'organizer',
    })).rejects.toThrow(errs.InsufficientCreditsError)

    // Nothing moved, nothing was paid, and the request is still decidable.
    expect((await walletService.getBalance(UID)).balance).toBe(100)
    expect((await refundRepo.read(r.refundId))!.status).toBe('requested')
    expect(gw.refundCreateCalls).toBe(0)
  })

  it('DEFERRED: a gateway failure debits the credits and parks the refund at `approved`', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)
    gw.failRefund = true

    await expect(refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN }))
      .rejects.toThrow(errs.RefundSettlementDeferredError)

    // Credits gone — the debit committed — money not yet sent. The debt is visible.
    expect((await walletService.getBalance(UID)).balance).toBe(0)
    const stored = await refundRepo.read(r.refundId)
    expect(stored!.status).toBe('approved')
    expect(stored!.gatewayRefundId).toBeNull()
    expect(stored!.gatewayAttempts).toBeGreaterThanOrEqual(1)
  })

  // ── Reconciliation ─────────────────────────────────────────────────────────

  it('the reconciler settles a deferred refund, and only once', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)
    gw.failRefund = true
    await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN }).catch(() => {})

    gw.failRefund = false
    const first = await recon.retryPendingRefunds({ limit: 50 })
    expect(first.resolved).toBeGreaterThanOrEqual(1)
    expect((await refundRepo.read(r.refundId))!.status).toBe('settled')

    const before = gw.refundCreateCalls
    await recon.retryPendingRefunds({ limit: 50 })
    expect(gw.refundCreateCalls).toBe(before)      // nothing paid a second time
  })

  it('runReconciliation drains grants and refunds together and is replay-safe', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)
    gw.failRefund = true
    await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN }).catch(() => {})
    gw.failRefund = false

    const report = await recon.runReconciliation({ limit: 50 })
    expect(report.refunds.resolved).toBeGreaterThanOrEqual(1)
    expect((await refundRepo.read(r.refundId))!.status).toBe('settled')

    // Running it again changes nothing.
    const balance = (await walletService.getBalance(UID)).balance
    await recon.runReconciliation({ limit: 50 })
    expect((await walletService.getBalance(UID)).balance).toBe(balance)
  }, CONTENTION_TIMEOUT_MS)

  it('detectOrphans flags a stuck refund after repeated payout failures', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)
    gw.failRefund = true
    await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN }).catch(() => {})
    for (let i = 1; i < recon.STUCK_REFUND_ATTEMPTS; i++) {
      await recon.retryPendingRefunds({ limit: 50 })
    }

    const orphans = await recon.detectOrphans(100)
    expect(orphans.stuckRefunds).toContain(r.refundId)
  }, CONTENTION_TIMEOUT_MS)

  // ── Reads + invariant ──────────────────────────────────────────────────────

  it('reads are tenant-scoped', async () => {
    const purchaseId = await buy(10)
    const r = await request(purchaseId)

    expect(await refunds.getRefundRequest(UID, r.refundId)).toBeTruthy()
    expect(await refunds.getRefundRequest('another-workspace', r.refundId)).toBeNull()

    const { refunds: mine } = await refunds.listRefundRequests(UID, 25)
    expect(mine.map(x => x.refundId)).toContain(r.refundId)
  })

  it('THE invariant: balance still equals the sum of ledger deltas after a refund', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)
    await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)
    expect((await walletService.getBalance(UID)).balance).toBe(sum)
  })

  // ── RD-MC-REFUND-V2-P1 · the refunded lot ──────────────────────────────────

  it('an APPROVED refund drains the lot it came from, in the same transaction', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)

    const before = await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get()
    expect(before.get('creditsRemaining')).toBe(100)

    await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })

    // Refunded credits left the wallet, so the lot must not still claim them — otherwise
    // Σ lots would permanently exceed the balance.
    const after = await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get()
    expect(after.get('creditsRemaining')).toBe(0)
    // Drained ⇒ out of the open-lot query, exactly as a fully consumed lot is.
    expect(after.get('lotSeq')).toBeUndefined()
    expect((await walletService.getBalance(UID)).balance).toBe(0)
  })

  it('a REJECTED refund leaves the lot untouched', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)
    await refunds.rejectRefund({ refundId: r.refundId, adminUid: ADMIN, note: 'Not eligible.' })

    const doc = await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get()
    expect(doc.get('creditsRemaining')).toBe(100)
    expect((await walletService.getBalance(UID)).balance).toBe(100)
  })

  it('a REPLAYED approval debits the lot exactly once', async () => {
    const purchaseId = await buy(100)
    const r = await request(purchaseId)

    await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })
    await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })

    // The replay returns the already-approved refund from inside the transaction, so it never
    // reaches the lot write. Without that, `creditsRemaining` would be untouched at 0 only by
    // luck — `refundDebitFor` returns null on an empty lot — and a partial refund would
    // double-debit.
    const doc = await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get()
    expect(doc.get('creditsRemaining')).toBe(0)
    expect((await walletService.getBalance(UID)).balance).toBe(0)
  })

  // ── RD-MC-REFUND-V2-P2 · partial refunds of unused credits ─────────────────
  //
  // The arithmetic is proven in tests/unit/refundMath.test.ts. What needs a real database
  // here is that the number reaching that arithmetic is the LOT's, that a purchase is priced
  // at its own rate when several exist, and that the frozen terms survive to approval.

  /** Real uploads are one transaction per photo, so consuming 200 is 200 round trips. */
  const PARTIAL_TIMEOUT_MS = 90_000

  describe('partial refunds', () => {
    /** Uploads `n` photos and settles, so `n` credits are really consumed via FIFO. */
    async function consume(n: number) {
      const sessionId = `p2-${process.pid}-${Math.round(gw.orderSeq * 1000 + n)}`
      await sessions.openSession({
        sessionId, organizerUid: UID, slotCount: n, actorUid: ACTOR,
        eventId: 'p2-evt', eventSlug: 'p2-evt', galleryId: 'p2-gal',
      })
      for (let i = 0; i < n; i++) {
        const assetId = slots.deriveAssetId(sessionId, i)
        await ledgerService.reserve({
          organizerUid: UID, assetId, credits: 1, actorUid: ACTOR,
          sessionId, slotIndex: i,
          eventId: 'p2-evt', eventSlug: 'p2-evt', galleryId: 'p2-gal',
        })
        await ledgerService.consume({ organizerUid: UID, assetId, actorUid: ACTOR })
      }
      await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: ACTOR })
      await settlement.settleSession(sessionId)
    }

    const viewFor = async (purchaseId: string) => {
      const p = await purchases.getPurchase(UID, purchaseId)
      const [view] = await refunds.refundViewsForPurchases(UID, [{
        purchaseId, status: p!.status, credits: p!.credits,
        amountPaise: p!.amountPaise, grantedAtMs: p!.grantedAtMs ?? 0,
        unitPricePaise: p!.unitPricePaise,
      }])
      return view
    }

    it("SINGLE PURCHASE · the brief's worked example, end to end", async () => {
      // 500 bought at ₹1, one credit used ⇒ ₹499 base, ₹49.90 charge, ₹449.10 net.
      const purchaseId = await buy(500)
      await consume(1)

      const view = await viewFor(purchaseId)
      expect(view.eligible).toBe(true)
      expect(view.credits).toBe(500)
      expect(view.creditsUsed).toBe(1)
      expect(view.creditsRemaining).toBe(499)
      expect(view.refundBasePaise).toBe(49_900)
      expect(view.serviceChargePaise).toBe(4_990)
      expect(view.refundAmountPaise).toBe(44_910)

      const r = await refunds.createRefundRequest({
        organizerUid: UID, purchaseId, reason: 'over-bought', requestedBy: ACTOR,
      })
      expect(r.credits).toBe(499)                     // the debit is the REMAINDER
      expect(r.creditsRemainingAtRequest).toBe(499)
      expect(r.refundBasePaise).toBe(49_900)
      expect(r.refundAmountPaise).toBe(44_910)
      expect(r.purchaseAmountPaise).toBe(50_000)      // context: the full purchase
    })

    it('ZERO REMAINING · a fully consumed purchase is refused, and NOT as an insufficiency', async () => {
      const purchaseId = await buy(10)
      await consume(10)

      const view = await viewFor(purchaseId)
      expect(view.eligible).toBe(false)
      expect(view.reason).toBe('no_unused_credits')
      expect(view.creditsRemaining).toBe(0)
      expect(view.refundBasePaise).toBe(0)

      await expect(refunds.createRefundRequest({
        organizerUid: UID, purchaseId, reason: 'changed my mind', requestedBy: ACTOR,
      })).rejects.toThrow(errs.RefundNotAllowedError)
    })

    it('ONE REMAINING · the smallest possible refund still prices', async () => {
      const purchaseId = await buy(10)
      await consume(9)

      const view = await viewFor(purchaseId)
      expect(view.creditsRemaining).toBe(1)
      expect(view.refundBasePaise).toBe(100)          // ₹1
      expect(view.serviceChargePaise).toBe(10)        // 10%
      expect(view.refundAmountPaise).toBe(90)
    })

    it('LARGE REMAINING · a big remainder prices without drift', async () => {
      const purchaseId = await buy(50_000)
      await consume(3)

      const view = await viewFor(purchaseId)
      expect(view.creditsRemaining).toBe(49_997)
      expect(view.refundBasePaise).toBe(4_999_700)    // ₹49,997
      expect(view.refundAmountPaise).toBe(4_499_730)  // less 10%
    })

    it('MULTIPLE PURCHASES AT DIFFERENT PRICES · each refunds at its OWN rate', async () => {
      // A: 500 @ ₹1 (oldest). B: 500 @ ₹2. FIFO drains A first.
      const a = await buy(500)
      configure({ creditUnitPricePaise: 200 })
      const b = await buy(500)

      await consume(200)          // all from A, the older lot

      const [va, vb] = [await viewFor(a), await viewFor(b)]

      expect(va.creditsRemaining).toBe(300)
      expect(va.refundBasePaise).toBe(30_000)         // 300 × ₹1
      expect(vb.creditsRemaining).toBe(500)           // untouched — FIFO never skips ahead
      expect(vb.refundBasePaise).toBe(100_000)        // 500 × ₹2, NOT 500 × ₹1

      // The two must never be priced off one rate. A wallet-wide average would give both
      // rows the same per-credit figure.
      expect(vb.refundBasePaise / vb.creditsRemaining)
        .not.toBe(va.refundBasePaise / va.creditsRemaining)
    }, PARTIAL_TIMEOUT_MS)

    it('CREDITS HELD · an open upload blocks the refund rather than stranding itself', async () => {
      const purchaseId = await buy(100)
      await sessions.openSession({
        sessionId: `p2-hold-${process.pid}`, organizerUid: UID, slotCount: 40,
        actorUid: ACTOR, eventId: 'p2-evt', eventSlug: 'p2-evt', galleryId: 'p2-gal',
      })

      // Unused but not free: 100 remaining, only 60 available.
      const view = await viewFor(purchaseId)
      expect(view.creditsRemaining).toBe(100)
      expect(view.availableCredits).toBe(60)
      expect(view.eligible).toBe(false)
      expect(view.reason).toBe('credits_held')

      await expect(refunds.createRefundRequest({
        organizerUid: UID, purchaseId, reason: 'no longer needed', requestedBy: ACTOR,
      })).rejects.toThrow(errs.InsufficientCreditsError)
    })

    it('APPROVAL reuses the FROZEN terms and drains only the refunded credits', async () => {
      const purchaseId = await buy(500)
      await consume(100)
      const r = await refunds.createRefundRequest({
        organizerUid: UID, purchaseId, reason: 'over-bought', requestedBy: ACTOR,
      })

      // A later policy change must not re-price a request already made.
      configure({ refundServiceChargePercent: 50 })
      await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })

      const stored = await refundRepo.read(r.refundId)
      expect(stored!.refundAmountPaise).toBe(r.refundAmountPaise)   // 400 × ₹1 less 10%
      expect(stored!.refundAmountPaise).toBe(36_000)

      // 400 refunded out of a 500 lot that had 100 consumed ⇒ nothing left.
      const doc = await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get()
      expect(doc.get('creditsRemaining')).toBe(0)
      expect((await walletService.getBalance(UID)).balance).toBe(0)
    }, PARTIAL_TIMEOUT_MS)

    it('RD-MC-REFUND-V2-P3 · uploads SKIP the reserved lot and drain the next one', async () => {
      // This was P2's unreachable-invariant case: FIFO would drain the older lot A even
      // though a refund was pending on it, and the approval then had to refuse. P3 takes A
      // out of the open-lot query, so the upload spends B and the refund stays approvable.
      // "They cannot disappear because of later uploads" — measured, not asserted in a
      // comment.
      const a = await buy(500)
      const b = await buy(500)
      const r = await refunds.createRefundRequest({
        organizerUid: UID, purchaseId: a, reason: 'over-bought', requestedBy: ACTOR,
      })
      expect(r.credits).toBe(500)

      // The reservation IS the removal of the ordering key — the same mechanism a drained
      // lot uses, which is why `allocateFifo` needed no change.
      const reserved = await adminDb.doc(`mediaCreditPurchases/${a}`).get()
      expect(reserved.get('lotSeq')).toBeUndefined()
      expect(reserved.get('creditsRemaining')).toBe(500)     // still owned, just unreachable

      await consume(100)

      expect((await adminDb.doc(`mediaCreditPurchases/${a}`).get()).get('creditsRemaining'))
        .toBe(500)                                            // untouched by the upload
      expect((await adminDb.doc(`mediaCreditPurchases/${b}`).get()).get('creditsRemaining'))
        .toBe(400)                                            // B paid for the photos

      // And the refund is still worth exactly what the organizer was quoted.
      await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })
      expect((await refundRepo.read(r.refundId))!.refundAmountPaise).toBe(r.refundAmountPaise)
      expect((await walletService.getBalance(UID)).balance).toBe(400)
    }, PARTIAL_TIMEOUT_MS)

    it('the P2 stale guard still refuses a lot that cannot cover the quote', async () => {
      // Defence in depth. P3 makes the upload route to this state unreachable, but the guard
      // must stay: a refund written before P3 reserved no lot, and any future path that
      // drains a purchase would otherwise debit the wallet by more than the lot can give —
      // permanent drift with no error to show for it.
      const a = await buy(500)
      await buy(500)
      const r = await refunds.createRefundRequest({
        organizerUid: UID, purchaseId: a, reason: 'over-bought', requestedBy: ACTOR,
      })

      // Drain the lot behind the refund's back, exactly as a pre-P3 request would have been
      // drained by an upload.
      await adminDb.doc(`mediaCreditPurchases/${a}`).update({ creditsRemaining: 400 })

      await expect(refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN }))
        .rejects.toThrow(errs.RefundNotAllowedError)

      // Nothing moved: no partial payout, no drift, and the request survives for a human.
      expect((await refundRepo.read(r.refundId))!.status).toBe('requested')
      expect((await walletService.getBalance(UID)).balance).toBe(1_000)
      expect(gw.refundCreateCalls).toBe(0)
    }, PARTIAL_TIMEOUT_MS)

    it('the INVARIANT survives a partial refund', async () => {
      const lotRepo = await import('@/features/media-credits/repositories/lotRepo')
      const purchaseId = await buy(500)
      await consume(120)
      const r = await refunds.createRefundRequest({
        organizerUid: UID, purchaseId, reason: 'over-bought', requestedBy: ACTOR,
      })
      await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })

      // Σ lots == balance, still. 500 bought − 120 used − 380 refunded = 0.
      const [sum, balance] = await Promise.all([
        lotRepo.sumOpenLots(UID),
        walletService.getBalance(UID).then(b => b.balance),
      ])
      expect(sum).toBe(balance)
      expect(balance).toBe(0)
    }, PARTIAL_TIMEOUT_MS)
  })

  // ── RD-MC-REFUND-V2-P3 · the refund hold and multiple partial refunds ──────
  //
  // INVARIANTS UNDER TEST
  //   I5  wallet.refundHeldCredits == Σ credits of refunds in status 'requested'
  //   I6  available = balance − heldCredits − refundHeldCredits
  //   I7  per purchase, Σ refunded + Σ consumed ≤ credits bought
  //   I1  balance == Σ ledger deltas                        (a hold writes NO ledger entry)
  //   Σ lots == balance                                     (a hold moves no credits)

  describe('refund holds', () => {
    /** Uploads `n` photos and settles. Shares the P2 helper's shape deliberately. */
    async function consumeCredits(n: number) {
      const sessionId = `p3-${process.pid}-${gw.orderSeq}-${n}`
      await sessions.openSession({
        sessionId, organizerUid: UID, slotCount: n, actorUid: ACTOR,
        eventId: 'p3-evt', eventSlug: 'p3-evt', galleryId: 'p3-gal',
      })
      for (let i = 0; i < n; i++) {
        const assetId = slots.deriveAssetId(sessionId, i)
        await ledgerService.reserve({
          organizerUid: UID, assetId, credits: 1, actorUid: ACTOR, sessionId, slotIndex: i,
          eventId: 'p3-evt', eventSlug: 'p3-evt', galleryId: 'p3-gal',
        })
        await ledgerService.consume({ organizerUid: UID, assetId, actorUid: ACTOR })
      }
      await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: ACTOR })
      await settlement.settleSession(sessionId)
    }

    /** I5 · the wallet's hold must equal the sum of what pending refunds claim. */
    async function assertHoldMatchesPendingRefunds() {
      const snap = await adminDb.collection('mediaCreditRefunds')
        .where('organizerUid', '==', UID).get()
      const expected = snap.docs
        .filter(d => d.get('status') === 'requested')
        .reduce((n, d) => n + (d.get('credits') as number), 0)
      const wallet = await adminDb.doc(`mediaCreditWallets/${UID}`).get()
      expect(wallet.get('refundHeldCredits') ?? 0).toBe(expected)
    }

    /** I1 + Σ lots — neither may be disturbed by a hold, which moves no credits. */
    async function assertLedgerAndLots() {
      const lotRepo = await import('@/features/media-credits/repositories/lotRepo')
      const snap = await adminDb.collection('mediaCreditLedger')
        .where('organizerUid', '==', UID).get()
      const fromLedger = snap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)
      const balance = (await walletService.getBalance(UID)).balance
      expect(balance).toBe(fromLedger)
      expect(await lotRepo.sumOpenLots(UID)).toBe(balance)
    }

    // ═══ The hold ═════════════════════════════════════════════════════════════

    it("REQUEST · the brief's workflow, figure for figure", async () => {
      // 500 bought, 1 used, 499 refundable.
      const purchaseId = await buy(500)
      await consumeCredits(1)

      const before = await walletService.getBalance(UID)
      expect(before.balance).toBe(499)
      expect(before.refundHeld).toBe(0)

      const r = await refunds.createRefundRequest({
        organizerUid: UID, purchaseId, reason: 'over-bought', requestedBy: ACTOR,
      })
      expect(r.credits).toBe(499)

      const after = await walletService.getBalance(UID)
      expect(after.balance).toBe(499)                  // UNCHANGED — a hold moves no credits
      expect(after.refundHeld).toBe(499)               // reserved
      expect(after.available).toBe(0)                  // and so unspendable
      expect((await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get())
        .get('creditsRemaining')).toBe(499)            // the lot is UNCHANGED too

      await assertHoldMatchesPendingRefunds()
      await assertLedgerAndLots()
    }, PARTIAL_TIMEOUT_MS)

    it('a request writes NO ledger entry — I1 is untouched', async () => {
      const purchaseId = await buy(100)
      const before = await adminDb.collection('mediaCreditLedger')
        .where('organizerUid', '==', UID).get()

      await request(purchaseId)

      const after = await adminDb.collection('mediaCreditLedger')
        .where('organizerUid', '==', UID).get()
      // A hold changes no balance, so there is no delta to record. Inventing a zero-delta
      // entry would make the ledger claim a movement that never happened.
      expect(after.size).toBe(before.size)
      await assertLedgerAndLots()
    })

    it('UPLOADS cannot consume held credits', async () => {
      const purchaseId = await buy(100)
      await request(purchaseId)

      // The whole balance is reserved, so a session for even one photo is refused.
      await expect(sessions.openSession({
        sessionId: `p3-blocked-${process.pid}`, organizerUid: UID, slotCount: 1,
        actorUid: ACTOR, eventId: 'p3-evt', eventSlug: 'p3-evt', galleryId: 'p3-gal',
      })).rejects.toThrow(errs.InsufficientCreditsError)
    })

    it('the upload refusal NAMES the refund rather than just saying "insufficient"', async () => {
      const purchaseId = await buy(100)
      await request(purchaseId)

      // An organizer whose balance still reads 100 must be told where the credits went, and
      // that cancelling gets them back.
      await expect(sessions.openSession({
        sessionId: `p3-msg-${process.pid}`, organizerUid: UID, slotCount: 1,
        actorUid: ACTOR, eventId: 'p3-evt', eventSlug: 'p3-evt', galleryId: 'p3-gal',
      })).rejects.toThrow(/reserved by a pending refund/i)
    })

    it('a SECOND refund cannot double-spend the first one’s reservation', async () => {
      const a = await buy(100)
      const b = await buy(100)
      await refunds.createRefundRequest({
        organizerUid: UID, purchaseId: a, reason: 'first', requestedBy: ACTOR,
      })
      // B is a different purchase, so `request_already_open` does not apply — what stops a
      // double-spend is that the wallet has only 100 available for a 100-credit hold.
      await refunds.createRefundRequest({
        organizerUid: UID, purchaseId: b, reason: 'second', requestedBy: ACTOR,
      })

      const w = await walletService.getBalance(UID)
      expect(w.balance).toBe(200)
      expect(w.refundHeld).toBe(200)
      expect(w.available).toBe(0)
      await assertHoldMatchesPendingRefunds()
    })

    // ═══ Releasing it ═════════════════════════════════════════════════════════

    it('REJECT · restores availability, moves no money, writes no ledger entry', async () => {
      const purchaseId = await buy(100)
      const r = await request(purchaseId)
      const entriesBefore = (await adminDb.collection('mediaCreditLedger')
        .where('organizerUid', '==', UID).get()).size

      await refunds.rejectRefund({ refundId: r.refundId, adminUid: ADMIN, note: 'Not eligible.' })

      const w = await walletService.getBalance(UID)
      expect(w.balance).toBe(100)
      expect(w.refundHeld).toBe(0)
      expect(w.available).toBe(100)                    // spendable again
      expect((await adminDb.collection('mediaCreditLedger')
        .where('organizerUid', '==', UID).get()).size).toBe(entriesBefore)
      // The lot is back in FIFO, so the credits can be uploaded as well as refunded.
      expect((await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get()).get('lotSeq'))
        .toBeTypeOf('number')
      await assertHoldMatchesPendingRefunds()
      await assertLedgerAndLots()
    })

    it('CANCEL · behaves exactly like a rejection', async () => {
      const purchaseId = await buy(100)
      const r = await request(purchaseId)

      await refunds.cancelRefund({ organizerUid: UID, refundId: r.refundId, actorUid: ACTOR })

      const stored = await refundRepo.read(r.refundId)
      expect(stored!.status).toBe('cancelled')
      expect(stored!.decidedBy).toBe(ACTOR)            // the organizer, named on their own act

      const w = await walletService.getBalance(UID)
      expect(w.balance).toBe(100)
      expect(w.refundHeld).toBe(0)
      expect(w.available).toBe(100)
      expect(gw.refundCreateCalls).toBe(0)
      await assertHoldMatchesPendingRefunds()
      await assertLedgerAndLots()
    })

    it('CANCEL · is refused for another workspace, and cannot be double-released', async () => {
      const purchaseId = await buy(100)
      const r = await request(purchaseId)

      // Not yours reads exactly like does-not-exist, so ids cannot be probed.
      await expect(refunds.cancelRefund({
        organizerUid: 'someone-else', refundId: r.refundId, actorUid: 'intruder',
      })).rejects.toThrow(errs.InvalidCreditOperationError)
      expect((await walletService.getBalance(UID)).refundHeld).toBe(100)

      await refunds.cancelRefund({ organizerUid: UID, refundId: r.refundId, actorUid: ACTOR })
      // Replay. The status guard — not the clamp — is what makes this a no-op.
      await refunds.cancelRefund({ organizerUid: UID, refundId: r.refundId, actorUid: ACTOR })
      expect((await walletService.getBalance(UID)).refundHeld).toBe(0)
      await assertHoldMatchesPendingRefunds()
    })

    it('CANCEL · cannot unwind an APPROVED refund', async () => {
      const purchaseId = await buy(100)
      const r = await request(purchaseId)
      await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })

      // The credits have left the wallet and the payout has gone. There is nothing to cancel.
      await expect(refunds.cancelRefund({
        organizerUid: UID, refundId: r.refundId, actorUid: ACTOR,
      })).rejects.toThrow(errs.RefundNotAllowedError)
      expect((await refundRepo.read(r.refundId))!.status).toBe('settled')
    })

    it('APPROVE · converts the hold into a debit exactly once', async () => {
      const purchaseId = await buy(100)
      const r = await request(purchaseId)

      await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })

      const w = await walletService.getBalance(UID)
      expect(w.balance).toBe(0)                        // debited
      expect(w.refundHeld).toBe(0)                     // and the hold is gone, not stranded
      expect(w.available).toBe(0)
      await assertHoldMatchesPendingRefunds()
      await assertLedgerAndLots()
    })

    it('APPROVE · a wallet holding ONLY these credits can still pay them back', async () => {
      // The ordering hazard. `applyDelta` checks a debit against `available`, which the hold
      // reduces to zero — so freeing must precede debiting or an approval fails its own
      // reservation. Same ordering `settleSessionInTx` uses for session holds.
      const purchaseId = await buy(500)
      const r = await request(purchaseId)
      expect((await walletService.getBalance(UID)).available).toBe(0)

      await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })
      expect((await walletService.getBalance(UID)).balance).toBe(0)
    })

    it('a REPLAYED approval releases the hold exactly once', async () => {
      const purchaseId = await buy(100)
      const r = await request(purchaseId)

      await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })
      await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })

      const w = await walletService.getBalance(UID)
      expect(w.balance).toBe(0)
      expect(w.refundHeld).toBe(0)
      await assertLedgerAndLots()
    })

    it('AUTO-REJECT releases the hold too — it is the same code path', async () => {
      const purchaseId = await buy(100)
      const r = await request(purchaseId)
      configure({ refundAutoRejectDays: 7 })
      await adminDb.doc(`mediaCreditRefunds/${r.refundId}`).update({
        createdAt: new Date(Date.now() - 30 * 86_400_000),
      })

      const report = await recon.autoRejectStaleRefunds({ limit: 50 })
      expect(report.rejected).toBeGreaterThanOrEqual(1)

      expect((await refundRepo.read(r.refundId))!.status).toBe('rejected')
      expect((await walletService.getBalance(UID)).refundHeld).toBe(0)
      await assertHoldMatchesPendingRefunds()
    })

    // ═══ Multiple partial refunds ═════════════════════════════════════════════

    it("MULTIPLE REFUNDS · the brief's 500 → 100 → 50 → 350 sequence", async () => {
      const purchaseId = await buy(500)
      const remainingOf = async () =>
        (await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get())
          .get('creditsRemaining') as number

      // A settled refund must NOT permanently block the next one — the whole point of P3.
      for (const [refundCredits, left] of [[100, 400], [50, 350], [350, 0]] as const) {
        // The organizer refunds part of what is left; the request is priced on the lot.
        await adminDb.doc(`mediaCreditPurchases/${purchaseId}`)
          .update({ creditsRemaining: refundCredits })
        const r = await refunds.createRefundRequest({
          organizerUid: UID, purchaseId, reason: `slice of ${refundCredits}`, requestedBy: ACTOR,
        })
        expect(r.credits).toBe(refundCredits)
        await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })
        expect((await refundRepo.read(r.refundId))!.status).toBe('settled')

        // Put back what this slice did not cover, standing in for the credits the organizer
        // still holds. The assertion that matters is that the NEXT request is allowed at all.
        if (left > 0) await adminDb.doc(`mediaCreditPurchases/${purchaseId}`)
          .update({ creditsRemaining: left, lotSeq: Date.now() })
      }

      expect(await remainingOf()).toBe(0)
      // I7 · four refunds, and never more than the purchase bought.
      const all = await adminDb.collection('mediaCreditRefunds')
        .where('purchaseId', '==', purchaseId).get()
      const refunded = all.docs
        .filter(d => ['approved', 'settling', 'settled'].includes(d.get('status') as string))
        .reduce((n, d) => n + (d.get('credits') as number), 0)
      expect(refunded).toBe(500)
      expect(refunded).toBeLessThanOrEqual(500)
    }, PARTIAL_TIMEOUT_MS)

    it('a SETTLED refund does not block a later one on the same purchase', async () => {
      const purchaseId = await buy(500)
      await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).update({ creditsRemaining: 100 })
      const first = await request(purchaseId)
      await refunds.approveRefund({ refundId: first.refundId, adminUid: ADMIN })

      // 400 still unspent. Before P3 `findBlockingForPurchase` counted `settled` and this
      // second request was impossible — the first partial refund was the last one.
      await adminDb.doc(`mediaCreditPurchases/${purchaseId}`)
        .update({ creditsRemaining: 400, lotSeq: Date.now() })
      const second = await request(purchaseId)
      expect(second.credits).toBe(400)
      expect(second.status).toBe('requested')
    })

    it('an ACTIVE refund DOES block a second one on the same purchase', async () => {
      const purchaseId = await buy(500)
      await request(purchaseId)
      await expect(request(purchaseId)).rejects.toThrow(errs.RefundNotAllowedError)
      // And exactly one hold was placed.
      expect((await walletService.getBalance(UID)).refundHeld).toBe(500)
      await assertHoldMatchesPendingRefunds()
    })

    it('a fully-refunded purchase says REFUNDED, not "used"', async () => {
      const purchaseId = await buy(100)
      const r = await request(purchaseId)
      await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })

      const p = await purchases.getPurchase(UID, purchaseId)
      const [view] = await refunds.refundViewsForPurchases(UID, [{
        purchaseId, status: p!.status, credits: p!.credits,
        amountPaise: p!.amountPaise, grantedAtMs: p!.grantedAtMs ?? 0,
        unitPricePaise: p!.unitPricePaise,
      }])
      expect(view.eligible).toBe(false)
      expect(view.reason).toBe('already_refunded')
      expect(view.explanation).toMatch(/refunded/i)
    })
  })

  // ── MC-12.1 · auto-rejecting stale requests ────────────────────────────────

  describe('autoRejectStaleRefunds', () => {
    /** Ages a request by rewriting its createdAt — the only way to test a day threshold. */
    async function age(refundId: string, days: number) {
      await adminDb.doc(`mediaCreditRefunds/${refundId}`).update({
        createdAt: new Date(Date.now() - days * 86_400_000),
      })
    }

    it('does NOTHING when the threshold is 0', async () => {
      configure({ refundAutoRejectDays: 0 })
      const r = await request(await buy(100))
      await age(r.refundId, 90)

      const { autoRejectStaleRefunds } = await import('@/features/media-credits/services/reconciliation')
      const report = await autoRejectStaleRefunds()

      expect(report.enabled).toBe(false)
      expect(report.rejected).toBe(0)
      // Untouched: the admin can still decide it.
      const after = await refunds.getRefundRequest(UID, r.refundId)
      expect(after?.status).toBe('requested')
    })

    it('rejects a request older than the threshold and MOVES NO MONEY', async () => {
      configure({ refundAutoRejectDays: 14 })
      const purchaseId = await buy(100)
      const r = await request(purchaseId)
      await age(r.refundId, 20)

      const before = await walletService.getBalance(UID)

      const { autoRejectStaleRefunds } = await import('@/features/media-credits/services/reconciliation')
      const report = await autoRejectStaleRefunds()

      expect(report.enabled).toBe(true)
      expect(report.rejected).toBe(1)

      const after = await refunds.getRefundRequest(UID, r.refundId)
      expect(after?.status).toBe('rejected')

      // THE property. Rejection is the one refund transition that touches no wallet.
      const balance = await walletService.getBalance(UID)
      expect(balance.balance).toBe(before.balance)
      expect(balance.held).toBe(before.held)

      // And no ledger entry was written for it.
      const entries = await adminDb.collection('mediaCreditLedger')
        .where('organizerUid', '==', UID).where('reason', '==', 'refund').get()
      expect(entries.size).toBe(0)
    })

    it('leaves a request YOUNGER than the threshold alone', async () => {
      configure({ refundAutoRejectDays: 14 })
      const r = await request(await buy(100))
      await age(r.refundId, 3)

      const { autoRejectStaleRefunds } = await import('@/features/media-credits/services/reconciliation')
      const report = await autoRejectStaleRefunds()

      expect(report.rejected).toBe(0)
      expect((await refunds.getRefundRequest(UID, r.refundId))?.status).toBe('requested')
    })

    it('records a note that makes the automation unmistakable', async () => {
      configure({ refundAutoRejectDays: 7 })
      const r = await request(await buy(100))
      await age(r.refundId, 10)

      const { autoRejectStaleRefunds, AUTO_REJECT_NOTE } =
        await import('@/features/media-credits/services/reconciliation')
      await autoRejectStaleRefunds()

      const after = await refunds.getRefundRequest(UID, r.refundId)
      expect(after?.decisionNote).toBe(AUTO_REJECT_NOTE)
    })

    it('is idempotent — a second sweep rejects nothing further', async () => {
      configure({ refundAutoRejectDays: 7 })
      const r = await request(await buy(100))
      await age(r.refundId, 10)

      const { autoRejectStaleRefunds } = await import('@/features/media-credits/services/reconciliation')
      const first  = await autoRejectStaleRefunds()
      const second = await autoRejectStaleRefunds()

      expect(first.rejected).toBe(1)
      // Already `rejected`, so it is no longer in the `requested` scan at all.
      expect(second.rejected).toBe(0)
      expect((await refunds.getRefundRequest(UID, r.refundId))?.status).toBe('rejected')
    })

    it('leaves the purchase refundable again — a rejection is not a bar', async () => {
      configure({ refundAutoRejectDays: 7 })
      const purchaseId = await buy(100)
      const r = await request(purchaseId)
      await age(r.refundId, 10)

      const { autoRejectStaleRefunds } = await import('@/features/media-credits/services/reconciliation')
      await autoRejectStaleRefunds()

      // The credits were never taken, so the organizer may ask again.
      const second = await request(purchaseId)
      expect(second.status).toBe('requested')
    })
  })

})
