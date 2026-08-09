// RD-MS-PROD-VALIDATION-01 · The complete organizer journey — REAL Firestore (emulator).
//
// ═══ WHY THIS FILE EXISTS ═════════════════════════════════════════════════════
// Every module of Media Studio is tested in isolation: credits in creditRefunds/creditLots,
// bulk in bulkDelete, sessions in creditSettlement. Nothing tested them TOGETHER, so the
// claim "an organizer can buy credits, upload photos and get a partial refund" rested on
// each piece being right rather than on the whole ever having been run.
//
// This drives the real spine end to end, in order, against real Firestore:
//
//   purchase → wallet → session hold → upload → duplicate detection → gallery counters
//   → visibility → storage dashboard → refund request (hold) → approve → payout
//   → wallet, ledger, lots, purchase history and counters all re-verified
//
// ═══ WHAT IT CANNOT COVER ════════════════════════════════════════════════════
// The BROWSER half: canvas compression, EXIF orientation, the upload queue's resume, and
// every pixel. Those need a real browser and are called out as such in the sprint report
// rather than silently implied by a green test.
//
// Object storage is stubbed — R2 is an external paid service. Razorpay is stubbed for the
// same reason, using the same signing helper the other suites use, so the signature
// verification is real even though the gateway is not.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const SECRET = 'journey_secret'
const UNIT   = 100          // ₹1 per credit
const JOURNEY_TIMEOUT_MS = 120_000

const gw = vi.hoisted(() => ({
  orderSeq: 0,
  refundSeq: 0,
  payments: new Map<string, Record<string, unknown>>(),
  refunds:  [] as { id: string; notes: Record<string, unknown>; amount: number; status: string }[],
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      // The pid is in the id: a long-running emulator keeps documents across runs, and a
      // plain counter eventually resolves to another run's purchase (tenant_mismatch).
      create: async (o: { amount: number; currency: string }) => ({
        id: `order_JRN_${process.pid}_${++gw.orderSeq}`, amount: o.amount, currency: o.currency,
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
        const r = {
          id: `rfnd_JRN_${++gw.refundSeq}`, notes: { ...params.notes, paymentId },
          amount: params.amount, status: 'processed',
        }
        gw.refunds.push(r)
        return r
      },
    },
  },
}))

