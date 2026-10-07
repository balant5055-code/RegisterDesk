// RD-ANALYTICS-12-11 · History stays bounded at scale. REAL Firestore.
//
// ═══ WHY THIS NEEDS A REAL DATABASE ══════════════════════════════════════════
// The unit suite proves the scan loop against a fake that honours where/orderBy/startAfter,
// and it counts documents — which is the right instrument for the LOOP. What it cannot prove
// is that the query Firestore is actually asked for behaves the way the fake does: that
// `startAfter(Timestamp)` lands exactly where the previous page stopped, that a cursor
// carrying seconds+nanoseconds is precise enough not to skip or repeat a row, and that a
// workspace holding twenty thousand export jobs does not change any of it.
//
// ═══ THE FIXTURE IS BUILT SO AN UNBOUNDED READER MUST FAIL ═══════════════════
// 20,000 jobs in one workspace. A reader that walked the collection to answer one page would
// read all of them; a reader that stopped at the visible page reads at most 250. The
// difference is observable without counting server reads: `hasMore` must be TRUE, because a
// request that returned `hasMore: false` over this fixture could only have reached the end.
//
// A second workspace holds 500 jobs of a kind no registry entry describes — the worst case
// the scan bound exists for, where every document read is invisible and the page can never
// fill. That request must still terminate, still return a cursor, and still make progress.
//
// ═══ WHAT THIS CANNOT VALIDATE ═══════════════════════════════════════════════
// The composite index. The Firestore emulator does not enforce index definitions, so this
// file passing says NOTHING about whether (organizerUid ASC, createdAt DESC) is deployed. In
// production the same query fails with FAILED_PRECONDITION until it is. The index definition
// is added in this phase and deliberately NOT deployed.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { permissionsForRole } from '@/lib/team/types'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const BIG   = `a1211-big-${PID}`      // 20,000 visible jobs
const OTHER = `a1211-other-${PID}`    // a different workspace entirely
const BLIND = `a1211-blind-${PID}`    // 500 jobs of an unregistered kind

// Document id prefixes, deliberately NOT derived from the workspace uids above: a jobId
// built out of the uid would make the "no organizerUid in the projection" assertion pass or
// fail on the fixture's naming rather than on the projection.
const BIG_P   = `a1211-bj-${PID}`
const OTHER_P = `a1211-oj-${PID}`
const BLIND_P = `a1211-xj-${PID}`

const BIG_JOBS   = 20_000
const OTHER_JOBS = 25
const BLIND_JOBS = 500

const COLLECTION = 'reportExportJobs'
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)

