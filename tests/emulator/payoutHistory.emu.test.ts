// RD-FINANCE-CLOSURE-02 · Payout-profile audit trail — REAL Firestore (emulator).
//
// The pure rules (masking, diffing) are covered in tests/unit/payoutHistoryMask.test.ts.
// What can ONLY be proven against a real database is here:
//
//   • the profile change and its audit record commit ATOMICALLY (a batch)
//   • a failed commit leaves NO record and NO profile change
//   • records are APPEND-ONLY — `create` refuses to overwrite
//   • the read is scoped so organizer A can never see organizer B's trail
//   • repeated legitimate changes accumulate as separate entries
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const T = 60_000

describeEmu('RD-FINANCE-CLOSURE-02 · payout-profile change history', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let history: typeof import('@/lib/payout/history')
  let record:  typeof import('@/lib/payout/historyRecord')
  let enc:     typeof import('@/lib/payout/encryption')

  const ORG_A = `payout-a-${process.pid}`
  const ORG_B = `payout-b-${process.pid}`

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    history = await import('@/lib/payout/history')
    record  = await import('@/lib/payout/historyRecord')
    enc     = await import('@/lib/payout/encryption')
  })

  async function wipe() {
    for (const uid of [ORG_A, ORG_B]) {
      const snap = await adminDb.collection(history.PAYOUT_PROFILE_HISTORY)
        .where('organizerUid', '==', uid).get()
      const b = adminDb.batch()
      snap.docs.forEach(d => b.delete(d.ref))
      b.delete(adminDb.doc(`organizerPayoutProfiles/${uid}`))
      await b.commit()
    }
  }
  beforeEach(wipe)

  const bank = (acct: string, bankName = 'HDFC Bank'): record.PayoutSnapshot => ({
    accountHolderName: 'Asha Menon',
    payoutMethod: 'bank',
    bankName,
    accountNumber: acct,
    ifscCode: 'HDFC0001234',
    upiId: null,
    panNumber: 'ABCDE1234F',
    gstNumber: null,
  })

  /** Mirrors exactly what the PUT handler does: profile + record in ONE batch. */
  async function saveProfile(uid: string, actor: string, snap: record.PayoutSnapshot,
                             before: record.PayoutSnapshot | null, wasVerified = false) {
    const ref   = adminDb.doc(`organizerPayoutProfiles/${uid}`)
    const batch = adminDb.batch()
    batch.set(ref, {
      uid,
      accountHolderName: snap.accountHolderName,
      payoutMethod:      snap.payoutMethod,
      bankName:          snap.bankName,
      accountNumber:     enc.encryptPii(snap.accountNumber),
      ifscCode:          enc.encryptPii(snap.ifscCode),
      upiId:             snap.upiId,
      panNumber:         enc.encryptPii(snap.panNumber) ?? '',
      gstNumber:         snap.gstNumber,
      isVerified: false, verifiedAt: null, verifiedBy: null, rejectionNote: null,
    })
    history.stageHistoryRecord(batch, record.buildHistoryRecord({
      organizerUid: uid, actorUid: actor, before, after: snap,
      wasVerified, requestIp: '203.0.113.9', userAgent: 'emu',
    }))
    await batch.commit()
  }

  // ═══════════════════════════════════════════════════════════════════════════

  it('a FIRST payout-profile change writes exactly one record', async () => {
    await saveProfile(ORG_A, 'actor-1', bank('123456789012'), null)

    const entries = await history.listPayoutHistory(ORG_A)
    expect(entries).toHaveLength(1)
    expect(entries[0].action).toBe('created')
    expect(entries[0].previous).toBeNull()
    expect(entries[0].next.label).toBe('HDFC Bank ••••9012')
    expect(entries[0].actorUid).toBe('actor-1')
    expect(entries[0].createdAt).toBeTruthy()          // server timestamp resolved
    expect(entries[0].verificationReset).toBe(false)
  }, T)

  it('a SECOND change adds a separate record and keeps the first', async () => {
    const first = bank('123456789012')
    await saveProfile(ORG_A, 'actor-1', first, null)
    // The profile was verified in between; this change must record the reset.
    await saveProfile(ORG_A, 'actor-2', bank('999988887777', 'ICICI Bank'), first, true)

    const entries = await history.listPayoutHistory(ORG_A)
    expect(entries).toHaveLength(2)

    // Newest first.
    expect(entries[0].action).toBe('updated')
    expect(entries[0].actorUid).toBe('actor-2')
    expect(entries[0].previous?.label).toBe('HDFC Bank ••••9012')
    expect(entries[0].next.label).toBe('ICICI Bank ••••7777')
    expect(entries[0].changedFields.sort()).toEqual(['accountNumber', 'bankName'])
    expect(entries[0].verificationReset).toBe(true)

    // The earlier record is untouched — nothing overwrote it.
    expect(entries[1].action).toBe('created')
    expect(entries[1].actorUid).toBe('actor-1')
  }, T)

  it('repeated legitimate changes each get their own entry', async () => {
    let prev: record.PayoutSnapshot | null = null
    for (const acct of ['111111111111', '222222222222', '333333333333']) {
      const next = bank(acct)
      await saveProfile(ORG_A, 'actor-1', next, prev)
      prev = next
    }
    const entries = await history.listPayoutHistory(ORG_A)
    expect(entries).toHaveLength(3)
    expect(entries.map(e => e.next.accountMasked)).toEqual(['••••3333', '••••2222', '••••1111'])
  }, T)

  it('stores NO plaintext payout data in Firestore', async () => {
    await saveProfile(ORG_A, 'actor-1', bank('123456789012'), null)
    const snap = await adminDb.collection(history.PAYOUT_PROFILE_HISTORY)
      .where('organizerUid', '==', ORG_A).get()
    const raw = JSON.stringify(snap.docs.map(d => d.data()))

    for (const secret of ['123456789012', 'HDFC0001234', 'ABCDE1234F']) {
      expect(raw).not.toContain(secret)
    }
    // …and not an encrypted copy either.
    expect(raw).not.toContain('enc:v1:')
  }, T)

  it('is APPEND-ONLY — create refuses to overwrite an existing record', async () => {
    await saveProfile(ORG_A, 'actor-1', bank('123456789012'), null)
    const [doc] = (await adminDb.collection(history.PAYOUT_PROFILE_HISTORY)
      .where('organizerUid', '==', ORG_A).get()).docs

    const b = adminDb.batch()
    b.create(doc.ref, { organizerUid: ORG_A, tampered: true })
    await expect(b.commit()).rejects.toThrow()

    const after = await doc.ref.get()
    expect((after.data() as { tampered?: boolean }).tampered).toBeUndefined()
  }, T)

  it('a FAILED commit writes neither the profile change nor a record', async () => {
    // First save succeeds.
    await saveProfile(ORG_A, 'actor-1', bank('123456789012'), null)
    const before = await adminDb.doc(`organizerPayoutProfiles/${ORG_A}`).get()

    // Now a batch that stages a legitimate profile change AND a create that must fail
    // (the id already exists). Atomicity means the profile change is rolled back too.
    const existingId = (await adminDb.collection(history.PAYOUT_PROFILE_HISTORY)
      .where('organizerUid', '==', ORG_A).get()).docs[0].id

    const batch = adminDb.batch()
    batch.set(adminDb.doc(`organizerPayoutProfiles/${ORG_A}`),
      { ...before.data(), accountHolderName: 'SHOULD NOT PERSIST' })
    batch.create(adminDb.collection(history.PAYOUT_PROFILE_HISTORY).doc(existingId),
      { organizerUid: ORG_A })
    await expect(batch.commit()).rejects.toThrow()

    const after = await adminDb.doc(`organizerPayoutProfiles/${ORG_A}`).get()
    expect((after.data() as { accountHolderName: string }).accountHolderName).toBe('Asha Menon')
    expect(await history.listPayoutHistory(ORG_A)).toHaveLength(1)
  }, T)

  it('organizer A cannot read organizer B history', async () => {
    await saveProfile(ORG_A, 'actor-a', bank('111111111111'), null)
    await saveProfile(ORG_B, 'actor-b', bank('222222222222'), null)

    const a = await history.listPayoutHistory(ORG_A)
    const b = await history.listPayoutHistory(ORG_B)

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0].next.accountMasked).toBe('••••1111')
    expect(b[0].next.accountMasked).toBe('••••2222')
    expect(a.every(e => e.organizerUid === ORG_A)).toBe(true)
    expect(b.every(e => e.organizerUid === ORG_B)).toBe(true)
  }, T)

  it('RD-FINANCE-TAX-CLEANUP-01 · a supplied GSTIN round-trips and is audited', async () => {
    const withGst = { ...bank('123456789012'), gstNumber: '29ABCDE1234F1Z5' }
    await saveProfile(ORG_A, 'actor-1', withGst, null)

    const doc = (await adminDb.doc(`organizerPayoutProfiles/${ORG_A}`).get()).data() as
      { gstNumber: string | null }
    // Stored as-is: a GSTIN is a public business identifier, NOT PII like the PAN or the
    // account number, so it is deliberately not encrypted. Pinned so the distinction is a
    // decision rather than an accident.
    expect(doc.gstNumber).toBe('29ABCDE1234F1Z5')

    // It is an audited field, so changing it is recorded.
    await saveProfile(ORG_A, 'actor-1', { ...withGst, gstNumber: '27AADCB2230M1ZT' }, withGst)
    const entries = await history.listPayoutHistory(ORG_A)
    expect(entries[0].changedFields).toEqual(['gstNumber'])
  }, T)

  it('RD-FINANCE-TAX-CLEANUP-01 · an ABSENT GSTIN keeps its optional semantics', async () => {
    // bank() supplies gstNumber: null — the common case. It must still save.
    await saveProfile(ORG_A, 'actor-1', bank('123456789012'), null)
    const doc = (await adminDb.doc(`organizerPayoutProfiles/${ORG_A}`).get()).data() as
      { gstNumber: string | null }
    expect(doc.gstNumber).toBeNull()
    expect(await history.listPayoutHistory(ORG_A)).toHaveLength(1)
  }, T)

  it('the encrypted profile still round-trips — verification semantics unchanged', async () => {
    await saveProfile(ORG_A, 'actor-1', bank('123456789012'), null)
    const doc = (await adminDb.doc(`organizerPayoutProfiles/${ORG_A}`).get()).data() as {
      accountNumber: string; isVerified: boolean; verifiedAt: unknown; verifiedBy: unknown
    }
    // Still encrypted at rest, still decryptable, still reset to unverified.
    expect(doc.accountNumber.startsWith('enc:v1:')).toBe(true)
    expect(enc.decryptPii(doc.accountNumber)).toBe('123456789012')
    expect(doc.isVerified).toBe(false)
    expect(doc.verifiedAt).toBeNull()
    expect(doc.verifiedBy).toBeNull()
  }, T)
})
