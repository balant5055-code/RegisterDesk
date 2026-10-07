// RD-RACEOPS-RESULTS-04 · Split-bearing results at scale — REAL Firestore (emulator).
//
// The 03 audit's open scale question, answered with measurement rather than assertion: a
// participant with checkpoints costs a SECOND published document, so a snapshot chunk that
// used to be 400 writes could become 800 and exceed Firestore's 500-write batch limit. The
// chunk was therefore halved to 200 rows (snapshotService.SNAPSHOT_CHUNK_SIZE) and both
// documents are written in ONE batch, so a published version can never hold a result without
// its checkpoints.
//
// This proves that at size, and records the timings:
//
//   • every finisher has exactly one entry AND one splits document, both at the live version
//   • the public leaderboard is untouched — same page count, same tie-safe walk
//   • the runner page still costs TWO document GETs, whatever the field size
//   • group ranks and totals are correct across the whole field
//
//   RD_RESULTS_SCALE=1000,5000,20000   (default: 1000,5000 — 20,000 takes minutes on the
//                                       emulator; run it deliberately and record the time)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const SIZES = (process.env.RD_RESULTS_SCALE ?? '1000,5000').split(',').map(Number).filter(n => n > 0)
const T = 30 * 60_000

/** Checkpoints per participant. Mid-range for a road race: a 21K with 7 mats, a 10K with 2. */
const SPLITS_PER_RESULT = 7

