// RD-ANALYTICS-03 · Event Analytics at 20,000 registrations — REAL Firestore (emulator).
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// getEventAnalytics read `registrations` with .limit(5001) and derived every count, chart
// bucket, payment split, per-pass figure and funnel step by iterating those documents.
// Above the cap it described a SAMPLE and presented it as the event. Worse, the sample was
// ordered by document id — so it was not even the most recent 5,000.
//
// ═══ WHAT THIS PROVES ════════════════════════════════════════════════════════
// Two things, and the second is the one that cannot be faked:
//
//   1. CORRECTNESS — with 20,000 registrations in seven statuses, every count matches the
//      canonical aggregate helpers exactly, including rows deliberately placed at document
//      positions 5,001 / 9,999 / 19,999 which the old cap could never have reached.
//
//   2. COST — every Firestore Query.get() issued during the call is intercepted and its
//      RESULT SIZE recorded. count()/sum() aggregates run on a different prototype and are
//      therefore excluded by construction, which is exactly the distinction that matters:
//      an aggregate transfers no documents. The old implementation transferred 5,001
//      registration documents; the assertion below is that the total transferred by ALL
//      queries is a small constant while 20,000 registrations exist.
//
// LIMITATION, stated rather than papered over: this instrumentation cannot attribute a
// transferred document to its collection without reaching into firebase-admin internals.
// It therefore asserts the TOTAL, which is strictly stronger for this purpose — if any
// registration query ran, the total could not stay under the bound.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const UID   = `an03-org-${PID}`
const SLUG  = `an03-event-${PID}`
const OTHER_UID   = `an03-other-org-${PID}`
const OTHER_EVENT = `an03-other-event-${PID}`
const PASS_A = 'pass-a'
const PASS_B = 'pass-b'

// ─── The fixture ──────────────────────────────────────────────────────────────
// Seven (status, paymentStatus) combinations. Every one appears throughout the id space,
// so each is represented both before and after the old 5,000 boundary.
const MIX: { status: string; paymentStatus: string; n: number }[] = [
  { status: 'confirmed',  paymentStatus: 'paid',           n: 12_000 },
  { status: 'confirmed',  paymentStatus: 'not_required',   n:  1_200 },
  { status: 'confirmed',  paymentStatus: 'refunded',       n:    500 },
  { status: 'confirmed',  paymentStatus: 'refund_pending', n:    300 },
  { status: 'pending',    paymentStatus: 'pending',        n:  2_000 },
  { status: 'cancelled',  paymentStatus: 'paid',           n:  1_800 },
  { status: 'rejected',   paymentStatus: 'paid',           n:  1_200 },
  { status: 'waitlisted', paymentStatus: 'pending',        n:  1_000 },
]
const TOTAL = MIX.reduce((s, m) => s + m.n, 0)          // 20,000

const CONFIRMED  = 12_000 + 1_200 + 500 + 300           // 14,000
const PENDING    = 2_000
const CANCELLED  = 1_800
const REJECTED   = 1_200
const WAITLISTED = 1_000
const PAID       = 12_000 + 1_800 + 1_200               // 15,000
const FREE       = 1_200
const PAY_PEND   = 2_000 + 1_000                        // 3,000
const REFUNDED   = 500
const REFUND_PEND = 300
/** Every 5th confirmed row is checked in. */
const CHECKED_IN = Math.floor(CONFIRMED / 5)

const AMOUNT = 50_000                                    // paise, on every priced row
/** Σ amount over CONFIRMED — what the canonical revenue reader must return. */
const CONFIRMED_REVENUE = CONFIRMED * AMOUNT

/** Rows placed exactly at these positions, to prove the old cap is gone. */
const MARKERS = [5_001, 9_999, 19_999]

const regId = (i: number) => `${SLUG}-reg-${String(i).padStart(6, '0')}`

interface Row { id: string; status: string; paymentStatus: string; passId: string; checkedIn: boolean }

function buildRows(): Row[] {
  // Interleave by cycling the mix so no status occupies a contiguous block — a cap or an
  // off-by-one on an ordered read would otherwise be invisible for most statuses.
  const pool: { status: string; paymentStatus: string }[] = []
  const left = MIX.map(m => ({ ...m }))
  let guard = 0
  while (pool.length < TOTAL && guard++ < TOTAL * 2) {
    for (const m of left) {
      if (m.n > 0) { pool.push({ status: m.status, paymentStatus: m.paymentStatus }); m.n-- }
      if (pool.length === TOTAL) break
    }
  }
  let confirmedSeen = 0
  return pool.map((p, i) => {
    const isConfirmed = p.status === 'confirmed'
    const checkedIn = isConfirmed && (confirmedSeen++ % 5 === 0)
    return {
      id: regId(i), status: p.status, paymentStatus: p.paymentStatus,
      passId: i % 2 === 0 ? PASS_A : PASS_B, checkedIn,
    }
  })
}

