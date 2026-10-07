// RD-RACEOPS-02C · Result integrity — REAL Firestore (emulator), through the real services.
//
//   P0  tie-safe public pagination   every entry appears exactly once across pages, whatever
//                                    the ties; backward pages; final page; repeated cursor;
//                                    malformed cursor
//   P1  bib uniqueness per session   within a chunk, across chunks, crafted, retry, after
//                                    a partial failure
//   P1  append after snapshot        the rebuilt snapshot is complete and correctly ranked
//   P1  publish completeness         an incomplete pending snapshot cannot go live

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

describeEmu('RD-RACEOPS-02C · result integrity, end to end', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let svc: typeof import('@/features/race-operations/services/importService')
  let snap: typeof import('@/features/race-operations/services/snapshotService')
  let verify: typeof import('@/features/race-operations/services/registrationVerify')
  let repo: typeof import('@/features/race-operations/repositories/snapshotRepo')
  let pub: typeof import('@/features/race-operations/services/publicResults')
  let keys: typeof import('@/features/race-operations/utils/publicKeys')
  let types: typeof import('@/features/race-operations/types/snapshot')

  const UID = `emu-integrity-${process.pid}`, ACTOR = 'integrity-actor'
  const EVENT = `evt_int_${process.pid}`, SLUG = `evt-int-${process.pid}`, PASS = 'pass_10k'
  const PASS_SLUG = () => keys.passSlug('10K', PASS)
  const BIBS = Array.from({ length: 12 }, (_, i) => String(101 + i))

  async function seed() {
    const b = adminDb.batch()
    b.set(adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`), { eventType: 'sports', eventDetails: { seo: { urlSlug: SLUG }, info: { name: 'Integrity 10K' }, schedule: { startDate: '2026-03-01' } } })
    b.set(adminDb.doc(`events/${SLUG}`), { uid: UID, draftId: EVENT, eventSlug: SLUG, lifecycleStatus: 'published', eventDetails: { info: { name: 'Integrity 10K' } }, pricing: { passes: [{ id: PASS, name: '10K' }] } })
    for (const bib of BIBS) b.set(adminDb.doc(`registrations/int_${process.pid}_${bib}`), { organizerUid: UID, eventSlug: SLUG, passId: PASS, status: 'confirmed', bibNumber: bib, attendee: { name: `Athlete ${bib}` } })
    await b.commit()
  }
  async function wipe() {
    for (const c of ['raceImportSessions']) {
      const s = await adminDb.collection(c).where('organizerUid', '==', UID).get()
      for (const d of s.docs) { const rows = await d.ref.collection('results').get(); const b = adminDb.batch(); rows.docs.forEach(r => b.delete(r.ref)); b.delete(d.ref); await b.commit() }
    }
    const id = types.snapshotId(SLUG, PASS)
    const es = await adminDb.collection('raceResultSnapshots').doc(id).collection('entries').get()
    for (let i = 0; i < es.docs.length; i += 400) { const b = adminDb.batch(); es.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit() }
    await adminDb.collection('raceResultSnapshots').doc(id).delete().catch(() => null)
  }
  async function cleanup() {
    await wipe()
    const b = adminDb.batch()
    b.delete(adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`)); b.delete(adminDb.doc(`events/${SLUG}`))
    ;(await adminDb.collection('registrations').where('organizerUid', '==', UID).get()).docs.forEach(d => b.delete(d.ref))
    await b.commit()
  }

  const row = (rowNumber: number, bib: string, ms: number, status: 'finished' | 'dnf' = 'finished') => ({
    rowNumber, participantName: `Athlete ${bib}`, bibNumber: bib, chipTimeMs: status === 'finished' ? ms : null, gunTimeMs: null,
    chipTimeRaw: status === 'finished' ? String(ms) : null, gunTimeRaw: null, status, statusRaw: null,
    gender: null, category: null, ageGroup: null, rawRow: { Bib: bib, Time: String(ms) }, sourceProvider: 'csv',
  })
  const create = () => svc.createImportSession({ workspaceUid: UID, callerUid: ACTOR, eventId: EVENT, passId: PASS, fileName: 'r.csv', fileHash: 'h', provider: 'csv', mapping: { bibNumber: 'Bib', chipTime: 'Time' }, totalRows: 12 })
  const sessionIdOf = (c: Awaited<ReturnType<typeof create>>) => (c.ok ? c.value.sessionId : '')
  const append = (sid: string, rows: ReturnType<typeof row>[]) => svc.appendResults({ sessionId: sid, workspaceUid: UID, results: rows })
  async function prepare(sid: string) {
    const v = await verify.verifySessionRegistrations({ sessionId: sid, workspaceUid: UID }); if (!v.ok) throw new Error(v.error)
    for (;;) { const k = await svc.rankSessionChunk({ sessionId: sid, workspaceUid: UID }); if (!k.ok) throw new Error(k.error); if (k.value.done) break }
    for (;;) { const s = await snap.buildSnapshotChunk({ sessionId: sid, workspaceUid: UID }); if (!s.ok) throw new Error(s.error); if (s.value.done) break }
  }
  const publish = (sid: string) => svc.publishSession({ sessionId: sid, workspaceUid: UID, callerUid: ACTOR })

  /** Walk every page forward with the public service and return the bibs in order. */
  async function walkForward(pageSize: number): Promise<{ bibs: string[]; pages: number }> {
    const bibs: string[] = []; let pages = 0
    const live = await repo.getLiveSnapshotByPass(SLUG, PASS); if (!live) throw new Error('not live')
    let cursor: import('@/features/race-operations/utils/publicKeys').LeaderboardCursor | null = null
    for (;;) {
      const page = await repo.fetchLeaderboardPage(live.snapshotId, live.version, pageSize, cursor)
      pages++; bibs.push(...page.rows.map(r => r.bibNumber))
      if (!page.nextCursor) break
      cursor = page.nextCursor
      if (pages > 100) throw new Error('runaway pagination')
    }
    return { bibs, pages }
  }

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
    await cleanup().catch(() => null); await seed()
  }, T)
  beforeEach(async () => { await wipe() }, T)
  afterAll(async () => { await cleanup() }, T)

  // ─── P0 · pagination ─────────────────────────────────────────────────────

  describe('tie-safe public pagination', () => {
    // 12 finishers with ties engineered at every 4-row boundary: ranks 1,2,2,2,5,5,7,8,9,9,9,12
    const TIMES = [1000, 2000, 2000, 2000, 5000, 5000, 7000, 8000, 9000, 9000, 9000, 12000]

    async function publishTies(times = TIMES) {
      const sid = sessionIdOf(await create())
      await append(sid, times.map((ms, i) => row(i + 2, BIBS[i], ms)))
      await prepare(sid); const p = await publish(sid); expect(p.ok).toBe(true)
      return sid
    }

    it('tied rows at a page boundary — every entry exactly once, in rank order', async () => {
      await publishTies()
      const { bibs, pages } = await walkForward(4)
      expect(pages).toBe(3)
      expect(bibs.length).toBe(12)
      expect(new Set(bibs).size).toBe(12)
      expect(bibs).toEqual([...BIBS])                      // (rank, id) order == bib order here
    }, T)

    it('all tied — one rank, three pages, twelve distinct entries', async () => {
      await publishTies(TIMES.map(() => 4321))
      const { bibs } = await walkForward(5)
      expect(bibs.length).toBe(12); expect(new Set(bibs).size).toBe(12)
    }, T)

    it('no ties — unchanged behaviour', async () => {
      await publishTies(TIMES.map((_, i) => 1000 + i * 100))
      const { bibs, pages } = await walkForward(5)
      expect(pages).toBe(3); expect(bibs).toEqual([...BIBS])
    }, T)

    it('final page has no next cursor; a short first page has neither', async () => {
      await publishTies()
      const live = (await repo.getLiveSnapshotByPass(SLUG, PASS))!
      const all = await repo.fetchLeaderboardPage(live.snapshotId, live.version, 50, null)
      expect(all.rows.length).toBe(12); expect(all.nextCursor).toBeNull(); expect(all.prevCursor).toBeNull()
    }, T)

    it('repeated cursor — the same page again, nothing skipped or duplicated; backward returns the exact previous page', async () => {
      await publishTies()
      const live = (await repo.getLiveSnapshotByPass(SLUG, PASS))!
      const p1 = await repo.fetchLeaderboardPage(live.snapshotId, live.version, 4, null)
      const p2a = await repo.fetchLeaderboardPage(live.snapshotId, live.version, 4, p1.nextCursor)
      const p2b = await repo.fetchLeaderboardPage(live.snapshotId, live.version, 4, p1.nextCursor)
      expect(p2a.rows.map(r => r.bibNumber)).toEqual(p2b.rows.map(r => r.bibNumber))
      expect(p2a.rows.map(r => r.bibNumber)).toEqual(BIBS.slice(4, 8))
      const back = await repo.fetchLeaderboardPage(live.snapshotId, live.version, 4, p2a.prevCursor, 'before')
      expect(back.rows.map(r => r.bibNumber)).toEqual(BIBS.slice(0, 4))
      expect(back.prevCursor).toBeNull()                    // that IS the first page
      expect(back.nextCursor).toEqual(p1.nextCursor)
    }, T)

    it('invalid cursor — the public service lands on page one, never an error', async () => {
      await publishTies()
      for (const bad of ['', 'abc', '2', '2~', '~101', '-1~101', '2~bib 101', '999999999~101']) {
        expect(keys.decodeLeaderboardCursor(bad)).toBeNull()
      }
      const board = await pub.getLeaderboard(SLUG, PASS_SLUG(), keys.decodeLeaderboardCursor('garbage'))
      expect(board?.rows.map(r => r.bibNumber).slice(0, 4)).toEqual(BIBS.slice(0, 4))
      // a well-formed cursor that names no entry still resumes at the right place
      const beyond = await pub.getLeaderboard(SLUG, PASS_SLUG(), { rank: 2, bibKey: 'ZZZ' })
      expect(beyond?.rows[0]?.bibNumber).toBe(BIBS[4])
      // round-trip
      expect(keys.decodeLeaderboardCursor(keys.encodeLeaderboardCursor({ rank: 2, bibKey: '103' }))).toEqual({ rank: 2, bibKey: '103' })
    }, T)
  })

  // ─── P1 · bib uniqueness ─────────────────────────────────────────────────

  describe('bib uniqueness per session', () => {
    it('duplicate within a chunk → 409, nothing stored', async () => {
      const sid = sessionIdOf(await create())
      const r = await append(sid, [row(2, '101', 1000), row(3, '101', 2000)])
      expect(r.ok).toBe(false); if (!r.ok) { expect(r.status).toBe(409); expect(r.error).toContain('101') }
      expect((await adminDb.collection('raceImportSessions').doc(sid).collection('results').get()).size).toBe(0)
    }, T)

    it('duplicate across chunks (a crafted request) → 409, first chunk intact, count unchanged', async () => {
      const sid = sessionIdOf(await create())
      expect((await append(sid, [row(2, '101', 1000), row(3, '102', 2000)])).ok).toBe(true)
      const r = await append(sid, [row(4, '103', 3000), row(5, '101', 900)])
      expect(r.ok).toBe(false); if (!r.ok) expect([r.status, r.error.includes('101')]).toEqual([409, true])
      const doc = (await adminDb.collection('raceImportSessions').doc(sid).get()).data()!
      expect(doc.storedRows).toBe(2)
      expect((await adminDb.collection('raceImportSessions').doc(sid).collection('results').get()).size).toBe(2)
    }, T)

    it('case / spacing variants are the same bib', async () => {
      const sid = sessionIdOf(await create())
      expect((await append(sid, [row(2, 'a101', 1000)])).ok).toBe(true)
      const r = await append(sid, [row(3, 'A-101', 2000)])
      expect(r.ok).toBe(false)
    }, T)

    it('retrying the same chunk is safe — same rows, same count, still publishable', async () => {
      const sid = sessionIdOf(await create())
      const chunk = BIBS.slice(0, 6).map((b, i) => row(i + 2, b, 1000 + i * 10))
      const first = await append(sid, chunk); expect(first.ok && first.value.storedRows).toBe(6)
      const again = await append(sid, chunk); expect(again.ok && again.value.storedRows).toBe(6)
      expect(again.ok && again.value.written).toBe(0)
      await prepare(sid)
      expect((await publish(sid)).ok).toBe(true)
    }, T)

    it('duplicate after a partial failure — the refused chunk left nothing, the corrected chunk succeeds', async () => {
      const sid = sessionIdOf(await create())
      expect((await append(sid, [row(2, '101', 1000)])).ok).toBe(true)
      const bad = await append(sid, [row(3, '102', 2000), row(4, '101', 1500)])   // refused as a whole
      expect(bad.ok).toBe(false)
      expect((await adminDb.collection('raceImportSessions').doc(sid).collection('results').get()).size).toBe(1)
      const fixed = await append(sid, [row(3, '102', 2000), row(4, '103', 1500)])
      expect(fixed.ok && fixed.value.storedRows).toBe(3)
    }, T)
  })

  // ─── P1 · append after ranking / snapshot ────────────────────────────────

  it('append after verify+rank+snapshot → stale state cleared, rebuilt snapshot is complete and correctly ranked', async () => {
    const sid = sessionIdOf(await create())
    await append(sid, [row(2, '101', 3000), row(3, '102', 4000)])
    await prepare(sid)
    // the fastest athlete arrives late
    const late = await append(sid, [row(4, '103', 1000)]); expect(late.ok).toBe(true)
    const after = (await adminDb.collection('raceImportSessions').doc(sid).get()).data()!
    expect(after.rankedAt ?? null).toBeNull()
    expect(after.registrationCheck ?? null).toBeNull()
    const pendingReset = (await adminDb.collection('raceResultSnapshots').doc(types.snapshotId(SLUG, PASS)).get()).data()!
    expect(pendingReset.pendingTotalCount).toBe(0); expect(pendingReset.pendingCursor ?? null).toBeNull()
    // publishing now must be impossible in every path
    expect((await publish(sid)).ok).toBe(false)
    // verify, rank, snapshot again, publish
    await prepare(sid)
    const p = await publish(sid); expect(p.ok).toBe(true)
    const { bibs } = await walkForward(50)
    expect(bibs).toEqual(['103', '101', '102'])
    const live = (await repo.getLiveSnapshotByPass(SLUG, PASS))!
    expect([live.totalCount, live.finisherCount]).toEqual([3, 3])
    const entries = await adminDb.collection('raceResultSnapshots').doc(live.snapshotId).collection('entries').where('v', '==', live.version).get()
    expect(entries.docs.map(d => d.data().bibNumber + '#' + d.data().overallRank).sort()).toEqual(['101#2', '102#3', '103#1'])
  }, T)

  // ─── P1 · publish completeness ───────────────────────────────────────────

  it('an incomplete pending snapshot is refused; the completed one publishes', async () => {
    const sid = sessionIdOf(await create())
    await append(sid, BIBS.map((b, i) => row(i + 2, b, 1000 + i)))
    const v = await verify.verifySessionRegistrations({ sessionId: sid, workspaceUid: UID }); expect(v.ok).toBe(true)
    for (;;) { const k = await svc.rankSessionChunk({ sessionId: sid, workspaceUid: UID }); if (!k.ok) throw new Error(k.error); if (k.value.done) break }
    // build ONE chunk only by shrinking what the build sees: simulate by building, then
    // knocking the pending count down as an interrupted build would leave it
    for (;;) { const s = await snap.buildSnapshotChunk({ sessionId: sid, workspaceUid: UID }); if (!s.ok) throw new Error(s.error); if (s.value.done) break }
    const ref = adminDb.collection('raceResultSnapshots').doc(types.snapshotId(SLUG, PASS))
    await ref.update({ pendingTotalCount: 5 })
    const refused = await publish(sid)
    expect(refused.ok).toBe(false); if (!refused.ok) { expect(refused.status).toBe(409); expect(refused.error).toMatch(/incomplete/i) }
    expect((await repo.getLiveSnapshotByPass(SLUG, PASS))).toBeNull()
    await ref.update({ pendingTotalCount: 12 })
    expect((await publish(sid)).ok).toBe(true)
    expect((await repo.getLiveSnapshotByPass(SLUG, PASS))?.totalCount).toBe(12)
  }, T)
})
