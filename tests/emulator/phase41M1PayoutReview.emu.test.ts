// M1 — payout/refund integrity, on REAL Firestore through the REAL code: credit, release job, registration
// reversal, donation refund accounting, organizer + admin settlement routes, Notification Center writes.
// Synthetic emulator data only; the Razorpay stub can never create a refund, and nothing makes a bank transfer.
//
//   a refund that leaves a payout request unbacked → the request is HELD FOR REVIEW in the refund transaction
//   (status and full amount kept, reservation released, audit + organizer notification staged with it);
//   approve / mark-paid refuse while it is open; new organizer requests are refused; a Super Admin resumes it
//   (only if funded), rejects it (an approved one needs confirmNoTransfer) or records a transfer that DID complete
//   (paid; an uncovered part becomes a 'payout_shortfall' clawback).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000
const SUPER = `m1-super-${P}`, SUPER2 = `m1-super2-${P}`

const h = vi.hoisted(() => ({
  who: '' as string, admin: '' as string,
  captured: [] as Array<{ scope?: unknown }>,
  failOpenRead: false,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({
  ...(await orig<typeof import('@/lib/monitoring/sentry')>()),
  captureFinancialError: (_e: unknown, ctx?: { scope?: unknown }) => { h.captured.push(ctx ?? {}) },
  captureError: () => undefined,
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_m1', RAZORPAY_KEY_SECRET: 'm1',
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
vi.mock('@/lib/settlements/payoutReview', async orig => {
  const real = await orig<typeof import('@/lib/settlements/payoutReview')>()
  return { ...real, readOpenPayoutRequests: async (...a: Parameters<typeof real.readOpenPayoutRequests>) => {
    if (h.failOpenRead) throw new Error('injected open-request read failure')
    return real.readOpenPayoutRequests(...a)
  } }
})

const req = (body?: unknown, method = 'POST') => new NextRequest('http://localhost/api/test', {
  method, headers: { 'Content-Type': 'application/json', authorization: 'Bearer t' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

describeEmu('M1 · payout requests held for review when a refund leaves them unbacked', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let applyDonation: typeof import('@/lib/donations/refundService').applyDonationRefundAccounting
  let reconcileWallet: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
  let recheck: typeof import('@/lib/settlements/payoutReview').recheckPayoutReservations
  const savedAdminUids = process.env.ADMIN_UIDS
  const created = new Set<string>()
  const orgs = new Set<string>()   // M1.1 — their payout requests are removed afterwards (platform-wide totals)
  let n = 0

  // ── fixtures (same conventions as the Phase 4.0A suite) ─────────────────────────────────────
  const PROFILE_MS = Date.parse('2026-09-01T10:00:00.000Z')
  async function organizer(tag: string) {
    const uid = `m1-org-${tag}-${P}-${++n}`
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
  async function released(uid: string, net: number, kind: 'registration' | 'donation' = 'registration') {
    const id = `m1-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed',
      organizerUid: uid, entityId: `m1-ev-${P}`, entityType: kind === 'donation' ? 'campaign' : 'event', sourceId: id, sourceType: kind,
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
      gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR',
      gateway: 'razorpay', gatewayPaymentId: `p_${id}`, gatewayOrderId: `o_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - 30 * DAY) })
    await release({ limit: 500 })
    expect((await db.doc(`platformTransactions/ptx_${id}`).get()).get('releaseStatus')).toBe('released')
    if (kind === 'donation') {
      const slug = `m1-camp-${P}-${n}`
      await db.doc(`donations/${id}`).set({ amountPaise: net, campaignSlug: slug, donorEmail: `d${n}@x.test`, donorName: 'D', isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: `o_${id}`, organizerUid: uid })
      return { id, ptxId: `ptx_${id}`, slug }
    }
    return { id, ptxId: `ptx_${id}`, slug: '' }
  }
  async function donationRefund(d: { id: string; slug: string }, uid: string, amount: number) {
    const refundId = `rfnd_m1_${P}_${++n}`
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
  const listOwn = async (uid: string) => {
    const { GET } = await import('@/app/api/organizer/settlements/route')
    h.who = uid
    const r = await json(await GET(req(undefined, 'GET')))
    h.who = ''
    return r.body.requests as Array<{ id: string; status: string; underReview?: boolean }>
  }
  const settle = async (id: string, body: Record<string, unknown>, as = SUPER) => {
    const { PATCH } = await import('@/app/api/admin/settlements/[id]/route')
    h.admin = as
    return json(await PATCH(req(body, 'PATCH'), ctx(id)))
  }
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
  const reviewNotice = async (uid: string, id: string, triggerRef: string) =>
    (await db.doc(`users/${uid}/notifications/settlement-${id}-review-${triggerRef}`).get()).data() ?? null
  const scopes = () => h.captured.map(c => c.scope)
  const check = async (uid: string) =>
    (await reconcileWallet(uid, (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!)).map(m => [m.field, m.expected, m.actual])
  const clawbacksOf = async (uid: string) => (await db.collection('walletClawbacks').where('organizerUid', '==', uid).get()).docs.map(d => ({ id: d.id, ...d.data() }))

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    process.env.ADMIN_UIDS = `${SUPER},${SUPER2}`
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    applyDonation = (await import('@/lib/donations/refundService')).applyDonationRefundAccounting
    reconcileWallet = (await import('@/lib/reconciliation/wallets')).reconcileOneWallet
    recheck = (await import('@/lib/settlements/payoutReview')).recheckPayoutReservations
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
  beforeEach(() => { h.who = ''; h.admin = ''; h.captured.length = 0; h.failOpenRead = false })
  afterEach(() => { h.failOpenRead = false; vi.restoreAllMocks() })

  it('1 · REGISTRATION refund: the unbacked request is held for review (status + amount kept, reservation released); audit + organizer notification committed with it; the organizer sees it and cannot request again', async () => {
    const uid = await organizer('reg')
    const p1 = await released(uid, 6_000)
    await released(uid, 4_000)                                                         // available 10,000
    const a = await open(uid, 7_000, true)
    expect(await reverse(p1.ptxId)).toMatchObject({ reversed: true, debited: 6_000, insolvent: false })
    expect(await wallet(uid)).toMatchObject({ available: 4_000, inTransit: 0 })
    expect(await reqDoc(a)).toMatchObject({
      status: 'approved', amountPaise: 7_000, reserved: false,
      payoutReview: { status: 'open', reason: 'available_below_reservations', trigger: { kind: 'registration_refund', ref: p1.ptxId }, statusAtReview: 'approved', requestedAmountPaise: 7_000, availableAtReviewPaise: 4_000, keptAheadPaise: 0 },
    })
    const [row] = await auditRows(a, 'settlement.review_opened')
    expect(row).toMatchObject({ adminUid: 'system', actorRole: 'system', before: { reserved: true }, after: { reserved: false, review: 'open' }, metadata: { trigger: { kind: 'registration_refund', ref: p1.ptxId } } })
    expect(await reviewNotice(uid, a, p1.ptxId)).toMatchObject({ category: 'settlement', type: 'SETTLEMENT_UNDER_REVIEW', severity: 'warning', link: '/dashboard/finance/settlements' })
    expect(scopes()).toContain('reversePlatformTransactionAndDebit.payout_review_opened')
    expect((await listOwn(uid)).find(r => r.id === a)).toMatchObject({ status: 'approved', underReview: true })
    const again = await request(uid, 100)
    expect(again.status).toBe(409)
    expect(String(again.body.error)).toMatch(/on hold for review/)
    expect(await check(uid)).toEqual([])
  }, T)

  it('2 · DONATION refund: the equivalent review (same fields, audit, notification); parity with registrations', async () => {
    const uid = await organizer('don')
    const d = await released(uid, 10_000, 'donation')
    const a = await open(uid, 7_000, true)
    const rid = await donationRefund(d, uid, 6_000)
    expect(await applyDonation(rid)).toMatchObject({ applied: true, reversedPaise: 6_000 })
    expect(await wallet(uid)).toMatchObject({ available: 4_000, inTransit: 0 })
    expect(await reqDoc(a)).toMatchObject({ status: 'approved', amountPaise: 7_000, reserved: false, payoutReview: { status: 'open', trigger: { kind: 'donation_refund', ref: rid }, availableAtReviewPaise: 4_000 } })
    expect(await auditRows(a, 'settlement.review_opened')).toHaveLength(1)
    expect(await reviewNotice(uid, a, rid)).toMatchObject({ type: 'SETTLEMENT_UNDER_REVIEW' })
    expect(scopes()).toContain('applyDonationRefundAccounting.payout_review_opened')
    expect((await request(uid, 100)).status).toBe(409)
    expect(await check(uid)).toEqual([])
  }, T)

  it('3 · a request that still FITS stays valid: no review, no audit, no notification, reservation intact (both kinds)', async () => {
    for (const kind of ['registration', 'donation'] as const) {
      const uid = await organizer(`fits-${kind}`)
      let refund: () => Promise<unknown>; let ref: string
      if (kind === 'registration') { const p1 = await released(uid, 2_000); await released(uid, 8_000); refund = () => reverse(p1.ptxId); ref = p1.ptxId }
      else { const d = await released(uid, 10_000, 'donation'); ref = await donationRefund(d, uid, 2_000); refund = () => applyDonation(ref) }
      const a = await open(uid, 6_000, true)
      const b = await open(uid, 2_000, false)
      await refund()                                                                   // available 8,000 = 6,000 + 2,000
      expect(await wallet(uid)).toMatchObject({ available: 8_000, inTransit: 8_000 })
      for (const id of [a, b]) {
        expect(await reqDoc(id)).toMatchObject({ reserved: true })
        expect(await reqDoc(id)).not.toHaveProperty('payoutReview')
        expect(await auditRows(id, 'settlement.review_opened')).toHaveLength(0)
        expect(await reviewNotice(uid, id, ref)).toBeNull()
      }
      expect((await settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: `UTR3-${kind}` }, SUPER2)).status).toBe(200)
      expect(await check(uid)).toEqual([])
    }
  }, T)

  it('4 · while under review: approve and mark-paid refuse (409 UNDER_REVIEW), nothing written', async () => {
    const uid = await organizer('blocked')
    const p1 = await released(uid, 6_000)
    await released(uid, 4_000)
    const pend = await open(uid, 9_000, false)                                         // pending, reserved
    await reverse(p1.ptxId)                                                            // 4,000 < 9,000 → review
    expect(await reqDoc(pend)).toMatchObject({ status: 'pending', payoutReview: { status: 'open', statusAtReview: 'pending' } })
    const before = await wallet(uid)
    expect(await settle(pend, { action: 'approve', reason: 'try approving' })).toMatchObject({ status: 409, body: { code: 'UNDER_REVIEW' } })
    expect(await reqDoc(pend)).toMatchObject({ status: 'pending' })
    expect(await wallet(uid)).toEqual(before)
    // an approved one under review cannot be marked paid
    const uid2 = await organizer('blocked2')
    const q1 = await released(uid2, 6_000)
    await released(uid2, 4_000)
    const appr = await open(uid2, 7_000, true)
    await reverse(q1.ptxId)
    const before2 = await wallet(uid2)
    expect(await settle(appr, { action: 'paid', reason: 'bank transfer sent', utrNumber: 'UTR4' }, SUPER2)).toMatchObject({ status: 409, body: { code: 'UNDER_REVIEW' } })
    expect(await wallet(uid2)).toEqual(before2)
    expect(await reqDoc(appr)).not.toHaveProperty('utrNumber')
    expect(await auditRows(appr, 'settlement.paid')).toHaveLength(0)
  }, T)

  it('5 · resume only when funded: refused while unfunded; after new funds it re-reserves (audited, organizer notified) and mark-paid then succeeds under the existing rules', async () => {
    const uid = await organizer('resume')
    const p1 = await released(uid, 6_000)
    await released(uid, 4_000)
    const a = await open(uid, 7_000, true)
    await reverse(p1.ptxId)                                                            // available 4,000
    expect(await settle(a, { action: 'resume_review', reason: 'checking funds' })).toMatchObject({ status: 409, body: { code: 'STILL_UNFUNDED' } })
    expect(await reqDoc(a)).toMatchObject({ reserved: false, payoutReview: { status: 'open' } })
    await released(uid, 3_000)                                                         // available 7,000
    expect((await settle(a, { action: 'resume_review', reason: 'balance restored' })).status).toBe(200)
    expect(await reqDoc(a)).toMatchObject({ status: 'approved', reserved: true, payoutReview: { status: 'resolved', outcome: 'resumed', resolvedBy: SUPER, resolutionReason: 'balance restored' } })
    expect(await wallet(uid)).toMatchObject({ available: 7_000, inTransit: 7_000 })
    expect(await auditRows(a, 'settlement.review_resumed')).toEqual([expect.objectContaining({ adminUid: SUPER, reason: 'balance restored' })])
    expect((await db.doc(`users/${uid}/notifications/settlement-${a}-resumed-${p1.ptxId}`).get()).data()).toMatchObject({ type: 'SETTLEMENT_RESUMED' })   // M1.1 — keyed per review
    expect(await settle(a, { action: 'resume_review', reason: 'again' })).toMatchObject({ status: 409, body: { code: 'NOT_UNDER_REVIEW' } })   // idempotent
    expect((await settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: 'UTR5' }, SUPER)).status).toBe(409)   // maker-checker still applies
    expect((await settle(a, { action: 'paid', reason: 'bank transfer sent', utrNumber: 'UTR5' }, SUPER2)).status).toBe(200)
    expect(await wallet(uid)).toMatchObject({ available: 0, inTransit: 0, settled: 7_000 })
    expect(await check(uid)).toEqual([])
  }, T)

  it('6 · a CONFIRMED transfer is recorded, never re-sent or treated as unpaid: paid with the UTR; the uncovered part is a payout_shortfall clawback; it cannot be recorded or paid again; the wallet reconciles; the debt is recovered from the next release', async () => {
    const uid = await organizer('transfer')
    const p1 = await released(uid, 6_000)
    await released(uid, 4_000)
    const a = await open(uid, 7_000, true)                                             // approved by SUPER; bank transfer made
    await reverse(p1.ptxId)                                                            // refund lands before mark-paid → review
    expect(await settle(a, { action: 'record_transfer', reason: 'transfer confirmed' }, SUPER2)).toMatchObject({ status: 422 })   // UTR required
    expect(await settle(a, { action: 'record_transfer', reason: 'transfer confirmed', utrNumber: 'UTR6' }, SUPER)).toMatchObject({ status: 409, body: { code: 'MAKER_CHECKER_REQUIRED' } })
    const r = await settle(a, { action: 'record_transfer', reason: 'transfer confirmed by bank statement', utrNumber: 'UTR6' }, SUPER2)
    expect(r).toMatchObject({ status: 200, body: { status: 'paid' } })
    expect(await reqDoc(a)).toMatchObject({
      status: 'paid', utrNumber: 'UTR6', paidByAdmin: SUPER2,
      payoutReview: { status: 'resolved', outcome: 'paid_after_transfer', shortfallPaise: 3_000, clawbackId: `clawback_payout_${a}`, resolvedBy: SUPER2 },
    })
    expect(await wallet(uid)).toMatchObject({ available: 0, inTransit: 0, settled: 7_000 })
    expect(await clawbacksOf(uid)).toEqual([expect.objectContaining({
      id: `clawback_payout_${a}`, sourceType: 'settlement', sourceId: a, reason: 'payout_shortfall',
      reversalAmountPaise: 7_000, recoveredAmountPaise: 4_000, outstandingAmountPaise: 3_000, status: 'partially_recovered',
    })])
    const [paidRow] = await auditRows(a, 'settlement.paid')
    expect(paidRow).toMatchObject({ adminUid: SUPER2, metadata: { reviewResolution: 'paid_after_transfer', takenFromAvailablePaise: 4_000, shortfallPaise: 3_000, approvedBy: SUPER, makerChecker: 'distinct_approver' } })
    expect(scopes()).toContain('settlement.record_transfer_shortfall')
    expect(await check(uid)).toEqual([])
    // never twice, never paid again, never rejected afterwards
    expect((await settle(a, { action: 'record_transfer', reason: 'again', utrNumber: 'UTR6' }, SUPER2)).status).toBe(409)
    expect((await settle(a, { action: 'paid', reason: 'again', utrNumber: 'UTR6' }, SUPER2)).status).toBe(409)
    expect((await settle(a, { action: 'reject', reason: 'reject paid', confirmNoTransfer: true })).status).toBe(409)
    expect(await wallet(uid)).toMatchObject({ available: 0, settled: 7_000 })
    // the organizer is no longer blocked (no open review) — a new request is judged on the free balance (0)
    expect((await request(uid, 100)).status).toBe(422)
    // the debt is recovered from the next release; the wallet still reconciles
    await released(uid, 5_000)
    expect(await clawbacksOf(uid)).toEqual([expect.objectContaining({ id: `clawback_payout_${a}`, status: 'recovered', outstandingAmountPaise: 0 })])
    expect(await wallet(uid)).toMatchObject({ available: 2_000 })
    expect(await check(uid)).toEqual([])
  }, T)

  it('7 · interleavings: refund first ⇒ review then a recorded transfer; recording a transfer that consumes another request\'s backing sends THAT one to review in the same transaction; a refund concurrent with a recorded transfer keeps every invariant', async () => {
    const uid = await organizer('cascade')
    const p1 = await released(uid, 5_000)
    await released(uid, 9_000)                                                         // available 14,000
    const a = await open(uid, 8_000, true)                                             // oldest approved
    const b = await open(uid, 5_000, true)
    await reverse(p1.ptxId)                                                            // 9,000: a kept (8,000), b → review
    expect(await reqDoc(b)).toMatchObject({ payoutReview: { status: 'open' } })
    expect(await wallet(uid)).toMatchObject({ available: 9_000, inTransit: 8_000 })
    // b had in fact been transferred: recording it takes the 9,000 available, so a (8,000) loses its backing
    expect((await settle(b, { action: 'record_transfer', reason: 'transfer confirmed', utrNumber: 'UTR7B' }, SUPER2)).status).toBe(200)
    expect(await wallet(uid)).toMatchObject({ available: 4_000, inTransit: 0, settled: 5_000 })
    expect(await reqDoc(a)).toMatchObject({ status: 'approved', reserved: false, payoutReview: { status: 'open', trigger: { kind: 'payout_after_transfer', ref: b } } })
    expect(await clawbacksOf(uid)).toEqual([])                                         // 5,000 fully covered: no debt
    expect(scopes()).toContain('settlement.record_transfer_review_opened')
    expect(await check(uid)).toEqual([])
    // concurrent: a refund and the recording of a's (completed) transfer
    const q = await released(uid, 3_000)                                               // available 7,000
    const [, rec] = await Promise.all([
      reverse(q.ptxId),
      settle(a, { action: 'record_transfer', reason: 'transfer confirmed', utrNumber: 'UTR7A' }, SUPER2),
    ])
    expect(rec.status).toBe(200)
    const w = await wallet(uid)
    expect(w.available).toBeGreaterThanOrEqual(0)
    expect(w.inTransit).toBeLessThanOrEqual(w.available)
    expect(w.settled).toBe(13_000)
    // either order ends the same: refund first ⇒ the transfer takes 4,000 and owes 4,000; transfer first ⇒ it takes
    // 7,000 and owes 1,000, then the refund finds nothing left and owes 3,000. Paid out 13,000 against 9,000 net.
    const owed = (await clawbacksOf(uid)).reduce((t, c) => t + Number((c as { outstandingAmountPaise?: number }).outstandingAmountPaise ?? 0), 0)
    expect(w.available).toBe(0)
    expect(owed).toBe(4_000)
    expect(await check(uid)).toEqual([])
  }, T)

  it('8 · duplicates are idempotent: a replayed reversal / donation refund opens no second review, audit or notification; re-checks change nothing', async () => {
    const uid = await organizer('dup')
    const p1 = await released(uid, 6_000)
    await released(uid, 4_000)
    const a = await open(uid, 7_000, true)
    await reverse(p1.ptxId)
    expect(await reverse(p1.ptxId)).toMatchObject({ reversed: false })
    expect(await auditRows(a, 'settlement.review_opened')).toHaveLength(1)
    expect((await db.collection(`users/${uid}/notifications`).where('type', '==', 'SETTLEMENT_UNDER_REVIEW').get()).size).toBe(1)
    const w1 = await wallet(uid)
    expect(await recheck(uid, { kind: 'manual_recheck', ref: 'dup-1' })).toEqual({ organizerUid: uid, reviewed: [], inTransitPaise: 0 })
    expect(await wallet(uid)).toEqual(w1)
    // donation replay
    const u2 = await organizer('dup-don')
    const d = await released(u2, 10_000, 'donation')
    const b = await open(u2, 7_000, true)
    const rid = await donationRefund(d, u2, 6_000)
    await applyDonation(rid)
    expect(await applyDonation(rid)).toMatchObject({ applied: false })
    expect(await auditRows(b, 'settlement.review_opened')).toHaveLength(1)
    expect(await check(u2)).toEqual([])
  }, T)

  it('9 · a re-fit FAILURE is visible and recoverable: the refund transaction fails WHOLE (nothing committed); the retry commits refund + review together; drift found later is repaired by the re-check', async () => {
    const uid = await organizer('fail')
    const d = await released(uid, 10_000, 'donation')
    const a = await open(uid, 7_000, true)
    const rid = await donationRefund(d, uid, 6_000)
    h.failOpenRead = true
    await expect(applyDonation(rid)).rejects.toThrow(/injected open-request read failure/)
    h.failOpenRead = false
    expect((await db.doc(`donationRefunds/${rid}`).get()).get('status')).toBe('pending')
    expect((await db.doc(`platformTransactions/ptx_refund_${rid}`).get()).exists).toBe(false)
    expect(await wallet(uid)).toMatchObject({ available: 10_000, inTransit: 7_000 })
    expect(await reqDoc(a)).toMatchObject({ reserved: true })
    expect(await reqDoc(a)).not.toHaveProperty('payoutReview')
    expect(await applyDonation(rid)).toMatchObject({ applied: true })                 // the retry
    expect(await reqDoc(a)).toMatchObject({ reserved: false, payoutReview: { status: 'open' } })
    expect(await check(uid)).toEqual([])
    // drift (e.g. a balance corrected out of band): reconciliation reports it; the re-check routes it to review
    const u2 = await organizer('drift')
    await released(u2, 10_000)
    const b = await open(u2, 6_000, true)
    await db.doc(`organizerRevenueWallets/${u2}`).update({ availablePaise: 5_000 })      // synthetic out-of-band change
    expect(await check(u2)).toEqual(expect.arrayContaining([['inTransitWithinAvailable', 0, 1_000]]))
    expect(await recheck(u2, { kind: 'manual_recheck', ref: 'drift-1' })).toEqual({ organizerUid: u2, reviewed: [{ id: b, amountPaise: 6_000 }], inTransitPaise: 0 })
    expect(await reqDoc(b)).toMatchObject({ payoutReview: { status: 'open', trigger: { kind: 'manual_recheck', ref: 'drift-1' } } })
    expect(await recheck(u2, { kind: 'manual_recheck', ref: 'drift-2' })).toMatchObject({ reviewed: [] })
  }, T)

  it('10 · audit / notification failures: a failed review audit (in the refund transaction) commits nothing; a failed resolution audit changes nothing; a failed organizer notification never undoes a decision', async () => {
    const uid = await organizer('auditfail')
    const p1 = await released(uid, 6_000)
    await released(uid, 4_000)
    const a = await open(uid, 7_000, true)
    const realCreate = FS.Transaction.prototype.create
    const failAudit = (prefix: string) => vi.spyOn(FS.Transaction.prototype, 'create').mockImplementation(function (this: InstanceType<typeof FS.Transaction>, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
      if (ref.path.startsWith(prefix)) throw new Error('injected audit failure')
      return realCreate.call(this, ref, data)
    } as never)
    let spy = failAudit('adminAuditLogs/settlement_review_')
    await expect(reverse(p1.ptxId)).rejects.toThrow(/injected audit failure/)
    spy.mockRestore()
    expect((await db.doc(`platformTransactions/${p1.ptxId}`).get()).get('status')).toBe('completed')
    expect(await reqDoc(a)).toMatchObject({ reserved: true })
    await reverse(p1.ptxId)
    expect(await reqDoc(a)).toMatchObject({ payoutReview: { status: 'open' } })
    // the resume's audit fails ⇒ nothing changes (the request stays under review, the wallet untouched)
    await released(uid, 3_000)
    const before = await wallet(uid)
    spy = failAudit('adminAuditLogs/')
    expect((await settle(a, { action: 'resume_review', reason: 'balance restored' })).status).toBe(500)
    spy.mockRestore()
    expect(await reqDoc(a)).toMatchObject({ reserved: false, payoutReview: { status: 'open' } })
    expect(await wallet(uid)).toEqual(before)
    // the organizer notification after a resume fails ⇒ the resume stands
    const realSet = FS.DocumentReference.prototype.set
    vi.spyOn(FS.DocumentReference.prototype, 'set').mockImplementation(function (this: FirebaseFirestore.DocumentReference, ...args: unknown[]) {
      if (this.path.includes('/notifications/')) return Promise.reject(new Error('injected notification failure'))
      return (realSet as (...x: unknown[]) => Promise<unknown>).apply(this, args)
    } as never)
    expect((await settle(a, { action: 'resume_review', reason: 'balance restored' })).status).toBe(200)
    await new Promise(r => setTimeout(r, 300))
    vi.restoreAllMocks()
    expect(await reqDoc(a)).toMatchObject({ reserved: true, payoutReview: { status: 'resolved', outcome: 'resumed' } })
    expect((await db.collection(`users/${uid}/notifications`).where('type', '==', 'SETTLEMENT_RESUMED').get()).size).toBe(0)
    expect(await check(uid)).toEqual([])
  }, T)

  it('12 · M1.1 · a refund on a wallet whose inTransit already DRIFTED below its reservations (as pre-M1 donation refunds left it) still reviews what the refund leaves unbacked (both kinds)', async () => {
    for (const kind of ['registration', 'donation'] as const) {
      const uid = await organizer(`drift-${kind}`)
      let refund: () => Promise<unknown>
      if (kind === 'registration') { await released(uid, 7_000); const p = await released(uid, 3_000); refund = () => reverse(p.ptxId) }
      else { const d = await released(uid, 10_000, 'donation'); const rid = await donationRefund(d, uid, 3_000); refund = () => applyDonation(rid) }
      const a = await open(uid, 6_000, true)
      const b = await open(uid, 2_000, false)                                          // reserved 8,000 of 10,000
      await db.doc(`organizerRevenueWallets/${uid}`).update({ inTransitPaise: 5_000 })   // legacy drift (pre-M1 cap)
      await refund()                                                                   // available 7,000 < 8,000 reserved, ≥ 5,000 stored
      expect(await wallet(uid)).toMatchObject({ available: 7_000, inTransit: 6_000 })
      expect(await reqDoc(a)).toMatchObject({ reserved: true })
      expect(await reqDoc(b)).toMatchObject({ status: 'pending', reserved: false, payoutReview: { status: 'open', keptAheadPaise: 6_000 } })
      expect(await check(uid)).toEqual([])
    }
  }, T)

  it('13 · M1.1 · every resume is notified: a request reviewed, resumed, reviewed again and resumed again gets a notification each time', async () => {
    const uid = await organizer('renotify')
    const p1 = await released(uid, 6_000)
    await released(uid, 4_000)                                                         // available 10,000
    const a = await open(uid, 7_000, true)
    await reverse(p1.ptxId)                                                            // 4,000 → review 1
    const p2 = await released(uid, 3_000)                                              // 7,000
    expect((await settle(a, { action: 'resume_review', reason: 'funds back' })).status).toBe(200)
    const p3 = await released(uid, 2_000)                                              // 9,000
    await reverse(p3.ptxId)                                                            // 7,000: still fits
    expect(await reqDoc(a)).toMatchObject({ reserved: true })
    await reverse(p2.ptxId)                                                            // 4,000 → review 2
    expect(await reqDoc(a)).toMatchObject({ reserved: false, payoutReview: { status: 'open', trigger: { ref: p2.ptxId } } })
    await released(uid, 3_000)                                                         // 7,000
    expect((await settle(a, { action: 'resume_review', reason: 'funds back again' })).status).toBe(200)
    await new Promise(r => setTimeout(r, 300))                                         // the resume notice is written after commit
    const notices = (await db.collection(`users/${uid}/notifications`).get()).docs.map(d => d.get('type'))
    expect(notices.filter(t => t === 'SETTLEMENT_UNDER_REVIEW')).toHaveLength(2)
    expect(notices.filter(t => t === 'SETTLEMENT_RESUMED')).toHaveLength(2)
  }, T)

  it('11 · several requests: approved-first greedy re-plan across successive refunds; inTransit always = kept reservations; rejecting an approved one under review needs confirmNoTransfer; new requests stay blocked until every review is resolved', async () => {
    const uid = await organizer('multi')
    const p1 = await released(uid, 3_000)
    const p2 = await released(uid, 2_000)
    await released(uid, 5_000)                                                         // available 10,000
    const a = await open(uid, 4_000, true)
    const b = await open(uid, 3_000, true)
    const c = await open(uid, 1_000, false)
    expect(await wallet(uid)).toMatchObject({ available: 10_000, inTransit: 8_000 })
    await reverse(p1.ptxId)                                                            // 7,000: a + b (7,000) fit; c (1,000) → review
    expect(await wallet(uid)).toMatchObject({ available: 7_000, inTransit: 7_000 })
    expect([(await reqDoc(a)).payoutReview, (await reqDoc(b)).payoutReview]).toEqual([undefined, undefined])
    expect(await reqDoc(c)).toMatchObject({ status: 'pending', payoutReview: { status: 'open', keptAheadPaise: 7_000 } })
    await reverse(p2.ptxId)                                                            // 5,000: a (4,000) kept; b (3,000) → review
    expect(await wallet(uid)).toMatchObject({ available: 5_000, inTransit: 4_000 })
    expect(await reqDoc(b)).toMatchObject({ status: 'approved', reserved: false, payoutReview: { status: 'open', keptAheadPaise: 4_000 } })
    expect(await auditRows(c, 'settlement.review_opened')).toHaveLength(1)            // c was not reviewed twice
    expect(await check(uid)).toEqual([])
    // rejecting the APPROVED request under review needs an explicit "no transfer was made"
    expect(await settle(b, { action: 'reject', reason: 'not funded' })).toMatchObject({ status: 409, body: { code: 'TRANSFER_CONFIRMATION_REQUIRED' } })
    expect((await settle(b, { action: 'reject', reason: 'not funded; no transfer made', confirmNoTransfer: true })).status).toBe(200)
    expect(await reqDoc(b)).toMatchObject({ status: 'rejected', payoutReview: { status: 'resolved', outcome: 'rejected' } })
    expect((await auditRows(b, 'settlement.rejected'))[0]).toMatchObject({ metadata: { reviewResolution: 'rejected', confirmNoTransfer: true, releasedHoldPaise: 0 } })
    expect(await wallet(uid)).toMatchObject({ available: 5_000, inTransit: 4_000 })    // nothing released twice
    expect((await request(uid, 100)).status).toBe(409)                                 // c is still under review (and pending)
    // the PENDING request under review needs no confirmation
    expect((await settle(c, { action: 'reject', reason: 'not funded' })).status).toBe(200)
    expect((await request(uid, 100)).status).toBe(201)                                 // unblocked: free 1,000 covers 100
    expect(await wallet(uid)).toMatchObject({ inTransit: 4_100 })
    expect(await check(uid)).toEqual([])
  }, T)
})
