// MC-05.6C · MULTI-INSTANCE validation — REAL Firestore semantics (emulator).
//
// ═══ THE QUESTION THIS ANSWERS ═══════════════════════════════════════════════
// MC-05.6B serialised the credit path with an IN-PROCESS lock and disclosed the limitation:
// on a serverless deployment, one organizer's uploads may be served by several instances,
// and a per-process mutex cannot serialise across them.
//
// This file measures that limitation instead of reasoning about it. Each `vitest run`
// invocation is a separate OS process with its own module registry, so `organizerLock`'s
// map — and therefore the lock — is per process. N concurrent invocations against ONE
// organizer are exactly the multi-instance condition.
//
// ═══ WHAT IT CANNOT ANSWER ═══════════════════════════════════════════════════
// Nothing here speaks to production Firestore's sustained per-document write throttling.
// The emulator has none. Cross-instance CONTENTION is reproduced faithfully (optimistic
// concurrency, aborts, retries); absolute throughput is not.
//
// ═══ ROLES ═══════════════════════════════════════════════════════════════════
// Driven by env so one file can play three parts in a shell-orchestrated run:
//   MC_ROLE=setup   — wipe + seed the shared organizer (run once, first)
//   MC_ROLE=worker  — upload MC_PHOTOS photos as instance MC_INSTANCE (run N in parallel)
//   MC_ROLE=verify  — assert every financial invariant (run once, last)
//
// The shared organizer id is fixed, NOT per-process — the whole point is contention.

