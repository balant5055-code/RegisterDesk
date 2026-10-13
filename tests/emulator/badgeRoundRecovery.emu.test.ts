// RD-PRINT-P8 (W6) — the dedicated badge-round recovery walk and cron (app/api/cron/badge-rounds-reconcile),
// on REAL Firestore, settling through the REAL transactional settlePrintBadgeRound.
//
// Fixtures are written the way the billing store writes them: a paid job (billing { mode: 'paid', round }),
// its open round printBadgeRounds/{jobId}_r1, the usage record eventServiceAllowances/{draft}/usage/{jobId}_r1
// and the ledger's consumed units. One draft per job, so every ledger figure is checked exactly.
//
// Test-process mocks ONLY: CRON_SECRET, the Super Admin resolver and the audit write for the Operations
// Center cancel route. Nothing here touches a release gate.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({ failSettle: false }))
// The real settlement, except while h.failSettle (a transient failure AFTER a successful cancel).
vi.mock('@/lib/printAssets/badgeBilling/store', async orig => {
  const real = await orig<typeof import('@/lib/printAssets/badgeBilling/store')>()
  return { ...real, settlePrintBadgeRound: (...a: Parameters<typeof real.settlePrintBadgeRound>) => (h.failSettle ? Promise.reject(new Error('transient')) : real.settlePrintBadgeRound(...a)) }
})
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), CRON_SECRET: 'p8-round-cron' }))
vi.mock('@/lib/admin/auth', async orig => ({ ...(await orig<typeof import('@/lib/admin/auth')>()), resolveAdminUid: async () => 'p8-super' }))
vi.mock('@/lib/admin/audit', async orig => ({ ...(await orig<typeof import('@/lib/admin/audit')>()), logAdminAction: async () => 'audit' }))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const PID = process.pid
// '!' sorts before letters, digits and '_' — so these rounds come first in document-id order.
const P = `!p8r-${PID}`
const ORG = `p8r-org-${PID}`
type Rec = Record<string, unknown>

