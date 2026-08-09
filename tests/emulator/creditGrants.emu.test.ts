// MC-09 · Manual grant integration tests — REAL Firestore (emulator).
//
// What needs a real database here is ATOMICITY and IDEMPOTENCY. A grant writes a ledger
// entry, a wallet balance and a justification record in one transaction, and the claim that a
// replay cannot create a second grant is a claim about Firestore's transaction boundary and
// `tx.create` semantics. A mock cannot prove either.
//
// ═══ HOW TO RUN ══════════════════════════════════════════════════════════════
//   npm run emu:start        # requires JDK 21+
//   npm run test:emu
//
// Skips automatically without FIRESTORE_EMULATOR_HOST. Refuses to run outside a `demo-`
// project, because it deletes documents.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

/** Budget for contended tests — several transactions on ONE wallet doc, retried with backoff. */
const CONTENTION_TIMEOUT_MS = 30_000

describeEmu('MC-09 · manual credit grants against the Firestore emulator', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let svc: typeof import('@/features/media-credits/services/grantService')
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let errs: typeof import('@/features/media-credits/errors')

  const UID   = 'emu-grant-organizer'
  const ADMIN = 'emu-super-admin'

  const base = {
    organizerUid: UID,
    credits:      500,
    reason:       'goodwill',
    note:         'Compensating a failed import batch.',
    actorUid:     ADMIN,
  }

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    svc = await import('@/features/media-credits/services/grantService')
    ;({ walletService, ledgerService } = await import('@/features/media-credits/services'))
    errs = await import('@/features/media-credits/errors')
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  function enableCredits(patch: Record<string, unknown> = {}) {
    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: 100,
      minCreditPurchase: 1, ...patch,
    } as never)
  }

  async function reset() {
    businessConfig.clearRuntimeOverrides()
    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    for (const col of ['mediaCreditLedger', 'mediaCreditGrants']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()
    enableCredits()
  }

  beforeEach(async () => { await reset() })

  const ledgerFor = async (entryId: string) =>
    (await adminDb.doc(`mediaCreditLedger/${entryId}`).get()).data()

  // ── Successful grant ───────────────────────────────────────────────────────

  it('credits the wallet, appends the ledger entry and records the justification', async () => {
    const r = await svc.createGrant({ ...base, grantId: 'g_ok' })

    expect(r.created).toBe(true)
    expect(r.grant.credits).toBe(500)
    expect(r.grant.entryId).toBe('grant:g_ok')

    const balance = await walletService.getBalance(UID)
    expect(balance.balance).toBe(500)
    expect(balance.available).toBe(500)
    // A grant is a lifetime addition, exactly like a purchase.
    expect(balance.lifetimeGranted).toBe(500)

    const entry = await ledgerFor('grant:g_ok')
    expect(entry?.delta).toBe(500)
    expect(entry?.reason).toBe('grant')
    expect(entry?.actorKind).toBe('platform')
    expect(entry?.actorUid).toBe(ADMIN)

    const grant = (await adminDb.doc('mediaCreditGrants/g_ok').get()).data()
    expect(grant?.note).toBe(base.note)
    expect(grant?.reason).toBe('goodwill')
    expect(grant?.actorUid).toBe(ADMIN)
    // The record points at the movement it caused, so neither can be read without the other.
    expect(grant?.entryId).toBe('grant:g_ok')
    expect(grant?.balanceAfter).toBe(500)
  })

  it('stores the normalised value, not the raw input', async () => {
    const r = await svc.createGrant({
      ...base, grantId: 'g_norm',
      note: '   padded justification text   ',
      reference: '  TICKET-42  ',
    })
    expect(r.grant.note).toBe('padded justification text')
    expect(r.grant.reference).toBe('TICKET-42')
  })

  it('accumulates across grants rather than replacing the balance', async () => {
    await svc.createGrant({ ...base, grantId: 'g_a', credits: 100 })
    await svc.createGrant({ ...base, grantId: 'g_b', credits: 250 })

    const balance = await walletService.getBalance(UID)
    expect(balance.balance).toBe(350)
    expect(balance.lifetimeGranted).toBe(350)
  })

  // ── Duplicate / replay ─────────────────────────────────────────────────────

  it('a replayed grantId returns the original and credits NOTHING further', async () => {
    const first  = await svc.createGrant({ ...base, grantId: 'g_replay' })
    const second = await svc.createGrant({ ...base, grantId: 'g_replay' })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.grant.grantId).toBe(first.grant.grantId)

    expect((await walletService.getBalance(UID)).balance).toBe(500)
  })

  it('a replay with DIFFERENT numbers does not amend the original', async () => {
    // The id is the identity. Re-sending it with a bigger amount must not top up the grant —
    // that would make an idempotency key into an edit mechanism.
    await svc.createGrant({ ...base, grantId: 'g_amend', credits: 500 })
    const again = await svc.createGrant({ ...base, grantId: 'g_amend', credits: 9_000 })

    expect(again.created).toBe(false)
    expect(again.grant.credits).toBe(500)
    expect((await walletService.getBalance(UID)).balance).toBe(500)
  })

  it('writes exactly ONE ledger entry for a replayed grant', async () => {
    await svc.createGrant({ ...base, grantId: 'g_once' })
    await svc.createGrant({ ...base, grantId: 'g_once' })
    await svc.createGrant({ ...base, grantId: 'g_once' })

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    expect(snap.size).toBe(1)
  })

  // ── Concurrency ────────────────────────────────────────────────────────────

  it('concurrent grants with ONE id produce one grant', async () => {
    // The double-clicked button, and the reason `tx.create` backstops the read check.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => svc.createGrant({ ...base, grantId: 'g_race' })),
    )

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(5)          // none surface an error to the admin

    const created = fulfilled
      .filter(r => (r as PromiseFulfilledResult<{ created: boolean }>).value.created)
    expect(created).toHaveLength(1)            // exactly one actually granted

    expect((await walletService.getBalance(UID)).balance).toBe(500)

    const snap = await adminDb.collection('mediaCreditGrants')
      .where('organizerUid', '==', UID).get()
    expect(snap.size).toBe(1)
  }, CONTENTION_TIMEOUT_MS)

  it('concurrent grants with DISTINCT ids all land, and the balance is their sum', async () => {
    const n = 6
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        svc.createGrant({ ...base, grantId: `g_par_${i}`, credits: 100 })),
    )
    expect((await walletService.getBalance(UID)).balance).toBe(n * 100)
  }, CONTENTION_TIMEOUT_MS)

  // ── Invariants ─────────────────────────────────────────────────────────────

  it('I1 · balance equals the sum of ledger deltas', async () => {
    await svc.createGrant({ ...base, grantId: 'g_i1_a', credits: 300 })
    await svc.createGrant({ ...base, grantId: 'g_i1_b', credits: 125 })

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.data().delta as number), 0)

    expect((await walletService.getBalance(UID)).balance).toBe(sum)
  })

  it('every grant document has a matching ledger entry', async () => {
    await svc.createGrant({ ...base, grantId: 'g_pair_a' })
    await svc.createGrant({ ...base, grantId: 'g_pair_b' })

    const grants = await adminDb.collection('mediaCreditGrants')
      .where('organizerUid', '==', UID).get()
    expect(grants.size).toBe(2)

    for (const d of grants.docs) {
      const entry = await ledgerFor(d.data().entryId as string)
      expect(entry).toBeDefined()
      expect(entry?.delta).toBe(d.data().credits)
    }
  })

  it('balanceAfter on the grant matches the ledger snapshot', async () => {
    await svc.createGrant({ ...base, grantId: 'g_snap_a', credits: 100 })
    await svc.createGrant({ ...base, grantId: 'g_snap_b', credits: 400 })

    const grant = (await adminDb.doc('mediaCreditGrants/g_snap_b').get()).data()
    const entry = await ledgerFor('grant:g_snap_b')
    expect(grant?.balanceAfter).toBe(entry?.balanceAfter)
    expect(grant?.balanceAfter).toBe(500)
  })

  // ── Rejection ──────────────────────────────────────────────────────────────

  it('refuses invalid amounts and writes NOTHING', async () => {
    for (const credits of [0, -100, 10.5, Number.NaN]) {
      await expect(
        svc.createGrant({ ...base, grantId: `g_bad_${credits}`, credits }),
      ).rejects.toBeInstanceOf(errs.InvalidCreditOperationError)
    }

    const snap = await adminDb.collection('mediaCreditGrants')
      .where('organizerUid', '==', UID).get()
    expect(snap.size).toBe(0)
    expect((await walletService.getBalance(UID)).balance).toBe(0)
  })

  it('refuses a grant with no justification', async () => {
    await expect(
      svc.createGrant({ ...base, grantId: 'g_nonote', note: 'no' }),
    ).rejects.toBeInstanceOf(errs.InvalidCreditOperationError)
  })

  it('refuses an unknown reason', async () => {
    await expect(
      svc.createGrant({ ...base, grantId: 'g_badreason', reason: 'vibes' }),
    ).rejects.toBeInstanceOf(errs.InvalidCreditOperationError)
  })

  it('refuses to grant while credits are switched off', async () => {
    // Otherwise the grant creates a liability the organizer cannot see or spend — their
    // dashboard renders "credits are not in use on this account".
    businessConfig.setRuntimeOverride('mediaStudio', { creditsEnabled: false } as never)
    await expect(
      svc.createGrant({ ...base, grantId: 'g_off' }),
    ).rejects.toBeInstanceOf(errs.CreditsDisabledError)

    enableCredits()
    expect((await walletService.getBalance(UID)).balance).toBe(0)
  })

  it('requires a grant id — the idempotency key is never server-minted', async () => {
    await expect(
      svc.createGrant({ ...base, grantId: '' }),
    ).rejects.toBeInstanceOf(errs.InvalidCreditOperationError)
  })

  // ── History ────────────────────────────────────────────────────────────────

  it('lists grants newest first and scopes to one organizer', async () => {
    await svc.createGrant({ ...base, grantId: 'g_h1', credits: 100 })
    await svc.createGrant({ ...base, grantId: 'g_h2', credits: 200 })
    await svc.createGrant({
      ...base, grantId: 'g_other', organizerUid: 'emu-grant-other', credits: 900,
    })

    const page = await svc.listGrants(UID, 25)
    expect(page.grants).toHaveLength(2)
    expect(page.grants.every(g => g.organizerUid === UID)).toBe(true)
    expect(page.grants[0].grantId).toBe('g_h2')          // newest first

    // Tidy the other workspace's wallet — `reset` only clears UID.
    await adminDb.doc('mediaCreditWallets/emu-grant-other').delete()
    await adminDb.doc('mediaCreditGrants/g_other').delete()
    await adminDb.doc('mediaCreditLedger/grant:g_other').delete()
  })

  it('the history carries the full audit record', async () => {
    await svc.createGrant({
      ...base, grantId: 'g_full', reason: 'compensation',
      note: 'Refunded a failed batch after support ticket.', reference: 'ZD-9182',
    })

    const [g] = (await svc.listGrants(UID, 5)).grants
    expect(g.grantId).toBe('g_full')
    expect(g.organizerUid).toBe(UID)
    expect(g.actorUid).toBe(ADMIN)
    expect(g.reason).toBe('compensation')
    expect(g.note).toContain('support ticket')
    expect(g.reference).toBe('ZD-9182')
    expect(g.credits).toBe(500)
    expect(g.createdAtMs).toBeGreaterThan(0)
    expect(g.entryId).toBe('grant:g_full')
  })

  // ── The LedgerService member ───────────────────────────────────────────────

  it('ledgerService.grant is implemented and routes to the SAME path', async () => {
    // MC-09's definition of done: no NotImplementedError remains for granting.
    await ledgerService.grant({
      organizerUid: UID, grantId: 'g_via_ledger', credits: 75,
      reason: 'support', note: 'Granted through the ledger service facade.',
      actorUid: ADMIN,
    })

    expect((await walletService.getBalance(UID)).balance).toBe(75)
    // Same entry id shape ⇒ the same single writer, not a parallel path.
    expect(await ledgerFor('grant:g_via_ledger')).toBeDefined()
    expect((await adminDb.doc('mediaCreditGrants/g_via_ledger').get()).exists).toBe(true)
  })

  // ── Interaction with the rest of the module ────────────────────────────────

  it('granted credits are spendable — held reduces available', async () => {
    await svc.createGrant({ ...base, grantId: 'g_spend', credits: 1_000 })

    const { sessionService } = await import('@/features/media-credits/services/sessionService')
    await sessionService.openSession({
      sessionId: 'sess_grant_spend', organizerUid: UID,
      eventId: 'evt', eventSlug: 'evt', galleryId: 'gal',
      slotCount: 200, actorUid: UID,
    })

    const balance = await walletService.getBalance(UID)
    expect(balance.balance).toBe(1_000)
    expect(balance.held).toBe(200)
    expect(balance.available).toBe(800)

    await adminDb.doc('mediaCreditSessions/sess_grant_spend').delete()
  })
})
