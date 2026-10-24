// RD-RELEASE-DIAG-01 — the production shape behind `release-funds` reporting {"processed":0,"failures":2} every
// day, reproduced on the REAL release job + REAL stuck-release report (synthetic emulator data only):
//
//   one organizer, four ledger rows, all releaseStatus 'pending':
//     • two COMPLETED rows (25,000 + 50,000 paise) — eligible (past the hold)
//     • two rows REFUNDED before release (50,000 each) — reversed in place through the real reversal path
//   and the wallet's pendingPaise below every eligible net (24,500).
//
// Proven here: the two failures are exactly the two COMPLETED rows (INSUFFICIENT — pending cannot cover the net),
// the refunded rows are never selected, never released and never recorded as failures, nothing is paid out, and
// the daily stuck-release report (→ the critical `settlement_release_stuck` health alert) confirms both.
// How the wallet's pending fell below its rows is NOT asserted: the pending value is set directly.

import { describe, it, expect, beforeAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000

vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('release-funds · two eligible rows refused for insufficient pending; refunded rows excluded', () => {
  let db: import('firebase-admin/firestore').Firestore
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let stuck: typeof import('@/lib/reconciliation/stuckReleases')
  let n = 0

  async function payment(uid: string, net: number, daysAgo: number) {
    const id = `rdiag-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: 'e', entityType: 'event', sourceId: id, sourceType: 'registration',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - daysAgo * DAY) })
    return `ptx_${id}`
  }
  const ptx = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data()!
  const wallet = async (uid: string) => (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!
  const attempt = async (id: string) => (await db.doc(`settlementReleaseAttempts/${id}`).get()).data() ?? null
  const releasesOf = async (id: string) => (await db.collection('settlementReleases').where('transactionId', '==', id).get()).size

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    stuck = await import('@/lib/reconciliation/stuckReleases')
  }, T)

  it('the two COMPLETED rows are refused (INSUFFICIENT) every run; the two REFUNDED rows are never selected, released or counted; nothing moves', async () => {
    const uid = `rdiag-org-${P}`
    const completedA = await payment(uid, 25_000, 64)   // like ptx_454f… (₹250)
    const refundedA  = await payment(uid, 50_000, 61)
    const completedB = await payment(uid, 50_000, 60)   // like ptx_ad02… (₹500)
    const refundedB  = await payment(uid, 50_000, 59)
    // refunded BEFORE release, through the real reversal: status → refunded, releaseStatus stays 'pending'
    for (const id of [refundedA, refundedB]) expect(await reverse(id)).toMatchObject({ reversed: true, debited: 50_000, insolvent: false })
    expect(await wallet(uid)).toMatchObject({ pendingPaise: 75_000 })        // = the two completed rows' nets
    expect(await ptx(refundedA)).toMatchObject({ status: 'refunded', releaseStatus: 'pending' })

    // the production state: pending below every eligible net (cause not asserted here)
    await db.doc(`organizerRevenueWallets/${uid}`).update({ pendingPaise: 24_500 })
    const w0 = await wallet(uid)

    for (let run = 1; run <= 2; run++) {
      await release({ limit: 500 })
      expect(await attempt(completedA)).toMatchObject({ attempts: run, lastCode: 'INSUFFICIENT', lastOutcome: 'refused', lastDetail: { pendingPaise: 24_500, amountPaise: 25_000 } })
      expect(await attempt(completedB)).toMatchObject({ attempts: run, lastCode: 'INSUFFICIENT', lastOutcome: 'refused', lastDetail: { pendingPaise: 24_500, amountPaise: 50_000 } })
    }
    // refunded rows: never selected ⇒ no failure evidence, untouched, never released
    for (const id of [refundedA, refundedB]) {
      expect(await attempt(id)).toBeNull()
      expect(await ptx(id)).toMatchObject({ status: 'refunded', releaseStatus: 'pending' })
    }
    // nothing paid out: no release record for any row, completed rows still pending, wallet unchanged
    for (const id of [completedA, completedB, refundedA, refundedB]) expect(await releasesOf(id)).toBe(0)
    for (const id of [completedA, completedB]) expect(await ptx(id)).toMatchObject({ status: 'completed', releaseStatus: 'pending' })
    expect(await wallet(uid)).toMatchObject({ pendingPaise: w0.pendingPaise, availablePaise: w0.availablePaise })

    // the daily stuck-release report confirms BOTH (→ critical settlement_release_stuck); the refunded rows are not in it
    const report = await stuck.reconcileStuckReleases()
    const mine = report.mismatches.filter(m => [completedA, completedB, refundedA, refundedB].includes(m.entityId))
    expect(mine.map(m => m.entityId).sort()).toEqual([completedA, completedB].sort())
    expect(mine.every(m => m.field === 'stuckRelease:repeated_refusal')).toBe(true)
    expect(report.unverifiable.some(u => [refundedA, refundedB].includes(u.entityId))).toBe(false)

    // tidy: a permanently refused fixture would be refused (and counted) by every later suite's release run, and its
    // open attempt record (pointing at a deleted row) would stay in every later evidence sweep's page
    for (const id of [completedA, completedB]) {
      await db.doc(`platformTransactions/${id}`).delete()
      await db.doc(`settlementReleaseAttempts/${id}`).delete()
    }
  }, T)
})
