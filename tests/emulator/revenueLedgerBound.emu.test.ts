// RD-ANALYTICS-09 · the payment ledger's read bound, against REAL Firestore (emulator).
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// The producer read `platformTransactions` with `.limit(CAP)` and set `ledgerAvailable`
// the moment the page came back non-empty. An event with more than CAP transactions
// therefore summed the first CAP of them and published the result as gross, fees and net —
// a partial sum wearing the label of a total — with `profitEstimate` inheriting it through
// `net`. Nothing on screen said which.
//
// ═══ WHY THIS TEST NEEDS A REAL DATABASE ═════════════════════════════════════
// The defect is entirely about what Firestore does at a query bound. A fake that returns
// whatever it was handed cannot distinguish a complete page from a truncated one, so the
// unit guard can only assert the SHAPE of the fix. This asserts the behaviour: 5,001 real
// documents in, nothing published; 4,000 in, an exact total.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID  = process.pid
const UID  = `an09-org-${PID}`
const OVER = `an09-over-${PID}`     // more transactions than the cap
const UNDER = `an09-under-${PID}`   // comfortably inside it

/** Must match `CAP` in lib/analytics/eventAnalytics.ts — the bound under test. */
const CAP = 5000
const GROSS = 10_000
const PLATFORM_FEE = 200
const GST = 36
const GATEWAY_FEE = 236
const NET = GROSS - PLATFORM_FEE - GST - GATEWAY_FEE

describeEmu('RD-ANALYTICS-09 · a bounded ledger read never publishes a partial total', () => {
  let adminDb: FirebaseFirestore.Firestore
  let getEventAnalytics: typeof import('@/lib/analytics/eventAnalytics').getEventAnalytics

  const seedEvent = async (slug: string, transactions: number) => {
    await adminDb.doc(`events/${slug}`).set({
      slug, uid: UID, draftId: `${slug}-draft`,
      lifecycleStatus: 'published', totalCapacity: null,
      eventDetails: { info: { name: slug } },
      pricing: { passes: [] },
    })
    let batch = adminDb.batch()
    for (let i = 0; i < transactions; i++) {
      batch.set(adminDb.collection('platformTransactions').doc(`${slug}-t-${i}`), {
        entityId: slug, entityType: 'event', organizerUid: UID,
        grossAmountPaise: GROSS, platformFeeBasePaise: PLATFORM_FEE,
        platformFeeGstPaise: GST, gatewayFeeActualPaise: GATEWAY_FEE,
        netSettlementPaise: NET,
      })
      if ((i + 1) % 450 === 0) { await batch.commit(); batch = adminDb.batch() }
    }
    await batch.commit()
  }

  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ getEventAnalytics } = await import('@/lib/analytics/eventAnalytics'))
    await seedEvent(UNDER, 4_000)
    await seedEvent(OVER,  CAP + 1)
  }, 900_000)

  afterAll(async () => {
    for (const slug of [UNDER, OVER]) {
      let last: string | null = null
      for (;;) {
        let q = adminDb.collection('platformTransactions')
          .where('entityId', '==', slug).orderBy('__name__').limit(450)
        if (last) q = q.startAfter(last)
        const snap = await q.get()
        if (snap.empty) break
        const batch = adminDb.batch()
        for (const d of snap.docs) batch.delete(d.ref)
        await batch.commit()
        last = snap.docs[snap.docs.length - 1].id
        if (snap.size < 450) break
      }
      await adminDb.doc(`events/${slug}`).delete()
    }
  }, 900_000)

  it('1 · under the cap, every gateway figure is an EXACT total', async () => {
    const out = await getEventAnalytics(UNDER, { includeFinancial: true })
    const f = out!.analytics.financial!
    expect(f.grossPaise).toEqual({ ok: true, paise: GROSS * 4_000 })
    expect(f.netPaise).toEqual({ ok: true, paise: NET * 4_000 })
    expect(out!.analytics.limits.ledger).toBe(true)
  }, 900_000)

  it('2 · over the cap, NOTHING is published — not even the part that was read', async () => {
    const out = await getEventAnalytics(OVER, { includeFinancial: true })
    const f = out!.analytics.financial!
    for (const k of ['grossPaise', 'platformFeePaise', 'gstPaise', 'gatewayFeePaise', 'netPaise'] as const) {
      expect(f[k], k).toEqual({ ok: false, reason: 'out_of_budget' })
    }
    // The partial sum the old code would have published must appear nowhere.
    expect(JSON.stringify(f)).not.toContain(String(GROSS * CAP))
  }, 900_000)

  it('3 · the profit estimate inherits the refusal rather than a partial net', async () => {
    const out = await getEventAnalytics(OVER, { includeFinancial: true })
    expect(out!.analytics.financial!.profitEstimatePaise.ok).toBe(false)
  }, 900_000)

  it('4 · `limits.ledger` agrees with the figures', async () => {
    // A consumer that trusted the flag over the values — or the reverse — is how a partial
    // total gets rendered beneath a "complete" badge.
    const out = await getEventAnalytics(OVER, { includeFinancial: true })
    expect(out!.analytics.limits.ledger).toBe(false)
  }, 900_000)

  it('5 · the canonical CONFIRMED revenue is unaffected by the ledger bound', async () => {
    // It comes from a sum() aggregate over registrations, not from this collection at all.
    const out = await getEventAnalytics(OVER, { includeFinancial: true })
    expect(out!.analytics.financial!.confirmedRevenuePaise.ok).toBe(true)
  }, 900_000)

  it('6 · a caller without the permission issues no ledger read at all', async () => {
    const out = await getEventAnalytics(OVER, { includeFinancial: false })
    expect(out!.analytics.financial).toBeUndefined()
    expect(out!.analytics.limits.ledger).toBe(true)   // nothing was attempted, nothing capped
  }, 900_000)
})
