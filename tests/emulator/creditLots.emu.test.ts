// RD-MC-REFUND-V2-P1 · FIFO credit-lot attribution — REAL Firestore (emulator).
//
// `utils/creditLots.ts` already proves the arithmetic in tests/unit. What needs a real
// database is everything the pure allocator cannot see:
//
//   · that the lot debit and the wallet debit commit in ONE transaction
//   · that a drained lot actually leaves the sparse `lotSeq` query
//   · that a settlement reads lots BEFORE it writes (Firestore rejects the reverse)
//   · that concurrent sessions cannot double-spend one lot
//   · the invariant, measured against real documents:
//         Σ purchase.creditsRemaining + Σ grant.creditsRemaining == wallet.balance
//
// ═══ HOW CREDITS ARE SEEDED HERE ═════════════════════════════════════════════
// Through `completePurchase` and `createGrant` — the two real paths — NOT through
// `ledgerService.credit`, which the sibling suites use to seed. That shortcut moves a balance
// without writing a purchase or grant document, so it creates credits belonging to no lot and
// would make the invariant fail by construction. It has no production callers; seeding is its
// only use. This suite therefore avoids it deliberately.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const SECRET = 'rzp_lot_secret'
const UNIT_PAISE = 100

/** Real uploads are one transaction per photo, so a session of 60 is 60 round trips. */
const LOT_TIMEOUT_MS = 60_000

