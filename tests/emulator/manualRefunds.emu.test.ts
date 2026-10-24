// RD-REFUND-MANUAL-01 — Super Admin MANUAL attendee refunds, over real Firestore + Auth emulators and the REAL
// ledger: payments are credited through recordPlatformTransactionAndCredit, released by releaseEligibleFunds,
// and every scenario ends with the REAL wallet reconciliation (reconcileOneWallet) reporting no mismatch.
// Razorpay is never called: its refund LOOKUP is stubbed (and it is the only gateway function the manual
// workflow ever touches — it sends no money).
//
//   A  authorization — Super Admin only; maker-checker with no bypass
//   I  idempotency, duplicate submissions, concurrent requests
//   X  exclusivity with gateway refunds, both directions (route, webhook counting, retry, ledger reversal)
//   L  atomic ledger: full + partial (proportional, cumulatively exact), negative reversal rows, release of
//      the remainder, a paid-out settlement's clawback, payout requests sent to review, reconciliation clean
//   R  duplicate fund releases; the release-funds cron records a success the monitor does not flag as stopped

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `mr${process.pid}`
const DAY = 86_400_000

const h = vi.hoisted(() => ({ gatewayRefunds: [] as Array<{ id: string; amount: number; status: string }>, lookupFails: false, refundCalls: 0 }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_manual', RAZORPAY_KEY_SECRET: 'x',
  razorpay: {
    payments: {
      fetchMultipleRefund: async () => { if (h.lookupFails) throw new Error('lookup down'); return { items: h.gatewayRefunds } },
      // Must never be reached by the manual workflow; counted so a test can prove it.
      refund: async () => { h.refundCalls++; throw new Error('gateway refund must not be called') },
    },
  },
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined, flushMonitoring: async () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))

type Json = Record<string, unknown>

