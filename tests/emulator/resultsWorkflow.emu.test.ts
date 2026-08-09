// RD-RESULTS-FINAL-01 · The complete Marathon Results workflow — REAL Firestore (emulator).
//
// ═══ WHY THIS FILE EXISTS ═════════════════════════════════════════════════════
// Every piece of the results module is unit-tested in isolation: ranking, ties, validation,
// the state machine, the start-list matcher, the public projection. Nothing had ever run the
// pieces TOGETHER, so the claims that matter — "a wrong result can be corrected", "a rollback
// restores the previous version", "certificates follow the published version" — rested on
// each part being right rather than on the chain ever having been executed.
//
// This drives the real spine, in order, against real Firestore:
//
//   import → start-list verification → rank → snapshot → publish v1 → public results
//   → certificates → republish v2 → public results → rollback to v1 → export
//
// ═══ WHAT IT DOES NOT COVER ══════════════════════════════════════════════════
// The browser: the upload dropzone, column mapping UI, and every pixel. Those need a real
// browser and are called out as such in the sprint report rather than implied by a green run.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const WORKFLOW_TIMEOUT_MS = 120_000

describeEmu('RD-RESULTS-FINAL-01 · the marathon results workflow, end to end', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let importService: typeof import('@/features/race-operations/services/importService')
  let snapshotService: typeof import('@/features/race-operations/services/snapshotService')
  let registrationVerify: typeof import('@/features/race-operations/services/registrationVerify')
  let publicResults: typeof import('@/features/race-operations/services/publicResults')
  let snapshotRepo: typeof import('@/features/race-operations/repositories/snapshotRepo')
  let certificateResults: typeof import('@/features/race-operations/services/certificateResults')
  let snapshotTypes: typeof import('@/features/race-operations/types/snapshot')

  const UID   = `emu-results-${process.pid}`
  const ACTOR = 'results-actor'
  const EVENT = `evt_results_${process.pid}`
  const SLUG  = `evt-results-${process.pid}`
  const PASS  = 'pass_half'
  const OTHER = 'pass_10k'

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    importService      = await import('@/features/race-operations/services/importService')
    snapshotService    = await import('@/features/race-operations/services/snapshotService')
    registrationVerify = await import('@/features/race-operations/services/registrationVerify')
    publicResults      = await import('@/features/race-operations/services/publicResults')
    snapshotRepo       = await import('@/features/race-operations/repositories/snapshotRepo')
    certificateResults = await import('@/features/race-operations/services/certificateResults')
    snapshotTypes      = await import('@/features/race-operations/types/snapshot')
  })

  /** The event, its published pass list, and a confirmed start list with bibs. */
  async function seed() {
    const batch = adminDb.batch()

    batch.set(adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`), {
      eventDetails: {
        seo:      { urlSlug: SLUG },
        info:     { name: 'Emulator Marathon' },
        schedule: { startDate: '2026-01-18' },
      },
    })

    batch.set(adminDb.doc(`events/${SLUG}`), {
      uid: UID, draftId: EVENT, eventSlug: SLUG,
      lifecycleStatus: 'published',
      eventDetails: { info: { name: 'Emulator Marathon' } },
      pricing: { passes: [
        { id: PASS,  name: 'Half Marathon' },
        { id: OTHER, name: '10K' },
      ] },
    })

    // Bibs 101–105 run the half; 900 runs the 10K. 105 is a confirmed entrant who will not
    // appear in the timing file — a DNS, which must warn and never block.
    for (const [bib, pass] of [
      ['101', PASS], ['102', PASS], ['103', PASS], ['104', PASS], ['105', PASS],
      ['900', OTHER],
    ] as const) {
      batch.set(adminDb.doc(`registrations/reg_${process.pid}_${bib}`), {
        organizerUid: UID, eventSlug: SLUG, passId: pass,
        status: 'confirmed', bibNumber: bib,
        attendee: { name: `Runner ${bib}`, email: `r${bib}@example.test` },
      })
    }

    await batch.commit()
  }

  async function wipe() {
    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`))
    batch.delete(adminDb.doc(`events/${SLUG}`))
    for (const col of ['raceImportSessions', 'registrations']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()

    // The snapshot and its entries are keyed by slug, not organizerUid.
    const id = snapshotTypes.snapshotId(SLUG, PASS)
    const entries = await adminDb.collection('raceResultSnapshots').doc(id)
      .collection('entries').get()
    for (const chunk of chunked(entries.docs, 400)) {
      const b = adminDb.batch()
      chunk.forEach(d => b.delete(d.ref))
      await b.commit()
    }
    await adminDb.collection('raceResultSnapshots').doc(id).delete().catch(() => null)
  }

  const chunked = <T,>(xs: readonly T[], n: number): T[][] =>
    xs.length === 0 ? [] : [xs.slice(0, n) as T[], ...chunked(xs.slice(n), n)]

  beforeEach(async () => { await wipe(); await seed() })

  /** One canonical row. */
  const row = (rowNumber: number, bib: string, chipTimeMs: number | null, status = 'finished') => ({
    rowNumber,
    participantName: `Runner ${bib}`,
    bibNumber:   bib,
    chipTimeMs,
    gunTimeMs:   chipTimeMs === null ? null : chipTimeMs + 5_000,
    chipTimeRaw: chipTimeMs === null ? null : String(chipTimeMs),
    gunTimeRaw:  null,
    status:      status as 'finished' | 'dnf' | 'dns' | 'dq',
    statusRaw:   null,
    gender:      null,
    category:    null,
    ageGroup:    null,
    // A REAL raw row:  tests that every value is empty, and an empty object
    // makes that vacuously true — every row would be rejected as blank. This also gives
    //  something to distinguish rows by, which duplicate-ROW detection needs.
    rawRow:      { Bib: bib, Chip: chipTimeMs === null ? '' : String(chipTimeMs) },
    sourceProvider: 'csv',
  })

  /**
   * Drives store → VERIFY → rank → snapshot for one set of rows and returns the session id
   * plus the verification result.
   *
   * RD-RESULTS-CLOSURE-02 · verification moved from last to third, and /rank and /snapshot
   * now refuse without it, so this helper returns early when the check blocks — exactly as
   * the browser's commit hook does. Deliberately the SAME sequence, in the same order.
   */
  async function importAndPrepare(rows: ReturnType<typeof row>[]) {
    const created = await importService.createImportSession({
      workspaceUid: UID, callerUid: ACTOR, eventId: EVENT, passId: PASS,
      fileName: 'results.csv', fileHash: `h${rows.length}`, provider: 'csv',
      mapping: { bibNumber: 'Bib', chipTime: 'Chip' }, totalRows: rows.length,
    })
    if (!created.ok) throw new Error(`create failed: ${created.error}`)
    const sessionId = created.value.sessionId

    const appended = await importService.appendResults({
      sessionId, workspaceUid: UID, results: rows,
    })
    if (!appended.ok) throw new Error(`append failed: ${appended.error}`)

    // ── Verification, immediately after storing ─────────────────────────────
    const check = await registrationVerify.verifySessionRegistrations({
      sessionId, workspaceUid: UID,
    })
    if (!check.ok) throw new Error(`verify failed: ${check.error}`)
    if (check.value.blocking) return { sessionId, check: check.value, prepared: false as const }

    for (;;) {
      const r = await importService.rankSessionChunk({ sessionId, workspaceUid: UID })
      if (!r.ok) throw new Error(`rank failed: ${r.error}`)
      if (r.value.done) break
    }

    let cursor: number | null = null
    for (;;) {
      const b = await snapshotService.buildSnapshotChunk({
        sessionId, workspaceUid: UID, afterRowNumber: cursor,
      })
      if (!b.ok) throw new Error(`snapshot failed: ${b.error}`)
      if (b.value.done) break
      cursor = b.value.nextCursor
    }

    return { sessionId, check: check.value, prepared: true as const }
  }

  /** Create + store only — no verification, so the "never checked" gate can be exercised. */
  async function importOnly(rows: ReturnType<typeof row>[]) {
    const created = await importService.createImportSession({
      workspaceUid: UID, callerUid: ACTOR, eventId: EVENT, passId: PASS,
      fileName: 'results.csv', fileHash: `h${rows.length}`, provider: 'csv',
      mapping: { bibNumber: 'Bib', chipTime: 'Chip' }, totalRows: rows.length,
    })
    if (!created.ok) throw new Error(`create failed: ${created.error}`)
    const appended = await importService.appendResults({
      sessionId: created.value.sessionId, workspaceUid: UID, results: rows,
    })
    if (!appended.ok) throw new Error(`append failed: ${appended.error}`)
    return created.value.sessionId
  }

  /** Entry documents currently stored for the race, whatever version they carry. */
  async function allEntries() {
    const id = snapshotTypes.snapshotId(SLUG, PASS)
    const snap = await adminDb.collection('raceResultSnapshots').doc(id)
      .collection('entries').get()
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
  }

  const raceSnapshot = async () => (
    await adminDb.collection('raceResultSnapshots')
      .doc(snapshotTypes.snapshotId(SLUG, PASS)).get()
  ).data() as Record<string, unknown> | undefined

  // ═══════════════════════════════════════════════════════════════════════════

  it('import → verify → publish v1 → public → certificates → v2 → rollback', async () => {
    // ── 1. Import a clean file ──────────────────────────────────────────────
    const v1Rows = [
      row(1, '101', 3_600_000),   // 1:00:00 → 1st
      row(2, '102', 3_900_000),   // 1:05:00 → 2nd
      row(3, '103', 4_200_000),   // 1:10:00 → 3rd
      row(4, '104', null, 'dnf'),
    ]
    const { sessionId: s1 } = await importAndPrepare(v1Rows)

    // ── 2. Start-list verification ──────────────────────────────────────────
    const check = await registrationVerify.verifySessionRegistrations({
      sessionId: s1, workspaceUid: UID,
    })
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.value.matched).toBe(4)
    expect(check.value.unknownRunner).toBe(0)
    expect(check.value.wrongRace).toBe(0)
    // 105 registered and never appeared — a DNS. Warns, never blocks.
    expect(check.value.missingResult).toBe(1)
    expect(check.value.blocking).toBe(false)

    // ── 3. Publish v1 ───────────────────────────────────────────────────────
    const pub1 = await importService.publishSession({
      sessionId: s1, workspaceUid: UID, callerUid: ACTOR,
    })
    expect(pub1.ok).toBe(true)

    // ── 4. Public results serve v1 ──────────────────────────────────────────
    const board1 = await publicResults.getLeaderboard(SLUG, 'half-marathon', null)
    expect(board1).not.toBeNull()
    expect(board1!.rows[0].bibNumber).toBe('101')
    expect(board1!.rows[0].overallRank).toBe(1)

    // ═══ DOCUMENTED BEHAVIOUR, not an oversight in this test ═══════════════
    // The leaderboard orders by , and Firestore EXCLUDES documents whose
    // ordered field is null. DNF / DNS / DQ rows carry a null rank by design, so they do
    // not appear on the leaderboard — three finishers, not four rows.
    expect(board1!.rows).toHaveLength(3)
    expect(board1!.rows.some(r => r.bibNumber === '104')).toBe(false)

    // They are NOT lost: a bib lookup is a document GET and finds them, which is how a DNF
    // runner reaches their own result page.
    const dnf = await publicResults.getRunnerResult(SLUG, 'half-marathon', '104')
    expect(dnf?.result.status).toBe('dnf')
    expect(dnf?.result.overallRank).toBeNull()

    const bib1 = await publicResults.getRunnerResult(SLUG, 'half-marathon', '102')
    expect(bib1?.result.overallRank).toBe(2)

    const search1 = await publicResults.searchRace(SLUG, 'half-marathon', 'Runner 103')
    expect(search1?.rows[0]?.bibNumber).toBe('103')

    // ── 5. Certificates resolve the published version ───────────────────────
    const cert1 = await certificateResults.resolveCertificateRaceResult({
      eventSlug: SLUG, passId: PASS, bibNumber: '101',
    })
    // The certificate DTO exposes a FORMATTED position, not a raw rank — that is what a
    // certificate prints.
    expect(cert1.position).toBe('1st')
    expect(cert1.distance).toBe('Half Marathon')

    // ── 6. REPUBLISH — the correction path that used to be impossible ───────
    // 102's chip time was wrong; corrected it now beats 101.
    const v2Rows = [
      row(1, '101', 3_600_000),
      row(2, '102', 3_000_000),   // corrected → now 1st
      row(3, '103', 4_200_000),
      row(4, '104', null, 'dnf'),
    ]
    const { sessionId: s2 } = await importAndPrepare(v2Rows)
    const check2 = await registrationVerify.verifySessionRegistrations({
      sessionId: s2, workspaceUid: UID,
    })
    expect(check2.ok).toBe(true)

    // The live race is UNTOUCHED while v2 builds — the pending lane's whole purpose.
    const midBoard = await publicResults.getLeaderboard(SLUG, 'half-marathon', null)
    expect(midBoard!.rows[0].bibNumber).toBe('101')

    const pub2 = await importService.publishSession({
      sessionId: s2, workspaceUid: UID, callerUid: ACTOR,
    })
    expect(pub2.ok).toBe(true)

    // ── 7. Public now serves v2 ─────────────────────────────────────────────
    const board2 = await publicResults.getLeaderboard(SLUG, 'half-marathon', null)
    expect(board2!.rows[0].bibNumber).toBe('102')
    expect(board2!.rows[0].overallRank).toBe(1)

    // Certificates follow WITHOUT any regeneration call — they read the live version.
    const cert2 = await certificateResults.resolveCertificateRaceResult({
      eventSlug: SLUG, passId: PASS, bibNumber: '102',
    })
    expect(cert2.position).toBe('1st')

    // ── 8. Version history records both ─────────────────────────────────────
    const versions = await snapshotRepo.listSnapshotVersions(SLUG, PASS, UID)
    expect(versions.map(v => v.version)).toEqual([2, 1])
    expect(versions.every(v => v.totalCount === 4)).toBe(true)

    // ── 9. ROLLBACK to v1 ───────────────────────────────────────────────────
    // Possible only because v1's entries were never overwritten.
    const back = await snapshotRepo.rollbackSnapshot({
      eventSlug: SLUG, passId: PASS, organizerUid: UID, toVersion: 1, actorUid: ACTOR,
    })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.version).toBe(1)
    expect(back.previousVersion).toBe(2)

    const board3 = await publicResults.getLeaderboard(SLUG, 'half-marathon', null)
    expect(board3!.rows[0].bibNumber).toBe('101')          // v1 restored
    expect(board3!.rows).toHaveLength(3)

    const cert3 = await certificateResults.resolveCertificateRaceResult({
      eventSlug: SLUG, passId: PASS, bibNumber: '102',
    })
    expect(cert3.position).toBe('2nd')                      // follows the rollback

    // The rollback is recorded, not silent.
    const after = await snapshotRepo.listSnapshotVersions(SLUG, PASS, UID)
    expect(after.find(v => v.version === 1)?.restoredAt).toBeTruthy()
    expect(after.find(v => v.version === 1)?.restoredBy).toBe(ACTOR)
  }, WORKFLOW_TIMEOUT_MS)

  it('REFUSES to publish a file containing a bib nobody holds', async () => {
    // The defect this gate exists for: a mis-keyed bib used to publish as a real finisher.
    const { sessionId: s, prepared } = await importAndPrepare([
      row(1, '101', 3_600_000),
      row(2, '777', 3_700_000),   // on no start list
    ])
    // RD-RESULTS-CLOSURE-02 · the pipeline now STOPS at verification, so ranking
    // never ran and not one snapshot entry was written.
    expect(prepared).toBe(false)
    expect(await allEntries()).toHaveLength(0)

    const check = await registrationVerify.verifySessionRegistrations({
      sessionId: s, workspaceUid: UID,
    })
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.value.unknownRunner).toBe(1)
    expect(check.value.blocking).toBe(true)

    const pub = await importService.publishSession({
      sessionId: s, workspaceUid: UID, callerUid: ACTOR,
    })
    expect(pub.ok).toBe(false)
    if (pub.ok) return
    expect(pub.status).toBe(422)
    expect(pub.error).toMatch(/start list/i)

    // Nothing reached the public.
    expect(await publicResults.getLeaderboard(SLUG, 'half-marathon', null)).toBeNull()
  }, WORKFLOW_TIMEOUT_MS)

  it('REFUSES a row belonging to a different race at the same event', async () => {
    const { sessionId: s, prepared } = await importAndPrepare([
      row(1, '101', 3_600_000),
      row(2, '900', 3_700_000),   // a 10K entrant in the half file
    ])
    expect(prepared).toBe(false)
    expect(await allEntries()).toHaveLength(0)

    const check = await registrationVerify.verifySessionRegistrations({
      sessionId: s, workspaceUid: UID,
    })
    if (!check.ok) return
    expect(check.value.wrongRace).toBe(1)
    expect(check.value.unknownRunner).toBe(0)   // told apart, not lumped together

    const pub = await importService.publishSession({
      sessionId: s, workspaceUid: UID, callerUid: ACTOR,
    })
    expect(pub.ok).toBe(false)
    if (!pub.ok) expect(pub.error).toMatch(/different race/i)
  }, WORKFLOW_TIMEOUT_MS)

  it('REFUSES to publish without a start-list check at all', async () => {
    // Verification skipped entirely — absent counts as unverified, not as clean.
    const s = await importOnly([row(1, '101', 3_600_000)])
    const pub = await importService.publishSession({
      sessionId: s, workspaceUid: UID, callerUid: ACTOR,
    })
    expect(pub.ok).toBe(false)
    if (!pub.ok) {
      expect(pub.status).toBe(422)
      expect(pub.error).toMatch(/not been checked/i)
    }
  }, WORKFLOW_TIMEOUT_MS)

  it('a changed file CLEARS the check, so a stale pass cannot publish', async () => {
    const { sessionId: s } = await importAndPrepare([row(1, '101', 3_600_000)])
    const first = await registrationVerify.verifySessionRegistrations({
      sessionId: s, workspaceUid: UID,
    })
    expect(first.ok).toBe(true)

    // More rows land after the check — the file it verified no longer exists.
    const more = await importService.appendResults({
      sessionId: s, workspaceUid: UID, results: [row(2, '102', 3_700_000)],
    })
    expect(more.ok).toBe(true)

    const pub = await importService.publishSession({
      sessionId: s, workspaceUid: UID, callerUid: ACTOR,
    })
    expect(pub.ok).toBe(false)
    if (!pub.ok) expect(pub.error).toMatch(/not been checked|ranking/i)
  }, WORKFLOW_TIMEOUT_MS)

  it('a draft never reaches the public', async () => {
    await importAndPrepare([row(1, '101', 3_600_000)])
    // Snapshot built, session still draft — `status` is not `live`.
    expect(await publicResults.getLeaderboard(SLUG, 'half-marathon', null)).toBeNull()
    expect(await publicResults.getRunnerResult(SLUG, 'half-marathon', '101')).toBeNull()
  }, WORKFLOW_TIMEOUT_MS)

  // ═══ RD-RESULTS-CLOSURE-02 ══════════════════════════════════════════════════

  it('a rejected import leaves NOTHING behind for the next one to publish', async () => {
    // ═══ THE DEFECT THIS EXISTS FOR ═════════════════════════════════════════
    // Import A built its snapshot BEFORE verification, so a rejected file still wrote a
    // full set of entries. `nextSnapshotVersion` then handed that same pending version to
    // import B, B overwrote only the bibs it shared, and nothing in the module deletes an
    // entry — so publishing B served A's rejected runner on the public leaderboard.
    //
    //   import A (101, 102, 777) → 777 is on no start list → cancel
    //   import B (101, 102)      → publish
    //
    // Every assertion below failed before this sprint.

    // ── Import A · rejected ─────────────────────────────────────────────────
    const a = await importAndPrepare([
      row(1, '101', 3_600_000),
      row(2, '102', 3_900_000),
      row(3, '777', 4_000_000),   // nobody holds this bib
    ])
    expect(a.prepared).toBe(false)
    expect(a.check.unknownRunner).toBe(1)

    // Verification ran before ranking and before the snapshot, so neither exists.
    expect(await allEntries()).toHaveLength(0)
    expect(await raceSnapshot()).toBeUndefined()

    // The server refuses even if a client tries to skip ahead on its own.
    const forcedRank = await importService.rankSessionChunk({ sessionId: a.sessionId, workspaceUid: UID })
    expect(forcedRank.ok).toBe(false)
    if (!forcedRank.ok) expect(forcedRank.error).toMatch(/start list/i)

    const forcedSnap = await snapshotService.buildSnapshotChunk({
      sessionId: a.sessionId, workspaceUid: UID, afterRowNumber: null,
    })
    expect(forcedSnap.ok).toBe(false)
    if (!forcedSnap.ok) expect(forcedSnap.error).toMatch(/start list/i)

    const cancelled = await importService.cancelSession({
      sessionId: a.sessionId, workspaceUid: UID, callerUid: ACTOR, reason: 'unknown bib',
    })
    expect(cancelled.ok).toBe(true)

    // ── Import B · corrected, published ─────────────────────────────────────
    const b = await importAndPrepare([
      row(1, '101', 3_600_000),
      row(2, '102', 3_900_000),
    ])
    expect(b.prepared).toBe(true)
    expect(b.check.unknownRunner).toBe(0)

    const pub = await importService.publishSession({
      sessionId: b.sessionId, workspaceUid: UID, callerUid: ACTOR,
    })
    expect(pub.ok).toBe(true)

    // ── 1. No stale snapshot rows ───────────────────────────────────────────
    const entries = await allEntries()
    expect(entries.map(e => e.bibNumber).sort()).toEqual(['101', '102'])
    expect(entries.some(e => e.bibNumber === '777')).toBe(false)

    // ── 2. Correct snapshot count ───────────────────────────────────────────
    const snap = await raceSnapshot()
    expect(snap?.status).toBe('live')
    expect(snap?.totalCount).toBe(2)
    expect(snap?.finisherCount).toBe(2)
    // The lane is fully cleared on promotion — cursor included.
    expect(snap?.pendingVersion ?? null).toBeNull()
    expect(snap?.pendingCursor  ?? null).toBeNull()

    // ── 3. Correct public leaderboard ───────────────────────────────────────
    const board = await publicResults.getLeaderboard(SLUG, 'half-marathon', null)
    expect(board?.rows.map(r => r.bibNumber)).toEqual(['101', '102'])
    expect(board?.race.totalCount).toBe(2)
    expect(await publicResults.getRunnerResult(SLUG, 'half-marathon', '777')).toBeNull()

    // ── 4. Correct certificate version ──────────────────────────────────────
    const cert = await certificateResults.resolveCertificateRaceResult({
      eventSlug: SLUG, passId: PASS, bibNumber: '101',
    })
    expect(cert.position).toBe('1st')
    expect(cert.finishTime).not.toBe('')
    // A rejected runner has no result to certify.
    const ghost = await certificateResults.resolveCertificateRaceResult({
      eventSlug: SLUG, passId: PASS, bibNumber: '777',
    })
    expect(ghost).toEqual({ distance: '', finishTime: '', position: '' })

    // ── 5. Correct history ──────────────────────────────────────────────────
    // Exactly ONE published version. The cancelled import contributed no record, and its
    // version number was skipped rather than inherited.
    const versions = await snapshotRepo.listSnapshotVersions(SLUG, PASS, UID)
    expect(versions).toHaveLength(1)
    expect(versions[0].sessionId).toBe(b.sessionId)
    expect(versions[0].totalCount).toBe(2)
    expect(versions[0].version).toBe(snap?.version)
  }, WORKFLOW_TIMEOUT_MS)

  it('an ABANDONED clean build never lends its version to the next import', async () => {
    // ═══ THE OTHER HALF OF THE DEFECT ═══════════════════════════════════════
    // Reordering verification stops a REJECTED import from leaving entries behind. It does
    // nothing about a CLEAN one the organizer simply walks away from — that build reached
    // the snapshot legitimately, and `nextSnapshotVersion` used to hand its pending version
    // to whoever asked next. This is the case that proves pending-lane OWNERSHIP, not just
    // the reordering.

    // ── Import A · clean, fully prepared, never published ───────────────────
    const a = await importAndPrepare([
      row(1, '101', 3_600_000),
      row(2, '102', 3_900_000),
      row(3, '103', 4_200_000),   // dropped from the corrected file
    ])
    expect(a.prepared).toBe(true)
    expect(await allEntries()).toHaveLength(3)
    const afterA = await raceSnapshot()
    expect(afterA?.pendingSessionId).toBe(a.sessionId)
    const abandonedVersion = afterA?.pendingVersion as number

    // The organizer walks away — no cancel, no publish. The lane stays open.

    // ── Import B · the corrected file ───────────────────────────────────────
    const b = await importAndPrepare([
      row(1, '101', 3_600_000),
      row(2, '102', 3_900_000),
    ])
    expect(b.prepared).toBe(true)

    const beforePublish = await raceSnapshot()
    // B did NOT inherit A's lane.
    expect(beforePublish?.pendingSessionId).toBe(b.sessionId)
    expect(beforePublish?.pendingVersion).not.toBe(abandonedVersion)

    const pub = await importService.publishSession({
      sessionId: b.sessionId, workspaceUid: UID, callerUid: ACTOR,
    })
    expect(pub.ok).toBe(true)

    const snap = await raceSnapshot()
    expect(snap?.version).not.toBe(abandonedVersion)
    expect(snap?.totalCount).toBe(2)

    // A's rows still physically exist — nothing is deleted — but they carry the abandoned
    // version, so no public query can reach them.
    const all = await allEntries()
    expect(all.length).toBeGreaterThan(2)
    expect(all.some(e => e.bibNumber === '103' && e.v === abandonedVersion)).toBe(true)

    const board = await publicResults.getLeaderboard(SLUG, 'half-marathon', null)
    expect(board?.rows.map(r => r.bibNumber)).toEqual(['101', '102'])
    expect(await publicResults.getRunnerResult(SLUG, 'half-marathon', '103')).toBeNull()

    // And 103 gets no certificate for a race it was withdrawn from.
    expect(await certificateResults.resolveCertificateRaceResult({
      eventSlug: SLUG, passId: PASS, bibNumber: '103',
    })).toEqual({ distance: '', finishTime: '', position: '' })
  }, WORKFLOW_TIMEOUT_MS)

  it('a replayed snapshot chunk cannot inflate the published count', async () => {
    // The build cursor used to come from the request body, so a re-sent chunk re-copied a
    // page and `bumpSnapshotCounts` incremented the totals again. The server owns it now.
    const { sessionId } = await importAndPrepare([
      row(1, '101', 3_600_000),
      row(2, '102', 3_900_000),
      row(3, '103', 4_200_000),
    ])

    // Replay the FIRST chunk three times, always claiming to start from the beginning.
    for (let i = 0; i < 3; i++) {
      const again = await snapshotService.buildSnapshotChunk({
        sessionId, workspaceUid: UID, afterRowNumber: null,
      })
      expect(again.ok).toBe(true)
    }

    const pub = await importService.publishSession({ sessionId, workspaceUid: UID, callerUid: ACTOR })
    expect(pub.ok).toBe(true)

    const snap = await raceSnapshot()
    expect(snap?.totalCount).toBe(3)          // not 6, not 12
    expect(snap?.finisherCount).toBe(3)
    expect(await allEntries()).toHaveLength(3)
  }, WORKFLOW_TIMEOUT_MS)
})
