// MC-05.6B · Wallet contention LOAD MEASUREMENT — REAL Firestore (emulator).
//
// PURPOSE: measure the credit path's actual throughput before deciding whether Blocker #2 is
// real. The MC-05.5 audit asserted a bottleneck from Google's DOCUMENTED per-document write
// guidance, not from a measurement. This file supplies the measurement.
//
// ═══ WHAT THIS CAN AND CANNOT PROVE ══════════════════════════════════════════
// The Firestore EMULATOR is a single-process, in-memory implementation. It reproduces
// transaction SEMANTICS — optimistic concurrency, aborts, retries — but NOT production's
// per-document sustained-write throttling. So:
//
//   CAN prove : whether the design serialises, how many retries/aborts contention produces,
//               relative cost of the credit path vs the rest of the upload, failure counts.
//   CANNOT prove: the absolute writes/sec ceiling of production Firestore.
//
// Any production number in the report is derived from these ratios plus Google's published
// limit, and is labelled as derived — never presented as measured.
//
// Run: npm run emu:start && npm run test:emu:load

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

/** Load runs are slow by construction. */
const LOAD_TIMEOUT_MS = 15 * 60 * 1000

interface Sample { ms: number; ok: boolean }

interface LoadResult {
  label:       string
  photos:      number
  concurrency: number
  totalMs:     number
  perSec:      number
  failures:    number
  p50:         number
  p95:         number
  worst:       number
}

function summarise(label: string, photos: number, concurrency: number,
                   totalMs: number, samples: Sample[]): LoadResult {
  const ok = samples.filter(s => s.ok).map(s => s.ms).sort((a, b) => a - b)
  const at = (p: number) => ok.length ? ok[Math.min(ok.length - 1, Math.floor(ok.length * p))] : 0
  return {
    label, photos, concurrency,
    totalMs:  Math.round(totalMs),
    perSec:   Number((photos / (totalMs / 1000)).toFixed(2)),
    failures: samples.filter(s => !s.ok).length,
    p50: at(0.50), p95: at(0.95), worst: ok.length ? ok[ok.length - 1] : 0,
  }
}

const TABLE: LoadResult[] = []

