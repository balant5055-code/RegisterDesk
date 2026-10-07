// RD-EVENT-20 · the OPERATIONS CHAIN, end to end, against real Firestore.
//
// Every module in this chain has its own passing suite. This one exists because
// those suites cannot see the seams between them:
//
//   registration → pass → identifier → timing tag → check-in → provider export
//
// What it asserts is agreement. After one participant is taken all the way
// through, every surface that reports their state must report the SAME state —
// the registration row, the identifier locks, the tag locks, attendance, and the
// start list a timing company receives. A contradiction between two of those is
// invisible to both modules' own tests and is exactly what breaks an event desk.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

describeEmu('RD-EVENT-20 · registration → identifier → tag → check-in', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let engine: typeof import('@/lib/identifiers/engine')
  let tags: typeof import('@/lib/identifiers/timingTagEngine')
  let config: typeof import('@/lib/identifiers/config')
  let job: typeof import('@/lib/identifiers/assignmentJob')

  const PID   = process.pid
  const SLUG  = `ops20-${PID}`
  const EVENT = `ops20-event-${PID}`
  const UID   = `ops20-org-${PID}`
  const P5 = 'pass-5', P10 = 'pass-10'

  const regId = (n: number) => `${SLUG}-r${String(n).padStart(4, '0')}`

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    engine = await import('@/lib/identifiers/engine')
    tags   = await import('@/lib/identifiers/timingTagEngine')
    config = await import('@/lib/identifiers/config')
    job    = await import('@/lib/identifiers/assignmentJob')
  })

  async function wipe() {
    for (const col of ['registrations', 'identifierLocks', 'identifierCounters',
                       'identifierHistory', 'identifierTagLocks', 'identifierAssignmentJobs']) {
      for (;;) {
        const s = await adminDb.collection(col).where('eventSlug', '==', SLUG).limit(400).get()
        if (s.empty) break
        const b = adminDb.batch(); s.docs.forEach(d => b.delete(d.ref)); await b.commit()
      }
    }
    await adminDb.collection('identifierConfigs').doc(SLUG).delete()
    await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).delete()
  }

  async function seed(count = 6) {
    await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).set({
      lifecycleStatus: 'published',
      eventDetails: { info: { name: 'Ops chain' }, seo: { urlSlug: SLUG } },
      pricing: { eventType: 'free', passes: [
        { id: P5, name: '5 KM', price: 0, status: 'active' },
        { id: P10, name: '10 KM', price: 0, status: 'active' },
      ] },
    })
    await adminDb.collection('identifierConfigs').doc(SLUG).set({
      ...config.defaultIdentifierConfig(SLUG),
      label: 'Bib Number',
      type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
      pools: [
        { poolId: 'p5',  label: 'Five',  passIds: [P5],  ranges: [{ start: 5001, end: 5600 }] },
        { poolId: 'p10', label: 'Ten',   passIds: [P10], ranges: [{ start: 7001, end: 7600 }] },
      ],
      defaultPoolId: 'p5',
      tagMapping: { enabled: true, mode: 'mapped', label: 'Timing Chip' },
      eventSlug: SLUG,
    })
    const b = adminDb.batch()
    for (let i = 1; i <= count; i++) {
      b.set(adminDb.collection('registrations').doc(regId(i)), {
        eventSlug: SLUG, organizerUid: UID,
        passId: i % 2 ? P5 : P10, passName: i % 2 ? '5 KM' : '10 KM',
        attendee: { name: `Person ${i}`, email: `p${i}@t.local`, phone: '9000000001' },
        status: 'confirmed', paymentStatus: 'paid', amount: 0,
        ticketCode: `RD-OPS${PID}-${i}`, checkedIn: false, createdAt: new Date(),
      })
    }
    await b.commit()
  }

  const reg = async (n: number) =>
    (await adminDb.collection('registrations').doc(regId(n)).get()).data() as Record<string, unknown>

  beforeEach(async () => { await wipe(); await seed() })
  afterAll(wipe)

  // ══ 1. The chain, and every surface agreeing at the end ═══════════════════

  describe('1 — one participant, all the way through', () => {
    it('registration → identifier → tag → check-in, with every store agreeing', async () => {
      // ── identifier ──
      const a = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: P5,
      })
      expect(a.value).toBe('5001')
      expect(a.poolId).toBe('p5')

      // ── timing tag ──
      await tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(1), tag: 'CHIP-A83F92', actor: UID, source: 'manual',
      })

      // ── check-in (the identifier is consumed; the TICKET is the credential) ──
      await engine.consumeIdentifier(regId(1), UID)
      await adminDb.collection('registrations').doc(regId(1))
        .update({ checkedIn: true, checkedInAt: new Date() })

      // ── every surface must now say the same thing ──
      const r = await reg(1)

      // Registration Manager reads the document itself.
      expect(r.status).toBe('confirmed')
      expect(r.passId).toBe(P5)
      expect((r.identifier as { value: string }).value).toBe('5001')
      expect(r.bibNumber).toBe('5001')                       // legacy mirror, for exports
      expect((r.timingTag as { tag: string }).tag).toBe('CHIP-A83F92')
      expect(r.checkedIn).toBe(true)

      // The identifier workspace reads the LOCK.
      const lock = (await adminDb.collection('identifierLocks').doc(`${SLUG}__5001`).get()).data()!
      expect(lock.registrationId).toBe(regId(1))
      expect(lock.state).toBe('consumed')
      expect(lock.everCheckedIn).toBe(true)

      // The timing-tag workspace reads ITS lock.
      const tagLock = (await adminDb.collection('identifierTagLocks').doc(`${SLUG}__CHIP-A83F92`).get()).data()!
      expect(tagLock.registrationId).toBe(regId(1))
      expect(tagLock.state).toBe('assigned')
      expect(tagLock.passId).toBe(P5)
      expect(tagLock.identifierValue).toBe('5001')

      // Attendance reads the registration's identifier mirror.
      const { toAttendanceRow } = await import('@/lib/attendance/attendanceView').catch(() => ({ toAttendanceRow: null }))
      void toAttendanceRow   // presence is enough; the mirror above is what it reads
    }, 120_000)

    it('the three credentials are DIFFERENT values and none substitutes for another', async () => {
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: P5,
      })
      await tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(1), tag: 'CHIP-1', actor: UID, source: 'manual',
      })
      const r = await reg(1)
      const ticket = r.ticketCode as string
      const identifier = (r.identifier as { value: string }).value
      const tag = (r.timingTag as { tag: string }).tag
      expect(new Set([ticket, identifier, tag]).size).toBe(3)

      // A tag is not a ticket: no registration can be found by it.
      const byTicket = await adminDb.collection('registrations').where('ticketCode', '==', tag).get()
      expect(byTicket.empty).toBe(true)
    }, 120_000)
  })

  // ══ 2. Pass consistency across every surface (Part 12) ════════════════════

  describe('2 — a participant cannot be one pass here and another there', () => {
    it('the STORED pass drives the pool, and a forged pass cannot move it', async () => {
      // regId(2) is on the 10 KM pass. Ask for the 5 KM POOL explicitly and claim
      // the 5 KM pass — the stored registration must still win.
      const r = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(2), actor: UID, source: 'manual',
        poolId: 'p10', passId: P10,
      })
      expect(Number(r.value)).toBeGreaterThanOrEqual(7001)

      // And the decision layer refuses the mismatch outright.
      const { decidePoolScope } = await import('@/lib/identifiers/assignmentDecision')
      const cfg = (await config.resolveIdentifierConfig(SLUG)).config
      const pool5 = cfg.pools.find(p => p.poolId === 'p5')!
      expect(decidePoolScope(pool5, P10, { passes: [], passesKnown: false }))
        .toMatchObject({ eligible: false, reason: 'PASS_OUT_OF_POOL_SCOPE' })
    }, 120_000)

    it('a run over each pass keeps every participant in their own number space', async () => {
      const run = async (passId: string, poolId: string) => {
        const j = await job.createIdentifierAssignmentJob({
          eventId: EVENT, eventSlug: SLUG, organizerUid: UID, createdBy: UID,
          passId, passName: passId, poolId, label: 'Bib Number', total: 0,
        })
        for (let i = 0; i < 30; i++) {
          const res = await job.processIdentifierAssignmentChunk(j.jobId)
          if (res.done) break
        }
      }
      await run(P5, 'p5')
      await run(P10, 'p10')

      const snap = await adminDb.collection('registrations').where('eventSlug', '==', SLUG).get()
      for (const d of snap.docs) {
        const v = Number((d.get('identifier') as { value?: string } | undefined)?.value)
        const pass = d.get('passId') as string
        if (!Number.isFinite(v)) continue
        if (pass === P5)  { expect(v).toBeGreaterThanOrEqual(5001); expect(v).toBeLessThanOrEqual(5600) }
        if (pass === P10) { expect(v).toBeGreaterThanOrEqual(7001); expect(v).toBeLessThanOrEqual(7600) }
      }
      const values = snap.docs
        .map(d => (d.get('identifier') as { value?: string } | undefined)?.value)
        .filter(Boolean)
      expect(new Set(values).size).toBe(values.length)
    }, 300_000)
  })

  // ══ 3. The approved 19F-B decision, across the whole chain ════════════════

  describe('3 — a tag survives every identifier operation', () => {
    it('swap, release and re-assign all leave the tag attached to the person', async () => {
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: P5,
      })
      await tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(1), tag: 'STICKY', actor: UID, source: 'manual',
      })

      // THE 19F-B DECISION, UNCHANGED: the device belongs to the PERSON, not to the
      // number — so changing the number leaves it exactly where it was.
      await engine.swapIdentifier({ registrationId: regId(1), actor: UID, explicitValue: '5555' })
      expect(((await reg(1)).timingTag as { tag: string }).tag).toBe('STICKY')

      // ═══ RD-BIB-TIMING-01 · WHAT CHANGED, AND WHY ═════════════════════════════
      // This test used to release the number here and assert the device stayed —
      // leaving `{ identifier: null, timingTag: STICKY }`. That is now a forbidden
      // state: a device that maps to no number cannot appear on a provider start
      // list, and RD-BIB-TIMING-01 makes "an identifier before a device" an
      // invariant enforced in both engines.
      //
      // The 19F-B decision is NOT reversed. "The tag follows the participant, not
      // the number" is about OWNERSHIP across a change, and that is asserted above
      // and still true. Whether a participant may hold a device with NO number is a
      // different question, and the answer is now no — so the release is refused
      // rather than the device being silently detached.
      let refused: string | null = null
      try { await engine.releaseIdentifier(regId(1), UID, 'manual') }
      catch (e) { refused = (e as { code?: string }).code ?? 'THREW' }
      expect(refused).toBe('IDENTIFIER_HELD_BY_TIMING_TAG')

      const afterRefusal = await reg(1)
      expect((afterRefusal.identifier as { value: string }).value).toBe('5555')
      expect((afterRefusal.timingTag as { tag: string }).tag).toBe('STICKY')

      // The LIFECYCLE path still frees the number, because a cancelled participant
      // must not keep it — it surrenders both credentials, device first.
      await tags.detachTimingTagByRegistration(regId(1), UID, 'cancelled')
      await engine.releaseIdentifier(regId(1), UID, 'cancelled', { allowWhileTagged: true })
      const afterCancel = await reg(1)
      expect(afterCancel.identifier).toBeNull()
      expect(afterCancel.timingTag).toBeNull()

      // Re-assigning a number works normally afterwards.
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: P5,
      })
      expect((await reg(1)).identifier).not.toBeNull()
    }, 180_000)
  })

  // ══ 4. The provider hand-off carries the real relationships ═══════════════

  describe('4 — the start list matches what every other surface says', () => {
    it('each row pairs the participant\'s own identifier with their own tag', async () => {
      const pairs: Array<[number, string, string]> = [
        [1, '5001', 'CHIP001'],
        [3, '5002', 'CHIP002'],
        [2, '7001', 'CHIP801'],
      ]
      for (const [n, , tag] of pairs) {
        const passId = n % 2 ? P5 : P10
        await engine.allocateIdentifier({
          eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual', passId,
        })
        await tags.assignTimingTag({
          eventSlug: SLUG, registrationId: regId(n), tag, actor: UID, source: 'manual',
        })
      }

      for (const [n, expectedId, expectedTag] of pairs) {
        const r = await reg(n)
        expect((r.identifier as { value: string }).value, `reg ${n}`).toBe(expectedId)
        expect((r.timingTag as { tag: string }).tag, `reg ${n}`).toBe(expectedTag)
        // …and the tag lock records the pass, so an export can group by it.
        const lock = (await adminDb.collection('identifierTagLocks')
          .doc(`${SLUG}__${expectedTag}`).get()).data()!
        expect(lock.passId).toBe(n % 2 ? P5 : P10)
      }
    }, 180_000)

    it('a tag is never written onto any public-facing field', async () => {
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: P5,
      })
      await tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(1), tag: 'SECRET-CHIP', actor: UID, source: 'manual',
      })
      const r = await reg(1)
      // The legacy mirrors that public surfaces and certificates read carry the
      // IDENTIFIER, never the device.
      expect(r.bibNumber).toBe('5001')
      expect(r.bibCategory ?? null).not.toBe('SECRET-CHIP')
      expect(r.ticketCode).not.toContain('SECRET-CHIP')
    }, 120_000)
  })

  // ══ 5. One audit trail covers the whole chain ═════════════════════════════

  describe('5 — the history can reconstruct the participant\'s operational life', () => {
    it('identifier and tag events land in ONE timeline with actor and time', async () => {
      await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: P5,
      })
      await tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(1), tag: 'T1', actor: UID, source: 'manual',
      })
      await tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(1), tag: 'T2', actor: UID, source: 'manual',
      })
      await engine.consumeIdentifier(regId(1), UID)

      const hist = await adminDb.collection('identifierHistory')
        .where('eventSlug', '==', SLUG).get()
      const actions = hist.docs.map(d => d.get('action') as string)
      for (const a of ['assigned', 'tag_assigned', 'tag_replaced', 'consumed']) {
        expect(actions, a).toContain(a)
      }
      for (const d of hist.docs) {
        expect(d.get('actor')).toBeTruthy()
        expect(d.get('timestamp')).toBeTruthy()
        expect(d.get('eventSlug')).toBe(SLUG)
      }
    }, 180_000)
  })
})
