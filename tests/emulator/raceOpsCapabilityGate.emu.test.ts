// RD-RACEOPS-02B · Race Operations is available only where the event's TYPE admits it —
// REAL Firestore (emulator), through the real services.
//
// The sidebar hides the row and the access gate refuses the page, but neither is the
// boundary. These tests drive the SERVICES every Race Operations route calls and prove:
//
//   A  sports + timing configuration            → allowed
//   F  sports + NO identifier/timing config     → allowed (the canonical rule is the event
//                                                  type; bibs reach `registrations.bibNumber`
//                                                  through the legacy mirror too, and the
//                                                  start-list check fails closed without them)
//   B–E, H  conference / workshop / meetup /
//           fundraising                          → refused before any session exists (409)
//   L  an existing session whose event stops
//      admitting Race Operations                → cannot be appended, verified, ranked,
//                                                  snapshotted, published or cancelled
//   J  and admits again                          → the same session proceeds
//
// Role authorization (K) is unchanged and lives in `authorizeRaceOps`, exercised by the
// route-level suites; the services below are reached only after it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const TIMEOUT_MS = 60_000

describeEmu('RD-RACEOPS-02B · event-type capability gate, end to end', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let importService: typeof import('@/features/race-operations/services/importService')
  let snapshotService: typeof import('@/features/race-operations/services/snapshotService')
  let registrationVerify: typeof import('@/features/race-operations/services/registrationVerify')
  let eventReadRepo: typeof import('@/features/race-operations/repositories/eventReadRepo')
  let snapshotRepo: typeof import('@/features/race-operations/repositories/snapshotRepo')
  let snapshotTypes: typeof import('@/features/race-operations/types/snapshot')

  const UID   = `emu-raceops-gate-${process.pid}`
  const ACTOR = 'gate-actor'
  const PASS  = 'pass_10k'

  // One draft + published event per type under test. The published `events/{slug}` doc is
  // identical for all of them: the gate must decide on the DRAFT's type, which is the same
  // field the organizer's event list is built from.
  const TYPES = ['sports', 'conference', 'workshop', 'meetup', 'fundraising'] as const
  const eventIdOf = (type: string) => `evt_gate_${type}_${process.pid}`
  const slugOf    = (type: string) => `evt-gate-${type}-${process.pid}`

  async function seedEvent(type: string, opts: { identifiers?: boolean } = {}) {
    const b = adminDb.batch()
    b.set(adminDb.doc(`users/${UID}/eventDrafts/${eventIdOf(type)}`), {
      eventType: type,
      eventDetails: { seo: { urlSlug: slugOf(type) }, info: { name: `Gate ${type}` }, schedule: { startDate: '2026-02-01' } },
    })
    b.set(adminDb.doc(`events/${slugOf(type)}`), {
      uid: UID, draftId: eventIdOf(type), eventSlug: slugOf(type), lifecycleStatus: 'published',
      eventDetails: { info: { name: `Gate ${type}` } },
      pricing: { passes: [{ id: PASS, name: '10K' }] },
    })
    if (opts.identifiers) {
      b.set(adminDb.doc(`identifierConfigs/${slugOf(type)}`), {
        eventSlug: slugOf(type), enabled: true, label: 'Bib', tagMapping: { enabled: true, mode: 'import', label: 'Timing Chip' },
      })
    }
    b.set(adminDb.doc(`registrations/gate_${process.pid}_${type}_101`), {
      organizerUid: UID, eventSlug: slugOf(type), passId: PASS, status: 'confirmed', bibNumber: '101',
      attendee: { name: 'Runner 101' },
    })
    await b.commit()
  }

  async function cleanup() {
    const b = adminDb.batch()
    for (const type of TYPES) {
      b.delete(adminDb.doc(`users/${UID}/eventDrafts/${eventIdOf(type)}`))
      b.delete(adminDb.doc(`events/${slugOf(type)}`))
      b.delete(adminDb.doc(`identifierConfigs/${slugOf(type)}`))
    }
    for (const col of ['registrations', 'raceImportSessions']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      for (const d of snap.docs) {
        if (col === 'raceImportSessions') {
          const rows = await d.ref.collection('results').get()
          rows.docs.forEach(r => b.delete(r.ref))
        }
        b.delete(d.ref)
      }
    }
    await b.commit()
    const id = snapshotTypes.snapshotId(slugOf('sports'), PASS)
    const entries = await adminDb.collection('raceResultSnapshots').doc(id).collection('entries').get()
    const b2 = adminDb.batch(); entries.docs.forEach(d => b2.delete(d.ref)); await b2.commit()
    await adminDb.collection('raceResultSnapshots').doc(id).delete().catch(() => null)
  }

  const row = (rowNumber: number, bib: string, ms: number) => ({
    rowNumber, participantName: `R${bib}`, bibNumber: bib, chipTimeMs: ms, gunTimeMs: null,
    chipTimeRaw: '00:40:00', gunTimeRaw: null, status: 'finished' as const, statusRaw: null,
    gender: null, category: null, ageGroup: null, rawRow: { Bib: bib }, sourceProvider: 'csv',
  })

  const create = (type: string) => importService.createImportSession({
    workspaceUid: UID, callerUid: ACTOR, eventId: eventIdOf(type), passId: PASS,
    fileName: 'r.csv', fileHash: 'h', provider: 'csv', mapping: { bibNumber: 'Bib', chipTime: 'Time' }, totalRows: 1,
  })

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    importService      = await import('@/features/race-operations/services/importService')
    snapshotService    = await import('@/features/race-operations/services/snapshotService')
    registrationVerify = await import('@/features/race-operations/services/registrationVerify')
    eventReadRepo      = await import('@/features/race-operations/repositories/eventReadRepo')
    snapshotRepo       = await import('@/features/race-operations/repositories/snapshotRepo')
    snapshotTypes      = await import('@/features/race-operations/types/snapshot')
    await cleanup().catch(() => null)
    await seedEvent('sports', { identifiers: true })
    for (const t of TYPES.slice(1)) await seedEvent(t)
  }, TIMEOUT_MS)

  afterAll(async () => { await cleanup() }, TIMEOUT_MS)

  it('A · a sports event with timing configuration resolves its race', async () => {
    const r = await eventReadRepo.resolveRace(UID, eventIdOf('sports'), PASS)
    expect(r.ok).toBe(true)
  }, TIMEOUT_MS)

  it.each(['conference', 'workshop', 'meetup', 'fundraising'])(
    'B–E/H · a %s event is refused before any session exists — 409, the type reason, nothing created', async type => {
      const resolved = await eventReadRepo.resolveRace(UID, eventIdOf(type), PASS)
      expect(resolved).toEqual({ ok: false, status: 409, error: eventReadRepo.RACE_OPS_TYPE_ERROR })
      const created = await create(type)
      expect(created.ok).toBe(false)
      if (!created.ok) expect(created.status).toBe(409)
      const sessions = await adminDb.collection('raceImportSessions')
        .where('organizerUid', '==', UID).where('eventId', '==', eventIdOf(type)).get()
      expect(sessions.size).toBe(0)
      // the rollback / versions path is gated by the same resolution
      const rollback = await snapshotRepo.rollbackSnapshot({
        eventSlug: slugOf(type), passId: PASS, organizerUid: UID, toVersion: 1, actorUid: ACTOR,
      })
      expect(rollback.ok).toBe(false)
    }, TIMEOUT_MS)

  it('an event that does not exist in this workspace is still 404, not 409 — ownership answers before capability', async () => {
    const r = await eventReadRepo.resolveRaceOpsEvent(UID, 'no-such-event')
    expect(r).toEqual({ ok: false, status: 404, error: 'Event not found' })
  }, TIMEOUT_MS)

  it('F · a sports event with NO identifier or timing configuration is still admitted — type is the rule', async () => {
    await adminDb.doc(`identifierConfigs/${slugOf('sports')}`).delete()
    const r = await eventReadRepo.resolveRace(UID, eventIdOf('sports'), PASS)
    expect(r.ok).toBe(true)
  }, TIMEOUT_MS)

  it('L/J · an existing session follows its event: refused while the type no longer admits results, allowed again when it does', async () => {
    const created = await create('sports')
    expect(created.ok).toBe(true)
    const sessionId = created.ok ? created.value.sessionId : ''
    const draftRef = adminDb.doc(`users/${UID}/eventDrafts/${eventIdOf('sports')}`)

    // The event stops being a sports event (a console edit, a wrong wizard choice corrected).
    await draftRef.update({ eventType: 'conference' })
    const refused = [
      await importService.appendResults({ sessionId, workspaceUid: UID, results: [row(2, '101', 2_400_000)] }),
      await registrationVerify.verifySessionRegistrations({ sessionId, workspaceUid: UID }),
      await importService.rankSessionChunk({ sessionId, workspaceUid: UID }),
      await snapshotService.buildSnapshotChunk({ sessionId, workspaceUid: UID }),
      await importService.publishSession({ sessionId, workspaceUid: UID, callerUid: ACTOR }),
      await importService.cancelSession({ sessionId, workspaceUid: UID, callerUid: ACTOR }),
    ]
    for (const r of refused) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect([r.status, r.error]).toEqual([409, eventReadRepo.RACE_OPS_TYPE_ERROR])
    }
    // nothing was written while refused
    const rows = await adminDb.collection('raceImportSessions').doc(sessionId).collection('results').get()
    expect(rows.size).toBe(0)
    const still = await adminDb.collection('raceImportSessions').doc(sessionId).get()
    expect(still.data()?.status).toBe('draft')

    // J · the event is a sports event again: the very same session proceeds to publish.
    await draftRef.update({ eventType: 'sports' })
    const appended = await importService.appendResults({ sessionId, workspaceUid: UID, results: [row(2, '101', 2_400_000)] })
    expect(appended.ok).toBe(true)
    const verified = await registrationVerify.verifySessionRegistrations({ sessionId, workspaceUid: UID })
    expect(verified.ok && verified.value.blocking).toBe(false)
    let done = false
    while (!done) { const k = await importService.rankSessionChunk({ sessionId, workspaceUid: UID }); expect(k.ok).toBe(true); done = k.ok && k.value.done }
    done = false
    while (!done) { const s = await snapshotService.buildSnapshotChunk({ sessionId, workspaceUid: UID }); expect(s.ok).toBe(true); done = s.ok && s.value.done }
    const published = await importService.publishSession({ sessionId, workspaceUid: UID, callerUid: ACTOR })
    expect(published.ok).toBe(true)
    const live = await snapshotRepo.getLiveSnapshotByPass(slugOf('sports'), PASS)
    expect(live?.status).toBe('live')
  }, TIMEOUT_MS)
})