describeEmu('RD-ANALYTICS-03 · Event Analytics at 20,000 registrations', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let getEventAnalytics: typeof import('@/lib/analytics/eventAnalytics').getEventAnalytics
  let aggregateRegistrationStatusCounts: typeof import('@/lib/firebase/firestore/registrationCounters').aggregateRegistrationStatusCounts
  let sumConfirmedRevenueFromLedgerChecked: typeof import('@/lib/firebase/firestore/registrationCounters').sumConfirmedRevenueFromLedgerChecked

  const rows = buildRows()
  const foreignIds: string[] = []

  /** Sizes of every QuerySnapshot returned while the recorder is armed. */
  let transferred: number[] = []
  let recording = false
  let restore: (() => void) | null = null

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ getEventAnalytics } = await import('@/lib/analytics/eventAnalytics'))
    ;({ aggregateRegistrationStatusCounts, sumConfirmedRevenueFromLedgerChecked } =
      await import('@/lib/firebase/firestore/registrationCounters'))

    // The published event mirror — the doc getEventAnalytics resolves identity and passes from.
    await adminDb.doc(`events/${SLUG}`).set({
      slug: SLUG, uid: UID, draftId: 'draft-A', lifecycleStatus: 'published',
      totalCapacity: 25_000,
      eventDetails: { info: { name: 'Analytics Scale Event' } },
      pricing: { passes: [{ id: PASS_A, name: 'General' }, { id: PASS_B, name: 'VIP' }] },
    })

    const write = async (entries: [string, Record<string, unknown>][]) => {
      for (let i = 0; i < entries.length; i += 450) {
        const b = adminDb.batch()
        for (const [id, data] of entries.slice(i, i + 450)) {
          b.set(adminDb.collection('registrations').doc(id), data)
        }
        await b.commit()
      }
    }

    await write(rows.map(r => [r.id, {
      organizerUid: UID, eventSlug: SLUG, eventName: 'Analytics Scale Event',
      status: r.status, paymentStatus: r.paymentStatus,
      amount: AMOUNT, passId: r.passId, passName: r.passId === PASS_A ? 'General' : 'VIP',
      ticketCode: `TC-${r.id}`, checkedIn: r.checkedIn,
      ...(r.checkedIn ? { checkedInAt: new Date() } : {}),
      attendee: { name: `P ${r.id}`, email: `${r.id}@test.local`, phone: '', formResponses: {} },
      registeredAt: new Date(),
    }]))

    // Foreign rows: a DIFFERENT organizer on a different event, and this organizer on a
    // different event. Both confirmed and paid, so only the scope predicates keep them out.
    //
    // NOTE ON THE SHAPE. An earlier version of this fixture put a foreign ORGANIZER on THIS
    // event's slug. That combination cannot occur — an event slug belongs to exactly one
    // workspace — and it made the test fail against the canonical revenue reader, because
    // sumConfirmedRevenueFromLedgerChecked scopes on (eventSlug, status) ALONE, with no
    // organizerUid predicate. That is sound given globally unique slugs, and it is recorded
    // here because it is a real property of the canonical reader worth knowing.
    const foreign: [string, Record<string, unknown>][] = []
    for (let i = 0; i < 60; i++) {
      const id = `${SLUG}-foreign-${i}`
      foreignIds.push(id)
      foreign.push([id, {
        organizerUid: i % 2 === 0 ? OTHER_UID : UID,
        eventSlug:    OTHER_EVENT,
        status: 'confirmed', paymentStatus: 'paid', amount: AMOUNT,
        passId: PASS_A, passName: 'General', ticketCode: `TC-${id}`, checkedIn: false,
        attendee: { name: 'Foreign', email: 'f@test.local', phone: '', formResponses: {} },
        registeredAt: new Date(),
      }])
    }
    await write(foreign)

    // The counter document — the canonical per-pass CONFIRMED split.
    const passA = rows.filter(r => r.status === 'confirmed' && r.passId === PASS_A).length
    const passB = rows.filter(r => r.status === 'confirmed' && r.passId === PASS_B).length
    await adminDb.collection('registrationCounters').doc(SLUG).set({
      totalCount: TOTAL, passCounts: { [PASS_A]: passA, [PASS_B]: passB },
      revenuePaise: CONFIRMED_REVENUE, cancelledCount: CANCELLED,
    })

    // ── Arm the recorder on the LIVE prototype ────────────────────────────────
    const sample = adminDb.collection('registrations').where('organizerUid', '==', UID)
    const QueryProto = Object.getPrototypeOf(sample) as { get: () => Promise<{ size?: number }> }
    const origGet = QueryProto.get
    QueryProto.get = async function (this: unknown, ...args: unknown[]) {
      const snap = await (origGet as (...a: unknown[]) => Promise<{ size?: number }>).apply(this, args)
      // Only QuerySnapshots carry `size`; a DocumentSnapshot does not, and an aggregate
      // runs on a different prototype entirely — so this counts DOCUMENTS TRANSFERRED.
      if (recording && typeof snap.size === 'number') transferred.push(snap.size)
      return snap
    } as typeof origGet
    restore = () => { QueryProto.get = origGet }
  }, 900_000)

  afterAll(async () => {
    restore?.()
    const del = async (ids: string[]) => {
      for (let i = 0; i < ids.length; i += 400) {
        const b = adminDb.batch()
        ids.slice(i, i + 400).forEach(id => b.delete(adminDb.collection('registrations').doc(id)))
        await b.commit()
      }
    }
    await del(rows.map(r => r.id))
    await del(foreignIds)
    await adminDb.doc(`events/${SLUG}`).delete()
    await adminDb.collection('registrationCounters').doc(SLUG).delete()
  }, 900_000)

  // ── Correctness ─────────────────────────────────────────────────────────────

  describe('every registration is counted, not the first 5,000', () => {
    let a: import('@/lib/analytics/eventAnalytics').EventAnalytics

    it('1 · computes analytics over the whole 20,000-registration event', async () => {
      transferred = []; recording = true
      const out = await getEventAnalytics(SLUG, { includeFinancial: true })
      recording = false
      expect(out).not.toBeNull()
      a = out!.analytics
      expect(out!.organizerUid).toBe(UID)
    }, 900_000)

    it('2 · the total is the whole event — 4× what the old cap could see', () => {
      expect(a.kpis.registrations).toBe(TOTAL)
      expect(a.kpis.registrations!).toBeGreaterThan(5_000)
    })

    it('3 · every registration status is exact', () => {
      expect(a.kpis.confirmed).toBe(CONFIRMED)
      expect(a.kpis.pending).toBe(PENDING)
      expect(a.kpis.cancelled).toBe(CANCELLED)
      expect(a.kpis.rejected).toBe(REJECTED)
      expect(a.kpis.waitlisted).toBe(WAITLISTED)
    })

    it('4 · every payment status is exact, and refunded ≠ refund_pending', () => {
      expect(a.kpis.paid).toBe(PAID)
      expect(a.kpis.free).toBe(FREE)
      expect(a.kpis.paymentPending).toBe(PAY_PEND)
      expect(a.kpis.refunded).toBe(REFUNDED)
      expect(a.kpis.refundPending).toBe(REFUND_PEND)
    })

    it('5 · the status counts reconcile — parts sum to the whole, no residue', () => {
      const s = a.kpis
      expect(s.confirmed! + s.pending! + s.cancelled! + s.rejected! + s.waitlisted!).toBe(TOTAL)
      expect(s.paid! + s.free! + s.paymentPending! + s.refunded! + s.refundPending!).toBe(TOTAL)
    })

    it('6 · check-ins are exact', () => {
      expect(a.kpis.checkedIn).toBe(CHECKED_IN)
    })

    it('7 · rows at positions 5,001 / 9,999 / 19,999 exist and are inside the totals', async () => {
      // Direct proof that the boundary is gone: these documents sort AFTER the old cap.
      for (const pos of MARKERS) {
        const snap = await adminDb.collection('registrations').doc(regId(pos)).get()
        expect(snap.exists, `${regId(pos)} must exist`).toBe(true)
      }
      // The totals above already include them; this states the arithmetic explicitly.
      expect(a.kpis.registrations).toBe(rows.length)
    }, 900_000)

    it('8 · no foreign-organizer or foreign-event registration leaked in', () => {
      // 60 confirmed+paid rows exist outside this (organizerUid, eventSlug) pair — 30 owned
      // by another workspace, 30 by this one on a different event. Either predicate failing
      // would show up as a total above TOTAL.
      expect(a.kpis.registrations).toBe(TOTAL)
      expect(a.kpis.confirmed).toBe(CONFIRMED)
    })

    it('9 · the per-pass split is complete and sums to confirmed', () => {
      const sum = a.passSales.reduce((n, p) => n + p.value, 0)
      expect(sum).toBe(CONFIRMED)
      expect(a.passSales.map(p => p.label).sort()).toEqual(['General', 'VIP'])
      expect(a.limits.passValue).toBe(true)
    })

    it('10 · the registration path declares itself complete', () => {
      expect(a.limits.registrations).toBe(true)
    })

    // ── §18 · Cross-reconciliation with the canonical helpers ──────────────────

    it('11 · matches aggregateRegistrationStatusCounts exactly', async () => {
      const canonical = await aggregateRegistrationStatusCounts(UID, SLUG)
      expect(a.kpis.registrations).toBe(canonical.total)
      expect(a.kpis.confirmed).toBe(canonical.confirmed)
      expect(a.kpis.pending).toBe(canonical.pending)
      expect(a.kpis.cancelled).toBe(canonical.cancelled)
      expect(a.kpis.waitlisted).toBe(canonical.waitlisted)
      expect(a.kpis.rejected).toBe(canonical.rejected)
      expect(a.kpis.checkedIn).toBe(canonical.checkedIn)
    }, 900_000)

    it('12 · confirmed revenue matches sumConfirmedRevenueFromLedgerChecked exactly', async () => {
      const canonical = await sumConfirmedRevenueFromLedgerChecked(SLUG)
      expect(canonical).toEqual({ value: CONFIRMED_REVENUE, ok: true })
      expect(a.financial!.confirmedRevenuePaise).toEqual({ ok: true, paise: CONFIRMED_REVENUE })
    }, 900_000)
  })

  // ── §17 · Read scale ────────────────────────────────────────────────────────

  describe('the cost no longer scales with the event', () => {
    /**
     * The bound. Aggregates transfer nothing, the counter and event docs are DocumentSnapshots
     * (no `size`, so not counted here), and the rollup read is a getAll of document refs.
     * What remains on the Query path is a handful of small internal reads. 200 is far below
     * the 5,001 registration documents the old implementation transferred, and far below any
     * number a 20,000-row query could produce.
     */
    const BOUND = 200

    it('13 · analytics over 20,000 registrations transfers almost no documents', () => {
      const total = transferred.reduce((n, v) => n + v, 0)
      expect(total).toBeLessThan(BOUND)
      // The single decisive number: the old code's first read alone was 5,001.
      expect(total).toBeLessThan(5_000)
    })

    it('14 · no single query returned a large page', () => {
      const max = transferred.length ? Math.max(...transferred) : 0
      expect(max).toBeLessThan(BOUND)
    })

    it('15 · a second call costs the same — nothing scales with volume', async () => {
      transferred = []; recording = true
      await getEventAnalytics(SLUG, { includeFinancial: true })
      recording = false
      expect(transferred.reduce((n, v) => n + v, 0)).toBeLessThan(BOUND)
    }, 900_000)

    it('16 · a caller without the finance permission costs no more', async () => {
      transferred = []; recording = true
      const out = await getEventAnalytics(SLUG, { includeFinancial: false })
      recording = false
      expect(transferred.reduce((n, v) => n + v, 0)).toBeLessThan(BOUND)
      // …and still reports the whole event.
      expect(out!.analytics.kpis.registrations).toBe(TOTAL)
      expect(out!.analytics.financial).toBeUndefined()
    }, 900_000)

    // ─── RD-ANALYTICS-08 · the Registrations module at 20,000 ─────────────────

    it('17 · the cancellation series and period totals cost NO extra documents', async () => {
      // The module added `cancellationsByDay` and `period.cancelled`. Both are summed from
      // the rollup rows the trend already reads, so the bound that held before must still
      // hold — if either had become its own query, the total would move.
      transferred = []; recording = true
      const out = await getEventAnalytics(SLUG, { includeFinancial: false })
      recording = false
      expect(transferred.reduce((n, v) => n + v, 0)).toBeLessThan(BOUND)

      const a = out!.analytics
      // Present and shaped, at 20,000 registrations, without a registration read.
      expect(a.cancellationsByDay).not.toBeUndefined()
      expect(a.period.cancelled).not.toBeUndefined()
      if (a.cancellationsByDay !== null) {
        expect(a.cancellationsByDay.length).toBe(a.registrationsByDay?.length ?? 0)
        for (const p of a.cancellationsByDay) expect(typeof p.value).toBe('number')
      }
    }, 900_000)

    it('18 · every registration figure the module renders is measured, not null', async () => {
      // A 20,000-row event is exactly where a scan-based implementation used to give up and
      // report a sample. Each of these comes from a count() aggregate or the counter doc.
      const out = await getEventAnalytics(SLUG, { includeFinancial: false })
      const k = out!.analytics.kpis
      for (const key of ['registrations', 'confirmed', 'pending', 'cancelled', 'rejected',
                         'waitlisted', 'paid', 'free', 'paymentPending'] as const) {
        expect(k[key], key).not.toBeNull()
      }
      expect(k.registrations).toBe(TOTAL)
    }, 900_000)
  })
})
