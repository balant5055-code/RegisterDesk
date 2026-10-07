// RD-ANALYTICS-12-29 · registration source composition, against REAL Firestore (emulator).
//
// ═══ WHY THIS TEST NEEDS A REAL DATABASE ═════════════════════════════════════
// The unit suite pins the SHAPE of every query; only Firestore can establish:
//
//   · that four equality clauses (`organizerUid`, `eventSlug`, `registrationSource`,
//     `status`) count exactly over 20,000+ rows with no composite index and no page
//   · that a row with NO `registrationSource` is excluded by BOTH equality counts, so the
//     remainder against the status total is exactly the pre-field population — never
//     silently "online"
//   · that two workspaces sharing an event slug, and two events of one workspace, never
//     see each other's rows
//   · that a status with nothing in it is a measured zero on every source, not unavailable
//
//   npm run emu:start && npm run test:emu
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const UID_A = `an29-org-a-${PID}`
const UID_B = `an29-org-b-${PID}`
const BIG   = `an29-big-${PID}`
const SMALL = `an29-small-${PID}`

const BIG_ONLINE_CONFIRMED  = 12_000
const BIG_WALKIN_CONFIRMED  = 5_000
const BIG_LEGACY_CONFIRMED  = 3_000   // no registrationSource field at all
const BIG_ONLINE_CANCELLED  = 400
const BIG_LEGACY_CANCELLED  = 100
const BIG_TOTAL = BIG_ONLINE_CONFIRMED + BIG_WALKIN_CONFIRMED + BIG_LEGACY_CONFIRMED
                + BIG_ONLINE_CANCELLED + BIG_LEGACY_CANCELLED   // 20,500

