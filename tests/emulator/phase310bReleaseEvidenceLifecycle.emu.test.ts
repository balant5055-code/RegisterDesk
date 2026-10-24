// Phase 3.10B — release-attempt evidence: concurrency, interruption, reference errors and the READ-ONLY lifecycle
// classification of open records, through the REAL release job on REAL Firestore (synthetic emulator data only).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000

const fx = vi.hoisted(() => ({ failPlainEvidenceRead: false }))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 3.10B · release-attempt evidence lifecycle', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let att: typeof import('@/lib/settlements/releaseAttempts')
  let stuck: typeof import('@/lib/reconciliation/stuckReleases')
  let n = 0

  async function payment(uid: string, net: number) {
    const id = `p310l-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: 'e', entityType: 'event', sourceId: id, sourceType: 'registration',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - 40 * DAY) })
    return `ptx_${id}`
  }
  const setPending = (uid: string, v: number) => db.doc(`organizerRevenueWallets/${uid}`).update({ pendingPaise: v })
  const attempt = async (id: string) => (await db.doc(`settlementReleaseAttempts/${id}`).get()).data() ?? null
  const releasesOf = async (id: string) => (await db.collection('settlementReleases').where('transactionId', '==', id).get()).docs.map(d => d.data())
  const stateOf = async (id: string) => (await stuck.reportOpenReleaseEvidence()).entries.find(e => e.ptxId === id)?.state ?? null

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    att = await import('@/lib/settlements/releaseAttempts')
    stuck = await import('@/lib/reconciliation/stuckReleases')
  }, T)
  beforeEach(() => {
    vi.restoreAllMocks()
    fx.failPlainEvidenceRead = false
    const proto = FS.DocumentReference.prototype as unknown as { get: (...a: unknown[]) => unknown }
    const origGet = proto.get
    vi.spyOn(proto, 'get').mockImplementation(function (this: { path: string }, ...a: unknown[]) {
      if (fx.failPlainEvidenceRead && this.path.startsWith('settlementReleaseAttempts/')) return Promise.reject(new Error('4 DEADLINE_EXCEEDED: simulated'))
      return origGet.apply(this, a)
    })
  })

  it('1 · concurrent release runs: a coverable row releases EXACTLY once (amount and buckets exact) and its record resolves; a refused row counts each real run', async () => {
    const uid = `p310l-org-${P}-1`
    const id = await payment(uid, 2_000)
    await setPending(uid, 0)
    await release({ limit: 500 })                                                       // refused ⇒ open record
    await setPending(uid, 2_000)
    const runs = await Promise.all([release({ limit: 500 }), release({ limit: 500 })])
    expect(runs.reduce((s, r) => s + r.processed, 0)).toBeGreaterThanOrEqual(1)
    expect(await releasesOf(id)).toEqual([expect.objectContaining({ amountPaise: 2_000, creditedAvailablePaise: 2_000 })])   // once
    expect((await db.doc(`organizerRevenueWallets/${uid}`).get()).data()).toMatchObject({ pendingPaise: 0, availablePaise: 2_000 })
    expect(await attempt(id)).toMatchObject({ status: 'resolved', attempts: 1 })        // never left open on a released row
    // a row refused by two concurrent runs: two real attempts
    const uid2 = `p310l-org-${P}-1b`
    const short = await payment(uid2, 9_000)
    await setPending(uid2, 1)
    await Promise.all([release({ limit: 500 }), release({ limit: 500 })])
    expect(await attempt(short)).toMatchObject({ status: 'open', attempts: 2, codeCounts: { INSUFFICIENT: 2 } })
    await db.doc(`platformTransactions/${short}`).delete()                              // tidy
  }, T)

  it('2 · interrupted between a release and its evidence check: the release stands exactly; the record is left open and reported as released_unresolved (never as a refusal)', async () => {
    const uid = `p310l-org-${P}-2`
    const id = await payment(uid, 3_000)
    await setPending(uid, 0)
    await release({ limit: 500 })
    await setPending(uid, 3_000)
    fx.failPlainEvidenceRead = true                                                     // the post-commit check fails (as if the run died there)
    const r = await release({ limit: 500 })
    fx.failPlainEvidenceRead = false
    expect(r.failures).toBe(0)                                                          // the evidence failure is not a release failure
    expect(await releasesOf(id)).toEqual([expect.objectContaining({ amountPaise: 3_000 })])
    expect((await db.doc(`platformTransactions/${id}`).get()).get('releaseStatus')).toBe('released')
    expect(await attempt(id)).toMatchObject({ status: 'open', attempts: 1 })
    expect(await stateOf(id)).toBe('released_unresolved')
    expect((await stuck.reportStuckReleases()).entries.find(e => e.ptxId === id)).toBeUndefined()   // a released row is never "stuck"
  }, T)

  it('3 · reference-creation errors never escape: an invalid id is unrecorded, not thrown', async () => {
    await expect(att.recordReleaseFailure({ ptxId: 'bad/id', organizerUid: null, runId: 'r', message: 'INSUFFICIENT:0:1' })).resolves.toBe('unrecorded')
    await expect(att.resolveReleaseAttempt({ ptxId: 'bad/id', releaseId: 'x' })).resolves.toBe('unrecorded')
    await expect(att.recordReleaseFailure({ ptxId: '', organizerUid: null, runId: 'r', message: 'INSUFFICIENT:0:1' })).resolves.toBe('unrecorded')
  }, T)

  it('4 · lifecycle of OPEN records is CLASSIFIED, never closed: held, reversed, deleted, re-eligible', async () => {
    const uid = `p310l-org-${P}-4`
    const [held, reversed, deleted, back] = [await payment(uid, 1_000), await payment(uid, 1_100), await payment(uid, 1_200), await payment(uid, 1_300)]
    await setPending(uid, 0)
    await release({ limit: 500 })                                                       // four refusals ⇒ four open records
    for (const id of [held, reversed, deleted, back]) expect(await attempt(id)).toMatchObject({ status: 'open' })
    await db.doc(`platformTransactions/${held}`).update({ releaseStatus: 'held', releaseHold: { reason: 'refund_review', refundIds: [], heldAt: new Date() } })
    await setPending(uid, 1_100); await reverse(reversed)                              // a refund reversal of that row
    await db.doc(`platformTransactions/${deleted}`).delete()
    await db.doc(`platformTransactions/${back}`).update({ releaseStatus: 'held', releaseHold: { reason: 'refund_review', refundIds: [], heldAt: new Date() } })
    await db.doc(`platformTransactions/${back}`).update({ releaseStatus: 'pending', releaseHold: FS.FieldValue.delete() })   // the hold lifted: eligible again
    expect(await stateOf(held)).toBe('row_held')
    expect(await stateOf(reversed)).toBe('row_reversed')
    expect(await stateOf(deleted)).toBe('row_deleted')
    expect(await stateOf(back)).toBe('active')
    for (const id of [held, reversed, deleted, back]) expect(await attempt(id)).toMatchObject({ status: 'open' })   // nothing was closed
    // eligibility is unchanged by the evidence: a row still 'pending' but carrying a refund hold is NEVER released,
    // even with pending enough to cover it (the release transaction's own re-check)
    const pendingHeld = await payment(`${uid}-ph`, 700)
    await db.doc(`platformTransactions/${pendingHeld}`).update({ releaseHold: { reason: 'refund_review', refundIds: [], heldAt: new Date() } })
    const r = await release({ limit: 500 })
    expect(r.held ?? 0).toBeGreaterThanOrEqual(1)
    expect((await db.doc(`platformTransactions/${pendingHeld}`).get()).get('releaseStatus')).toBe('pending')
    expect(await releasesOf(pendingHeld)).toEqual([])
    expect(await attempt(pendingHeld)).toBeNull()                                       // a hold is not a refusal: no evidence
    // tidy: no refusable rows left for later suites
    for (const id of [held, back, pendingHeld]) await db.doc(`platformTransactions/${id}`).delete()
  }, T)
})
