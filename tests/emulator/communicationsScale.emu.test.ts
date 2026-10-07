// RD-ANALYTICS-11 · communication counts at scale, against REAL Firestore (emulator).
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// The producer read `emailLogs` with `.limit(5000)` and counted the page in memory, then
// published sent / delivered / failed as the event's totals with `limits.communications`
// still true. An event that sent more than 5,000 messages reported the first 5,000 as its
// whole history, and nothing on screen said so. The counts are now `count()` aggregates,
// which have no page to overflow.
//
// ═══ WHY THIS TEST NEEDS A REAL DATABASE ═════════════════════════════════════
// Every claim here is a claim about what Firestore does, and a fake cannot establish any of
// them:
//
//   · that a `count()` aggregate answers over 5,001 documents at all, and answers exactly —
//     the whole basis for removing the cap
//   · that `where('channel','==','whatsapp')` EXCLUDES rows with no `channel` field, which
//     is why email is counted as (all − whatsapp) rather than by an equality filter that
//     would silently drop the entire pre-WhatsApp history
//   · that the equality filters used here need no composite index — an aggregate that
//     FAILED_PRECONDITIONs in production would surface as `null`, and a green unit suite
//     would have told us nothing
//   · that `sum('costPaise')` returns an exact total over rows where some are missing the
//     field entirely
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const BIG   = `an11-big-${PID}`      // more messages than the old cap
const MIXED = `an11-mixed-${PID}`    // both channels, every delivery state
const QUIET = `an11-quiet-${PID}`    // exists, has never sent anything

/** The bound the old in-memory count could not see past. */
const CAP = 5000

/**
 * BIG's population. Legacy email rows carry NO `channel` field — exactly like every row
 * written before WhatsApp shipped — which is the case a `channel == 'email'` filter loses.
 */
const BIG_EMAIL_SENT      = 3_200
const BIG_EMAIL_DELIVERED = 1_500
const BIG_WA_DELIVERED    = 400
const BIG_TOTAL           = BIG_EMAIL_SENT + BIG_EMAIL_DELIVERED + BIG_WA_DELIVERED  // 5,100
const COST_PAISE          = 12

