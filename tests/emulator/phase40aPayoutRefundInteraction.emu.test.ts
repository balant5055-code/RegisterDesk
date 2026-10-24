// Phase 4.0A — TESTS ONLY: how refunds interact with open payout requests TODAY, on REAL Firestore through the
// REAL code (credit, release job, registration reversal, donation refund accounting, organizer + admin
// settlement routes). These pin CURRENT behaviour — including the registration/donation divergence — and encode
// no new policy. Synthetic emulator data only; the Razorpay stub can never create a refund.
//
//   registration reversal → caps inTransit → reconcileSettlementHoldsAfterRefund (approved first, oldest
//     first, GREEDY fill; unbacked requests auto-rejected; inTransit rebuilt; fire-and-forget audit; best-effort)
//   donation reversal     → caps inTransit only; open requests keep their full amount and status
//   mark-paid             → refuses when availablePaise < amount (422), nothing written
//
// M1 (payout/refund integrity, owner-approved) SUPERSEDES the auto-reject and the donation divergence: both refund
// paths now hold unbacked requests FOR REVIEW inside the refund transaction (lib/settlements/payoutReview.ts).
// Per the approved plan, every scenario and test name is kept; only the assertions M1 intentionally changes were
// updated, each marked "M1". Tests 3 and 4 inject their failure where it now happens (inside the refund
// transaction). Unaffected assertions are unchanged.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { appendFileSync } from 'node:fs'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000
const SUPER = `p40a-super-${P}`, SUPER2 = `p40a-super2-${P}`

const h = vi.hoisted(() => ({
  who: '' as string, admin: '' as string,
  captured: [] as Array<{ scope?: unknown }>,
  failReconcile: false, failAuditLog: false,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({
  ...(await orig<typeof import('@/lib/monitoring/sentry')>()),
  captureFinancialError: (_e: unknown, ctx?: { scope?: unknown }) => { h.captured.push(ctx ?? {}) },
  captureError: () => undefined,
}))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_p40a', RAZORPAY_KEY_SECRET: 'p40a',
  razorpay: { payments: {
    refund: async () => { throw new Error('no refund may be created in this suite') },
    fetchMultipleRefund: async () => ({ entity: 'collection', count: 0, items: [] }),
  } },
}))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => ([SUPER, SUPER2].includes(h.admin) ? h.admin : null),
  legacyAdminClaimOnly: async () => false,
  resolveSuperAdminUid: async () => ([SUPER, SUPER2].includes(h.admin) ? h.admin : null),
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))
// failure injection at the module boundary (the real implementation runs otherwise)
vi.mock('@/lib/settlements/reconcile', async orig => {
  const real = await orig<typeof import('@/lib/settlements/reconcile')>()
  return { ...real, reconcileSettlementHoldsAfterRefund: async (uid: string) => {
    if (h.failReconcile) throw new Error('injected reconcile failure')
    return real.reconcileSettlementHoldsAfterRefund(uid)
  } }
})
// M1 — the re-fit now happens INSIDE the refund transaction: test 3 fails its open-request read there
vi.mock('@/lib/settlements/payoutReview', async orig => {
  const real = await orig<typeof import('@/lib/settlements/payoutReview')>()
  return { ...real, readOpenPayoutRequests: async (...a: Parameters<typeof real.readOpenPayoutRequests>) => {
    if (h.failReconcile) throw new Error('injected open-request read failure')
    return real.readOpenPayoutRequests(...a)
  } }
})
vi.mock('@/lib/admin/audit', async orig => {
  const real = await orig<typeof import('@/lib/admin/audit')>()
  return { ...real, logAdminAction: async (p: Parameters<typeof real.logAdminAction>[0]) => {
    if (h.failAuditLog && p.adminUid === 'system') throw new Error('injected audit failure')
    return real.logAdminAction(p)
  } }
})

