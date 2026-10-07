// RD-RACEOPS-RESULTS-06 · A text PDF reaches the public runner page — REAL Firestore.
//
// The point of this suite is that there is NOTHING PDF-specific past the parser. The same
// services, the same roster gate, the same snapshot, the same publish transaction and the
// same public read serve a PDF-originated result, and a PDF import and an equivalent
// spreadsheet import land on byte-identical canonical data.
//
// ⚠ The PDFs are SYNTHETIC (tests/helpers/syntheticResultPdf.ts). They prove the pipeline,
// not any real provider's export — real-provider parity is RESULTS-07 and needs a real file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { runnerBlockPdf, flatTablePdf, sectionedTablePdf, type BlockRunner } from '../helpers/syntheticResultPdf'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000

describeEmu('RD-RACEOPS-RESULTS-06 · PDF → public runner result', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let svc: typeof import('@/features/race-operations/services/importService')
  let snapSvc: typeof import('@/features/race-operations/services/snapshotService')
  let verify: typeof import('@/features/race-operations/services/registrationVerify')
  let repo: typeof import('@/features/race-operations/repositories/snapshotRepo')
  let pub: typeof import('@/features/race-operations/services/publicResults')
  let keys: typeof import('@/features/race-operations/utils/publicKeys')
  let types: typeof import('@/features/race-operations/types/snapshot')
  let perf: typeof import('@/features/race-operations/utils/performance')
  let imp: typeof import('@/features/race-operations/import')
  let extract: typeof import('@/features/race-operations/import/parsers/pdf/extract')

  const UID_A = `emu-pdf-a-${process.pid}`, UID_B = `emu-pdf-b-${process.pid}`, ACTOR = 'pdf-actor'
  const EV_A = `evt_pdf_a_${process.pid}`, SLUG_A = `evt-pdf-a-${process.pid}`
  const EV_B = `evt_pdf_b_${process.pid}`, SLUG_B = `evt-pdf-b-${process.pid}`
  const PASS = 'p10k', PASS_NAME = '10K'
  const PASS_SLUG = () => keys.passSlug(PASS_NAME, PASS)

  const ms = (clock: string) => {
    const p = clock.split(':').map(Number)
    return p.length === 3 ? ((p[0] * 60 + p[1]) * 60 + p[2]) * 1000 : (p[0] * 60 + p[1]) * 1000
  }

  const TARGET: BlockRunner = {
    name: 'Sureshkumar V', bib: '10571', gender: 'Male', ageGroup: 'Below 35yrs - Men',
    category: '10K', distance: '10 KM', gun: '00:32:38', net: '00:32:35',
    overallRank: '1 / 931', pace: '03:15 min/km', speed: '18.4 km/h',
    splits: [
      { split: '5KM',  distance: '5 KM',  overall: '00:16:05', lapDistance: '5 KM', lapTime: '00:16:05' },
      { split: '10KM', distance: '10 KM', overall: '00:32:35', lapDistance: '5 KM', lapTime: '00:16:30' },
    ],
  }
  const FIELD: BlockRunner[] = [
    TARGET,
    { ...TARGET, name: 'Arun P',  bib: '10572', net: '00:34:10', gun: '00:34:13', splits: [
      { split: '5KM',  distance: '5 KM',  overall: '00:17:00', lapDistance: '5 KM', lapTime: '00:17:00' },
      { split: '10KM', distance: '10 KM', overall: '00:34:10', lapDistance: '5 KM', lapTime: '00:17:10' },
    ] },
    { ...TARGET, name: 'Meena R', bib: '10573', gender: 'Female', ageGroup: 'Below 35yrs - Women', net: '00:36:05', gun: '00:36:08', splits: [] },
  ]

  async function seed() {
    const b = adminDb.batch()
    for (const [uid, ev, slug, name] of [[UID_A, EV_A, SLUG_A, 'PDF Event A'], [UID_B, EV_B, SLUG_B, 'PDF Event B']]) {
      b.set(adminDb.doc(`users/${uid}/eventDrafts/${ev}`), { eventType: 'sports', eventDetails: { seo: { urlSlug: slug }, info: { name }, schedule: { startDate: '2026-06-07' } } })
      b.set(adminDb.doc(`events/${slug}`), { uid, draftId: ev, eventSlug: slug, lifecycleStatus: 'published', eventDetails: { info: { name } }, pricing: { passes: [{ id: PASS, name: PASS_NAME }] } })
    }
    for (const r of FIELD) {
      b.set(adminDb.doc(`registrations/pdf_${process.pid}_a_${r.bib}`), {
        organizerUid: UID_A, eventSlug: SLUG_A, passId: PASS, status: 'confirmed',
        bibNumber: r.bib, attendee: { name: r.name, email: `${r.bib}@pdf.test` },
      })
    }
    // The SAME bib in organizer B's event belongs to someone else entirely.
    b.set(adminDb.doc(`registrations/pdf_${process.pid}_b_${TARGET.bib}`), {
      organizerUid: UID_B, eventSlug: SLUG_B, passId: PASS, status: 'confirmed',
      bibNumber: TARGET.bib, attendee: { name: 'Different Person' },
    })
    await b.commit()
  }
  async function cleanup() {
    const del = async (refs: FirebaseFirestore.DocumentReference[]) => {
      for (let i = 0; i < refs.length; i += 400) { const b = adminDb.batch(); refs.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit() }
    }
    for (const uid of [UID_A, UID_B]) {
      for (const s of (await adminDb.collection('raceImportSessions').where('organizerUid', '==', uid).get()).docs) {
        await del(await s.ref.collection('results').listDocuments()); await s.ref.delete()
      }
      await del((await adminDb.collection('registrations').where('organizerUid', '==', uid).get()).docs.map(d => d.ref))
      await del(await adminDb.collection(`users/${uid}/eventDrafts`).listDocuments())
    }
    for (const slug of [SLUG_A, SLUG_B]) {
      const ref = adminDb.collection('raceResultSnapshots').doc(types.snapshotId(slug, PASS))
      await del(await ref.collection('entries').listDocuments())
      await del(await ref.collection(types.SNAPSHOT_SPLITS_SUBCOLLECTION).listDocuments())
      await ref.delete().catch(() => null)
      await adminDb.doc(`events/${slug}`).delete().catch(() => null)
    }
  }

  /** bytes → canonical rows, through the real extractor and the EXISTING pipeline. */
  async function rowsFromPdf(bytes: Uint8Array) {
    const extracted = await extract.extractPdfPages(bytes)
    if (!extracted.ok) throw new Error(`${extracted.error.code}: ${extracted.error.message}`)
    const built = imp.reconstruct(extracted.pages)
    if (!built.ok) throw new Error(`${built.error.code}: ${built.error.message}`)

    const table = imp.tabulate(built.value.results, { provider: 'pdf', sheetName: 'PDF' })
    if (!table.ok) throw new Error(table.message)
    const auto = imp.autoMapColumns(table.table.headers)
    const mapped = imp.applyMapping(table.table, auto.mapping)

    if (!built.value.splits) return { rows: mapped, issues: [] as ReturnType<typeof imp.attachSplits>['issues'] }
    const st = imp.tabulate(built.value.splits, { provider: 'pdf', sheetName: 'PDF splits' })
    if (!st.ok) return { rows: mapped, issues: [] }
    const parsed = imp.parseSplitSheet(st.table, imp.autoMapSplitColumns(st.table.headers))
    const attached = imp.attachSplits(mapped, parsed)
    return { rows: attached.results, issues: [...parsed.issues, ...attached.issues] }
  }

  async function publishRows(uid: string, eventId: string, rows: import('@/features/race-operations/types/results').NormalizedRaceResult[], hash: string) {
    const created = await svc.createImportSession({
      workspaceUid: uid, callerUid: ACTOR, eventId, passId: PASS, fileName: 'results.pdf',
      fileHash: hash, provider: 'pdf', mapping: { bibNumber: 'Bib Number', chipTime: 'Chip Time' }, totalRows: rows.length,
    })
    if (!created.ok) throw new Error(created.error)
    const sid = created.value.sessionId
    const a = await svc.appendResults({ sessionId: sid, workspaceUid: uid, results: rows })
    if (!a.ok) return { sid, failure: `${a.status} ${a.error}` }
    const v = await verify.verifySessionRegistrations({ sessionId: sid, workspaceUid: uid })
    if (!v.ok) return { sid, failure: `${v.status} ${v.error}` }
    if (v.value.blocking) return { sid, failure: `blocking unknown=${v.value.unknownRunner} wrongRace=${v.value.wrongRace}` }
    for (;;) { const k = await svc.rankSessionChunk({ sessionId: sid, workspaceUid: uid }); if (!k.ok) return { sid, failure: k.error }; if (k.value.done) break }
    for (;;) { const s = await snapSvc.buildSnapshotChunk({ sessionId: sid, workspaceUid: uid }); if (!s.ok) return { sid, failure: s.error }; if (s.value.done) break }
    const p = await svc.publishSession({ sessionId: sid, workspaceUid: uid, callerUid: ACTOR })
    return p.ok ? { sid, failure: null } : { sid, failure: `${p.status} ${p.error}` }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    svc = await import('@/features/race-operations/services/importService')
    snapSvc = await import('@/features/race-operations/services/snapshotService')
    verify = await import('@/features/race-operations/services/registrationVerify')
    repo = await import('@/features/race-operations/repositories/snapshotRepo')
    pub = await import('@/features/race-operations/services/publicResults')
    keys = await import('@/features/race-operations/utils/publicKeys')
    types = await import('@/features/race-operations/types/snapshot')
    perf = await import('@/features/race-operations/utils/performance')
    imp = await import('@/features/race-operations/import')
    extract = await import('@/features/race-operations/import/parsers/pdf/extract')
    await cleanup().catch(() => null)
    await seed()
  }, T)
  afterAll(async () => { await cleanup() }, T)

  it('a PDF publishes through the existing pipeline and reaches the public runner page', async () => {
    const regsBefore = (await adminDb.collection('registrations').where('organizerUid', '==', UID_A).get()).size

    const { rows, issues } = await rowsFromPdf(await runnerBlockPdf(FIELD, { perPage: 2 }))
    expect(issues.filter(i => i.severity === 'error')).toEqual([])
    expect(rows).toHaveLength(3)

    const outcome = await publishRows(UID_A, EV_A, rows, 'pdf-v1')
    expect(outcome.failure).toBeNull()

    // identity: nothing was created by the import
    const regsAfter = (await adminDb.collection('registrations').where('organizerUid', '==', UID_A).get()).size
    expect(regsAfter).toBe(regsBefore)
    for (const c of ['participants', 'runners', 'raceParticipants']) {
      expect((await adminDb.collection(c).limit(1).get()).size, c).toBe(0)
    }

    // the public page — the SAME one an XLSX import produces
    const runner = (await pub.getRunnerResult(SLUG_A, PASS_SLUG(), TARGET.bib))!
    expect(runner.result).toMatchObject({
      bibNumber: '10571', name: 'Sureshkumar V', gender: 'Male',
      ageGroup: 'Below 35yrs - Men', distanceMeters: 10_000,
      chipTimeMs: ms('00:32:35'), gunTimeMs: ms('00:32:38'), overallRank: 1,
    })
    expect(perf.formatPace(runner.result.paceMsPerKm)).toBe('3:15')
    expect(perf.formatSpeed(runner.result.speedKmh)).toBe('18.4 km/h')
    // ranks are RegisterDesk's own: 2 men finished, 1 woman
    expect(runner.result.genderRank).toBe(1)
    expect(runner.result.genderTotal).toBe(2)
    expect(runner.result.ageGroupTotal).toBe(2)

    // splits survived, cumulative and segment still distinct
    expect(runner.splits).toHaveLength(2)
    expect(runner.splits[1]).toMatchObject({
      name: '10KM', distanceMeters: 10_000, segmentMeters: 5_000,
      cumulativeTimeMs: ms('00:32:35'), segmentTimeMs: ms('00:16:30'),
    })

    // nothing private crossed the boundary
    const json = JSON.stringify(runner)
    for (const leak of ['@pdf.test', UID_A, EV_A, 'ris_', 'rawRow', 'bibKey']) {
      expect(json.includes(leak), leak).toBe(false)
    }
  }, T)

  it('a PDF-originated result is byte-identical to the same data imported as a sheet', async () => {
    const { rows: fromPdf } = await rowsFromPdf(await runnerBlockPdf([TARGET]))

    const sheet = imp.tabulate([
      ['Bib Number', 'Participant Name', 'Distance', 'Chip Time', 'Gun Time', 'Gender', 'Category', 'Age Group'],
      ['10571', 'Sureshkumar V', '10 KM', '00:32:35', '00:32:38', 'Male', '10K', 'Below 35yrs - Men'],
    ], { provider: 'excel', sheetName: 'Results' })
    if (!sheet.ok) throw new Error(sheet.message)
    const splitSheet = imp.tabulate([
      ['Bib Number', 'Split', 'Distance', 'Time of Day', 'Elapsed Time', 'Lap Distance', 'Split Time'],
      ['10571', '5KM',  '5 KM',  '', '00:16:05', '5 KM', '00:16:05'],
      ['10571', '10KM', '10 KM', '', '00:32:35', '5 KM', '00:16:30'],
    ], { provider: 'excel', sheetName: 'Splits' })
    if (!splitSheet.ok) throw new Error(splitSheet.message)
    const mapped = imp.applyMapping(sheet.table, imp.autoMapColumns(sheet.table.headers).mapping)
    const fromSheet = imp.attachSplits(mapped, imp.parseSplitSheet(splitSheet.table)).results

    const canonical = (r: import('@/features/race-operations/types/results').NormalizedRaceResult) => ({
      bibNumber: r.bibNumber, participantName: r.participantName, gender: r.gender,
      category: r.category, ageGroup: r.ageGroup, distanceMeters: r.distanceMeters,
      chipTimeMs: r.chipTimeMs, gunTimeMs: r.gunTimeMs, status: r.status,
      splits: (r.splits ?? []).map(s => ({ ...s })),
    })
    expect(canonical(fromPdf[0])).toEqual(canonical(fromSheet[0]))
  }, T)

  it('a PDF naming the wrong person still resolves by BIB, and never renames the registration', async () => {
    const { rows } = await rowsFromPdf(await runnerBlockPdf([{ ...TARGET, name: 'WRONG NAME ENTIRELY' }]))
    expect(rows[0].bibNumber).toBe(TARGET.bib)
    expect(rows[0].participantName).toBe('WRONG NAME ENTIRELY')

    const reg = await adminDb.collection('registrations')
      .where('organizerUid', '==', UID_A).where('bibNumber', '==', TARGET.bib).get()
    expect(reg.docs[0].data().attendee.name).toBe('Sureshkumar V')
  }, T)

  it('an unknown bib in a PDF blocks the publish', async () => {
    const { rows } = await rowsFromPdf(await runnerBlockPdf([{ ...TARGET, bib: '99999' }]))
    expect(rows[0].bibNumber).toBe('99999')
    const outcome = await publishRows(UID_A, EV_A, rows, 'pdf-unknown')
    expect(outcome.failure).toMatch(/blocking|unknown/i)
  }, T)

  it('a duplicate bib in a PDF is refused before anything is stored', async () => {
    const { rows } = await rowsFromPdf(await runnerBlockPdf([TARGET, { ...TARGET, name: 'Twin' }]))
    expect(rows).toHaveLength(2)
    const outcome = await publishRows(UID_A, EV_A, rows, 'pdf-dup')
    expect(outcome.failure).toMatch(/409|already|more than once|once per/i)
    const stored = await adminDb.collection('raceImportSessions').doc(outcome.sid).collection('results').count().get()
    expect(stored.data().count).toBe(0)
  }, T)

  it('the same bib in another organizer\'s event stays in that event', async () => {
    const { rows } = await rowsFromPdf(await runnerBlockPdf([{ ...TARGET, name: 'Different Person', net: '00:40:00', gun: '00:40:05', splits: [] }]))
    const outcome = await publishRows(UID_B, EV_B, rows, 'pdf-cross')
    expect(outcome.failure).toBeNull()

    const inA = (await pub.getRunnerResult(SLUG_A, PASS_SLUG(), TARGET.bib))!
    const inB = (await pub.getRunnerResult(SLUG_B, PASS_SLUG(), TARGET.bib))!
    expect(inA.result.name).toBe('Sureshkumar V')
    expect(inB.result.name).toBe('Different Person')
    expect(inA.result.chipTimeMs).not.toBe(inB.result.chipTimeMs)
  }, T)

  it('a PDF republish versions and rolls back exactly as a spreadsheet does', async () => {
    const snapRef = adminDb.collection('raceResultSnapshots').doc(types.snapshotId(SLUG_A, PASS))
    const v1 = (await snapRef.get()).data()!.version as number

    const slower = FIELD.map(r => ({
      ...r, net: r.net?.replace(':3', ':4'), gun: r.gun?.replace(':3', ':4'),
      splits: (r.splits ?? []).map(s => ({ ...s, overall: s.overall?.replace(':3', ':4') })),
    }))
    const { rows } = await rowsFromPdf(await runnerBlockPdf(slower as BlockRunner[], { perPage: 2 }))
    expect((await publishRows(UID_A, EV_A, rows, 'pdf-v2')).failure).toBeNull()

    const v2 = (await snapRef.get()).data()!.version as number
    expect(v2).toBe(v1 + 1)
    const ids = (await snapRef.collection(types.SNAPSHOT_SPLITS_SUBCOLLECTION).listDocuments()).map(d => d.id)
    expect(ids).toContain(`v${v1}__${TARGET.bib}`)
    expect(ids).toContain(`v${v2}__${TARGET.bib}`)

    const rb = await repo.rollbackSnapshot({ eventSlug: SLUG_A, passId: PASS, organizerUid: UID_A, toVersion: v1, actorUid: ACTOR })
    expect(rb.ok).toBe(true)
    const restored = (await pub.getRunnerResult(SLUG_A, PASS_SLUG(), TARGET.bib))!
    expect(restored.result.chipTimeMs).toBe(ms('00:32:35'))
    expect(restored.splits[1].cumulativeTimeMs).toBe(ms('00:32:35'))
  }, T)

  // RD-RACEOPS-RESULTS-07A · the server side of the fix: authorization runs BEFORE any byte
  // is parsed, and a request with no Bearer token is a 401 carrying no result data.
  it('the parse route refuses an unauthenticated request with 401, before parsing', async () => {
    const { POST } = await import('@/app/api/organizer/race-operations/results/parse-pdf/route')
    const { NextRequest } = await import('next/server')
    const bytes = await runnerBlockPdf([TARGET])
    const req = new NextRequest(`http://localhost/api/organizer/race-operations/results/parse-pdf?eventId=${EV_A}`, {
      method: 'POST', body: bytes, headers: { 'Content-Type': 'application/pdf' },
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
    const body = await res.json() as { error?: string; results?: unknown }
    expect(body.results).toBeUndefined()
    expect(body.error).toMatch(/unauthori[sz]ed/i)

    // …and a forged token is refused too — the check is verification, not presence.
    const forged = new NextRequest(`http://localhost/api/organizer/race-operations/results/parse-pdf?eventId=${EV_A}`, {
      method: 'POST', body: await runnerBlockPdf([TARGET]),
      headers: { 'Content-Type': 'application/pdf', Authorization: 'Bearer not-a-real-token' },
    })
    const res2 = await POST(forged)
    expect(res2.status).toBe(401)
  }, T)

  it('a flat-table PDF publishes through the same path', async () => {
    const { rows } = await rowsFromPdf(await flatTablePdf(FIELD.map(r => ({
      bib: r.bib, name: r.name, gender: r.gender, category: r.category,
      ageGroup: r.ageGroup, distance: r.distance, gun: r.gun, net: r.net,
    }))))
    expect(rows).toHaveLength(3)
    expect(rows[0].distanceMeters).toBe(10_000)
    const outcome = await publishRows(UID_A, EV_A, rows, 'pdf-flat')
    expect(outcome.failure).toBeNull()
    const runner = (await pub.getRunnerResult(SLUG_A, PASS_SLUG(), TARGET.bib))!
    expect(runner.result.chipTimeMs).toBe(ms('00:32:35'))
    expect(runner.splits).toEqual([])            // a flat table carried no checkpoints
  }, T)

  // ─── RD-RACEOPS-RESULTS-07B · the real provider's header + sectioned layout ──────────
  // Exact heading spellings from the real listings RESULTS-07 audited; synthetic rows.
  it('07B · a grouped listing under `Pl. | Bib | Name | Finish ChipTime | Finish TimeOfDay` publishes with section gender / band, ranked by RegisterDesk', async () => {
    const regsBefore = (await adminDb.collection('registrations').where('organizerUid', '==', UID_A).get()).size
    const { rows, issues } = await rowsFromPdf(await sectionedTablePdf(
      ['Pl.', 'Bib', 'Name', 'Finish ChipTime', 'Finish TimeOfDay'],
      [
        { section: 'Male' },
        { section: '16-25 Yrs' },
        // the provider's placing is deliberately WRONG (3, 1) so an imported rank would show
        { cells: ['3', TARGET.bib, TARGET.name, '32:35', '07:02:35'] },
        { cells: ['1', '10572',    'Arun P',    '34:10', '07:04:10'] },
        { section: 'Female' },
        { section: '26-45 Yrs' },
        { cells: ['2', '10573',    'Meena R',   '36:05', '07:06:05'] },
      ],
    ))
    expect(issues.filter(i => i.severity === 'error')).toEqual([])
    expect(rows).toHaveLength(3)                                          // no heading became a row
    expect(rows.map(r => r.chipTimeMs)).toEqual([ms('32:35'), ms('34:10'), ms('36:05')])
    expect(rows.every(r => r.gunTimeMs === null)).toBe(true)              // Finish TimeOfDay imported nowhere
    expect(rows.map(r => r.gender)).toEqual(['Male', 'Male', 'Female'])
    expect(rows.map(r => r.ageGroup)).toEqual(['Male 16-25', 'Male 16-25', 'Female 26-45'])   // the section's identity: the band is nested under the gender

    const outcome = await publishRows(UID_A, EV_A, rows, 'pdf-07b-sectioned')
    expect(outcome.failure).toBeNull()
    expect((await adminDb.collection('registrations').where('organizerUid', '==', UID_A).get()).size).toBe(regsBefore)

    const first  = (await pub.getRunnerResult(SLUG_A, PASS_SLUG(), TARGET.bib))!
    const second = (await pub.getRunnerResult(SLUG_A, PASS_SLUG(), '10572'))!
    const third  = (await pub.getRunnerResult(SLUG_A, PASS_SLUG(), '10573'))!
    // RegisterDesk's rank from chip time — the printed "Pl." (3, 1, 2) is nowhere
    expect([first, second, third].map(r => r.result.overallRank)).toEqual([1, 2, 3])
    expect(first.result).toMatchObject({ gender: 'Male',   ageGroup: 'Male 16-25', genderRank: 1, genderTotal: 2, ageGroupRank: 1, ageGroupTotal: 2 })
    expect(second.result).toMatchObject({ gender: 'Male',  ageGroup: 'Male 16-25', genderRank: 2, genderTotal: 2, ageGroupRank: 2, ageGroupTotal: 2 })
    expect(third.result).toMatchObject({ gender: 'Female', ageGroup: 'Female 26-45', genderRank: 1, genderTotal: 1, ageGroupRank: 1, ageGroupTotal: 1 })
    expect(first.result.chipTimeMs).toBe(ms('32:35'))
    expect(first.result.gunTimeMs).toBeNull()
    for (const r of [first, second, third]) {
      const json = JSON.stringify(r)
      expect(json.includes('07:0'), 'time-of-day leaked').toBe(false)
      expect(json.includes('(section)'), 'internal column label leaked').toBe(false)
    }
  }, T)
})
