// Phase 3.10B — the COST of release-attempt evidence inside the release job, measured on the emulator (local
// timings, not production): evidence transactions and plain evidence reads per row (spied), and the release
// time with the evidence switched OFF vs ON for the same batch shape. Results are appended to BENCH_OUT when
// that variable is set (for the phase report); the assertions pin the optimised operation counts.

import fs from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 600_000
const P = process.pid
const DAY = 86_400_000

const fx = vi.hoisted(() => ({ evidenceOff: false }))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))
// the evidence switch: OFF makes both evidence calls no-ops, so OFF vs ON isolates their cost
vi.mock('@/lib/settlements/releaseAttempts', async orig => {
  const real = await orig<typeof import('@/lib/settlements/releaseAttempts')>()
  return {
    ...real,
    recordReleaseFailure: async (...a: Parameters<typeof real.recordReleaseFailure>) => (fx.evidenceOff ? 'not_recorded' : real.recordReleaseFailure(...a)),
    resolveReleaseAttempt: async (...a: Parameters<typeof real.resolveReleaseAttempt>) => (fx.evidenceOff ? 'none' : real.resolveReleaseAttempt(...a)),
  }
})

describeEmu('Phase 3.10B · release-attempt evidence cost', () => {
  let db: import('firebase-admin/firestore').Firestore
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let n = 0
  const counts = { evidenceTx: 0, evidenceReads: 0 }

  async function rows(uid: string, count: number, net: number) {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = `p310b-${P}-${++n}`
      await credit({
        id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: 'e', entityType: 'event', sourceId: id, sourceType: 'registration',
        payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
        netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
      } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
      ids.push(`ptx_${id}`)
    }
    const b = db.batch()
    ids.forEach((id, i) => b.update(db.doc(`platformTransactions/${id}`), { paidAt: new Date(Date.now() - 40 * DAY - i * 1_000) }))
    await b.commit()
    return ids
  }
  async function measure(label: string, ids: string[], evidenceOff: boolean, setup?: () => Promise<void>) {
    if (setup) await setup()
    fx.evidenceOff = evidenceOff
    counts.evidenceTx = 0; counts.evidenceReads = 0
    const t0 = performance.now()
    const r = await release({ limit: 500 })
    const ms = performance.now() - t0
    fx.evidenceOff = false
    const out = { label, rows: ids.length, evidenceOff, ms: Math.round(ms), processed: r.processed, failures: r.failures, evidenceTx: counts.evidenceTx, evidenceReads: counts.evidenceReads }
    if (process.env.BENCH_OUT) fs.appendFileSync(process.env.BENCH_OUT, JSON.stringify(out) + '\n')
    return out
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    credit = (await import('@/lib/firebase/firestore/platformTransactions')).recordPlatformTransactionAndCredit
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    // count evidence transactions (any transaction that reads an evidence document) and plain evidence reads
    const origTx = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) => {
      let touched = false
      const res = await origTx(async tx => {
        const get = tx.get.bind(tx) as (q: unknown) => unknown
        const getAll = (tx.getAll as unknown as (...r: unknown[]) => unknown).bind(tx)
        ;(tx as unknown as { get: unknown }).get = (q: { path?: string }) => { if (typeof q?.path === 'string' && q.path.startsWith('settlementReleaseAttempts/')) touched = true; return get(q) }
        ;(tx as unknown as { getAll: unknown }).getAll = (...refs: Array<{ path?: string }>) => { if (refs.some(r => typeof r?.path === 'string' && r.path.startsWith('settlementReleaseAttempts/'))) touched = true; return getAll(...refs) }
        return fn(tx)
      }, opts)
      if (touched) counts.evidenceTx++
      return res
    }) as never)
    // a plain DocumentReference.get() goes through firestore.getAll(), so counting getAll counts every plain read once
    const origGetAll = db.getAll.bind(db)
    vi.spyOn(db, 'getAll').mockImplementation(((...refs: Array<{ path?: string }>) => {
      if (refs.some(r => typeof r?.path === 'string' && r.path.startsWith('settlementReleaseAttempts/'))) counts.evidenceReads++
      return origGetAll(...(refs as never[]))
    }) as never)
  }, T)

  it('released rows: evidence cost per row, OFF vs ON, at 50 and 200 rows', async () => {
    for (const size of [50, 200]) {
      const off = await measure(`released_${size}`, await rows(`p310b-off-${P}-${size}`, size, 1_000), true)
      const on = await measure(`released_${size}`, await rows(`p310b-on-${P}-${size}`, size, 1_000), false)
      expect(off.processed).toBe(size)
      expect(on.processed).toBe(size)
      // Phase 3.10B — a released row with no open record costs NO evidence transaction (one plain read)
      expect.soft(on.evidenceTx).toBe(0)
      expect.soft(on.evidenceReads).toBe(size)
    }
  }, T)

  it('refused rows: evidence cost per row, OFF vs ON (50 rows)', async () => {
    const offIds = await rows(`p310b-roff-${P}`, 50, 5_000)
    await db.doc(`organizerRevenueWallets/p310b-roff-${P}`).update({ pendingPaise: 0 })
    const off = await measure('refused_50', offIds, true)
    // the OFF fixtures stay eligible (and refusable): removed so the ON run measures only its own 50 rows
    { const b = db.batch(); for (const id of offIds) b.delete(db.doc(`platformTransactions/${id}`)); await b.commit() }
    const onIds = await rows(`p310b-ron-${P}`, 50, 5_000)
    await db.doc(`organizerRevenueWallets/p310b-ron-${P}`).update({ pendingPaise: 0 })
    const on = await measure('refused_50', onIds, false)
    expect(off.failures).toBeGreaterThanOrEqual(50)
    expect(on.failures).toBe(50)
    expect.soft(on.evidenceTx).toBe(50)                                                // one record transaction per refusal
    // tidy: refused fixtures would be refused again by every later release run
    const b = db.batch(); for (const id of onIds) b.delete(db.doc(`platformTransactions/${id}`)); await b.commit()
  }, T)

  it('released after an earlier refusal: exactly one resolve transaction for the open record', async () => {
    const uid = `p310b-res-${P}`
    const ids = await rows(uid, 5, 2_000)
    await db.doc(`organizerRevenueWallets/${uid}`).update({ pendingPaise: 0 })
    await release({ limit: 500 })                                                     // 5 refusals ⇒ 5 open records
    await db.doc(`organizerRevenueWallets/${uid}`).update({ pendingPaise: 10_000 })
    const on = await measure('released_after_refusal_5', ids, false)
    expect(on.processed).toBe(5)
    expect.soft(on.evidenceTx).toBe(5)                                                   // the five open records resolved
    for (const id of ids) expect((await db.doc(`settlementReleaseAttempts/${id}`).get()).get('status')).toBe('resolved')
  }, T)
})