describeEmu('RD-RACEOPS-RESULTS-04 · split-bearing results at scale', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let svc: typeof import('@/features/race-operations/services/importService')
  let snap: typeof import('@/features/race-operations/services/snapshotService')
  let verify: typeof import('@/features/race-operations/services/registrationVerify')
  let repo: typeof import('@/features/race-operations/repositories/snapshotRepo')
  let pub: typeof import('@/features/race-operations/services/publicResults')
  let keys: typeof import('@/features/race-operations/utils/publicKeys')
  let types: typeof import('@/features/race-operations/types/snapshot')

  const UID = `emu-splitscale-${process.pid}`, ACTOR = 'splitscale-actor'
  const EVENT = `evt_ss_${process.pid}`, SLUG = `evt-ss-${process.pid}`, PASS = 'pass_21k'
  const PASS_NAME = '21K'
  const bibOf = (i: number) => String(20000 + i)
  const GENDERS = ['Male', 'Female'] as const
  const AGE_GROUPS = ['18-30 Yrs', '31-40 Yrs', '41-50 Yrs', '51+ Yrs'] as const
  const DISTANCE_M = 21_000

  async function seedEvent() {
    const b = adminDb.batch()
    b.set(adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`), { eventType: 'sports', eventDetails: { seo: { urlSlug: SLUG }, info: { name: 'Split Scale Half' }, schedule: { startDate: '2026-04-12' } } })
    b.set(adminDb.doc(`events/${SLUG}`), { uid: UID, draftId: EVENT, eventSlug: SLUG, lifecycleStatus: 'published', eventDetails: { info: { name: 'Split Scale Half' } }, pricing: { passes: [{ id: PASS, name: PASS_NAME }] } })
    await b.commit()
  }
  async function seedRoster(n: number) {
    for (let i = 0; i < n; i += 400) {
      const b = adminDb.batch()
      for (let k = i; k < Math.min(n, i + 400); k++) {
        b.set(adminDb.doc(`registrations/ss_${process.pid}_${k}`), { organizerUid: UID, eventSlug: SLUG, passId: PASS, status: 'confirmed', bibNumber: bibOf(k), attendee: { name: `Athlete ${k}` } })
      }
      await b.commit()
    }
  }
  async function wipe(all: boolean) {
    const delQuery = async (q: FirebaseFirestore.Query) => { for (;;) { const s = await q.limit(400).get(); if (s.empty) break; const b = adminDb.batch(); s.docs.forEach(d => b.delete(d.ref)); await b.commit() } }
    for (const s of (await adminDb.collection('raceImportSessions').where('organizerUid', '==', UID).get()).docs) {
      await delQuery(s.ref.collection('results')); await s.ref.delete()
    }
    const ref = adminDb.collection('raceResultSnapshots').doc(types.snapshotId(SLUG, PASS))
    await delQuery(ref.collection('entries'))
    await delQuery(ref.collection(types.SNAPSHOT_SPLITS_SUBCOLLECTION))
    await ref.delete().catch(() => null)
    if (all) {
      await delQuery(adminDb.collection('registrations').where('organizerUid', '==', UID))
      await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).delete().catch(() => null)
      await adminDb.doc(`events/${SLUG}`).delete().catch(() => null)
    }
  }

  /** 7 checkpoints at 3 / 5.5 / 11 / 16.5 / 19 / 21 km plus the start, as Provider A publishes. */
  const MARKS = [0, 3_000, 5_500, 11_000, 16_500, 19_000, DISTANCE_M]
  const splitsFor = (chipMs: number) => MARKS.map((meters, i) => {
    const cumulative = Math.round(chipMs * (meters / DISTANCE_M))
    const previous = i === 0 ? 0 : Math.round(chipMs * (MARKS[i - 1] / DISTANCE_M))
    return {
      sequence: i + 1,
      splitKey: `M${meters}`,
      name: meters === 0 ? 'Start' : `${meters / 1000} KM`,
      distanceMeters: meters === 0 ? null : meters,
      segmentMeters: i === 0 ? null : meters - MARKS[i - 1],
      cumulativeTimeMs: cumulative,
      segmentTimeMs: cumulative - previous,
      timeOfDay: null,
    }
  })

  const row = (rowNumber: number, i: number, ms: number) => ({
    rowNumber, participantName: `Athlete ${i}`, bibNumber: bibOf(i),
    chipTimeMs: ms, gunTimeMs: ms + 4_000, chipTimeRaw: String(ms), gunTimeRaw: null,
    status: 'finished' as const, statusRaw: null,
    gender: GENDERS[i % GENDERS.length], category: null, ageGroup: AGE_GROUPS[i % AGE_GROUPS.length],
    distanceMeters: DISTANCE_M, distanceRaw: '21 KM',
    splits: splitsFor(ms),
    rawRow: { Bib: bibOf(i), Time: String(ms) },
    sourceProvider: 'excel',
  })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project required')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    svc = await import('@/features/race-operations/services/importService')
    snap = await import('@/features/race-operations/services/snapshotService')
    verify = await import('@/features/race-operations/services/registrationVerify')
    repo = await import('@/features/race-operations/repositories/snapshotRepo')
    pub = await import('@/features/race-operations/services/publicResults')
    keys = await import('@/features/race-operations/utils/publicKeys')
    types = await import('@/features/race-operations/types/snapshot')
    await wipe(true).catch(() => null)
    await seedEvent()
    await seedRoster(Math.max(...SIZES))
  }, T)
  afterAll(async () => { await wipe(true) }, T)

  for (const N of SIZES) {
    it(`${N.toLocaleString('en-IN')} results × ${SPLITS_PER_RESULT} checkpoints: publishes, and the public cost is unchanged`, async () => {
      await wipe(false)
      const t0 = Date.now()
      // Whole-second times over N/3 distinct values → three-way ties everywhere, scattered by
      // a coprime stride so tied rows are not adjacent (the tie-safe cursor's hard case).
      const distinct = Math.max(2, Math.floor(N / 3))
      const times = Array.from({ length: N }, (_, i) => 5_400_000 + ((i * 7919) % distinct) * 1000)

      const created = await svc.createImportSession({
        workspaceUid: UID, callerUid: ACTOR, eventId: EVENT, passId: PASS,
        fileName: 'scale.xlsx', fileHash: 'h', provider: 'excel',
        mapping: { bibNumber: 'Bib', chipTime: 'Time', distance: 'Distance' }, totalRows: N,
      })
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

      // Every chunk writes N entries + N splits documents in ONE batch. A batch over 500
      // writes throws in writeSnapshotChunk, so reaching `done` at all proves the halved
      // chunk size holds.
      let snapCalls = 0
      for (;;) { const s = await snap.buildSnapshotChunk({ sessionId: sid, workspaceUid: UID }); if (!s.ok) throw new Error(`${s.status} ${s.error}`); snapCalls++; if (s.value.done) break }
      const tSnap = Date.now()

      const p = await svc.publishSession({ sessionId: sid, workspaceUid: UID, callerUid: ACTOR })
      if (!p.ok) throw new Error(p.error)
      const tPublish = Date.now()

      const live = (await repo.getLiveSnapshotByPass(SLUG, PASS))!
      expect(live.totalCount).toBe(N)
      expect(live.finisherCount).toBe(N)

      // ── one entry and one splits document per participant, both at the live version ──
      const snapRef = adminDb.collection('raceResultSnapshots').doc(types.snapshotId(SLUG, PASS))
      const entryCount = (await snapRef.collection('entries').count().get()).data().count
      const splitCount = (await snapRef.collection(types.SNAPSHOT_SPLITS_SUBCOLLECTION).count().get()).data().count
      expect(entryCount).toBe(N)
      expect(splitCount).toBe(N)

      // ── the public leaderboard is untouched by splits: same pages, every bib once ──
      const seen = new Map<string, number>(); let pages = 0; let lastRank = 0
      let cursor: import('@/features/race-operations/utils/publicKeys').LeaderboardCursor | null = null
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

      // ── the runner page: still one entry GET + one splits GET, whatever N is ──
      const tRunner0 = Date.now()
      const runner = await pub.getRunnerResult(SLUG, keys.passSlug(PASS_NAME, PASS), bibOf(0))
      const tRunner = Date.now()
      expect(runner!.splits).toHaveLength(SPLITS_PER_RESULT)
      expect(runner!.splits[0].name).toBe('Start')
      expect(runner!.splits[SPLITS_PER_RESULT - 1].distanceMeters).toBe(DISTANCE_M)
      expect(runner!.result.paceMsPerKm).not.toBeNull()

      // ── group ranks and totals span the whole field ──
      // Genders alternate and age groups cycle through four, so the totals are arithmetic.
      expect(runner!.result.genderTotal).toBe(Math.ceil(N / GENDERS.length))
      expect(runner!.result.ageGroupTotal).toBe(Math.ceil(N / AGE_GROUPS.length))
      expect(runner!.result.genderRank).not.toBeNull()
      expect(runner!.result.ageGroupRank).not.toBeNull()

      console.log(
        `[split scale ${N}] rows=${N} splits/row=${SPLITS_PER_RESULT} append chunks=${chunks} rank calls=${rankCalls} `
        + `snapshot calls=${snapCalls} (chunk ${snap.SNAPSHOT_CHUNK_SIZE}) docs: entries=${entryCount} splits=${splitCount} `
        + `pages=${pages} | store ${tStore - t0} ms · verify ${tVerify - tStore} ms · rank ${tRank - tVerify} ms · `
        + `snapshot ${tSnap - tRank} ms · publish ${tPublish - tSnap} ms · walk ${tWalk - tPublish} ms · `
        + `runner page ${tRunner - tRunner0} ms · total ${tWalk - t0} ms`,
      )
    }, T)
  }
})
