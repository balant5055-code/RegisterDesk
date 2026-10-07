// RD-ANALYTICS-10 · operational capability resolution, against REAL Firestore (emulator).
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// The analytics panel table gated timing on `eventTypes: ['sports']`. That is an inference
// from a taxonomy string, and it is wrong in both directions: a sports event whose organizer
// never switched timing on was offered a timing panel, and any other event that DID switch
// it on could never see one. Timing chips are a per-event switch stored in
// `identifierConfigs/{slug}.tagMapping.enabled`.
//
// ═══ WHY THIS NEEDS A REAL DATABASE ══════════════════════════════════════════
// The unit suite can assert the SHAPE of the rule against a fixture. Only a real document
// can establish that an event which has never been configured resolves to "off" with no
// migration, that a partially-written legacy document does not throw, and that the label an
// organizer typed reaches the analytics payload verbatim.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID = process.pid
const NEVER_CONFIGURED = `an10-none-${PID}`
const IDS_ONLY         = `an10-ids-${PID}`
const IDS_AND_TIMING   = `an10-both-${PID}`
const TIMING_ONLY      = `an10-timing-${PID}`
const LEGACY           = `an10-legacy-${PID}`
const DISABLED         = `an10-disabled-${PID}`

describeEmu('RD-ANALYTICS-10 · capabilities come from the event, not its type', () => {
  let adminDb: FirebaseFirestore.Firestore
  let resolveOperationalCapabilities:
    typeof import('@/lib/analytics/operationsSources').resolveOperationalCapabilities

  const writeConfig = (slug: string, doc: Record<string, unknown>) =>
    adminDb.collection('identifierConfigs').doc(slug).set(doc)

  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ resolveOperationalCapabilities } =
      await import('@/lib/analytics/operationsSources'))

    // NEVER_CONFIGURED gets no document at all — the state most events are in.
    await writeConfig(IDS_ONLY, {
      eventSlug: IDS_ONLY, enabled: true, label: 'Badge', preset: 'badge',
    })
    await writeConfig(IDS_AND_TIMING, {
      eventSlug: IDS_AND_TIMING, enabled: true, label: 'Bib', preset: 'bib',
      tagMapping: { enabled: true, mode: 'mapped', label: 'Transponder' },
    })
    // Timing WITHOUT platform-issued numbers: a real configuration — pre-printed bibs.
    await writeConfig(TIMING_ONLY, {
      eventSlug: TIMING_ONLY, enabled: false, label: 'Bib',
      tagMapping: { enabled: true, mode: 'mapped', label: 'Timing Chip' },
    })
    // A document written before `tagMapping` existed. No migration has run.
    await writeConfig(LEGACY, { eventSlug: LEGACY, enabled: true, label: 'Token' })
    await writeConfig(DISABLED, { eventSlug: DISABLED, enabled: false, label: 'Bib' })
  }, 900_000)

  afterAll(async () => {
    for (const slug of [IDS_ONLY, IDS_AND_TIMING, TIMING_ONLY, LEGACY, DISABLED]) {
      await adminDb.collection('identifierConfigs').doc(slug).delete()
    }
  }, 900_000)

  it('1 · an event that was never configured has NO capabilities', async () => {
    const c = await resolveOperationalCapabilities(NEVER_CONFIGURED)
    expect(c).toEqual({
      identifiersEnabled: false, identifierLabel: null,
      timingEnabled: false, timingLabel: null,
    })
  }, 900_000)

  it('2 · a legacy document with no tagMapping resolves timing OFF, not thrown', async () => {
    const c = await resolveOperationalCapabilities(LEGACY)
    expect(c.identifiersEnabled).toBe(true)
    expect(c.identifierLabel).toBe('Token')
    expect(c.timingEnabled).toBe(false)
  }, 900_000)

  it('3 · identifiers on, timing off', async () => {
    const c = await resolveOperationalCapabilities(IDS_ONLY)
    expect(c.identifiersEnabled).toBe(true)
    expect(c.timingEnabled).toBe(false)
  }, 900_000)

  it('4 · identifiers AND timing, each with the organizer\'s own word', async () => {
    const c = await resolveOperationalCapabilities(IDS_AND_TIMING)
    expect(c.identifiersEnabled).toBe(true)
    expect(c.identifierLabel).toBe('Bib')
    expect(c.timingEnabled).toBe(true)
    // Verbatim: an event that calls them Transponders is not shown "Timing Chip".
    expect(c.timingLabel).toBe('Transponder')
  }, 900_000)

  it('5 · timing WITHOUT identifiers is a real configuration and resolves as one', async () => {
    // Deriving one capability from the other would make this event wrong.
    const c = await resolveOperationalCapabilities(TIMING_ONLY)
    expect(c.identifiersEnabled).toBe(false)
    expect(c.timingEnabled).toBe(true)
  }, 900_000)

  it('6 · an explicitly disabled config yields no identifier capability', async () => {
    const c = await resolveOperationalCapabilities(DISABLED)
    expect(c.identifiersEnabled).toBe(false)
  }, 900_000)

  it('7 · none of this consults the event type — there is no event document at all', async () => {
    // Every slug above exists ONLY as an identifierConfigs document; no `events/{slug}` was
    // written. If the resolver depended on a taxonomy it could not have answered.
    for (const slug of [IDS_ONLY, IDS_AND_TIMING, TIMING_ONLY]) {
      const ev = await adminDb.doc(`events/${slug}`).get()
      expect(ev.exists, slug).toBe(false)
      expect((await resolveOperationalCapabilities(slug)).identifiersEnabled
             || (await resolveOperationalCapabilities(slug)).timingEnabled, slug).toBe(true)
    }
  }, 900_000)
})
