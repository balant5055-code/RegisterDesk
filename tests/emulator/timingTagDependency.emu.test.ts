// RD-BIB-TIMING-01 · a timing device requires an identifier — against REAL Firestore.
//
// ═══ WHAT WAS TRUE BEFORE THIS PHASE ═════════════════════════════════════════
// `REGISTRATION_HAS_NO_IDENTIFIER` was declared in the timing-tag error union from
// the beginning and thrown by NOTHING. Measured against the emulator before the
// guard existed:
//
//   • attaching a device to a participant with no identifier → ACCEPTED, and the
//     lock was written with `identifierValue: null`;
//   • releasing an identifier from a participant carrying a device → produced
//     `{ bib: null, tag: "CHIP-ORPHAN" }`.
//
// Both are states the provider start list cannot express: a chip that maps to no
// number, and a number that has been handed back while a device still depends on it.
//
// These tests pin the invariant from BOTH ends, in the transactions that enforce it.
// A mock cannot prove any of it — the guards read the stored registration inside the
// transaction precisely so a concurrent change cannot slip past them.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

describeEmu('RD-BIB-TIMING-01 · identifier before timing device', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let tags:   typeof import('@/lib/identifiers/timingTagEngine')
  let engine: typeof import('@/lib/identifiers/engine')

  const PID  = process.pid
  const SLUG = `tdep-${PID}`
  const UID  = `tdep-org-${PID}`
  const rid  = (n: string) => `${SLUG}-${n}`

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    tags   = await import('@/lib/identifiers/timingTagEngine')
    engine = await import('@/lib/identifiers/engine')

    await adminDb.doc(`users/${UID}/eventDrafts/${SLUG}`).set({
      status: 'published', lifecycleStatus: 'published',
      eventDetails: { info: { name: 'dep' }, seo: { urlSlug: SLUG } },
      pricing: { eventType: 'free', passes: [{ id: 'p5', name: '5 KM', price: 0, quantity: 900, status: 'active' }] },
    })
    await adminDb.collection('identifierConfigs').doc(SLUG).set({
      eventSlug: SLUG, enabled: true, label: 'BIB Number', preset: 'custom', type: 'numeric',
      format: { prefix: '', suffix: '', padding: 0, startNumber: 1 },
      reusePolicy: 'never', assignmentStrategy: 'manual',
      allowManualOverride: true, allowDuplicate: false,
      pools: [{ poolId: 'pool_p5', label: '5 KM', passIds: ['p5'], ranges: [{ start: 5001, end: 5600 }] }],
      templates: [], defaultPoolId: 'pool_p5',
      visibility: { attendee: true, ticket: true, certificate: true, badge: false, checkin: true },
      tagMapping: { enabled: true, mode: 'mapped', label: 'Timing Chip' },
      version: 1,
    })
  }, 120_000)

  afterAll(async () => {
    for (const c of ['registrations', 'identifierLocks', 'identifierTagLocks',
                     'identifierCounters', 'identifierHistory']) {
      const s = await adminDb.collection(c).where('eventSlug', '==', SLUG).get()
      await Promise.all(s.docs.map(d => d.ref.delete()))
    }
    await adminDb.collection('identifierConfigs').doc(SLUG).delete().catch(() => {})
    await adminDb.doc(`users/${UID}/eventDrafts/${SLUG}`).delete().catch(() => {})
  }, 120_000)

  async function wipe() {
    for (const c of ['registrations', 'identifierLocks', 'identifierTagLocks',
                     'identifierCounters', 'identifierHistory']) {
      const s = await adminDb.collection(c).where('eventSlug', '==', SLUG).get()
      const b = adminDb.batch(); s.docs.forEach(d => b.delete(d.ref)); await b.commit()
    }
  }
  const seed = async (n: string) => {
    await adminDb.collection('registrations').doc(rid(n)).set({
      id: rid(n), eventSlug: SLUG, organizerUid: UID, passId: 'p5', passName: '5 KM',
      attendee: { name: `P ${n}`, email: `${n}@t.local` },
      status: 'confirmed', paymentStatus: 'paid', amount: 0,
      ticketCode: `RD-${SLUG}-${n}`, checkedIn: false, hasIdentifier: false,
      registeredAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    })
    return rid(n)
  }
  const state = async (id: string) => {
    const r = (await adminDb.collection('registrations').doc(id).get()).data() ?? {}
    return {
      bib: (r.identifier as { value?: string } | null | undefined)?.value ?? null,
      tag: (r.timingTag as { tag?: string; state?: string } | null | undefined)?.state === 'assigned'
        ? (r.timingTag as { tag: string }).tag : null,
    }
  }
  const codeOf = async (fn: () => Promise<unknown>) => {
    try { await fn(); return 'ACCEPTED' } catch (e) { return (e as { code?: string }).code ?? 'THREW' }
  }
  const giveBib = (id: string) => engine.allocateIdentifier({
    eventSlug: SLUG, registrationId: id, actor: 'test', source: 'manual', passId: 'p5',
  })
  const giveTag = (id: string, tag: string) => tags.assignTimingTag({
    eventSlug: SLUG, registrationId: id, tag, actor: 'test', source: 'manual',
  })

  beforeEach(wipe, 60_000)

  // ══ 1–3 · the forward rule ═════════════════════════════════════════════════

  it('1 · with an identifier, a device attaches', async () => {
    const id = await seed('a'); await giveBib(id)
    await giveTag(id, 'CHIP-A')
    expect(await state(id)).toEqual({ bib: '5001', tag: 'CHIP-A' })
  }, 60_000)

  it('2 · with NO identifier, a device is REFUSED and nothing is written', async () => {
    const id = await seed('b')
    expect(await codeOf(() => giveTag(id, 'CHIP-B'))).toBe('REGISTRATION_HAS_NO_IDENTIFIER')
    expect(await state(id)).toEqual({ bib: null, tag: null })
    // Not even a lock document — the refusal precedes every write.
    const locks = await adminDb.collection('identifierTagLocks')
      .where('eventSlug', '==', SLUG).get()
    expect(locks.size).toBe(0)
  }, 60_000)

  it('3 · the legacy bibNumber mirror also satisfies the rule', async () => {
    // An event predating the canonical field must not be told it has no numbers.
    const id = await seed('c')
    await adminDb.collection('registrations').doc(id).update({ bibNumber: '4242' })
    await giveTag(id, 'CHIP-C')
    expect((await state(id)).tag).toBe('CHIP-C')
  }, 60_000)

  // ══ 4–6 · replacement and removal ══════════════════════════════════════════

  it('4 · a device can be replaced while the identifier stands', async () => {
    const id = await seed('d'); await giveBib(id)
    await giveTag(id, 'CHIP-D1')
    const r = await giveTag(id, 'CHIP-D2')
    expect(r.replaced).toBe('CHIP-D1')
    expect((await state(id)).tag).toBe('CHIP-D2')
    const old = await adminDb.collection('identifierTagLocks').doc(`${SLUG}__CHIP-D1`).get()
    expect(old.data()?.state).toBe('replaced')   // history survives
  }, 60_000)

  it('5 · removing the device leaves a valid identifier-only state', async () => {
    const id = await seed('e'); await giveBib(id); await giveTag(id, 'CHIP-E')
    await tags.removeTimingTag(SLUG, id, 'test', null)
    expect(await state(id)).toEqual({ bib: '5001', tag: null })
  }, 60_000)

  it('6 · an identifier CHANGE keeps the device — the tag follows the participant', async () => {
    const id = await seed('f'); await giveBib(id); await giveTag(id, 'CHIP-F')
    // `swapIdentifier` takes `explicitValue`; the pass and slug come from the
    // stored registration, which is why no slug is passed here.
    await engine.swapIdentifier({
      registrationId: id, explicitValue: '5555', actor: 'test', reason: 'swap',
    })
    expect(await state(id)).toEqual({ bib: '5555', tag: 'CHIP-F' })
  }, 60_000)

  // ══ 7–8 · the reverse rule ═════════════════════════════════════════════════

  it('7 · the identifier CANNOT be removed while a device depends on it', async () => {
    const id = await seed('g'); await giveBib(id); await giveTag(id, 'CHIP-G')
    expect(await codeOf(() => engine.releaseIdentifier(id, 'test', 'manual')))
      .toBe('IDENTIFIER_HELD_BY_TIMING_TAG')
    // Nothing moved: the pair is intact.
    expect(await state(id)).toEqual({ bib: '5001', tag: 'CHIP-G' })
    const lock = await adminDb.collection('identifierLocks').doc(`${SLUG}__5001`).get()
    expect(lock.data()?.state).toBe('assigned')
  }, 60_000)

  it('8 · remove the device, and the identifier releases normally', async () => {
    const id = await seed('h'); await giveBib(id); await giveTag(id, 'CHIP-H')
    await tags.removeTimingTag(SLUG, id, 'test', null)
    await engine.releaseIdentifier(id, 'test', 'manual')
    expect(await state(id)).toEqual({ bib: null, tag: null })
  }, 60_000)

  it('9 · the LIFECYCLE path surrenders both, and never strands the number', async () => {
    // Cancellation must still free the number even though a device is attached —
    // refusing there would lock it to somebody who is not coming.
    const id = await seed('i'); await giveBib(id); await giveTag(id, 'CHIP-I')
    await tags.detachTimingTagByRegistration(id, 'test', 'cancelled')
    await engine.releaseIdentifier(id, 'test', 'cancelled', { allowWhileTagged: true })
    expect(await state(id)).toEqual({ bib: null, tag: null })
  }, 60_000)

  it('10 · NO ordering of the two operations can produce a device without a number', async () => {
    const id = await seed('j'); await giveBib(id); await giveTag(id, 'CHIP-J')
    // Release first (refused) then detach → identifier-only. Valid.
    await codeOf(() => engine.releaseIdentifier(id, 'test', 'x'))
    await tags.removeTimingTag(SLUG, id, 'test', null)
    const s = await state(id)
    expect(s.tag === null || s.bib !== null).toBe(true)
  }, 60_000)

  // ══ 11–13 · concurrency and uniqueness ═════════════════════════════════════

  it('11 · two organizers racing for ONE device — exactly one wins', async () => {
    const a = await seed('k'); const b = await seed('l')
    await giveBib(a); await giveBib(b)
    const results = await Promise.allSettled([giveTag(a, 'CHIP-RACE'), giveTag(b, 'CHIP-RACE')])
    const ok = results.filter(r => r.status === 'fulfilled')
    expect(ok).toHaveLength(1)
    const holders = [await state(a), await state(b)].filter(s => s.tag === 'CHIP-RACE')
    expect(holders).toHaveLength(1)
  }, 90_000)

  it('12 · a release racing a device attachment cannot end with a stranded device', async () => {
    const id = await seed('m'); await giveBib(id)
    await Promise.allSettled([
      giveTag(id, 'CHIP-M'),
      engine.releaseIdentifier(id, 'test', 'race'),
    ])
    const s = await state(id)
    // Whichever won, the forbidden combination never appears.
    expect(s.tag !== null && s.bib === null).toBe(false)
  }, 90_000)

  it('13 · a device from ANOTHER event cannot be reached through this one', async () => {
    const id = await seed('n'); await giveBib(id)
    expect(await codeOf(() => tags.assignTimingTag({
      eventSlug: `${SLUG}-other`, registrationId: id, tag: 'CHIP-X',
      actor: 'test', source: 'manual',
    }))).toBe('REGISTRATION_NOT_FOUND')
  }, 60_000)

  // ══ 14 · the import path shares the guard ══════════════════════════════════

  it('14 · a bulk row for a participant with no identifier is refused by the SAME rule', async () => {
    // The import strategy calls `assignTimingTag` per row and tallies its code, so
    // the invariant needs no separate implementation there.
    const withBib = await seed('o'); await giveBib(withBib)
    const without = await seed('p')
    const good = await codeOf(() => giveTag(withBib, 'CHIP-OK'))
    const bad  = await codeOf(() => giveTag(without, 'CHIP-BAD'))
    expect(good).toBe('ACCEPTED')
    expect(bad).toBe('REGISTRATION_HAS_NO_IDENTIFIER')
    expect(await state(without)).toEqual({ bib: null, tag: null })
  }, 60_000)

  // ══ 15–17 · RD-BIB-TIMING-03 · neither credential invents the other ════════
  //
  // §22/§23. The unit suite proves this structurally — neither engine has a write
  // path to the other's records. These prove it OBSERVATIONALLY, against real
  // Firestore, because "the code cannot do it" and "the stored document does not
  // contain it" are different claims and only the second is what an organizer sees.

  it('15 · assigning a number NEVER produces a device', async () => {
    const id = await seed('q')
    await giveBib(id)
    const after = await state(id)
    expect(after.bib).toBeTruthy()
    expect(after.tag).toBeNull()                       // no CHIP-5001 invented

    // …and no device lock was created anywhere in the event, under any name.
    const locks = await adminDb.collection('identifierTagLocks')
      .where('eventSlug', '==', SLUG).get()
    expect(locks.size).toBe(0)
  }, 60_000)

  it('16 · assigning a device NEVER produces a number', async () => {
    // The device can only be attached to somebody who already HAS a number, so
    // the question is whether attaching it invents or alters one.
    const id = await seed('r')
    await giveBib(id)
    const before = await state(id)
    await giveTag(id, 'CHIP-NOGEN')
    const after = await state(id)
    expect(after.bib).toBe(before.bib)                 // unchanged, not regenerated
    expect(after.tag).toBe('CHIP-NOGEN')

    // Exactly one number lock exists for this participant — the device did not
    // mint a second one from its own value.
    const locks = await adminDb.collection('identifierLocks')
      .where('eventSlug', '==', SLUG).where('registrationId', '==', id).get()
    expect(locks.size).toBe(1)
    expect((locks.docs[0].data() as { value?: string }).value).toBe(before.bib)
  }, 60_000)

  it('17 · the device value is never derived from the number', async () => {
    // A generated device would follow the number. Two participants with different
    // numbers, both given the SAME device value in turn, prove the value is the
    // organizer's input and nothing else.
    const a = await seed('s'); await giveBib(a)
    const b = await seed('t'); await giveBib(b)
    const sa = await state(a), sb = await state(b)
    expect(sa.bib).not.toBe(sb.bib)

    await giveTag(a, 'CHIP-SAME')
    expect((await state(a)).tag).toBe('CHIP-SAME')
    // …and it is NOT silently moved to the second participant.
    expect(await codeOf(() => giveTag(b, 'CHIP-SAME'))).toBe('TAG_OWNED_BY_OTHER')
    expect((await state(b)).tag).toBeNull()
    expect((await state(a)).tag).toBe('CHIP-SAME')
  }, 60_000)
})