const rzp = vi.hoisted(() => ({
  orderSeq: 0,
  payments: new Map<string, Record<string, unknown>>(),
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID:     'rzp_test_stub',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      // The pid is in the id deliberately. Purchases are keyed by gatewayOrderId and a
      // long-running emulator keeps documents from earlier runs, whose organizer uid also
      // carries a pid — so a plain counter eventually resolves to another run's purchase and
      // fails as `tenant_mismatch`. Uniqueness here beats relying on cleanup.
      create: async (o: { amount: number; currency: string }) => ({
        id: `order_LOT_${process.pid}_${++rzp.orderSeq}`, amount: o.amount, currency: o.currency,
      }),
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

describeEmu('RD-MC-REFUND-V2-P1 · credit lot attribution', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let purchases: typeof import('@/features/media-credits/services/purchaseService')
  let grants: typeof import('@/features/media-credits/services/grantService')
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let sessions: typeof import('@/features/media-credits/services/sessionService')
  let settlement: typeof import('@/features/media-credits/services/sessionSettlementService')
  let lotRepo: typeof import('@/features/media-credits/repositories/lotRepo')
  let slots: typeof import('@/features/media-credits/utils/sessionSlots')
  let signPaymentVerification: typeof import('../mocks/razorpay')['signPaymentVerification']

  const UID = `emu-lots-${process.pid}`
  const EVT = { eventId: 'lot-evt', eventSlug: 'lot-evt', galleryId: 'lot-gal' }
  const ACTOR = 'lot-actor'
  const ADMIN = 'lot-admin'
  let seq = 0
  const nextId = () => `lot-${process.pid}-${++seq}`

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    purchases  = await import('@/features/media-credits/services/purchaseService')
    grants     = await import('@/features/media-credits/services/grantService')
    sessions   = await import('@/features/media-credits/services/sessionService')
    settlement = await import('@/features/media-credits/services/sessionSettlementService')
    lotRepo    = await import('@/features/media-credits/repositories/lotRepo')
    slots      = await import('@/features/media-credits/utils/sessionSlots')
    ;({ ledgerService, walletService } = await import('@/features/media-credits/services'))
    ;({ signPaymentVerification } = await import('../mocks/razorpay'))
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  async function reset(creditsPerPhoto = 1) {
    businessConfig.clearRuntimeOverrides()
    rzp.payments.clear()
    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    for (const col of [
      'mediaCreditLedger', 'mediaCreditPurchases', 'mediaCreditGrants',
      'mediaCreditReservations', 'mediaCreditSessions', 'mediaCreditReconciliations',
    ]) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()
    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto, creditUnitPricePaise: UNIT_PAISE,
      minCreditPurchase: 1, refundsEnabled: true, refundWindowDays: 30,
      refundServiceChargeMethod: 'percent', refundServiceChargePercent: 10,
      refundServiceChargeFixedPaise: 0, minRefundablePaise: 100,
    } as never)
  }

  beforeEach(async () => { await reset() })

  // ─── seeding through the real paths ────────────────────────────────────────

  /** A real purchase: intent → captured payment → verified grant. Returns its purchaseId. */
  async function buy(credits: number): Promise<string> {
    const intent = await purchases.createPurchaseIntent({
      organizerUid: UID, credits, actorUid: ACTOR,
    })
    const paymentId = `pay_for_${intent.gatewayOrderId}`
    rzp.payments.set(paymentId, {
      amount: intent.amountPaise, currency: 'INR',
      status: 'captured', order_id: intent.gatewayOrderId,
    })
    await purchases.completePurchase({
      organizerUid: UID, orderId: intent.gatewayOrderId, paymentId,
      signature: signPaymentVerification(intent.gatewayOrderId, paymentId, SECRET),
      actorUid: ACTOR,
    })
    return intent.purchaseId
  }

  async function grant(credits: number): Promise<string> {
    const grantId = nextId()
    await grants.createGrant({
      grantId, organizerUid: UID, credits, reason: 'goodwill',
      note: 'Seeding a grant lot for the attribution tests.', actorUid: ADMIN,
    })
    return grantId
  }

  /** Opens a session, uploads `uploads` of `slotCount` slots, seals and settles it. */
  async function uploadAndSettle(slotCount: number, uploads: number) {
    const sessionId = nextId()
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount, actorUid: ACTOR, ...EVT,
    })
    for (let i = 0; i < uploads; i++) {
      const assetId = slots.deriveAssetId(sessionId, i)
      await ledgerService.reserve({
        organizerUid: UID, assetId, credits: 1, actorUid: ACTOR,
        sessionId, slotIndex: i, ...EVT,
      })
      await ledgerService.consume({ organizerUid: UID, assetId, actorUid: ACTOR })
    }
    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: ACTOR })
    return settlement.settleSession(sessionId)
  }

  // ─── reading lots back ─────────────────────────────────────────────────────

  const remainingOf = async (col: string, id: string) =>
    (await adminDb.doc(`${col}/${id}`).get()).get('creditsRemaining') as number | undefined
  const lotSeqOf = async (col: string, id: string) =>
    (await adminDb.doc(`${col}/${id}`).get()).get('lotSeq') as number | undefined

  const purchaseRemaining = (id: string) => remainingOf('mediaCreditPurchases', id)
  const grantRemaining    = (id: string) => remainingOf('mediaCreditGrants', id)

  /** The invariant, measured against real documents. */
  async function assertInvariant() {
    const [sum, balance] = await Promise.all([
      lotRepo.sumOpenLots(UID),
      walletService.getBalance(UID).then(b => b.balance),
    ])
    expect(sum).toBe(balance)
  }

  // ═══ Lots open with the credits ════════════════════════════════════════════

  it('a granted PURCHASE opens a lot holding exactly what was bought', async () => {
    const p = await buy(500)
    expect(await purchaseRemaining(p)).toBe(500)
    expect(await lotSeqOf('mediaCreditPurchases', p)).toBeTypeOf('number')
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  it('a GRANT opens a lot too — otherwise granted credits belong to nothing', async () => {
    const g = await grant(300)
    expect(await grantRemaining(g)).toBe(300)
    expect(await lotSeqOf('mediaCreditGrants', g)).toBeTypeOf('number')
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  it('a purchase that never completes opens NO lot', async () => {
    const intent = await purchases.createPurchaseIntent({
      organizerUid: UID, credits: 40, actorUid: ACTOR,
    })
    // `pending`: the money has not been verified, so no credits exist to attribute.
    expect(await purchaseRemaining(intent.purchaseId)).toBeUndefined()
    expect(await lotSeqOf('mediaCreditPurchases', intent.purchaseId)).toBeUndefined()
    expect(await lotRepo.sumOpenLots(UID)).toBe(0)
  }, LOT_TIMEOUT_MS)

  // ═══ Consumption drains oldest-first ═══════════════════════════════════════

  it('SINGLE PURCHASE: an upload debits the lot it came from', async () => {
    const p = await buy(500)
    const r = await uploadAndSettle(50, 50)

    expect(r.creditsConsumed).toBe(50)
    expect(await purchaseRemaining(p)).toBe(450)
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  it("MULTIPLE PURCHASES: the brief's worked example, end to end", async () => {
    // 500 then 200. Upload 50 → the FIRST purchase pays. Upload 480 → the first is drained
    // and the second covers the remaining 30.
    const first  = await buy(500)
    const second = await buy(200)

    await uploadAndSettle(50, 50)
    expect(await purchaseRemaining(first)).toBe(450)
    expect(await purchaseRemaining(second)).toBe(200)   // untouched: FIFO never skips ahead
    await assertInvariant()

    await uploadAndSettle(480, 480)
    expect(await purchaseRemaining(first)).toBe(0)
    expect(await purchaseRemaining(second)).toBe(170)
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  it('DIFFERENT SIZES: a small lot drains inside one session and the next continues it', async () => {
    const small = await buy(10)
    const large = await buy(90)

    await uploadAndSettle(25, 25)
    expect(await purchaseRemaining(small)).toBe(0)
    expect(await purchaseRemaining(large)).toBe(75)
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  it('PURCHASES AND GRANTS share one timeline, oldest first', async () => {
    const g1 = await grant(20)         // oldest
    const p1 = await buy(30)
    const g2 = await grant(40)         // newest

    await uploadAndSettle(45, 45)      // 20 from g1, 25 from p1
    expect(await grantRemaining(g1)).toBe(0)
    expect(await purchaseRemaining(p1)).toBe(5)
    expect(await grantRemaining(g2)).toBe(40)
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  it('a DRAINED lot leaves the open-lot query entirely', async () => {
    const p = await buy(10)
    await buy(90)
    await uploadAndSettle(10, 10)

    // The ordering key is gone, so Firestore omits the document — this is what stops a
    // settlement from paging through every purchase the organizer has ever made.
    expect(await lotSeqOf('mediaCreditPurchases', p)).toBeUndefined()
    const open = await adminDb.runTransaction(tx => lotRepo.readOpenLotsInTx(tx, UID))
    expect(open.map(l => l.lotId)).not.toContain(p)
    expect(open).toHaveLength(1)
  }, LOT_TIMEOUT_MS)

  // ═══ The paths that must NOT move a lot ════════════════════════════════════

  it('a CANCELLED session (zero uploads) debits no lot', async () => {
    const p = await buy(100)
    const r = await uploadAndSettle(60, 0)

    expect(r.creditsConsumed).toBe(0)
    expect(r.creditsReleased).toBe(60)
    expect(await purchaseRemaining(p)).toBe(100)     // a hold is not a spend
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  it('PARTIAL uploads debit only what landed', async () => {
    const p = await buy(100)
    await uploadAndSettle(60, 37)
    expect(await purchaseRemaining(p)).toBe(63)
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  it('a RETRIED settlement debits the lot exactly once', async () => {
    const p = await buy(100)
    const sessionId = nextId()
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: 20, actorUid: ACTOR, ...EVT,
    })
    for (let i = 0; i < 20; i++) {
      const assetId = slots.deriveAssetId(sessionId, i)
      await ledgerService.reserve({
        organizerUid: UID, assetId, credits: 1, actorUid: ACTOR, sessionId, slotIndex: i, ...EVT,
      })
      await ledgerService.consume({ organizerUid: UID, assetId, actorUid: ACTOR })
    }
    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: ACTOR })

    await settlement.settleSession(sessionId)
    await settlement.settleSession(sessionId)      // replay
    await settlement.settleSession(sessionId)      // and again

    expect(await purchaseRemaining(p)).toBe(80)    // not 60, not 40
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  it('creditsPerPhoto > 1 debits the lot in CREDITS, not in photos', async () => {
    await reset(3)
    const p = await buy(100)
    const r = await uploadAndSettle(10, 10)

    expect(r.creditsConsumed).toBe(30)
    expect(await purchaseRemaining(p)).toBe(70)
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  // ═══ Concurrency ═══════════════════════════════════════════════════════════

  it('CONCURRENT settlements cannot spend one lot twice', async () => {
    const p = await buy(100)

    // Three sessions, each uploading 10, settled together. The wallet document serialises
    // them; the lot debit rides in the same transaction, so it must serialise identically.
    const ids: string[] = []
    for (let s = 0; s < 3; s++) {
      const sessionId = nextId()
      ids.push(sessionId)
      await sessions.openSession({
        sessionId, organizerUid: UID, slotCount: 10, actorUid: ACTOR, ...EVT,
      })
      for (let i = 0; i < 10; i++) {
        const assetId = slots.deriveAssetId(sessionId, i)
        await ledgerService.reserve({
          organizerUid: UID, assetId, credits: 1, actorUid: ACTOR, sessionId, slotIndex: i, ...EVT,
        })
        await ledgerService.consume({ organizerUid: UID, assetId, actorUid: ACTOR })
      }
      await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: ACTOR })
    }

    await Promise.all(ids.map(id => settlement.settleSession(id)))

    expect(await purchaseRemaining(p)).toBe(70)
    await assertInvariant()
  }, LOT_TIMEOUT_MS)

  // ═══ The invariant, under a mixed history ══════════════════════════════════

  it('INVARIANT holds across purchases, grants, partial and full consumption', async () => {
    await buy(120)
    await grant(30)
    await uploadAndSettle(50, 41)
    await buy(75)
    await assertInvariant()

    await uploadAndSettle(100, 100)
    await assertInvariant()

    await uploadAndSettle(30, 0)          // released, not spent
    await assertInvariant()

    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(120 + 30 + 75 - 41 - 100)
    expect(b.held).toBe(0)
  }, LOT_TIMEOUT_MS)

  it('an OPEN session makes Σ lots exceed AVAILABLE — which is why the invariant uses BALANCE', async () => {
    await buy(100)
    const sessionId = nextId()
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: 40, actorUid: ACTOR, ...EVT,
    })

    const b = await walletService.getBalance(UID)
    expect(b.held).toBe(40)
    expect(b.available).toBe(60)
    // A hold moves no credits, so no lot has been debited. Stated against `available` the
    // invariant would fail here for entirely correct behaviour.
    expect(await lotRepo.sumOpenLots(UID)).toBe(100)
    await assertInvariant()

    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: ACTOR })
    await settlement.settleSession(sessionId)
    await assertInvariant()
  }, LOT_TIMEOUT_MS)
})