describeEmu('MC-05.6B · credit path load measurement', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let openSession: typeof import('@/features/media-credits/services/sessionService')['openSession']
  let deriveAssetId: typeof import('@/features/media-credits/utils/sessionSlots')['deriveAssetId']

  // Unique per PROCESS. Two load runs sharing one uid would delete each other's ledger
  // entries mid-run and produce a false invariant violation — which is exactly what an
  // accidental overlap produced once. The isolation is part of the instrument.
  const UID  = `emu-load-organizer-${process.pid}`
  const EVT  = { eventId: 'load-evt', eventSlug: 'load-evt', galleryId: 'load-gal' }

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    ;({ openSession } = await import('@/features/media-credits/services/sessionService'))
    ;({ deriveAssetId } = await import('@/features/media-credits/utils/sessionSlots'))
    const svc = await import('@/features/media-credits/services')
    ledgerService = svc.ledgerService
    walletService = svc.walletService

    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: 100,
      minCreditPurchase: 1, refundsEnabled: true, refundWindowDays: 30,
      refundServiceChargeMethod: 'percent', refundServiceChargePercent: 10,
      refundServiceChargeFixedPaise: 0, minRefundablePaise: 100,
    } as never)
  })

  afterAll(() => {
    businessConfig.clearRuntimeOverrides()
    if (TABLE.length) {
      console.log('\n═══ MC-05.6B · EMULATOR LOAD RESULTS ═══')
      console.table(TABLE.map(r => ({
        scenario: r.label, photos: r.photos, conc: r.concurrency,
        'total(s)': (r.totalMs / 1000).toFixed(1),
        'photos/s': r.perSec, fails: r.failures,
        'p50(ms)': r.p50, 'p95(ms)': r.p95, 'worst(ms)': r.worst,
      })))
    }
  })

  /**
   * THE guarantee, checked after every load scenario.
   *
   * This — not a failure count — is what must survive contention. A refused upload is the
   * design working (fail-closed); a balance that disagrees with the ledger would be the
   * design broken. Paginated, because these runs push the ledger past one query page.
   */
  async function assertInvariant() {
    let sum = 0
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
    for (;;) {
      let q = adminDb.collection('mediaCreditLedger')
        .where('organizerUid', '==', UID).orderBy('__name__').limit(500)
      if (cursor) q = q.startAfter(cursor)
      const snap = await q.get()
      if (snap.empty) break
      snap.docs.forEach(d => { sum += d.get('delta') as number })
      cursor = snap.docs[snap.docs.length - 1]
      if (snap.size < 500) break
    }
    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(sum)
    expect(b.available).toBeGreaterThanOrEqual(0)
  }

  /** Deletes this suite's data and seeds a balance large enough for the run. */
  async function reset(credits: number) {
    for (const col of ['mediaCreditLedger', 'mediaCreditReservations']) {
      // Batched deletes — a 10k-entry ledger cannot go in one batch (500 write cap).
      for (;;) {
        const snap = await adminDb.collection(col)
          .where('organizerUid', '==', UID).limit(400).get()
        if (snap.empty) break
        const b = adminDb.batch()
        snap.docs.forEach(d => b.delete(d.ref))
        await b.commit()
      }
    }
    await adminDb.doc(`mediaCreditWallets/${UID}`).delete()
    await ledgerService.credit({
      organizerUid: UID, entryId: `load-seed:${credits}:${Date.now()}`,
      credits, reason: 'grant', actorUid: 'load', actorKind: 'platform',
    })
  }

  /**
   * Simulates `photos` uploads through the REAL credit path — reserve (prepare) then
   * consume (complete) — at the uploader's real concurrency.
   *
   * Storage I/O is deliberately absent: this isolates the WALLET cost. The upload's own
   * network time is added back as context in the report, not measured here.
   */
  async function runLoad(label: string, photos: number, concurrency: number): Promise<LoadResult> {
    await reset(photos + 1000)

    // MC-06B: ONE session supplies the hold and the slot addressing for the whole run.
    // The wallet is touched once here and never again on the per-photo path.
    const loadSessionId = `${label}-${process.pid}-${Date.now()}`
    await openSession({
      sessionId: loadSessionId, organizerUid: UID, slotCount: photos, actorUid: 'load', ...EVT,
    })

    const samples: Sample[] = []
    let firstError = ''
    // Namespaced per PROCESS, like the uid. Reservation docs are keyed by assetId ALONE
    // (mediaCreditReservations/{assetId}) while reset() deletes by organizerUid, so a reused
    // assetId from an earlier process survives the wipe and  correctly refuses it —
    // MC-03 guarantees a consumed reservation id is spent forever.
    const ids = Array.from({ length: photos }, (_, i) => deriveAssetId(loadSessionId, i))
    let cursor = 0
    const started = performance.now()

    async function worker() {
      for (;;) {
        const i = cursor++
        if (i >= ids.length) return
        const assetId = ids[i]
        const t0 = performance.now()
        try {
          await ledgerService.reserve({
            organizerUid: UID, assetId, credits: 1, actorUid: 'load',
            sessionId: loadSessionId, slotIndex: i, ...EVT,
          })
          await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'load' })
          samples.push({ ms: performance.now() - t0, ok: true })
        } catch (err) {
          // Diagnostic: a silent catch turned a 200/200 failure into an invisible one.
          if (!firstError) firstError = err instanceof Error ? err.message : String(err)
          samples.push({ ms: performance.now() - t0, ok: false })
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker))
    const result = summarise(label, photos, concurrency, performance.now() - started, samples)
    if (result.failures) console.log(`[${label}] FIRST ERROR: ${firstError}`)
    TABLE.push(result)
    return result
  }

  // ── Baseline: what does ONE photo cost with no contention? ─────────────────

  it('measures the uncontended per-photo credit cost', async () => {
    const r = await runLoad('1-serial', 25, 1)
    console.log(`[serial] ${r.perSec} photos/s · p50 ${r.p50}ms · worst ${r.worst}ms`)
    await assertInvariant()
  }, LOAD_TIMEOUT_MS)

  // ── The real uploader concurrency ──────────────────────────────────────────

  it('100 photos at the uploader\'s real concurrency (4)', async () => {
    const r = await runLoad('100', 100, 4)
    console.log(`[100] ${r.perSec} photos/s · p50 ${r.p50}ms · p95 ${r.p95}ms · worst ${r.worst}ms · fails ${r.failures}`)
    await assertInvariant()
  }, LOAD_TIMEOUT_MS)

  it('500 photos at concurrency 4', async () => {
    const r = await runLoad('500', 500, 4)
    console.log(`[500] ${r.perSec} photos/s · p50 ${r.p50}ms · p95 ${r.p95}ms · worst ${r.worst}ms · fails ${r.failures}`)
    await assertInvariant()
  }, LOAD_TIMEOUT_MS)

  it('1000 photos at concurrency 4', async () => {
    const r = await runLoad('1000', 1000, 4)
    console.log(`[1000] ${r.perSec} photos/s · p50 ${r.p50}ms · p95 ${r.p95}ms · worst ${r.worst}ms · fails ${r.failures}`)
    await assertInvariant()
  }, LOAD_TIMEOUT_MS)

  // ── Does raising concurrency help, or does the wallet serialise it? ────────
  // THE diagnostic. If the wallet is the bottleneck, 16 concurrent workers finish no faster
  // than 4 — every transaction queues on the same document regardless.

  it('DIAGNOSTIC: does throughput scale with concurrency, or is it wallet-bound?', async () => {
    const c4  = await runLoad('scale-c4',  200, 4)
    const c16 = await runLoad('scale-c16', 200, 16)
    const gain = c16.perSec / c4.perSec
    console.log(`[scale] c4=${c4.perSec}/s  c16=${c16.perSec}/s  gain=${gain.toFixed(2)}x  ` +
                `retries→fails c4=${c4.failures} c16=${c16.failures}`)
    // Recorded, NOT asserted. Contention failures are the finding; asserting them away
    // would delete the evidence. What must hold is the invariant.
    await assertInvariant()
  }, LOAD_TIMEOUT_MS)

  // ── The financial invariant must survive the load ──────────────────────────

  it('THE invariant holds after sustained load', async () => {
    await runLoad('invariant', 200, 8)
    await assertInvariant()
  }, LOAD_TIMEOUT_MS)
})
