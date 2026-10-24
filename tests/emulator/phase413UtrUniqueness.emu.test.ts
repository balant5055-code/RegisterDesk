// M1.3 — ONE bank-transfer UTR, ONE payout, across ordinary mark-paid, record_transfer and the changed-destination
// exception; maker-checker for the exception without any bypass. REAL Firestore, REAL routes; synthetic data only.
// Nothing here makes, retries or authorizes a bank transfer.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000
const SUPER = `m13-super-${P}`, SUPER2 = `m13-super2-${P}`, SUPER3 = `m13-super3-${P}`

const h = vi.hoisted(() => ({ who: '' as string, admin: '' as string, captured: [] as Array<{ scope?: unknown }> }))
vi.mock('@/lib/monitoring/sentry', async orig => ({
  ...(await orig<typeof import('@/lib/monitoring/sentry')>()),
  captureFinancialError: (_e: unknown, ctx?: { scope?: unknown }) => { h.captured.push(ctx ?? {}) },
  captureError: () => undefined,
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_m13', RAZORPAY_KEY_SECRET: 'm13',
  razorpay: { payments: {
    refund: async () => { throw new Error('no refund may be created in this suite') },
    fetchMultipleRefund: async () => ({ entity: 'collection', count: 0, items: [] }),
  } },
}))
// identity: a per-request 'Bearer as:<uid>' token wins (concurrent requests), else the current h.admin
const who = (header: string | null) => (header?.startsWith('Bearer as:') ? header.slice('Bearer as:'.length) : h.admin)
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async (hd: string | null) => ([SUPER, SUPER2, SUPER3].includes(who(hd)) ? who(hd) : null),
  legacyAdminClaimOnly: async () => false,
  resolveSuperAdminUid: async (hd: string | null) => ([SUPER, SUPER2, SUPER3].includes(who(hd)) ? who(hd) : null),
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))

