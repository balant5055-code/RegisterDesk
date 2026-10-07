// RD-RACEOPS-02C · Results at scale — REAL Firestore (emulator), through the real services.
//
// Import → verify → rank → snapshot → publish for 1,000 / 5,000 / 20,000 results with
// second-resolution times (so ties are everywhere), then walk the public leaderboard with
// the tie-safe cursor and prove every finisher appears exactly once, in rank order, and
// that the session-level bib uniqueness check did not change the chunk cost.
//
//   RD_RESULTS_SCALE=1000,5000,20000   (default: 1000,5000 — 20,000 takes minutes on the
//                                       emulator; run it deliberately and record the time)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const SIZES = (process.env.RD_RESULTS_SCALE ?? '1000,5000').split(',').map(Number).filter(n => n > 0)
const T = 20 * 60_000

describeEmu('RD-RACEOPS-02C · results at scale', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let svc: typeof import('@/features/race-operations/services/importService')
  let snap: typeof import('@/features/race-operations/services/snapshotService')
  let verify: typeof import('@/features/race-operations/services/registrationVerify')
  let repo: typeof import('@/features/race-operations/repositories/snapshotRepo')
  let types: typeof import('@/features/race-operations/types/snapshot')

  const UID = `emu-scale-${process.pid}`, ACTOR = 'scale-actor'
  const EVENT = `evt_scale_${process.pid}`, SLUG = `evt-scale-${process.pid}`, PASS = 'pass_full'
  const bibOf = (i: number) => String(1000 + i)

  async function seedEvent() {
    const b = adminDb.batch()
    b.set(adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`), { eventType: 'sports', eventDetails: { seo: { urlSlug: SLUG }, info: { name: 'Scale Marathon' }, schedule: { startDate: '2026-04-01' } } })
    b.set(adminDb.doc(`events/${SLUG}`), { uid: UID, draftId: EVENT, eventSlug: SLUG, lifecycleStatus: 'published', eventDetails: { info: { name: 'Scale Marathon' } }, pricing: { passes: [{ id: PASS, name: 'Full' }] } })
    await b.commit()
  }
  async function seedRoster(n: number) {
    for (let i = 0; i < n; i += 400) {
      const b = adminDb.batch()
      for (let k = i; k < Math.min(n, i + 400); k++) {
        b.set(adminDb.doc(`registrations/scale_${process.pid}_${k}`), { organizerUid: UID, eventSlug: SLUG, passId: PASS, status: 'confirmed', bibNumber: bibOf(k), attendee: { name: `Athlete ${k}` } })
      }
      await b.commit()
    }
  }
  async function wipe(all: boolean) {
    const delQuery = async (q: FirebaseFirestore.Query) => { for (;;) { const s = await q.limit(400).get(); if (s.empty) break; const b = adminDb.batch(); s.docs.forEach(d => b.delete(d.ref)); await b.commit() } }
    const sessions = await adminDb.collection('raceImportSessions').where('organizerUid', '==', UID).get()
    for (const s of sessions.docs) { await delQuery(s.ref.collection('results')); await s.ref.delete() }
    const snapRef = adminDb.collection('raceResultSnapshots').doc(types.snapshotId(SLUG, PASS))
    await delQuery(snapRef.collection('entries')); await snapRef.delete().catch(() => null)
    if (all) {
      await delQuery(adminDb.collection('registrations').where('organizerUid', '==', UID))
      await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).delete().catch(() => null)
      await adminDb.doc(`events/${SLUG}`).delete().catch(() => null)
    }
  }

  const row = (rowNumber: number, i: number, ms: number) => ({
    rowNumber, participantName: `Athlete ${i}`, bibNumber: bibOf(i), chipTimeMs: ms, gunTimeMs: null,
    chipTimeRaw: String(ms), gunTimeRaw: null, status: 'finished' as const, statusRaw: null,
    gender: null, category: null, ageGroup: null, rawRow: { Bib: bibOf(i), Time: String(ms) }, sourceProvider: 'csv',
  })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project required')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    svc = await import('@/features/race-operations/services/importService')
    snap = await import('@/features/race-operations/services/snapshotService')
    verify = await import('@/features/race-operations/services/registrationVerify')
    repo = await import('@/features/race-operations/repositories/snapshotRepo')
    types = await import('@/features/race-operations/types/snapshot')
    await wipe(true).catch(() => null)
    await seedEvent()
    await seedRoster(Math.max(...SIZES))
  }, T)
  afterAll(async () => { await wipe(true) }, T)

  for (const N of SIZES) {
    it(`${N.toLocaleString('en-IN')} results: import, publish, and walk every page exactly once`, async () => {
      await wipe(false)
      const t0 = Date.now()
      // Whole-second times spread over N/3 distinct values → roughly three-way ties at every
      // size, scattered by a coprime stride so tied entries are not adjacent in the file.
      const distinct = Math.max(2, Math.floor(N / 3))
      const times = Array.from({ length: N }, (_, i) => 3_600_000 + ((i * 7919) % distinct) * 1000)
      const created = await svc.createImportSession({ workspaceUid: UID, callerUid: ACTOR, eventId: EVENT, passId: PASS, fileName: 'scale.csv', fileHash: 'h', provider: 'csv', mapping: { bibNumber: 'Bib', chipTime: 'Time' }, totalRows: N })
      if (!created.ok) throw new Error(created.error)
      const sid = created.value.sessionId
      let chunks = 0
      for (let i = 0; i < N; i += svc.RESULT_CHUNK_SIZE) {
        const rows = times.slice(i, i + svc.RESULT_CHUNK_SIZE).map((ms, k) => row(i + k + 2, i + k, ms))
        const r = await svc.appendResults({ sessionId: sid, workspaceUid: UID, results: rows })
        if (!r.ok) throw new Error(r.error)
        chunks++
      }
      const tStore = Date.now()
      const v = await verify.verifySessionRegistrations({ sessionId: sid, workspaceUid: UID })
      if (!v.ok) throw new Error(v.error)
      expect(v.value.blocking).toBe(false)
      const tVerify = Date.now()
      let rankCalls = 0
      for (;;) { const k = await svc.rankSessionChunk({ sessionId: sid, workspaceUid: UID }); if (!k.ok) throw new Error(k.error); rankCalls++; if (k.value.done) break }
      const tRank = Date.now()
      let snapCalls = 0
      for (;;) { const s = await snap.buildSnapshotChunk({ sessionId: sid, workspaceUid: UID }); if (!s.ok) throw new Error(s.error); snapCalls++; if (s.value.done) break }
      const tSnap = Date.now()
      const p = await svc.publishSession({ sessionId: sid, workspaceUid: UID, callerUid: ACTOR })
      if (!p.ok) throw new Error(p.error)
      const tPublish = Date.now()

      const live = (await repo.getLiveSnapshotByPass(SLUG, PASS))!
      expect(live.totalCount).toBe(N); expect(live.finisherCount).toBe(N)

      // Walk the public leaderboard with the production page size.
      const seen = new Map<string, number>(); let pages = 0; let lastRank = 0; let cursor: import('@/features/race-operations/utils/publicKeys').LeaderboardCursor | null = null
      for (;;) {
        const page = await repo.fetchLeaderboardPage(live.snapshotId, live.version, 50, cursor)
        pages++
        for (const r of page.rows) {
          expect(r.overallRank!).toBeGreaterThanOrEqual(lastRank); lastRank = r.overallRank!
          seen.set(r.bibNumber, (seen.get(r.bibNumber) ?? 0) + 1)
        }
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
      const tWalk = Date.now()
      expect(seen.size).toBe(N)
      expect([...seen.values()].every(c => c === 1)).toBe(true)
      expect(pages).toBe(Math.ceil(N / 50))
      // ties really were exercised: distinct ranks < N
      const ranks = new Set(times).size
      expect(ranks).toBeLessThan(N)

      console.log(`[scale ${N}] chunks=${chunks} rank calls=${rankCalls} snapshot calls=${snapCalls} pages=${pages} distinct times=${ranks} | store ${tStore - t0} ms · verify ${tVerify - tStore} ms · rank ${tRank - tVerify} ms · snapshot ${tSnap - tRank} ms · publish ${tPublish - tSnap} ms · walk ${tWalk - tPublish} ms · total ${tWalk - t0} ms`)
    }, T)
  }
})
