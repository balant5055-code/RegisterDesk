// RD-EVENT-19A · Identifier core contracts against REAL Firestore (emulator).
//
// A mock cannot prove any of this. What is under test is exactly the behaviour
// that only a real transaction produces:
//   • two simultaneous allocations cannot both take 5001;
//   • a counter standing in a GAP between two configured ranges advances to the
//     next range rather than issuing a number nobody printed;
//   • a pass-scoped pool is chosen from the registration's own pass;
//   • an event configured before RD-EVENT-19A behaves exactly as it did.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

describeEmu('RD-EVENT-19A · identifier allocation', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let engine: typeof import('@/lib/identifiers/engine')
  let config: typeof import('@/lib/identifiers/config')

  const PID  = process.pid
  const SLUG = `id19a-${PID}`
  const UID  = `id19a-org-${PID}`

  const PASS_A = 'pass-alpha'
  const PASS_B = 'pass-beta'

  const regId = (n: number) => `${SLUG}-reg-${n}`

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    engine = await import('@/lib/identifiers/engine')
    config = await import('@/lib/identifiers/config')
  })

  // ── Fixtures ───────────────────────────────────────────────────────────────

  async function wipe() {
    const batch = adminDb.batch()
    for (const col of ['identifierLocks', 'identifierCounters', 'identifierHistory', 'bibLocks', 'bibCounters']) {
      const snap = await adminDb.collection(col).where('eventSlug', '==', SLUG).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    // History for config changes is written with eventSlug too, so the query above
    // catches it. Locks/counters use deterministic ids; delete by id as well.
    batch.delete(adminDb.collection('identifierConfigs').doc(SLUG))
    for (let n = 0; n < 12; n++) batch.delete(adminDb.collection('registrations').doc(regId(n)))
    await batch.commit()
    // bibCounters is keyed by slug, not by an eventSlug field.
    await adminDb.collection('bibCounters').doc(SLUG).delete()
  }

  async function seedRegistration(n: number, passId: string, status = 'confirmed') {
    await adminDb.collection('registrations').doc(regId(n)).set({
      eventSlug: SLUG, organizerUid: UID, passId, passName: passId,
      attendee: { name: `Person ${n}`, email: `p${n}@test.local` },
      status, paymentStatus: 'paid', amount: 0, ticketCode: `RD-${PID}-${n}`,
      createdAt: new Date(),
    })
  }

  /** Writes the config document directly — saveIdentifierConfig is tested separately. */
  async function seedConfig(patch: Record<string, unknown>) {
    await adminDb.collection('identifierConfigs').doc(SLUG).set({
      ...config.defaultIdentifierConfig(SLUG), ...patch, eventSlug: SLUG,
    })
  }

  const lockOf = async (value: string) =>
    (await adminDb.collection('identifierLocks').doc(`${SLUG}__${value}`).get()).data()

  const identifierOf = async (n: number) =>
    (await adminDb.collection('registrations').doc(regId(n)).get()).get('identifier') as
      { value?: string; poolId?: string } | null

  beforeEach(wipe)
  afterAll(wipe)

  // ══ 1. Pass-aware allocation ═════════════════════════════════════════════

  describe('1 — the pass decides the pool, and therefore the number', () => {
    beforeEach(async () => {
      await seedConfig({
        type: 'numeric',
        format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [
          { poolId: 'default', label: 'Default' },
          { poolId: 'p-a', label: 'Alpha', passIds: [PASS_A], ranges: [{ start: 5001, end: 6500 }] },
          { poolId: 'p-b', label: 'Beta',  passIds: [PASS_B], ranges: [{ start: 7000, end: 7499 }] },
        ],
        defaultPoolId: 'default',
      })
      await Promise.all([
        seedRegistration(1, PASS_A), seedRegistration(2, PASS_A), seedRegistration(3, PASS_B),
      ])
    })

    it('each pass draws from its own range', async () => {
      const a1 = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_A })
      const a2 = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual', passId: PASS_A })
      const b1 = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(3), actor: UID, source: 'manual', passId: PASS_B })

      expect(a1.value).toBe('5001')
      expect(a2.value).toBe('5002')
      expect(b1.value).toBe('7000')
      expect(a1.poolId).toBe('p-a')
      expect(b1.poolId).toBe('p-b')
    })

    it('a pass B participant NEVER receives a pass A number', async () => {
      const b = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(3), actor: UID, source: 'manual', passId: PASS_B })
      expect(Number(b.value)).toBeGreaterThanOrEqual(7000)
      expect(Number(b.value)).toBeLessThanOrEqual(7499)
    })

    it('the counters are per pool, so one pass cannot advance another', async () => {
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_A })
      const a = await adminDb.collection('identifierCounters').doc(`${SLUG}__p-a`).get()
      const b = await adminDb.collection('identifierCounters').doc(`${SLUG}__p-b`).get()
      expect(a.get('nextNumber')).toBe(5002)
      expect(b.exists).toBe(false)
    })

    // RD-BIB-01 · these two are INVERTED, against the live engine, and the inversion
    // is the fix. Both used to assert the default-pool fallback, and the audit watched
    // what that meant: a participant whose pass has no configured range — or no pass
    // at all — was quietly issued a number out of the default pool's block, which on a
    // freshly-defaulted config is unbounded and starts at 1.
    //
    // On an event that maps numbers to passes this is now refused, and nothing is
    // written. The permissive answer survives unchanged for events that never opted
    // into pass scoping — pinned immediately below, against the same engine.
    it('an UNKNOWN pass is REFUSED, and never lands in another pass\'s pool', async () => {
      await seedRegistration(4, 'pass-unheard-of')
      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(4), actor: UID, source: 'manual', passId: 'pass-unheard-of',
      })).rejects.toMatchObject({ code: 'POOL_NOT_FOUND' })

      const after = await adminDb.collection('registrations').doc(regId(4)).get()
      expect(after.get('identifier') ?? null).toBeNull()
    })

    it('NO passId on a pass-scoped event is refused too', async () => {
      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual',
      })).rejects.toMatchObject({ code: 'POOL_NOT_FOUND' })
    })

    it('a LEGACY event with no pass scoping still uses its default pool', async () => {
      const legacySlug = `${SLUG}-legacy`
      await adminDb.doc(`users/${UID}/eventDrafts/${legacySlug}`).set({
        status: 'published', lifecycleStatus: 'published',
        eventDetails: { info: { name: 'legacy' }, seo: { urlSlug: legacySlug } },
        pricing: { eventType: 'free', passes: [] },
      })
      await adminDb.doc(`identifierConfigs/${legacySlug}`).set({
        eventSlug: legacySlug, enabled: true, label: 'Identifier', preset: 'custom', type: 'numeric',
        format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        reusePolicy: 'never', assignmentStrategy: 'manual',
        allowManualOverride: true, allowDuplicate: false,
        pools: [{ poolId: 'default', label: 'General' }],
        templates: [], defaultPoolId: 'default',
        visibility: { attendee: true, ticket: true, certificate: true, badge: false, checkin: true },
        version: 1,
      })
      const rid = `${legacySlug}-r1`
      await adminDb.collection('registrations').doc(rid).set({
        id: rid, eventSlug: legacySlug, organizerUid: UID, passId: 'whatever', passName: 'Whatever',
        attendee: { name: 'Legacy person', email: 'legacy@a.local' },
        status: 'confirmed', paymentStatus: 'paid', amount: 0, ticketCode: 'RD-LEG-1',
        checkedIn: false, registeredAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      })
      const r = await engine.allocateIdentifier({
        eventSlug: legacySlug, registrationId: rid, actor: UID, source: 'manual', passId: 'whatever',
      })
      expect(r.poolId).toBe('default')
    })

    it('the lock records the pool it came from', async () => {
      const r = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_A })
      expect((await lockOf(r.value))?.poolId).toBe('p-a')
      expect((await identifierOf(1))?.poolId).toBe('p-a')
    })
  })

  // ══ 2. Multiple ranges ═══════════════════════════════════════════════════

  describe('2 — a gap between ranges is never issued', () => {
    beforeEach(async () => {
      await seedConfig({
        type: 'numeric',
        format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [{
          poolId: 'default', label: 'Default',
          ranges: [{ start: 100, end: 102 }, { start: 200, end: 201 }],
        }],
        defaultPoolId: 'default',
      })
      for (let n = 1; n <= 6; n++) await seedRegistration(n, PASS_A)
    })

    it('walks 100,101,102 then JUMPS to 200,201', async () => {
      const issued: string[] = []
      for (let n = 1; n <= 5; n++) {
        issued.push((await engine.allocateIdentifier({
          eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual',
        })).value)
      }
      expect(issued).toEqual(['100', '101', '102', '200', '201'])
      // 103–199 were never formatted, so no lock for them can exist.
      expect(await lockOf('103')).toBeUndefined()
      expect(await lockOf('150')).toBeUndefined()
    })

    it('POOL_EXHAUSTED only after the LAST range is spent', async () => {
      for (let n = 1; n <= 5; n++) {
        await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual' })
      }
      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(6), actor: UID, source: 'manual',
      })).rejects.toMatchObject({ code: 'POOL_EXHAUSTED' })
    })

    it('a counter parked in the gap resumes at the next range', async () => {
      await adminDb.collection('identifierCounters').doc(`${SLUG}__default`).set({
        eventSlug: SLUG, poolId: 'default', nextNumber: 150, updatedAt: new Date(),
      })
      const r = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      expect(r.value).toBe('200')
    })
  })

  // ══ 3. Concurrency ═══════════════════════════════════════════════════════

  describe('3 — two people cannot hold the same identifier', () => {
    beforeEach(async () => {
      await seedConfig({
        type: 'numeric',
        format: { prefix: '', suffix: '', padding: 0, startNumber: 5001 },
        pools: [{ poolId: 'default', label: 'Default' }],
        defaultPoolId: 'default',
      })
      for (let n = 1; n <= 8; n++) await seedRegistration(n, PASS_A)
    })

    it('the SAME explicit value: exactly one wins, the other is refused', async () => {
      const results = await Promise.allSettled([
        engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: '5001' }),
        engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual', explicitValue: '5001' }),
      ])
      const ok = results.filter(r => r.status === 'fulfilled')
      expect(ok).toHaveLength(1)

      const lock = await lockOf('5001')
      expect(lock?.state).toBe('assigned')
      // Exactly one registration mirrors it.
      const holders = (await Promise.all([1, 2].map(identifierOf))).filter(i => i?.value === '5001')
      expect(holders).toHaveLength(1)
    })

    it('simultaneous AUTOMATIC allocation issues eight distinct values', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4, 5, 6, 7, 8].map(n =>
          engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual' })),
      )
      const values = results.map(r => r.value)
      expect(new Set(values).size).toBe(8)
      for (const v of values) expect(Number(v)).toBeGreaterThanOrEqual(5001)
    }, 60_000)

    it('the counter ends up past every value it issued', async () => {
      await Promise.all([1, 2, 3, 4].map(n =>
        engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual' })))
      const next = (await adminDb.collection('identifierCounters').doc(`${SLUG}__default`).get()).get('nextNumber')
      expect(next).toBeGreaterThanOrEqual(5005)
    }, 60_000)
  })

  // ══ 4. Normalization + length ════════════════════════════════════════════

  describe('4 — the normalized value is the lock identity', () => {
    beforeEach(async () => {
      await seedConfig({ pools: [{ poolId: 'default', label: 'Default' }], defaultPoolId: 'default' })
      await seedRegistration(1, PASS_A)
      await seedRegistration(2, PASS_A)
    })

    it('a padded value locks the trimmed one', async () => {
      const r = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: '  A-77  ',
      })
      expect(r.value).toBe('A-77')
      expect(await lockOf('A-77')).toBeTruthy()
      expect(await lockOf('  A-77  ')).toBeUndefined()
    })

    it('" 5001" and "5001" are ONE identifier, so the second request conflicts', async () => {
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: '5001' })
      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual', explicitValue: ' 5001 ',
      })).rejects.toMatchObject({ code: 'VALUE_CONFLICT' })
    })

    it('an over-length value is refused BEFORE a lock is created', async () => {
      const huge = 'A'.repeat(200)
      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: huge,
      })).rejects.toMatchObject({ code: 'INVALID_VALUE' })
      expect(await lockOf(huge)).toBeUndefined()
    })

    it('a BLOCKED value is found by the allocator — the whole point of normalizing here', async () => {
      // Before RD-EVENT-19A, blocking "  B-9  " wrote a lock at the document id
      // `slug__  B-9  `, which the allocator could never see: it would go on to
      // hand B-9 to somebody. Now both sides resolve the same value.
      await engine.blockIdentifier({ eventSlug: SLUG, value: '  B-9  ', actor: UID, reason: 'damaged' })
      expect(await lockOf('B-9')).toMatchObject({ state: 'blocked' })
      expect(await lockOf('  B-9  ')).toBeUndefined()

      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: 'B-9',
      })).rejects.toMatchObject({ code: 'VALUE_CONFLICT' })
    })

    it('a reserved value is skipped by AUTOMATIC allocation', async () => {
      // Reserving holds a value aside from the counter. An operator typing it
      // explicitly still claims it — `reserved → assigned` is a documented
      // transition and is unchanged by this phase.
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [{ poolId: 'default', label: 'Default' }], defaultPoolId: 'default',
      })
      await engine.reserveIdentifier({ eventSlug: SLUG, value: '  1  ', actor: UID })
      expect(await lockOf('1')).toMatchObject({ state: 'reserved' })

      const r = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual',
      })
      expect(r.value).toBe('2')
    })

    it('a prefixed value stores its real numeric component', async () => {
      await seedConfig({
        type: 'alphanumeric',
        format: { prefix: 'DEL-', suffix: '', padding: 4, startNumber: 1 },
        pools: [{ poolId: 'default', label: 'Default' }], defaultPoolId: 'default',
      })
      const r = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      expect(r.value).toBe('DEL-0001')
      expect((await lockOf('DEL-0001'))?.numeric).toBe(1)
    })
  })

  // ══ 5. Eligibility ═══════════════════════════════════════════════════════

  describe('5 — who may hold one', () => {
    beforeEach(async () => {
      await seedConfig({ pools: [{ poolId: 'default', label: 'Default' }], defaultPoolId: 'default' })
    })

    for (const [status, allowed] of [
      ['confirmed', true], ['pending', true], ['waitlisted', true],
      ['cancelled', false], ['rejected', false],
    ] as const) {
      it(`${status} → ${allowed ? 'allocatable' : 'refused'} (behaviour PRESERVED, not re-decided)`, async () => {
        await seedRegistration(1, PASS_A, status)
        const call = engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
        if (allowed) await expect(call).resolves.toBeTruthy()
        else await expect(call).rejects.toMatchObject({ code: 'REGISTRATION_TERMINAL' })
      })
    }

    it('a missing registration is refused', async () => {
      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: `${SLUG}-nope`, actor: UID, source: 'manual',
      })).rejects.toMatchObject({ code: 'REGISTRATION_NOT_FOUND' })
    })
  })

  // ══ 6. Check-in contracts ════════════════════════════════════════════════

  describe('6 — check-in still works exactly as before', () => {
    beforeEach(async () => {
      await seedConfig({
        pools: [{ poolId: 'default', label: 'Default' }], defaultPoolId: 'default',
        assignmentStrategy: 'auto', reusePolicy: 'after_cancel_before_checkin',
      })
      await seedRegistration(1, PASS_A)
    })

    it('autoAssignIfEnabled allocates and honours the pass', async () => {
      await seedConfig({
        pools: [
          { poolId: 'default', label: 'Default' },
          { poolId: 'p-a', label: 'Alpha', passIds: [PASS_A], ranges: [{ start: 900, end: 950 }] },
        ],
        defaultPoolId: 'default', assignmentStrategy: 'auto',
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
      })
      const r = await engine.autoAssignIfEnabled({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'walkin', passId: PASS_A,
      })
      expect(r?.value).toBe('900')
      expect(r?.poolId).toBe('p-a')
    })

    it('autoAssignIfEnabled is a NO-OP when the event never opted in', async () => {
      await adminDb.collection('identifierConfigs').doc(SLUG).delete()
      const r = await engine.autoAssignIfEnabled({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'walkin', passId: PASS_A,
      })
      expect(r).toBeNull()
    })

    it('consume latches everCheckedIn and is idempotent', async () => {
      const a = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      await engine.consumeIdentifier(regId(1), UID)
      await engine.consumeIdentifier(regId(1), UID)
      const lock = await lockOf(a.value)
      expect(lock?.state).toBe('consumed')
      expect(lock?.everCheckedIn).toBe(true)
    })

    it('a consumed identifier is NEVER auto-reused, whatever the policy says', async () => {
      const a = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      await engine.consumeIdentifier(regId(1), UID)
      await engine.releaseIdentifier(regId(1), UID, 'cancelled after check-in')

      await seedRegistration(2, PASS_A)
      const b = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual' })
      expect(b.value).not.toBe(a.value)
      expect((await lockOf(a.value))?.everCheckedIn).toBe(true)
    })

    it('release clears both the generic and the legacy mirrors', async () => {
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      await engine.releaseIdentifier(regId(1), UID, 'cancelled')
      const doc = await adminDb.collection('registrations').doc(regId(1)).get()
      expect(doc.get('identifier')).toBeNull()
      expect(doc.get('bibNumber')).toBeNull()
      expect(doc.get('bibCategory')).toBeNull()
    })
  })

  // ══ 7. Legacy compatibility ══════════════════════════════════════════════

  describe('7 — an event configured before RD-EVENT-19A is unchanged', () => {
    it('a legacy rangeStart/rangeEnd pool still allocates and still exhausts', async () => {
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [{ poolId: 'default', label: 'Default', rangeStart: 300, rangeEnd: 301 }],
        defaultPoolId: 'default',
      })
      for (let n = 1; n <= 3; n++) await seedRegistration(n, PASS_A)

      expect((await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })).value).toBe('300')
      expect((await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual' })).value).toBe('301')
      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(3), actor: UID, source: 'manual',
      })).rejects.toMatchObject({ code: 'POOL_EXHAUSTED' })
    })

    it('an event with NO stored config still allocates through the default', async () => {
      await seedRegistration(1, PASS_A)
      const r = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      expect(r.value).toBe('0001')          // numeric, padding 4 — the legacy default
      expect(r.poolId).toBe('default')
    })

    it('the legacy bibCounters seed is still honoured for continuity', async () => {
      await adminDb.collection('bibCounters').doc(SLUG).set({ nextBib: 4242 })
      await seedRegistration(1, PASS_A)
      const r = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      expect(r.value).toBe('4242')
    })

    it('the legacy seed does NOT drag a range-configured pool out of its ranges', async () => {
      await adminDb.collection('bibCounters').doc(SLUG).set({ nextBib: 4242 })
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [{ poolId: 'default', label: 'Default', ranges: [{ start: 100, end: 102 }] }],
        defaultPoolId: 'default',
      })
      await seedRegistration(1, PASS_A)
      const r = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      // 4242 is outside the configured block; the block is what was printed.
      expect(r.value).toBe('100')
    })

    it('a value held only in the legacy bibLocks is still refused', async () => {
      await adminDb.collection('bibLocks').doc(`${SLUG}__777`).set({
        eventSlug: SLUG, registrationId: 'someone-else',
      })
      await seedRegistration(1, PASS_A)
      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: '777',
      })).rejects.toMatchObject({ code: 'VALUE_CONFLICT' })
    })

    it('the legacy registration mirrors are still written', async () => {
      await seedRegistration(1, PASS_A)
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', category: 'Open',
      })
      const doc = await adminDb.collection('registrations').doc(regId(1)).get()
      expect(doc.get('bibNumber')).toBe('0001')
      expect(doc.get('bibCategory')).toBe('Open')
    })

    it('a legacy matchRule.by = "pass" config still routes on the pass', async () => {
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [
          { poolId: 'default', label: 'Default' },
          { poolId: 'legacy', label: 'Legacy', matchRule: { by: 'pass', values: [PASS_B] }, rangeStart: 600, rangeEnd: 699 },
        ],
        defaultPoolId: 'default',
      })
      await seedRegistration(1, PASS_B)
      const r = await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_B })
      expect(r.poolId).toBe('legacy')
      expect(r.value).toBe('600')
    })
  })

  // ══ 8. Configuration validation (the write gate) ═════════════════════════

  describe('8 — an unallocatable configuration cannot be persisted', () => {
    const save = (pools: unknown) =>
      config.saveIdentifierConfig(SLUG, { pools: pools as never, defaultPoolId: 'default' }, UID)

    it('accepts pass-scoped, non-overlapping, multi-range pools', async () => {
      await expect(save([
        { poolId: 'default', label: 'Default' },
        { poolId: 'a', label: 'A', passIds: [PASS_A], ranges: [{ start: 5001, end: 5999 }, { start: 7000, end: 7500 }] },
        { poolId: 'b', label: 'B', passIds: [PASS_B], ranges: [{ start: 8000, end: 8799 }] },
      ])).resolves.toBeTruthy()
    })

    it('accepts ADJACENT ranges across pools', async () => {
      await expect(save([
        { poolId: 'default', label: 'Default' },
        { poolId: 'a', label: 'A', ranges: [{ start: 5001, end: 5999 }] },
        { poolId: 'b', label: 'B', ranges: [{ start: 6000, end: 6999 }] },
      ])).resolves.toBeTruthy()
    })

    it('refuses OVERLAPPING ranges across pools', async () => {
      await expect(save([
        { poolId: 'default', label: 'Default' },
        { poolId: 'a', label: 'A', ranges: [{ start: 5001, end: 6500 }] },
        { poolId: 'b', label: 'B', ranges: [{ start: 6000, end: 7000 }] },
      ])).rejects.toThrow(/overlap/i)
    })

    it('refuses a legacy pool overlapping a multi-range pool', async () => {
      await expect(save([
        { poolId: 'default', label: 'Default' },
        { poolId: 'a', label: 'A', ranges: [{ start: 100, end: 200 }] },
        { poolId: 'b', label: 'B', rangeStart: 150, rangeEnd: 300 },
      ])).rejects.toThrow(/overlap/i)
    })

    it('refuses two pools claiming the same pass', async () => {
      await expect(save([
        { poolId: 'default', label: 'Default' },
        { poolId: 'a', label: 'A', passIds: [PASS_A] },
        { poolId: 'b', label: 'B', passIds: [PASS_A] },
      ])).rejects.toThrow(/same pass/i)
    })

    it('refuses an EMPTY passIds rather than storing something that reads as "all"', async () => {
      await expect(save([
        { poolId: 'default', label: 'Default' },
        { poolId: 'a', label: 'A', passIds: [] },
      ])).rejects.toThrow(/empty list/i)
    })

    it('refuses an invalid range', async () => {
      await expect(save([
        { poolId: 'default', label: 'Default', ranges: [{ start: 500, end: 100 }] },
      ])).rejects.toThrow(/starts after it ends/i)
    })

    it('a rejected save leaves the stored config untouched', async () => {
      await save([{ poolId: 'default', label: 'Default', ranges: [{ start: 1, end: 9 }] }])
      const before = (await adminDb.collection('identifierConfigs').doc(SLUG).get()).get('pools')
      await expect(save([
        { poolId: 'default', label: 'Default', ranges: [{ start: 1, end: 9 }] },
        { poolId: 'x', label: 'X', ranges: [{ start: 5, end: 20 }] },
      ])).rejects.toThrow()
      const after = (await adminDb.collection('identifierConfigs').doc(SLUG).get()).get('pools')
      expect(after).toEqual(before)
    })
  })

  // ══ 9. Statistics honesty ════════════════════════════════════════════════

  describe('9 — a multi-range pool reports its real capacity', () => {
    it('capacity is the SUM of the configured ranges, not a null "unbounded"', async () => {
      await seedConfig({
        pools: [{
          poolId: 'default', label: 'Default',
          ranges: [{ start: 1, end: 100 }, { start: 200, end: 249 }],
        }],
        defaultPoolId: 'default',
      })
      const stats = await config.getPoolStatistics(SLUG)
      const p = stats.pools.find(x => x.poolId === 'default')!
      expect(p.capacity).toBe(150)
      expect(p.ranges).toHaveLength(2)
    })

    it('an unbounded pool still reports capacity as unknown, never as 0', async () => {
      await seedConfig({ pools: [{ poolId: 'default', label: 'Default' }], defaultPoolId: 'default' })
      const stats = await config.getPoolStatistics(SLUG)
      expect(stats.pools[0].capacity).toBeNull()
      expect(stats.pools[0].available).toBeNull()
    })

    it('a pass-scoped pool reports which passes it serves', async () => {
      await seedConfig({
        pools: [
          { poolId: 'default', label: 'Default' },
          { poolId: 'a', label: 'A', passIds: [PASS_A] },
        ],
        defaultPoolId: 'default',
      })
      const stats = await config.getPoolStatistics(SLUG)
      expect(stats.pools.find(p => p.poolId === 'a')!.passIds).toEqual([PASS_A])
      expect(stats.pools.find(p => p.poolId === 'default')!.passIds).toBeNull()
    })
  })
})
