// RD-EVENT-19E · identifier assignment EXECUTION against REAL Firestore (emulator).
//
// This is the phase that actually writes identifiers to people, so the properties
// that matter are the ones only a real datastore can demonstrate:
//   • running the same job twice assigns nobody a second number;
//   • a retried chunk resumes from its cursor instead of restarting;
//   • a pass is only ever served from its OWN pool;
//   • a gapped range jumps the gap;
//   • exhaustion stops the run and reports it, and what was committed stays;
//   • the cron and the client cannot process the same chunk at once;
//   • a newly assigned identifier is immediately usable at check-in.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

describeEmu('RD-EVENT-19E · assignment execution', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let job: typeof import('@/lib/identifiers/assignmentJob')
  let engine: typeof import('@/lib/identifiers/engine')
  let config: typeof import('@/lib/identifiers/config')

  const PID   = process.pid
  const SLUG  = `id19e-${PID}`
  const EVENT = `id19e-event-${PID}`
  const UID   = `id19e-org-${PID}`
  const PASS_A = 'pass-alpha'
  const PASS_B = 'pass-beta'

  const regId = (n: number) => `${SLUG}-reg-${String(n).padStart(4, '0')}`

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    job    = await import('@/lib/identifiers/assignmentJob')
    engine = await import('@/lib/identifiers/engine')
    config = await import('@/lib/identifiers/config')
  })

  // ── Fixtures ───────────────────────────────────────────────────────────────

  async function wipe() {
    for (const col of ['identifierLocks', 'identifierCounters', 'identifierHistory', 'registrations']) {
      const snap = await adminDb.collection(col).where('eventSlug', '==', SLUG).get()
      const b = adminDb.batch(); snap.docs.forEach(d => b.delete(d.ref)); await b.commit()
    }
    const jobs = await adminDb.collection('identifierAssignmentJobs').where('eventSlug', '==', SLUG).get()
    const jb = adminDb.batch(); jobs.docs.forEach(d => jb.delete(d.ref)); await jb.commit()
    await adminDb.collection('identifierConfigs').doc(SLUG).delete()
    await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).delete()
  }

  async function seedEvent(lifecycleStatus = 'published') {
    await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).set({
      lifecycleStatus,
      eventDetails: { info: { name: 'Execution QA' }, seo: { urlSlug: SLUG } },
      pricing: { eventType: 'free', passes: [
        { id: PASS_A, name: 'Alpha', price: 0, status: 'active' },
        { id: PASS_B, name: 'Beta',  price: 0, status: 'active' },
      ] },
      updatedAt: new Date(),
    })
  }

  async function seedConfig(patch: Record<string, unknown>) {
    await adminDb.collection('identifierConfigs').doc(SLUG).set({
      ...config.defaultIdentifierConfig(SLUG),
      type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
      ...patch, eventSlug: SLUG,
    })
  }

  async function seedRegistrations(count: number, passId: string, status = 'confirmed', from = 1) {
    const b = adminDb.batch()
    for (let i = from; i < from + count; i++) {
      b.set(adminDb.collection('registrations').doc(regId(i)), {
        eventSlug: SLUG, organizerUid: UID, passId, passName: passId,
        attendee: { name: `P${i}`, email: `p${i}@test.local` },
        status, paymentStatus: 'paid', amount: 0, ticketCode: `RD-${PID}-${i}`, createdAt: new Date(),
      })
    }
    await b.commit()
  }

  const createJob = (passId: string | null, poolId: string) =>
    job.createIdentifierAssignmentJob({
      eventId: EVENT, eventSlug: SLUG, organizerUid: UID, createdBy: UID,
      passId, passName: passId, poolId, label: 'Participant Number', total: 0,
    })

  /** Drives a job to completion the way the route + cron together would. */
  async function runToEnd(jobId: string, maxChunks = 60) {
    for (let i = 0; i < maxChunks; i++) {
      const r = await job.processIdentifierAssignmentChunk(jobId)
      if (r.done) return r
    }
    throw new Error('job did not finish')
  }

  const heldBy = async (n: number) =>
    (await adminDb.collection('registrations').doc(regId(n)).get()).get('identifier')?.value as string | undefined

  const assignedValues = async () => {
    const snap = await adminDb.collection('registrations').where('eventSlug', '==', SLUG).get()
    return snap.docs
      .map(d => d.get('identifier')?.value as string | undefined)
      .filter((v): v is string => typeof v === 'string')
      .sort((a, b) => Number(a) - Number(b))
  }

  beforeEach(wipe)
  afterAll(wipe)

  // ══ 1. It assigns, and it assigns the right numbers ══════════════════════

  describe('1 — a run assigns the pass from its own pool', () => {
    beforeEach(async () => {
      await seedEvent()
      await seedConfig({
        pools: [
          { poolId: 'pa', label: 'Alpha', passIds: [PASS_A], ranges: [{ start: 5001, end: 5999 }] },
          { poolId: 'pb', label: 'Beta',  passIds: [PASS_B], ranges: [{ start: 7000, end: 7999 }] },
        ],
        defaultPoolId: 'pa',
      })
    }, 60_000)

    it('assigns every eligible participant on the pass', async () => {
      await seedRegistrations(5, PASS_A)
      const j = await createJob(PASS_A, 'pa')
      const r = await runToEnd(j.jobId)

      expect(r.status).toBe('completed')
      const after = await job.getIdentifierAssignmentJob(j.jobId)
      expect(after!.counts.succeeded).toBe(5)
      expect(after!.reasons.ASSIGNED).toBe(5)
      expect(await assignedValues()).toEqual(['5001', '5002', '5003', '5004', '5005'])
    }, 60_000)

    it('records the range it ACTUALLY issued', async () => {
      await seedRegistrations(3, PASS_A)
      const j = await createJob(PASS_A, 'pa')
      await runToEnd(j.jobId)
      const after = await job.getIdentifierAssignmentJob(j.jobId)
      expect(after!.firstValue).toBe('5001')
      expect(after!.lastValue).toBe('5003')
    }, 60_000)

    it('THE RULE · a participant on another pass is never given this pool\'s numbers', async () => {
      await seedRegistrations(3, PASS_A, 'confirmed', 1)
      await seedRegistrations(3, PASS_B, 'confirmed', 100)

      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      await runToEnd((await createJob(PASS_B, 'pb')).jobId)

      for (let i = 1; i <= 3; i++) {
        expect(Number(await heldBy(i))).toBeGreaterThanOrEqual(5001)
        expect(Number(await heldBy(i))).toBeLessThan(6000)
      }
      for (let i = 100; i <= 102; i++) {
        expect(Number(await heldBy(i))).toBeGreaterThanOrEqual(7000)
      }
    }, 60_000)

    it('a pass-scoped job does not touch another pass\'s participants', async () => {
      await seedRegistrations(2, PASS_A, 'confirmed', 1)
      await seedRegistrations(2, PASS_B, 'confirmed', 100)
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      expect(await heldBy(100)).toBeUndefined()
      expect(await heldBy(101)).toBeUndefined()
    }, 60_000)

    it('only CONFIRMED registrations are selected — the shipped roster rule', async () => {
      await seedRegistrations(2, PASS_A, 'confirmed', 1)
      await seedRegistrations(1, PASS_A, 'pending', 50)
      await seedRegistrations(1, PASS_A, 'cancelled', 60)
      await seedRegistrations(1, PASS_A, 'waitlisted', 70)

      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      expect(await heldBy(1)).toBeTruthy()
      expect(await heldBy(50)).toBeUndefined()   // pending — the known divergence
      expect(await heldBy(60)).toBeUndefined()
      expect(await heldBy(70)).toBeUndefined()
    }, 60_000)
  })

  // ══ 2. IDEMPOTENCY ══════════════════════════════════════════════════════

  describe('2 — running it again changes nothing', () => {
    beforeEach(async () => {
      await seedEvent()
      await seedConfig({
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A], ranges: [{ start: 5001, end: 5999 }] }],
        defaultPoolId: 'pa',
      })
      await seedRegistrations(4, PASS_A)
    }, 60_000)

    it('a SECOND job over the same people assigns nobody a second number', async () => {
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      const first = await assignedValues()

      const second = await createJob(PASS_A, 'pa')
      await runToEnd(second.jobId)

      expect(await assignedValues()).toEqual(first)
      const after = await job.getIdentifierAssignmentJob(second.jobId)
      expect(after!.counts.succeeded).toBe(0)
      expect(after!.counts.skipped).toBe(4)
      expect(after!.reasons.ALREADY_ASSIGNED).toBe(4)
    }, 60_000)

    it('the counter is NOT advanced by a repeat run', async () => {
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      const before = (await adminDb.collection('identifierCounters').doc(`${SLUG}__pa`).get()).get('nextNumber')
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      const after = (await adminDb.collection('identifierCounters').doc(`${SLUG}__pa`).get()).get('nextNumber')
      expect(after).toBe(before)
    }, 60_000)

    it('no second history entry is written for a repeat', async () => {
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      const before = (await adminDb.collection('identifierHistory').where('eventSlug', '==', SLUG).get()).size
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      const after = (await adminDb.collection('identifierHistory').where('eventSlug', '==', SLUG).get()).size
      expect(after).toBe(before)
    }, 60_000)

    it('DIRECT engine call · skipIfAssigned makes a double click a no-op', async () => {
      const a = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual',
        poolId: 'pa', passId: PASS_A, skipIfAssigned: true,
      })
      const b = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual',
        poolId: 'pa', passId: PASS_A, skipIfAssigned: true,
      })
      expect(b.value).toBe(a.value)
      expect(b.alreadyAssigned).toBe(true)
      expect(await heldBy(1)).toBe(a.value)
    }, 60_000)

    it('WITHOUT the flag the engine still swaps — the old behaviour is untouched', async () => {
      const a = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', poolId: 'pa', passId: PASS_A,
      })
      const b = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', poolId: 'pa', passId: PASS_A,
      })
      expect(b.value).not.toBe(a.value)
      expect(b.alreadyAssigned).toBeFalsy()
    }, 60_000)
  })

  // ══ 3. Resume, partial failure, cancellation ═════════════════════════════

  describe('3 — a run that stops keeps what it committed', () => {
    beforeEach(async () => {
      await seedEvent()
      await seedConfig({
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A], ranges: [{ start: 5001, end: 5999 }] }],
        defaultPoolId: 'pa',
      })
    }, 60_000)

    it('a multi-page run processes every participant exactly once', async () => {
      // A chunk loops PAGES until its time budget, so one call may well finish the
      // whole run — the invariant is that nobody is processed twice, not how many
      // calls it took.
      await seedRegistrations(250, PASS_A)          // > two 100-row pages
      const j = await createJob(PASS_A, 'pa')
      await runToEnd(j.jobId)

      const end = await job.getIdentifierAssignmentJob(j.jobId)
      expect(end!.counts.processed).toBe(250)
      expect(end!.counts.succeeded).toBe(250)
      expect(end!.cursor).toBeTruthy()
      // 250 distinct values — no page was replayed.
      expect(new Set(await assignedValues()).size).toBe(250)
    }, 240_000)

    it('RESUME · a run continues from its cursor and does not revisit earlier pages', async () => {
      await seedRegistrations(20, PASS_A, 'confirmed', 1)     // reg 0001…0020
      const j = await createJob(PASS_A, 'pa')

      // Pretend a previous chunk stopped after registration 0010, exactly as the
      // kernel would have persisted it.
      await adminDb.collection(job.IDENTIFIER_ASSIGNMENT_JOBS).doc(j.jobId)
        .update({ cursor: regId(10), status: 'processing' })

      await runToEnd(j.jobId)

      // 1–10 were behind the cursor and must NOT have been touched…
      for (let i = 1; i <= 10; i++) expect(await heldBy(i)).toBeUndefined()
      // …and 11–20 were assigned.
      for (let i = 11; i <= 20; i++) expect(await heldBy(i)).toBeTruthy()
      expect((await assignedValues()).length).toBe(10)
    }, 120_000)

    it('EXHAUSTION · what was committed stays, and the rest is reported', async () => {
      await seedConfig({
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A], ranges: [{ start: 1, end: 3 }] }],
        defaultPoolId: 'pa',
      })
      await seedRegistrations(6, PASS_A)
      const j = await createJob(PASS_A, 'pa')
      await runToEnd(j.jobId)

      const after = await job.getIdentifierAssignmentJob(j.jobId)
      expect(after!.counts.succeeded).toBe(3)
      expect(after!.counts.failed).toBe(3)
      expect(after!.reasons.POOL_EXHAUSTED).toBe(3)
      // The three that DID get one keep it — no rollback.
      expect((await assignedValues()).length).toBe(3)
      expect(after!.status).toBe('completed')
    }, 60_000)

    it('a cancelled run does no further work, and keeps what it committed', async () => {
      await seedRegistrations(20, PASS_A, 'confirmed', 1)
      const first = await createJob(PASS_A, 'pa')
      // Commit some real work through a run that completes normally…
      await runToEnd(first.jobId)
      const committed = (await assignedValues()).length
      expect(committed).toBe(20)

      // …then a SECOND run is cancelled before it is ever driven.
      await seedRegistrations(5, PASS_A, 'confirmed', 500)
      const second = await createJob(PASS_A, 'pa')
      const { cancelJob } = await import('@/lib/jobs/kernel')
      await cancelJob(job.IDENTIFIER_ASSIGNMENT_JOBS, second.jobId)

      const r = await job.processIdentifierAssignmentChunk(second.jobId)
      expect(r.status).toBe('cancelled')
      expect(await heldBy(500)).toBeUndefined()          // it never ran
      expect((await assignedValues()).length).toBe(committed)   // …and undid nothing
    }, 180_000)

    it('a run on an event that becomes read-only mid-flight fails systemically', async () => {
      await seedRegistrations(3, PASS_A)
      const j = await createJob(PASS_A, 'pa')
      await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).update({ lifecycleStatus: 'archived' })

      const r = await job.processIdentifierAssignmentChunk(j.jobId)
      expect(r.status).toBe('failed')
      expect((await assignedValues()).length).toBe(0)
    }, 60_000)
  })

  // ══ 4. Ranges ═══════════════════════════════════════════════════════════

  describe('4 — the gap is jumped, never filled', () => {
    it('walks 5001–5002 then 7000–7001', async () => {
      await seedEvent()
      await seedConfig({
        pools: [{
          poolId: 'pa', label: 'A', passIds: [PASS_A],
          ranges: [{ start: 5001, end: 5002 }, { start: 7000, end: 7001 }],
        }],
        defaultPoolId: 'pa',
      })
      await seedRegistrations(4, PASS_A)
      const j = await createJob(PASS_A, 'pa')
      await runToEnd(j.jobId)

      expect(await assignedValues()).toEqual(['5001', '5002', '7000', '7001'])
      const after = await job.getIdentifierAssignmentJob(j.jobId)
      expect(after!.firstValue).toBe('5001')
      expect(after!.lastValue).toBe('7001')
      // Nothing in the gap was ever minted.
      for (const v of ['5003', '6000', '6999']) {
        expect((await adminDb.collection('identifierLocks').doc(`${SLUG}__${v}`).get()).exists).toBe(false)
      }
    }, 60_000)

    it('an UNLIMITED pool keeps going past any range', async () => {
      await seedEvent()
      await seedConfig({
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A] }], defaultPoolId: 'pa',
      })
      await seedRegistrations(5, PASS_A)
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      expect((await assignedValues()).length).toBe(5)
    }, 60_000)

    it('a LEGACY scalar range still runs', async () => {
      await seedEvent()
      await seedConfig({
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A], rangeStart: 300, rangeEnd: 302 }],
        defaultPoolId: 'pa',
      })
      await seedRegistrations(3, PASS_A)
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      expect(await assignedValues()).toEqual(['300', '301', '302'])
    }, 60_000)

    it('a LEGACY matchRule pool still runs', async () => {
      await seedEvent()
      await seedConfig({
        pools: [{
          poolId: 'lg', label: 'Legacy', matchRule: { by: 'pass', values: [PASS_A] },
          ranges: [{ start: 600, end: 602 }],
        }],
        defaultPoolId: 'lg',
      })
      await seedRegistrations(3, PASS_A)
      await runToEnd((await createJob(PASS_A, 'lg')).jobId)
      expect(await assignedValues()).toEqual(['600', '601', '602'])
    }, 60_000)
  })

  // ══ 5. Concurrency ══════════════════════════════════════════════════════

  describe('5 — two drivers cannot do the same work twice', () => {
    beforeEach(async () => {
      await seedEvent()
      await seedConfig({
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A], ranges: [{ start: 5001, end: 5999 }] }],
        defaultPoolId: 'pa',
      })
      await seedRegistrations(120, PASS_A)
    }, 60_000)

    it('the client poller and the cron racing the SAME job produce no duplicates', async () => {
      const j = await createJob(PASS_A, 'pa')
      await Promise.all([
        job.processIdentifierAssignmentChunk(j.jobId),
        job.processIdentifierAssignmentChunk(j.jobId),
      ])
      await runToEnd(j.jobId)

      const values = await assignedValues()
      expect(new Set(values).size).toBe(values.length)   // every value unique
      const after = await job.getIdentifierAssignmentJob(j.jobId)
      expect(after!.counts.succeeded).toBe(120)
      expect(after!.counts.processed).toBe(120)
    }, 180_000)

    it('TWO jobs over the same pass never give one participant two numbers', async () => {
      const a = await createJob(PASS_A, 'pa')
      const b = await createJob(PASS_A, 'pa')
      await Promise.all([runToEnd(a.jobId), runToEnd(b.jobId)])

      const snap = await adminDb.collection('registrations').where('eventSlug', '==', SLUG).get()
      const values = snap.docs.map(d => d.get('identifier')?.value).filter(Boolean)
      expect(new Set(values).size).toBe(values.length)
      expect(values.length).toBe(120)

      // …and no participant ended up with a lock that is not theirs.
      const locks = await adminDb.collection('identifierLocks')
        .where('eventSlug', '==', SLUG).where('state', '==', 'assigned').get()
      expect(locks.size).toBe(120)
    }, 240_000)

    it('a MANUAL assignment during a run is not overwritten', async () => {
      // RD-BIB-01 · the fixture value was 'VIP-1'. This test is about IDEMPOTENCY —
      // a hand-picked number survives a run — and the value was only chosen to be
      // visibly distinct from the sequence. A manual value must now be inside the
      // pass's configured range (5001–5999), so it is a distinctive number in it.
      // A separate test below pins the refusal of one that is not.
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual',
        explicitValue: '5999', poolId: 'pa', passId: PASS_A,
      })
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      expect(await heldBy(1)).toBe('5999')
    }, 180_000)

    it('RD-BIB-01 · a manual value OUTSIDE the pass\'s range is refused outright', async () => {
      // The audit observed 99999 being accepted into a pool configured 5001–5999 and
      // recorded as that pool's member, which made its capacity figures describe
      // something untrue. Both shapes are refused: a number outside the block, and a
      // value with no number in it at all.
      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual',
        explicitValue: '99999', poolId: 'pa', passId: PASS_A,
      })).rejects.toMatchObject({ code: 'OUT_OF_RANGE' })

      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual',
        explicitValue: 'VIP-1', poolId: 'pa', passId: PASS_A,
      })).rejects.toMatchObject({ code: 'OUT_OF_RANGE' })

      // …and nothing was written by either refusal.
      const lock = await adminDb.doc(`identifierLocks/${SLUG}__99999`).get()
      expect(lock.exists).toBe(false)
    }, 180_000)
  })

  // ══ 6. Check-in compatibility ═══════════════════════════════════════════

  describe('6 — an identifier assigned by a run works at the gate', () => {
    it('is findable, consumable, and then never auto-reused', async () => {
      await seedEvent()
      await seedConfig({
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A], ranges: [{ start: 5001, end: 5999 }] }],
        defaultPoolId: 'pa', reusePolicy: 'after_cancel_before_checkin',
      })
      await seedRegistrations(1, PASS_A)
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)

      const value = (await heldBy(1))!
      expect(value).toBe('5001')

      // The scanner's lookup path.
      const found = await engine.lookupIdentifier(SLUG, value)
      expect(found.exists).toBe(true)
      expect(found.registrationId).toBe(regId(1))

      await engine.consumeIdentifier(regId(1), UID)
      const lock = (await adminDb.collection('identifierLocks').doc(`${SLUG}__${value}`).get()).data()!
      expect(lock.state).toBe('consumed')
      expect(lock.everCheckedIn).toBe(true)

      // Released after check-in, it must never be handed to anybody else.
      await engine.releaseIdentifier(regId(1), UID, 'cancelled after check-in')
      await seedRegistrations(1, PASS_A, 'confirmed', 900)
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      expect(await heldBy(900)).not.toBe(value)
    }, 60_000)

    it('the legacy mirrors are written by a run, so exports keep working', async () => {
      await seedEvent()
      await seedConfig({
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A], ranges: [{ start: 5001, end: 5999 }] }],
        defaultPoolId: 'pa',
      })
      await seedRegistrations(1, PASS_A)
      await runToEnd((await createJob(PASS_A, 'pa')).jobId)
      const doc = await adminDb.collection('registrations').doc(regId(1)).get()
      expect(doc.get('bibNumber')).toBe('5001')
      expect(doc.get('identifier').value).toBe('5001')
    }, 60_000)

    it('every assignment is in the immutable history', async () => {
      await seedEvent()
      await seedConfig({
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A], ranges: [{ start: 5001, end: 5999 }] }],
        defaultPoolId: 'pa',
      })
      await seedRegistrations(3, PASS_A)
      const j = await createJob(PASS_A, 'pa')
      await runToEnd(j.jobId)

      const hist = await adminDb.collection('identifierHistory').where('eventSlug', '==', SLUG).get()
      const assigned = hist.docs.filter(d => d.get('action') === 'assigned')
      expect(assigned.length).toBe(3)
      // The run is identifiable in the audit trail.
      expect(assigned.every(d => String(d.get('reason') ?? '').includes(j.jobId))).toBe(true)
      expect(assigned.every(d => !!d.get('actor'))).toBe(true)
    }, 60_000)
  })

  // ══ 7. Scope planning ═══════════════════════════════════════════════════

  describe('7 — ALL PASSES is one scope per pass, never one merged run', () => {
    it('plans a separate pool per pass', async () => {
      const cfg = {
        ...config.defaultIdentifierConfig(SLUG),
        pools: [
          { poolId: 'pa', label: 'A', passIds: [PASS_A] },
          { poolId: 'pb', label: 'B', passIds: [PASS_B] },
        ],
        defaultPoolId: 'pa',
      }
      const scopes = job.planScopes(cfg, [{ id: PASS_A, name: 'Alpha' }, { id: PASS_B, name: 'Beta' }], { kind: 'all_passes' })
      expect(scopes).toEqual([
        { passId: PASS_A, passName: 'Alpha', poolId: 'pa', blocked: null },
        { passId: PASS_B, passName: 'Beta',  poolId: 'pb', blocked: null },
      ])
    }, 60_000)

    it('a pass with NO pool is blocked, not folded into another pass\'s pool', async () => {
      const cfg = {
        ...config.defaultIdentifierConfig(SLUG),
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A] }],
        defaultPoolId: 'pa',
      }
      const scopes = job.planScopes(cfg, [{ id: PASS_A, name: 'Alpha' }, { id: PASS_B, name: 'Beta' }], { kind: 'all_passes' })
      expect(scopes[1]).toMatchObject({ passId: PASS_B, poolId: null, blocked: 'POOL_MISSING' })
      expect(scopes[1].poolId).not.toBe('pa')
    }, 60_000)

    it('an event with no passes still has one unrestricted scope', async () => {
      const cfg = {
        ...config.defaultIdentifierConfig(SLUG),
        pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def',
      }
      expect(job.planScopes(cfg, [], { kind: 'all_passes' }))
        .toEqual([{ passId: null, passName: null, poolId: 'def', blocked: null }])
    }, 60_000)

    it('running ALL PASSES keeps each pass in its own number space', async () => {
      await seedEvent()
      await seedConfig({
        pools: [
          { poolId: 'pa', label: 'A', passIds: [PASS_A], ranges: [{ start: 100, end: 199 }] },
          { poolId: 'pb', label: 'B', passIds: [PASS_B], ranges: [{ start: 200, end: 299 }] },
        ],
        defaultPoolId: 'pa',
      })
      await seedRegistrations(3, PASS_A, 'confirmed', 1)
      await seedRegistrations(3, PASS_B, 'confirmed', 100)

      const cfg = (await config.resolveIdentifierConfig(SLUG)).config
      const scopes = job.planScopes(cfg, [{ id: PASS_A, name: 'Alpha' }, { id: PASS_B, name: 'Beta' }], { kind: 'all_passes' })
      for (const s of scopes) await runToEnd((await createJob(s.passId, s.poolId!)).jobId)

      for (let i = 1; i <= 3; i++) expect(Number(await heldBy(i))).toBeLessThan(200)
      for (let i = 100; i <= 102; i++) expect(Number(await heldBy(i))).toBeGreaterThanOrEqual(200)
    }, 120_000)
  })
})