describeEmu('RD-ANALYTICS-12-11 · History is bounded and exact at scale', () => {
  let adminDb: FirebaseFirestore.Firestore
  let readReportHistory: typeof import('@/lib/reports/history').readReportHistory
  let HISTORY_MAX_SCAN: number
  let HISTORY_PAGE_SIZE: number

  const ids: string[] = []

  const seed = async (uid: string, count: number, prefix: string, kind: string) => {
    let batch = adminDb.batch()
    for (let i = 0; i < count; i++) {
      const id = `${prefix}-${i}`
      ids.push(id)
      batch.set(adminDb.collection(COLLECTION).doc(id), {
        jobId: id, organizerUid: uid, createdBy: uid,
        kind, format: 'csv', filenameBase: kind, heading: kind,
        filters: { from: '2026-01-01', to: '2026-01-31' },
        status: 'completed',
        counts: { total: 1, processed: 1, succeeded: 1, failed: 0 },
        cursor: 'done', error: null, lockedUntil: null,
        // One second apart, so the ordering is total and a skipped or repeated row is
        // detectable by id rather than only by count.
        createdAt: new Date(T0 + i * 1000),
        startedAt: new Date(T0 + i * 1000),
        updatedAt: new Date(T0 + i * 1000),
        completedAt: new Date(T0 + i * 1000),
        output: {
          path: `reportExports/${uid}/${id}/${kind}.csv`,
          filename: `${kind}.csv`, contentType: 'text/csv',
          rowCount: 10, truncated: false,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      })
      if ((i + 1) % 450 === 0) { await batch.commit(); batch = adminDb.batch() }
    }
    await batch.commit()
  }

  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    const mod = await import('@/lib/reports/history')
    readReportHistory  = mod.readReportHistory
    HISTORY_MAX_SCAN   = mod.HISTORY_MAX_SCAN
    HISTORY_PAGE_SIZE  = mod.HISTORY_PAGE_SIZE

    await seed(BIG,   BIG_JOBS,   BIG_P,   'transactions')
    await seed(OTHER, OTHER_JOBS, OTHER_P, 'transactions')
    await seed(BLIND, BLIND_JOBS, BLIND_P, 'a-report-kind-no-registry-describes')
  }, 1_800_000)

  afterAll(async () => {
    for (let i = 0; i < ids.length; i += 450) {
      const batch = adminDb.batch()
      for (const id of ids.slice(i, i + 450)) batch.delete(adminDb.collection(COLLECTION).doc(id))
      await batch.commit()
    }
  }, 1_800_000)

  const owner = () => permissionsForRole('owner')

  it('0 · the fixture is actually large — otherwise every assertion below is vacuous', async () => {
    const c = await adminDb.collection(COLLECTION).where('organizerUid', '==', BIG).count().get()
    expect(c.data().count).toBe(BIG_JOBS)
    expect(BIG_JOBS).toBeGreaterThan(HISTORY_MAX_SCAN * 10)
  }, 300_000)

  it('1 · one page is one page, over twenty thousand jobs', async () => {
    const page = await readReportHistory({
      workspaceUid: BIG, callerUid: BIG, permissions: owner(), cursor: null,
    })
    expect(page.entries.length).toBe(HISTORY_PAGE_SIZE)
    // The whole property in one assertion: a reader that had walked the collection would
    // have found the end, and hasMore would be false.
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBeTruthy()
  }, 300_000)

  it('2 · newest first, exactly — the last seeded job is the first row', async () => {
    const page = await readReportHistory({
      workspaceUid: BIG, callerUid: BIG, permissions: owner(), cursor: null,
    })
    expect(page.entries[0]!.jobId).toBe(`${BIG_P}-${BIG_JOBS - 1}`)
    expect(page.entries[HISTORY_PAGE_SIZE - 1]!.jobId).toBe(`${BIG_P}-${BIG_JOBS - HISTORY_PAGE_SIZE}`)
  }, 300_000)

  it('3 · the keyset cursor is exact across page boundaries — no skips, no repeats', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let turn = 0; turn < 8; turn++) {
      const page = await readReportHistory({
        workspaceUid: BIG, callerUid: BIG, permissions: owner(), cursor,
      })
      seen.push(...page.entries.map(e => e.jobId))
      cursor = page.nextCursor
      expect(cursor, `page ${turn} lost its cursor`).toBeTruthy()
    }
    expect(seen.length).toBe(8 * HISTORY_PAGE_SIZE)
    // Distinctness catches a repeat; the contiguous descending sequence catches a skip,
    // which a set alone would not.
    expect(new Set(seen).size).toBe(seen.length)
    const expected = Array.from({ length: seen.length }, (_, k) => `${BIG_P}-${BIG_JOBS - 1 - k}`)
    expect(seen).toEqual(expected)
  }, 600_000)

  it('4 · another workspace\'s twenty thousand jobs are invisible, and its own are complete', async () => {
    const page = await readReportHistory({
      workspaceUid: OTHER, callerUid: OTHER, permissions: owner(), cursor: null,
    })
    expect(page.entries.length).toBe(HISTORY_PAGE_SIZE)
    for (const e of page.entries) expect(e.jobId.startsWith(`${OTHER_P}-`)).toBe(true)

    // And paging to the end of that workspace terminates at exactly its own job count.
    const seen = new Set(page.entries.map(e => e.jobId))
    let cursor = page.nextCursor
    while (cursor) {
      const next = await readReportHistory({
        workspaceUid: OTHER, callerUid: OTHER, permissions: owner(), cursor,
      })
      next.entries.forEach(e => seen.add(e.jobId))
      cursor = next.hasMore ? next.nextCursor : null
      if (!next.hasMore) break
    }
    expect(seen.size).toBe(OTHER_JOBS)
  }, 300_000)

  it('5 · a workspace where EVERY job is invisible still terminates, bounded, with progress', async () => {
    // The scan loop's worst case: the page can never fill, so only the bound stops it.
    const started = Date.now()
    const page = await readReportHistory({
      workspaceUid: BLIND, callerUid: BLIND, permissions: owner(), cursor: null,
    })
    expect(page.entries).toEqual([])
    // It stopped at the bound rather than reading all 500 — so there is more, and a cursor
    // to continue from.
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBeTruthy()

    // The cursor moved: the next request must not return the same position.
    const second = await readReportHistory({
      workspaceUid: BLIND, callerUid: BLIND, permissions: owner(), cursor: page.nextCursor,
    })
    expect(second.nextCursor).not.toBe(page.nextCursor)
    // Bounded work, not a benchmark: two requests over 500 invisible documents.
    expect(Date.now() - started).toBeLessThan(120_000)
  }, 300_000)

  it('6 · continuing past every invisible job reaches the end and stops', async () => {
    let cursor: string | null = null
    let turns = 0
    for (; turns < 20; turns++) {
      const page: Awaited<ReturnType<typeof readReportHistory>> = await readReportHistory({
        workspaceUid: BLIND, callerUid: BLIND, permissions: owner(), cursor,
      })
      expect(page.entries).toEqual([])
      if (!page.hasMore) break
      cursor = page.nextCursor
    }
    // 500 invisible jobs at a 250-document bound: it ends, and in a small number of turns.
    expect(turns).toBeLessThan(10)
  }, 300_000)

  it('7 · the projection carries no storage path and no workspace uid, from real documents', async () => {
    const page = await readReportHistory({
      workspaceUid: BIG, callerUid: BIG, permissions: owner(), cursor: null,
    })
    const raw = JSON.stringify(page.entries)
    expect(raw).not.toContain('reportExports/')
    expect(raw).not.toContain(BIG)
    expect(raw).not.toContain('text/csv')
    expect(raw).not.toMatch(/"path"/)
    expect(raw).not.toMatch(/"url"/)
    // What it does carry.
    expect(page.entries[0]!.download).toBe('available')
    expect(page.entries[0]!.createdByYou).toBe(true)
  }, 300_000)

  it('8 · a caller holding no report permission reads nothing at all', async () => {
    const page = await readReportHistory({
      workspaceUid: BIG, callerUid: BIG, permissions: permissionsForRole('manager'), cursor: null,
    })
    expect(page.entries).toEqual([])
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeNull()
  }, 300_000)
})
