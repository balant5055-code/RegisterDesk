// M1.2 — approved-payout rejection needs an explicit "no transfer was made" (policy A), and the changed-destination
// exception records a transfer that ALREADY completed (policy B). REAL Firestore, REAL routes; synthetic data only.
// Nothing here makes, retries or authorizes a bank transfer — RegisterDesk only records them.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

/** RD-SETTLE-PAY-02 — recording a payment requires the explicit confirmation; tests opt OUT by passing it themselves. */
const PAYMENT_ACTIONS = new Set(['paid', 'record_transfer', 'transfer_exception_approve'])
const withTransferConfirmed = (b: Record<string, unknown>) =>
  PAYMENT_ACTIONS.has(String(b.action)) && !('confirmTransferCompleted' in b) ? { ...b, confirmTransferCompleted: true } : b

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000
const SUPER = `m12-super-${P}`, SUPER2 = `m12-super2-${P}`, SUPER3 = `m12-super3-${P}`, NOBODY = `m12-nobody-${P}`

const h = vi.hoisted(() => ({ who: '' as string, admin: '' as string, captured: [] as Array<{ scope?: unknown }> }))
vi.mock('@/lib/monitoring/sentry', async orig => ({
  ...(await orig<typeof import('@/lib/monitoring/sentry')>()),
  captureFinancialError: (_e: unknown, ctx?: { scope?: unknown }) => { h.captured.push(ctx ?? {}) },
  captureError: () => undefined,
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_m12', RAZORPAY_KEY_SECRET: 'm12',
  razorpay: { payments: {
    refund: async () => { throw new Error('no refund may be created in this suite') },
    fetchMultipleRefund: async () => ({ entity: 'collection', count: 0, items: [] }),
  } },
}))
// identity: a per-request 'Bearer as:<uid>' token wins (concurrent requests), else the current h.admin
const who = (header: string | null) => (header?.startsWith('Bearer as:') ? header.slice('Bearer as:'.length) : h.admin)
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async (hd: string | null) => ([SUPER, SUPER2, SUPER3].includes(who(hd)) ? who(hd) : null),
  legacyAdminClaimOnly: async (hd: string | null) => who(hd) === NOBODY,
  resolveSuperAdminUid: async (hd: string | null) => ([SUPER, SUPER2, SUPER3].includes(who(hd)) ? who(hd) : null),
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))