describeEmu('RD-MS-PROD-VALIDATION-01 · the organizer journey, end to end', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let purchases:  typeof import('@/features/media-credits/services/purchaseService')
  let refunds:    typeof import('@/features/media-credits/services/refundService')
  let sessions:   typeof import('@/features/media-credits/services/sessionService')
  let settlement: typeof import('@/features/media-credits/services/sessionSettlementService')
  let walletService:  typeof import('@/features/media-credits/services')['walletService']
  let ledgerService:  typeof import('@/features/media-credits/services')['ledgerService']
  let slots:      typeof import('@/features/media-credits/utils/sessionSlots')
  let assetRepo:  typeof import('@/features/media-studio/repositories/assetRepo')
  let lotRepo:    typeof import('@/features/media-credits/repositories/lotRepo')
  let settingsRepo: typeof import('@/features/media-studio/repositories/settingsRepo')
  let duplicates: typeof import('@/features/media-studio/utils/duplicates')
  let sign: (o: string, p: string, s: string) => string

  const UID     = `emu-journey-${process.pid}`
  const ACTOR   = 'journey-actor'
  const ADMIN   = 'journey-admin'
  const EVENT   = 'evt_journey'
  const SLUG    = 'evt-journey'
  const GALLERY = `gal_journey_${process.pid}`

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    purchases  = await import('@/features/media-credits/services/purchaseService')
    refunds    = await import('@/features/media-credits/services/refundService')
    sessions   = await import('@/features/media-credits/services/sessionService')
    settlement = await import('@/features/media-credits/services/sessionSettlementService')
    slots      = await import('@/features/media-credits/utils/sessionSlots')
    assetRepo  = await import('@/features/media-studio/repositories/assetRepo')
    lotRepo    = await import('@/features/media-credits/repositories/lotRepo')
    settingsRepo = await import('@/features/media-studio/repositories/settingsRepo')
    duplicates = await import('@/features/media-studio/utils/duplicates')
    ;({ walletService, ledgerService } = await import('@/features/media-credits/services'))
    ;({ signPaymentVerification: sign } = await import('../mocks/razorpay'))
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  async function reset() {
    businessConfig.clearRuntimeOverrides()
    gw.payments.clear(); gw.refunds = []; gw.refundSeq = 0

    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    batch.delete(adminDb.doc(`mediaSettings/${UID}`))
    batch.delete(adminDb.doc(`mediaGalleries/${GALLERY}`))
    for (const col of [
      'mediaCreditLedger', 'mediaCreditPurchases', 'mediaCreditGrants', 'mediaCreditRefunds',
      'mediaCreditReservations', 'mediaCreditSessions', 'mediaCreditReconciliations',
      'mediaAssets',
    ]) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()

    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: UNIT,
      minCreditPurchase: 1, refundsEnabled: true, refundWindowDays: 30,
      refundServiceChargeMethod: 'percent', refundServiceChargePercent: 10,
      refundServiceChargeFixedPaise: 0, minRefundablePaise: 100,
      maxPhotosPerEvent: null,
    } as never)

    await adminDb.doc(`mediaGalleries/${GALLERY}`).set({
      galleryId: GALLERY, organizerUid: UID, eventId: EVENT, eventSlug: SLUG,
      schemaVersion: 1, name: 'Journey', slug: 'journey', preset: 'custom', description: null,
      assetCount: 0, albumCount: 0, bytesStored: 0, bytesOriginalSource: 0,
      coverAssetId: null, createdBy: UID, createdAt: new Date(), updatedAt: new Date(),
    })
  }

  beforeEach(async () => { await reset() })

  /** A real purchase: intent → captured payment → verified grant. */
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

  /**
   * Uploads `count` photos through the REAL path: session hold → reserve → consume →
   * registerAsset (which moves the gallery counters in its own transaction) → seal → settle.
   *
   * `registerAsset` is called directly rather than through the HTTP route because the route's
   * only extra work is HEAD-ing the bucket, and the bucket is not real here. Everything
   * financial and every counter is genuine.
   */
  async function upload(count: number, opts: { visibility?: 'PUBLIC' | 'PRIVATE'; from?: number } = {}) {
    const from = opts.from ?? 0
    const sessionId = `jrn-${process.pid}-${from}-${count}`
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: count, actorUid: ACTOR,
      eventId: EVENT, eventSlug: SLUG, galleryId: GALLERY,
    })
    for (let i = 0; i < count; i++) {
      const assetId = slots.deriveAssetId(sessionId, i)
      await ledgerService.reserve({
        organizerUid: UID, assetId, credits: 1, actorUid: ACTOR, sessionId, slotIndex: i,
        eventId: EVENT, eventSlug: SLUG, galleryId: GALLERY,
      })
      await assetRepo.registerAsset({
        assetId, organizerUid: UID, eventId: EVENT, eventSlug: SLUG,
        galleryId: GALLERY, albumId: null,
        checksum: String(from + i).padStart(64, '0'),
        originalFilename: `IMG_${from + i}.jpg`,
        renditions: {
          original:  { path: `p/${assetId}/o.jpg`, size: 900, mimeType: 'image/jpeg', width: 4000, height: 3000 },
          thumbnail: { path: `p/${assetId}/t.jpg`, size: 100, mimeType: 'image/jpeg', width: 400,  height: 300 },
        },
        bytesStored: 1_000, bytesOriginalSource: 4_000,
        mimeType: 'image/jpeg', width: 4000, height: 3000,
        profileId: 'balanced',
        visibility: opts.visibility ?? 'PUBLIC',
        uploadedBy: ACTOR,
      })
      await ledgerService.consume({ organizerUid: UID, assetId, actorUid: ACTOR })
    }
    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: ACTOR })
    return settlement.settleSession(sessionId)
  }

  /** THE invariants. Re-checked after every step of the journey, not only at the end. */
  async function assertInvariants(label: string) {
    const [wallet, lots, ledgerSnap] = await Promise.all([
      walletService.getBalance(UID),
      lotRepo.sumOpenLots(UID),
      adminDb.collection('mediaCreditLedger').where('organizerUid', '==', UID).get(),
    ])
    const fromLedger = ledgerSnap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)

    // I1 · the ledger is truth, the wallet is a cache.
    expect(`${label}: balance==Σdeltas`).toBe(`${label}: balance==Σdeltas`)
    expect(wallet.balance).toBe(fromLedger)
    // Σ lots == balance (RD-MC-REFUND-V2-P1).
    expect(lots).toBe(wallet.balance)
    // I6 · available never exceeds balance and is never negative.
    expect(wallet.available).toBeLessThanOrEqual(wallet.balance)
    expect(wallet.available).toBeGreaterThanOrEqual(0)

    // I5 · the refund hold equals what pending refunds claim.
    const refundSnap = await adminDb.collection('mediaCreditRefunds')
      .where('organizerUid', '==', UID).get()
    const pendingHeld = refundSnap.docs
      .filter(d => d.get('status') === 'requested')
      .reduce((n, d) => n + (d.get('credits') as number), 0)
    expect(wallet.refundHeld).toBe(pendingHeld)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // THE JOURNEY
  // ═══════════════════════════════════════════════════════════════════════════

  it('buy → upload → dedupe → gallery → refund → approve, with invariants at every step', async () => {
    // ── 1. Purchase credits ────────────────────────────────────────────────
    const purchaseId = await buy(500)
    let w = await walletService.getBalance(UID)
    expect(w.balance).toBe(500)
    expect(w.available).toBe(500)
    await assertInvariants('after purchase')

    // The purchase is a LOT holding exactly what was bought.
    expect((await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get()).get('creditsRemaining'))
      .toBe(500)

    // ── 2. Upload 100 photos ───────────────────────────────────────────────
    const settled = await upload(100)
    expect(settled.creditsConsumed).toBe(100)

    w = await walletService.getBalance(UID)
    expect(w.balance).toBe(400)
    expect(w.held).toBe(0)                       // the session hold resolved
    await assertInvariants('after upload')

    // FIFO drained the purchase lot, not some other pool.
    expect((await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get()).get('creditsRemaining'))
      .toBe(400)

    // ── 3. Gallery counters moved transactionally with the assets ──────────
    const gallery = await adminDb.doc(`mediaGalleries/${GALLERY}`).get()
    expect(gallery.get('assetCount')).toBe(100)
    expect(gallery.get('bytesStored')).toBe(100_000)
    expect(gallery.get('bytesOriginalSource')).toBe(400_000)

    // ── 4. Duplicate detection sees the real checksums ─────────────────────
    const existing = await assetRepo.findByChecksums(UID, EVENT, [
      String(0).padStart(64, '0'),      // uploaded above
      String(999).padStart(64, '0'),    // never uploaded
    ])
    expect(existing).toHaveLength(1)
    expect(existing[0].originalFilename).toBe('IMG_0.jpg')
    // And the PURE classifier agrees with what the repository found.
    const scan = duplicates.scanForDuplicates(
      [{ itemId: 'a', checksum: String(0).padStart(64, '0') },
       { itemId: 'b', checksum: String(999).padStart(64, '0') }],
      existing,
    )
    expect(scan.matches).toHaveLength(1)
    expect(scan.fresh).toHaveLength(1)
    expect(scan.matches[0].existing.originalFilename).toBe('IMG_0.jpg')

    // ── 5. Storage dashboard reads COUNTERS, not a scan ────────────────────
    const usage = await settingsRepo.computeUsage(UID, EVENT)
    expect(usage.photoCount).toBe(100)
    expect(usage.bytesStored).toBe(100_000)
    expect(usage.bytesSaved).toBe(300_000)
    expect(usage.savingsPercent).toBe(75)

    // ── 6. Partial refund of the UNUSED credits ────────────────────────────
    const r = await refunds.createRefundRequest({
      organizerUid: UID, purchaseId, reason: 'over-bought for this race', requestedBy: ACTOR,
    })
    expect(r.credits).toBe(400)                  // the remainder, not the purchase
    expect(r.refundBasePaise).toBe(40_000)       // 400 × ₹1
    expect(r.refundAmountPaise).toBe(36_000)     // less 10%

    // The hold: balance unchanged, availability gone, lot untouched.
    w = await walletService.getBalance(UID)
    expect(w.balance).toBe(400)
    expect(w.refundHeld).toBe(400)
    expect(w.available).toBe(0)
    await assertInvariants('after refund request')

    // ── 7. Uploads cannot spend the reserved credits ───────────────────────
    await expect(sessions.openSession({
      sessionId: `jrn-blocked-${process.pid}`, organizerUid: UID, slotCount: 1,
      actorUid: ACTOR, eventId: EVENT, eventSlug: SLUG, galleryId: GALLERY,
    })).rejects.toThrow(/reserved by a pending refund/i)

    // ── 8. Approve, and the money actually leaves ──────────────────────────
    const approved = await refunds.approveRefund({ refundId: r.refundId, adminUid: ADMIN })
    expect(approved.settled).toBe(true)
    expect(gw.refunds).toHaveLength(1)
    expect(gw.refunds[0].amount).toBe(36_000)    // the frozen amount, at the gateway

    w = await walletService.getBalance(UID)
    expect(w.balance).toBe(0)
    expect(w.refundHeld).toBe(0)                 // released, not stranded
    await assertInvariants('after approval')

    // ── 9. Purchase history tells the whole story ──────────────────────────
    const stored = await adminDb.doc(`mediaCreditPurchases/${purchaseId}`).get()
    expect(stored.get('status')).toBe('granted')     // terminal, never rewritten
    expect(stored.get('credits')).toBe(500)          // what was bought, unchanged
    expect(stored.get('creditsRemaining')).toBe(0)   // 100 used + 400 refunded
    expect(stored.get('lotSeq')).toBeUndefined()     // drained ⇒ out of the FIFO query

    // ── 10. The photos are untouched by any of it ──────────────────────────
    expect((await adminDb.doc(`mediaGalleries/${GALLERY}`).get()).get('assetCount')).toBe(100)
    const page = await assetRepo.listAssets({ organizerUid: UID, galleryId: GALLERY, limit: 200 })
    expect(page.assets).toHaveLength(100)
  }, JOURNEY_TIMEOUT_MS)

  it('the credit ceiling refuses an upload the wallet cannot fund', async () => {
    await buy(10)
    // 11 slots against 10 credits. The exactness gate is the ONLY balance check on the
    // upload path, so if it does not hold here nothing downstream would catch it.
    await expect(sessions.openSession({
      sessionId: `jrn-over-${process.pid}`, organizerUid: UID, slotCount: 11,
      actorUid: ACTOR, eventId: EVENT, eventSlug: SLUG, galleryId: GALLERY,
    })).rejects.toThrow()
    await assertInvariants('after refused session')
  }, JOURNEY_TIMEOUT_MS)

  it('a cancelled upload returns every credit and leaves no photo', async () => {
    await buy(50)
    const sessionId = `jrn-cancel-${process.pid}`
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: 30, actorUid: ACTOR,
      eventId: EVENT, eventSlug: SLUG, galleryId: GALLERY,
    })
    expect((await walletService.getBalance(UID)).available).toBe(20)

    // The organizer cancels before uploading anything (MC-10.6's early release).
    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: ACTOR })
    const out = await settlement.settleSession(sessionId)

    expect(out.creditsConsumed).toBe(0)
    expect(out.creditsReleased).toBe(30)
    const w = await walletService.getBalance(UID)
    expect(w.balance).toBe(50)                   // nothing was charged
    expect(w.available).toBe(50)                 // and the hold came back
    expect((await adminDb.doc(`mediaGalleries/${GALLERY}`).get()).get('assetCount')).toBe(0)
    await assertInvariants('after cancelled upload')
  }, JOURNEY_TIMEOUT_MS)

  it('visibility is per photo, and the public projection honours it', async () => {
    await buy(20)
    await upload(5, { visibility: 'PUBLIC' })
    await upload(5, { visibility: 'PRIVATE', from: 100 })

    const publicOnly = await assetRepo.listAssets({
      organizerUid: UID, galleryId: GALLERY, visibility: 'PUBLIC', limit: 100,
    })
    expect(publicOnly.assets).toHaveLength(5)
    expect(publicOnly.assets.every(a => a.visibility === 'PUBLIC')).toBe(true)

    // RD-MS-CLOSURE-01 · the filter runs IN THE QUERY, so the page size is honest.
    const privateOnly = await assetRepo.listAssets({
      organizerUid: UID, galleryId: GALLERY, visibility: 'PRIVATE', limit: 100,
    })
    expect(privateOnly.assets).toHaveLength(5)

    // And the public counter — what the public gallery pages on — sees only the public five.
    expect(await assetRepo.countPublicAssets(UID, GALLERY, null)).toBe(5)
  }, JOURNEY_TIMEOUT_MS)

  it('sort resolves both directions on the same index', async () => {
    await buy(10)
    await upload(5)
    const newest = await assetRepo.listAssets({
      organizerUid: UID, galleryId: GALLERY, sort: 'newest', limit: 100,
    })
    const oldest = await assetRepo.listAssets({
      organizerUid: UID, galleryId: GALLERY, sort: 'oldest', limit: 100,
    })
    expect(newest.assets).toHaveLength(5)
    expect(oldest.assets).toHaveLength(5)
    // Same set, reversed. If the direction flip were unserved this would throw, not reorder.
    expect(oldest.assets.map(a => a.assetId).reverse())
      .toEqual(newest.assets.map(a => a.assetId))
  }, JOURNEY_TIMEOUT_MS)

  it('the download counter increments atomically and only when asked', async () => {
    await buy(5)
    await upload(1)
    const page = await assetRepo.listAssets({ organizerUid: UID, galleryId: GALLERY, limit: 10 })
    const assetId = page.assets[0].assetId
    // The DOCUMENT has no field until the first download — that is the point of the optional
    // field and the `?? 0` backfill. The serialized VIEW is where it becomes a number, so
    // that is what the drawer renders and what is asserted here.
    expect(page.assets[0].downloadCount).toBeUndefined()
    expect(assetRepo.serializeAsset(page.assets[0], null).downloadCount).toBe(0)

    // Concurrent downloads of one popular finisher photo. `FieldValue.increment` is what
    // stops a read-modify-write losing counts here.
    await Promise.all(Array.from({ length: 10 }, () => assetRepo.recordDownload(assetId)))

    const after = await adminDb.doc(`mediaAssets/${assetId}`).get()
    expect(after.get('downloadCount')).toBe(10)

    // A photo that was never downloaded stays uncounted — the counter is not a side effect
    // of listing, and listing ten times must not manufacture demand.
    await upload(1, { from: 500 })
    const page2 = await assetRepo.listAssets({ organizerUid: UID, galleryId: GALLERY, limit: 10 })
    const counts = page2.assets.map(a => a.downloadCount ?? 0).sort((x, y) => x - y)
    expect(counts).toEqual([0, 10])
  }, JOURNEY_TIMEOUT_MS)
})
