// Phase 3.9 — the reconciliation REPORTING CONTRACT, on REAL Firestore (synthetic emulator data only).
// Read-only checks; the only writes are fixtures, reports, run summaries and scan cursors.
//   1 · cursors: a full cycle visits every row exactly once; reset / stale / past-the-end cursors are safe;
//       an interrupted run reports its unchecked remainder and does not advance
//   2 · early stops in the Phase 3.6A donation pass and the wallet pass are explicit, never clean
//   3 · one failing pass no longer discards the others; the run summary records exact counts and completeness
//   4 · a flood of reports cannot hide an urgent finding from operations health; repeated runs append

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 300_000
const P = process.pid

const probe = vi.hoisted(() => ({ failReleasePass: false }))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))
vi.mock('@/lib/reconciliation/stuckReleases', async orig => {
  const real = await orig<typeof import('@/lib/reconciliation/stuckReleases')>()
  return { ...real, reconcileStuckReleases: async () => { if (probe.failReleasePass) throw new Error('simulated pass failure'); return real.reconcileStuckReleases() } }
})

describeEmu('Phase 3.9 · reconciliation reporting contract', () => {
  let db: import('firebase-admin/firestore').Firestore
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let rows: typeof import('@/lib/reconciliation/donationLedgerRows')
  let dons: typeof import('@/lib/reconciliation/donationRefunds')
  let wallets: typeof import('@/lib/reconciliation/wallets')
  let global: typeof import('@/lib/reconciliation')
  let health: typeof import('@/lib/operations/healthMetrics').getOperationsHealth
  const junk: string[] = []

  const cursor = async (key: string) => ((await db.doc(`reconciliationCursors/${key}`).get()).data() ?? {}).after ?? null
  const setCursor = (key: string, after: string | null) => db.doc(`reconciliationCursors/${key}`).set({ after }, { merge: true })
  async function payment(uid: string, net: number, kind: 'registration' | 'donation', id: string) {
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed', organizerUid: uid,
      entityId: 'e', entityType: kind === 'donation' ? 'campaign' : 'event', sourceId: id, sourceType: kind, payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net,
      platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays',
      planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    if (kind === 'donation') await db.doc(`donations/${id}`).set({ amountPaise: net, organizerUid: uid, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, campaignSlug: 'c' })
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    credit = (await import('@/lib/firebase/firestore/platformTransactions')).recordPlatformTransactionAndCredit
    rows = await import('@/lib/reconciliation/donationLedgerRows')
    dons = await import('@/lib/reconciliation/donationRefunds')
    wallets = await import('@/lib/reconciliation/wallets')
    global = await import('@/lib/reconciliation')
    health = (await import('@/lib/operations/healthMetrics')).getOperationsHealth
  }, T)
  afterAll(async () => {
    if (!db) return
    for (let i = 0; i < junk.length; i += 400) {
      const b = db.batch(); for (const id of junk.slice(i, i + 400)) b.delete(db.doc(`reconciliationReports/${id}`)); await b.commit()
    }
  }, T)

  it('1 · cursors: one full cycle reports every row exactly once; reset, stale and past-the-end cursors are safe; an interrupted run does not advance', async () => {
    const key = 'recon:donation-ledger-rows'
    const uid = `p39-org-${P}`
    const donationId = `p39don-${P}`
    await payment(uid, 1_000, 'donation', donationId)
    const ids = Array.from({ length: 7 }, (_, i) => `ptx_refund_rfnd_p39_${P}_${i}`)
    for (const id of ids) await db.doc(`platformTransactions/${id}`).set({ organizerUid: uid, parentTransactionId: `ptx_${donationId}`, status: 'refunded', sourceType: 'donation', grossAmountPaise: -1, netSettlementPaise: -1 })
    // reset: no cursor ⇒ from the beginning
    await db.doc(`reconciliationCursors/${key}`).delete()
    const seen = new Map<string, number>()
    let wrapped = false
    for (let run = 0; run < 2_000 && !wrapped; run++) {
      const before = await cursor(key)
      const r = await rows.reconcileDonationLedgerRows({ limit: 2 })
      expect(r.unverifiable.filter(u => u.check.startsWith('scan:'))).toEqual([])    // every page finished
      for (const m of r.mismatches) for (const id of ids) if (m.field.endsWith(`:${id}`)) seen.set(id, (seen.get(id) ?? 0) + 1)
      wrapped = before !== null && (await cursor(key)) === null
    }
    expect(wrapped).toBe(true)
    expect(ids.map(id => seen.get(id) ?? 0)).toEqual(Array(7).fill(1))                 // no skip, no duplicate
    // stale cursor: the id it names no longer exists — the scan continues after it, without error
    await db.doc(`platformTransactions/${ids[2]}`).delete()
    await setCursor(key, ids[2])
    const afterStale = await rows.reconcileDonationLedgerRows({ limit: 1 })
    expect(afterStale.mismatches.map(m => m.field)).toEqual([`ledgerRowOnInactiveDonation:${ids[3]}`])
    // past the end: an empty page wraps the cursor to the start
    await setCursor(key, '')
    const empty = await rows.reconcileDonationLedgerRows({ limit: 5 })
    expect(empty).toMatchObject({ scanned: 0, mismatches: [], unverifiable: [] })
    expect(await cursor(key)).toBeNull()
    // interrupted: nothing checked ⇒ an explicit unverifiable, and the cursor does not move
    await setCursor(key, ids[0])
    const cut = await rows.reconcileDonationLedgerRows({ limit: 5, budgetMs: -1 })
    expect(cut.unverifiable).toEqual([expect.objectContaining({ check: `scan:${key}`, reason: `budget_exhausted_after:${ids[0]}` })])
    expect(await cursor(key)).toBe(ids[0])
  }, T)

  it('2 · an early stop in the Phase 3.6A donation pass and in the wallet pass is reported (never clean) and resumes where it stopped', async () => {
    await setCursor('recon:donation-refunds', null)
    const d = await dons.reconcileDonationRefunds({ limit: 10, budgetMs: -1 })
    expect(d.scanned).toBe(0)
    expect(d.unverifiable).toEqual([expect.objectContaining({ entityType: 'donation', check: 'scan:recon:donation-refunds', reason: 'budget_exhausted_after:start' })])
    expect(await cursor('recon:donation-refunds')).toBeNull()
    await setCursor('recon:wallet', null)
    const w = await wallets.reconcileWallets({ limit: 10, budgetMs: -1 })
    expect(w.scanned).toBe(0)
    expect(w.unverifiable).toEqual([expect.objectContaining({ entityType: 'wallet', check: 'scan:recon:wallet', reason: 'budget_exhausted_after:start' })])
    expect(await cursor('recon:wallet')).toBeNull()
    // and an unhindered page is complete
    const full = await wallets.reconcileWallets({ limit: 3 })
    expect(full.unverifiable.filter(u => u.check.startsWith('scan:'))).toEqual([])
  }, T)

  it('3 · a failing pass is isolated: the other passes still report, the failure is an explicit unverifiable, and the run summary records exact counts and completeness', async () => {
    // start the wallet pass from the beginning, so it has a page to scan whatever earlier runs left in its cursor
    await setCursor('recon:wallet', null)
    probe.failReleasePass = true
    let r: Awaited<ReturnType<typeof global.runGlobalReconciliation>>
    try { r = await global.runGlobalReconciliation({ limit: 50 }) } finally { probe.failReleasePass = false }
    expect(r.scanned.wallets).toBeGreaterThan(0)                                         // other passes ran
    expect(r.scanned.eligibleReleases).toBe(0)
    expect(r.unverifiableByType.release).toBeGreaterThanOrEqual(1)
    expect(r.incompleteScans).toEqual(expect.arrayContaining([expect.stringMatching(/^scan:stuck-releases:pass_failed:simulated pass failure/)]))
    const report = (await db.collection('reconciliationReports').where('entityId', '==', 'pass:stuck-releases').get()).docs.map(x => x.data())
    expect(report[0]).toMatchObject({ kind: 'unverifiable', entityType: 'release', field: 'scan:stuck-releases', reason: expect.stringMatching(/^pass_failed:/) })
    const run = (await db.collection('reconciliationRuns').orderBy('finishedAt', 'desc').limit(1).get()).docs[0].data()
    expect(run).toMatchObject({ totalMismatches: r.totalMismatches, totalUnverifiable: r.totalUnverifiable, mismatchesByType: r.byType, unverifiableByType: r.unverifiableByType, incompleteScans: r.incompleteScans })
  }, T)

  it('4 · a flood of newer reports cannot hide an urgent finding (health reads the run summary); repeated runs append, never overwrite', async () => {
    const uid = `p39-org-${P}-w`
    await payment(uid, 2_000, 'registration', `p39reg-${P}`)
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: 1 })             // a real wallet mismatch
    const v = await wallets.verifyOneWallet(uid, (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!)
    expect(v.status).toBe('mismatch')
    const r1 = await global.runGlobalReconciliation({ limit: 5_000 })
    expect(r1.byType.wallet).toBeGreaterThanOrEqual(1)
    const mine = async () => (await db.collection('reconciliationReports').where('entityId', '==', uid).where('kind', '==', 'mismatch').get()).size
    const after1 = await mine()
    expect(after1).toBeGreaterThan(0)
    // a flood of 1,100 newer reports (as a first run over legacy data could write)
    for (let i = 0; i < 1_100; i += 400) {
      const b = db.batch()
      for (let j = i; j < Math.min(i + 400, 1_100); j++) {
        const ref = db.collection('reconciliationReports').doc(); junk.push(ref.id)
        b.set(ref, { kind: 'unverifiable', entityType: 'event', entityId: `p39-junk-${j}`, field: 'x', reason: 'flood', repaired: false, createdAt: new Date(Date.now() + 60_000) })
      }
      await b.commit()
    }
    const newest = (await db.collection('reconciliationReports').orderBy('createdAt', 'desc').limit(1_000).get()).docs
    expect(newest.filter(d => d.get('entityId') === uid)).toEqual([])                     // the old window can no longer see it …
    const h = await health()
    expect(h.dataIntegrity.walletMismatches).toBe(r1.byType.wallet)                       // … the run summary still counts it exactly
    // a second run appends a new report for the still-unresolved finding and a new run summary
    const runs0 = (await db.collection('reconciliationRuns').get()).size
    await global.runGlobalReconciliation({ limit: 5_000 })
    expect(await mine()).toBeGreaterThan(after1)
    expect((await db.collection('reconciliationRuns').get()).size).toBe(runs0 + 1)
  }, T)
})