describeEmu('manual attendee refunds', () => {
  let db: import('firebase-admin/firestore').Firestore
  let auth: import('firebase-admin/auth').Auth
  let svc: typeof import('@/lib/refunds/manualRefunds')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let reconcile: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
  let accumulate: typeof import('@/lib/refunds/registrationRefunds').accumulatePaymentRefund
  let requestRoute: (req: Request, ctx: { params: Promise<{ registrationId: string }> }) => Promise<Response>
  let actionRoute: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
  let gatewayRoute: (req: Request, ctx: { params: Promise<{ registrationId: string }> }) => Promise<Response>

  const MAKER = `${P}-maker`, CHECKER = `${P}-checker`, ORG_USER = `${P}-orguser`
  const tokens: Record<string, string> = {}
  let prevAdmins: string | undefined
  let n = 0
  const organizers: string[] = []

  async function idToken(uid: string): Promise<string> {
    const custom = await auth.createCustomToken(uid)
    const key  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'fake-api-key'
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const res  = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })
    const body = await res.json() as { idToken?: string }
    if (!body.idToken) throw new Error(`no idToken: ${JSON.stringify(body)}`)
    return body.idToken
  }

  /**
   * A paid ₹30 registration exactly as checkout leaves it: registration paid, payment intent, and the
   * settlement credited through the REAL ledger path (₹0.35 platform fee incl. GST, ₹0.75 gateway → ₹28.90 net).
   */
  async function paidRegistration(opts: { gross?: number; fees?: number; gateway?: number } = {}) {
    const gross = opts.gross ?? 3000, platform = opts.fees ?? 35, gw = opts.gateway ?? 75, net = gross - platform - gw
    const organizerUid = `${P}-org-${++n}`; organizers.push(organizerUid)
    const regId = `${P}-reg-${n}`, orderId = `order_${P}_${n}`, paymentId = `pay_${P}_${n}`
    await db.doc(`registrations/${regId}`).set({
      id: regId, organizerUid, eventSlug: `${P}-ev`, paymentStatus: 'paid', status: 'confirmed', amount: gross, paymentId,
      attendee: { name: 'Synthetic Attendee', email: `att${n}@rd.test` }, createdAt: new Date(),
    })
    await db.doc(`paymentIntents/${orderId}`).set({
      orderId, registrationId: regId, organizerUid, eventSlug: `${P}-ev`, amount: gross, currency: 'INR', paymentId, status: 'paid', provider: 'razorpay',
    })
    await credit({
      id: `ptx_${regId}`, type: 'event_registration', category: 'ticketed', organizerUid, entityId: `${P}-ev`, entityType: 'event',
      sourceId: regId, sourceType: 'registration', payerName: 'Synthetic Attendee', payerEmail: `att${n}@rd.test`,
      grossAmountPaise: gross, platformFeeBasePaise: 30, platformFeeGstPaise: platform - 30, platformFeeTotalPaise: platform,
      gatewayFeeEstimatePaise: gw, netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x',
      currency: 'INR', gateway: 'razorpay', gatewayPaymentId: paymentId, gatewayOrderId: orderId,
    } as never, { organizerUid, grossAmountPaise: gross, feesTotalPaise: platform + gw, netSettlementPaise: net } as never)
    return { organizerUid, regId, orderId, paymentId, gross, net, ptxId: `ptx_${regId}` }
  }

  const wallet = async (uid: string) => {
    const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data() ?? {}
    return { pending: Number(w.pendingPaise ?? 0), available: Number(w.availablePaise ?? 0), inTransit: Number(w.inTransitPaise ?? 0) }
  }
  const doc = async (path: string) => (await db.doc(path).get()).data() as Json | undefined
  const reconClean = async (uid: string) =>
    expect(await reconcile(uid, (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!)).toEqual([])
  /** Ages a settlement past the hold so the release job takes it, then runs the REAL release job. */
  const releaseNow = async (ptxId: string) => {
    await db.doc(`platformTransactions/${ptxId}`).update({ paidAt: new Date(Date.now() - 30 * DAY) })
    await release({ limit: 500 })
  }
  const key = () => `${P}key${String(++n).padStart(6, '0')}`
  const req = (args: Partial<Parameters<typeof svc.requestManualRefund>[0]> & { registrationId: string }) => svc.requestManualRefund({
    requestKey: key(), amountPaise: 3000, method: 'bank_transfer', recipientName: 'Synthetic Attendee', recipientDetail: '123456789012',
    reason: 'Event date changed; attendee cannot attend', adminUid: MAKER, ...args,
  })
  const complete = (id: string, reference: string, adminUid = CHECKER) =>
    svc.completeManualRefund({ id, adminUid, reference, transferredOn: '2026-10-20', note: 'Transfer confirmed on bank statement' })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db, adminAuth: auth } = await import('@/lib/firebase/admin'))
    svc = await import('@/lib/refunds/manualRefunds')
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    ;({ releaseEligibleFunds: release } = await import('@/lib/settlements/releaseFunds'))
    ;({ reconcileOneWallet: reconcile } = await import('@/lib/reconciliation/wallets'))
    ;({ accumulatePaymentRefund: accumulate } = await import('@/lib/refunds/registrationRefunds'))
    ;({ POST: requestRoute } = await import('@/app/api/admin/registrations/[registrationId]/manual-refunds/route') as never)
    ;({ POST: actionRoute } = await import('@/app/api/admin/manual-refunds/[id]/route') as never)
    ;({ POST: gatewayRoute } = await import('@/app/api/organizer/registrations/[registrationId]/refund/route') as never)
    for (const uid of [MAKER, CHECKER, ORG_USER]) {
      await auth.createUser({ uid, email: `${uid}@rd.test`, emailVerified: true }).catch(() => null)
      tokens[uid] = await idToken(uid)
    }
    prevAdmins = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = [prevAdmins, MAKER, CHECKER].filter(Boolean).join(',')
  }, T)

  afterAll(async () => {
    if (prevAdmins === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = prevAdmins
    for (const u of [MAKER, CHECKER, ORG_USER]) await auth.deleteUser(u).catch(() => null)
  }, T)

  beforeEach(() => { h.gatewayRefunds = []; h.lookupFails = false })

  // ─── A · authorization ──────────────────────────────────────────────────────

  it('A1 · only a Super Admin may request or act on a manual refund', async () => {
    const r = await paidRegistration()
    for (const tok of [null, tokens[ORG_USER]]) {
      const res = await requestRoute(new NextRequest(new Request('http://x/api', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ requestKey: key(), amountPaise: 3000, method: 'cash', recipientName: 'X Y', reason: 'attempt by non-admin' }),
      })), { params: Promise.resolve({ registrationId: r.regId }) })
      expect(res.status).toBe(403)
      const act = await actionRoute(new NextRequest(new Request('http://x/api', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ action: 'cancel', reason: 'attempt by non-admin' }),
      })), { params: Promise.resolve({ id: `mrr_${r.regId}_abcdefgh` }) })
      expect(act.status).toBe(403)
    }
    expect((await doc(`registrations/${r.regId}`))!.paymentStatus).toBe('paid')
  }, T)

  it('A2 · maker-checker: the requester cannot complete their own refund (no bypass)', async () => {
    const r = await paidRegistration()
    const q = await req({ registrationId: r.regId })
    expect(q.ok).toBe(true)
    const self = await complete((q as { record: { id: string } }).record.id, `UTR${P}A2`, MAKER)
    expect(self).toMatchObject({ ok: false, code: 'MAKER_CHECKER_REQUIRED' })
    expect((await doc(`registrations/${r.regId}`))!.paymentStatus).toBe('refund_pending')
    expect(await wallet(r.organizerUid)).toMatchObject({ pending: r.net })
  }, T)

  // ─── I · idempotency + concurrency ───────────────────────────────────────────

  it('I1 · a resubmission returns the SAME request; a reused key for a different refund is refused', async () => {
    const r = await paidRegistration()
    const k = key()
    const a = await svc.requestManualRefund({ registrationId: r.regId, requestKey: k, amountPaise: 1000, method: 'upi', recipientName: 'Synthetic Attendee', recipientDetail: 'synthetic.att@okaxis', reason: 'partial goodwill refund', adminUid: MAKER })
    const b = await svc.requestManualRefund({ registrationId: r.regId, requestKey: k, amountPaise: 1000, method: 'upi', recipientName: 'Synthetic Attendee', recipientDetail: 'synthetic.att@okaxis', reason: 'partial goodwill refund', adminUid: MAKER })
    expect(a).toMatchObject({ ok: true, duplicate: false })
    expect(b).toMatchObject({ ok: true, duplicate: true })
    expect((a as { record: Json }).record.recipient).toEqual({ name: 'Synthetic Attendee', detail: expect.stringMatching(/^sy.+@okaxis$/) })
    expect(JSON.stringify((a as { record: Json }).record)).not.toContain('synthetic.att@')
    const c = await svc.requestManualRefund({ registrationId: r.regId, requestKey: k, amountPaise: 2000, method: 'upi', recipientName: 'Synthetic Attendee', recipientDetail: 'synthetic.att@okaxis', reason: 'partial goodwill refund', adminUid: MAKER })
    expect(c).toMatchObject({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })
    expect((await db.collection('manualRegistrationRefunds').where('registrationId', '==', r.regId).get()).size).toBe(1)
  }, T)

  it('I2 · concurrent requests for one registration: exactly one wins', async () => {
    const r = await paidRegistration()
    const out = await Promise.all([1, 2, 3].map(() => req({ registrationId: r.regId })))
    expect(out.filter(o => o.ok).length).toBe(1)
    expect(out.filter(o => !o.ok).every(o => (o as { code: string }).code === 'NOT_PAID')).toBe(true)
    const intent = (await doc(`paymentIntents/${r.orderId}`))!
    expect(Object.keys(intent.manualRefundsPaise as Json)).toHaveLength(1)
  }, T)

  it('I3 · concurrent completions by two checkers: applied exactly once', async () => {
    const r = await paidRegistration()
    const q = await req({ registrationId: r.regId }) as { ok: true; record: { id: string } }
    const THIRD = `${P}-third`; process.env.ADMIN_UIDS += `,${THIRD}`
    const out = await Promise.all([complete(q.record.id, `UTR${P}I3`), complete(q.record.id, `UTR${P}I3`, THIRD)])
    expect(out.every(o => o.ok)).toBe(true)
    expect(out.filter(o => (o as { duplicate: boolean }).duplicate).length).toBe(1)
    expect(await wallet(r.organizerUid)).toMatchObject({ pending: 0 })
    expect((await db.collection('platformTransactions').where('parentTransactionId', '==', r.ptxId).get()).size).toBe(1)
    await reconClean(r.organizerUid)
  }, T)

  // ─── X · exclusivity with gateway refunds ────────────────────────────────────

  it('X1 · refused when the gateway already holds a refund of the payment, or cannot be asked', async () => {
    const r = await paidRegistration()
    h.gatewayRefunds = [{ id: 'rfnd_existing', amount: 3000, status: 'processed' }]
    expect(await req({ registrationId: r.regId })).toMatchObject({ ok: false, code: 'GATEWAY_REFUND_EXISTS' })
    h.gatewayRefunds = []; h.lookupFails = true
    expect(await req({ registrationId: r.regId })).toMatchObject({ ok: false, code: 'GATEWAY_CHECK_FAILED' })
    h.lookupFails = false
    // a counted gateway refund on the intent (seen by the webhook) also refuses
    await db.doc(`paymentIntents/${r.orderId}`).update({ gatewayRefundsPaise: { rfnd_old: 500 } })
    expect(await req({ registrationId: r.regId })).toMatchObject({ ok: false, code: 'GATEWAY_REFUND_EXISTS' })
    expect((await doc(`registrations/${r.regId}`))!.paymentStatus).toBe('paid')
    expect((await db.collection('manualRegistrationRefunds').where('registrationId', '==', r.regId).get()).size).toBe(0)
  }, T)

  it('X2 · while a manual refund is pending, the gateway refund route cannot start one', async () => {
    const r = await paidRegistration()
    expect((await req({ registrationId: r.regId })).ok).toBe(true)
    const res = await gatewayRoute(new NextRequest(new Request('http://x/api', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[CHECKER]}` },
      body: JSON.stringify({ reason: 'attempt a gateway refund too' }),
    })), { params: Promise.resolve({ registrationId: r.regId }) })
    expect(res.status).toBe(409)
    expect(h.refundCalls).toBe(0)
  }, T)

  it('X3 · after a PARTIAL manual refund the gateway route refuses (the remainder goes through the manual workflow)', async () => {
    const r = await paidRegistration()
    const q = await req({ registrationId: r.regId, amountPaise: 1000 }) as { ok: true; record: { id: string } }
    expect((await complete(q.record.id, `UTR${P}X3`)).ok).toBe(true)
    expect((await doc(`registrations/${r.regId}`))!.paymentStatus).toBe('paid')
    const res = await gatewayRoute(new NextRequest(new Request('http://x/api', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[CHECKER]}` },
      body: JSON.stringify({ reason: 'attempt a gateway refund of the rest' }),
    })), { params: Promise.resolve({ registrationId: r.regId }) })
    expect(res.status).toBe(409)
    expect(h.refundCalls).toBe(0)
  }, T)

  it('X4 · a gateway refund arriving anyway (dashboard) is counted, held for review — never applied; completion refuses, cancellation withdraws the manual request and leaves the review hold', async () => {
    const r = await paidRegistration()
    const q = await req({ registrationId: r.regId }) as { ok: true; record: { id: string } }
    const acc = await accumulate(r.orderId, `rfnd_${P}_dash`, 3000)
    expect(acc.kind).toBe('manual_conflict')
    expect((await doc(`registrationRefunds/rfnd_${P}_dash`))).toMatchObject({ reviewRequired: 'manual_refund_conflict', reviewOpen: true })
    expect((await doc(`paymentIntents/${r.orderId}`))!.gatewayRefundsPaise).toEqual({ [`rfnd_${P}_dash`]: 3000 })
    expect((await doc(`platformTransactions/${r.ptxId}`))).toMatchObject({ status: 'completed', releaseStatus: 'held' })
    expect(await complete(q.record.id, `UTR${P}X4`)).toMatchObject({ ok: false, code: 'GATEWAY_REFUND_CONFLICT' })
    expect(await wallet(r.organizerUid)).toMatchObject({ pending: r.net })    // nothing debited by either path
    // The attendee was repaid by the gateway: the manual transfer will not be made — the request is withdrawn.
    expect(await svc.cancelManualRefund({ id: q.record.id, adminUid: CHECKER, reason: 'repaid via gateway' })).toMatchObject({ ok: true, record: { status: 'cancelled' } })
    expect(await doc(`registrations/${r.regId}`)).toMatchObject({ paymentStatus: 'paid' })
    expect((await doc(`paymentIntents/${r.orderId}`))!.manualRefundsPaise).toEqual({})
    const ptx = (await doc(`platformTransactions/${r.ptxId}`))!
    expect(ptx).toMatchObject({ status: 'completed', releaseStatus: 'held', releaseHold: expect.anything() })   // the review's hold stays
    expect(ptx.manualRefundHold).toBeUndefined()
    const audit = (await db.collection('adminAuditLogs').where('entityId', '==', r.regId).where('action', '==', 'registration.manual_refund_cancelled').get()).docs[0]
    expect(audit.get('metadata')).toMatchObject({ gatewayRefundConflict: true })
    expect(await wallet(r.organizerUid)).toMatchObject({ pending: r.net })
    await reconClean(r.organizerUid)
  }, T)

  it('X5 · the in-place gateway reversal refuses a settlement a manual refund already reversed (no double debit)', async () => {
    const r = await paidRegistration()
    const q = await req({ registrationId: r.regId, amountPaise: 1000 }) as { ok: true; record: { id: string } }
    expect((await complete(q.record.id, `UTR${P}X5`)).ok).toBe(true)
    const before = await wallet(r.organizerUid)
    await expect(reverse(r.ptxId)).rejects.toThrow(/MANUAL_REFUND_PRESENT/)
    expect(await wallet(r.organizerUid)).toEqual(before)
    await reconClean(r.organizerUid)
  }, T)

  // ─── L · accounting ───────────────────────────────────────────────────────────

  it('L1 · full manual refund of the ₹30 registration reverses exactly the ₹28.90 net, atomically and audited', async () => {
    const r = await paidRegistration()
    expect(r.net).toBe(2890)
    const q = await req({ registrationId: r.regId }) as { ok: true; record: { id: string } }
    expect((await doc(`platformTransactions/${r.ptxId}`))).toMatchObject({ releaseStatus: 'held', manualRefundHold: { refundId: q.record.id } })
    const c = await complete(q.record.id, `utr-${P}-l1`)
    expect(c).toMatchObject({ ok: true, record: { status: 'completed', reference: `UTR${P}L1`.toUpperCase(), accounting: { reversalNetPaise: 2890, debitedPaise: 2890, clawbackId: null, fullyRefunded: true, bucket: 'pending' } } })
    expect(await wallet(r.organizerUid)).toMatchObject({ pending: 0, available: 0 })
    expect(await doc(`registrations/${r.regId}`)).toMatchObject({ paymentStatus: 'refunded', refundMethod: 'manual', refundAmount: 3000, manualRefunds: { refundedPaise: 3000, count: 1 } })
    expect(await doc(`platformTransactions/ptx_mrefund_${q.record.id}`)).toMatchObject({ netSettlementPaise: -2890, grossAmountPaise: -3000, status: 'refunded', parentTransactionId: r.ptxId, refundMethod: 'manual' })
    // the original stays 'completed' (not reversed in place), held — nothing is left to release
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ status: 'completed', releaseStatus: 'held', manualRefund: { reversedNetPaise: 2890, refundedGrossPaise: 3000, fullyRefunded: true } })
    expect((await doc(`manualRefundReferences/${`UTR${P}L1`.toUpperCase()}`))).toMatchObject({ manualRefundId: q.record.id })
    const audits = (await db.collection('adminAuditLogs').where('entityId', '==', r.regId).get()).docs.map(d => d.get('action')).sort()
    expect(audits).toEqual(['registration.manual_refund_completed', 'registration.manual_refund_requested'])
    // a repeated completion is answered from the record; a different reference is refused
    expect(await complete(q.record.id, `utr-${P}-l1`)).toMatchObject({ ok: true, duplicate: true })
    expect(await complete(q.record.id, `OTHER${P}`)).toMatchObject({ ok: false, code: 'ALREADY_COMPLETED' })
    await reconClean(r.organizerUid)
  }, T)

  it('L2 · partial refunds: proportional, cumulatively exact; the release moves only the remainder; reconciliation stays clean', async () => {
    const r = await paidRegistration()
    const q1 = await req({ registrationId: r.regId, amountPaise: 1000 }) as { ok: true; record: { id: string } }
    const c1 = await complete(q1.record.id, `UTR${P}L2A`)
    expect(c1).toMatchObject({ ok: true, record: { accounting: { reversalNetPaise: 963, fullyRefunded: false, bucket: 'pending' } } })   // round(2890×1000/3000)
    expect(await doc(`registrations/${r.regId}`)).toMatchObject({ paymentStatus: 'paid', manualRefunds: { refundedPaise: 1000 } })
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ status: 'completed', releaseStatus: 'pending' })   // hold lifted
    expect(await wallet(r.organizerUid)).toMatchObject({ pending: 2890 - 963 })
    await reconClean(r.organizerUid)

    await releaseNow(r.ptxId)
    expect(await doc(`platformTransactions/${r.ptxId}`)).toMatchObject({ releaseStatus: 'released' })
    expect(await wallet(r.organizerUid)).toMatchObject({ pending: 0, available: 1927 })        // only the remainder moved
    await reconClean(r.organizerUid)

    // the rest is refunded after release: taken from AVAILABLE, and it completes the charge exactly
    const q2 = await req({ registrationId: r.regId, amountPaise: 2000 }) as { ok: true; record: { id: string } }
    expect(q2.ok).toBe(true)
    const c2 = await complete(q2.record.id, `UTR${P}L2B`)
    expect(c2).toMatchObject({ ok: true, record: { accounting: { reversalNetPaise: 1927, debitedPaise: 1927, fullyRefunded: true, bucket: 'available' } } })
    expect(await wallet(r.organizerUid)).toMatchObject({ pending: 0, available: 0 })
    expect(await doc(`registrations/${r.regId}`)).toMatchObject({ paymentStatus: 'refunded', refundAmount: 3000 })
    // more than what is refundable is refused
    await reconClean(r.organizerUid)
  }, T)

  it('L3 · amounts are validated against what is still refundable', async () => {
    const r = await paidRegistration()
    expect(await req({ registrationId: r.regId, amountPaise: 3001 })).toMatchObject({ ok: false, code: 'EXCEEDS_REFUNDABLE' })
    expect(await req({ registrationId: r.regId, amountPaise: 0 })).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' })
    expect(await req({ registrationId: r.regId, amountPaise: 10.5 })).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' })
    expect((await doc(`registrations/${r.regId}`))!.paymentStatus).toBe('paid')
  }, T)

  it('L4 · a settlement already PAID OUT: the shortfall becomes a durable clawback; payout reservations go to review', async () => {
    const r = await paidRegistration()
    await releaseNow(r.ptxId)
    expect(await wallet(r.organizerUid)).toMatchObject({ available: 2890 })
    // the organizer requested a payout reserving 2000 (open), and was paid 800 out of available
    await db.doc(`organizerRevenueWallets/${r.organizerUid}`).update({ availablePaise: 2090, inTransitPaise: 2000, settledPaise: 800 })
    const srPaid = `${P}-sr-paid-${n}`, srOpen = `${P}-sr-open-${n}`
    await db.collection('settlementRequests').doc(srPaid).set({ organizerUid: r.organizerUid, amountPaise: 800, status: 'paid', requestedAt: new Date() })
    await db.collection('settlementRequests').doc(srOpen).set({ organizerUid: r.organizerUid, amountPaise: 2000, status: 'pending', reserved: true, requestedAt: new Date() })
    const q = await req({ registrationId: r.regId }) as { ok: true; record: { id: string } }
    expect((await doc(`platformTransactions/${r.ptxId}`))!.releaseStatus).toBe('released')   // a released settlement is not held
    const c = await complete(q.record.id, `UTR${P}L4`)
    expect(c).toMatchObject({ ok: true, record: { accounting: { reversalNetPaise: 2890, debitedPaise: 2090, bucket: 'available', clawbackId: `clawback_ptx_mrefund_${q.record.id}` } } })
    expect(await doc(`walletClawbacks/clawback_ptx_mrefund_${q.record.id}`)).toMatchObject({ outstandingAmountPaise: 800, recoveredAmountPaise: 2090, status: 'partially_recovered', sourceType: 'registration', sourceId: r.regId })
    expect(await wallet(r.organizerUid)).toMatchObject({ available: 0, inTransit: 0 })
    expect((await doc(`settlementRequests/${srOpen}`))!.payoutReview).toMatchObject({ status: 'open', trigger: { kind: 'registration_refund', ref: q.record.id } })
  }, T)

  it('L5 · cancellation lifts every claim and hold; a completed refund cannot be cancelled', async () => {
    const r = await paidRegistration()
    const q = await req({ registrationId: r.regId }) as { ok: true; record: { id: string } }
    const c = await svc.cancelManualRefund({ id: q.record.id, adminUid: MAKER, reason: 'attendee withdrew the request' })
    expect(c).toMatchObject({ ok: true, record: { status: 'cancelled' } })
    expect(await doc(`registrations/${r.regId}`)).toMatchObject({ paymentStatus: 'paid' })
    expect((await doc(`registrations/${r.regId}`))!.refundClaim).toBeUndefined()
    expect((await doc(`paymentIntents/${r.orderId}`))!.manualRefundsPaise).toEqual({})
    const ptx = (await doc(`platformTransactions/${r.ptxId}`))!
    expect(ptx.releaseStatus).toBe('pending'); expect(ptx.manualRefundHold).toBeUndefined()
    expect(await svc.cancelManualRefund({ id: q.record.id, adminUid: MAKER, reason: 'again' })).toMatchObject({ ok: true, duplicate: true })
    // a new request now works, and once completed cannot be cancelled
    const q2 = await req({ registrationId: r.regId }) as { ok: true; record: { id: string } }
    expect((await complete(q2.record.id, `UTR${P}L5`)).ok).toBe(true)
    expect(await svc.cancelManualRefund({ id: q2.record.id, adminUid: MAKER, reason: 'too late' })).toMatchObject({ ok: false, code: 'ALREADY_COMPLETED' })
    await reconClean(r.organizerUid)
  }, T)

  it('L6 · one reference, one refund — and never a reference already used for a payout', async () => {
    const a = await paidRegistration(), b = await paidRegistration()
    const qa = await req({ registrationId: a.regId }) as { ok: true; record: { id: string } }
    const qb = await req({ registrationId: b.regId }) as { ok: true; record: { id: string } }
    expect((await complete(qa.record.id, `UTR${P}L6`)).ok).toBe(true)
    expect(await complete(qb.record.id, `utr ${P} l6`)).toMatchObject({ ok: false, code: 'REFERENCE_IN_USE' })   // same canonical form
    await db.doc(`payoutTransferReferences/${`PAYOUT${P}L6`.toUpperCase()}`).set({ settlementId: 'x' })
    expect(await complete(qb.record.id, `PAYOUT${P}L6`)).toMatchObject({ ok: false, code: 'REFERENCE_IN_USE' })
    expect((await doc(`registrations/${b.regId}`))!.paymentStatus).toBe('refund_pending')
  }, T)

  // ─── R · releases + cron ──────────────────────────────────────────────────────

  // ─── F · financial reporting ──────────────────────────────────────────────────

  it('F1 · dashboard + reports count a manual refund like a gateway refund: refunds listed, ticket value unchanged, payable reduced', async () => {
    const a = await paidRegistration()
    const orgUid = a.organizerUid
    // a second registration of the SAME organizer and event
    const regB = `${P}-reg-b-${++n}`, orderB = `order_${P}_b_${n}`
    await db.doc(`registrations/${regB}`).set({ id: regB, organizerUid: orgUid, eventSlug: `${P}-ev`, paymentStatus: 'paid', status: 'confirmed', amount: 3000, paymentId: `pay_${P}_b_${n}`, attendee: { name: 'B', email: `b${n}@rd.test` }, createdAt: new Date() })
    await db.doc(`paymentIntents/${orderB}`).set({ orderId: orderB, registrationId: regB, organizerUid: orgUid, eventSlug: `${P}-ev`, amount: 3000, currency: 'INR', paymentId: `pay_${P}_b_${n}`, status: 'paid', provider: 'razorpay' })
    await credit({
      id: `ptx_${regB}`, type: 'event_registration', category: 'ticketed', organizerUid: orgUid, entityId: `${P}-ev`, entityType: 'event',
      sourceId: regB, sourceType: 'registration', payerName: 'B', payerEmail: `b${n}@rd.test`, grossAmountPaise: 3000, platformFeeBasePaise: 30, platformFeeGstPaise: 5,
      platformFeeTotalPaise: 35, gatewayFeeEstimatePaise: 75, netSettlementPaise: 2890, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x',
      currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${P}_b_${n}`, gatewayOrderId: orderB,
    } as never, { organizerUid: orgUid, grossAmountPaise: 3000, feesTotalPaise: 110, netSettlementPaise: 2890 } as never)
    const qa = await req({ registrationId: a.regId }) as { ok: true; record: { id: string } }
    expect((await complete(qa.record.id, `UTR${P}F1A`)).ok).toBe(true)
    const qb = await req({ registrationId: regB, amountPaise: 1000 }) as { ok: true; record: { id: string } }
    expect((await complete(qb.record.id, `UTR${P}F1B`)).ok).toBe(true)

    const { getLedgerTotals, getRefundTotals } = await import('@/lib/finance/financeAnalytics')
    const scope = { organizerUid: orgUid, eventSlug: `${P}-ev`, from: null, to: null }
    const ledger = await getLedgerTotals(scope as never)
    expect(ledger.grossPaise).toEqual({ ok: true, paise: 6000 })                          // ticket value: sales, unchanged by refunds
    expect(ledger.organizerPayable).toEqual({ ok: true, paise: 2890 * 2 - 2890 - 963 })   // what the wallet still holds
    const w = await wallet(orgUid)
    expect(w.pending + w.available).toBe(2890 * 2 - 2890 - 963)
    const refunds = await getRefundTotals(scope as never)
    expect(refunds).toMatchObject({ count: 2, amount: { ok: true, paise: 4000 }, complete: true })

    const { buildRefunds, buildPayoutStatement } = await import('@/lib/reports/builders')
    const table = await buildRefunds(orgUid, { event: `${P}-ev` }) as unknown as { rows: Array<Record<string, unknown>> }
    const manualRows = table.rows.filter(r => String(r.attribution).startsWith('Manual refund'))
    expect(manualRows.map(r => r.amount).sort()).toEqual([1000, 3000])
    expect(manualRows.every(r => r.status === 'processed' && String(r.refundId).startsWith('mrr_'))).toBe(true)
    const stmt = await buildPayoutStatement(orgUid, {})
    expect(stmt).toMatchObject({ grossRevenuePaise: 6000, registrationRefundsPaise: 4000, netSettlementPaise: 2890 * 2 - 2890 - 963 })
  }, T)

  it('F2 · release evidence and the stuck-release replay use the net LEFT after a manual refund', async () => {
    const r = await paidRegistration()
    const q = await req({ registrationId: r.regId, amountPaise: 1000 }) as { ok: true; record: { id: string } }
    expect((await complete(q.record.id, `UTR${P}F2`)).ok).toBe(true)
    await db.doc(`platformTransactions/${r.ptxId}`).update({ paidAt: new Date(Date.now() - 30 * DAY) })
    const { reportStuckReleases } = await import('@/lib/reconciliation/stuckReleases')
    const before = (await reportStuckReleases()).entries.find(e => e.ptxId === r.ptxId)
    expect(before?.amountPaise).toBe(1927)
    expect(before?.verdict).not.toBe('stuck')                 // pending (1927) covers what the release will move
    await release({ limit: 500 })
    const { resolveConfirmedReleaseEvidence, RELEASE_ATTEMPTS_COLLECTION } = await import('@/lib/settlements/releaseAttempts')
    await db.doc(`${RELEASE_ATTEMPTS_COLLECTION}/${r.ptxId}`).set({ status: 'open', attempts: 1, lastCode: 'INSUFFICIENT' })
    expect(await resolveConfirmedReleaseEvidence(r.ptxId)).toBe('resolved')
  }, T)

  it('F3 · a refund-review hold cannot be lifted while a manual refund holds the settlement', async () => {
    const { evaluateLift } = await import('@/lib/settlements/refundHoldRules')
    const base = { ledgerStatus: 'completed', releaseStatus: 'held', alreadyReleased: false, holdRefundIds: ['rf1'], paymentRefunds: [{ id: 'rf1', status: 'failed' }], countedRefundsPaise: 0 }
    expect(evaluateLift(base)).toEqual({ ok: true })
    expect(evaluateLift({ ...base, manualRefundHold: true })).toEqual({ ok: false, why: 'manual_refund_hold' })
  }, T)

  it('R1 · two release runs racing over a partially refunded settlement release it exactly once', async () => {
    const r = await paidRegistration()
    const q = await req({ registrationId: r.regId, amountPaise: 1500 }) as { ok: true; record: { id: string } }
    expect((await complete(q.record.id, `UTR${P}R1`)).ok).toBe(true)
    await db.doc(`platformTransactions/${r.ptxId}`).update({ paidAt: new Date(Date.now() - 30 * DAY) })
    await Promise.all([release({ limit: 500 }), release({ limit: 500 })])
    expect((await db.collection('settlementReleases').where('transactionId', '==', r.ptxId).get()).size).toBe(1)
    expect(await wallet(r.organizerUid)).toMatchObject({ pending: 0, available: 2890 - 1445 })
    await reconClean(r.organizerUid)
  }, T)

  it('R2 · the release-funds cron records a success that the stopped-cron monitor does not flag', async () => {
    const prev = process.env.CRON_SECRET
    process.env.CRON_SECRET = `${P}-cron-secret`
    vi.resetModules()
    try {
      const { GET } = await import('@/app/api/cron/release-funds/route')
      const { isStale } = await import('@/lib/operations/healthMetrics')
      expect((await GET(new NextRequest(new Request('http://x/api/cron/release-funds')))).status).toBe(401)
      const res = await GET(new NextRequest(new Request('http://x/api/cron/release-funds', { headers: { authorization: `Bearer ${P}-cron-secret` } })))
      expect(res.status).toBe(200)
      const m = (await doc('operationsMetrics/release-funds'))!
      expect(m.lastOk).toBe(true)
      const last = (m.lastSuccessAt as { toMillis: () => number }).toMillis()
      expect(isStale('release-funds', last, last + 3 * 3_600_000)).toBe(false)    // hours later: healthy (was a critical alert)
      expect(isStale('release-funds', last, last + 49 * 3_600_000)).toBe(true)    // two missed daily runs: stopped
    } finally {
      if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev
    }
  }, T)
})
