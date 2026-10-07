// RD-RACEOPS-02G · Snapshot version allocation after rollback — REAL Firestore (emulator),
// through the real services. Nothing in the repository layer is faked.
//
// 02F reproduced a P1: the next snapshot version was `doc.version + 1` off the LIVE
// pointer, so after `live v6 → rollback → v4` a correction was built as v5 — a namespace
// that already had entries. The public leaderboard served the union (120 rows against a
// totalCount of 60), and a second run overwrote PUBLISHED v6 and left `versions[]` with two
// v6 records. Every scenario here would have corrupted data before this sprint.
//
//   1  rollback → republish            v7, never v5; entries(v7) == totalCount; public == v7
//   2  abandoned-lane collision        the exact 02F shape: history [1,3,4,6], lane v5, live v4
//   3  published-version collision     live v5, published v6 → v7; v6 byte-for-byte intact
//   4  repeated rollback               [1,2,3,4] → rb 2 → v5 → rb 3 → v6
//   5  concurrent allocation           two builds race: distinct versions, one owner
//   6  rollback + concurrent builds    the pointer moves while two lanes are claimed
//   7  duplicate versions[] defense    build, publish and rollback all fail closed
//   8  historical immutability         (inside 3 and 6)
//   9  public consistency              leaderboard, participant, certificate, badge, export
//  10  stale tab                       409 preserved; the loser rebuilds into a NEW version

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000