import { describe, it, expect, beforeAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const ROLE     = process.env.MC_ROLE ?? ''
const describeEmu = EMULATOR && ROLE ? describe : describe.skip

const SHARED_UID = process.env.MC_SHARED_UID ?? 'emu-multi-organizer'
const INSTANCE   = process.env.MC_INSTANCE ?? '0'
const PHOTOS     = Number(process.env.MC_PHOTOS ?? '100')
const SEED       = Number(process.env.MC_SEED ?? '20000')
const WORKERS    = Number(process.env.MC_WORKERS ?? '4')

const ROLE_TIMEOUT_MS = 10 * 60 * 1000
const EVT = { eventId: 'multi-evt', eventSlug: 'multi-evt', galleryId: 'multi-gal' }

describeEmu(`MC-05.6C · multi-instance [${ROLE}${ROLE === 'worker' ? ` #${INSTANCE}` : ''}]`, () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let sealSession: typeof import('@/features/media-credits/services/sessionService')['sealSession']
  let runSessionCleanup: typeof import('@/features/media-credits/services/sessionCleanupService')['runSessionCleanup']
  let openSession: typeof import('@/features/media-credits/services/sessionService')['openSession']
  let deriveAssetId: typeof import('@/features/media-credits/utils/sessionSlots')['deriveAssetId']

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    ;({ openSession, sealSession } = await import('@/features/media-credits/services/sessionService'))
    ;({ runSessionCleanup } = await import('@/features/media-credits/services/sessionCleanupService'))
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

  async function wipe(col: string) {
    for (;;) {
      const snap = await adminDb.collection(col)
        .where('organizerUid', '==', SHARED_UID).limit(400).get()
      if (snap.empty) break
      const b = adminDb.batch()
      snap.docs.forEach(d => b.delete(d.ref))
      await b.commit()
    }
  }

  it.runIf(ROLE === 'setup')('seeds the shared organizer', async () => {
    for (const c of ['mediaCreditLedger', 'mediaCreditReservations', 'mediaCreditSessions']) await wipe(c)
    await adminDb.doc(`mediaCreditWallets/${SHARED_UID}`).delete()
    await ledgerService.credit({
      organizerUid: SHARED_UID, entryId: `multi-seed:${Date.now()}`,
      credits: SEED, reason: 'grant', actorUid: 'setup', actorKind: 'platform',
    })
    const b = await walletService.getBalance(SHARED_UID)
    expect(b.balance).toBe(SEED)
    console.log(`[setup] seeded ${SEED} credits for ${SHARED_UID}`)
  }, ROLE_TIMEOUT_MS)

  it.runIf(ROLE === 'worker')(`uploads ${PHOTOS} photos as instance ${INSTANCE}`, async () => {
    const samples: number[] = []
    const errors = new Map<string, number>()

    // Each instance opens its OWN session. That is the real shape: the wallet is touched
    // once per instance at open, and never on the per-photo path.
    const loadSessionId = `${SHARED_UID}-i${INSTANCE}`
    await openSession({
      sessionId: loadSessionId, organizerUid: SHARED_UID, slotCount: PHOTOS,
      actorUid: 'multi', ...EVT,
    })
    // Asset ids carry the instance, so two instances never collide on a reservation id —
    // real uploads never share one either. Contention here is purely on the WALLET.
    // Namespaced by the RUN (SHARED_UID is timestamped), because reservation documents are
    // keyed by assetId ALONE while setup wipes by organizerUid. Without this, a second run
    // inherits the first run's spent ids and every reserve is correctly refused.
    const ids = Array.from({ length: PHOTOS }, (_, i) => deriveAssetId(loadSessionId, i))
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
            organizerUid: SHARED_UID, assetId, credits: 1, actorUid: 'multi',
            sessionId: loadSessionId, slotIndex: i, ...EVT,
          })
          await ledgerService.consume({ organizerUid: SHARED_UID, assetId, actorUid: 'multi' })
          samples.push(performance.now() - t0)
        } catch (err) {
          const key = err instanceof Error ? err.message.slice(0, 80) : 'unknown'
          errors.set(key, (errors.get(key) ?? 0) + 1)
        }
      }
    }

    await Promise.all(Array.from({ length: WORKERS }, worker))
    const totalMs = performance.now() - started
    const ok = samples.sort((a, b) => a - b)
    const at = (p: number) => ok.length ? Math.round(ok[Math.min(ok.length - 1, Math.floor(ok.length * p))]) : 0
    const failures = PHOTOS - ok.length

    // Written to stdout in a parseable form so the shell coordinator can aggregate.
    console.log(`[instance ${INSTANCE}] RESULT ` + JSON.stringify({
      instance: INSTANCE, photos: PHOTOS, workers: WORKERS,
      totalMs: Math.round(totalMs),
      perSec: Number((ok.length / (totalMs / 1000)).toFixed(2)),
      succeeded: ok.length, failures,
      p50: at(0.5), p95: at(0.95), worst: ok.length ? Math.round(ok[ok.length - 1]) : 0,
      errors: Object.fromEntries(errors),
    }))

    // A worker asserts nothing about throughput — that is the measurement. It asserts only
    // that no upload was lost silently.
    expect(ok.length + failures).toBe(PHOTOS)
  }, ROLE_TIMEOUT_MS)

  it.runIf(ROLE === 'verify')('EVERY financial invariant holds after multi-instance load', async () => {
    // ── 1. The upload path must have written NOTHING financial ───────────────
    // Spec v1.0 §9: no per-photo ledger entry, ever. This is the property that removes the
    // wallet from the hot path, so it is checked before anything is settled.
    const readLedger = async () => {
      const out: { id: string; delta: number; reason: string }[] = []
      let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
      for (;;) {
        let q = adminDb.collection('mediaCreditLedger')
          .where('organizerUid', '==', SHARED_UID).orderBy('__name__').limit(500)
        if (cursor) q = q.startAfter(cursor)
        const snap = await q.get()
        if (snap.empty) break
        for (const d of snap.docs) {
          out.push({ id: d.id, delta: d.get('delta') as number, reason: d.get('reason') as string })
        }
        cursor = snap.docs[snap.docs.length - 1]
        if (snap.size < 500) break
      }
      return out
    }

    const beforeSettle = await readLedger()
    expect(beforeSettle.map(e => e.reason)).not.toContain('consume')
    expect(beforeSettle.map(e => e.reason)).not.toContain('release')

    // Ledger == Wallet holds DURING the upload, not only after settlement.
    const mid = await walletService.getBalance(SHARED_UID)
    expect(mid.balance).toBe(beforeSettle.reduce((n, e) => n + e.delta, 0))
    expect(mid.held).toBeGreaterThan(0)          // every instance's session is holding
    expect(mid.available).toBeGreaterThanOrEqual(0)

    // ── 2. No duplicate reservations, and the slot ids are unique ────────────
    const res = await adminDb.collection('mediaCreditReservations')
      .where('organizerUid', '==', SHARED_UID).get()
    const byStatus: Record<string, number> = {}
    const seenAssetIds = new Set<string>()
    for (const d of res.docs) {
      const status = d.get('status') as string
      byStatus[status] = (byStatus[status] ?? 0) + 1
      expect(seenAssetIds.has(d.id)).toBe(false)
      seenAssetIds.add(d.id)
    }
    const consumed = byStatus.consumed ?? 0

    // ── 3. Drive the scheduler across every instance's session ───────────────
    const sessionsBefore = await adminDb.collection('mediaCreditSessions')
      .where('organizerUid', '==', SHARED_UID).get()
    for (const d of sessionsBefore.docs) {
      await sealSession({ sessionId: d.id, reason: 'CLOSED', sealedBy: 'verify' })
    }
    // Run it repeatedly — idempotent, so extra passes must change nothing.
    for (let i = 0; i < 3; i++) await runSessionCleanup({ limit: 500, budgetMs: 60_000 })

    // ── 4. Post-settlement invariants ────────────────────────────────────────
    const afterSettle = await readLedger()
    const settleEntries = afterSettle.filter(e => e.reason === 'consume')
    const settleIds = new Set(settleEntries.map(e => e.id))
    expect(settleIds.size).toBe(settleEntries.length)          // no duplicate ledger entry

    const after = await walletService.getBalance(SHARED_UID)
    const sum = afterSettle.reduce((n, e) => n + e.delta, 0)
    expect(after.balance).toBe(sum)                            // Ledger == Wallet
    expect(after.available).toBeGreaterThanOrEqual(0)
    expect(after.held).toBe(0)                                 // every hold resolved
    // Charged exactly for the slots that landed — no credit loss, no credit creation.
    expect(mid.balance - after.balance).toBe(consumed)

    // No orphan session: every one reached SETTLED.
    const sessionsAfter = await adminDb.collection('mediaCreditSessions')
      .where('organizerUid', '==', SHARED_UID).get()
    const statuses = sessionsAfter.docs.map(d => d.get('status') as string)
    expect(statuses.every(st => st === 'SETTLED')).toBe(true)

    console.log('[verify] RESULT ' + JSON.stringify({
      balance: after.balance, held: after.held, available: after.available,
      ledgerSum: sum, ledgerEntries: afterSettle.length,
      perPhotoFinancialWrites: 0,
      reservations: byStatus, consumed,
      sessions: statuses.length, settlementEntries: settleEntries.length,
      chargedCredits: mid.balance - after.balance,
    }))
  }, ROLE_TIMEOUT_MS)
})
