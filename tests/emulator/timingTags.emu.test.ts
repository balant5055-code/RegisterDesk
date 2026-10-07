// RD-EVENT-19F-B · timing tags against REAL Firestore (emulator).
//
// The properties that only a real datastore can demonstrate:
//   • one device cannot be attached to two participants in one event;
//   • the SAME device is reusable in a DIFFERENT event;
//   • re-attaching a tag somebody already has writes nothing;
//   • replacement preserves the old lock and its history;
//   • changing a participant's IDENTIFIER leaves their tag attached;
//   • a cross-event registration id cannot be reached;
//   • an import run is idempotent, resumable and reports what it did.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

describeEmu('RD-EVENT-19F-B · timing tags', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let tags: typeof import('@/lib/identifiers/timingTagEngine')
  let job: typeof import('@/lib/identifiers/timingTagImportJob')
  let engine: typeof import('@/lib/identifiers/engine')
  let config: typeof import('@/lib/identifiers/config')

  const PID   = process.pid
  const SLUG  = `id19f-${PID}`
  const SLUG2 = `id19f-other-${PID}`
  const EVENT = `id19f-event-${PID}`
  const UID   = `id19f-org-${PID}`
  const PASS  = 'pass-alpha'

  const regId = (n: number, slug = SLUG) => `${slug}-reg-${String(n).padStart(4, '0')}`

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    tags   = await import('@/lib/identifiers/timingTagEngine')
    job    = await import('@/lib/identifiers/timingTagImportJob')
    engine = await import('@/lib/identifiers/engine')
    config = await import('@/lib/identifiers/config')
  })

  async function wipe() {
    for (const slug of [SLUG, SLUG2]) {
      for (const col of ['identifierTagLocks', 'identifierLocks', 'identifierCounters',
                         'identifierHistory', 'registrations', 'timingTagImportJobs']) {
        const snap = await adminDb.collection(col).where('eventSlug', '==', slug).get()
        const b = adminDb.batch(); snap.docs.forEach(d => b.delete(d.ref)); await b.commit()
      }
      await adminDb.collection('identifierConfigs').doc(slug).delete()
    }
    await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).delete()
  }

  async function seedEvent(lifecycleStatus = 'published') {
    await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).set({
      lifecycleStatus,
      eventDetails: { info: { name: 'Tag QA' }, seo: { urlSlug: SLUG } },
      pricing: { eventType: 'free', passes: [{ id: PASS, name: 'Alpha', price: 0, status: 'active' }] },
      updatedAt: new Date(),
    })
  }

  async function seedConfig(slug = SLUG, tagMapping: unknown = { enabled: true, mode: 'mapped', label: 'Timing Tag' }) {
    await adminDb.collection('identifierConfigs').doc(slug).set({
      ...config.defaultIdentifierConfig(slug),
      type: 'numeric', format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
      pools: [{ poolId: 'pa', label: 'A', passIds: [PASS], ranges: [{ start: 5001, end: 5999 }] }],
      defaultPoolId: 'pa', tagMapping, eventSlug: slug,
    })
  }

  /**
   * RD-BIB-TIMING-01 · every seeded participant now carries an IDENTIFIER.
   *
   * A timing device requires one — that is the new product invariant, enforced
   * inside `assignTimingTag`'s transaction. These tests are about device mechanics
   * (uniqueness, replacement, idempotency, import), and each of them presupposes a
   * participant who could legitimately be given a device in the first place. Their
   * subjects are unchanged; only the precondition is now stated.
   *
   * `identifierless` seeds the OTHER case on purpose, for the test that pins the
   * refusal.
   */
  async function seedRegs(
    count: number, slug = SLUG, status = 'confirmed', from = 1,
    opts: { identifierless?: boolean } = {},
  ) {
    const b = adminDb.batch()
    for (let i = from; i < from + count; i++) {
      const value = String(5000 + i)
      b.set(adminDb.collection('registrations').doc(regId(i, slug)), {
        eventSlug: slug, organizerUid: UID, passId: PASS, passName: 'Alpha',
        attendee: { name: `P${i}`, email: `p${i}@test.local` },
        status, paymentStatus: 'paid', amount: 0, ticketCode: `RD-${PID}-${slug}-${i}`, createdAt: new Date(),
        ...(opts.identifierless ? {} : {
          hasIdentifier: true, bibNumber: value,
          identifier: {
            value, label: 'Identifier', type: 'numeric', poolId: 'pa', templateId: null,
            category: null, state: 'assigned', source: 'manual',
            assignedAt: new Date(), assignedBy: UID, everCheckedIn: false,
          },
        }),
      })
    }
    await b.commit()
  }

  const tagOf = async (n: number, slug = SLUG) =>
    (await adminDb.collection('registrations').doc(regId(n, slug)).get())
      .get('timingTag')?.tag as string | undefined

  const lockOf = async (tag: string, slug = SLUG) =>
    (await adminDb.collection('identifierTagLocks').doc(`${slug}__${tag.toUpperCase()}`).get()).data()

  beforeEach(wipe)
  afterAll(wipe)

  // ══ 1. Uniqueness ═══════════════════════════════════════════════════════

  describe('1 — one device, one participant, per event', () => {
    beforeEach(async () => { await seedEvent(); await seedConfig(); await seedRegs(3) })

    it('attaches a tag and mirrors it on the registration', async () => {
      const r = await tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(1), tag: 'TAG-A83F92', actor: UID, source: 'manual',
      })
      expect(r).toMatchObject({ tag: 'TAG-A83F92', unchanged: false, replaced: null })
      expect(await tagOf(1)).toBe('TAG-A83F92')
      expect(await lockOf('TAG-A83F92')).toMatchObject({
        state: 'assigned', registrationId: regId(1), eventSlug: SLUG,
      })
    }, 60_000)

    it('RD-BIB-TIMING-01 · a participant with NO identifier is refused, and nothing is written', async () => {
      // The other half of the precondition the seed above now supplies. Verified
      // against the emulator before the guard existed: this was ACCEPTED, and the
      // lock was written with `identifierValue: null`.
      await seedRegs(1, SLUG, 'confirmed', 90, { identifierless: true })
      let code: string | null = null
      try {
        await tags.assignTimingTag({
          eventSlug: SLUG, registrationId: regId(90), tag: 'CHIP-NOBIB', actor: UID, source: 'manual',
        })
      } catch (e) { code = (e as { code?: string }).code ?? 'THREW' }
      expect(code).toBe('REGISTRATION_HAS_NO_IDENTIFIER')
      expect(await tagOf(90)).toBeUndefined()
      expect(await lockOf('CHIP-NOBIB')).toBeUndefined()
    }, 60_000)

    it('THE RULE · a second participant cannot take the same device', async () => {
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'CHIP001', actor: UID, source: 'manual' })
      await expect(tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(2), tag: 'CHIP001', actor: UID, source: 'manual',
      })).rejects.toMatchObject({ code: 'TAG_OWNED_BY_OTHER' })
      expect(await tagOf(2)).toBeUndefined()
    }, 60_000)

    it('case and whitespace cannot smuggle a duplicate past it', async () => {
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'chip-9', actor: UID, source: 'manual' })
      await expect(tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(2), tag: '  CHIP-9  ', actor: UID, source: 'manual',
      })).rejects.toMatchObject({ code: 'TAG_OWNED_BY_OTHER' })
    }, 60_000)

    it('two writers racing for one device: never both', async () => {
      const results = await Promise.allSettled([
        tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'RACE1', actor: UID, source: 'manual' }),
        tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(2), tag: 'RACE1', actor: UID, source: 'manual' }),
      ])
      expect(results.filter(r => r.status === 'fulfilled').length).toBeLessThanOrEqual(1)
      const holders = await adminDb.collection('registrations')
        .where('eventSlug', '==', SLUG).where('timingTag.normalizedTag', '==', 'RACE1').get()
      expect(holders.size).toBeLessThanOrEqual(1)
    }, 60_000)

    it('the SAME device is reusable in a DIFFERENT event', async () => {
      await seedConfig(SLUG2)
      await seedRegs(1, SLUG2)
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'REUSE1', actor: UID, source: 'manual' })
      await expect(tags.assignTimingTag({
        eventSlug: SLUG2, registrationId: regId(1, SLUG2), tag: 'REUSE1', actor: UID, source: 'manual',
      })).resolves.toMatchObject({ unchanged: false })
      expect(await tagOf(1)).toBe('REUSE1')
      expect(await tagOf(1, SLUG2)).toBe('REUSE1')
    }, 60_000)

    it('a cancelled registration is refused', async () => {
      await seedRegs(1, SLUG, 'cancelled', 90)
      await expect(tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(90), tag: 'X1', actor: UID, source: 'manual',
      })).rejects.toMatchObject({ code: 'REGISTRATION_TERMINAL' })
    }, 60_000)

    it('a registration from ANOTHER event cannot be reached even with its id', async () => {
      await seedRegs(1, SLUG2)
      await expect(tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(1, SLUG2), tag: 'X2', actor: UID, source: 'manual',
      })).rejects.toMatchObject({ code: 'REGISTRATION_NOT_FOUND' })
    }, 60_000)
  })

  // ══ 2. Idempotency + replacement ════════════════════════════════════════

  describe('2 — repeats are free, replacements are recorded', () => {
    beforeEach(async () => { await seedEvent(); await seedConfig(); await seedRegs(2) })

    it('re-attaching the same device writes NOTHING', async () => {
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'SAME1', actor: UID, source: 'manual' })
      const before = (await adminDb.collection('identifierHistory').where('eventSlug', '==', SLUG).get()).size

      const again = await tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(1), tag: 'same1', actor: UID, source: 'manual',
      })
      expect(again.unchanged).toBe(true)
      const after = (await adminDb.collection('identifierHistory').where('eventSlug', '==', SLUG).get()).size
      expect(after).toBe(before)
    }, 60_000)

    it('replacement keeps the OLD lock and records what replaced it', async () => {
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'TAG001', actor: UID, source: 'manual' })
      const r = await tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(1), tag: 'TAG999', actor: UID, source: 'manual', reason: 'damaged',
      })
      expect(r.replaced).toBe('TAG001')
      expect(await tagOf(1)).toBe('TAG999')
      expect(await lockOf('TAG001')).toMatchObject({ state: 'replaced', replacedBy: 'TAG999' })
      expect(await lockOf('TAG999')).toMatchObject({ state: 'assigned', registrationId: regId(1) })

      const hist = await adminDb.collection('identifierHistory').where('eventSlug', '==', SLUG).get()
      const actions = hist.docs.map(d => d.get('action'))
      expect(actions).toContain('tag_replaced')
      expect(actions.filter(a => a === 'tag_assigned').length).toBe(2)
    }, 60_000)

    it('a replaced device becomes attachable again', async () => {
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'T1', actor: UID, source: 'manual' })
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'T2', actor: UID, source: 'manual' })
      await expect(tags.assignTimingTag({
        eventSlug: SLUG, registrationId: regId(2), tag: 'T1', actor: UID, source: 'manual',
      })).resolves.toMatchObject({ unchanged: false })
    }, 60_000)

    it('removal detaches, keeps the lock for provenance, and is idempotent', async () => {
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'R1', actor: UID, source: 'manual' })
      expect((await tags.removeTimingTag(SLUG, regId(1), UID)).removed).toBe('R1')
      expect(await tagOf(1)).toBeUndefined()
      expect(await lockOf('R1')).toMatchObject({ state: 'removed' })
      // Again → a no-op, not an error.
      expect((await tags.removeTimingTag(SLUG, regId(1), UID)).removed).toBeNull()
    }, 60_000)
  })

  // ══ 3. THE LOCKED DECISION — tags follow the participant ════════════════

  describe('3 — changing an identifier does NOT detach the tag', () => {
    it('the participant keeps their device across an identifier swap', async () => {
      await seedEvent(); await seedConfig(); await seedRegs(1)

      const first = await engine.allocateIdentifier({
        eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS,
      })
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'STICKY', actor: UID, source: 'manual' })
      expect(await lockOf('STICKY')).toMatchObject({ identifierValue: first.value })

      // Move them onto a completely different identifier.
      //
      // RD-BIB-01 · the value was '7777', which this pass's configured range
      // (5001–5999) does not contain — the engine now refuses that, and rightly. The
      // point of this test is that the TAG survives an identifier change, so the new
      // value is simply a different one from inside the pass's own block.
      const second = await engine.swapIdentifier({
        registrationId: regId(1), actor: UID, explicitValue: '5888',
      })
      expect(second.value).toBe('5888')
      expect(second.value).not.toBe(first.value)

      // THE DECISION: the tag is still attached to the person.
      expect(await tagOf(1)).toBe('STICKY')
      expect(await lockOf('STICKY')).toMatchObject({ state: 'assigned', registrationId: regId(1) })
    }, 60_000)

    it('the recorded identifier is provenance, and going stale does not break anything', async () => {
      await seedEvent(); await seedConfig(); await seedRegs(1)
      await engine.allocateIdentifier({ eventSlug: SLUG, registrationId: regId(1), actor: UID, source: 'manual', passId: PASS })
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'PROV', actor: UID, source: 'manual' })
      // RD-BIB-01 · was '8888', which is outside this pass's configured 5001–5999 and
      // is now refused. The test is about the tag lock keeping the identifier it was
      // created with, so any different in-range value serves.
      await engine.swapIdentifier({ registrationId: regId(1), actor: UID, explicitValue: '5888' })

      const lock = await lockOf('PROV')
      expect(lock!.identifierValue).toBe('5001')     // historical, deliberately
      expect(lock!.registrationId).toBe(regId(1))    // the owner, still correct
      // Removing still works, keyed by the participant rather than the identifier.
      expect((await tags.removeTimingTag(SLUG, regId(1), UID)).removed).toBe('PROV')
    }, 60_000)
  })

  // ══ 4. Import job ═══════════════════════════════════════════════════════

  describe('4 — the import run', () => {
    const runToEnd = async (jobId: string) => {
      for (let i = 0; i < 40; i++) {
        const r = await job.processTimingTagImportChunk(jobId)
        if (r.done) return r
      }
      throw new Error('did not finish')
    }
    const makeJob = (rows: Array<{ registrationId: string; tag: string; rowNumber: number }>) =>
      job.createTimingTagImportJob({
        eventId: EVENT, eventSlug: SLUG, organizerUid: UID, createdBy: UID,
        label: 'Timing Tag', rows,
      })

    beforeEach(async () => { await seedEvent(); await seedConfig(); await seedRegs(5) })

    it('maps every row and reports what it did', async () => {
      const j = await makeJob([1, 2, 3].map(n => ({ registrationId: regId(n), tag: `C${n}`, rowNumber: n })))
      const r = await runToEnd(j.jobId)
      expect(r.status).toBe('completed')

      const after = await job.getTimingTagImportJob(j.jobId)
      expect(after!.counts.succeeded).toBe(3)
      expect(after!.reasons.MAPPED).toBe(3)
      expect(await tagOf(1)).toBe('C1')
      expect(await tagOf(3)).toBe('C3')
    }, 120_000)

    it('IDEMPOTENT · running the same file again changes nothing', async () => {
      const rows = [1, 2].map(n => ({ registrationId: regId(n), tag: `D${n}`, rowNumber: n }))
      await runToEnd((await makeJob(rows)).jobId)
      const histBefore = (await adminDb.collection('identifierHistory').where('eventSlug', '==', SLUG).get()).size

      const second = await makeJob(rows)
      await runToEnd(second.jobId)
      const after = await job.getTimingTagImportJob(second.jobId)
      expect(after!.counts.succeeded).toBe(0)
      expect(after!.counts.skipped).toBe(2)
      expect(after!.reasons.UNCHANGED).toBe(2)

      const histAfter = (await adminDb.collection('identifierHistory').where('eventSlug', '==', SLUG).get()).size
      expect(histAfter).toBe(histBefore)
    }, 180_000)

    it('a row whose tag belongs to somebody else FAILS and is counted', async () => {
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'TAKEN', actor: UID, source: 'manual' })
      const j = await makeJob([{ registrationId: regId(2), tag: 'TAKEN', rowNumber: 1 }])
      await runToEnd(j.jobId)
      const after = await job.getTimingTagImportJob(j.jobId)
      expect(after!.counts.failed).toBe(1)
      expect(after!.reasons.TAG_OWNED_BY_OTHER).toBe(1)
      expect(await tagOf(2)).toBeUndefined()
    }, 120_000)

    it('an import REPLACES an existing tag, and says how many', async () => {
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'OLD1', actor: UID, source: 'manual' })
      const j = await makeJob([{ registrationId: regId(1), tag: 'NEW1', rowNumber: 1 }])
      await runToEnd(j.jobId)
      const after = await job.getTimingTagImportJob(j.jobId)
      expect(after!.reasons.REPLACED).toBe(1)
      expect(await tagOf(1)).toBe('NEW1')
      expect(await lockOf('OLD1')).toMatchObject({ state: 'replaced', replacedBy: 'NEW1' })
    }, 120_000)

    it('an event locked mid-import stops the run', async () => {
      const j = await makeJob([1, 2].map(n => ({ registrationId: regId(n), tag: `L${n}`, rowNumber: n })))
      await adminDb.doc(`users/${UID}/eventDrafts/${EVENT}`).update({ lifecycleStatus: 'archived' })
      const r = await job.processTimingTagImportChunk(j.jobId)
      expect(r.status).toBe('failed')
      expect(await tagOf(1)).toBeUndefined()
    }, 120_000)

    it('turning the capability off mid-import stops the run', async () => {
      const j = await makeJob([{ registrationId: regId(1), tag: 'OFF1', rowNumber: 1 }])
      await seedConfig(SLUG, { enabled: false, mode: 'mapped', label: 'Timing Tag' })
      const r = await job.processTimingTagImportChunk(j.jobId)
      expect(r.status).toBe('failed')
      expect(await tagOf(1)).toBeUndefined()
    }, 120_000)

    it('a large file is processed exactly once per row', async () => {
      await seedRegs(150, SLUG, 'confirmed', 1000)
      const rows = Array.from({ length: 150 }, (_, i) => ({
        registrationId: regId(1000 + i), tag: `BULK-${i}`, rowNumber: i + 1,
      }))
      const j = await makeJob(rows)
      await runToEnd(j.jobId)
      const after = await job.getTimingTagImportJob(j.jobId)
      expect(after!.counts.processed).toBe(150)
      expect(after!.counts.succeeded).toBe(150)

      const locks = await adminDb.collection('identifierTagLocks')
        .where('eventSlug', '==', SLUG).where('state', '==', 'assigned').get()
      expect(locks.size).toBe(150)
    }, 240_000)
  })

  // ══ 5. Counting ═════════════════════════════════════════════════════════

  // ══ RD-BIB-TIMING-04 · per-pass figures reconcile with the event ═══════════
  //
  // The Timing Chips workspace shows a per-pass breakdown beside event-wide
  // totals. Those used to be derived from the bounded list the browser had
  // loaded, so on a large event they described the first page and read like the
  // whole pass. They are aggregates now — and aggregates are only trustworthy if
  // they ADD UP, which is what this proves against real Firestore.
  //
  // Both use the query shapes the route uses: equality-only filters, which
  // Firestore serves by merging single-field indexes.
  describe('5b — pass totals sum to the event totals', () => {
    const PASS_B = 'pass-beta'

    /** Seeds `count` registrations on a given pass, some with a device. */
    async function seedPass(pass: string, count: number, withTag: number, from: number) {
      const b = adminDb.batch()
      for (let i = from; i < from + count; i++) {
        const value = String(5000 + i)
        const tagged = i - from < withTag
        b.set(adminDb.collection('registrations').doc(regId(i)), {
          eventSlug: SLUG, organizerUid: UID, passId: pass, passName: pass,
          attendee: { name: `P${i}`, email: `p${i}@test.local` },
          status: 'confirmed', paymentStatus: 'paid', amount: 0,
          ticketCode: `RD-${PID}-${SLUG}-${i}`, createdAt: new Date(),
          hasIdentifier: true, bibNumber: value,
          identifier: { value, state: 'assigned', assignedAt: new Date() },
          ...(tagged
            ? { timingTag: { tag: `T${i}`, normalizedTag: `T${i}`, state: 'assigned', assignedAt: new Date() } }
            : {}),
        })
      }
      await b.commit()
    }

    it('every pass figure sums to the event-wide figure', async () => {
      await seedEvent(); await seedConfig()
      await seedPass(PASS,   7, 3, 100)   // 7 participants, 3 devices
      await seedPass(PASS_B, 5, 2, 200)   // 5 participants, 2 devices

      const base = adminDb.collection('registrations')
        .where('organizerUid', '==', UID)
        .where('eventSlug', '==', SLUG)
        .where('status', '==', 'confirmed')
      const countOf = (q: FirebaseFirestore.Query) => q.count().get().then(s => s.data().count as number)

      const [eventTotal, eventWithId, eventWithTag] = await Promise.all([
        countOf(base),
        countOf(base.where('hasIdentifier', '==', true)),
        countOf(base.where('timingTag.state', '==', 'assigned')),
      ])

      const perPass = await Promise.all([PASS, PASS_B].map(async pass => {
        const q = base.where('passId', '==', pass)
        const [total, withId, withTag] = await Promise.all([
          countOf(q),
          countOf(q.where('hasIdentifier', '==', true)),
          countOf(q.where('timingTag.state', '==', 'assigned')),
        ])
        return { pass, total, withId, withTag }
      }))

      expect(perPass.map(p => p.total)).toEqual([7, 5])
      expect(perPass.map(p => p.withTag)).toEqual([3, 2])

      // The reconciliation §18 asks for.
      const sum = (k: 'total' | 'withId' | 'withTag') => perPass.reduce((n, p) => n + p[k], 0)
      expect(sum('total')).toBe(eventTotal)
      expect(sum('withId')).toBe(eventWithId)
      expect(sum('withTag')).toBe(eventWithTag)
    }, 120_000)

    it('a participant on NO pass is not silently folded into one', async () => {
      await seedEvent(); await seedConfig()
      await seedPass(PASS, 4, 1, 300)
      // One registration with no passId at all — the case §18 calls out.
      await adminDb.collection('registrations').doc(regId(400)).set({
        eventSlug: SLUG, organizerUid: UID, passName: '',
        attendee: { name: 'No Pass', email: 'nopass@test.local' },
        status: 'confirmed', paymentStatus: 'paid', amount: 0,
        ticketCode: `RD-${PID}-${SLUG}-400`, createdAt: new Date(),
        hasIdentifier: false,
      })

      const base = adminDb.collection('registrations')
        .where('organizerUid', '==', UID)
        .where('eventSlug', '==', SLUG)
        .where('status', '==', 'confirmed')
      const countOf = (q: FirebaseFirestore.Query) => q.count().get().then(s => s.data().count as number)

      const eventTotal = await countOf(base)
      const passTotal  = await countOf(base.where('passId', '==', PASS))

      // The event has one MORE participant than every pass accounts for, and the
      // pass total is not inflated to hide it. Reporting the gap is the product
      // decision; corrupting a pass total to make the sum look tidy is not.
      expect(eventTotal).toBe(5)
      expect(passTotal).toBe(4)
      expect(eventTotal - passTotal).toBe(1)
    }, 120_000)
  })

  describe('5 — counts are aggregates and never invented', () => {
    it('counts only ACTIVE tags', async () => {
      await seedEvent(); await seedConfig(); await seedRegs(3)
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'A1', actor: UID, source: 'manual' })
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(2), tag: 'A2', actor: UID, source: 'manual' })
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(2), tag: 'A3', actor: UID, source: 'manual' })  // replaces A2
      await tags.removeTimingTag(SLUG, regId(1), UID)                                                                     // removes A1

      expect(await tags.countAssignedTags(SLUG)).toBe(1)
    }, 120_000)

    it('an event with no tags counts a real ZERO', async () => {
      await seedEvent(); await seedConfig()
      expect(await tags.countAssignedTags(SLUG)).toBe(0)
    }, 60_000)

    it('lookup finds a tag, and reports null for one that was never used', async () => {
      await seedEvent(); await seedConfig(); await seedRegs(1)
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'FIND1', actor: UID, source: 'manual' })
      expect((await tags.lookupTimingTag(SLUG, 'find1'))!.registrationId).toBe(regId(1))
      expect(await tags.lookupTimingTag(SLUG, 'NOPE')).toBeNull()
    }, 60_000)

    // RD-BIB-TIMING-02 · the availability check behind the assignment panel reads
    // this lock and calls the device FREE unless `state === 'assigned'`. A lock
    // survives removal — so if that rule were "the lock exists", every device ever
    // returned at a help desk would look permanently taken and could not be reissued.
    it('a REMOVED tag keeps its lock but stops being taken', async () => {
      await seedEvent(); await seedConfig(); await seedRegs(2)
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(1), tag: 'REUSE1', actor: UID, source: 'manual' })
      await tags.removeTimingTag(SLUG, regId(1), UID)

      const lock = await tags.lookupTimingTag(SLUG, 'REUSE1')
      expect(lock).not.toBeNull()                 // the audit record survives…
      expect(lock!.state).not.toBe('assigned')    // …but the device is free again

      // And it really can be issued to somebody else.
      await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(2), tag: 'REUSE1', actor: UID, source: 'manual' })
      const after = await tags.lookupTimingTag(SLUG, 'REUSE1')
      expect(after!.state).toBe('assigned')
      expect(after!.registrationId).toBe(regId(2))
    }, 90_000)
  })

  // ══ 6. The identifier system is untouched ═══════════════════════════════

  describe('6 — 19A–19E still behave exactly as before', () => {
    it('identifier allocation is unaffected by the presence of tags', async () => {
      await seedEvent(); await seedConfig(); await seedRegs(3)
      for (let n = 1; n <= 3; n++) {
        await engine.allocateIdentifier({
          eventSlug: SLUG, registrationId: regId(n), actor: UID, source: 'manual', passId: PASS,
        })
        await tags.assignTimingTag({ eventSlug: SLUG, registrationId: regId(n), tag: `Z${n}`, actor: UID, source: 'manual' })
      }
      const locks = await adminDb.collection('identifierLocks')
        .where('eventSlug', '==', SLUG).where('state', '==', 'assigned').get()
      expect(locks.size).toBe(3)
      // …and check-in still consumes the IDENTIFIER, not the tag.
      await engine.consumeIdentifier(regId(1), UID)
      const doc = await adminDb.collection('registrations').doc(regId(1)).get()
      expect(doc.get('identifier').state).toBe('consumed')
      expect(doc.get('timingTag').tag).toBe('Z1')      // untouched by check-in
    }, 120_000)
  })
})
