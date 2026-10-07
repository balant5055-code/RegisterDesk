// RD-EVENT-19B · identifier statistics against REAL Firestore (emulator).
//
// A mock cannot prove any of this. What is under test is behaviour only a real
// Firestore produces:
//   • a count() aggregate returns the same number the old full scan did — while
//     transferring no documents;
//   • the equality-only conjunctions (eventSlug + poolId + state) actually run;
//   • a legacy event, an unlimited pool and a config-less event all survive;
//   • the response the organizer receives carries no attendee PII.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

describeEmu('RD-EVENT-19B · identifier statistics', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let config: typeof import('@/lib/identifiers/config')
  let engine: typeof import('@/lib/identifiers/engine')

  const PID  = process.pid
  const SLUG = `id19b-${PID}`
  const UID  = `id19b-org-${PID}`
  const PASS_A = 'pass-alpha'
  const PASS_B = 'pass-beta'

  const regId = (n: number) => `${SLUG}-reg-${n}`
  const CTX_NONE = { passes: [] as Array<{ id: string; name: string }>, passesKnown: false }
  const ctxWith = (passes: Array<{ id: string; name: string }>) => ({ passes, passesKnown: true })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    config = await import('@/lib/identifiers/config')
    engine = await import('@/lib/identifiers/engine')
  })

  async function wipe() {
    for (const col of ['identifierLocks', 'identifierCounters', 'identifierHistory', 'bibLocks']) {
      const snap = await adminDb.collection(col).where('eventSlug', '==', SLUG).get()
      const batch = adminDb.batch()
      snap.docs.forEach(d => batch.delete(d.ref))
      await batch.commit()
    }
    const regs = await adminDb.collection('registrations').where('eventSlug', '==', SLUG).get()
    const b2 = adminDb.batch()
    regs.docs.forEach(d => b2.delete(d.ref))
    b2.delete(adminDb.collection('identifierConfigs').doc(SLUG))
    await b2.commit()
  }

  async function seedConfig(patch: Record<string, unknown>) {
    await adminDb.collection('identifierConfigs').doc(SLUG).set({
      ...config.defaultIdentifierConfig(SLUG), ...patch, eventSlug: SLUG,
    })
  }

  async function seedRegistration(n: number, passId: string, status = 'confirmed') {
    await adminDb.collection('registrations').doc(regId(n)).set({
      eventSlug: SLUG, organizerUid: UID, passId, passName: passId,
      attendee: { name: `Person ${n}`, email: `p${n}@test.local`, phone: '9999999999' },
      status, paymentStatus: 'paid', amount: 0, ticketCode: `RD-${PID}-${n}`, createdAt: new Date(),
    })
  }

  /** Writes a lock directly, so a state can be set up without driving the engine. */
  async function seedLock(value: string, poolId: string, state: string, everCheckedIn = false) {
    await adminDb.collection('identifierLocks').doc(`${SLUG}__${value}`).set({
      eventSlug: SLUG, value, numeric: Number(value) || null, poolId, templateId: null,
      state, registrationId: null, everCheckedIn, reason: null,
      assignedAt: null, releasedAt: null, createdAt: new Date(), updatedAt: new Date(),
    })
  }

  beforeEach(wipe)
  afterAll(wipe)

  // ══ 1. Aggregates agree with the truth ═══════════════════════════════════

  describe('1 — the aggregates count what is actually there', () => {
    beforeEach(async () => {
      await seedConfig({
        pools: [
          { poolId: 'a', label: 'A', passIds: [PASS_A], ranges: [{ start: 1, end: 100 }] },
          { poolId: 'b', label: 'B', passIds: [PASS_B], ranges: [{ start: 200, end: 299 }] },
        ],
        defaultPoolId: 'a',
      })
      await Promise.all([
        seedLock('1', 'a', 'assigned'), seedLock('2', 'a', 'assigned'), seedLock('3', 'a', 'consumed', true),
        seedLock('4', 'a', 'reserved'), seedLock('5', 'a', 'blocked'),  seedLock('6', 'a', 'retired'),
        seedLock('7', 'a', 'released'), seedLock('8', 'a', 'released', true),
        seedLock('200', 'b', 'assigned'),
      ])
    })

    it('per pool, per state, exactly', async () => {
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      const a = model.pools.find(p => p.poolId === 'a')!
      expect(a).toMatchObject({
        assigned: 2, consumed: 1, reserved: 1, blocked: 1, retired: 1, released: 2,
      })
      expect(a.occupied).toBe(6)              // released is NOT occupied
      expect(a.capacity).toBe(100)
      expect(a.available).toBe(94)
      expect(a.utilization).toBeCloseTo(0.06)
      expect(a.state).toBe('available')
    })

    it('a second pool is counted independently', async () => {
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      const b = model.pools.find(p => p.poolId === 'b')!
      expect(b.assigned).toBe(1)
      expect(b.consumed).toBe(0)
      expect(b.available).toBe(99)
    })

    it('reusable counts released-and-never-checked-in only', async () => {
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.summary.reusable).toBe(1)   // '7' yes, '8' checked in
    })

    it('the event summary sums the pools', async () => {
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.summary.configuredCapacity).toBe(200)
      expect(model.summary.assigned).toBe(3)
      expect(model.summary.occupied).toBe(7)
      expect(model.summary.available).toBe(193)
    })

    it('an empty event reports a real ZERO, not unknown', async () => {
      await wipe()
      await seedConfig({ pools: [{ poolId: 'a', label: 'A', ranges: [{ start: 1, end: 10 }] }], defaultPoolId: 'a' })
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].assigned).toBe(0)
      expect(model.pools[0].assigned).not.toBeNull()
      expect(model.pools[0].state).toBe('empty')
      expect(model.pools[0].available).toBe(10)
    })

    it('the legacy statistics shape is built from the SAME numbers', async () => {
      const { model, legacy } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(legacy.totals.assigned).toBe(model.summary.assigned)
      expect(legacy.pools.map(p => p.poolId)).toEqual(model.pools.map(p => p.poolId))
      expect(legacy.pools[0].available).toBe(model.pools[0].available)
    })
  })

  // ══ 2. Agreement with the engine ═════════════════════════════════════════

  describe('2 — the aggregate agrees with what the engine actually allocated', () => {
    it('counts every identifier the engine issued, per pool', async () => {
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [
          { poolId: 'def', label: 'Default' },
          { poolId: 'a', label: 'A', passIds: [PASS_A], ranges: [{ start: 5001, end: 5999 }] },
        ],
        defaultPoolId: 'def',
      })
      for (let n = 1; n <= 5; n++) await seedRegistration(n, PASS_A)
      for (let n = 1; n <= 5; n++) {
        await engine.allocateIdentifier({
          eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual', passId: PASS_A,
        })
      }

      const { model } = await config.getIdentifierOverview(SLUG, ctxWith([{ id: PASS_A, name: 'Alpha' }]))
      const a = model.pools.find(p => p.poolId === 'a')!
      expect(a.assigned).toBe(5)
      expect(a.nextNumber).toBe(5006)
      expect(a.available).toBe(999 - 5)
    })

    it('a consumed identifier moves out of assigned and into consumed', async () => {
      await seedConfig({ pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def' })
      await seedRegistration(1, PASS_A)
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      await engine.consumeIdentifier(regId(1), UID)

      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].assigned).toBe(0)
      expect(model.pools[0].consumed).toBe(1)
      expect(model.pools[0].occupied).toBe(1)
    })

    it('a released identifier leaves occupied and becomes reusable', async () => {
      await seedConfig({
        pools: [{ poolId: 'def', label: 'D', ranges: [{ start: 1, end: 10 }] }], defaultPoolId: 'def',
      })
      await seedRegistration(1, PASS_A)
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      await engine.releaseIdentifier(regId(1), UID, 'cancelled')

      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].assigned).toBe(0)
      expect(model.pools[0].released).toBe(1)
      expect(model.pools[0].occupied).toBe(0)
      expect(model.pools[0].available).toBe(10)
      expect(model.summary.reusable).toBe(1)
    })
  })

  // ══ 3. Exhaustion / inconsistency ════════════════════════════════════════

  describe('3 — the boundaries', () => {
    it('a full pool is EXHAUSTED, and the engine agrees by refusing', async () => {
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [{ poolId: 'def', label: 'D', ranges: [{ start: 1, end: 2 }] }], defaultPoolId: 'def',
      })
      for (let n = 1; n <= 3; n++) await seedRegistration(n, PASS_A)
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual' })

      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].state).toBe('exhausted')
      expect(model.pools[0].available).toBe(0)
      expect(model.pools[0].utilization).toBe(1)
      expect(model.summary.poolsExhausted).toBe(1)

      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(3), actor: UID, source: 'manual',
      })).rejects.toMatchObject({ code: 'POOL_EXHAUSTED' })
    })

    it('more locks than the range holds is INCONSISTENT, not clamped', async () => {
      // Exactly the legacy shape this reports: identifiers issued before the range
      // was narrowed. Nothing is released, deleted or reassigned.
      await seedConfig({
        pools: [{ poolId: 'def', label: 'D', ranges: [{ start: 1, end: 2 }] }], defaultPoolId: 'def',
      })
      await Promise.all([
        seedLock('1', 'def', 'assigned'), seedLock('2', 'def', 'assigned'), seedLock('3', 'def', 'assigned'),
      ])
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].state).toBe('inconsistent')
      expect(model.pools[0].assigned).toBe(3)
      expect(model.pools[0].utilization).toBeCloseTo(1.5)
      expect(model.pools[0].available).toBeNull()
      expect(model.summary.poolsInconsistent).toBe(1)

      // The stranded identifier is still there, untouched.
      expect((await adminDb.collection('identifierLocks').doc(`${SLUG}__3`).get()).exists).toBe(true)
    })

    it('an UNLIMITED pool is never a full meter', async () => {
      await seedConfig({ pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def' })
      await Promise.all([seedLock('1', 'def', 'assigned'), seedLock('2', 'def', 'assigned')])
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].capacityKind).toBe('unlimited')
      expect(model.pools[0].capacity).toBeNull()
      expect(model.pools[0].available).toBeNull()
      expect(model.pools[0].utilization).toBeNull()
      expect(model.pools[0].assigned).toBe(2)
      expect(model.pools[0].state).toBe('unlimited')
      expect(JSON.stringify(model)).not.toContain('Infinity')
    })
  })

  // ══ 4. Pass scopes ═══════════════════════════════════════════════════════

  describe('4 — pass scopes, without reading one registration', () => {
    beforeEach(async () => {
      await seedConfig({
        pools: [
          { poolId: 'a1', label: 'A1', passIds: [PASS_A], ranges: [{ start: 1, end: 100 }] },
          { poolId: 'a2', label: 'A2', passIds: [PASS_A], ranges: [{ start: 500, end: 599 }] },
          { poolId: 'b',  label: 'B',  passIds: [PASS_B], ranges: [{ start: 1000, end: 1099 }] },
          { poolId: 'def', label: 'D' },
        ],
        defaultPoolId: 'def',
      })
      await Promise.all([
        seedLock('1', 'a1', 'assigned'), seedLock('500', 'a2', 'assigned'), seedLock('1000', 'b', 'assigned'),
      ])
    })

    it('two pools serving one pass make ONE scope with the summed capacity', async () => {
      const { model } = await config.getIdentifierOverview(
        SLUG, ctxWith([{ id: PASS_A, name: 'Alpha' }, { id: PASS_B, name: 'Beta' }]),
      )
      const alpha = model.passScopes.find(s => s.passId === PASS_A)!
      expect(alpha.capacity).toBe(200)
      expect(alpha.assigned).toBe(2)
      expect(alpha.poolIds).toEqual(['a1', 'a2'])
      expect(alpha.passName).toBe('Alpha')
      // The pools themselves are still separate objects.
      expect(model.pools.map(p => p.poolId)).toEqual(['a1', 'a2', 'b', 'def'])
    })

    it('a pool wired to a DELETED pass is orphaned, and nothing is repaired', async () => {
      const before = await adminDb.collection('identifierLocks').doc(`${SLUG}__1`).get()
      const { model } = await config.getIdentifierOverview(SLUG, ctxWith([{ id: PASS_B, name: 'Beta' }]))
      const a1 = model.pools.find(p => p.poolId === 'a1')!
      expect(a1.state).toBe('orphaned')
      expect(a1.orphanedPassIds).toEqual([PASS_A])
      expect(model.summary.poolsOrphaned).toBe(2)   // a1 and a2 both serve the gone pass

      const after = await adminDb.collection('identifierLocks').doc(`${SLUG}__1`).get()
      expect(after.exists).toBe(true)
      expect(after.get('state')).toBe(before.get('state'))
    })

    it('when the passes are UNKNOWN nothing is condemned', async () => {
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.summary.poolsOrphaned).toBe(0)
      expect(model.passesKnown).toBe(false)
    })

    it('eligible and unassigned per pass stay UNKNOWN with a stated reason', async () => {
      const { model } = await config.getIdentifierOverview(SLUG, ctxWith([{ id: PASS_A, name: 'Alpha' }]))
      const alpha = model.passScopes.find(s => s.passId === PASS_A)!
      expect(alpha.eligible.value).toBeNull()
      expect(alpha.unassignedEligible.value).toBeNull()
      expect(alpha.eligible.reason).toBeTruthy()
    })
  })

  // ══ 5. Eligibility ═══════════════════════════════════════════════════════

  describe('5 — the eligible count is one aggregate over the roster rule', () => {
    beforeEach(async () => {
      await seedConfig({ pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def' })
      await Promise.all([
        seedRegistration(1, PASS_A, 'confirmed'), seedRegistration(2, PASS_A, 'confirmed'),
        seedRegistration(3, PASS_A, 'pending'),   seedRegistration(4, PASS_A, 'cancelled'),
        seedRegistration(5, PASS_A, 'waitlisted'), seedRegistration(6, PASS_A, 'rejected'),
      ])
    })

    it('counts exactly the statuses the roster lists', async () => {
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE, UID)
      expect(model.eligibility.eligible.value).toBe(2)
      expect(model.eligibility.eligible.status).toBe('known')
    })

    it('the divergence is reported, not resolved', async () => {
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE, UID)
      expect(model.eligibility.policy).toBe('divergent')
      expect(model.eligibility.divergentStatuses.sort()).toEqual(['pending', 'waitlisted'])
      expect(model.eligibility.unassignedEligible.value).toBeNull()
      expect(model.eligibility.unassignedReason).toMatch(/counter|flag/i)
    })

    it('without an organizer uid the count is UNAVAILABLE, never 0', async () => {
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.eligibility.eligible.status).toBe('unavailable')
      expect(model.eligibility.eligible.value).toBeNull()
      expect(model.eligibility.eligible.value).not.toBe(0)
    })

    it('a cross-workspace uid sees none of this event\'s registrations', async () => {
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE, `${UID}-someone-else`)
      expect(model.eligibility.eligible.value).toBe(0)
    })
  })

  // ══ 6. No PII, no document transfer ══════════════════════════════════════

  describe('6 — statistics carry counts, never people', () => {
    it('the serialized model contains no attendee data even with registrations present', async () => {
      await seedConfig({ pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def' })
      for (let n = 1; n <= 5; n++) await seedRegistration(n, PASS_A)

      const { model, legacy } = await config.getIdentifierOverview(SLUG, CTX_NONE, UID)
      const json = (JSON.stringify(model) + JSON.stringify(legacy)).toLowerCase()
      for (const leak of ['person 1', 'test.local', '9999999999', 'attendee', 'email', 'phone']) {
        expect(json, leak).not.toContain(leak)
      }
      expect(model.eligibility.eligible.value).toBe(5)   // …the count is still exact
    })
  })

  // ══ 7. Legacy shapes ═════════════════════════════════════════════════════

  describe('7 — legacy events still produce a read model', () => {
    it('an event with NO stored config falls back to the default pool', async () => {
      await seedLock('0001', 'default', 'assigned')
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.configured).toBe(false)
      expect(model.pools).toHaveLength(1)
      expect(model.pools[0].poolId).toBe('default')
      expect(model.pools[0].assigned).toBe(1)
      expect(model.pools[0].capacityKind).toBe('unlimited')
    })

    it('a legacy scalar range still reports capacity and availability', async () => {
      await seedConfig({
        pools: [{ poolId: 'def', label: 'D', rangeStart: 100, rangeEnd: 199 }], defaultPoolId: 'def',
      })
      await seedLock('100', 'def', 'assigned')
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].capacity).toBe(100)
      expect(model.pools[0].available).toBe(99)
    })

    it('a half-bounded legacy pool is UNLIMITED, never zero-capacity', async () => {
      await seedConfig({
        pools: [{ poolId: 'def', label: 'D', rangeStart: 100 }], defaultPoolId: 'def',
      })
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].capacityKind).toBe('unlimited')
      expect(model.pools[0].capacity).toBeNull()
      expect(model.pools[0].capacity).not.toBe(0)
    })

    it('legacy bibLocks are counted SEPARATELY and never added to assigned', async () => {
      await seedConfig({ pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def' })
      await seedLock('1', 'def', 'assigned')
      await adminDb.collection('bibLocks').doc(`${SLUG}__900`).set({
        eventSlug: SLUG, registrationId: 'legacy-reg',
      })
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.legacyLocks.value).toBe(1)
      expect(model.summary.assigned).toBe(1)   // the legacy lock is NOT folded in
    })

    it('an old counter document is surfaced as the pool\'s next number', async () => {
      await seedConfig({ pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def' })
      await adminDb.collection('identifierCounters').doc(`${SLUG}__def`).set({
        eventSlug: SLUG, poolId: 'def', nextNumber: 4242, updatedAt: new Date(),
      })
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].nextNumber).toBe(4242)
    })

    it('a pool with no counter yet reports null, not the range start', async () => {
      await seedConfig({
        pools: [{ poolId: 'def', label: 'D', ranges: [{ start: 500, end: 599 }] }], defaultPoolId: 'def',
      })
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].nextNumber).toBeNull()
    })
  })

  // ══ 8. Determinism + scale ═══════════════════════════════════════════════

  describe('8 — deterministic, and flat in cost', () => {
    it('two identical requests return byte-identical output', async () => {
      await seedConfig({
        pools: [
          { poolId: 'z', label: 'Z', ranges: [{ start: 900, end: 999 }] },
          { poolId: 'a', label: 'A', ranges: [{ start: 1, end: 100 }] },
        ],
        defaultPoolId: 'a',
      })
      await Promise.all([seedLock('1', 'a', 'assigned'), seedLock('900', 'z', 'assigned')])
      const one = await config.getIdentifierOverview(SLUG, CTX_NONE)
      const two = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(JSON.stringify(one.model)).toBe(JSON.stringify(two.model))
      // Configuration order, not Firestore document order (which would sort a, z).
      expect(one.model.pools.map(p => p.poolId)).toEqual(['z', 'a'])
    })

    it('the same query count serves 5 identifiers and 200', async () => {
      await seedConfig({
        pools: [{ poolId: 'def', label: 'D', ranges: [{ start: 1, end: 1000 }] }], defaultPoolId: 'def',
      })
      for (let batchStart = 1; batchStart <= 200; batchStart += 100) {
        const batch = adminDb.batch()
        for (let n = batchStart; n < batchStart + 100; n++) {
          batch.set(adminDb.collection('identifierLocks').doc(`${SLUG}__${n}`), {
            eventSlug: SLUG, value: String(n), numeric: n, poolId: 'def', templateId: null,
            state: 'assigned', registrationId: null, everCheckedIn: false, reason: null,
            assignedAt: null, releasedAt: null, createdAt: new Date(), updatedAt: new Date(),
          })
        }
        await batch.commit()
      }
      const { model } = await config.getIdentifierOverview(SLUG, CTX_NONE)
      expect(model.pools[0].assigned).toBe(200)
      expect(model.pools[0].available).toBe(800)
      expect(model.pools[0].utilization).toBeCloseTo(0.2)
    }, 60_000)
  })
})