describeEmu('RD-ANALYTICS-11 · communication counts are aggregates, not a page', () => {
  let adminDb: FirebaseFirestore.Firestore
  let readCommunicationCounts:
    typeof import('@/lib/analytics/communicationsSources').readCommunicationCounts
  let readCommunicationSpend:
    typeof import('@/lib/analytics/communicationsSources').readCommunicationSpend

  const seeded: string[] = []

  const write = async (eventId: string, rows: Record<string, unknown>[]) => {
    let batch = adminDb.batch()
    for (let i = 0; i < rows.length; i++) {
      const id = `${eventId}-m-${i}`
      seeded.push(id)
      batch.set(adminDb.collection('emailLogs').doc(id), { eventId, ...rows[i] })
      if ((i + 1) % 450 === 0) { await batch.commit(); batch = adminDb.batch() }
    }
    await batch.commit()
  }

  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ readCommunicationCounts, readCommunicationSpend } =
      await import('@/lib/analytics/communicationsSources'))

    // BIG · over the old cap, with a legacy email population that has no `channel` at all.
    await write(BIG, [
      ...Array.from({ length: BIG_EMAIL_SENT },      () => ({ status: 'sent',      costPaise: COST_PAISE })),
      ...Array.from({ length: BIG_EMAIL_DELIVERED }, () => ({ status: 'delivered', costPaise: COST_PAISE })),
      ...Array.from({ length: BIG_WA_DELIVERED },    () => ({ status: 'delivered', channel: 'whatsapp' })),
    ])

    // MIXED · one of everything, including the two rows that share `status: 'failed'` and
    // mean opposite things.
    await write(MIXED, [
      { status: 'sent' },
      { status: 'delivered' },
      { status: 'failed' },                                             // email, rejected
      { status: 'queued' },
      { status: 'skipped' },
      { status: 'sent',      channel: 'whatsapp' },
      { status: 'delivered', channel: 'whatsapp' },
      { status: 'failed',    channel: 'whatsapp' },                     // rejected by Meta
      { status: 'failed',    channel: 'whatsapp', deliveryUnknown: true }, // send timed out
    ])

    // QUIET is seeded with nothing on purpose.
  }, 900_000)

  afterAll(async () => {
    for (let i = 0; i < seeded.length; i += 450) {
      const batch = adminDb.batch()
      for (const id of seeded.slice(i, i + 450)) {
        batch.delete(adminDb.collection('emailLogs').doc(id))
      }
      await batch.commit()
    }
  }, 900_000)

  it('1 · AA · over 5,000 messages, every count is exact — there is no cap left to hit', async () => {
    const c = (await readCommunicationCounts(BIG))!
    expect(c).not.toBeNull()
    expect(c.total).toBe(BIG_TOTAL)
    expect(BIG_TOTAL).toBeGreaterThan(CAP)          // the old read would have truncated here
    // The figure the capped scan could never produce: an exact count past its own bound.
    // BIG has no rejections, so every attempted email is a dispatch or a delivery.
    expect(c.email.sent).toBe(BIG_EMAIL_SENT + BIG_EMAIL_DELIVERED)
    expect(c.email.delivered).toBe(BIG_EMAIL_DELIVERED)
  })

  it('2 · a row with NO `channel` field counts as email, not as nothing', async () => {
    // This is the whole reason email is (all − whatsapp). Every BIG email row predates the
    // field; an equality filter on `channel == "email"` would have returned zero of them.
    const c = (await readCommunicationCounts(BIG))!
    expect(c.whatsapp.delivered).toBe(BIG_WA_DELIVERED)
    expect(c.email.delivered).toBe(BIG_EMAIL_DELIVERED)
    expect(c.email.delivered! + c.whatsapp.delivered!).toBe(BIG_EMAIL_DELIVERED + BIG_WA_DELIVERED)

    const legacyByEquality = await adminDb.collection('emailLogs')
      .where('eventId', '==', BIG).where('channel', '==', 'email').count().get()
    expect(legacyByEquality.data().count).toBe(0)   // …and this is what would have shipped
  })

  it('3 · a send that timed out is UNKNOWN, and is subtracted out of failed', async () => {
    const c = (await readCommunicationCounts(MIXED))!
    // Two WhatsApp rows carry `status: 'failed'`. One is a rejection; the other is a
    // transport timeout that says nothing about delivery.
    const rawFailed = await adminDb.collection('emailLogs')
      .where('eventId', '==', MIXED).where('channel', '==', 'whatsapp')
      .where('status', '==', 'failed').count().get()
    expect(rawFailed.data().count).toBe(2)

    expect(c.whatsapp.unknown).toBe(1)
    expect(c.whatsapp.failed).toBe(1)              // NOT 2 — the timeout is not a rejection
    expect(c.email.unknown).toBe(0)
    expect(c.email.failed).toBe(1)
  })

  it('4 · each channel reports its own position, and the states stay apart', async () => {
    const c = (await readCommunicationCounts(MIXED))!
    // email: 1 sent + 1 delivered + 1 rejected attempted; queued and skipped were not.
    expect(c.email).toEqual({
      sent: 3, delivered: 1, failed: 1, unknown: 0, queued: 1, skipped: 1,
    })
    // whatsapp: 1 sent + 1 delivered + 1 rejected + 1 timed out.
    expect(c.whatsapp).toEqual({
      sent: 4, delivered: 1, failed: 1, unknown: 1, queued: 0, skipped: 0,
    })
    expect(c.total).toBe(9)
    // The invariant the browser found broken: attempted + queued + skipped = every row.
    expect(c.email.sent! + c.email.queued! + c.email.skipped!
         + c.whatsapp.sent! + c.whatsapp.queued! + c.whatsapp.skipped!).toBe(c.total)
  })

  it('5 · an event that has sent nothing reads as MEASURED zero, not as unavailable', async () => {
    const c = (await readCommunicationCounts(QUIET))!
    expect(c).not.toBeNull()
    expect(c.total).toBe(0)
    expect(c.email.sent).toBe(0)
    expect(c.whatsapp.sent).toBe(0)
    // Zero because we asked and the answer was zero — every field is a number, none is null.
    expect(Object.values(c.email).every(v => v === 0)).toBe(true)
  })

  it('6 · every filter used here is served WITHOUT a declared composite index', async () => {
    // A missing index is a FAILED_PRECONDITION, which the readers turn into null. If any of
    // these needed one, production would publish "unavailable" for every event and the unit
    // suite would never notice. Nothing here may be null.
    for (const id of [BIG, MIXED, QUIET]) {
      const c = (await readCommunicationCounts(id))!
      for (const [chan, counts] of Object.entries({ email: c.email, whatsapp: c.whatsapp })) {
        for (const [field, v] of Object.entries(counts)) {
          expect(v, `${id}.${chan}.${field}`).not.toBeNull()
        }
      }
      expect(c.total, id).not.toBeNull()
    }
  })

  it('7 · spend is an exact sum over rows where some carry no cost at all', async () => {
    const spend = await readCommunicationSpend(BIG)
    expect(spend.ok).toBe(true)
    // The WhatsApp rows have no `costPaise` field; sum() skips them rather than failing.
    expect(spend).toEqual({
      ok: true, paise: (BIG_EMAIL_SENT + BIG_EMAIL_DELIVERED) * COST_PAISE,
    })

    const quiet = await readCommunicationSpend(QUIET)
    expect(quiet).toEqual({ ok: true, paise: 0 })   // measured ₹0, not `gone`
  })

  it('8 · counts are event-scoped — one event never sees another\'s messages', async () => {
    const big   = (await readCommunicationCounts(BIG))!
    const mixed = (await readCommunicationCounts(MIXED))!
    expect(big.total).toBe(BIG_TOTAL)
    expect(mixed.total).toBe(9)
    expect(big.total).not.toBe(mixed.total)
  })
})