const req = (body?: unknown, method = 'POST') => new NextRequest('http://localhost/api/test', {
  method, headers: { 'Content-Type': 'application/json', authorization: 'Bearer t' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

describeEmu('M1.2 · approved-payout rejection + changed-destination transfer exception', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let reconcileWallet: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
  const savedAdminUids = process.env.ADMIN_UIDS
  const created = new Set<string>()
  const orgs = new Set<string>()
  const utrs = new Set<string>()
  let n = 0

  const PROFILE_MS = Date.parse('2026-09-01T10:00:00.000Z')
  async function organizer(tag: string) {
    const uid = `m12-org-${tag}-${P}-${++n}`
    orgs.add(uid)
    const put = async (path: string, d: Record<string, unknown>) => { await db.doc(path).set(d); created.add(path) }
    await put(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })
    await put(`organizerPayoutProfiles/${uid}`, {
      uid, accountHolderName: 'Test Holder', payoutMethod: 'bank', bankName: 'HDFC Bank', accountNumber: '123456789012', ifscCode: 'HDFC0001234',
      upiId: null, panNumber: 'ABCDE1234F', gstNumber: null, isVerified: true, verifiedAt: FS.Timestamp.fromMillis(PROFILE_MS + 1000), verifiedBy: SUPER,
      verifiedVersion: PROFILE_MS, rejectionNote: null, createdAt: FS.Timestamp.fromMillis(PROFILE_MS), updatedAt: FS.Timestamp.fromMillis(PROFILE_MS + 1000),
    })
    return uid
  }
  /** the organizer changes bank details and they are re-verified: a NEW binding version */
  const changeDestination = (uid: string) => db.doc(`organizerPayoutProfiles/${uid}`).update({ verifiedVersion: PROFILE_MS + 77_000, accountNumber: '999988887777' })
  async function released(uid: string, net: number) {
    const id = `m12-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: `m12-ev-${P}`, entityType: 'event', sourceId: id, sourceType: 'registration',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
      gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR',
      gateway: 'razorpay', gatewayPaymentId: `p_${id}`, gatewayOrderId: `o_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - 30 * DAY) })
    await release({ limit: 500 })
    return { id, ptxId: `ptx_${id}` }
  }
  const request = async (uid: string, amountPaise: number) => {
    const { POST } = await import('@/app/api/organizer/settlements/route')
    h.who = uid
    const r = await json(await POST(req({ amountPaise })))
    h.who = ''
    return r
  }
  const settle = async (id: string, body: Record<string, unknown>, as = SUPER) => {
    const { PATCH } = await import('@/app/api/admin/settlements/[id]/route')
    h.admin = as
    return json(await PATCH(req(withTransferConfirmed(body), 'PATCH'), ctx(id)))
  }
  /** an approved request (approved by SUPER) */
  const approved = async (uid: string, amountPaise: number) => {
    const r = await request(uid, amountPaise)
    expect(r.status).toBe(201)
    const id = r.body.id as string
    expect((await settle(id, { action: 'approve', reason: 'checked for test' }, SUPER)).status).toBe(200)
    return id
  }
  const reqDoc = async (id: string) => (await db.doc(`settlementRequests/${id}`).get()).data()!
  const wallet = async (uid: string) => {
    const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!
    return { pending: w.pendingPaise as number, available: w.availablePaise as number, inTransit: (w.inTransitPaise ?? 0) as number, settled: (w.settledPaise ?? 0) as number }
  }
  const auditRows = async (entityId: string, action: string) =>
    (await db.collection('adminAuditLogs').where('entityId', '==', entityId).where('action', '==', action).get()).docs.map(d => d.data())
  const check = async (uid: string) =>
    (await reconcileWallet(uid, (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!)).map(m => [m.field, m.expected, m.actual])
  const clawbacksOf = async (uid: string) => (await db.collection('walletClawbacks').where('organizerUid', '==', uid).get()).docs.map(d => ({ id: d.id, ...d.data() }))
  let utrN = 0
  const newUtr = () => { const u = `M12UTR${P}X${++utrN}`; utrs.add(u); return u }
  /** evidence matching the request's own destination snapshot */
  const evidenceFor = async (id: string, over: Record<string, unknown> = {}) => {
    const snap = (await reqDoc(id)).payoutDestination as { verifiedVersion: number; label: string | null }
    return { originalDestination: { verifiedVersion: snap.verifiedVersion, label: snap.label }, transfer: { source: 'bank_statement', reference: 'STMT-OCT-ref-A', observation: 'transfer_completed', ...over } }
  }
  const initiate = async (id: string, utr: string, as = SUPER, extra: Record<string, unknown> = {}) =>
    settle(id, { action: 'transfer_exception_initiate', reason: 'transfer completed before the bank change', utrNumber: utr, evidence: await evidenceFor(id), ...extra }, as)
  const approveEx = async (id: string, as: string, over: Record<string, unknown> = {}) => {
    const ex = (await reqDoc(id)).transferException as { amountPaise: number; utrNumber: string; fingerprint: string }
    return settle(id, { action: 'transfer_exception_approve', reason: 'evidence verified by second admin', utrNumber: ex.utrNumber, expectedAmountPaise: ex.amountPaise, evidenceFingerprint: ex.fingerprint, ...over }, as)
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    process.env.ADMIN_UIDS = `${SUPER},${SUPER2},${SUPER3}`
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    reconcileWallet = (await import('@/lib/reconciliation/wallets')).reconcileOneWallet
  }, T)
  afterAll(async () => {
    process.env.ADMIN_UIDS = savedAdminUids
    for (const p of created) await db.doc(p).delete().catch(() => null)
    for (const uid of orgs) {
      const s = await db.collection('settlementRequests').where('organizerUid', '==', uid).get()
      for (const d of s.docs) await d.ref.delete().catch(() => null)
    }
    for (const u of utrs) await db.doc(`payoutTransferReferences/${u}`).delete().catch(() => null)
  }, T)
  beforeEach(() => { h.who = ''; h.admin = ''; h.captured.length = 0 })
  afterEach(() => { vi.restoreAllMocks() })

  // ═══ A · rejecting an approved payout ═══════════════════════════════════════════════════════
  it('A1 · an approved payout OUTSIDE review: rejection without confirmation is refused with no writes; a non-boolean confirmation is refused too', async () => {
    const uid = await organizer('a1')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)
    const docBefore = await reqDoc(id), wBefore = await wallet(uid)
    for (const extra of [{}, { confirmNoTransfer: 'true' }, { confirmNoTransfer: 1 }]) {
      expect(await settle(id, { action: 'reject', reason: 'not needed', ...extra }, SUPER2)).toMatchObject({ status: 409, body: { code: 'TRANSFER_CONFIRMATION_REQUIRED' } })
    }
    expect(await reqDoc(id)).toEqual(docBefore)
    expect(await wallet(uid)).toEqual(wBefore)
    expect(await auditRows(id, 'settlement.rejected')).toHaveLength(0)
  }, T)

  it('A2 · with the explicit confirmation the rejection is valid: hold released once; the audit row carries the reason and the confirmation', async () => {
    const uid = await organizer('a2')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)
    expect(await wallet(uid)).toMatchObject({ inTransit: 6_000 })
    expect((await settle(id, { action: 'reject', reason: 'organizer cancelled; bank shows no transfer', confirmNoTransfer: true }, SUPER2)).status).toBe(200)
    expect(await reqDoc(id)).toMatchObject({ status: 'rejected', rejectedBy: SUPER2 })
    expect(await wallet(uid)).toMatchObject({ available: 10_000, inTransit: 0 })
    const [row] = await auditRows(id, 'settlement.rejected')
    expect(row).toMatchObject({ reason: 'organizer cancelled; bank shows no transfer', metadata: { confirmNoTransfer: true, releasedHoldPaise: 6_000 } })
    expect(await check(uid)).toEqual([])
    // a PENDING request is unaffected by the rule
    const p = (await request(uid, 1_000)).body.id as string
    expect((await settle(p, { action: 'reject', reason: 'duplicate request' })).status).toBe(200)
  }, T)

  it('A3 · an approved payout UNDER REVIEW: the same rule; rejecting resolves the review explicitly (no bypass)', async () => {
    const uid = await organizer('a3')
    const p1 = await released(uid, 6_000)
    await released(uid, 4_000)
    const id = await approved(uid, 7_000)
    await reverse(p1.ptxId)                                                            // → review
    expect(await settle(id, { action: 'reject', reason: 'unfunded' }, SUPER2)).toMatchObject({ status: 409, body: { code: 'TRANSFER_CONFIRMATION_REQUIRED' } })
    expect(await reqDoc(id)).toMatchObject({ status: 'approved', payoutReview: { status: 'open' } })
    expect((await settle(id, { action: 'reject', reason: 'unfunded; no transfer made', confirmNoTransfer: true }, SUPER2)).status).toBe(200)
    expect(await reqDoc(id)).toMatchObject({ status: 'rejected', payoutReview: { status: 'resolved', outcome: 'rejected', resolvedBy: SUPER2 } })
    expect((await auditRows(id, 'settlement.rejected'))[0]).toMatchObject({ metadata: { confirmNoTransfer: true, reviewResolution: 'rejected' } })
  }, T)

  it('A4 · a payout that may already have been transferred (a transfer exception pending) can NOT be rejected — even with the confirmation — nor marked paid', async () => {
    const uid = await organizer('a4')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)
    await changeDestination(uid)
    expect((await initiate(id, newUtr())).status).toBe(200)
    expect(await settle(id, { action: 'reject', reason: 'try', confirmNoTransfer: true }, SUPER2)).toMatchObject({ status: 409, body: { code: 'EXCEPTION_PENDING' } })
    expect(await settle(id, { action: 'paid', reason: 'try', utrNumber: 'ANYUTR1' }, SUPER2)).toMatchObject({ status: 409, body: { code: 'EXCEPTION_PENDING' } })
    expect(await reqDoc(id)).toMatchObject({ status: 'approved', transferException: { status: 'pending_approval' } })
  }, T)

  // ═══ B · the changed-destination exception ═════════════════════════════════════════════════
  it('B1 · a valid, already-completed transfer is recorded: requested by one Super Admin, approved by another; paid ONCE; UTR reserved; audited with the evidence; nothing can pay or reject it afterwards; the wallet reconciles', async () => {
    const uid = await organizer('b1')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)                                             // approved by SUPER
    await changeDestination(uid)
    // the standard path refuses (the guard is NOT weakened)
    expect(await settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber: 'X' + newUtr() }, SUPER2)).toMatchObject({ status: 409, body: { code: 'DESTINATION_CHANGED' } })
    const utr = newUtr()
    const ini = await initiate(id, utr.toLowerCase(), SUPER)                          // normalized server-side
    expect(ini).toMatchObject({ status: 200, body: { exception: 'pending_approval', duplicate: false } })
    expect(await reqDoc(id)).toMatchObject({ status: 'approved', transferException: { status: 'pending_approval', utrNumber: utr, initiatedBy: SUPER, bindingCodeAtRequest: 'DESTINATION_CHANGED', amountPaise: 6_000 } })
    expect((await auditRows(id, 'settlement.transfer_exception_requested'))[0]).toMatchObject({ adminUid: SUPER, metadata: { utrNumber: utr, evidence: { transferSource: 'bank_statement', transferReference: 'STMT-OCT-ref-A' } } })
    expect(await wallet(uid)).toMatchObject({ available: 10_000, inTransit: 6_000, settled: 0 })   // nothing moves on request
    const ap = await approveEx(id, SUPER2)
    expect(ap).toMatchObject({ status: 200, body: { status: 'paid', duplicate: false } })
    expect(await reqDoc(id)).toMatchObject({ status: 'paid', utrNumber: utr, paidByAdmin: SUPER2, reserved: false, transferException: { status: 'approved', approvedBy: SUPER2 } })
    expect(await wallet(uid)).toMatchObject({ available: 4_000, inTransit: 0, settled: 6_000 })
    expect(await clawbacksOf(uid)).toEqual([])
    expect((await db.doc(`payoutTransferReferences/${utr}`).get()).data()).toMatchObject({ settlementId: id, recordedVia: 'transfer_exception', initiatedBy: SUPER, approvedBy: SUPER2 })
    const [paidRow] = await auditRows(id, 'settlement.paid')
    expect(paidRow).toMatchObject({ adminUid: SUPER2, metadata: { paidVia: 'transfer_exception', exceptionInitiatedBy: SUPER, exceptionApprovedBy: SUPER2, makerChecker: 'distinct_initiator_and_approver', bindingCode: 'DESTINATION_CHANGED' } })
    expect(JSON.stringify(paidRow)).not.toContain('999988887777')                      // no account data
    expect(JSON.stringify(paidRow)).not.toContain('123456789012')
    expect(await check(uid)).toEqual([])
    for (const body of [
      { action: 'paid', reason: 'again', utrNumber: utr },
      { action: 'reject', reason: 'again', confirmNoTransfer: true },
      { action: 'record_transfer', reason: 'again', utrNumber: utr },
      { action: 'transfer_exception_initiate', reason: 'again', utrNumber: utr, evidence: await evidenceFor(id) },
    ]) expect((await settle(id, body, SUPER3)).status).toBe(409)
    expect(await wallet(uid)).toMatchObject({ available: 4_000, settled: 6_000 })
  }, T)

  it('B2 · evidence is mandatory and validated: missing UTR / reason / evidence, a wrong original destination, an unconfirmed outcome, an unknown source or account-like reference all fail closed with no writes', async () => {
    const uid = await organizer('b2')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)
    await changeDestination(uid)
    const good = await evidenceFor(id)
    const cases: Array<[Record<string, unknown>, number, string | undefined]> = [
      [{ utrNumber: '' }, 422, 'UTR_REQUIRED'],
      [{ utrNumber: 'ab' }, 422, 'UTR_REQUIRED'],
      [{ reason: '' }, 400, undefined],
      [{ evidence: undefined }, 422, 'EVIDENCE_REQUIRED'],
      [{ evidence: { ...good, originalDestination: { ...good.originalDestination, verifiedVersion: PROFILE_MS + 77_000 } } }, 422, 'ORIGINAL_DESTINATION_MISMATCH'],
      [{ evidence: { ...good, originalDestination: { ...good.originalDestination, label: 'Other Bank ••••0000' } } }, 422, 'ORIGINAL_DESTINATION_MISMATCH'],
      [{ evidence: { ...good, transfer: { ...good.transfer, observation: 'transfer_pending' } } }, 422, 'TRANSFER_OUTCOME_UNCONFIRMED'],
      [{ evidence: { ...good, transfer: { ...good.transfer, observation: undefined } } }, 422, 'TRANSFER_OUTCOME_UNCONFIRMED'],
      [{ evidence: { ...good, transfer: { ...good.transfer, source: 'phone_call' } } }, 422, 'EVIDENCE_SOURCE_INVALID'],
      [{ evidence: { ...good, transfer: { ...good.transfer, reference: 'acct 123456789012' } } }, 422, 'EVIDENCE_REFERENCE_SENSITIVE'],
    ]
    for (const [over, status, code] of cases) {
      const r = await settle(id, { action: 'transfer_exception_initiate', reason: 'transfer completed before the bank change', utrNumber: newUtr(), evidence: good, ...over }, SUPER)
      expect(r.status, JSON.stringify(over)).toBe(status)
      if (code) expect(r.body.code).toBe(code)
    }
    expect(await reqDoc(id)).not.toHaveProperty('transferException')
    expect(await auditRows(id, 'settlement.transfer_exception_requested')).toHaveLength(0)
    // never a way around a working guard: an UNCHANGED destination is refused (use the standard path)
    const u2 = await organizer('b2u')
    await released(u2, 10_000)
    const id2 = await approved(u2, 2_000)
    expect(await initiate(id2, newUtr())).toMatchObject({ status: 409, body: { code: 'DESTINATION_UNCHANGED' } })
    // a request with no destination snapshot cannot prove the original destination
    await db.doc(`settlementRequests/${id2}`).update({ payoutDestination: null })
    await changeDestination(u2)
    expect(await settle(id2, { action: 'transfer_exception_initiate', reason: 'r e a s o n', utrNumber: newUtr(), evidence: good }, SUPER)).toMatchObject({ status: 422, body: { code: 'NO_DESTINATION_SNAPSHOT' } })
  }, T)

  it('B3 · authorization: a non-Super-Admin is refused at both steps; the requesting Super Admin may approve it (single-admin operation; audited as same_admin)', async () => {
    const uid = await organizer('b3')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)                                             // payout approved by SUPER
    await changeDestination(uid)
    expect((await initiate(id, newUtr(), NOBODY)).status).toBe(403)
    expect((await initiate(id, newUtr(), '')).status).toBe(403)
    expect((await initiate(id, newUtr(), SUPER2)).status).toBe(200)                   // requested by SUPER2
    expect((await approveEx(id, NOBODY)).status).toBe(403)
    expect(await reqDoc(id)).toMatchObject({ status: 'approved', transferException: { status: 'pending_approval' } })
    expect((await approveEx(id, SUPER2)).status).toBe(200)                            // RD-SETTLE-PAY-02: the requester approves
    const [paidRow] = await auditRows(id, 'settlement.paid')
    expect(paidRow).toMatchObject({ adminUid: SUPER2, metadata: { paidVia: 'transfer_exception', exceptionInitiatedBy: SUPER2, makerChecker: 'same_admin', transferConfirmed: true } })
  }, T)

  it('B4 · an approval is bound to its request, amount, UTR and evidence: any mismatch (or another request\'s fingerprint) records nothing', async () => {
    const uid = await organizer('b4')
    await released(uid, 20_000)
    const a = await approved(uid, 6_000)
    const b = await approved(uid, 5_000)
    await changeDestination(uid)
    await initiate(a, newUtr())
    await initiate(b, newUtr(), SUPER, { evidence: { ...(await evidenceFor(b)), transfer: { source: 'payout_report', reference: 'RPT-B', observation: 'transfer_completed' } } })
    const exB = (await reqDoc(b)).transferException as { fingerprint: string; utrNumber: string }
    for (const over of [{ expectedAmountPaise: 6_001 }, { utrNumber: exB.utrNumber }, { evidenceFingerprint: exB.fingerprint }, { evidenceFingerprint: 'f'.repeat(64) }]) {
      expect(await approveEx(a, SUPER2, over), JSON.stringify(over)).toMatchObject({ status: 409, body: { code: 'APPROVAL_MISMATCH' } })
    }
    expect(await approveEx(a, SUPER2, { expectedAmountPaise: undefined })).toMatchObject({ status: 422, body: { code: 'APPROVAL_BINDING_REQUIRED' } })
    expect(await reqDoc(a)).toMatchObject({ status: 'approved', transferException: { status: 'pending_approval' } })
    expect(await wallet(uid)).toMatchObject({ settled: 0 })
    expect((await approveEx(a, SUPER2)).status).toBe(200)
    expect((await approveEx(b, SUPER2)).status).toBe(200)
    expect(await wallet(uid)).toMatchObject({ available: 9_000, inTransit: 0, settled: 11_000 })
    expect(await check(uid)).toEqual([])
  }, T)

  it('B5 · duplicates are idempotent: the same request twice is one exception; the same approval twice records the transfer once', async () => {
    const uid = await organizer('b5')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)
    await changeDestination(uid)
    const utr = newUtr()
    expect((await initiate(id, utr)).body).toMatchObject({ duplicate: false })
    expect((await initiate(id, utr)).body).toMatchObject({ duplicate: true })
    expect(await auditRows(id, 'settlement.transfer_exception_requested')).toHaveLength(1)
    expect(await initiate(id, newUtr())).toMatchObject({ status: 409, body: { code: 'EXCEPTION_PENDING' } })   // a DIFFERENT one while pending
    expect((await approveEx(id, SUPER2)).body).toMatchObject({ status: 'paid', duplicate: false })
    expect((await approveEx(id, SUPER2)).body).toMatchObject({ status: 'paid', duplicate: true })
    expect(await auditRows(id, 'settlement.paid')).toHaveLength(1)
    expect(await wallet(uid)).toMatchObject({ settled: 6_000, available: 4_000 })
  }, T)

  it('B6 · a UTR already used by another payout is refused: one recorded by mark-paid, and one reserved by another exception', async () => {
    const uid = await organizer('b6')
    await released(uid, 30_000)
    const paidOne = await approved(uid, 2_000)
    const usedUtr = newUtr()
    expect((await settle(paidOne, { action: 'paid', reason: 'bank transfer sent', utrNumber: usedUtr }, SUPER2)).status).toBe(200)
    const a = await approved(uid, 3_000)
    const b = await approved(uid, 4_000)
    await changeDestination(uid)
    expect(await initiate(a, usedUtr)).toMatchObject({ status: 409, body: { code: 'UTR_IN_USE' } })
    const shared = newUtr()
    expect((await initiate(a, shared)).status).toBe(200)
    expect((await initiate(b, shared)).status).toBe(200)                                 // both pending with the same UTR…
    expect((await approveEx(a, SUPER2)).status).toBe(200)
    expect(await approveEx(b, SUPER2)).toMatchObject({ status: 409, body: { code: 'UTR_IN_USE' } })   // …only one can be recorded
    expect(await reqDoc(b)).toMatchObject({ status: 'approved', transferException: { status: 'pending_approval' } })
    expect(await wallet(uid)).toMatchObject({ settled: 5_000 })
  }, T)

  it('B7 · CONCURRENT approvals (two different Super Admins) record the transfer exactly once', async () => {
    for (let i = 0; i < 3; i++) {
      const uid = await organizer(`b7${i}`)
      await released(uid, 10_000)
      const id = await approved(uid, 6_000)
      await changeDestination(uid)
      await initiate(id, newUtr())
      const ex = (await reqDoc(id)).transferException as { amountPaise: number; utrNumber: string; fingerprint: string }
      const body = { action: 'transfer_exception_approve', reason: 'evidence verified by second admin', utrNumber: ex.utrNumber, expectedAmountPaise: ex.amountPaise, evidenceFingerprint: ex.fingerprint, confirmTransferCompleted: true }
      const { PATCH } = await import('@/app/api/admin/settlements/[id]/route')
      // two admins at once, each identified by its own request token
      const asAdmin = async (uidAs: string) => json(await PATCH(new NextRequest('http://localhost/api/test', { method: 'PATCH', headers: { 'Content-Type': 'application/json', authorization: `Bearer as:${uidAs}` }, body: JSON.stringify(body) }), ctx(id)))
      const [r1, r2] = await Promise.all([asAdmin(SUPER2), asAdmin(SUPER3)])
      expect([r1.status, r2.status].filter(s => s === 200).length).toBeGreaterThanOrEqual(1)
      const wins = [r1, r2].filter(r => r.status === 200 && r.body.duplicate === false)
      expect(wins).toHaveLength(1)
      expect(await auditRows(id, 'settlement.paid')).toHaveLength(1)
      expect(await wallet(uid)).toMatchObject({ settled: 6_000, available: 4_000, inTransit: 0 })
      expect(await check(uid)).toEqual([])
    }
  }, T)

  it('B8 · a SHORTFALL (a refund put the payout under review before the transfer was recorded): paid, review resolved, payout_shortfall clawback; the wallet reconciles', async () => {
    const uid = await organizer('b8')
    const p1 = await released(uid, 6_000)
    await released(uid, 4_000)
    const id = await approved(uid, 7_000)
    await reverse(p1.ptxId)                                                            // available 4,000 → review
    await changeDestination(uid)
    expect(await settle(id, { action: 'record_transfer', reason: 'transfer done', utrNumber: newUtr() }, SUPER2)).toMatchObject({ status: 409, body: { code: 'DESTINATION_CHANGED' } })   // standard path still guarded
    await initiate(id, newUtr())
    expect((await approveEx(id, SUPER2)).status).toBe(200)
    expect(await reqDoc(id)).toMatchObject({ status: 'paid', payoutReview: { status: 'resolved', outcome: 'paid_after_transfer', shortfallPaise: 3_000, clawbackId: `clawback_payout_${id}` } })
    expect(await wallet(uid)).toMatchObject({ available: 0, inTransit: 0, settled: 7_000 })
    expect(await clawbacksOf(uid)).toEqual([expect.objectContaining({ sourceType: 'settlement', reason: 'payout_shortfall', reversalAmountPaise: 7_000, recoveredAmountPaise: 4_000, outstandingAmountPaise: 3_000 })])
    expect(h.captured.map(c => c.scope)).toContain('settlement.transfer_exception_shortfall')
    expect(await check(uid)).toEqual([])
  }, T)

  it('B9 · a declined exception is kept as evidence; the payout is unchanged and a corrected request can follow', async () => {
    const uid = await organizer('b9')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)
    await changeDestination(uid)
    const utr = newUtr()
    await initiate(id, utr)
    expect((await settle(id, { action: 'transfer_exception_decline', reason: 'statement does not show the debit' }, SUPER2)).status).toBe(200)
    const d = await reqDoc(id)
    expect(d).toMatchObject({ status: 'approved' })
    expect(d).not.toHaveProperty('transferException')
    expect(Object.values(d.transferExceptionHistory as Record<string, unknown>)).toEqual([expect.objectContaining({ status: 'declined', utrNumber: utr, declinedBy: SUPER2, declineReason: 'statement does not show the debit', initiatedBy: SUPER })])
    expect((await auditRows(id, 'settlement.transfer_exception_declined'))[0]).toMatchObject({ adminUid: SUPER2, metadata: { utrNumber: utr } })
    expect(await wallet(uid)).toMatchObject({ inTransit: 6_000, settled: 0 })
    expect(await settle(id, { action: 'transfer_exception_decline', reason: 'again' }, SUPER2)).toMatchObject({ status: 409, body: { code: 'NO_PENDING_EXCEPTION' } })
    expect((await initiate(id, utr)).status).toBe(200)                                   // a corrected request may follow
  }, T)
})