describeEmu('RD-ANALYTICS-12-29 · registration source composition', () => {
  let adminDb: FirebaseFirestore.Firestore
  let src: typeof import('@/lib/analytics/participantsSources')
  let counters: typeof import('@/lib/firebase/firestore/registrationCounters')
  const seeded: string[] = []

  const write = async (prefix: string, rows: Record<string, unknown>[]) => {
    let batch = adminDb.batch()
    for (let i = 0; i < rows.length; i++) {
      const id = `${prefix}-${i}`
      seeded.push(id)
      batch.set(adminDb.collection('registrations').doc(id), rows[i])
      if ((i + 1) % 450 === 0) { await batch.commit(); batch = adminDb.batch() }
    }
    await batch.commit()
  }
  const reg = (uid: string, slug: string, status: string, source?: 'online' | 'walkin') => ({
    organizerUid: uid, eventSlug: slug, status, paymentStatus: 'not_required', amount: 0,
    passId: 'p', passName: 'P', ticketCode: 'x', checkedIn: false,
    attendee: { name: 'n', email: 'e@x.test', phone: '', formResponses: {} },
    registeredAt: new Date(),
    ...(source ? { registrationSource: source } : {}),
  })

  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    src      = await import('@/lib/analytics/participantsSources')
    counters = await import('@/lib/firebase/firestore/registrationCounters')

    await write(BIG, [
      ...Array.from({ length: BIG_ONLINE_CONFIRMED }, () => reg(UID_A, BIG, 'confirmed', 'online')),
      ...Array.from({ length: BIG_WALKIN_CONFIRMED }, () => reg(UID_A, BIG, 'confirmed', 'walkin')),
      ...Array.from({ length: BIG_LEGACY_CONFIRMED }, () => reg(UID_A, BIG, 'confirmed')),
      ...Array.from({ length: BIG_ONLINE_CANCELLED }, () => reg(UID_A, BIG, 'cancelled', 'online')),
      ...Array.from({ length: BIG_LEGACY_CANCELLED }, () => reg(UID_A, BIG, 'cancelled')),
    ])
    await write(SMALL, [
      reg(UID_A, SMALL, 'confirmed', 'online'),
      reg(UID_A, SMALL, 'pending',   'walkin'),
    ])
    // Workspace B claims BIG's slug. Must never be counted for A.
    await write(`${BIG}-b`, [
      reg(UID_B, BIG, 'confirmed', 'walkin'),
      reg(UID_B, BIG, 'confirmed', 'walkin'),
      reg(UID_B, BIG, 'confirmed'),
    ])
  }, 900_000)

  afterAll(async () => {
    for (let i = 0; i < seeded.length; i += 450) {
      const batch = adminDb.batch()
      for (const id of seeded.slice(i, i + 450)) batch.delete(adminDb.collection('registrations').doc(id))
      await batch.commit()
    }
  }, 900_000)

  const totalsFor = async (uid: string, slug: string) => {
    const t = await counters.aggregateRegistrationStatusCounts(uid, slug)
    return { total: t.total, confirmed: t.confirmed, pending: t.pending, cancelled: t.cancelled,
             rejected: t.rejected, waitlisted: t.waitlisted }
  }

  it('1 · AA · 20,500 rows: every source figure is exact, and no document is read', async () => {
    const started = Date.now()
    const c = (await src.readRegistrationSourceComposition(UID_A, BIG, await totalsFor(UID_A, BIG)))!
    expect(c.lifetime).toEqual({
      online:     BIG_ONLINE_CONFIRMED + BIG_ONLINE_CANCELLED,
      walkin:     BIG_WALKIN_CONFIRMED,
      unrecorded: BIG_LEGACY_CONFIRMED + BIG_LEGACY_CANCELLED,
    })
    expect(c.lifetime.online! + c.lifetime.walkin! + c.lifetime.unrecorded!).toBe(BIG_TOTAL)
    expect(Date.now() - started).toBeLessThan(30_000)
  }, 120_000)

  it('2 · a row with NO registrationSource is "unrecorded" — never online', async () => {
    const c = (await src.readRegistrationSourceComposition(UID_A, BIG, await totalsFor(UID_A, BIG)))!
    expect(c.byStatus.confirmed).toEqual({
      online: BIG_ONLINE_CONFIRMED, walkin: BIG_WALKIN_CONFIRMED, unrecorded: BIG_LEGACY_CONFIRMED,
    })
    expect(c.byStatus.cancelled).toEqual({ online: BIG_ONLINE_CANCELLED, walkin: 0, unrecorded: BIG_LEGACY_CANCELLED })
  }, 120_000)

  it('3 · an empty status is a measured zero on every source, not unavailable', async () => {
    const c = (await src.readRegistrationSourceComposition(UID_A, BIG, await totalsFor(UID_A, BIG)))!
    expect(c.byStatus.rejected).toEqual({ online: 0, walkin: 0, unrecorded: 0 })
    expect(c.byStatus.waitlisted).toEqual({ online: 0, walkin: 0, unrecorded: 0 })
  }, 120_000)

  it('4 · two events of one workspace stay apart', async () => {
    const small = (await src.readRegistrationSourceComposition(UID_A, SMALL, await totalsFor(UID_A, SMALL)))!
    expect(small.lifetime).toEqual({ online: 1, walkin: 1, unrecorded: 0 })
    expect(small.byStatus.pending).toEqual({ online: 0, walkin: 1, unrecorded: 0 })
  }, 120_000)

  it('5 · a workspace never sees another workspace\'s rows, even under the same slug', async () => {
    const b = (await src.readRegistrationSourceComposition(UID_B, BIG, await totalsFor(UID_B, BIG)))!
    expect(b.lifetime).toEqual({ online: 0, walkin: 2, unrecorded: 1 })
    const a = (await src.readRegistrationSourceComposition(UID_A, BIG, await totalsFor(UID_A, BIG)))!
    expect(a.lifetime.walkin).toBe(BIG_WALKIN_CONFIRMED)   // B's two walk-ins are not in A
  }, 120_000)

  it('6 · an unmeasured status total makes only that remainder unmeasured, never zero', async () => {
    const t = await totalsFor(UID_A, SMALL)
    const c = (await src.readRegistrationSourceComposition(UID_A, SMALL, { ...t, pending: null }))!
    expect(c.byStatus.pending.unrecorded).toBeNull()
    expect(c.byStatus.pending.walkin).toBe(1)
    expect(c.byStatus.confirmed.unrecorded).toBe(0)
  }, 120_000)
})
