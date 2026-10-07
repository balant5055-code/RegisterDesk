// RD-RACEOPS-RESULTS-04 · Rich results end to end — REAL Firestore (emulator), real services.
//
// What this proves, in the order it matters:
//
//   1  identity      a result resolves to the EXISTING registration by (event, bib). No
//                    participant is ever created by a timing upload.
//   2  unknown bib   refused by the start-list gate; the race cannot be published.
//   3  duplicate bib refused before anything is stored.
//   4  persistence   distance, gender, age group and checkpoints survive the publish
//                    boundary — the P1 the 03 audit found (they used to be dropped).
//   5  ranking       gender and age-group positions and totals are RegisterDesk's own,
//                    computed from the published set; provider rank columns are not stored.
//   6  public        the runner page reads exactly the live version, with derived pace/speed.
//   7  versioning    v(n) splits are isolated from v(n+1); rollback exposes the older set.
//   8  lifecycle     stale publish, concurrent publish and the completeness check all hold.
//   9  no splits     a race without checkpoints publishes and reads normally.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000

describeEmu('RD-RACEOPS-RESULTS-04 · rich timing results, end to end', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let svc: typeof import('@/features/race-operations/services/importService')
  let snap: typeof import('@/features/race-operations/services/snapshotService')
  let verify: typeof import('@/features/race-operations/services/registrationVerify')
  let repo: typeof import('@/features/race-operations/repositories/snapshotRepo')
  let pub: typeof import('@/features/race-operations/services/publicResults')
  let cert: typeof import('@/features/race-operations/services/certificateResults')
  let keys: typeof import('@/features/race-operations/utils/publicKeys')
  let types: typeof import('@/features/race-operations/types/snapshot')
  let perf: typeof import('@/features/race-operations/utils/performance')

  const UID = `emu-rich-${process.pid}`, ACTOR = 'rich-actor'
  const EVENT = `evt_rich_${process.pid}`, SLUG = `evt-rich-${process.pid}`
  const PASS = 'p10k', PASS_NAME = '10K'
  const PASS_SLUG = () => keys.passSlug(PASS_NAME, PASS)

  /** 12 confirmed registrations — the start list this upload must resolve against. */
  const FIELD = [
    { bib: '10571', name: 'Sureshkumar V', gender: 'Male',   age: 'Below 35yrs - Men',   ms: (32 * 60 + 35) * 1000 },
    { bib: '10572', name: 'Arun P',        gender: 'Male',   age: 'Below 35yrs - Men',   ms: (34 * 60 + 10) * 1000 },
    { bib: '10573', name: 'Vikram S',      gender: 'Male',   age: '35-45yrs - Men',      ms: (35 * 60 + 40) * 1000 },
    { bib: '10574', name: 'Meena R',       gender: 'Female', age: 'Below 35yrs - Women', ms: (36 * 60 + 5) * 1000 },
    { bib: '10575', name: 'Divya K',       gender: 'Female', age: 'Below 35yrs - Women', ms: (36 * 60 + 5) * 1000 },   // tie
    { bib: '10576', name: 'Hari M',        gender: 'Male',   age: '35-45yrs - Men',      ms: (38 * 60 + 0) * 1000 },
    { bib: '10577', name: 'Latha N',       gender: 'Female', age: '35-45yrs - Women',    ms: (39 * 60 + 20) * 1000 },
    { bib: '10578', name: 'Karthik T',     gender: 'Male',   age: 'Below 35yrs - Men',   ms: (40 * 60 + 15) * 1000 },
    { bib: '10579', name: 'Priya S',       gender: 'Female', age: 'Below 35yrs - Women', ms: (41 * 60 + 30) * 1000 },
    { bib: '10580', name: 'Ramesh B',      gender: 'Male',   age: '35-45yrs - Men',      ms: (42 * 60 + 45) * 1000 },
    { bib: '10581', name: 'Anu G',         gender: 'Female', age: 'Below 35yrs - Women', ms: (44 * 60 + 0) * 1000 },
    { bib: '10582', name: 'Suresh D',      gender: 'Male',   age: 'Below 35yrs - Men',   ms: null },                   // DNF
  ]

  async function seed() {
    const b = adminDb.batch()
    b.set(adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`), { eventType: 'sports', eventDetails: { seo: { urlSlug: SLUG }, info: { name: 'Rich 10K' }, schedule: { startDate: '2026-04-05' } } })
    b.set(adminDb.doc(`events/${SLUG}`), { uid: UID, draftId: EVENT, eventSlug: SLUG, lifecycleStatus: 'published', eventDetails: { info: { name: 'Rich 10K' } }, pricing: { passes: [{ id: PASS, name: PASS_NAME }] } })
    for (const f of FIELD) {
      // The EXISTING registration record — the source of truth for who this bib is.
      b.set(adminDb.doc(`registrations/rich_${process.pid}_${f.bib}`), {
        organizerUid: UID, eventSlug: SLUG, passId: PASS, status: 'confirmed',
        bibNumber: f.bib, attendee: { name: f.name },
      })
    }
    await b.commit()
  }
  async function cleanup() {
    const del = async (refs: FirebaseFirestore.DocumentReference[]) => {
      for (let i = 0; i < refs.length; i += 400) { const b = adminDb.batch(); refs.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit() }
    }
    for (const s of (await adminDb.collection('raceImportSessions').where('organizerUid', '==', UID).get()).docs) {
      await del(await s.ref.collection('results').listDocuments()); await s.ref.delete()
    }
    const ref = adminDb.collection('raceResultSnapshots').doc(types.snapshotId(SLUG, PASS))
    await del(await ref.collection('entries').listDocuments())
    await del(await ref.collection(types.SNAPSHOT_SPLITS_SUBCOLLECTION).listDocuments())
    await ref.delete().catch(() => null)
    await del((await adminDb.collection('registrations').where('organizerUid', '==', UID).get()).docs.map(d => d.ref))
    await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).delete().catch(() => null)
    await adminDb.doc(`events/${SLUG}`).delete().catch(() => null)
  }

  // ── row builders ────────────────────────────────────────────────────────────
  type Split = import('@/features/race-operations/types/results').NormalizedRaceSplit
  const split = (seq: number, name: string, meters: number | null, cumulativeMs: number | null, tod: string | null = null, segMeters: number | null = null, segMs: number | null = null): Split => ({
    sequence: seq, splitKey: name.toUpperCase().replace(/[^A-Z0-9]/g, ''), name,
    distanceMeters: meters, segmentMeters: segMeters, cumulativeTimeMs: cumulativeMs, segmentTimeMs: segMs, timeOfDay: tod,
  })

  const row = (
    i: number,
    f: typeof FIELD[number],
    over: Partial<{ distanceRaw: string | null; distanceMeters: number | null; splits: Split[]; shiftMs: number }> = {},
  ) => {
    const chip = f.ms === null ? null : f.ms + (over.shiftMs ?? 0)
    return {
      rowNumber: i + 2,
      participantName: f.name,
      bibNumber: f.bib,
      chipTimeMs: chip,
      gunTimeMs: chip === null ? null : chip + 3_000,
      chipTimeRaw: chip === null ? null : String(chip),
      gunTimeRaw: null,
      status: (f.ms === null ? 'dnf' : 'finished') as 'finished' | 'dnf',
      statusRaw: null,
      gender: f.gender, category: null, ageGroup: f.age,
      distanceMeters: over.distanceMeters !== undefined ? over.distanceMeters : 10_000,
      distanceRaw:    over.distanceRaw !== undefined ? over.distanceRaw : '10 Km',
      splits: over.splits ?? [],
      rawRow: { Bib: f.bib },
      sourceProvider: 'excel',
    }
  }

  /** Provider B's shape: 5 km and 10 km laps, with lap distance and lap time. */
  const providerBSplits = (chipMs: number): Split[] => [
    split(1, '5km',  5_000,  Math.round(chipMs * 0.494), '06:16:05', 5_000, Math.round(chipMs * 0.494)),
    split(2, '10km', 10_000, chipMs,                     '06:32:35', 5_000, chipMs - Math.round(chipMs * 0.494)),
  ]

  const create = (totalRows = FIELD.length, fileHash = 'h1') => svc.createImportSession({
    workspaceUid: UID, callerUid: ACTOR, eventId: EVENT, passId: PASS,
    fileName: 'results.xlsx', fileHash, provider: 'excel',
    mapping: { bibNumber: 'Bib Number', chipTime: 'Chip Time', distance: 'Distance' },
    totalRows,
  })
  const sid = (c: Awaited<ReturnType<typeof create>>) => (c.ok ? c.value.sessionId : '')
  const append = (s: string, rows: ReturnType<typeof row>[]) => svc.appendResults({ sessionId: s, workspaceUid: UID, results: rows })
  const doVerify = (s: string) => verify.verifySessionRegistrations({ sessionId: s, workspaceUid: UID })
  const doRank = async (s: string) => { for (;;) { const k = await svc.rankSessionChunk({ sessionId: s, workspaceUid: UID }); if (!k.ok) return k; if (k.value.done) return k } }
  const doSnap = async (s: string) => { for (;;) { const k = await snap.buildSnapshotChunk({ sessionId: s, workspaceUid: UID }); if (!k.ok) return k; if (k.value.done) return k } }
  const publish = (s: string) => svc.publishSession({ sessionId: s, workspaceUid: UID, callerUid: ACTOR })
  async function fullPublish(rows: ReturnType<typeof row>[], fileHash = 'h1'): Promise<number> {
    const s = sid(await create(rows.length, fileHash))
    const a = await append(s, rows); if (!a.ok) throw new Error(a.error)
    const v = await doVerify(s);     if (!v.ok) throw new Error(v.error)
    const r = await doRank(s);       if (!r.ok) throw new Error(r.error)
    const b = await doSnap(s);       if (!b.ok) throw new Error(`${b.status} ${b.error}`)
    const p = await publish(s);      if (!p.ok) throw new Error(`${p.status} ${p.error}`)
    return (await snapDoc()).version
  }

  const snapRef = () => adminDb.collection('raceResultSnapshots').doc(types.snapshotId(SLUG, PASS))
  const snapDoc = async () => (await snapRef().get()).data() as import('@/features/race-operations/types/snapshot').RaceSnapshotDoc
  const splitDocs = async () => (await snapRef().collection(types.SNAPSHOT_SPLITS_SUBCOLLECTION).get()).docs
  const entryDocs = async () => (await snapRef().collection('entries').get()).docs

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('Refusing to run outside a demo-* emulator project')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    svc = await import('@/features/race-operations/services/importService')
    snap = await import('@/features/race-operations/services/snapshotService')
    verify = await import('@/features/race-operations/services/registrationVerify')
    repo = await import('@/features/race-operations/repositories/snapshotRepo')
    pub = await import('@/features/race-operations/services/publicResults')
    cert = await import('@/features/race-operations/services/certificateResults')
    keys = await import('@/features/race-operations/utils/publicKeys')
    types = await import('@/features/race-operations/types/snapshot')
    perf = await import('@/features/race-operations/utils/performance')
    await cleanup().catch(() => null)
    await seed()
  }, T)
  afterAll(async () => { await cleanup() }, T)

  // ═══ identity ═══════════════════════════════════════════════════════════════
  it('resolves every result against the EXISTING registration and creates no participant', async () => {
    const before = (await adminDb.collection('registrations').where('organizerUid', '==', UID).get()).size
    const s = sid(await create())
    expect(await append(s, FIELD.map((f, i) => row(i, f))).then(r => r.ok)).toBe(true)

    const v = await doVerify(s)
    expect(v.ok && v.value.matched).toBe(FIELD.length)
    expect(v.ok && v.value.unknownRunner).toBe(0)
    expect(v.ok && v.value.wrongRace).toBe(0)
    expect(v.ok && v.value.blocking).toBe(false)

    const after = (await adminDb.collection('registrations').where('organizerUid', '==', UID).get()).size
    expect(after, 'a timing upload must never create a participant').toBe(before)
    // …and no second participant collection appeared either.
    for (const name of ['participants', 'runners', 'raceParticipants']) {
      expect((await adminDb.collection(name).limit(1).get()).size, name).toBe(0)
    }
  }, T)

  it('an unknown bib is refused by the start-list gate and cannot be published', async () => {
    const s = sid(await create(FIELD.length + 1, 'h-unknown'))
    const rows = [...FIELD.map((f, i) => row(i, f)), row(99, { bib: '99999', name: 'Ghost', gender: 'Male', age: 'x', ms: 600_000 })]
    expect(await append(s, rows).then(r => r.ok)).toBe(true)
    const v = await doVerify(s)
    expect(v.ok && v.value.unknownRunner).toBe(1)
    expect(v.ok && v.value.blocking).toBe(true)
    // Every later stage refuses: the gate is server-side, not a browser courtesy.
    expect((await doRank(s)).ok).toBe(false)
    expect((await doSnap(s)).ok).toBe(false)
    const p = await publish(s)
    expect(p.ok).toBe(false)
    expect(!p.ok && p.status).toBe(422)
  }, T)

  it('a duplicate bib is refused before a single row is stored', async () => {
    const s = sid(await create(2, 'h-dup'))
    const dup = await append(s, [row(0, FIELD[0]), { ...row(1, FIELD[0]), rowNumber: 3 }])
    expect(dup.ok).toBe(false)
    expect(!dup.ok && dup.status).toBe(409)
    expect((await adminDb.collection('raceImportSessions').doc(s).collection('results').count().get()).data().count).toBe(0)
  }, T)

  // ═══ persistence + ranking + public ═════════════════════════════════════════
  it('publishes distance, gender, age group, group ranks and checkpoints — and the public reads them', async () => {
    const rows = FIELD.map((f, i) => row(i, f, { splits: f.ms === null ? [] : providerBSplits(f.ms) }))
    const version = await fullPublish(rows, 'h-rich')
    expect(version).toBe(1)

    const doc = await snapDoc()
    expect(doc.totalCount).toBe(FIELD.length)
    expect(doc.finisherCount).toBe(FIELD.length - 1)       // one DNF

    // ── entries carry what used to be dropped at this boundary ──
    const entries = await entryDocs()
    expect(entries).toHaveLength(FIELD.length)
    const first = entries.map(d => d.data()).find(e => e.bibNumber === '10571')!
    expect(first).toMatchObject({
      v: version, gender: 'Male', ageGroup: 'Below 35yrs - Men',
      distanceMeters: 10_000, distanceRaw: '10 Km', overallRank: 1,
    })
    expect(first.rawRow, 'the organizer\'s original row must never reach a public document').toBeUndefined()

    // ── group ranks are RegisterDesk's own, with totals from the published set ──
    // 7 men and 5 women finished; 5 men were Below-35 and 3 women were Below-35.
    expect(first.genderRank).toBe(1)
    expect(first.genderTotal).toBe(6)                       // 7 men, one DNF ⇒ 6 finishers
    expect(first.ageGroupRank).toBe(1)
    expect(first.ageGroupTotal).toBe(3)                     // Below-35 men who finished
    const dnf = entries.map(d => d.data()).find(e => e.bibNumber === '10582')!
    expect(dnf.overallRank, 'a DNF is never ranked').toBeNull()
    expect(dnf.genderRank).toBeNull()
    expect(dnf.ageGroupRank).toBeNull()

    // the tie (10574, 10575 both 36:05) shares a rank in BOTH dimensions
    const tied = entries.map(d => d.data()).filter(e => e.bibNumber === '10574' || e.bibNumber === '10575')
    expect(new Set(tied.map(e => e.overallRank)).size).toBe(1)
    expect(new Set(tied.map(e => e.genderRank)).size).toBe(1)

    // ── checkpoints: one document per participant per version, finishers only ──
    const splits = await splitDocs()
    expect(splits).toHaveLength(FIELD.length - 1)
    expect(splits.every(d => d.id.startsWith(`v${version}__`))).toBe(true)
    const mine = splits.find(d => d.id === `v${version}__10571`)!.data()
    expect(mine.v).toBe(version)
    expect(mine.splits).toHaveLength(2)
    expect(mine.splits[1]).toMatchObject({ name: '10km', distanceMeters: 10_000, segmentMeters: 5_000 })

    // ── the public runner page ──
    const runner = await pub.getRunnerResult(SLUG, PASS_SLUG(), '10571')
    expect(runner).not.toBeNull()
    expect(runner!.result).toMatchObject({
      bibNumber: '10571', name: 'Sureshkumar V', overallRank: 1,
      gender: 'Male', ageGroup: 'Below 35yrs - Men', distanceMeters: 10_000,
      genderRank: 1, genderTotal: 6, ageGroupRank: 1, ageGroupTotal: 3,
    })
    // pace and speed are DERIVED — 10 km in 32:35
    expect(perf.formatPace(runner!.result.paceMsPerKm)).toBe('3:15')
    expect(perf.formatSpeed(runner!.result.speedKmh)).toBe('18.4 km/h')
    expect(runner!.splits).toHaveLength(2)
    expect(runner!.splits[0].name).toBe('5km')
    expect(perf.formatPace(runner!.splits[1].segmentPaceMsPerKm)).not.toBe('')
    // nothing organizer-private crosses the boundary
    for (const forbidden of ['organizerUid', 'eventId', 'sessionId', 'rawRow', 'bibKey']) {
      expect(Object.keys(runner!.result), forbidden).not.toContain(forbidden)
    }

    // ── existing consumers are untouched ──
    const c = await cert.resolveCertificateRaceResult({ eventSlug: SLUG, passId: PASS, bibNumber: '10571' })
    expect(c).toMatchObject({ distance: PASS_NAME, finishTime: '00:32:35', position: '1st' })
    const live = await repo.getLiveSnapshotByPass(SLUG, PASS)
    const page = await repo.fetchLeaderboardPage(live!.snapshotId, live!.version, 50, null)
    expect(page.rows).toHaveLength(FIELD.length - 1)        // DNF has no rank ⇒ not on the leaderboard
    expect(page.rows[0].bibNumber).toBe('10571')
  }, T)

  it('a provider rank column is never stored as the published rank', async () => {
    // The published rank comes from the chip times alone: bib 10582 has the WORST time of the
    // finishers here, so whatever a provider claimed, RegisterDesk ranks it last.
    const rows = FIELD.filter(f => f.ms !== null).map((f, i) => row(i, f))
    const version = await fullPublish(rows, 'h-noprovider')
    const entries = (await entryDocs()).map(d => d.data()).filter(e => e.v === version)
    const byRank = entries.filter(e => e.overallRank !== null).sort((a, b) => a.overallRank! - b.overallRank!)
    expect(byRank[0].bibNumber).toBe('10571')
    expect(byRank[byRank.length - 1].bibNumber).toBe('10581')
    for (const e of entries) {
      expect(Object.keys(e)).not.toContain('providerRank')
      expect(Object.keys(e)).not.toContain('pace')
      expect(Object.keys(e)).not.toContain('speed')
    }
  }, T)

  // ═══ versioning ═════════════════════════════════════════════════════════════
  it('splits are snapshot-versioned: v(n+1) never shows v(n) checkpoints, and rollback restores them', async () => {
    // Self-contained: this test publishes its OWN splits-bearing version first, rather than
    // assuming the version an earlier test left live carries checkpoints — one of them
    // deliberately publishes a race with none.
    const baseline = FIELD.filter(f => f.ms !== null).map((f, i) => row(i, f, { splits: providerBSplits(f.ms!) }))
    const oldVersion = await fullPublish(baseline, 'h-versioned-base')
    const oldSplits = (await splitDocs()).filter(d => d.id.startsWith(`v${oldVersion}__`)).length
    expect(oldSplits).toBe(baseline.length)

    // Republish with DIFFERENT checkpoints and times.
    const corrected = FIELD.filter(f => f.ms !== null).slice(0, 5).map((f, i) =>
      row(i, f, { shiftMs: 60_000, splits: [split(1, '5km', 5_000, 900_000, '06:20:00'), split(2, '10km', 10_000, f.ms! + 60_000, '06:40:00')] }))
    const newVersion = await fullPublish(corrected, 'h-v2')
    expect(newVersion).toBe(oldVersion + 1)

    // Both versions' documents coexist; the ids keep them apart.
    const all = await splitDocs()
    expect(all.filter(d => d.id.startsWith(`v${oldVersion}__`)).length).toBe(oldSplits)
    expect(all.filter(d => d.id.startsWith(`v${newVersion}__`)).length).toBe(5)

    // The public reads ONLY the live version.
    const runner = await pub.getRunnerResult(SLUG, PASS_SLUG(), '10571')
    expect(runner!.splits[0].cumulativeTimeMs).toBe(900_000)
    expect(runner!.splits[1].cumulativeTimeMs).toBe(FIELD[0].ms! + 60_000)
    expect(runner!.result.chipTimeMs).toBe(FIELD[0].ms! + 60_000)

    // A version that is not live is unreachable, even by asking for it directly.
    const live = await repo.getLiveSnapshotByPass(SLUG, PASS)
    const stale = await repo.fetchSplitsByBib(live!.snapshotId, oldVersion, '10571')
    expect(stale[1].cumulativeTimeMs, 'the OLD version still has its own data').toBe(FIELD[0].ms!)

    // ── rollback ──
    const rb = await repo.rollbackSnapshot({ eventSlug: SLUG, passId: PASS, organizerUid: UID, toVersion: oldVersion, actorUid: ACTOR })
    expect(rb.ok).toBe(true)
    const restored = await pub.getRunnerResult(SLUG, PASS_SLUG(), '10571')
    expect(restored!.result.chipTimeMs).toBe(FIELD[0].ms!)
    expect(restored!.splits[1].cumulativeTimeMs).toBe(FIELD[0].ms!)
    expect(restored!.splits).toHaveLength(2)
    // a runner dropped by the correction is back, with their own checkpoints
    const dropped = await pub.getRunnerResult(SLUG, PASS_SLUG(), '10581')
    expect(dropped).not.toBeNull()
    expect(dropped!.splits.length).toBeGreaterThan(0)
  }, T)

  it('an abandoned build\'s checkpoints never become public', async () => {
    const liveBefore = (await snapDoc()).version
    const abandoned = sid(await create(3, 'h-abandoned'))
    const rows = FIELD.slice(0, 3).map((f, i) => row(i, f, { shiftMs: 5_000, splits: [split(1, '5km', 5_000, 111_000)] }))
    expect((await append(abandoned, rows)).ok).toBe(true)
    expect((await doVerify(abandoned)).ok).toBe(true)
    expect((await doRank(abandoned)).ok).toBe(true)
    const built = await doSnap(abandoned)
    expect(built.ok).toBe(true)
    const buildingVersion = built.ok ? built.value.version : -1
    expect(buildingVersion).toBeGreaterThan(liveBefore)

    // The documents exist…
    expect((await splitDocs()).some(d => d.id === `v${buildingVersion}__10571`)).toBe(true)
    // …and the public still sees the live version, not the build.
    expect((await snapDoc()).version).toBe(liveBefore)
    const runner = await pub.getRunnerResult(SLUG, PASS_SLUG(), '10571')
    expect(runner!.splits[0].cumulativeTimeMs).not.toBe(111_000)
  }, T)

  // ═══ lifecycle guards, with splits in play ══════════════════════════════════
  it('stale publish, duplicate publish and an incomplete snapshot are all still refused', async () => {
    const liveBefore = (await snapDoc()).version

    const a = sid(await create(4, 'h-stale-a'))
    expect((await append(a, FIELD.slice(0, 4).map((f, i) => row(i, f, { splits: providerBSplits(f.ms ?? 600_000) })))).ok).toBe(true)
    expect((await doVerify(a)).ok).toBe(true); expect((await doRank(a)).ok).toBe(true); expect((await doSnap(a)).ok).toBe(true)

    const b = sid(await create(5, 'h-stale-b'))
    expect((await append(b, FIELD.slice(0, 5).map((f, i) => row(i, f, { shiftMs: 2_000 })))).ok).toBe(true)
    expect((await doVerify(b)).ok).toBe(true); expect((await doRank(b)).ok).toBe(true); expect((await doSnap(b)).ok).toBe(true)
    expect((await publish(b)).ok).toBe(true)

    const stale = await publish(a)
    expect(stale.ok).toBe(false)
    expect(!stale.ok && stale.status).toBe(409)
    expect((await snapDoc()).version).toBeGreaterThan(liveBefore)

    // two simultaneous publishes of one session → exactly one winner
    const c = sid(await create(4, 'h-concurrent'))
    expect((await append(c, FIELD.slice(0, 4).map((f, i) => row(i, f, { shiftMs: 4_000 })))).ok).toBe(true)
    expect((await doVerify(c)).ok).toBe(true); expect((await doRank(c)).ok).toBe(true); expect((await doSnap(c)).ok).toBe(true)
    const [p1, p2] = await Promise.all([publish(c), publish(c)])
    expect([p1.ok, p2.ok].filter(Boolean)).toHaveLength(1)

    // an incomplete pending snapshot cannot go live
    const d = sid(await create(4, 'h-incomplete'))
    expect((await append(d, FIELD.slice(0, 4).map((f, i) => row(i, f, { shiftMs: 6_000 })))).ok).toBe(true)
    expect((await doVerify(d)).ok).toBe(true); expect((await doRank(d)).ok).toBe(true)
    const one = await snap.buildSnapshotChunk({ sessionId: d, workspaceUid: UID, afterRowNumber: null })
    expect(one.ok).toBe(true)
    await snapRef().update({ pendingTotalCount: 1 })
    const incomplete = await publish(d)
    expect(incomplete.ok).toBe(false)
    expect(!incomplete.ok && incomplete.error).toMatch(/incomplete|Rebuild/i)
  }, T)

  it('the server drops a duplicate or timeless checkpoint even when the browser did not', async () => {
    const s = sid(await create(1, 'h-sanitize'))
    const crafted = [{
      ...row(0, FIELD[0]),
      splits: [
        split(1, '5km', 5_000, 900_000),
        split(2, '5 KM', 5_000, 950_000),    // same checkpoint, different time
        split(3, '10km', 10_000, null),      // no time at all
        split(4, '15km', 15_000, 1_500_000),
      ],
    }]
    expect((await append(s, crafted)).ok).toBe(true)
    const stored = (await adminDb.collection('raceImportSessions').doc(s).collection('results').get()).docs[0].data()
    expect(stored.splits).toHaveLength(2)
    expect(stored.splits.map((x: { name: string }) => x.name)).toEqual(['5km', '15km'])
    expect(stored.splits.map((x: { sequence: number }) => x.sequence)).toEqual([1, 2])
  }, T)

  // ═══ backward compatibility ═════════════════════════════════════════════════
  it('a race with no distance and no checkpoints publishes and reads exactly as before', async () => {
    const rows = FIELD.filter(f => f.ms !== null).slice(0, 4).map((f, i) =>
      row(i, f, { shiftMs: 8_000, distanceMeters: null, distanceRaw: null, splits: [] }))
    const version = await fullPublish(rows, 'h-plain')

    expect((await splitDocs()).filter(d => d.id.startsWith(`v${version}__`))).toHaveLength(0)
    const runner = await pub.getRunnerResult(SLUG, PASS_SLUG(), '10571')
    expect(runner!.splits).toEqual([])
    expect(runner!.result.distanceMeters).toBeNull()
    expect(runner!.result.paceMsPerKm, 'no distance ⇒ no pace, never a zero').toBeNull()
    expect(runner!.result.speedKmh).toBeNull()
    expect(runner!.result.overallRank).toBe(1)
    expect(runner!.result.genderRank).toBe(1)              // groups still work without a distance
  }, T)

  it('an entry written before this sprint still reads — every new field is optional', async () => {
    const live = await repo.getLiveSnapshotByPass(SLUG, PASS)
    // A legacy-shaped entry: no gender, no distance, no group ranks, and the bare-bib id.
    await snapRef().collection('entries').doc(`v${live!.version}__10999`).set({
      v: live!.version, bibNumber: '10999', bibKey: '10999', name: 'Legacy Runner', nameLower: 'legacy runner',
      chipTimeMs: 3_000_000, gunTimeMs: null, status: 'finished', overallRank: 99, passRank: 99,
    })
    const runner = await pub.getRunnerResult(SLUG, PASS_SLUG(), '10999')
    expect(runner).not.toBeNull()
    expect(runner!.result).toMatchObject({ bibNumber: '10999', overallRank: 99, gender: null, ageGroup: null, distanceMeters: null, genderRank: null, genderTotal: null })
    expect(runner!.result.paceMsPerKm).toBeNull()
    expect(runner!.splits).toEqual([])
  }, T)
})