const req = (body?: unknown, method = 'POST') => new NextRequest('http://localhost/api/test', {
  method, headers: { 'Content-Type': 'application/json', authorization: 'Bearer t' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

describeEmu('Phase 4.0A · refunds vs open payout requests (current behaviour)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let applyDonation: typeof import('@/lib/donations/refundService').applyDonationRefundAccounting
  let reconcileWallet: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
  let refit: typeof import('@/lib/settlements/reconcile').reconcileSettlementHoldsAfterRefund
  const savedAdminUids = process.env.ADMIN_UIDS
  const created = new Set<string>()
  const orgs = new Set<string>()   // M1.1 — their payout requests are removed afterwards (platform-wide totals)
  let n = 0

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────
  const PROFILE_MS = Date.parse('2026-09-01T10:00:00.000Z')
  async function organizer(tag: string) {
    const uid = `p40a-org-${tag}-${P}-${++n}`
    orgs.add(uid)
    const put = async (path: string, d: Record<string, unknown>) => { await db.doc(path).set(d); created.add(path) }
    await put(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })
    await put(`organizerPayoutProfiles/${uid}`, {
      uid, accountHolderName: 'Test Holder', payoutMethod: 'bank', bankName: 'HDFC Bank', accountNumber: '123456789012', ifscCode: 'HDFC0001234',
      upiId: null, panNumber: 'ABCDE1234F', gstNumber: null, isVerified: true, verifiedAt: Timestamp.fromMillis(PROFILE_MS + 1000), verifiedBy: SUPER,
      verifiedVersion: PROFILE_MS, rejectionNote: null, createdAt: Timestamp.fromMillis(PROFILE_MS), updatedAt: Timestamp.fromMillis(PROFILE_MS + 1000),
    })
    return uid
  }
  /** A credited payment (real atomic credit path), released through the real job. */
  async function released(uid: string, net: number, kind: 'registration' | 'donation' = 'registration') {
    const id = `p40a-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed',
      organizerUid: uid, entityId: `p40a-ev-${P}`, entityType: kind === 'donation' ? 'campaign' : 'event', sourceId: id, sourceType: kind,
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
      gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR',
      gateway: 'razorpay', gatewayPaymentId: `p_${id}`, gatewayOrderId: `o_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - 30 * DAY) })
    await release({ limit: 500 })
    expect((await db.doc(`platformTransactions/ptx_${id}`).get()).get('releaseStatus')).toBe('released')
    if (kind === 'donation') {
      const slug = `p40a-camp-${P}-${n}`
      await db.doc(`donations/${id}`).set({ amountPaise: net, campaignSlug: slug, donorEmail: `d${n}@x.test`, donorName: 'D', isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: `o_${id}`, organizerUid: uid })
      return { id, ptxId: `ptx_${id}`, slug }
    }
    return { id, ptxId: `ptx_${id}`, slug: '' }
  }
  async function donationRefund(d: { id: string; slug: string }, uid: string, amount: number) {
    const refundId = `rfnd_p40a_${P}_${++n}`
    await db.doc(`donationRefunds/${refundId}`).set({ id: refundId, donationId: d.id, campaignId: d.slug, campaignSlug: d.slug, organizerUid: uid, razorpayRefundId: refundId, razorpayPaymentId: `p_${d.id}`, amountPaise: amount, reason: 'test', status: 'pending', initiatedBy: 'webhook', createdAt: new Date() })
    return refundId
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
    return json(await PATCH(req(body, 'PATCH'), ctx(id)))
  }
  /** A request through the real route; approved by SUPER when asked (requests are created one at a time:
   *  only a PENDING request blocks the next, so earlier ones are approved first). */
  const open = async (uid: string, amountPaise: number, approve: boolean) => {
    const r = await request(uid, amountPaise)
    expect(r.status).toBe(201)
    const id = r.body.id as string
    if (approve) expect((await settle(id, { action: 'approve', reason: 'checked for test' })).status).toBe(200)
    return id
  }
  const reqDoc = async (id: string) => (await db.doc(`settlementRequests/${id}`).get()).data()!
  const wallet = async (uid: string) => {
    const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!
    return { pending: w.pendingPaise as number, available: w.availablePaise as number, inTransit: (w.inTransitPaise ?? 0) as number, settled: (w.settledPaise ?? 0) as number }
  }
  const auditRows = async (entityId: string, action: string) =>
    (await db.collection('adminAuditLogs').where('entityId', '==', entityId).where('action', '==', action).get()).docs.map(d => d.data())
  const scopes = () => h.captured.map(c => c.scope)
  /** which serial order won a race — informational only, written when P40A_RACE_OUT names a file */
  const raceLog = (line: string) => { if (process.env.P40A_RACE_OUT) appendFileSync(process.env.P40A_RACE_OUT, `${line}\n`) }
  const check = async (uid: string) =>
    (await reconcileWallet(uid, (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!)).map(m => [m.field, m.expected, m.actual])

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    process.env.ADMIN_UIDS = `${SUPER},${SUPER2}`
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    applyDonation = (await import('@/lib/donations/refundService')).applyDonationRefundAccounting
    reconcileWallet = (await import('@/lib/reconciliation/wallets')).reconcileOneWallet
    refit = (await import('@/lib/settlements/reconcile')).reconcileSettlementHoldsAfterRefund
  }, T)
  afterAll(async () => {
    process.env.ADMIN_UIDS = savedAdminUids
    for (const p of created) await db.doc(p).delete().catch(() => null)
    // M1.1 — this suite's payout requests must not leak into suites that total EVERY paid settlement
    for (const uid of orgs) {
      const s = await db.collection('settlementRequests').where('organizerUid', '==', uid).get()
      for (const d of s.docs) await d.ref.delete().catch(() => null)
    }
    // M1.3 — and its transfer-reference reservations (one UTR, one payout) must not collide with other suites
    for (const uid of orgs) {
      const r = await db.collection('payoutTransferReferences').where('organizerUid', '==', uid).get()
      for (const d of r.docs) await d.ref.delete().catch(() => null)
    }
  }, T)
  beforeEach(() => { h.who = ''; h.admin = ''; h.captured.length = 0; h.failReconcile = false; h.failAuditLog = false })
  afterEach(() => { h.failReconcile = false; h.failAuditLog = false })

  // ═══ 1 · registration refund re-fits open requests ═══════════════════════════════════════════
  it('1 · registration refund: approved first then oldest, GREEDY fill (a later smaller request survives a larger rejected one); inTransit rebuilt; system audit per rejection; wallet reconciles', async () => {
    const uid = await organizer('refit')
    const p1 = await released(uid, 5_000)
    await released(uid, 5_000)                                                         // available 10,000
    const a = await open(uid, 4_000, true)                                              // approved, oldest
    const b = await open(uid, 3_000, true)                                              // approved
    const c = await open(uid, 1_000, false)                                             // pending
    expect(await wallet(uid)).toMatchObject({ available: 10_000, inTransit: 8_000 })
    expect(await reverse(p1.ptxId)).toMatchObject({ reversed: true, debited: 5_000, insolvent: false })   // available 5,000 < 8,000
    expect(await wallet(uid)).toMatchObject({ available: 5_000, inTransit: 5_000 })      // 4,000 (a) + 1,000 (c)
    expect(await reqDoc(a)).toMatchObject({ status: 'approved', amountPaise: 4_000 })
    // M1 — held FOR REVIEW (status and full amount kept, reservation released), never auto-rejected
    expect(await reqDoc(b)).toMatchObject({ status: 'approved', amountPaise: 3_000, reserved: false, payoutReview: { status: 'open', trigger: { kind: 'registration_refund', ref: p1.ptxId }, requestedAmountPaise: 3_000, availableAtReviewPaise: 5_000, keptAheadPaise: 4_000 } })
    expect(await reqDoc(c)).toMatchObject({ status: 'pending', amountPaise: 1_000 })    // greedy: still fits after b is skipped
    const rows = await auditRows(b, 'settlement.review_opened')                         // M1 — staged in the refund transaction
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ adminUid: 'system', actorRole: 'system', metadata: { organizerUid: uid, amountPaise: 3_000, availableAtReviewPaise: 5_000 } })
    expect(await auditRows(b, 'settlement.rejected')).toHaveLength(0)                   // M1
    expect(await auditRows(a, 'settlement.review_opened')).toHaveLength(0)              // M1
    expect(await check(uid)).toEqual([])
    // the request under review cannot be paid (M1: 409 UNDER_REVIEW); the surviving approved one can (maker-checker)
    expect((await settle(b, { action: 'paid', reason: 'try paying reviewed', utrNumber: 'UTRB' }, SUPER2))).toMatchObject({ status: 409, body: { code: 'UNDER_REVIEW' } })
    expect((await settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: 'UTRA' }, SUPER2)).status).toBe(200)
    expect(await wallet(uid)).toMatchObject({ available: 1_000, inTransit: 1_000, settled: 4_000 })
    expect(await check(uid)).toEqual([])
  }, T)

  it('2 · registration refund that leaves the holds covered: NO re-fit — requests and inTransit untouched', async () => {
    const uid = await organizer('fits')
    const p1 = await released(uid, 2_000)
    await released(uid, 8_000)                                                         // available 10,000
    const a = await open(uid, 6_000, true)
    await reverse(p1.ptxId)                                                            // available 8,000 ≥ 6,000
    expect(await wallet(uid)).toMatchObject({ available: 8_000, inTransit: 6_000 })
    expect(await reqDoc(a)).toMatchObject({ status: 'approved' })
    expect(scopes()).not.toContain('reversePlatformTransactionAndDebit.settlement_reconcile_failed')
    expect(await check(uid)).toEqual([])
  }, T)

  it('3 · re-fit FAILURE: the reversal stands, inTransit is only capped, the unbacked request stays open, a financial alert is raised; mark-paid then refuses; a later re-fit run repairs it', async () => {
    const uid = await organizer('refitfail')
    const p1 = await released(uid, 6_000)
    await released(uid, 4_000)                                                         // available 10,000
    const a = await open(uid, 7_000, true)
    h.failReconcile = true
    // M1 — the re-fit is part of the refund transaction: its failure fails the WHOLE reversal (nothing commits;
    // the callers' durable ledger-reversal retry keeps the refund), never a reversal with unbacked reservations
    await expect(reverse(p1.ptxId)).rejects.toThrow(/injected open-request read failure/)
    h.failReconcile = false
    expect((await db.doc(`platformTransactions/${p1.ptxId}`).get()).get('status')).toBe('completed')
    expect(await wallet(uid)).toMatchObject({ available: 10_000, inTransit: 7_000 })
    expect(await reqDoc(a)).toMatchObject({ status: 'approved', amountPaise: 7_000, reserved: true })
    expect(await reqDoc(a)).not.toHaveProperty('payoutReview')
    expect(await check(uid)).toEqual([])
    // the retry applies the refund AND the review together
    expect(await reverse(p1.ptxId)).toMatchObject({ reversed: true, debited: 6_000 })  // available 4,000 < 7,000
    expect(await wallet(uid)).toMatchObject({ available: 4_000, inTransit: 0 })
    expect(await reqDoc(a)).toMatchObject({ status: 'approved', reserved: false, payoutReview: { status: 'open' } })
    const before = await wallet(uid)
    const paid = await settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: 'UTR3' }, SUPER2)
    expect(paid).toMatchObject({ status: 409, body: { code: 'UNDER_REVIEW' } })
    expect(await wallet(uid)).toEqual(before)
    expect(await reqDoc(a)).toMatchObject({ status: 'approved' })
    expect(await auditRows(a, 'settlement.paid')).toHaveLength(0)
    // the recovery re-check (idempotent) finds nothing more to do
    expect(await refit(uid)).toEqual({ organizerUid: uid, reviewed: [] })
    expect(await check(uid)).toEqual([])
  }, T)

  it('4 · auto-reject AUDIT failure: the rejection still commits; the failure is alerted; no audit row exists', async () => {
    const uid = await organizer('auditfail')
    const p1 = await released(uid, 6_000)
    await released(uid, 1_000)
    const a = await open(uid, 5_000, true)
    // M1 — the review's audit row is staged IN the refund transaction: a failed audit write commits NOTHING
    // (no review without its audit, no silent loss); the reversal is retried and then commits with its audit
    const { Transaction } = await import('firebase-admin/firestore')
    const realCreate = Transaction.prototype.create
    const spy = vi.spyOn(Transaction.prototype, 'create').mockImplementation(function (this: InstanceType<typeof Transaction>, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
      if (ref.path.startsWith('adminAuditLogs/settlement_review_')) throw new Error('injected audit failure')
      return realCreate.call(this, ref, data)
    } as never)
    await expect(reverse(p1.ptxId)).rejects.toThrow(/injected audit failure/)           // available would be 1,000 < 5,000
    spy.mockRestore()
    expect((await db.doc(`platformTransactions/${p1.ptxId}`).get()).get('status')).toBe('completed')
    expect(await reqDoc(a)).toMatchObject({ status: 'approved', reserved: true })
    expect(await wallet(uid)).toMatchObject({ available: 7_000, inTransit: 5_000 })
    expect(await auditRows(a, 'settlement.review_opened')).toHaveLength(0)
    await reverse(p1.ptxId)
    expect(await reqDoc(a)).toMatchObject({ status: 'approved', reserved: false, payoutReview: { status: 'open' } })
    expect(await wallet(uid)).toMatchObject({ available: 1_000, inTransit: 0 })
    expect(await auditRows(a, 'settlement.review_opened')).toHaveLength(1)
    expect(await auditRows(a, 'settlement.rejected')).toHaveLength(0)
  }, T)

  // ═══ 2 · the mark-paid guard ═══════════════════════════════════════════════════════════════
  it('5 · mark-paid guard: refused (422, nothing written) when available < amount; allowed at exactly available', async () => {
    const uid = await organizer('guard')
    await released(uid, 5_000)
    const a = await open(uid, 5_000, true)
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: 4_999 })    // synthetic: one paisa short
    const before = await wallet(uid)
    const r = await settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: 'UTR5' }, SUPER2)
    expect(r).toMatchObject({ status: 422, body: { error: 'Insufficient available balance. Available: ₹49.99.' } })
    expect(await wallet(uid)).toEqual(before)
    expect(await reqDoc(a)).toMatchObject({ status: 'approved' })
    expect(await reqDoc(a)).not.toHaveProperty('utrNumber')
    expect(await auditRows(a, 'settlement.paid')).toHaveLength(0)
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: 5_000 })    // exactly enough
    expect((await settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: 'UTR5' }, SUPER2)).status).toBe(200)
    expect(await wallet(uid)).toMatchObject({ available: 0, inTransit: 0, settled: 5_000 })
    expect(await check(uid)).toEqual([])
  }, T)

  // ═══ 3 · donation refund with pending + approved requests, and parity ══════════════════════
  it('6 · donation refund with an APPROVED and a PENDING request: inTransit capped only — both keep full amount and status; no auto-reject, no audit; reconciliation reports the drift; the approved one cannot be paid', async () => {
    const uid = await organizer('don')
    const d = await released(uid, 10_000, 'donation')
    const a = await open(uid, 6_000, true)
    const b = await open(uid, 2_000, false)
    expect(await wallet(uid)).toMatchObject({ available: 10_000, inTransit: 8_000 })
    const refundId = await donationRefund(d, uid, 5_000)
    expect(await applyDonation(refundId)).toMatchObject({ applied: true, reversedPaise: 5_000, insolvent: false })
    // M1 — the same review as a registration refund: a (6,000) no longer fits 5,000 → review; b (2,000) kept
    expect(await wallet(uid)).toMatchObject({ available: 5_000, inTransit: 2_000 })
    expect(await reqDoc(a)).toMatchObject({ status: 'approved', amountPaise: 6_000, reserved: false, payoutReview: { status: 'open', trigger: { kind: 'donation_refund', ref: refundId } } })
    expect(await reqDoc(b)).toMatchObject({ status: 'pending', amountPaise: 2_000, reserved: true })
    await new Promise(r => setTimeout(r, 500))                                         // give any stray async audit time
    expect(await auditRows(a, 'settlement.rejected')).toHaveLength(0)
    expect(await auditRows(b, 'settlement.rejected')).toHaveLength(0)
    expect(await auditRows(a, 'settlement.review_opened')).toHaveLength(1)             // M1
    expect(await check(uid)).toEqual([])                                               // M1 — no drift
    // a pending request exists (and one is under review): a new request is refused
    expect((await request(uid, 100)).status).toBe(409)
    // the approved request is under review: mark-paid refuses (M1: 409 UNDER_REVIEW)
    expect((await settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: 'UTR6' }, SUPER2))).toMatchObject({ status: 409, body: { code: 'UNDER_REVIEW' } })
    // approving the pending one is NOT balance-checked (current behaviour)
    expect((await settle(b, { action: 'approve', reason: 'checked for test' })).status).toBe(200)
    expect(await reqDoc(b)).toMatchObject({ status: 'approved' })
    expect(await wallet(uid)).toMatchObject({ available: 5_000, inTransit: 2_000 })
    // M1 — with no request PENDING, a request under review still blocks a new one
    expect((await request(uid, 100)).status).toBe(409)
  }, T)

  it('7 · PARITY: the same refund on a registration vs a donation, with the same open requests, ends differently today', async () => {
    // registration: 10,000 released as two 5,000 payments; ONE is fully refunded (5,000 out of available)
    const r = await (async () => {
      const uid = await organizer('par-reg')
      const p1 = await released(uid, 5_000)
      await released(uid, 5_000)
      const a = await open(uid, 6_000, true)
      const b = await open(uid, 2_000, false)
      await reverse(p1.ptxId)
      return { uid, a, b }
    })()
    // donation: 10,000 released as one donation; a 5,000 partial refund (5,000 out of available)
    const dn = await (async () => {
      const uid = await organizer('par-don')
      const p = await released(uid, 10_000, 'donation')
      const a = await open(uid, 6_000, true)
      const b = await open(uid, 2_000, false)
      await applyDonation(await donationRefund(p, uid, 5_000))
      return { uid, a, b }
    })()
    // the same money left in available after the refund…
    expect((await wallet(r.uid)).available).toBe(5_000)
    expect((await wallet(dn.uid)).available).toBe(5_000)
    // …but different request outcomes and in-transit:
    // M1 — PARITY: both paths now end the same way (approved 6,000 under review; pending 2,000 kept)
    expect([(await reqDoc(r.a)).status, (await reqDoc(r.b)).status]).toEqual(['approved', 'pending'])
    expect((await reqDoc(r.a)).payoutReview).toMatchObject({ status: 'open', trigger: { kind: 'registration_refund' } })
    expect((await wallet(r.uid)).inTransit).toBe(2_000)
    expect(await check(r.uid)).toEqual([])
    expect([(await reqDoc(dn.a)).status, (await reqDoc(dn.b)).status]).toEqual(['approved', 'pending'])
    expect((await reqDoc(dn.a)).payoutReview).toMatchObject({ status: 'open', trigger: { kind: 'donation_refund' } })
    expect((await wallet(dn.uid)).inTransit).toBe(2_000)
    expect(await check(dn.uid)).toEqual([])
  }, T)

  // ═══ 4 · concurrency ════════════════════════════════════════════════════════════════════════
  it('8 · a registration refund CONCURRENT with mark-paid: one serial order wins; money is never paid AND kept, no bucket goes negative, the wallet reconciles', async () => {
    for (let i = 0; i < 3; i++) {
      const uid = await organizer(`race${i}`)
      const p1 = await released(uid, 5_000)
      await released(uid, 5_000)                                                       // available 10,000
      const a = await open(uid, 8_000, true)
      const [, paid] = await Promise.all([
        reverse(p1.ptxId),
        settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: `UTR8${i}` }, SUPER2),
      ])
      const w = await wallet(uid)
      const s = await reqDoc(a)
      const claw = (await db.collection('walletClawbacks').where('organizerUid', '==', uid).get()).docs.map(d => d.data())
      const outstanding = claw.reduce((t, c) => t + Number(c.outstandingAmountPaise ?? 0), 0)
      raceLog(`8.${i} mark-paid → ${paid.status}`)
      expect(w.available).toBeGreaterThanOrEqual(0)
      expect(w.inTransit).toBeLessThanOrEqual(w.available)
      if (paid.status === 200) {
        // paid first: 8,000 settled, the reversal took the 2,000 left and recorded 3,000 as a clawback
        expect(s.status).toBe('paid')
        expect(w).toMatchObject({ available: 0, inTransit: 0, settled: 8_000 })
        expect(outstanding).toBe(3_000)
      } else {
        // reversal first: the 8,000 request no longer fits — auto-rejected (409 on paid) or refused (422)
        expect([409, 422]).toContain(paid.status)
        expect(s.status).not.toBe('paid')
        expect(w).toMatchObject({ available: 5_000, settled: 0 })
        expect(outstanding).toBe(0)
      }
      expect(w.settled + w.available).toBe(5_000 + outstanding)                       // released net left + debt owed
      expect(await check(uid)).toEqual([])
    }
  }, T)

  it('8b · the two SERIAL orders, deterministically, for both kinds (the races above may only ever observe one)', async () => {
    for (const kind of ['registration', 'donation'] as const) {
      for (const order of ['paid_first', 'refund_first'] as const) {
        const uid = await organizer(`ser-${kind}-${order}`)
        let refund: () => Promise<unknown>
        if (kind === 'registration') {
          const p1 = await released(uid, 5_000)
          await released(uid, 5_000)
          refund = () => reverse(p1.ptxId)
        } else {
          const d = await released(uid, 10_000, 'donation')
          const rid = await donationRefund(d, uid, 5_000)
          refund = () => applyDonation(rid)
        }
        const a = await open(uid, 8_000, true)
        const pay = () => settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: `UTRS-${kind}-${order}` }, SUPER2)
        let paid: { status: number }
        if (order === 'paid_first') { paid = await pay(); await refund() } else { await refund(); paid = await pay() }
        const w = await wallet(uid)
        const outstanding = (await db.collection('walletClawbacks').where('organizerUid', '==', uid).get()).docs.reduce((t, c) => t + Number(c.get('outstandingAmountPaise') ?? 0), 0)
        if (order === 'paid_first') {
          expect(paid.status).toBe(200)
          expect(await reqDoc(a)).toMatchObject({ status: 'paid' })
          expect(w).toMatchObject({ available: 0, inTransit: 0, settled: 8_000 })
          expect(outstanding).toBe(3_000)                                                // the refund of paid-out money became a debt
        } else {
          // M1 — both kinds: held for review before the payout; mark-paid refuses with UNDER_REVIEW
          expect(paid.status).toBe(409)
          expect(await reqDoc(a)).toMatchObject({ status: 'approved', reserved: false, payoutReview: { status: 'open' } })
          expect(w).toMatchObject({ available: 5_000, inTransit: 0, settled: 0 })
          expect(outstanding).toBe(0)
        }
        expect(w.settled + w.available).toBe(5_000 + outstanding)
      }
    }
  }, T)

  it('9 · a donation refund CONCURRENT with mark-paid: same safety; with no re-fit, a "refund first" order leaves the approved request open but unpayable', async () => {
    for (let i = 0; i < 3; i++) {
      const uid = await organizer(`drace${i}`)
      const d = await released(uid, 10_000, 'donation')
      const a = await open(uid, 8_000, true)
      const rid = await donationRefund(d, uid, 5_000)
      const [, paid] = await Promise.all([
        applyDonation(rid),
        settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: `UTR9${i}` }, SUPER2),
      ])
      const w = await wallet(uid)
      const s = await reqDoc(a)
      const outstanding = (await db.collection('walletClawbacks').where('organizerUid', '==', uid).get()).docs.reduce((t, c) => t + Number(c.get('outstandingAmountPaise') ?? 0), 0)
      raceLog(`9.${i} mark-paid → ${paid.status}`)
      expect(w.available).toBeGreaterThanOrEqual(0)
      expect(w.inTransit).toBeLessThanOrEqual(w.available)
      if (paid.status === 200) {
        expect(s.status).toBe('paid')
        expect(w).toMatchObject({ available: 0, inTransit: 0, settled: 8_000 })
        expect(outstanding).toBe(3_000)
      } else {
        // M1 — refund first: held for review in the refund transaction; mark-paid refuses with UNDER_REVIEW
        expect(paid.status).toBe(409)
        expect(s).toMatchObject({ status: 'approved', reserved: false, payoutReview: { status: 'open' } })
        expect(w).toMatchObject({ available: 5_000, inTransit: 0, settled: 0 })
        expect(outstanding).toBe(0)
      }
      expect(w.settled + w.available).toBe(5_000 + outstanding)
    }
  }, T)
})