const req = (body?: unknown, method = 'POST', auth = 'Bearer t') => new NextRequest('http://localhost/api/test', {
  method, headers: { 'Content-Type': 'application/json', authorization: auth },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

describeEmu('M1.3 · one UTR, one payout — and maker-checker without bypass', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let reconcileWallet: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
  const savedAdminUids = process.env.ADMIN_UIDS
  const created = new Set<string>()
  const orgs = new Set<string>()
  let n = 0

  const PROFILE_MS = Date.parse('2026-09-01T10:00:00.000Z')
  async function organizer(tag: string) {
    const uid = `m13-org-${tag}-${P}-${++n}`
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
  const changeDestination = (uid: string) => db.doc(`organizerPayoutProfiles/${uid}`).update({ verifiedVersion: PROFILE_MS + 77_000 })
  async function released(uid: string, net: number) {
    const id = `m13-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: `m13-ev-${P}`, entityType: 'event', sourceId: id, sourceType: 'registration',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
      gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR',
      gateway: 'razorpay', gatewayPaymentId: `p_${id}`, gatewayOrderId: `o_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - 30 * DAY) })
    await release({ limit: 500 })
    return { id, ptxId: `ptx_${id}` }
  }
  const settle = async (id: string, body: Record<string, unknown>, as = SUPER) => {
    const { PATCH } = await import('@/app/api/admin/settlements/[id]/route')
    return json(await PATCH(req(body, 'PATCH', `Bearer as:${as}`), ctx(id)))
  }
  const approved = async (uid: string, amountPaise: number) => {
    const { POST } = await import('@/app/api/organizer/settlements/route')
    h.who = uid
    const r = await json(await POST(req({ amountPaise })))
    h.who = ''
    expect(r.status).toBe(201)
    const id = r.body.id as string
    expect((await settle(id, { action: 'approve', reason: 'checked for test' }, SUPER)).status).toBe(200)
    return id
  }
  const pay = (id: string, utr: string, as = SUPER2) => settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber: utr }, as)
  const reqDoc = async (id: string) => (await db.doc(`settlementRequests/${id}`).get()).data()!
  const refDoc = async (utr: string) => (await db.doc(`payoutTransferReferences/${utr}`).get()).data() ?? null
  const wallet = async (uid: string) => (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!
  const auditCount = async (id: string, action: string) => (await db.collection('adminAuditLogs').where('entityId', '==', id).where('action', '==', action).get()).size
  const clawCount = async (uid: string) => (await db.collection('walletClawbacks').where('organizerUid', '==', uid).get()).size
  const check = async (uid: string) => (await reconcileWallet(uid, await wallet(uid))).map(m => [m.field, m.expected, m.actual])
  let k = 0
  const utr = (tag = '') => `M13${tag}${P}N${++k}`   // canonical form (upper-case alphanumeric)
  const evidenceFor = async (id: string) => {
    const snap = (await reqDoc(id)).payoutDestination as { verifiedVersion: number; label: string | null }
    return { originalDestination: { verifiedVersion: snap.verifiedVersion, label: snap.label }, transfer: { source: 'bank_statement', reference: 'STMT-M13-ref', observation: 'transfer_completed' } }
  }
  /** a pending changed-destination exception, requested by `by` */
  const exception = async (id: string, u: string, by = SUPER) =>
    settle(id, { action: 'transfer_exception_initiate', reason: 'transfer completed before the bank change', utrNumber: u, evidence: await evidenceFor(id) }, by)
  const approveEx = async (id: string, as: string) => {
    const ex = (await reqDoc(id)).transferException as { amountPaise: number; utrNumber: string; fingerprint: string }
    return settle(id, { action: 'transfer_exception_approve', reason: 'evidence verified', utrNumber: ex.utrNumber, expectedAmountPaise: ex.amountPaise, evidenceFingerprint: ex.fingerprint }, as)
  }
  /** everything a duplicate attempt must leave untouched */
  const snapshot = async (uid: string, id: string) => ({ w: await wallet(uid), r: await reqDoc(id), claws: await clawCount(uid), paidAudits: await auditCount(id, 'settlement.paid') })

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
      for (const c of ['settlementRequests', 'payoutTransferReferences']) {
        const s = await db.collection(c).where('organizerUid', '==', uid).get()
        for (const d of s.docs) await d.ref.delete().catch(() => null)
      }
    }
  }, T)
  beforeEach(() => { h.who = ''; h.admin = ''; h.captured.length = 0; process.env.ADMIN_UIDS = `${SUPER},${SUPER2},${SUPER3}` })
  afterEach(() => { vi.restoreAllMocks() })

  it('1 · ordinary mark-paid records a unique UTR and reserves it (stored as submitted; reserved canonical)', async () => {
    const uid = await organizer('u1')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)
    const u = utr()
    const submitted = `${u.slice(0, 4).toLowerCase()} ${u.slice(4)}`                    // same UTR, other spelling
    expect((await pay(id, submitted)).status).toBe(200)
    expect(await reqDoc(id)).toMatchObject({ status: 'paid', utrNumber: submitted })    // storage unchanged
    expect(await refDoc(u)).toMatchObject({ utrNumber: u, settlementId: id, organizerUid: uid, amountPaise: 6_000, recordedVia: 'mark_paid', recordedBy: SUPER2 })
    expect(await check(uid)).toEqual([])
  }, T)

  it('2+6+7 · a UTR used by another ordinary payout is refused — in any equivalent spelling — with NO side effects; an invalid UTR is refused before any write', async () => {
    const uid = await organizer('u2')
    await released(uid, 20_000)
    const a = await approved(uid, 6_000)
    const b = await approved(uid, 5_000)
    const u = utr()
    expect((await pay(a, u)).status).toBe(200)
    const before = await snapshot(uid, b)
    for (const variant of [u, u.toLowerCase(), `${u.slice(0, 3)}-${u.slice(3)}`, ` ${u.slice(0, 5)} ${u.slice(5)} `]) {
      expect(await pay(b, variant), variant).toMatchObject({ status: 409, body: { code: 'UTR_IN_USE' } })
    }
    expect(await pay(b, 'UTR/123')).toMatchObject({ status: 422, body: { code: 'UTR_INVALID' } })
    expect(await snapshot(uid, b)).toEqual(before)
    expect(await refDoc(u)).toMatchObject({ settlementId: a })                           // the reservation is untouched
    // the payout is still payable with its OWN reference
    expect((await pay(b, utr())).status).toBe(200)
    expect(await check(uid)).toEqual([])
  }, T)

  it('3 · ordinary mark-paid refuses a UTR already recorded by a changed-destination exception; record_transfer is held to the same rule', async () => {
    const uid = await organizer('u3')
    await released(uid, 20_000)
    const ex = await approved(uid, 6_000)
    const other = await approved(uid, 5_000)
    await changeDestination(uid)
    const u = utr()
    expect((await exception(ex, u)).status).toBe(200)
    expect((await approveEx(ex, SUPER2)).status).toBe(200)
    expect(await refDoc(u)).toMatchObject({ settlementId: ex, recordedVia: 'transfer_exception' })
    await db.doc(`organizerPayoutProfiles/${uid}`).update({ verifiedVersion: PROFILE_MS })   // destination back: the standard path applies
    expect(await pay(other, u.toLowerCase())).toMatchObject({ status: 409, body: { code: 'UTR_IN_USE' } })
    expect(await reqDoc(other)).toMatchObject({ status: 'approved' })
    // record_transfer (a reviewed payout) is held to the same rule
    const u2 = await organizer('u3b')
    const p1 = await released(u2, 6_000)
    await released(u2, 4_000)
    const r = await approved(u2, 7_000)
    await reverse(p1.ptxId)                                                            // → review
    expect(await settle(r, { action: 'record_transfer', reason: 'transfer done', utrNumber: u }, SUPER2)).toMatchObject({ status: 409, body: { code: 'UTR_IN_USE' } })
    expect(await reqDoc(r)).toMatchObject({ status: 'approved', payoutReview: { status: 'open' } })
    // …including a LEGACY payout's UTR (recorded before M1.3, so no reservation exists — only the query finds it)
    const legacyUtr = utr('R')
    await db.doc(`settlementRequests/m13-legacy-rt-${P}`).set({ organizerUid: u2, amountPaise: 1, status: 'paid', utrNumber: legacyUtr, reserved: false, requestedAt: new Date(), approvedAt: null, paidAt: new Date(), adminNote: '' })
    expect(await settle(r, { action: 'record_transfer', reason: 'transfer done', utrNumber: legacyUtr.toLowerCase() }, SUPER2)).toMatchObject({ status: 409, body: { code: 'UTR_IN_USE' } })
    expect(await refDoc(legacyUtr)).toBeNull()
    await db.doc(`settlementRequests/m13-legacy-rt-${P}`).delete()
    const ru = utr()
    expect((await settle(r, { action: 'record_transfer', reason: 'transfer done', utrNumber: ru }, SUPER2)).status).toBe(200)
    expect(await refDoc(ru)).toMatchObject({ settlementId: r, recordedVia: 'record_transfer' })
  }, T)

  it('4 · exception approval refuses a UTR an ordinary payout recorded while the exception was pending', async () => {
    const uid = await organizer('u4')
    await released(uid, 20_000)
    const ex = await approved(uid, 6_000)
    const ordinary = await approved(uid, 5_000)
    await changeDestination(uid)
    const u = utr()
    expect((await exception(ex, u)).status).toBe(200)                                    // pending — reserves nothing yet
    await db.doc(`organizerPayoutProfiles/${uid}`).update({ verifiedVersion: PROFILE_MS })
    expect((await pay(ordinary, u)).status).toBe(200)                                    // the ordinary payout records it first
    await changeDestination(uid)
    const before = await snapshot(uid, ex)
    expect(await approveEx(ex, SUPER2)).toMatchObject({ status: 409, body: { code: 'UTR_IN_USE' } })
    expect(await snapshot(uid, ex)).toEqual(before)
    expect(await refDoc(u)).toMatchObject({ settlementId: ordinary })
  }, T)

  it('5 · CONCURRENT attempts recording one UTR against different payouts: at most one succeeds', async () => {
    for (let i = 0; i < 3; i++) {
      const uid = await organizer(`u5${i}`)
      await released(uid, 20_000)
      const a = await approved(uid, 6_000)
      const b = await approved(uid, 5_000)
      const u = utr()
      const [ra, rb] = await Promise.all([pay(a, u, SUPER2), pay(b, u.toLowerCase(), SUPER3)])
      const statuses = [ra.status, rb.status].sort()
      expect(statuses).toEqual([200, 409])
      const winner = ra.status === 200 ? a : b
      expect(await refDoc(u)).toMatchObject({ settlementId: winner })
      const w = await wallet(uid)
      expect(w.settledPaise).toBe(winner === a ? 6_000 : 5_000)
      expect(await check(uid)).toEqual([])
    }
  }, T)

  it('8 · retrying an already-paid payout stays idempotent (refused as already paid; nothing changes; its own reservation stands)', async () => {
    const uid = await organizer('u8')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)
    const u = utr()
    expect((await pay(id, u)).status).toBe(200)
    const before = await snapshot(uid, id)
    const again = await pay(id, u)
    expect(again.status).toBe(409)
    expect(String(again.body.error)).toMatch(/approved.*before marking paid|current: 'paid'/)
    expect(await snapshot(uid, id)).toEqual(before)
    expect(await refDoc(u)).toMatchObject({ settlementId: id })
  }, T)

  it('9 · a FAILED payout transaction leaves no orphaned reservation; the retry reserves and records once', async () => {
    const uid = await organizer('u9')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)
    const u = utr()
    const realCreate = FS.Transaction.prototype.create
    const spy = vi.spyOn(FS.Transaction.prototype, 'create').mockImplementation(function (this: InstanceType<typeof FS.Transaction>, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
      if (ref.path.startsWith('adminAuditLogs/')) throw new Error('injected audit failure')
      return realCreate.call(this, ref, data)
    } as never)
    expect((await pay(id, u)).status).toBe(500)
    spy.mockRestore()
    expect(await refDoc(u)).toBeNull()                                                  // nothing reserved
    expect(await reqDoc(id)).toMatchObject({ status: 'approved' })
    expect((await pay(id, u)).status).toBe(200)
    expect(await refDoc(u)).toMatchObject({ settlementId: id })
    expect(await wallet(uid)).toMatchObject({ settledPaise: 6_000 })
  }, T)

  it('10 · legacy payouts (recorded before M1.3, no reservation) are detected by their stored spelling — canonical, as submitted or upper-cased; another spelling is NOT (documented limitation)', async () => {
    const uid = await organizer('u10')
    await released(uid, 20_000)
    const legacy = (k2: string, stored: string) => db.doc(`settlementRequests/m13-legacy-${P}-${k2}`).set({ organizerUid: uid, amountPaise: 1, status: 'paid', utrNumber: stored, reserved: false, requestedAt: new Date(), approvedAt: null, paidAt: new Date(), adminNote: '' })
    const u = utr('L')
    await legacy('a', u)                                                                // stored canonical
    const id = await approved(uid, 2_000)
    for (const v of [u, u.toLowerCase(), `${u.slice(0, 4)}-${u.slice(4)}`]) {
      expect(await pay(id, v), v).toMatchObject({ status: 409, body: { code: 'UTR_IN_USE' } })
    }
    const lower = utr('L').toLowerCase()
    await legacy('b', lower)                                                            // stored lower-case
    expect(await pay(id, lower)).toMatchObject({ status: 409, body: { code: 'UTR_IN_USE' } })            // as submitted
    const spaced = utr('L')
    await legacy('c', `${spaced.slice(0, 5)} ${spaced.slice(5)}`)                       // stored with a space
    // LIMITATION: a legacy UTR stored in a spelling that is neither the submitted, the upper-cased nor the
    // canonical one is not found by an equality query — closing it needs a backfill of reservations (approval).
    expect((await pay(id, spaced)).status).toBe(200)
    for (const s of ['a', 'b', 'c']) await db.doc(`settlementRequests/m13-legacy-${P}-${s}`).delete()
  }, T)

  it('13 · the exception can be approved by neither its requester nor the payout approver', async () => {
    const uid = await organizer('u13')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)                                              // payout approved by SUPER
    await changeDestination(uid)
    expect((await exception(id, utr(), SUPER2)).status).toBe(200)                      // requested by SUPER2
    for (const as of [SUPER2, SUPER]) expect(await approveEx(id, as)).toMatchObject({ status: 409, body: { code: 'MAKER_CHECKER_REQUIRED' } })
    expect(await reqDoc(id)).toMatchObject({ status: 'approved', transferException: { status: 'pending_approval' } })
    expect((await approveEx(id, SUPER3)).status).toBe(200)
  }, T)

  it('14 · with only TWO Super Admins configured there is no eligible approver: the exception stays pending, the response says what to do, nothing is recorded', async () => {
    process.env.ADMIN_UIDS = `${SUPER},${SUPER2}`
    const uid = await organizer('u14')
    await released(uid, 10_000)
    const id = await approved(uid, 6_000)
    await changeDestination(uid)
    const u = utr()
    expect((await exception(id, u, SUPER2)).status).toBe(200)
    const before = await snapshot(uid, id)
    for (const as of [SUPER, SUPER2]) {
      const r = await approveEx(id, as)
      expect(r).toMatchObject({ status: 409, body: { code: 'MAKER_CHECKER_REQUIRED', exception: 'pending_approval' } })
      expect(String(r.body.error)).toMatch(/Only 2 Super Admin\(s\) are configured.*stays PENDING.*Operations Runbook B\.12.*cannot be bypassed/)
    }
    const after = await snapshot(uid, id)
    expect(after).toEqual(before)
    expect(await refDoc(u)).toBeNull()
  }, T)
})