describeEmu('RD-PRINT-P8 · badge-round recovery (real Firestore)', () => {
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let rec: typeof import('@/lib/printAssets/badgeBilling/roundRecovery')
  let store: typeof import('@/lib/printAssets/badgeBilling/store')
  const drafts: string[] = []
  const jobs: string[] = []
  let k = 0

  /** A paid job with one OPEN round: `reserved` units held, `claimed` attendees billed so far. */
  async function openRound(status: string, opts: { reserved?: number; claimed?: number; ageMs?: number; deleteJob?: boolean } = {}) {
    const reserved = opts.reserved ?? 3, claimed = opts.claimed ?? 1
    const n = String(++k).padStart(3, '0')
    const jobId = `${P}-j${n}`, draft = `p8r-${PID}-d${n}`
    const createdAt = new Date(Date.now() - (opts.ageMs ?? 60_000))
    drafts.push(draft); jobs.push(jobId)
    await adminDb.doc(`eventServiceAllowances/${draft}`).set({ draftId: draft, organizerUid: ORG, print_badges: { purchased: 10, consumed: reserved, onExhausted: 'block' } })
    await adminDb.doc(`eventServiceAllowances/${draft}/usage/${jobId}_r1`).set({ service: 'print_badges', quantity: reserved, source: `print_generation:${jobId}`, createdAt })
    await adminDb.doc(`printBadgeRounds/${jobId}_r1`).set({ roundId: `${jobId}_r1`, jobId, round: 1, organizerUid: ORG, eventId: draft, eventSlug: `${draft}-ev`, unitKey: `${jobId}_r1`, assetType: 'ID_CARD', status: 'reserved', reserved, claimed, createdAt })
    if (!opts.deleteJob) {
      await adminDb.doc(`printGenerationJobs/${jobId}`).set({ jobId, organizerUid: ORG, eventId: draft, eventSlug: `${draft}-ev`, assetType: 'ID_CARD', status, billing: { mode: 'paid', round: 1, chargeable: reserved, unitPricePaise: 20 }, lockedUntil: null, createdAt })
    }
    return { jobId, draft, reserved, claimed }
  }
  const round = async (jobId: string) => (await adminDb.doc(`printBadgeRounds/${jobId}_r1`).get()).data() as Rec
  const consumed = async (draft: string) => Number(((await adminDb.doc(`eventServiceAllowances/${draft}`).get()).get('print_badges') as Rec).consumed)
  const usage = async (jobId: string, draft: string) => (await adminDb.doc(`eventServiceAllowances/${draft}/usage/${jobId}_r1`).get()).data() as Rec | undefined
  const history = async (draft: string) => (await adminDb.collection('licenseHistory').where('eventId', '==', draft).where('action', '==', 'print_badges_consumed').get()).size
  const resetCursor = () => adminDb.doc(rec.ROUND_RECOVERY_STATE_PATH).delete()
  /** Settles every OTHER test's open rounds out of the way, so each test reasons about its own. */
  const settleMine = async () => { for (let i = 0; i < 10; i++) { const r = await rec.recoverBadgeRounds(); if (r.wrapped) break } }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    adminDb = (await import('@/lib/firebase/admin')).adminDb
    rec = await import('@/lib/printAssets/badgeBilling/roundRecovery')
    store = await import('@/lib/printAssets/badgeBilling/store')
    await resetCursor()
  }, T)

  afterAll(async () => {
    for (const j of jobs) {
      await adminDb.doc(`printBadgeRounds/${j}_r1`).delete().catch(() => null)
      await adminDb.recursiveDelete(adminDb.doc(`printGenerationJobs/${j}`)).catch(() => null)
    }
    for (const d of drafts) {
      await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${d}`)).catch(() => null)
      for (const h of (await adminDb.collection('licenseHistory').where('eventId', '==', d).get()).docs) await h.ref.delete()
    }
    await resetCursor()
  }, T)

  it('R1–R3, R10 · completed, failed, cancelled and DELETED jobs: their open rounds settle; units kept for billed attendees, the rest released', async () => {
    await resetCursor()
    const done = await openRound('completed'), failed = await openRound('failed'), cancelled = await openRound('cancelled')
    const orphan = await openRound('completed', { deleteJob: true })
    const r = await rec.recoverBadgeRounds()
    expect(r.errors).toBe(0)
    for (const x of [done, failed, cancelled, orphan]) {
      expect(await round(x.jobId), x.jobId).toMatchObject({ status: 'settled', keptUnits: x.claimed, releasedUnits: x.reserved - x.claimed })
      expect(await consumed(x.draft)).toBe(x.claimed)                      // the ledger gave back exactly the released units
      expect(await usage(x.jobId, x.draft)).toMatchObject({ quantity: x.claimed, releasedUnits: x.reserved - x.claimed })
      expect(await history(x.draft)).toBe(1)
    }
  }, T)

  it('a RUNNING job is never settled — however old its round is; it is reported as staleActive', async () => {
    await resetCursor()
    const live = await openRound('processing', { ageMs: 3 * 24 * 3600_000 })
    const r = await rec.recoverBadgeRounds()
    expect(await round(live.jobId)).toMatchObject({ status: 'reserved', reserved: live.reserved })
    expect(await consumed(live.draft)).toBe(live.reserved)
    expect(r.active).toBeGreaterThanOrEqual(1)
    expect(r.staleActive).toBeGreaterThanOrEqual(1)
    await adminDb.doc(`printGenerationJobs/${live.jobId}`).update({ status: 'completed' })   // let the next tests start clean
    await settleMine()
  }, T)

  it('R7 · repeated runs are idempotent: no second settlement, no second release, one history row', async () => {
    await resetCursor()
    const x = await openRound('completed', { reserved: 5, claimed: 2 })
    await rec.recoverBadgeRounds()
    await resetCursor()
    const again = await rec.recoverBadgeRounds()
    expect(again.settled).toBe(0)
    expect(await consumed(x.draft)).toBe(2)
    expect(await round(x.jobId)).toMatchObject({ status: 'settled', keptUnits: 2, releasedUnits: 3 })
    expect(await history(x.draft)).toBe(1)
  }, T)

  it('R4 · a round that fails is left OPEN and retried first next run; the cursor never passes it; the rest still settle', async () => {
    await settleMine(); await resetCursor()
    const a = await openRound('completed'), b = await openRound('completed'), c = await openRound('completed')
    const failing = vi.fn(async (jobId: string, reason: string, n?: number) => {
      if (jobId === b.jobId) throw new Error('transient')
      return store.settlePrintBadgeRound(jobId, reason, n)
    })
    const r1 = await rec.recoverBadgeRounds({ settle: failing })
    expect(r1.errors).toBe(1)
    expect(r1.wrapped).toBe(false)
    expect(await round(a.jobId)).toMatchObject({ status: 'settled' })
    expect(await round(b.jobId)).toMatchObject({ status: 'reserved' })
    expect(await round(c.jobId)).toMatchObject({ status: 'settled' })      // processed, just not checkpointed past b
    expect(r1.cursor).toBe(`${a.jobId}_r1`)
    expect((await rec.readRoundRecoveryState()).cursor).toBe(`${a.jobId}_r1`)
    const r2 = await rec.recoverBadgeRounds()
    expect(r2.errors).toBe(0)
    expect(await round(b.jobId)).toMatchObject({ status: 'settled' })
    expect(await history(c.draft)).toBe(1)                                   // c was not settled twice
  }, T)

  it('R6 · the time budget and the page limit stop the walk with progress saved; the next run resumes after it', async () => {
    await settleMine(); await resetCursor()
    const xs = [await openRound('completed'), await openRound('completed'), await openRound('completed')]
    let t = 0
    const clock = () => (t += 1_000)                                         // each check advances 1 s
    const r = await rec.recoverBadgeRounds({ budgetMs: 2_500, clock })      // the page check and one round fit; the second does not
    expect(r.stoppedBy).toBe('deadline')
    const settledNow = (await Promise.all(xs.map(x => round(x.jobId)))).filter(x => x.status === 'settled').length
    expect(settledNow).toBeGreaterThanOrEqual(1)
    expect(settledNow).toBeLessThan(3)
    const r2 = await rec.recoverBadgeRounds({ page: 1, maxPages: 1 })
    expect(r2.stoppedBy).toBe('pages')
    await settleMine()
    for (const x of xs) expect(await round(x.jobId)).toMatchObject({ status: 'settled' })
    for (const x of xs) expect(await history(x.draft)).toBe(1)
  }, T)

  it('R5 · concurrent sweeps: every round settles exactly once; a stale sweeper stops without overwriting progress', async () => {
    await settleMine(); await resetCursor()
    const xs = [await openRound('completed'), await openRound('cancelled'), await openRound('failed'), await openRound('completed')]
    const [r1, r2] = await Promise.all([rec.recoverBadgeRounds(), rec.recoverBadgeRounds()])
    expect(r1.errors + r2.errors).toBe(0)
    expect([r1.stoppedBy, r2.stoppedBy]).toContain('stale')                 // the loser of a compare-and-set stops
    await settleMine()
    for (const x of xs) {
      expect(await round(x.jobId)).toMatchObject({ status: 'settled', keptUnits: x.claimed })
      expect(await consumed(x.draft)).toBe(x.claimed)
      expect(await history(x.draft)).toBe(1)
    }
  }, T)

  it('R8 · Operations Center cancel settles the open round at once; a failed settlement is left to the cron', async () => {
    await settleMine(); await resetCursor()
    const x = await openRound('processing')
    const { POST } = await import('@/app/api/admin/operations-center/jobs/cancel/route')
    const call = async (jobId: string) => POST(new NextRequest('http://x/api/admin/operations-center/jobs/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: JSON.stringify({ collection: 'printGenerationJobs', jobId }),
    }))
    const res = await call(x.jobId)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobId: x.jobId, status: 'cancelled' })
    expect(await round(x.jobId)).toMatchObject({ status: 'settled', keptUnits: x.claimed })
    expect(await consumed(x.draft)).toBe(x.claimed)

    // Settlement failing after a successful cancel: the cancel still reports truthfully; the round stays open for the cron.
    const y = await openRound('processing')
    h.failSettle = true
    try {
      const res2 = await call(y.jobId)
      expect(res2.status).toBe(200)
      expect((await res2.json()).status).toBe('cancelled')
      expect(await round(y.jobId)).toMatchObject({ status: 'reserved' })      // deferred, never shown as settled
    } finally { h.failSettle = false }
    await settleMine()                                                        // the recovery walk settles it
    expect(await round(y.jobId)).toMatchObject({ status: 'settled', keptUnits: y.claimed })
    expect(await history(y.draft)).toBe(1)
  }, T)

  it('R9 · the dedicated cron route recovers rounds on its own (no print-generation budget involved); unauthorized calls are refused', async () => {
    await settleMine(); await resetCursor()
    const x = await openRound('failed')
    const route = await import('@/app/api/cron/badge-rounds-reconcile/route')
    expect((await route.POST(new NextRequest('http://x/api/cron/badge-rounds-reconcile', { method: 'POST' }))).status).toBe(401)
    const ok = await route.POST(new NextRequest('http://x/api/cron/badge-rounds-reconcile', { method: 'POST', headers: { authorization: 'Bearer p8-round-cron' } }))
    expect(ok.status).toBe(200)
    const body = await ok.json() as Rec
    expect(body).toMatchObject({ errors: 0 })
    expect(await round(x.jobId)).toMatchObject({ status: 'settled' })
    expect((await adminDb.doc('operationsMetrics/badge-rounds-reconcile').get()).exists).toBe(true)   // withCronMetrics recorded the run
  }, T)
})