describeEmu('RD-RACEOPS-02G · snapshot version allocation survives rollback', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let svc: typeof import('@/features/race-operations/services/importService')
  let snap: typeof import('@/features/race-operations/services/snapshotService')
  let verify: typeof import('@/features/race-operations/services/registrationVerify')
  let repo: typeof import('@/features/race-operations/repositories/snapshotRepo')
  let pub: typeof import('@/features/race-operations/services/publicResults')
  let cert: typeof import('@/features/race-operations/services/certificateResults')
  let keys: typeof import('@/features/race-operations/utils/publicKeys')
  let types: typeof import('@/features/race-operations/types/snapshot')

  const UID = `emu-vers-${process.pid}`, ACTOR = 'vers-actor'
  const EVENT = `evt_vers_${process.pid}`, SLUG = `evt-vers-${process.pid}`
  const PASSES = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'] as const
  type Pass = typeof PASSES[number]
  const PASS_NAME = (p: Pass) => `${p.toUpperCase()} 10K`
  // Bibs are unique across the EVENT (the roster check reads them that way), so each pass
  // gets its own hundred: p1 → 101–112, p2 → 201–212, …
  const bibsOf = (pass: Pass) => Array.from({ length: 12 }, (_, i) => String((PASSES.indexOf(pass) + 1) * 100 + 1 + i))

  async function seed() {
    const b = adminDb.batch()
    b.set(adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`), { eventType: 'sports', eventDetails: { seo: { urlSlug: SLUG }, info: { name: 'Versions 10K' }, schedule: { startDate: '2026-03-01' } } })
    b.set(adminDb.doc(`events/${SLUG}`), { uid: UID, draftId: EVENT, eventSlug: SLUG, lifecycleStatus: 'published', eventDetails: { info: { name: 'Versions 10K' } }, pricing: { passes: PASSES.map(id => ({ id, name: PASS_NAME(id) })) } })
    for (const pass of PASSES) for (const bib of bibsOf(pass)) {
      b.set(adminDb.doc(`registrations/vers_${process.pid}_${pass}_${bib}`), { organizerUid: UID, eventSlug: SLUG, passId: pass, status: 'confirmed', bibNumber: bib, attendee: { name: `Athlete ${bib}` } })
    }
    await b.commit()
  }
  async function cleanup() {
    const del = async (refs: FirebaseFirestore.DocumentReference[]) => { for (let i = 0; i < refs.length; i += 400) { const b = adminDb.batch(); refs.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit() } }
    const sessions = await adminDb.collection('raceImportSessions').where('organizerUid', '==', UID).get()
    for (const s of sessions.docs) { await del(await s.ref.collection('results').listDocuments()); await s.ref.delete() }
    for (const pass of PASSES) { const r = adminDb.collection('raceResultSnapshots').doc(types.snapshotId(SLUG, pass)); await del(await r.collection('entries').listDocuments()); await r.delete().catch(() => null) }
    await del((await adminDb.collection('registrations').where('organizerUid', '==', UID).get()).docs.map(d => d.ref))
    await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).delete().catch(() => null)
    await adminDb.doc(`events/${SLUG}`).delete().catch(() => null)
  }

  // ── drivers through the REAL services ───────────────────────────────────────
  // 30:00 + 10 s per row + a per-version shift of whole seconds, so `chipTimeMs % 10_000`
  // reads back which version's build wrote an entry.
  const ms = (i: number, shift: number) => 30 * 60_000 + i * 10_000 + shift
  const row = (n: number, bib: string, t: number) => ({
    rowNumber: n, participantName: `Athlete ${bib}`, bibNumber: bib, chipTimeMs: t, gunTimeMs: null,
    chipTimeRaw: String(t), gunTimeRaw: null, status: 'finished' as const, statusRaw: null,
    gender: null, category: null, ageGroup: null, rawRow: { Bib: bib, Time: String(t) }, sourceProvider: 'csv',
  })
  /** A new draft session with `bibs` stored, every time shifted by `shift` ms so versions differ. */
  async function newSession(pass: Pass, bibs: readonly string[] = bibsOf(pass), shift = 0): Promise<string> {
    const c = await svc.createImportSession({ workspaceUid: UID, callerUid: ACTOR, eventId: EVENT, passId: pass, fileName: 'r.csv', fileHash: `h${shift}`, provider: 'csv', mapping: { bibNumber: 'Bib', chipTime: 'Time' }, totalRows: bibs.length })
    if (!c.ok) throw new Error(c.error)
    const a = await svc.appendResults({ sessionId: c.value.sessionId, workspaceUid: UID, results: bibs.map((b, i) => row(i + 2, b, ms(i, shift))) })
    if (!a.ok) throw new Error(a.error)
    return c.value.sessionId
  }
  async function verifyAndRank(sid: string) {
    const v = await verify.verifySessionRegistrations({ sessionId: sid, workspaceUid: UID }); if (!v.ok) throw new Error(v.error)
    for (;;) { const k = await svc.rankSessionChunk({ sessionId: sid, workspaceUid: UID }); if (!k.ok) throw new Error(k.error); if (k.value.done) break }
  }
  const buildChunk = (sid: string) => snap.buildSnapshotChunk({ sessionId: sid, workspaceUid: UID })
  async function buildAll(sid: string): Promise<number> {
    for (;;) { const s = await buildChunk(sid); if (!s.ok) throw new Error(`${s.status} ${s.error}`); if (s.value.done) return s.value.version }
  }
  const publish = (sid: string) => svc.publishSession({ sessionId: sid, workspaceUid: UID, callerUid: ACTOR })
  /** create → append → verify → rank → snapshot → publish. Returns the live version. */
  async function publishFresh(pass: Pass, bibs: readonly string[] = bibsOf(pass), shift = 0): Promise<number> {
    const sid = await newSession(pass, bibs, shift); await verifyAndRank(sid); await buildAll(sid)
    const p = await publish(sid); if (!p.ok) throw new Error(`${p.status} ${p.error}`)
    return (await doc(pass)).version
  }
  const rollback = (pass: Pass, toVersion: number) => repo.rollbackSnapshot({ eventSlug: SLUG, passId: pass, organizerUid: UID, toVersion, actorUid: ACTOR })

  // ── inspection ──────────────────────────────────────────────────────────────
  const snapRef = (pass: Pass) => adminDb.collection('raceResultSnapshots').doc(types.snapshotId(SLUG, pass))
  const doc = async (pass: Pass) => (await snapRef(pass).get()).data() as import('@/features/race-operations/types/snapshot').RaceSnapshotDoc
  const versionList = (d: { versions?: { version: number }[] }) => (d.versions ?? []).map(v => v.version)
  /** Every entry written under `v`, keyed by bib, with the Firestore id — the full namespace. */
  async function entries(pass: Pass, v: number): Promise<Record<string, Record<string, unknown>>> {
    const s = await snapRef(pass).collection('entries').where('v', '==', v).get()
    const out: Record<string, Record<string, unknown>> = {}
    for (const d of s.docs) out[d.id] = d.data()
    return out
  }
  /** Public leaderboard, every page, through the real public service. */
  async function publicRows(pass: Pass) {
    const passSlug = keys.passSlug(PASS_NAME(pass), pass)
    const rows: { bibNumber: string; chipTimeMs: number | null }[] = []
    let cursor: import('@/features/race-operations/utils/publicKeys').LeaderboardCursor | null = null
    for (;;) {
      const page = await pub.getLeaderboard(SLUG, passSlug, cursor); if (!page) throw new Error('not live')
      rows.push(...page.rows.map(r => ({ bibNumber: r.bibNumber, chipTimeMs: r.chipTimeMs })))
      if (!page.nextCursor) return { rows, totalCount: page.race.totalCount, version: (await doc(pass)).version }
      cursor = page.nextCursor
    }
  }
  const expectUniqueHistory = (d: { versions?: { version: number }[] }) => {
    const list = versionList(d); expect(new Set(list).size, `versions ${JSON.stringify(list)} has a duplicate`).toBe(list.length)
  }

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
    await cleanup().catch(() => null)
    await seed()
  }, T)
  afterAll(async () => { await cleanup() }, T)

  // ═══ 1 + 9 · rollback → republish, and every public consumer follows ═════════
  it('1 · rollback 6→4 then a correction publishes as v7 — never v5 — and the public sees only v7', async () => {
    const pass: Pass = 'p1'
    for (let v = 1; v <= 6; v++) expect(await publishFresh(pass, bibsOf(pass), v * 1_000)).toBe(v)
    let d = await doc(pass)
    expect(versionList(d)).toEqual([1, 2, 3, 4, 5, 6]); expect(d.maxVersion).toBe(6)

    const rb = await rollback(pass, 4); expect(rb.ok).toBe(true)
    d = await doc(pass)
    expect(d.version).toBe(4)
    expect(d.maxVersion, 'rollback must not lower the allocator').toBe(6)
    expect(versionList(d)).toEqual([1, 2, 3, 4, 5, 6])

    // The correction drops half the field, so a namespace collision would be visible as
    // extra rows — exactly what 02F saw (120 rows against a totalCount of 60).
    const corrected = bibsOf(pass).slice(0, 6)
    const sid = await newSession(pass, corrected, 7_000); await verifyAndRank(sid)
    const first = await buildChunk(sid); expect(first.ok).toBe(true)
    expect(first.ok && first.value.version, 'allocation after rollback').toBe(7)
    await buildAll(sid)
    const p = await publish(sid); expect(p.ok, JSON.stringify(p)).toBe(true)

    d = await doc(pass)
    expect(d.version).toBe(7); expect(d.maxVersion).toBe(7); expect(d.totalCount).toBe(6)
    expect(versionList(d)).toEqual([1, 2, 3, 4, 5, 6, 7]); expectUniqueHistory(d)

    const v7 = await entries(pass, 7)
    expect(Object.keys(v7).length, 'entries(v7) == totalCount').toBe(d.totalCount)
    expect(Object.keys(v7).sort()).toEqual(corrected.map(b => keys.entryKey(7, b)).sort())
    for (const e of Object.values(v7)) expect((e.chipTimeMs as number) % 10_000, 'every v7 entry carries the correction shift').toBe(7_000)

    // 9 · public consistency — leaderboard, participant, certificate, badge, export
    const publicView = await publicRows(pass)
    expect(publicView.version).toBe(7)
    expect(publicView.totalCount).toBe(6)
    expect(publicView.rows.map(r => r.bibNumber).sort()).toEqual([...corrected].sort())
    for (const r of publicView.rows) expect((r.chipTimeMs ?? 0) % 10_000).toBe(7_000)

    const passSlug = keys.passSlug(PASS_NAME(pass), pass)
    const kept = await pub.getRunnerResult(SLUG, passSlug, '101')
    expect(kept?.result.chipTimeMs).toBe(ms(0, 7_000))
    expect(await pub.getRunnerResult(SLUG, passSlug, '112'), 'a bib dropped by the correction is gone').toBeNull()

    const c = await cert.resolveCertificateRaceResult({ eventSlug: SLUG, passId: pass, bibNumber: '101' })
    expect(c.finishTime).toBe('00:30:07')
    const gone = await cert.resolveCertificateRaceResult({ eventSlug: SLUG, passId: pass, bibNumber: '112' })
    expect(gone.finishTime).toBe('')

    // badge read path: getLiveSnapshot(eventSlug, passSlug) + fetchByBib(id, version, bibKey)
    const badgeSnap = await repo.getLiveSnapshot(SLUG, passSlug); expect(badgeSnap?.version).toBe(7)
    const badgeRow = await repo.fetchByBib(badgeSnap!.snapshotId, badgeSnap!.version, keys.bibKey('101'))
    expect(badgeRow?.chipTimeMs).toBe(ms(0, 7_000))
    expect(await repo.fetchByBib(badgeSnap!.snapshotId, badgeSnap!.version, keys.bibKey('112'))).toBeNull()

    // export read path: getLiveSnapshotByPass + fetchLeaderboardPage
    const exportSnap = await repo.getLiveSnapshotByPass(SLUG, pass); expect(exportSnap?.version).toBe(7)
    const exportPage = await repo.fetchLeaderboardPage(exportSnap!.snapshotId, exportSnap!.version, 500, null)
    expect(exportPage.rows.map(r => r.bibNumber).sort()).toEqual([...corrected].sort())
    expect(exportPage.nextCursor).toBeNull()
  }, T)

  // ═══ 2 · the exact 02F shape ══════════════════════════════════════════════════
  it('2 · abandoned lane v5 + live v4 (history [1,3,4,6]) → the correction is v7, v5 is untouched', async () => {
    const pass: Pass = 'p2'
    expect(await publishFresh(pass, bibsOf(pass), 1_000)).toBe(1)
    const abandoned2 = await newSession(pass, bibsOf(pass), 2_000); await verifyAndRank(abandoned2); expect(await buildAll(abandoned2)).toBe(2)   // never published
    expect(await publishFresh(pass, bibsOf(pass), 3_000)).toBe(3)
    expect(await publishFresh(pass, bibsOf(pass), 4_000)).toBe(4)
    const abandoned5 = await newSession(pass, bibsOf(pass), 5_000); await verifyAndRank(abandoned5); expect(await buildAll(abandoned5)).toBe(5)   // never published
    expect(await publishFresh(pass, bibsOf(pass), 6_000)).toBe(6)

    let d = await doc(pass)
    expect(versionList(d)).toEqual([1, 3, 4, 6]); expect(d.maxVersion).toBe(6)
    const rb = await rollback(pass, 4); expect(rb.ok).toBe(true)
    d = await doc(pass); expect(d.version).toBe(4); expect(d.maxVersion).toBe(6)

    const v5Before = await entries(pass, 5); expect(Object.keys(v5Before).length).toBe(12)

    const corrected = bibsOf(pass).slice(0, 6)
    const sid = await newSession(pass, corrected, 7_000); await verifyAndRank(sid)
    const first = await buildChunk(sid); expect(first.ok && first.value.version, 'must not be v5').toBe(7)
    await buildAll(sid)
    const p = await publish(sid); expect(p.ok, JSON.stringify(p)).toBe(true)

    d = await doc(pass)
    expect(d.version).toBe(7); expect(d.totalCount).toBe(6); expect(d.maxVersion).toBe(7)
    expect(versionList(d)).toEqual([1, 3, 4, 6, 7]); expectUniqueHistory(d)
    expect(await entries(pass, 5), 'the abandoned lane is exactly as it was').toEqual(v5Before)
    const v7 = await entries(pass, 7)
    expect(Object.keys(v7).length).toBe(6)
    for (const e of Object.values(v7)) expect((e.chipTimeMs as number) % 10_000).toBe(7_000)
    const publicView = await publicRows(pass)
    expect(publicView.rows.length, '02F served 120 rows against a totalCount of 60').toBe(6)
    expect(publicView.rows.map(r => r.bibNumber).sort()).toEqual([...corrected].sort())
  }, T)

  // ═══ 3 + 8 · collision with a PUBLISHED version; history immutable ═══════════
  it('3 · live v5 with published v6 → the correction is v7; v6 is value-identical before and after', async () => {
    const pass: Pass = 'p3'
    for (let v = 1; v <= 6; v++) expect(await publishFresh(pass, bibsOf(pass), v * 1_000)).toBe(v)
    const rb = await rollback(pass, 5); expect(rb.ok).toBe(true)
    const v6Before = await entries(pass, 6); expect(Object.keys(v6Before).length).toBe(12)
    const historyBefore = (await doc(pass)).versions

    const sid = await newSession(pass, bibsOf(pass), 7_000); await verifyAndRank(sid)
    const first = await buildChunk(sid); expect(first.ok && first.value.version, 'must not be v6').toBe(7)
    await buildAll(sid)
    expect(await entries(pass, 6), 'building v7 must not touch v6').toEqual(v6Before)
    const p = await publish(sid); expect(p.ok, JSON.stringify(p)).toBe(true)

    const d = await doc(pass)
    expect(d.version).toBe(7)
    expect(versionList(d)).toEqual([1, 2, 3, 4, 5, 6, 7]); expectUniqueHistory(d)
    expect(versionList(d).filter(v => v === 6).length, 'exactly one v6 record').toBe(1)
    expect(d.versions!.slice(0, 6), 'earlier records are untouched (restoredAt aside)').toEqual(historyBefore)
    expect(await entries(pass, 6), 'publishing v7 must not touch v6').toEqual(v6Before)
    // and v6 is still restorable, with its own counts and rows
    const back = await rollback(pass, 6); expect(back.ok).toBe(true)
    const publicView = await publicRows(pass)
    expect(publicView.version).toBe(6); expect(publicView.rows.length).toBe(12)
    for (const r of publicView.rows) expect((r.chipTimeMs ?? 0) % 10_000).toBe(6_000)
  }, T)

  // ═══ 4 · repeated rollback ═══════════════════════════════════════════════════
  it('4 · [1,2,3,4] → rollback 2 → v5 → rollback 3 → v6; nothing reused', async () => {
    const pass: Pass = 'p4'
    for (let v = 1; v <= 4; v++) expect(await publishFresh(pass, bibsOf(pass), v * 1_000)).toBe(v)
    expect((await rollback(pass, 2)).ok).toBe(true)
    expect(await publishFresh(pass, bibsOf(pass), 5_000)).toBe(5)
    expect((await rollback(pass, 3)).ok).toBe(true)
    expect(await publishFresh(pass, bibsOf(pass), 6_000)).toBe(6)
    const d = await doc(pass)
    expect(versionList(d)).toEqual([1, 2, 3, 4, 5, 6]); expectUniqueHistory(d)
    expect(d.version).toBe(6); expect(d.maxVersion).toBe(6)
    for (let v = 1; v <= 6; v++) {
      const ns = await entries(pass, v); expect(Object.keys(ns).length, `v${v} namespace`).toBe(12)
      for (const e of Object.values(ns)) expect((e.chipTimeMs as number) % 10_000, `v${v} holds only its own rows`).toBe(v * 1_000)
    }
  }, T)

  // ═══ 5 · concurrent allocation ═══════════════════════════════════════════════
  it('5 · two builds racing for the same race receive distinct versions; one owns the lane, the other rebuilds into a fresh one', async () => {
    const pass: Pass = 'p5'
    expect(await publishFresh(pass, bibsOf(pass), 1_000)).toBe(1)
    expect(await publishFresh(pass, bibsOf(pass), 2_000)).toBe(2)
    const a = await newSession(pass, bibsOf(pass), 3_000); await verifyAndRank(a)
    const b = await newSession(pass, bibsOf(pass), 4_000); await verifyAndRank(b)

    const [ra, rb] = await Promise.all([buildChunk(a), buildChunk(b)])
    // A chunk that lost the lane between its claim and its credit reports 409; a chunk
    // that kept it reports its version. Either way no number is handed out twice.
    for (const r of [ra, rb]) if (!r.ok) expect(r.status).toBe(409)
    const claimed = [ra, rb].filter(r => r.ok).map(r => (r as { ok: true; value: { version: number } }).value.version)
    expect(new Set(claimed).size).toBe(claimed.length)

    let d = await doc(pass)
    expect(d.maxVersion, 'two allocations happened').toBe(4)
    expect([3, 4]).toContain(d.pendingVersion)
    expect([a, b]).toContain(d.pendingSessionId)
    // Both namespaces were written, and each by ONE session only. Which session got v3 is
    // whichever transaction committed first — the invariant is that they differ.
    const v3 = await entries(pass, 3), v4 = await entries(pass, 4)
    const writers = (ns: Record<string, Record<string, unknown>>) => new Set(Object.values(ns).map(e => (e.chipTimeMs as number) % 10_000))
    expect(Object.keys(v3).length).toBe(12); expect(Object.keys(v4).length).toBe(12)
    expect(writers(v3).size).toBe(1); expect(writers(v4).size).toBe(1)
    expect(new Set([...writers(v3), ...writers(v4)])).toEqual(new Set([3_000, 4_000]))

    const owner = d.pendingSessionId === a ? a : b, loser = owner === a ? b : a
    const ownerVersion = await buildAll(owner)
    expect(ownerVersion).toBe(d.pendingVersion)
    expect((await publish(owner)).ok).toBe(true)
    const lost = await publish(loser); expect(lost.ok).toBe(false); expect(lost.ok || lost.status).toBe(409)
    // the loser rebuilds — into a NEW version, never back into the one it lost
    expect(await buildAll(loser)).toBe(5)
    expect((await publish(loser)).ok).toBe(true)
    d = await doc(pass)
    expect(d.version).toBe(5); expect(d.maxVersion).toBe(5)
    expect(versionList(d)).toEqual([1, 2, ownerVersion, 5]); expectUniqueHistory(d)
  }, T)

  // ═══ 6 · rollback while two builds allocate ══════════════════════════════════
  it('6 · a rollback racing two new builds: the pointer moves, both lanes are above the allocator, history untouched', async () => {
    const pass: Pass = 'p6'
    for (let v = 1; v <= 3; v++) expect(await publishFresh(pass, bibsOf(pass), v * 1_000)).toBe(v)
    const before = { v1: await entries(pass, 1), v2: await entries(pass, 2), v3: await entries(pass, 3) }
    const a = await newSession(pass, bibsOf(pass), 4_000); await verifyAndRank(a)
    const b = await newSession(pass, bibsOf(pass), 5_000); await verifyAndRank(b)

    const [rb, ra, rbb] = await Promise.all([rollback(pass, 1), buildChunk(a), buildChunk(b)])
    expect(rb.ok, JSON.stringify(rb)).toBe(true)
    for (const r of [ra, rbb]) if (!r.ok) expect(r.status).toBe(409)

    let d = await doc(pass)
    expect(d.version, 'rollback landed').toBe(1)
    expect(d.maxVersion, 'both allocations landed above everything').toBe(5)
    expect([4, 5]).toContain(d.pendingVersion)
    expect(versionList(d)).toEqual([1, 2, 3]); expectUniqueHistory(d)
    expect(await entries(pass, 1)).toEqual(before.v1)
    expect(await entries(pass, 2)).toEqual(before.v2)
    expect(await entries(pass, 3)).toEqual(before.v3)

    const owner = d.pendingSessionId === a ? a : b
    const ownerVersion = await buildAll(owner)
    expect((await publish(owner)).ok).toBe(true)
    d = await doc(pass)
    expect(d.version).toBe(ownerVersion)
    expect(versionList(d)).toEqual([1, 2, 3, ownerVersion]); expectUniqueHistory(d)
    expect(await entries(pass, 3), 'publishing after the race left v3 intact').toEqual(before.v3)
  }, T)

  // ═══ 7 · duplicate versions[] defense ════════════════════════════════════════
  it('7 · a history with a duplicate record: build, publish and rollback all fail closed; nothing is appended, the pointer stays', async () => {
    const pass: Pass = 'p7'
    expect(await publishFresh(pass, bibsOf(pass), 1_000)).toBe(1)
    expect(await publishFresh(pass, bibsOf(pass), 2_000)).toBe(2)
    const clean = await doc(pass)
    // Corrupt the document the way 02F's second run did: a second v2 record.
    await snapRef(pass).update({ versions: [...clean.versions!, { ...clean.versions![1] }] })

    // build → fails closed at allocation
    const sid = await newSession(pass, bibsOf(pass), 3_000); await verifyAndRank(sid)
    const built = await buildChunk(sid)
    expect(built.ok).toBe(false)
    expect(!built.ok && built.status).toBe(409)
    expect(!built.ok && built.error).toMatch(/inconsistent/)

    // publish → fails closed inside the go-live transaction, even with a lane hand-seeded
    // to look complete (bypassing the build)
    await snapRef(pass).update({ pendingVersion: 3, pendingSessionId: sid, pendingTotalCount: 12, pendingFinisherCount: 12, pendingCursor: null })
    const p = await publish(sid)
    expect(p.ok).toBe(false)
    expect(!p.ok && p.status).toBe(409)
    expect(!p.ok && p.error).toMatch(/inconsistent/)

    // rollback → refuses to guess between two v2 records
    const rb = await rollback(pass, 1)
    expect(rb.ok).toBe(false)
    expect(!rb.ok && rb.status).toBe(409)

    let d = await doc(pass)
    expect(d.version, 'live pointer unchanged').toBe(2)
    expect(versionList(d), 'nothing appended').toEqual([1, 2, 2])
    expect((await adminDb.collection('raceImportSessions').doc(sid).get()).data()!.status, 'the session was not flipped').toBe('draft')

    // Repair the history, then prove the second defense: a lane whose number already went
    // live is refused too, without a duplicate record.
    await snapRef(pass).update({ versions: clean.versions, pendingVersion: 2, pendingSessionId: sid, pendingTotalCount: 12, pendingFinisherCount: 12 })
    const dup = await publish(sid)
    expect(dup.ok).toBe(false)
    expect(!dup.ok && dup.status).toBe(409)
    expect(!dup.ok && dup.error).toMatch(/already been published/)
    d = await doc(pass)
    expect(d.version).toBe(2); expect(versionList(d)).toEqual([1, 2])
  }, T)

  // ═══ 10 · stale tab ══════════════════════════════════════════════════════════
  it('10 · stale tab: the superseded build still gets 409, its version is never promoted, and its rebuild is a fresh version', async () => {
    const pass: Pass = 'p8'
    expect(await publishFresh(pass, bibsOf(pass), 1_000)).toBe(1)
    const a = await newSession(pass, bibsOf(pass), 2_000); await verifyAndRank(a); expect(await buildAll(a)).toBe(2)
    const b = await newSession(pass, bibsOf(pass), 3_000); await verifyAndRank(b); expect(await buildAll(b)).toBe(3)
    expect((await publish(b)).ok).toBe(true)
    const v3 = await entries(pass, 3)

    const stale = await publish(a)
    expect(stale.ok).toBe(false)
    expect(!stale.ok && stale.status).toBe(409)
    expect(!stale.ok && stale.error).toMatch(/snapshot changed/)
    let d = await doc(pass)
    expect(d.version).toBe(3); expect(versionList(d)).toEqual([1, 3]); expect(d.maxVersion).toBe(3)

    expect(await buildAll(a), 'the rebuild never goes back into v2').toBe(4)
    expect((await publish(a)).ok).toBe(true)
    d = await doc(pass)
    expect(d.version).toBe(4); expect(d.maxVersion).toBe(4)
    expect(versionList(d)).toEqual([1, 3, 4]); expectUniqueHistory(d)
    expect(await entries(pass, 3), 'the superseding version is intact').toEqual(v3)
    for (const e of Object.values(await entries(pass, 4))) expect((e.chipTimeMs as number) % 10_000, 'v4 holds the rows session A uploaded').toBe(2_000)
  }, T)
})
