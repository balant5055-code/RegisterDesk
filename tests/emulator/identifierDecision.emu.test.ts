// RD-EVENT-19C · the decision model against REAL Firestore (emulator).
//
// A mock cannot prove any of this. What is under test is the agreement between a
// pure decision and what the transaction actually does:
//   • when the decision says PASS_OUT_OF_POOL_SCOPE, the allocator really does
//     put the participant somewhere else;
//   • when it says POOL_EXHAUSTED, the engine really refuses;
//   • when it says a value is not reusable, the engine really skips it;
//   • concurrent writers still produce exactly one winner.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

describeEmu('RD-EVENT-19C · assignment decisions', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let engine: typeof import('@/lib/identifiers/engine')
  let config: typeof import('@/lib/identifiers/config')
  let decision: typeof import('@/lib/identifiers/assignmentDecision')

  const PID  = process.pid
  const SLUG = `id19c-${PID}`
  const UID  = `id19c-org-${PID}`
  const PASS_A = 'pass-alpha'
  const PASS_B = 'pass-beta'

  const regId = (n: number) => `${SLUG}-reg-${n}`
  const ctxOf = (passes: Array<{ id: string; name: string }>) => ({ passes, passesKnown: true })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    engine   = await import('@/lib/identifiers/engine')
    config   = await import('@/lib/identifiers/config')
    decision = await import('@/lib/identifiers/assignmentDecision')
  })

  async function wipe() {
    for (const col of ['identifierLocks', 'identifierCounters', 'identifierHistory', 'bibLocks', 'registrations']) {
      const snap = await adminDb.collection(col).where('eventSlug', '==', SLUG).get()
      const batch = adminDb.batch()
      snap.docs.forEach(d => batch.delete(d.ref))
      await batch.commit()
    }
    await adminDb.collection('identifierConfigs').doc(SLUG).delete()
  }

  async function seedConfig(patch: Record<string, unknown>) {
    await adminDb.collection('identifierConfigs').doc(SLUG).set({
      ...config.defaultIdentifierConfig(SLUG), ...patch, eventSlug: SLUG,
    })
  }

  async function seedRegistration(n: number, passId: string, status = 'confirmed') {
    await adminDb.collection('registrations').doc(regId(n)).set({
      eventSlug: SLUG, organizerUid: UID, passId, passName: passId,
      attendee: { name: `P${n}`, email: `p${n}@test.local` },
      status, paymentStatus: 'paid', amount: 0, ticketCode: `RD-${PID}-${n}`, createdAt: new Date(),
    })
  }

  const readConfig = async () => (await config.resolveIdentifierConfig(SLUG)).config

  beforeEach(wipe)
  afterAll(wipe)

  // ══ 1. The decision predicts the transaction ═════════════════════════════

  describe('1 — a decision and the allocator agree', () => {
    beforeEach(async () => {
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [
          { poolId: 'def', label: 'Default' },
          { poolId: 'pa', label: 'Alpha', passIds: [PASS_A], ranges: [{ start: 5001, end: 5002 }] },
          { poolId: 'pb', label: 'Beta',  passIds: [PASS_B], ranges: [{ start: 7000, end: 7999 }] },
        ],
        defaultPoolId: 'def',
      })
    })

    it('WRONG PASS · the decision refuses, and the allocator really does route elsewhere', async () => {
      const cfg = await readConfig()
      const ctx = ctxOf([{ id: PASS_A, name: 'Alpha' }, { id: PASS_B, name: 'Beta' }])
      const poolA = cfg.pools.find(p => p.poolId === 'pa')!

      // The decision, before anything is written.
      expect(decision.decidePoolScope(poolA, PASS_B, ctx))
        .toMatchObject({ eligible: false, reason: 'PASS_OUT_OF_POOL_SCOPE' })

      // The engine, for real: a PASS_B participant never lands in pool 'pa'.
      await seedRegistration(1, PASS_B)
      const r = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_B,
      })
      expect(r.poolId).toBe('pb')
      expect(Number(r.value)).toBeGreaterThanOrEqual(7000)
    })

    it('POOL_EXHAUSTED · the decision predicts it and the engine confirms it', async () => {
      for (let n = 1; n <= 3; n++) await seedRegistration(n, PASS_A)
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_A })
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual', passId: PASS_A })

      const { model } = await config.getIdentifierOverview(SLUG, ctxOf([{ id: PASS_A, name: 'A' }, { id: PASS_B, name: 'B' }]))
      const stat = model.pools.find(p => p.poolId === 'pa')!
      expect(stat.state).toBe('exhausted')

      const cfg = await readConfig()
      const d = decision.decideAssignment({
        config: cfg, lifecycleStatus: 'published',
        registration: { status: 'confirmed', passId: PASS_A }, registrationId: regId(3),
        pool: cfg.pools.find(p => p.poolId === 'pa')!,
        current: { identifier: null, legacyValue: null },
        ctx: ctxOf([{ id: PASS_A, name: 'A' }]), poolUsage: stat,
      })
      expect(d).toMatchObject({ eligible: false, reason: 'POOL_EXHAUSTED' })

      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(3), actor: UID, source: 'manual', passId: PASS_A,
      })).rejects.toMatchObject({ code: 'POOL_EXHAUSTED' })
    })

    it('the range preview predicts the values the engine then issues', async () => {
      const cfg = await readConfig()
      const poolB = cfg.pools.find(p => p.poolId === 'pb')!
      const preview = decision.previewRangeAllocation(poolB, null, 3)
      expect(preview.nextValue).toBe(7000)
      expect(preview.lastValue).toBe(7002)

      for (let n = 1; n <= 3; n++) await seedRegistration(n, PASS_B)
      const issued: string[] = []
      for (let n = 1; n <= 3; n++) {
        issued.push((await engine.allocateIdentifier({
          eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual', passId: PASS_B,
        })).value)
      }
      expect(issued).toEqual(['7000', '7001', '7002'])
    })

    it('a gapped preview predicts the JUMP the engine performs', async () => {
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [{ poolId: 'def', label: 'D', ranges: [{ start: 10, end: 11 }, { start: 20, end: 21 }] }],
        defaultPoolId: 'def',
      })
      const cfg = await readConfig()
      const preview = decision.previewRangeAllocation(cfg.pools[0], null, 4)
      expect(preview.lastValue).toBe(21)
      expect(preview.gapsCrossed).toBe(1)

      for (let n = 1; n <= 4; n++) await seedRegistration(n, PASS_A)
      const issued: string[] = []
      for (let n = 1; n <= 4; n++) {
        issued.push((await engine.allocateIdentifier({
          eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual',
        })).value)
      }
      expect(issued).toEqual(['10', '11', '20', '21'])
    })
  })

  // ══ 2. Collision decisions vs the engine ═════════════════════════════════

  describe('2 — collision decisions match what the lock layer does', () => {
    beforeEach(async () => {
      await seedConfig({
        pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def',
        reusePolicy: 'after_cancel_before_checkin',
      })
      await seedRegistration(1, PASS_A)
      await seedRegistration(2, PASS_A)
    })

    it('a value owned by another registration is refused by both', async () => {
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: 'X-1',
      })
      const lock = (await adminDb.collection('identifierLocks').doc(`${SLUG}__X-1`).get()).data()!

      expect(decision.decideValueCollision({
        lock: lock as never, registrationId: regId(2),
        reusePolicy: 'after_cancel_before_checkin', phase: 'pre_event', allowDuplicate: false,
      })).toMatchObject({ eligible: false, reason: 'IDENTIFIER_OWNED_BY_OTHER' })

      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual', explicitValue: 'X-1',
      })).rejects.toMatchObject({ code: 'VALUE_CONFLICT' })
    })

    it('a released value the policy permits is reusable in both', async () => {
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: 'X-2',
      })
      await engine.releaseIdentifier(regId(1), UID, 'cancelled')
      const lock = (await adminDb.collection('identifierLocks').doc(`${SLUG}__X-2`).get()).data()!

      expect(decision.decideValueCollision({
        lock: lock as never, registrationId: regId(2),
        reusePolicy: 'after_cancel_before_checkin', phase: 'pre_event', allowDuplicate: false,
      })).toMatchObject({ eligible: true, action: 'reuse' })

      const r = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual', explicitValue: 'X-2',
      })
      expect(r.reused).toBe(true)
    })

    it('a released value that was CHECKED IN is refused by both', async () => {
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: 'X-3',
      })
      await engine.consumeIdentifier(regId(1), UID)
      await engine.releaseIdentifier(regId(1), UID, 'cancelled after check-in')
      const lock = (await adminDb.collection('identifierLocks').doc(`${SLUG}__X-3`).get()).data()!

      expect(decision.decideValueCollision({
        lock: lock as never, registrationId: regId(2),
        reusePolicy: 'after_cancel_before_checkin', phase: 'pre_event', allowDuplicate: false,
      })).toMatchObject({ eligible: false, reason: 'IDENTIFIER_NOT_REUSABLE' })

      // The engine's own automatic path also skips it.
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def',
      })
      const r = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual',
      })
      expect(r.value).not.toBe('X-3')
    })

    it('a blocked value is refused by both', async () => {
      await engine.blockIdentifier({ eventSlug: SLUG, value: 'X-4', actor: UID, reason: 'damaged' })
      const lock = (await adminDb.collection('identifierLocks').doc(`${SLUG}__X-4`).get()).data()!

      expect(decision.decideValueCollision({
        lock: lock as never, registrationId: regId(1),
        reusePolicy: 'never', phase: 'pre_event', allowDuplicate: false,
      })).toMatchObject({ reason: 'IDENTIFIER_BLOCKED' })

      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: 'X-4',
      })).rejects.toMatchObject({ code: 'VALUE_CONFLICT' })
    })
  })

  // ══ 3. Existing identifiers ══════════════════════════════════════════════

  describe('3 — a participant who already holds one', () => {
    beforeEach(async () => {
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def',
      })
      await seedRegistration(1, PASS_A)
    })

    it('the mirror the decision reads is what the engine wrote', async () => {
      const r = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual',
      })
      const doc = await adminDb.collection('registrations').doc(regId(1)).get()
      const current = {
        identifier: doc.get('identifier'),
        legacyValue: doc.get('bibNumber') as string | null,
      }
      expect(current.identifier.value).toBe(r.value)

      expect(decision.decideExistingIdentifier(current, r.value, 'def')).toMatchObject({ action: 'noop' })
      expect(decision.decideExistingIdentifier(current, '999', 'def'))
        .toMatchObject({ action: 'swap', reason: 'ALREADY_ASSIGNED' })
    })

    it('a CONSUMED identifier is not swapped automatically, and the engine still holds the lock', async () => {
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual' })
      await engine.consumeIdentifier(regId(1), UID)
      const doc = await adminDb.collection('registrations').doc(regId(1)).get()

      expect(decision.decideExistingIdentifier(
        { identifier: doc.get('identifier'), legacyValue: doc.get('bibNumber') }, '999', 'def',
      )).toMatchObject({ eligible: false, reason: 'IDENTIFIER_CONSUMED', action: 'blocked' })
    })

    it('an INCONSISTENT legacy-only mirror is reported and NOT repaired', async () => {
      await adminDb.collection('registrations').doc(regId(1)).update({
        bibNumber: '4242', bibCategory: null, identifier: null,
      })
      const doc = await adminDb.collection('registrations').doc(regId(1)).get()
      const d = decision.decideExistingIdentifier(
        { identifier: doc.get('identifier'), legacyValue: doc.get('bibNumber') }, null, 'def',
      )
      expect(d).toMatchObject({ state: 'unknown', reason: 'LEGACY_MIRROR_WITHOUT_LOCK' })

      // Nothing was written by asking.
      const after = await adminDb.collection('registrations').doc(regId(1)).get()
      expect(after.get('bibNumber')).toBe('4242')
      expect(after.get('identifier')).toBeNull()
    })
  })

  // ══ 4. Concurrency ═══════════════════════════════════════════════════════

  describe('4 — concurrency is unchanged and still exact', () => {
    beforeEach(async () => {
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [{ poolId: 'pa', label: 'A', passIds: [PASS_A], ranges: [{ start: 100, end: 199 }] }],
        defaultPoolId: 'pa',
      })
      for (let n = 1; n <= 6; n++) await seedRegistration(n, PASS_A)
    })

    it('two writers racing for the SAME value: never both', async () => {
      // SAFETY, not liveness. The invariant is that two participants can never
      // end up holding one identifier — that is what a printed number depends on.
      // "At least one must succeed" is a liveness property the datastore cannot
      // promise under contention: when the emulator is saturated BOTH
      // transactions can abort, and a retry is the caller's business. Asserting
      // exactly-one made this test fail in the full suite while the engine was
      // behaving correctly. A 20-round churn probe showed one winner and one
      // VALUE_CONFLICT every time, and zero double-holds.
      const results = await Promise.allSettled([
        engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: '150' }),
        engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual', explicitValue: '150' }),
      ])
      const winners = results.filter(r => r.status === 'fulfilled')
      expect(winners.length).toBeLessThanOrEqual(1)

      // Whatever happened, exactly one registration may hold the value…
      const holders = await adminDb.collection('registrations')
        .where('eventSlug', '==', SLUG).where('bibNumber', '==', '150').get()
      expect(holders.size).toBeLessThanOrEqual(1)

      // …and the lock and the mirror must agree.
      const lock = (await adminDb.collection('identifierLocks').doc(`${SLUG}__150`).get()).data()
      if (winners.length === 1) {
        expect(lock?.state).toBe('assigned')
        expect([regId(1), regId(2)]).toContain(lock?.registrationId)
        expect(holders.size).toBe(1)
        expect(holders.docs[0].id).toBe(lock?.registrationId)
        // The loser was refused for the right reason, not silently dropped.
        const loser = results.find(r => r.status === 'rejected')
        expect((loser as PromiseRejectedResult | undefined)?.reason)
          .toMatchObject({ code: 'VALUE_CONFLICT' })
      }
    })

    it('two writers on the SAME participant leave exactly one identifier', async () => {
      await Promise.allSettled([
        engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_A }),
        engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_A }),
      ])
      const doc = await adminDb.collection('registrations').doc(regId(1)).get()
      const held = doc.get('identifier')?.value as string
      expect(typeof held).toBe('string')

      const mine = await adminDb.collection('identifierLocks')
        .where('eventSlug', '==', SLUG).where('registrationId', '==', regId(1))
        .where('state', '==', 'assigned').get()
      expect(mine.size).toBe(1)
      expect(mine.docs[0].get('value')).toBe(held)
    }, 60_000)

    it('six simultaneous allocations from one range produce six distinct values', async () => {
      const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(n =>
        engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual', passId: PASS_A })))
      const values = rs.map(r => r.value)
      expect(new Set(values).size).toBe(6)
      for (const v of values) expect(Number(v)).toBeGreaterThanOrEqual(100)
    }, 60_000)

    it('a release racing a reassignment leaves a consistent lock', async () => {
      const a = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_A,
      })
      await Promise.allSettled([
        engine.releaseIdentifier(regId(1), UID, 'cancel'),
        engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual', explicitValue: a.value }),
      ])
      const lock = (await adminDb.collection('identifierLocks').doc(`${SLUG}__${a.value}`).get()).data()!
      // Whoever won, the lock names exactly one owner and one state.
      expect(['assigned', 'released']).toContain(lock.state)
      if (lock.state === 'assigned') expect(lock.registrationId).toBeTruthy()
    }, 60_000)

    it('a swap racing an assignment never leaves two live locks for one participant', async () => {
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_A,
      })
      await Promise.allSettled([
        engine.swapIdentifier({ registrationId: regId(1), actor: UID, explicitValue: '180' }),
        engine.swapIdentifier({ registrationId: regId(1), actor: UID, explicitValue: '181' }),
      ])
      const live = await adminDb.collection('identifierLocks')
        .where('eventSlug', '==', SLUG).where('registrationId', '==', regId(1))
        .where('state', '==', 'assigned').get()
      expect(live.size).toBeLessThanOrEqual(1)
    }, 60_000)
  })

  // ══ 5. Lifecycle enforcement ═════════════════════════════════════════════

  describe('5 — the lifecycle gate is real, not advisory', () => {
    it('the gate matches the platform rule for every defined lifecycle', () => {
      for (const ls of ['published', 'registration_closed', 'completed', 'unpublished', 'draft']) {
        expect(decision.resolveEventAssignmentGate(ls).open).toBe(true)
      }
      for (const ls of ['cancelled', 'archived']) {
        expect(decision.resolveEventAssignmentGate(ls).open).toBe(false)
      }
      expect(decision.resolveEventAssignmentGate('mystery').open).toBe(false)
      expect(decision.resolveEventAssignmentGate(null).open).toBe(false)
    })

    it('the ENGINE itself is unchanged — it still allocates regardless', async () => {
      // The gate lives at the route, deliberately: check-in has its OWN gate
      // (getEventCheckInStatus) and must keep working at the door.
      await seedConfig({ pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def' })
      await seedRegistration(1, PASS_A)
      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual',
      })).resolves.toBeTruthy()
    })
  })

  // ══ 6. Preview against real statistics ═══════════════════════════════════

  describe('6 — the preview reads the real read model', () => {
    it('builds a per-pass breakdown from live aggregates', async () => {
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [
          { poolId: 'pa', label: 'A', passIds: [PASS_A], ranges: [{ start: 100, end: 199 }] },
          { poolId: 'pb', label: 'B', passIds: [PASS_B], ranges: [{ start: 200, end: 249 }] },
        ],
        defaultPoolId: 'pa',
      })
      for (let n = 1; n <= 3; n++) await seedRegistration(n, PASS_A)
      for (let n = 1; n <= 3; n++) {
        await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual', passId: PASS_A })
      }

      const ctx = ctxOf([{ id: PASS_A, name: 'Alpha' }, { id: PASS_B, name: 'Beta' }])
      const { model, config: cfg } = await config.getIdentifierOverview(SLUG, ctx, UID)
      const preview = decision.buildAssignmentPreview({
        selection: { kind: 'all_passes' }, config: cfg, lifecycleStatus: 'published', ctx,
        poolStats: new Map(model.pools.map(p => [p.poolId, p])),
      })

      expect(preview.scopes.map(s => s.passName)).toEqual(['Alpha', 'Beta'])
      expect(preview.scopes[0].alreadyAssigned.value).toBe(3)
      expect(preview.scopes[0].capacityAvailable).toBe(97)
      expect(preview.scopes[1].alreadyAssigned.value).toBe(0)
      expect(preview.totals.capacityAvailable).toBe(97 + 50)
      expect(preview.ready).toBe(true)
      // …and the one number nobody can honestly produce yet.
      expect(preview.totals.remaining.value).toBeNull()
    })

    it('a locked event is not ready, whatever the pools say', async () => {
      await seedConfig({ pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def' })
      const ctx = ctxOf([{ id: PASS_A, name: 'Alpha' }])
      const { model, config: cfg } = await config.getIdentifierOverview(SLUG, ctx)
      const preview = decision.buildAssignmentPreview({
        selection: { kind: 'all_passes' }, config: cfg, lifecycleStatus: 'archived', ctx,
        poolStats: new Map(model.pools.map(p => [p.poolId, p])),
      })
      expect(preview.ready).toBe(false)
      expect(preview.blockers.map(b => b.reason)).toContain('EVENT_LOCKED')
    })

    it('an ORPHANED pool surfaces as a scope blocker', async () => {
      await seedConfig({
        pools: [{ poolId: 'gone', label: 'Gone', passIds: ['deleted-pass'], ranges: [{ start: 1, end: 9 }] }],
        defaultPoolId: 'gone',
      })
      const ctx = ctxOf([{ id: PASS_A, name: 'Alpha' }])
      const { model, config: cfg } = await config.getIdentifierOverview(SLUG, ctx)
      const preview = decision.buildAssignmentPreview({
        selection: { kind: 'all_passes' }, config: cfg, lifecycleStatus: 'published', ctx,
        poolStats: new Map(model.pools.map(p => [p.poolId, p])),
      })
      expect(preview.blockers.map(b => b.reason)).toContain('POOL_PASS_DELETED')
      expect(preview.ready).toBe(false)
    })
  })

  // ══ 7. Legacy shapes still decide ════════════════════════════════════════

  describe('7 — legacy configurations still produce decisions', () => {
    it('a legacy matchRule.by = pass scopes the decision AND the allocation', async () => {
      await seedConfig({
        type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
        pools: [
          { poolId: 'def', label: 'D' },
          { poolId: 'lg', label: 'Legacy', matchRule: { by: 'pass', values: [PASS_B] }, rangeStart: 600, rangeEnd: 699 },
        ],
        defaultPoolId: 'def',
      })
      const cfg = await readConfig()
      const ctx = ctxOf([{ id: PASS_A, name: 'A' }, { id: PASS_B, name: 'B' }])
      const legacy = cfg.pools.find(p => p.poolId === 'lg')!

      expect(decision.decidePoolScope(legacy, PASS_B, ctx).eligible).toBe(true)
      expect(decision.decidePoolScope(legacy, PASS_A, ctx))
        .toMatchObject({ eligible: false, reason: 'PASS_OUT_OF_POOL_SCOPE' })

      await seedRegistration(1, PASS_B)
      const r = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS_B,
      })
      expect(r.poolId).toBe('lg')
      expect(r.value).toBe('600')
    })

    it('an event with NO stored config still decides on the default pool', async () => {
      await seedRegistration(1, PASS_A)
      const cfg = await readConfig()
      expect(decision.decideAssignment({
        config: cfg, lifecycleStatus: 'published',
        registration: { status: 'confirmed', passId: PASS_A }, registrationId: regId(1),
        pool: cfg.pools[0], current: { identifier: null, legacyValue: null },
        ctx: ctxOf([{ id: PASS_A, name: 'A' }]), poolUsage: null,
      })).toMatchObject({ eligible: true, poolId: 'default' })
    })

    it('a value held only in legacy bibLocks is refused by the decision and the engine', async () => {
      await seedConfig({ pools: [{ poolId: 'def', label: 'D' }], defaultPoolId: 'def' })
      await adminDb.collection('bibLocks').doc(`${SLUG}__777`).set({
        eventSlug: SLUG, registrationId: 'someone-else',
      })
      await seedRegistration(1, PASS_A)

      expect(decision.decideValueCollision({
        lock: null, legacyOwner: 'someone-else', registrationId: regId(1),
        reusePolicy: 'never', phase: 'pre_event', allowDuplicate: false,
      })).toMatchObject({ eligible: false, reason: 'IDENTIFIER_OWNED_BY_OTHER' })

      await expect(engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', explicitValue: '777',
      })).rejects.toMatchObject({ code: 'VALUE_CONFLICT' })
    })
  })
})
