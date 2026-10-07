// RD-WALLET-W1 — wallet top-up payment safety, proved against REAL Firestore through the REAL
// routes (verify, payment.captured webhook, reconciliation cron, order creation).
//
// Razorpay is an in-memory stub (no request leaves the process — .env.local holds LIVE keys).
// Identity is mocked at the token boundary only (verifyCaller); the webhook signature check is
// stubbed at the provider adapter. Everything else — the credit transaction, the ledger, the
// reconciliation records — is the real code on the private emulator.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const SECRET = 'w1-test-secret'

const h = vi.hoisted(() => ({
  who: '' as string,
  payments: new Map<string, { id: string; status: string; amount: number; currency: string; order_id: string }>(),
  ordersCreated: 0,
  fetchPlan: [] as Array<'normal' | 'throw'>,
  orderFetchFails: false,
  failFetchFor: new Set<string>(),
  paymentFetches: 0,
  providerChoice: { ok: true, provider: 'razorpay' } as { ok: true; provider: 'razorpay' | 'cashfree' } | { ok: false; reason: 'cashfree_not_ready' },
  // RD-WALLET-W2.c — gateway instrumentation for the stale sweep (calls, concurrency, overrides).
  gatewayDelayMs: 0,
  inflight: 0,
  maxInflight: 0,
  orderLookups: [] as string[],
  failOrders: new Set<string>(),
  orderOverride: new Map<string, unknown[]>(),
  rawOverride: new Map<string, unknown>(),
  // W2.c fixes — the RAW order-payments lookup (orders.fetchPayments) and Sentry captures.
  rawOrderLookups: [] as string[],
  rawOrderFails: new Set<string>(),
  rawOrderOverride: new Map<string, unknown>(),
  sentry: [] as Array<{ what: string; scope: string }>,
}))
/** Mirrors lib/payments/providers/razorpayAdapter.ts toNormalizedPayment/mapStatus EXACTLY (unknown or
 *  missing status → 'failed', missing currency → 'INR', missing amount → 0). tests/unit/walletSweepRawStatus
 *  drives the REAL adapter with the same raw inputs, so this stub cannot drift silently. */
const RAW_KNOWN = new Set(['created', 'authorized', 'captured', 'refunded', 'failed'])
const normalizeLikeAdapter = (p: { id?: unknown; order_id?: unknown; status?: unknown; amount?: unknown; currency?: unknown }) => ({
  provider: 'razorpay' as const,
  providerPaymentId: String(p.id ?? ''),
  providerOrderId: typeof p.order_id === 'string' ? p.order_id : null,
  status: (typeof p.status === 'string' && RAW_KNOWN.has(p.status) ? p.status : 'failed') as 'authorized' | 'captured' | 'failed',
  amountPaise: typeof p.amount === 'number' ? p.amount : Number(p.amount ?? 0),
  currency: typeof p.currency === 'string' ? p.currency : 'INR',
  capturedAtMs: null,
})
const gatewayCall = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  h.inflight++; h.maxInflight = Math.max(h.maxInflight, h.inflight)
  try {
    if (h.gatewayDelayMs) await new Promise(r => setTimeout(r, h.gatewayDelayMs))
    return await fn()
  } finally { h.inflight-- }
}

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_w1', RAZORPAY_KEY_SECRET: 'w1-test-secret',
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => {
        h.ordersCreated++
        return { id: `order_w1_${h.ordersCreated}_${Math.random().toString(36).slice(2, 8)}`, amount: o.amount, currency: o.currency }
      },
      // RD-WALLET-W1.1 follow-up — the unresolved-top-up guard asks the gateway for an order's payments.
      fetchPayments: async (orderId: string) => gatewayCall(() => {
        h.rawOrderLookups.push(orderId)
        if (h.orderFetchFails || h.rawOrderFails.has(orderId)) throw new Error('simulated gateway outage (orders.fetchPayments)')
        if (h.rawOrderOverride.has(orderId)) return h.rawOrderOverride.get(orderId)
        return { items: [...h.payments.values()].filter(p => p.order_id === orderId) }
      }),
    },
    payments: {
      fetch: async (paymentId: string) => gatewayCall(() => {
        h.paymentFetches++
        if (h.failFetchFor.has(paymentId)) throw new Error('simulated gateway outage (this payment)')
        if ((h.fetchPlan.shift() ?? 'normal') === 'throw') throw new Error('simulated gateway outage')
        if (h.rawOverride.has(paymentId)) return h.rawOverride.get(paymentId)
        const p = h.payments.get(paymentId)
        if (!p) throw new Error('payment not found')
        return p
      }),
    },
  },
}))
vi.mock('@/lib/payments/providers', async orig => {
  const actual = await orig<typeof import('@/lib/payments/providers')>()
  return {
    ...actual,
    resolveActivePaymentProviderForNewOrder: async () => h.providerChoice,
    resolvePaymentProvider: (id: 'razorpay' | 'cashfree') => {
      const real = actual.resolvePaymentProvider(id)
      return id === 'razorpay'
        ? {
            ...real,
            verifyWebhookSignature: async () => true,
            // The adapter lazily imports the Razorpay client, which vitest resolves to the REAL
            // module from inside an importOriginal()'d module. Stub the lookup at the adapter
            // boundary instead, in the adapter's normalized shape (same stub data as the SDK mock).
            fetchOrderPayments: async (orderId: string) => gatewayCall(() => {
              h.orderLookups.push(orderId)
              if (h.orderFetchFails || h.failOrders.has(orderId)) throw new Error('simulated gateway outage (fetchOrderPayments)')
              if (h.orderOverride.has(orderId)) return h.orderOverride.get(orderId) as never
              return [...h.payments.values()].filter(p => p.order_id === orderId).map(normalizeLikeAdapter)
            }),
          }
        : real
    },
  }
})
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))
// W2.c fixes — Sentry captures are recorded (alert de-duplication is asserted on them), and the admin
// list's auth is stubbed at its boundary.
vi.mock('@/lib/monitoring/sentry', async orig => ({
  ...(await orig<typeof import('@/lib/monitoring/sentry')>()),
  captureFinancialError: (what: unknown, ctx?: { scope?: string }) => {
    h.sentry.push({ what: what instanceof Error ? what.message : String(what), scope: ctx?.scope ?? '' })
  },
}))
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', async orig => ({
  ...(await orig<typeof import('@/lib/admin/auth')>()),
  resolveAdminUid: async (header: string | null) => (header === 'Bearer w2c-admin' ? 'w2c-admin-uid' : null),
  legacyAdminClaimOnly: async () => false,
  // RD-WALLET-W2.f.1 — the admin top-ups list is Super Admin only; this caller is one (ADMIN_UIDS).
  resolveSuperAdminUid: async (header: string | null) => (header === 'Bearer w2c-admin' ? 'w2c-admin-uid' : null),
}))
// RD-WALLET-W2.c — the cron route's auth, at its boundary (the real check needs CRON_SECRET at import).
vi.mock('@/lib/cron/auth', async orig => ({
  ...(await orig<typeof import('@/lib/cron/auth')>()),
  isAuthorizedCron: (req: Request) => req.headers.get('authorization') === 'Bearer w2c-cron',
}))
vi.mock('@/lib/notifications/organizerWhatsApp', () => ({ sendOrganizerWhatsApp: async () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({
  ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()),
  notifyWalletRecharged: async () => undefined,
}))

const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
const post = (body: unknown) => new NextRequest('http://localhost/api/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer t' }, body: JSON.stringify(body),
})
const sign = (orderId: string, paymentId: string) =>
  crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex')

describeEmu('RD-WALLET-W1 · wallet top-up payment safety on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Transaction: typeof import('firebase-admin/firestore').Transaction
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let DocumentReference: typeof import('firebase-admin/firestore').DocumentReference
  const cleanup = new Set<string>()
  let n = 0

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Transaction, DocumentReference, Timestamp } = await import('firebase-admin/firestore'))
  }, T)
  afterAll(async () => { for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null) }, T)
  beforeEach(() => { h.who = ''; h.payments.clear(); h.fetchPlan = []; h.orderFetchFails = false; h.failFetchFor.clear(); h.paymentFetches = 0; inject.ledger = false; inject.recon = false; inject.reconRead = false; inject.reconReadFailures = 0; h.providerChoice = { ok: true, provider: 'razorpay' }
    h.gatewayDelayMs = 0; h.inflight = 0; h.maxInflight = 0; h.orderLookups = []; h.failOrders.clear(); h.orderOverride.clear(); h.rawOverride.clear()
    h.rawOrderLookups = []; h.rawOrderFails.clear(); h.rawOrderOverride.clear(); h.sentry = [] })
  afterEach(() => { vi.restoreAllMocks() })

  // ─── fixtures ───────────────────────────────────────────────────────────────
  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); cleanup.add(path) }
  async function organizer() {
    const uid = `w1-org-${P}-${++n}`
    await put(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })
    cleanup.add(`organizerWallets/${uid}`)
    return uid
  }
  /** A pending top-up order as the order route writes it. */
  async function topup(uid: string, amountPaise = 50_000) {
    const orderId = `order_w1_seed_${P}_${++n}`
    await put(`walletTopups/${orderId}`, { orderId, uid, amountPaise, currency: 'INR', provider: 'razorpay', status: 'pending' })
    cleanup.add(`walletTransactions/topup_${orderId}`)
    cleanup.add(`walletTopupReconciliation/${orderId}`)
    return orderId
  }
  function payment(orderId: string, status: string, amount = 50_000) {
    const id = `pay_w1_${P}_${++n}`
    h.payments.set(id, { id, status, amount, currency: 'INR', order_id: orderId })
    cleanup.add(`walletTopupReconciliation/dup_${id}`)
    return id
  }
  const balance = async (uid: string) => ((await adminDb.doc(`organizerWallets/${uid}`).get()).data()?.balancePaise as number | undefined) ?? 0
  const topupDoc = async (orderId: string) => (await adminDb.doc(`walletTopups/${orderId}`).get()).data()!
  const ledgerExists = async (orderId: string) => (await adminDb.doc(`walletTransactions/topup_${orderId}`).get()).exists
  const recon = async (id: string) => (await adminDb.doc(`walletTopupReconciliation/${id}`).get()).data()

  const verify = async (uid: string, orderId: string, paymentId: string) => {
    const { POST } = await import('@/app/api/organizer/wallet/topup/verify/route')
    h.who = uid
    return json(await POST(post({ orderId, paymentId, signature: sign(orderId, paymentId) })))
  }
  const webhook = async (orderId: string, paymentId: string, amount = 50_000, currency = 'INR') => {
    const { POST } = await import('@/app/api/webhooks/razorpay/route')
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency } } } })
    const res = await POST(new NextRequest('http://localhost/api/webhooks/razorpay', { method: 'POST', headers: { 'x-razorpay-signature': 'stubbed' }, body }))
    return json(res)
  }
  const cron = async () => (await import('@/lib/wallet/topupReconciliation')).retryPendingWalletTopups(100)

  // ═══ W1.1 ═══════════════════════════════════════════════════════════════════════════════
  it('W1.1 · a CAPTURED payment credits once: balance, credited status and the ledger row', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    const r = await verify(uid, orderId, pay)
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ success: true, newBalance: 50_000 })
    expect(await balance(uid)).toBe(50_000)
    expect(await topupDoc(orderId)).toMatchObject({ status: 'credited', paymentId: pay })
    expect(await ledgerExists(orderId)).toBe(true)
    // a replay changes nothing
    expect((await verify(uid, orderId, pay)).body).toMatchObject({ success: true, newBalance: 50_000 })
    expect(await balance(uid)).toBe(50_000)
  }, T)

  it('W1.1 · an AUTHORIZED payment credits NOTHING (clear pending state); the captured webhook then credits it once', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'authorized')
    const r = await verify(uid, orderId, pay)
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ success: false, pending: true, code: 'PAYMENT_NOT_CAPTURED' })
    expect(await balance(uid)).toBe(0)
    expect((await topupDoc(orderId)).status).toBe('pending')
    expect(await ledgerExists(orderId)).toBe(false)
    expect(await recon(orderId)).toBeUndefined()           // nothing the cron could credit either

    h.payments.get(pay)!.status = 'captured'
    expect((await webhook(orderId, pay)).status).toBe(200)
    expect(await balance(uid)).toBe(50_000)
    expect((await verify(uid, orderId, pay)).body).toMatchObject({ success: true, newBalance: 50_000 })
    expect(await balance(uid)).toBe(50_000)
  }, T)

  // ═══ W1.2 ═══════════════════════════════════════════════════════════════════════════════
  it('W1.2 · verify, webhook and cron racing on ONE captured payment credit exactly once', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    await put(`walletTopupReconciliation/${orderId}`, { orderId, uid, amountPaise: 50_000, paymentId: pay, status: 'pending', attempts: 1 })
    const results = await Promise.all([verify(uid, orderId, pay), webhook(orderId, pay), cron(), verify(uid, orderId, pay), webhook(orderId, pay)])
    expect(results.filter(x => 'status' in x && typeof x.status === 'number').every(x => (x as { status: number }).status === 200)).toBe(true)
    expect(await balance(uid)).toBe(50_000)
    const ledger = await adminDb.collection('walletTransactions').where('orderId', '==', orderId).get()
    expect(ledger.size).toBe(1)
  }, T)

  it('W1.2 · a missing top-up record, or one that is not creditable, is never credited', async () => {
    const { atomicTopupCredit, TopupCreditError } = await import('@/lib/firebase/firestore/wallet')
    const uid = await organizer()
    const ghost = adminDb.collection('walletTopups').doc(`order_w1_ghost_${P}`)
    await expect(atomicTopupCredit(uid, 50_000, ghost, 'pay_x')).rejects.toBeInstanceOf(TopupCreditError)
    await expect(atomicTopupCredit(uid, 50_000, ghost, 'pay_x')).rejects.toMatchObject({ code: 'TOPUP_NOT_FOUND' })

    const orderId = await topup(uid)
    const ref = adminDb.doc(`walletTopups/${orderId}`)
    await expect(atomicTopupCredit(`${uid}-other`, 50_000, ref, 'pay_x')).rejects.toMatchObject({ code: 'TOPUP_OWNER_MISMATCH' })
    await expect(atomicTopupCredit(uid, 99_999, ref, 'pay_x')).rejects.toMatchObject({ code: 'TOPUP_AMOUNT_MISMATCH' })
    await ref.update({ status: 'failed' })
    await expect(atomicTopupCredit(uid, 50_000, ref, 'pay_x')).rejects.toMatchObject({ code: 'TOPUP_NOT_CREDITABLE' })
    expect(await balance(uid)).toBe(0)

    // unknown order through the route: 404, nothing written
    const pay = payment(`order_w1_unknown_${P}`, 'captured')
    expect((await verify(uid, `order_w1_unknown_${P}`, pay)).status).toBe(404)
  }, T)

  it('W1.2 · a ledger row without a credited status is a CONFLICT: held for review, never credited again', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    await put(`walletTransactions/topup_${orderId}`, { organizerUid: uid, type: 'fund_added', amountPaise: 50_000, orderId })
    const r = await verify(uid, orderId, pay)
    expect(r.status).toBe(409); expect(r.body.code).toBe('NEEDS_REVIEW')
    expect(await balance(uid)).toBe(0)
    expect((await recon(orderId))?.status).toBe('needs_review')
    // the cron never replays a needs_review record
    await cron()
    expect(await balance(uid)).toBe(0)
  }, T)

  // ═══ W1.3 ═══════════════════════════════════════════════════════════════════════════════
  // One installer, driven by flags, so the two injections combine. RD-WALLET-W2.a — the
  // reconciliation recorders write through TRANSACTIONS (create/update), so those are covered too.
  const inject = { ledger: false, recon: false, reconRead: false, reconReadFailures: 0 }
  const installInjection = () => {
    vi.restoreAllMocks()
    const realCreate = Transaction.prototype.create
    const realUpdate = Transaction.prototype.update
    const realSet    = DocumentReference.prototype.set
    const realGet    = Transaction.prototype.get
    const isRecon = (path: string) => inject.recon && path.startsWith('walletTopupReconciliation/')
    vi.spyOn(Transaction.prototype, 'create').mockImplementation(function (this: InstanceType<typeof Transaction>, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
      if (inject.ledger && ref.path.startsWith('walletTransactions/topup_')) throw new Error('injected: credit transaction failed')
      if (isRecon(ref.path)) throw new Error('injected: reconciliation write failed')
      return realCreate.call(this, ref, data)
    } as never)
    vi.spyOn(Transaction.prototype, 'update').mockImplementation(function (this: InstanceType<typeof Transaction>, ref: FirebaseFirestore.DocumentReference, ...rest: unknown[]) {
      if (isRecon(ref.path)) throw new Error('injected: reconciliation write failed')
      return (realUpdate as (...a: unknown[]) => unknown).apply(this, [ref, ...rest])
    } as never)
    vi.spyOn(DocumentReference.prototype, 'set').mockImplementation(function (this: InstanceType<typeof DocumentReference>, ...args: unknown[]) {
      if (isRecon(this.path)) return Promise.reject(new Error('injected: reconciliation write failed'))
      return (realSet as (...a: unknown[]) => unknown).apply(this, args)
    } as never)
    // W2.c hold — reads of reconciliation records inside a transaction fail (e.g. the credit's hold check).
    vi.spyOn(Transaction.prototype, 'get').mockImplementation(function (this: InstanceType<typeof Transaction>, target: unknown, ...rest: unknown[]) {
      const path = (target as { path?: unknown } | null)?.path
      if (typeof path === 'string' && path.startsWith('walletTopupReconciliation/') && (inject.reconRead || inject.reconReadFailures > 0)) {
        if (!inject.reconRead) inject.reconReadFailures--
        return Promise.reject(new Error('injected: reconciliation read failed'))
      }
      return (realGet as (...a: unknown[]) => unknown).apply(this, [target, ...rest])
    } as never)
  }
  const failReconciliationRead  = () => { inject.reconRead = true; installInjection() }
  const failNextReconciliationReads = (n: number) => { inject.reconReadFailures = n; installInjection() }
  const failLedgerCreate        = () => { inject.ledger = true; installInjection() }
  const failReconciliationWrite = () => { inject.recon = true;  installInjection() }

  it('W1.3 · credit fails but the reconciliation record persists → webhook 200, and the cron (re-verifying capture) completes it once', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    failLedgerCreate()
    expect((await webhook(orderId, pay)).status).toBe(200)
    vi.restoreAllMocks()
    expect(await balance(uid)).toBe(0)
    expect(await recon(orderId)).toMatchObject({ status: 'pending', paymentId: pay })
    // RD-WALLET-W2.a — a new record is first retried 10 minutes after the failure; make it due.
    await adminDb.doc(`walletTopupReconciliation/${orderId}`).update({ nextAttemptAt: Timestamp.fromMillis(Date.now() - 1000) })
    const res = await cron()
    expect(res.resolved).toBeGreaterThanOrEqual(1)
    expect(await balance(uid)).toBe(50_000)
    expect((await recon(orderId))?.status).toBe('resolved')
    await cron()
    expect(await balance(uid)).toBe(50_000)
  }, T)

  it('W1.3 · credit AND reconciliation both fail → the webhook answers 500 (Razorpay redelivers); nothing is claimed', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    failLedgerCreate(); failReconciliationWrite()
    const r = await webhook(orderId, pay)
    vi.restoreAllMocks()
    expect(r.status).toBe(500)
    expect(await balance(uid)).toBe(0)
    expect(await recon(orderId)).toBeUndefined()
    // the redelivery succeeds
    expect((await webhook(orderId, pay)).status).toBe(200)
    expect(await balance(uid)).toBe(50_000)
  }, T)

  it('W1.3 · verify: when neither the credit nor the record persists, the organizer is told honestly (503, not "credited shortly")', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    failLedgerCreate(); failReconciliationWrite()
    const r = await verify(uid, orderId, pay)
    vi.restoreAllMocks()
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ success: false, pending: true, code: 'CREDIT_DEFERRED' })
    expect(await balance(uid)).toBe(0)
  }, T)

  it('W1.3 · the cron never credits an unverified record: authorized stays pending, a mismatch is held for review', async () => {
    const uid = await organizer()
    const o1 = await topup(uid); const p1 = payment(o1, 'authorized')
    await put(`walletTopupReconciliation/${o1}`, { orderId: o1, uid, amountPaise: 50_000, paymentId: p1, status: 'pending', attempts: 1 })
    const o2 = await topup(uid); const p2 = payment(o2, 'captured', 1_000)   // gateway says ₹10, order is ₹500
    await put(`walletTopupReconciliation/${o2}`, { orderId: o2, uid, amountPaise: 50_000, paymentId: p2, status: 'pending', attempts: 1 })
    const o3 = await topup(uid); const p3 = payment(o3, 'captured')
    await put(`walletTopupReconciliation/${o3}`, { orderId: o3, uid, amountPaise: 50_000, paymentId: p3, status: 'pending', attempts: 1 })
    h.fetchPlan = []
    await cron()
    expect((await recon(o1))?.status).toBe('pending')
    expect((await recon(o2))?.status).toBe('needs_review')
    expect((await recon(o3))?.status).toBe('resolved')
    expect(await balance(uid)).toBe(50_000)            // only the verified captured one
  }, T)

  // ═══ W1.4 ═══════════════════════════════════════════════════════════════════════════════
  it('W1.4 · a SECOND captured payment on a credited order is detected, recorded and flagged — never credited', async () => {
    const uid = await organizer(); const orderId = await topup(uid)
    const first = payment(orderId, 'captured'); const second = payment(orderId, 'captured')
    expect((await verify(uid, orderId, first)).status).toBe(200)
    expect(await balance(uid)).toBe(50_000)

    expect((await webhook(orderId, second)).status).toBe(200)
    const dup = await recon(`dup_${second}`)
    expect(dup).toMatchObject({ status: 'duplicate_payment', orderId, paymentId: second, creditedPaymentId: first, uid })
    const v = await verify(uid, orderId, second)
    expect(v.status).toBe(409); expect(v.body.code).toBe('DUPLICATE_PAYMENT')
    expect(await balance(uid)).toBe(50_000)
    const flags = await adminDb.collection('suspiciousPayments').where('paymentId', '==', second).get()
    expect(flags.docs.some(d => d.data().reason === 'duplicate_payment')).toBe(true)
    for (const d of flags.docs) cleanup.add(`suspiciousPayments/${d.id}`)
    // the cron never replays a duplicate record
    await cron()
    expect(await balance(uid)).toBe(50_000)
  }, T)

  it('W1.4 · the duplicate record cannot be persisted → the webhook answers 500 instead of acknowledging', async () => {
    const uid = await organizer(); const orderId = await topup(uid)
    const first = payment(orderId, 'captured'); const second = payment(orderId, 'captured')
    await verify(uid, orderId, first)
    failReconciliationWrite()
    const r = await webhook(orderId, second)
    vi.restoreAllMocks()
    expect(r.status).toBe(500)
    expect(await balance(uid)).toBe(50_000)
  }, T)

  // ═══ W1.7 ═══════════════════════════════════════════════════════════════════════════════
  it('W1.7 · Cashfree active (or chosen and refused) → wallet top-up fails CLOSED; Razorpay still works', async () => {
    const { POST } = await import('@/app/api/organizer/wallet/topup/route')
    for (const choice of [{ ok: true, provider: 'cashfree' }, { ok: false, reason: 'cashfree_not_ready' }] as const) {
      const uid = await organizer()
      h.providerChoice = choice as typeof h.providerChoice
      h.who = uid
      const before = h.ordersCreated
      const r = await json(await POST(post({ amountPaise: 50_000 })))
      expect(r.status, JSON.stringify(choice)).toBe(503)
      expect(r.body.code).toBe('WALLET_TOPUP_PROVIDER_UNAVAILABLE')
      expect(h.ordersCreated).toBe(before)                       // no Razorpay order minted
      expect((await adminDb.collection('walletTopups').where('uid', '==', uid).get()).size).toBe(0)
    }
    const uid = await organizer()
    h.providerChoice = { ok: true, provider: 'razorpay' }; h.who = uid
    const ok = await json(await POST(post({ amountPaise: 50_000 })))
    expect(ok.status).toBe(200)
    const orderId = ok.body.orderId as string
    cleanup.add(`walletTopups/${orderId}`)
    expect(await topupDoc(orderId)).toMatchObject({ status: 'pending', provider: 'razorpay', uid, amountPaise: 50_000 })
  }, T)

  // ═══ W1.1 follow-up · Issue 1 — server-side guard against a second top-up ════════════════════
  const createTopup = async (uid: string) => {
    const { POST } = await import('@/app/api/organizer/wallet/topup/route')
    h.who = uid
    const r = await json(await POST(post({ amountPaise: 50_000 })))
    if (r.status === 200) { cleanup.add(`walletTopups/${r.body.orderId as string}`); cleanup.add(`walletTopupReconciliation/${r.body.orderId as string}`) }
    return r
  }

  it('GUARD · a paid-but-uncredited (authorised) earlier top-up blocks a new one from ANY session — until it is credited', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'authorized')
    expect((await verify(uid, orderId, pay)).body.code).toBe('PAYMENT_NOT_CAPTURED')
    // "reload" / "another client": a brand-new request with no page state at all
    const before = h.ordersCreated
    const blocked = await createTopup(uid)
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'paid_not_credited' })
    expect(String(blocked.body.error)).toMatch(/do not pay again/i)
    expect(h.ordersCreated).toBe(before)                                     // no Razorpay order minted
    // captured → credited by the webhook → conclusively resolved → a new top-up is allowed
    h.payments.get(pay)!.status = 'captured'
    expect((await webhook(orderId, pay)).status).toBe(200)
    expect((await createTopup(uid)).status).toBe(200)
  }, T)

  it('GUARD · a captured payment whose credit is deferred (open reconciliation) blocks, and resolving it unblocks', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    await put(`walletTopupReconciliation/${orderId}`, { orderId, uid, amountPaise: 50_000, paymentId: pay, status: 'pending', attempts: 1 })
    expect((await createTopup(uid)).body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'credit_pending' })
    await cron()                                                               // re-verifies capture, credits once
    expect((await recon(orderId))?.status).toBe('resolved')
    expect((await createTopup(uid)).status).toBe(200)
  }, T)

  it('GUARD · review and duplicate records block (awaiting a Super Admin decision); an abandoned checkout does NOT block', async () => {
    const a = await organizer(); const oa = await topup(a)
    await put(`walletTopupReconciliation/${oa}`, { orderId: oa, uid: a, amountPaise: 50_000, paymentId: 'pay_x', status: 'needs_review' })
    expect((await createTopup(a)).body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'needs_review' })

    const b = await organizer(); const ob = await topup(b)
    await adminDb.doc(`walletTopups/${ob}`).update({ status: 'credited', paymentId: 'pay_first' })
    await put(`walletTopupReconciliation/dup_pay_second_${P}`, { orderId: ob, uid: b, amountPaise: 50_000, paymentId: `pay_second_${P}`, status: 'duplicate_payment' })
    expect((await createTopup(b)).body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'duplicate_payment' })

    const c = await organizer()
    await topup(c); await topup(c)                                            // two abandoned checkouts: no payments at all
    expect((await createTopup(c)).status).toBe(200)
  }, T)

  it('GUARD · the gateway cannot be asked about a pending order → fail CLOSED (503), no order minted', async () => {
    const uid = await organizer(); await topup(uid)
    h.orderFetchFails = true
    const before = h.ordersCreated
    const r = await createTopup(uid)
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'status_unknown' })
    expect(h.ordersCreated).toBe(before)
  }, T)

  it('GUARD · CONCURRENT top-up requests cannot bypass it', async () => {
    const uid = await organizer(); const orderId = await topup(uid); payment(orderId, 'authorized')
    const before = h.ordersCreated
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => createTopup(uid)))
    expect(rs.every(r => r.status === 409)).toBe(true)
    expect(h.ordersCreated).toBe(before)
    expect((await adminDb.collection('walletTopups').where('uid', '==', uid).get()).size).toBe(1)
  }, T)

  // ═══ W1.1 follow-up · Issue 2 — payment-specific confirmation ════════════════════════════════
  const status = async (uid: string, orderId: string, paymentId: string) => {
    const { GET } = await import('@/app/api/organizer/wallet/topup/status/route')
    h.who = uid
    const qs = new URLSearchParams({ orderId, paymentId })
    return json(await GET(new NextRequest(`http://localhost/api/organizer/wallet/topup/status?${qs}`, { headers: { authorization: 'Bearer t' } })))
  }

  it('STATUS · an UNRELATED wallet credit does not report the original top-up as credited; only its own credit does', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'authorized')
    await verify(uid, orderId, pay)                                            // pending hold
    // an unrelated credit raises the balance (e.g. a licence refund credited to the wallet)
    const { atomicWalletCredit } = await import('@/lib/firebase/firestore/wallet')
    const ledger = adminDb.doc(`walletTransactions/license_refund_w1_${P}_${n}`); cleanup.add(ledger.path)
    await atomicWalletCredit(uid, 20_000, ledger, { organizerUid: uid, type: 'license_refund', status: 'completed', referenceType: 'license', referenceId: 'ev' })
    expect(await balance(uid)).toBe(20_000)
    expect((await status(uid, orderId, pay)).body).toEqual({ state: 'pending' })

    h.payments.get(pay)!.status = 'captured'
    await webhook(orderId, pay)
    expect((await status(uid, orderId, pay)).body).toEqual({ state: 'credited', balancePaise: 70_000 })
  }, T)

  it('STATUS · review and duplicate stay distinct and unresolved; another workspace sees nothing', async () => {
    const uid = await organizer(); const orderId = await topup(uid)
    const first = payment(orderId, 'captured'); const second = payment(orderId, 'captured')
    await verify(uid, orderId, first)
    await webhook(orderId, second)                                             // duplicate recorded
    expect((await status(uid, orderId, first)).body.state).toBe('credited')
    expect((await status(uid, orderId, second)).body).toEqual({ state: 'duplicate_payment' })

    const o2 = await topup(uid); const p2 = payment(o2, 'captured')
    await put(`walletTopupReconciliation/${o2}`, { orderId: o2, uid, amountPaise: 50_000, paymentId: p2, status: 'needs_review' })
    expect((await status(uid, o2, p2)).body).toEqual({ state: 'needs_review' })

    const other = await organizer()
    expect((await status(other, orderId, first)).status).toBe(404)
    expect((await status(uid, 'bad id!', first)).status).toBe(400)
  }, T)

  it('STATUS · polling is READ-ONLY: it never credits, verifies, creates an order or changes any record', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    const snapshot = async () => JSON.stringify([
      await balance(uid), await topupDoc(orderId), await ledgerExists(orderId), (await recon(orderId)) ?? null,
    ])
    const before = await snapshot()
    const ordersBefore = h.ordersCreated, fetchesBefore = h.paymentFetches
    for (let i = 0; i < 5; i++) expect((await status(uid, orderId, pay)).body).toEqual({ state: 'pending' })
    expect(await snapshot()).toBe(before)                                      // captured but NOT credited by polling
    expect(h.ordersCreated).toBe(ordersBefore)
    expect(h.paymentFetches).toBe(fetchesBefore)                               // not even a gateway read
  }, T)

  // ═══ W2.a · retry hygiene ═══════════════════════════════════════════════════════════════════
  const MIN = 60_000
  const recMs = (v: unknown) => (v as { toMillis: () => number }).toMillis()
  const makeDue = async (id: string, at = Date.now() - 1_000) =>
    adminDb.doc(`walletTopupReconciliation/${id}`).update({ nextAttemptAt: Timestamp.fromMillis(at) })
  const resetLegacyCursor = () => adminDb.doc('reconciliationCursors/walletTopupReconciliation.legacy').delete().catch(() => null)

  it('W2.a · backoff: 10 min after the first failure, doubling, capped at 6 h; exhausted at attempt 12; firstSeenAt never changes', async () => {
    const { recordWalletTopupReconciliation, RETRY_POLICY } = await import('@/lib/wallet/topupReconciliation')
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    h.failFetchFor.add(pay)                                                    // transient gateway failure, every time
    expect(await recordWalletTopupReconciliation({ orderId, uid, amountPaise: 50_000, paymentId: pay, error: 'credit failed' })).toBe(true)
    let r = (await recon(orderId))!
    const firstSeen = recMs(r.firstSeenAt)
    expect(r).toMatchObject({ status: 'pending', attempts: 1 })
    expect(Math.abs(recMs(r.nextAttemptAt) - (Date.now() + 10 * MIN))).toBeLessThan(MIN)

    const expected = [20, 40, 80, 160, 320, 360, 360, 360, 360, 360]         // attempts 2 … 11 (minutes)
    for (let i = 0; i < expected.length; i++) {
      await makeDue(orderId)
      await cron()
      r = (await recon(orderId))!
      expect(r.status, `attempt ${i + 2}`).toBe('pending')
      expect(r.attempts).toBe(i + 2)
      expect(Math.abs(recMs(r.nextAttemptAt) - (Date.now() + expected[i] * MIN)), `delay after attempt ${i + 2}`).toBeLessThan(MIN)
      expect(recMs(r.firstSeenAt)).toBe(firstSeen)
    }
    await makeDue(orderId)
    const res = await cron()
    r = (await recon(orderId))!
    expect(r.status).toBe('exhausted')
    expect(r.attempts).toBe(RETRY_POLICY.maxAttempts)
    expect(r.nextAttemptAt).toBeUndefined()
    expect(res.exhausted).toBeGreaterThanOrEqual(1)
    expect(recMs(r.firstSeenAt)).toBe(firstSeen)
    expect(await balance(uid)).toBe(0)                                         // never credited on a failed verification

    // exhausted is NOT retried, stays unresolved, blocks new top-ups, and is never downgraded
    h.failFetchFor.clear()
    await cron()
    expect((await recon(orderId))!.status).toBe('exhausted')
    const blocked = await createTopup(uid)
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'retry_exhausted' })
    expect(await recordWalletTopupReconciliation({ orderId, uid, amountPaise: 50_000, paymentId: pay, error: 'again' })).toBe(true)
    expect((await recon(orderId))!.status).toBe('exhausted')
    expect((await status(uid, orderId, pay)).body).toEqual({ state: 'needs_review' })
  }, T)

  it('W2.a · repeated recording (webhook + verify) never resets the counters or schedule; review is never downgraded', async () => {
    const { recordWalletTopupReconciliation } = await import('@/lib/wallet/topupReconciliation')
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    await recordWalletTopupReconciliation({ orderId, uid, amountPaise: 50_000, paymentId: pay, error: 'webhook credit failed' })
    const first = (await recon(orderId))!
    await recordWalletTopupReconciliation({ orderId, uid, amountPaise: 50_000, paymentId: pay, error: 'verify credit failed' })
    const second = (await recon(orderId))!
    expect(second.attempts).toBe(1)
    expect(recMs(second.nextAttemptAt)).toBe(recMs(first.nextAttemptAt))
    expect(recMs(second.firstSeenAt)).toBe(recMs(first.firstSeenAt))
    expect(second.lastError).toBe('verify credit failed')
    // escalation pending → needs_review is allowed; the reverse never happens
    await recordWalletTopupReconciliation({ orderId, uid, amountPaise: 50_000, paymentId: pay, error: 'refused', status: 'needs_review' })
    expect((await recon(orderId))!.status).toBe('needs_review')
    await recordWalletTopupReconciliation({ orderId, uid, amountPaise: 50_000, paymentId: pay, error: 'transient again' })
    const after = (await recon(orderId))!
    expect(after.status).toBe('needs_review')
    expect(recMs(after.firstSeenAt)).toBe(recMs(first.firstSeenAt))
  }, T)

  it('W2.a · the duplicate record keeps its firstSeenAt across detections', async () => {
    const { recordDuplicateTopupPayment } = await import('@/lib/wallet/topupReconciliation')
    const uid = await organizer(); const orderId = await topup(uid); const second = payment(orderId, 'captured')
    const input = { orderId, uid, amountPaise: 50_000, paymentId: second, creditedPaymentId: 'pay_first', source: 'webhook' as const }
    await recordDuplicateTopupPayment(input)
    const a = (await recon(`dup_${second}`))!
    await recordDuplicateTopupPayment({ ...input, source: 'verify' })
    const b = (await recon(`dup_${second}`))!
    expect(recMs(b.firstSeenAt)).toBe(recMs(a.firstSeenAt))
    expect(b.detectedBy).toEqual(expect.arrayContaining(['webhook', 'verify']))
    const flags = await adminDb.collection('suspiciousPayments').where('paymentId', '==', second).get()
    for (const d of flags.docs) cleanup.add(`suspiciousPayments/${d.id}`)
  }, T)

  it('W2.a · transient failures retry; permanent ones go to review and are not retried', async () => {
    const uid = await organizer()
    const o1 = await topup(uid); const p1 = payment(o1, 'captured')
    const o2 = await topup(uid); const p2 = payment(o2, 'captured', 1_000)     // amount mismatch → permanent
    const o3 = await topup(uid); const p3 = payment(o3, 'authorized')          // waiting → transient
    const old = Date.now() - 10 * 24 * 3600 * 1000
    for (const [o, p] of [[o1, p1], [o2, p2], [o3, p3]] as const) {
      await put(`walletTopupReconciliation/${o}`, { orderId: o, uid, amountPaise: 50_000, paymentId: p, status: 'pending', attempts: 1, nextAttemptAt: Timestamp.fromMillis(old), firstSeenAt: Timestamp.fromMillis(old) })
    }
    h.failFetchFor.add(p1)
    await cron()
    expect(await recon(o1)).toMatchObject({ status: 'pending', attempts: 2 })
    expect(await recon(o2)).toMatchObject({ status: 'needs_review', attempts: 1 })
    expect(await recon(o3)).toMatchObject({ status: 'pending', attempts: 2 })
    expect((await recon(o2))!.nextAttemptAt).toBeUndefined()
    // the review record is not retried even when due-looking
    await cron()
    expect((await recon(o2))!.status).toBe('needs_review')
    expect(await balance(uid)).toBe(0)
  }, T)

  it('W2.a · deterministic order and a bounded batch: earliest nextAttemptAt first, the rest on the next run', async () => {
    const { retryPendingWalletTopups } = await import('@/lib/wallet/topupReconciliation')
    const uid = await organizer()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const o = await topup(uid); const p = payment(o, 'captured')
      // far in the past so they sort ahead of anything else due on this shared emulator
      await put(`walletTopupReconciliation/${o}`, { orderId: o, uid, amountPaise: 50_000, paymentId: p, status: 'pending', attempts: 1, nextAttemptAt: Timestamp.fromMillis(946_684_800_000 + i * 1000), firstSeenAt: Timestamp.fromMillis(946_684_800_000) })
      ids.push(o)
    }
    await retryPendingWalletTopups(2)
    expect((await recon(ids[0]))!.status).toBe('resolved')
    expect((await recon(ids[1]))!.status).toBe('resolved')
    expect((await recon(ids[2]))!.status).toBe('pending')                     // beyond the batch — not starved:
    await retryPendingWalletTopups(2)
    expect((await recon(ids[2]))!.status).toBe('resolved')
    expect(await balance(uid)).toBe(150_000)                                   // each order credited exactly once
    await retryPendingWalletTopups(2)
    expect(await balance(uid)).toBe(150_000)
  }, T)

  it('W2.a · legacy records (no nextAttemptAt / firstSeenAt) are normalized — never skipped — and keep their attempts', async () => {
    await resetLegacyCursor()
    const uid = await organizer()
    const o1 = await topup(uid); const p1 = payment(o1, 'captured')
    const o2 = await topup(uid); const p2 = payment(o2, 'authorized')
    const legacyUpdated = Timestamp.fromMillis(Date.now() - 3 * 24 * 3600 * 1000)
    await put(`walletTopupReconciliation/${o1}`, { orderId: o1, uid, amountPaise: 50_000, paymentId: p1, status: 'pending', attempts: 3, updatedAt: legacyUpdated })
    await put(`walletTopupReconciliation/${o2}`, { orderId: o2, uid, amountPaise: 50_000, paymentId: p2, status: 'pending', attempts: 11, updatedAt: legacyUpdated })
    let res = await cron()
    // the cursor may start mid-collection on a shared emulator — at most a couple of runs reach both
    for (let i = 0; i < 3 && (!(await recon(o1))?.nextAttemptAt && (await recon(o1))?.status === 'pending'); i++) res = await cron()
    expect(res.legacyNormalized).toBeGreaterThanOrEqual(0)
    const r1 = (await recon(o1))!
    expect(r1.status).toBe('resolved')                                         // normalized, due, credited
    expect(recMs(r1.firstSeenAt)).toBe(legacyUpdated.toMillis())               // derived from the legacy updatedAt
    for (let i = 0; i < 3 && (await recon(o2))?.status === 'pending' && !(await recon(o2))?.lastAttemptAt; i++) await cron()
    const r2 = (await recon(o2))!
    expect(r2.status).toBe('exhausted')                                        // legacy attempts 11 kept → 12th attempt exhausts
    expect(r2.attempts).toBe(12)
    expect(await balance(uid)).toBe(50_000)
  }, T)

  // ═══ W2.b · webhook mismatch recording ═══════════════════════════════════════════════════════
  const flagsFor = async (paymentId: string) => {
    const q = await adminDb.collection('suspiciousPayments').where('paymentId', '==', paymentId).get()
    for (const d of q.docs) cleanup.add(`suspiciousPayments/${d.id}`)
    return q.docs.map(d => d.data() as { reason?: string })
  }

  it('W2.b · a captured AMOUNT mismatch is recorded durably as needs_review (never credited) with expected/observed details', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured', 1_000)
    cleanup.add(`walletTopupReconciliation/mismatch_${pay}`)
    const r = await webhook(orderId, pay, 1_000)
    expect(r.status).toBe(200)
    expect(await recon(`mismatch_${pay}`)).toMatchObject({
      orderId, uid, paymentId: pay, status: 'needs_review', reason: 'amount_mismatch',
      expectedAmountPaise: 50_000, observedAmountPaise: 1_000, expectedCurrency: 'INR', observedCurrency: 'INR',
      detectedBy: 'webhook', deliveries: 1,
    })
    expect((await recon(`mismatch_${pay}`))!.nextAttemptAt).toBeUndefined()   // not a transient retry
    expect(await balance(uid)).toBe(0)
    expect((await topupDoc(orderId)).status).toBe('pending')
    expect(await ledgerExists(orderId)).toBe(false)
    expect((await flagsFor(pay)).filter(f => f.reason === 'amount_mismatch')).toHaveLength(1)
  }, T)

  it('W2.b · a captured CURRENCY mismatch is recorded as needs_review with its own reason', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured')
    cleanup.add(`walletTopupReconciliation/mismatch_${pay}`)
    expect((await webhook(orderId, pay, 50_000, 'USD')).status).toBe(200)
    expect(await recon(`mismatch_${pay}`)).toMatchObject({ status: 'needs_review', reason: 'currency_mismatch', observedCurrency: 'USD', observedAmountPaise: 50_000 })
    expect(await balance(uid)).toBe(0)
    const pay2 = payment(orderId, 'captured', 7)
    cleanup.add(`walletTopupReconciliation/mismatch_${pay2}`)
    await webhook(orderId, pay2, 7, 'USD')
    expect((await recon(`mismatch_${pay2}`))!.reason).toBe('amount_and_currency_mismatch')
  }, T)

  it('W2.b · duplicate deliveries: ONE record, firstSeenAt/status kept, flagged once; the order record and its retry metadata are untouched', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured', 1_000)
    cleanup.add(`walletTopupReconciliation/mismatch_${pay}`)
    // the ORDER's own record (another payment's credit retry) must not be disturbed by a mismatch
    const orderRec = { orderId, uid, amountPaise: 50_000, paymentId: 'pay_other', status: 'exhausted', attempts: 12, firstSeenAt: Timestamp.fromMillis(1_000_000), nextAttemptAt: Timestamp.fromMillis(2_000_000) }
    await put(`walletTopupReconciliation/${orderId}`, orderRec)
    await webhook(orderId, pay, 1_000)
    const first = (await recon(`mismatch_${pay}`))!
    for (let i = 0; i < 3; i++) expect((await webhook(orderId, pay, 1_000)).status).toBe(200)
    const after = (await recon(`mismatch_${pay}`))!
    expect(after.deliveries).toBe(4)
    expect(after.status).toBe('needs_review')
    expect(recMs(after.firstSeenAt)).toBe(recMs(first.firstSeenAt))
    expect((await flagsFor(pay)).filter(f => f.reason === 'amount_mismatch')).toHaveLength(1)
    const o = (await recon(orderId))!
    expect(o).toMatchObject({ status: 'exhausted', attempts: 12, paymentId: 'pay_other' })
    expect(recMs(o.firstSeenAt)).toBe(1_000_000)
    expect(recMs(o.nextAttemptAt)).toBe(2_000_000)
    // a later status on the mismatch record (e.g. a future review decision) is never overwritten by a redelivery
    await adminDb.doc(`walletTopupReconciliation/mismatch_${pay}`).update({ status: 'exhausted' })
    await webhook(orderId, pay, 1_000)
    expect((await recon(`mismatch_${pay}`))!.status).toBe('exhausted')
    expect(await balance(uid)).toBe(0)
  }, T)

  it('W2.b · if the mismatch cannot be recorded, the webhook answers 500 (Razorpay redelivers) and credits nothing', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const pay = payment(orderId, 'captured', 1_000)
    cleanup.add(`walletTopupReconciliation/mismatch_${pay}`)
    failReconciliationWrite()
    const r = await webhook(orderId, pay, 1_000)
    vi.restoreAllMocks()
    expect(r.status).toBe(500)
    expect(await recon(`mismatch_${pay}`)).toBeUndefined()
    expect(await balance(uid)).toBe(0)
    expect((await webhook(orderId, pay, 1_000)).status).toBe(200)              // the redelivery records it
    expect((await recon(`mismatch_${pay}`))!.status).toBe('needs_review')
  }, T)

  it('W2.b · the mismatch blocks new top-ups and reads as needs_review; verify, cron and the webhook never credit it; a matching payment still credits', async () => {
    const uid = await organizer(); const orderId = await topup(uid); const bad = payment(orderId, 'captured', 1_000)
    cleanup.add(`walletTopupReconciliation/mismatch_${bad}`)
    await webhook(orderId, bad, 1_000)
    const blocked = await createTopup(uid)
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'needs_review' })
    expect((await status(uid, orderId, bad)).body).toEqual({ state: 'needs_review' })
    expect((await verify(uid, orderId, bad)).status).toBe(400)                   // verify re-checks the gateway amount
    await cron()                                                                 // needs_review is never retried
    expect((await recon(`mismatch_${bad}`))!.status).toBe('needs_review')
    expect(await balance(uid)).toBe(0)

    // the normal path is unchanged: a MATCHING captured payment on another order credits once
    const other = await organizer(); const o2 = await topup(other); const good = payment(o2, 'captured')
    expect((await webhook(o2, good)).status).toBe(200)
    expect(await balance(other)).toBe(50_000)
    expect(await recon(`mismatch_${good}`)).toBeUndefined()
  }, T)

  // ═══ W2.c · stale top-up sweep ════════════════════════════════════════════════════════════════
  describe('W2.c · stale top-up sweep', () => {
    const CURSOR = 'reconciliationCursors/walletTopups.staleSweep'
    const HOUR = 60 * MIN
    const DAY = 24 * HOUR
    // The sweep reads EVERY pending order, so earlier tests' fixtures are cleared first (private
    // demo emulator only — beforeAll refuses anything else).
    beforeEach(async () => {
      delete process.env.WALLET_TOPUP_SWEEP_MODE
      const pend = await adminDb.collection('walletTopups').where('status', 'in', ['pending', 'abandoned']).get()
      for (let k = 0; k < pend.docs.length; k += 400) {
        const b = adminDb.batch()
        for (const d of pend.docs.slice(k, k + 400)) b.delete(d.ref)
        await b.commit()
      }
      await adminDb.doc(CURSOR).delete().catch(() => null)
      await adminDb.doc('reconciliationCursors/walletTopups.abandonedWatch').delete().catch(() => null)
      await adminDb.doc('reconciliationCursors/walletTopups.sweepAlerts').delete().catch(() => null)
    }, T)
    afterEach(() => { delete process.env.WALLET_TOPUP_SWEEP_MODE })

    let w = 0
    /** A pending order as the order route writes it, `ageMs` old (null = legacy: no createdAt). */
    async function stale(uid: string, ageMs: number | null, extra: Record<string, unknown> = {}) {
      const orderId = `order_w2c_${P}_${String(++w).padStart(4, '0')}`
      await put(`walletTopups/${orderId}`, {
        orderId, uid, amountPaise: 50_000, currency: 'INR', provider: 'razorpay', status: 'pending',
        ...(ageMs === null ? {} : { createdAt: Timestamp.fromMillis(Date.now() - ageMs) }),
        ...extra,
      })
      cleanup.add(`walletTransactions/topup_${orderId}`)
      cleanup.add(`walletTopupReconciliation/${orderId}`)
      return orderId
    }
    const sweep = async (opts: { mode?: 'report' | 'enforce'; deadlineAtMs?: number } = {}) =>
      (await import('@/lib/wallet/topupReconciliation')).sweepStaleWalletTopups(opts)
    const enforce = () => sweep({ mode: 'enforce' })

    // ── discovery and cursor ──────────────────────────────────────────────────────────────────
    it('W2.c · discovery: stale pending orders with NO reconciliation record are found; young, non-Razorpay, retry-owned and malformed orders are skipped; no-createdAt is checked but never abandoned', async () => {
      const uid = await organizer()
      const found = await stale(uid, HOUR); const pay = payment(found, 'captured')
      const young = await stale(uid, 5 * MIN); payment(young, 'captured')
      const cf = await stale(uid, HOUR, { provider: 'cashfree' })
      const owned = await stale(uid, HOUR); const ownedPay = payment(owned, 'captured')
      await put(`walletTopupReconciliation/${owned}`, { orderId: owned, uid, amountPaise: 50_000, paymentId: ownedPay, status: 'pending', attempts: 3, nextAttemptAt: Timestamp.fromMillis(Date.now() + HOUR), firstSeenAt: Timestamp.fromMillis(1_000_000) })
      const ownedBefore = JSON.stringify(await recon(owned))
      const legacy = await stale(uid, null)                                     // no createdAt, no payment
      const badTs = await stale(uid, null, { createdAt: 'last week' })           // unusable createdAt
      const malformed = await stale(uid, 10 * DAY, { amountPaise: null })

      const r = await enforce()
      expect(r).toMatchObject({
        mode: 'enforce', scanned: 7, tooRecent: 1, skippedProvider: 1, skippedOpenReconciliation: 1, malformedOrders: 1,
        checked: 3, singleMatch: 1, credited: 1, unpaidRecent: 2, unpaidAbandonable: 0, abandoned: 0, wrapped: true, complete: true,
      })
      expect(await balance(uid)).toBe(50_000)
      expect(await topupDoc(found)).toMatchObject({ status: 'credited', paymentId: pay })
      for (const o of [young, cf, owned, legacy, badTs, malformed]) expect((await topupDoc(o)).status).toBe('pending')
      expect(JSON.stringify(await recon(owned))).toBe(ownedBefore)               // the retry's record is untouched
      expect([...h.orderLookups].sort()).toEqual([found, legacy, badTs].sort())
    }, T)

    it('W2.c · bounded: pages of 200 by document id, ≤ 50 gateway calls and ≤ 5 in flight per run; the cursor advances and wraps, reaching every order exactly once per cycle', async () => {
      const uid = await organizer()
      const ids: string[] = []
      const createdAt = Timestamp.fromMillis(Date.now() - HOUR)
      for (let k = 0; k < 205; k += 100) {
        const b = adminDb.batch()
        for (let m = k; m < Math.min(k + 100, 205); m++) {
          const id = `order_w2c_bulk_${P}_${String(m).padStart(4, '0')}`
          ids.push(id)
          b.set(adminDb.doc(`walletTopups/${id}`), { orderId: id, uid, amountPaise: 50_000, currency: 'INR', provider: 'razorpay', status: 'pending', createdAt })
          cleanup.add(`walletTopups/${id}`)
        }
        await b.commit()
      }
      h.gatewayDelayMs = 15
      const first = await sweep()                                                // report (env unset)
      expect(first).toMatchObject({ mode: 'report', scanned: 200, complete: false, wrapped: false })
      expect(first.gatewayCalls).toBeLessThanOrEqual(50)
      expect(first.deferredForNextRun).toBe(200 - first.checked)
      expect(h.maxInflight).toBeGreaterThan(1)
      expect(h.maxInflight).toBeLessThanOrEqual(5)
      let runs = 1, wrapped = false
      while (!wrapped && runs < 10) {
        const r = await sweep()
        runs++
        expect(r.gatewayCalls).toBeLessThanOrEqual(50)
        wrapped = r.wrapped
      }
      expect(wrapped).toBe(true)
      expect(h.maxInflight).toBeLessThanOrEqual(5)
      expect(h.orderLookups).toHaveLength(205)                                   // no order twice, none skipped
      expect(new Set(h.orderLookups)).toEqual(new Set(ids))
      h.orderLookups = []
      await sweep()                                                              // a new cycle starts at the beginning
      expect(h.orderLookups[0]).toBe(ids[0])
      for (const id of ids.slice(0, 3)) expect((await topupDoc(id)).status).toBe('pending')   // report: nothing changed
    }, T)

    // ── classification ────────────────────────────────────────────────────────────────────────
    it('W2.c · ONE matching captured payment: REPORT mode (the default) changes nothing; ENFORCE credits it exactly once', async () => {
      const uid = await organizer(); const o = await stale(uid, HOUR); const pay = payment(o, 'captured')
      const snap = async () => JSON.stringify([
        await balance(uid), await topupDoc(o), await ledgerExists(o),
        (await recon(o)) ?? null, (await recon(`mismatch_${pay}`)) ?? null, (await recon(`dup_${pay}`)) ?? null,
      ])
      const before = await snap()
      const rep = await sweep()
      expect(rep).toMatchObject({ mode: 'report', singleMatch: 1, creditBlocked: 0, credited: 0, gatewayCalls: 2 })   // lookup + raw payments (read-only)
      expect(await snap()).toBe(before)

      process.env.WALLET_TOPUP_SWEEP_MODE = ' Enforce '
      const enf = await sweep()
      expect(enf).toMatchObject({ mode: 'enforce', singleMatch: 1, credited: 1, gatewayCalls: 2 })   // lookup + raw confirmation
      expect(await balance(uid)).toBe(50_000)
      expect(await topupDoc(o)).toMatchObject({ status: 'credited', paymentId: pay })
      expect((await adminDb.collection('walletTransactions').where('orderId', '==', o).get()).size).toBe(1)
      expect((await sweep()).credited).toBe(0)                                    // credited → no longer pending
      expect(await balance(uid)).toBe(50_000)
    }, T)

    it('W2.c · authorised stays pending at any age; no / created / failed / refunded payments are abandoned only at ≥ 7 days and only in enforce', async () => {
      const uid = await organizer()
      const auth8d = await stale(uid, 8 * DAY); payment(auth8d, 'authorized')
      const none1h = await stale(uid, HOUR)
      const failed6d = await stale(uid, 6 * DAY); payment(failed6d, 'failed')
      const none8d = await stale(uid, 8 * DAY)
      const created8d = await stale(uid, 8 * DAY); payment(created8d, 'created')
      const failed8d = await stale(uid, 8 * DAY); payment(failed8d, 'failed')
      const refunded8d = await stale(uid, 8 * DAY); payment(refunded8d, 'refunded')
      const old = [none8d, created8d, failed8d, refunded8d]

      expect(await sweep()).toMatchObject({ mode: 'report', authorized: 1, unpaidRecent: 2, unpaidAbandonable: 4, abandoned: 0 })
      for (const o of [auth8d, none1h, failed6d, ...old]) expect((await topupDoc(o)).status).toBe('pending')

      expect(await enforce()).toMatchObject({ authorized: 1, unpaidRecent: 2, unpaidAbandonable: 4, abandoned: 4 })
      for (const o of [auth8d, none1h, failed6d]) expect((await topupDoc(o)).status).toBe('pending')
      for (const o of old) {
        expect(await topupDoc(o)).toMatchObject({ status: 'abandoned', abandonReason: 'no_captured_or_authorized_payment_after_7_days' })
        expect(await recon(o)).toBeUndefined()
      }
      // abandoned is NOT creditable
      const { atomicTopupCredit } = await import('@/lib/firebase/firestore/wallet')
      await expect(atomicTopupCredit(uid, 50_000, adminDb.doc(`walletTopups/${none8d}`), 'pay_late_x')).rejects.toMatchObject({ code: 'TOPUP_NOT_CREDITABLE' })
      expect(await balance(uid)).toBe(0)
      // abandoned orders moved no money — the authorised one still blocks a new top-up
      expect((await createTopup(uid)).body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'paid_not_credited' })
    }, T)

    it('W2.c · a captured MISMATCH is recorded durably (enforce only), never credited, never abandoned; later passes never reset it', async () => {
      const uid = await organizer(); const o = await stale(uid, 8 * DAY); const pay = payment(o, 'captured', 1_000)
      cleanup.add(`walletTopupReconciliation/mismatch_${pay}`)
      expect(await sweep()).toMatchObject({ mismatchedPayments: 1, mismatchesRecorded: 0 })
      expect(await recon(`mismatch_${pay}`)).toBeUndefined()

      expect(await enforce()).toMatchObject({ mismatchedPayments: 1, mismatchesRecorded: 1, abandoned: 0, credited: 0 })
      const first = (await recon(`mismatch_${pay}`))!
      expect(first).toMatchObject({ orderId: o, status: 'needs_review', reason: 'amount_mismatch', detectedBy: 'sweep', observedAmountPaise: 1_000, expectedAmountPaise: 50_000 })
      await enforce()
      const after = (await recon(`mismatch_${pay}`))!
      expect(after.status).toBe('needs_review')
      expect(after.deliveries).toBe(2)
      expect(recMs(after.firstSeenAt)).toBe(recMs(first.firstSeenAt))
      expect((await topupDoc(o)).status).toBe('pending')
      expect(await balance(uid)).toBe(0)
      expect((await createTopup(uid)).body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'needs_review' })
    }, T)

    it('W2.c · D1 — two matching captured payments: NONE credited; the order is held and EVERY payment recorded; no later webhook / verify / sweep can credit either', async () => {
      const uid = await organizer(); const o = await stale(uid, HOUR)
      const p1 = payment(o, 'captured'); const p2 = payment(o, 'captured')
      const both = [p1, p2].sort()
      expect(await sweep()).toMatchObject({ multipleCaptured: 1, held: 0 })
      expect((await topupDoc(o)).status).toBe('pending')

      expect(await enforce()).toMatchObject({ multipleCaptured: 1, held: 1, credited: 0 })
      expect(await topupDoc(o)).toMatchObject({ status: 'needs_review', holdReason: 'multiple_captured_payments', heldPaymentIds: both })
      for (const p of both) {
        expect(await recon(`dup_${p}`)).toMatchObject({
          orderId: o, uid, paymentId: p, status: 'needs_review', reason: 'multiple_captured_payments',
          creditedPaymentId: null, capturedPaymentIds: both, detectedBy: ['sweep'],
        })
        expect((await flagsFor(p)).filter(f => f.reason === 'multiple_captured_payments')).toHaveLength(1)
      }
      expect((await createTopup(uid)).body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'needs_review' })
      expect((await status(uid, o, p1)).body).toEqual({ state: 'needs_review' })

      // a redelivered webhook and a verify for either payment are refused — held, not credited
      expect((await webhook(o, p1)).status).toBe(200)
      expect((await verify(uid, o, p2)).body.code).toBe('NEEDS_REVIEW')
      expect(await balance(uid)).toBe(0)
      expect(await ledgerExists(o)).toBe(false)
      expect(await recon(o)).toMatchObject({ status: 'needs_review', paymentIds: [p1, p2] })

      const seen = recMs((await recon(`dup_${p1}`))!.firstSeenAt)
      h.orderLookups = []
      await enforce()                                                            // no longer pending: not revisited
      expect(h.orderLookups).not.toContain(o)
      expect(recMs((await recon(`dup_${p1}`))!.firstSeenAt)).toBe(seen)
    }, T)

    it('W2.c · malformed or uncertain gateway data is never credited, recorded or abandoned; a raw confirmation that disagrees is a mismatch, not a credit', async () => {
      const uid = await organizer()
      const normalized = (o: string, over: Record<string, unknown>) =>
        ({ provider: 'razorpay', providerPaymentId: `pay_w2c_m_${o}`, providerOrderId: o, status: 'captured', amountPaise: 50_000, currency: 'INR', capturedAtMs: null, ...over })
      const cases: Array<Record<string, unknown>> = [
        { amountPaise: 0 },                 // the adapter's default for a missing amount
        { currency: '' },
        { providerOrderId: 'order_someone_else' },
        { providerPaymentId: '' },
        { status: 'mystery' },
      ]
      const odd: string[] = []
      for (const over of cases) { const o = await stale(uid, 8 * DAY); h.orderOverride.set(o, [normalized(o, over)]); odd.push(o) }
      // the adapter says INR (its default), but the RAW payment carries no currency at all
      const o2 = await stale(uid, HOUR); const pay = payment(o2, 'captured')
      h.rawOrderOverride.set(o2, { items: [{ id: pay, status: 'captured', amount: 50_000, order_id: o2 }] })
      cleanup.add(`walletTopupReconciliation/mismatch_${pay}`)

      const r = await enforce()
      expect(r).toMatchObject({ uncertain: 5, singleMatch: 1, credited: 0, abandoned: 0, mismatchesRecorded: 1 })
      for (const o of [...odd, o2]) expect((await topupDoc(o)).status).toBe('pending')
      expect(await balance(uid)).toBe(0)
      expect(await recon(`mismatch_${pay}`)).toMatchObject({ status: 'needs_review', reason: 'currency_mismatch', observedCurrency: null, detectedBy: 'sweep' })
    }, T)

    // ── idempotency and concurrency ─────────────────────────────────────────────────────────────
    it('W2.c · two sweeps, the webhook, verify and the retry racing on ONE captured order credit it exactly once', async () => {
      const uid = await organizer(); const o = await stale(uid, HOUR); const pay = payment(o, 'captured')
      h.gatewayDelayMs = 5
      await Promise.all([enforce(), enforce(), webhook(o, pay), verify(uid, o, pay), cron()])
      expect(await balance(uid)).toBe(50_000)
      expect((await adminDb.collection('walletTransactions').where('orderId', '==', o).get()).size).toBe(1)
      expect(await recon(`dup_${pay}`)).toBeUndefined()
      expect((await topupDoc(o)).paymentId).toBe(pay)
    }, T)

    it('W2.c · D3 — late captured payments on an ABANDONED order are held for review (every payment kept), never credited; the order stays abandoned', async () => {
      const uid = await organizer(); const o = await stale(uid, 8 * DAY)
      expect((await enforce()).abandoned).toBe(1)
      const late1 = payment(o, 'captured'); const late2 = payment(o, 'captured')

      expect((await webhook(o, late1)).status).toBe(200)
      const r1 = (await recon(o))!
      expect(r1).toMatchObject({ status: 'needs_review', paymentId: late1, paymentIds: [late1] })
      expect((await webhook(o, late1)).status).toBe(200)                         // redelivery
      expect((await verify(uid, o, late2)).body.code).toBe('NEEDS_REVIEW')
      const r2 = (await recon(o))!
      expect(r2.status).toBe('needs_review')
      expect(r2.paymentIds).toEqual([late1, late2])
      expect(r2.attempts).toBe(r1.attempts)
      expect(recMs(r2.firstSeenAt)).toBe(recMs(r1.firstSeenAt))

      // verify cannot claim "sent for review" when that could not be recorded
      const late3 = payment(o, 'captured')
      failReconciliationWrite()
      const refusedUnrecorded = await verify(uid, o, late3)
      vi.restoreAllMocks()
      expect(refusedUnrecorded.status).toBe(503)
      expect(refusedUnrecorded.body.code).toBe('REVIEW_UNRECORDED')                // never "will be credited"

      expect((await topupDoc(o)).status).toBe('abandoned')
      expect(await balance(uid)).toBe(0)
      expect((await createTopup(uid)).body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'needs_review' })
      expect((await status(uid, o, late2)).body).toEqual({ state: 'needs_review' })
      h.orderLookups = []
      await enforce()
      expect(h.orderLookups).not.toContain(o)                                    // abandoned: never swept again
    }, T)

    it('W2.c · orders owned by held W2.a records (needs_review / exhausted / duplicate_payment) are skipped — never credited, never downgraded', async () => {
      const uid = await organizer()
      const ids: string[] = []
      for (const st of ['needs_review', 'exhausted', 'duplicate_payment']) {
        const o = await stale(uid, HOUR); const p = payment(o, 'captured')
        await put(`walletTopupReconciliation/${o}`, { orderId: o, uid, amountPaise: 50_000, paymentId: p, status: st, attempts: 12, firstSeenAt: Timestamp.fromMillis(1_000_000) })
        ids.push(o)
      }
      const before = await Promise.all(ids.map(async o => JSON.stringify(await recon(o))))
      expect(await enforce()).toMatchObject({ skippedOpenReconciliation: 3, checked: 0, credited: 0 })
      expect(await Promise.all(ids.map(async o => JSON.stringify(await recon(o))))).toEqual(before)
      expect(await balance(uid)).toBe(0)
    }, T)

    // ── reliability and budgets ─────────────────────────────────────────────────────────────────
    it('W2.c · gateway outage is UNCERTAIN, never unpaid: nothing abandoned; 3 consecutive failures open the circuit and the cursor stays for the next run', async () => {
      const uid = await organizer()
      const os: string[] = []
      for (let k = 0; k < 8; k++) os.push(await stale(uid, 8 * DAY))
      h.orderFetchFails = true
      const r = await enforce()
      expect(r).toMatchObject({ circuitOpen: true, abandoned: 0, complete: false, deferredForNextRun: 8 })
      expect(r.uncertain).toBeGreaterThanOrEqual(3)
      expect(r.gatewayCalls).toBeLessThanOrEqual(5)
      for (const o of os) expect((await topupDoc(o)).status).toBe('pending')
      expect((await adminDb.doc(CURSOR).get()).exists).toBe(false)

      h.orderFetchFails = false
      h.failOrders.add(os[0])                                                    // one isolated failure: no circuit
      const r2 = await enforce()
      expect(r2).toMatchObject({ circuitOpen: false, abandoned: 7, uncertain: 1 })
      expect((await topupDoc(os[0])).status).toBe('pending')
    }, T)

    it('W2.c · the time budget stops NEW gateway work: nothing looked up, everything deferred, the cursor does not move', async () => {
      const uid = await organizer(); await stale(uid, HOUR); await stale(uid, HOUR)
      const r = await sweep({ mode: 'enforce', deadlineAtMs: Date.now() - 1 })
      expect(r).toMatchObject({ timeBudgetReached: true, gatewayCalls: 0, deferredForNextRun: 2, complete: false, wrapped: false })
      expect(h.orderLookups).toHaveLength(0)
      expect((await adminDb.doc(CURSOR).get()).exists).toBe(false)
    }, T)

    it('W2.c · a transient credit failure goes to the W2.a schedule (and the retry completes it); a refusal is held for review', async () => {
      const uid = await organizer(); const o = await stale(uid, HOUR); const pay = payment(o, 'captured')
      failLedgerCreate()
      const r = await enforce()
      vi.restoreAllMocks()
      expect(r).toMatchObject({ creditDeferred: 1, credited: 0 })
      const rec = (await recon(o))!
      expect(rec).toMatchObject({ status: 'pending', attempts: 1, paymentId: pay })
      expect(recMs(rec.nextAttemptAt) - Date.now()).toBeGreaterThan(9 * MIN)
      expect((await enforce()).skippedOpenReconciliation).toBe(1)               // now the retry's
      await makeDue(o); await cron()
      expect(await balance(uid)).toBe(50_000)

      const u2 = await organizer(); const o2 = await stale(u2, HOUR); payment(o2, 'captured')
      await put(`walletTransactions/topup_${o2}`, { organizerUid: u2, type: 'fund_added', amountPaise: 50_000, orderId: o2 })
      expect(await enforce()).toMatchObject({ creditRefused: 1, credited: 0 })
      expect(await recon(o2)).toMatchObject({ status: 'needs_review' })
      expect(await balance(u2)).toBe(0)
    }, T)

    it('W2.c · if the D1 hold cannot be written NOTHING is (one transaction): the order stays pending, the run is not complete, the next run holds it', async () => {
      const uid = await organizer(); const o = await stale(uid, HOUR)
      const p1 = payment(o, 'captured'); payment(o, 'captured')
      failReconciliationWrite()
      const r = await enforce()
      vi.restoreAllMocks()
      expect(r).toMatchObject({ multipleCaptured: 1, held: 0, recordFailed: 1, complete: false })
      expect((await topupDoc(o)).status).toBe('pending')
      expect(await recon(`dup_${p1}`)).toBeUndefined()
      expect(await balance(uid)).toBe(0)
      expect((await enforce()).held).toBe(1)
      expect((await topupDoc(o)).status).toBe('needs_review')
    }, T)

    // ── cron route ──────────────────────────────────────────────────────────────────────────────
    it('W2.c · cron: authenticated; the retry THEN the sweep; report by default; both results returned', async () => {
      const { GET } = await import('@/app/api/cron/wallet-reconciliation/route')
      const req = (auth?: string) => new NextRequest('http://localhost/api/cron/wallet-reconciliation', { headers: auth ? { authorization: auth } : {} })
      expect((await GET(req())).status).toBe(401)
      const uid = await organizer(); const o = await stale(uid, HOUR); payment(o, 'captured')
      const res = await json(await GET(req('Bearer w2c-cron')))
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ scanned: expect.any(Number), legacyNormalized: expect.any(Number) })
      expect(res.body.staleSweep).toMatchObject({ mode: 'report', singleMatch: 1, credited: 0, complete: true })
      expect(await balance(uid)).toBe(0)
      process.env.WALLET_TOPUP_SWEEP_MODE = 'enforce'
      const res2 = await json(await GET(req('Bearer w2c-cron')))
      expect(res2.body.staleSweep).toMatchObject({ mode: 'enforce', credited: 1 })
      expect(await balance(uid)).toBe(50_000)
    }, T)

    // ── D6 · verify mismatch ────────────────────────────────────────────────────────────────────
    it('W2.c · D6 — verify records a captured AMOUNT or CURRENCY mismatch durably (whatever the sweep mode), idempotently, and never credits it', async () => {
      const uid = await organizer(); const o = await topup(uid); const pay = payment(o, 'captured', 1_000)
      cleanup.add(`walletTopupReconciliation/mismatch_${pay}`)
      expect((await verify(uid, o, pay)).status).toBe(400)
      const first = (await recon(`mismatch_${pay}`))!
      expect(first).toMatchObject({ orderId: o, uid, status: 'needs_review', reason: 'amount_mismatch', detectedBy: 'verify', observedAmountPaise: 1_000, expectedAmountPaise: 50_000, deliveries: 1 })
      expect((await verify(uid, o, pay)).status).toBe(400)
      await webhook(o, pay, 1_000)                                               // converges on the same record
      const after = (await recon(`mismatch_${pay}`))!
      expect(after.deliveries).toBe(3)
      expect(recMs(after.firstSeenAt)).toBe(recMs(first.firstSeenAt))
      expect((await flagsFor(pay)).filter(f => f.reason === 'amount_mismatch')).toHaveLength(1)
      expect(await balance(uid)).toBe(0)
      expect((await topupDoc(o)).status).toBe('pending')
      expect((await status(uid, o, pay)).body).toEqual({ state: 'needs_review' })

      process.env.WALLET_TOPUP_SWEEP_MODE = 'report'
      const u2 = await organizer(); const o2 = await topup(u2); const p2 = payment(o2, 'captured')
      h.payments.get(p2)!.currency = 'USD'
      cleanup.add(`walletTopupReconciliation/mismatch_${p2}`)
      expect((await verify(u2, o2, p2)).status).toBe(400)
      expect(await recon(`mismatch_${p2}`)).toMatchObject({ status: 'needs_review', reason: 'currency_mismatch', observedCurrency: 'USD', detectedBy: 'verify' })
      expect(await balance(u2)).toBe(0)
    }, T)

    it('W2.c · D6 — if verify cannot record the mismatch it answers a retryable 503; a retry records it; a matching payment still credits normally', async () => {
      const uid = await organizer(); const o = await topup(uid); const pay = payment(o, 'captured', 1_000)
      cleanup.add(`walletTopupReconciliation/mismatch_${pay}`)
      failReconciliationWrite()
      const r = await verify(uid, o, pay)
      vi.restoreAllMocks()
      expect(r.status).toBe(503)
      expect(await recon(`mismatch_${pay}`)).toBeUndefined()
      expect((await verify(uid, o, pay)).status).toBe(400)
      expect((await recon(`mismatch_${pay}`))!.status).toBe('needs_review')
      expect(await balance(uid)).toBe(0)

      const u2 = await organizer(); const o2 = await topup(u2); const good = payment(o2, 'captured')
      expect((await verify(u2, o2, good)).body).toMatchObject({ success: true, newBalance: 50_000 })
      expect(await recon(`mismatch_${good}`)).toBeUndefined()
    }, T)

    // ═══ W2.c safety fixes ══════════════════════════════════════════════════════════════════════
    const watch = async (opts: { mode?: 'report' | 'enforce'; deadlineAtMs?: number; skip?: string } = {}) =>
      (await import('@/lib/wallet/topupReconciliation')).watchAbandonedWalletTopups(opts)
    /** An order the sweep abandoned `agoMs` ago (created 7 days before that). */
    async function abandonedOrder(uid: string, agoMs: number | null, extra: Record<string, unknown> = {}) {
      return stale(uid, (agoMs ?? 0) + 8 * DAY, {
        status: 'abandoned',
        ...(agoMs === null ? {} : { abandonedAt: Timestamp.fromMillis(Date.now() - agoMs) }),
        ...extra,
      })
    }
    function rawPayment(orderId: string, raw: Record<string, unknown>) {
      const id = `pay_w2c_raw_${P}_${++n}`
      h.payments.set(id, { id, amount: 50_000, currency: 'INR', order_id: orderId, ...raw } as never)
      cleanup.add(`walletTopupReconciliation/mismatch_${id}`)
      return id
    }
    const sentryScopes = (scope: string) => h.sentry.filter(e => e.scope === scope).length

    // ── Fix 1 ──
    it('FIX 1 · an unknown or MISSING raw status (read as "failed" by the adapter) is never abandoned; only raw created / failed / refunded is', async () => {
      const uid = await organizer()
      const mystery = await stale(uid, 8 * DAY); rawPayment(mystery, { status: 'mystery' })
      const missing = await stale(uid, 8 * DAY); rawPayment(missing, { status: undefined })
      const rawCaptured = await stale(uid, 8 * DAY); const rc = rawPayment(rawCaptured, { status: 'failed' })
      h.rawOrderOverride.set(rawCaptured, { items: [{ id: rc, order_id: rawCaptured, status: 'captured', amount: 50_000, currency: 'INR' }] })
      const rawAuthorized = await stale(uid, 8 * DAY); const ra = rawPayment(rawAuthorized, { status: 'failed' })
      h.rawOrderOverride.set(rawAuthorized, { items: [{ id: ra, order_id: rawAuthorized, status: 'authorized', amount: 50_000, currency: 'INR' }] })
      const noCurrency = await stale(uid, 8 * DAY); rawPayment(noCurrency, { status: 'failed', currency: undefined })
      const disagree = await stale(uid, 8 * DAY); rawPayment(disagree, { status: 'failed' })
      h.rawOrderOverride.set(disagree, { items: [] })
      const lookupFails = await stale(uid, 8 * DAY); rawPayment(lookupFails, { status: 'failed' })
      h.rawOrderFails.add(lookupFails)
      const created = await stale(uid, 8 * DAY); rawPayment(created, { status: 'created' })
      const failed = await stale(uid, 8 * DAY); rawPayment(failed, { status: 'failed' })
      const refunded = await stale(uid, 8 * DAY); rawPayment(refunded, { status: 'refunded' })
      const none = await stale(uid, 8 * DAY)
      const blocked = [mystery, missing, rawCaptured, rawAuthorized, noCurrency, disagree, lookupFails]
      const provable = [created, failed, refunded, none]

      const rep = await sweep()
      expect(rep).toMatchObject({ mode: 'report', unpaidAbandonable: 4, abandonBlocked: 7, abandoned: 0 })
      expect(rep.uncertain).toBe(7)

      const enf = await enforce()
      expect(enf).toMatchObject({ unpaidAbandonable: 4, abandonBlocked: 7, abandoned: 4, credited: 0 })
      for (const o of blocked) expect((await topupDoc(o)).status).toBe('pending')
      for (const o of provable) expect((await topupDoc(o)).status).toBe('abandoned')
      expect(await balance(uid)).toBe(0)
      for (const o of blocked) expect(await recon(o)).toBeUndefined()           // uncertain: no review record either
      expect(sentryScopes('walletTopupSweep.raw_lookup_failed')).toBe(2)        // report + enforce
    }, T)

    it('FIX 1 · the raw lookup counts against the 50-call budget (≤ 2 calls per order, never more)', async () => {
      const uid = await organizer()
      for (let k = 0; k < 30; k++) { const o = await stale(uid, 8 * DAY); rawPayment(o, { status: 'failed' }) }
      const r = await sweep()
      expect(r.gatewayCalls).toBeLessThanOrEqual(50)
      expect(r.checked * 2).toBe(r.gatewayCalls)                                // lookup + raw proof, each
      expect(r.deferredForNextRun).toBe(30 - r.checked)
    }, T)

    // ── Fix 2 ──
    it('FIX 2 · watch: late captured / authorised / unknown / mismatched payments on abandoned orders — report writes nothing; enforce records review, never credits; outside 30 days is skipped', async () => {
      const uid = await organizer()
      const oCap = await abandonedOrder(uid, 2 * DAY); const pCap = payment(oCap, 'captured')
      const oAuth = await abandonedOrder(uid, 2 * DAY); const pAuth = payment(oAuth, 'authorized')
      const oUnk = await abandonedOrder(uid, 2 * DAY); const pUnk = rawPayment(oUnk, { status: 'mystery' })
      const oMis = await abandonedOrder(uid, 2 * DAY); const pMis = payment(oMis, 'captured', 1_000)
      cleanup.add(`walletTopupReconciliation/mismatch_${pMis}`)
      const oClean = await abandonedOrder(uid, 2 * DAY); payment(oClean, 'failed')
      const oOld = await abandonedOrder(uid, 40 * DAY); payment(oOld, 'captured')
      const oNoTs = await abandonedOrder(uid, null); payment(oNoTs, 'captured')
      const all = [oCap, oAuth, oUnk, oMis, oClean, oOld, oNoTs]
      const snap = async () => JSON.stringify(await Promise.all(all.map(async o => [await topupDoc(o), (await recon(o)) ?? null])).then(x => [x, null]))

      const before = await snap()
      const rep = await watch()
      expect(rep).toMatchObject({
        mode: 'report', scanned: 7, outsideWindow: 1, missingAbandonedAt: 1, checked: 5,
        lateCaptured: 1, lateAuthorized: 1, unknownStatus: 1, mismatched: 1, reviewsRecorded: 0, mismatchesRecorded: 0, gatewayCalls: 5,
      })
      expect(await snap()).toBe(before)                                          // report: no writes
      expect(await recon(`mismatch_${pMis}`)).toBeUndefined()
      expect(h.rawOrderLookups).not.toContain(oOld)
      expect(h.rawOrderLookups).not.toContain(oNoTs)

      const enf = await watch({ mode: 'enforce' })
      expect(enf).toMatchObject({ reviewsRecorded: 3, mismatchesRecorded: 1, recordFailed: 0 })
      expect(await recon(oCap)).toMatchObject({ status: 'needs_review', paymentIds: [pCap] })
      expect(await recon(oAuth)).toMatchObject({ status: 'needs_review', paymentIds: [pAuth] })
      expect(await recon(oUnk)).toMatchObject({ status: 'needs_review', paymentIds: [pUnk] })
      expect(String((await recon(oUnk))!.lastError)).toContain("'mystery'")
      expect(await recon(`mismatch_${pMis}`)).toMatchObject({ status: 'needs_review', detectedBy: 'watch', observedAmountPaise: 1_000 })
      for (const o of [oClean, oOld, oNoTs]) expect(await recon(o)).toBeUndefined()
      for (const o of all) expect((await topupDoc(o)).status).toBe('abandoned')  // never changed
      expect(await balance(uid)).toBe(0)
      expect((await createTopup(uid)).body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'needs_review' })

      // repeated runs: nothing new — no rewrite, firstSeenAt kept, no second mismatch delivery
      const seen = recMs((await recon(oCap))!.firstSeenAt)
      const again = await watch({ mode: 'enforce' })
      expect(again).toMatchObject({ reviewsRecorded: 0, mismatchesRecorded: 0, alreadyRecorded: 4 })
      expect(recMs((await recon(oCap))!.firstSeenAt)).toBe(seen)
      expect((await recon(`mismatch_${pMis}`))!.deliveries).toBe(1)
      // a NEW late payment on an already-recorded order is added, the first is kept
      const pCap2 = payment(oCap, 'captured')
      expect((await watch({ mode: 'enforce' })).reviewsRecorded).toBe(1)
      expect((await recon(oCap))!.paymentIds).toEqual([pCap, pCap2])
      expect(await balance(uid)).toBe(0)
    }, T)

    it('FIX 2 · watch vs webhook vs verify racing on one late payment: one review record, every payment kept, no credit', async () => {
      const uid = await organizer(); const o = await abandonedOrder(uid, DAY); const late = payment(o, 'captured')
      h.gatewayDelayMs = 5
      await Promise.all([watch({ mode: 'enforce' }), watch({ mode: 'enforce' }), webhook(o, late), verify(uid, o, late)])
      expect(await recon(o)).toMatchObject({ status: 'needs_review', paymentIds: [late] })
      expect(await balance(uid)).toBe(0)
      expect(await ledgerExists(o)).toBe(false)
      expect((await topupDoc(o)).status).toBe('abandoned')
    }, T)

    it('FIX 2 · watch budget ≤ 10 calls, own cursor (independent of the sweep), wraps; circuit on 3 failures; skipped when told', async () => {
      const uid = await organizer()
      const os: string[] = []
      for (let k = 0; k < 13; k++) os.push(await abandonedOrder(uid, DAY))
      const pend = await stale(uid, HOUR)                                        // a pending order: the sweep's, not the watch's
      const r1 = await watch()
      expect(r1).toMatchObject({ gatewayCalls: 10, checked: 10, deferredForNextRun: 3, wrapped: false })
      expect((await adminDb.doc(CURSOR).get()).exists).toBe(false)               // the sweep's cursor is untouched
      const r2 = await watch()
      expect(r2).toMatchObject({ gatewayCalls: 3, wrapped: true })
      expect(new Set(h.rawOrderLookups)).toEqual(new Set(os))
      expect(h.rawOrderLookups).not.toContain(pend)

      h.rawOrderLookups = []
      h.orderFetchFails = true
      const r3 = await watch()
      expect(r3).toMatchObject({ circuitOpen: true, gatewayCalls: 3, complete: false })
      h.orderFetchFails = false
      h.rawOrderLookups = []
      await watch()
      expect(h.rawOrderLookups[0]).toBe(os[0])                                   // the failed ones are looked at again

      expect(await watch({ skip: 'gateway_circuit_open' })).toMatchObject({ skipped: 'gateway_circuit_open', gatewayCalls: 0, scanned: 0 })
    }, T)

    it('FIX 2 · cron: the watch runs AFTER the sweep with its own budget, and is skipped when the sweep\'s gateway circuit opened', async () => {
      const { GET } = await import('@/app/api/cron/wallet-reconciliation/route')
      const req = () => new NextRequest('http://localhost/api/cron/wallet-reconciliation', { headers: { authorization: 'Bearer w2c-cron' } })
      const uid = await organizer()
      for (let k = 0; k < 12; k++) await abandonedOrder(uid, DAY)
      for (let k = 0; k < 3; k++) await stale(uid, HOUR)
      const ok = await json(await GET(req()))
      expect(ok.status).toBe(200)
      expect(ok.body.staleSweep).toMatchObject({ checked: 3, gatewayCalls: 3 })
      expect(ok.body.abandonedWatch).toMatchObject({ mode: 'report', skipped: null, gatewayCalls: 10 })

      h.orderFetchFails = true
      const down = await json(await GET(req()))
      expect(down.body.staleSweep).toMatchObject({ circuitOpen: true })
      expect(down.body.abandonedWatch).toMatchObject({ skipped: 'gateway_circuit_open', gatewayCalls: 0 })
    }, T)

    // ── Fix 3 ──
    it('FIX 3 · a mismatch / multiple-capture alert fires once, not every pass; a NEW payment id alerts again', async () => {
      const uid = await organizer()
      const o1 = await stale(uid, HOUR); payment(o1, 'captured', 1_000)
      const o2 = await stale(uid, HOUR); payment(o2, 'captured'); payment(o2, 'captured')
      await sweep(); await sweep(); await sweep()
      expect(sentryScopes('walletTopupSweep.mismatch')).toBe(1)
      expect(sentryScopes('walletTopupSweep.multiple_captured')).toBe(1)

      payment(o1, 'captured', 2_000)                                             // a new mismatched payment
      payment(o2, 'captured')                                                    // a third capture: changed set
      await sweep(); await sweep()
      expect(sentryScopes('walletTopupSweep.mismatch')).toBe(2)
      expect(sentryScopes('walletTopupSweep.multiple_captured')).toBe(2)

      // enforce: the durable records are still written (source of truth), and still no repeat alert
      await enforce()
      expect(sentryScopes('walletTopupSweep.mismatch')).toBe(2)
      expect((await topupDoc(o2)).status).toBe('needs_review')
    }, T)

    // ── Fix 4 ──
    it('FIX 4 · verify: a recorded mismatch says NEEDS_REVIEW (400); an unrecorded one REVIEW_UNRECORDED (503) — the wizard shows review, never "credited automatically"', async () => {
      const { classifyTopupVerifyResponse } = await import('@/lib/wallet/topupVerifyOutcome')
      const uid = await organizer(); const o = await topup(uid); const pay = payment(o, 'captured', 1_000)
      cleanup.add(`walletTopupReconciliation/mismatch_${pay}`)
      failReconciliationWrite()
      const unrecorded = await verify(uid, o, pay)
      vi.restoreAllMocks()
      expect(unrecorded).toMatchObject({ status: 503, body: { success: false, code: 'REVIEW_UNRECORDED' } })
      const u = classifyTopupVerifyResponse(unrecorded.status, unrecorded.body)
      expect(u.kind).toBe('review')
      expect(u.kind === 'review' && u.message).not.toMatch(/credited automatically|will be credited/i)

      const recorded = await verify(uid, o, pay)
      expect(recorded).toMatchObject({ status: 400, body: { success: false, code: 'NEEDS_REVIEW' } })
      expect(classifyTopupVerifyResponse(recorded.status, recorded.body).kind).toBe('review')
      expect(await balance(uid)).toBe(0)
    }, T)

    // ── admin list filter ──
    it('ADMIN · a status filter finds OLDER needs_review / abandoned orders behind newer rows; the cursor resumes without skipping; no filter is unchanged', async () => {
      const { GET } = await import('@/app/api/admin/wallet-topups/route')
      const list = async (qs: Record<string, string>) => json(await GET(new NextRequest(
        `http://localhost/api/admin/wallet-topups?${new URLSearchParams(qs)}`, { headers: { authorization: 'Bearer w2c-admin' } })))
      expect((await GET(new NextRequest('http://localhost/api/admin/wallet-topups'))).status).toBe(403)   // no admin token
      const uid = await organizer()
      const old: string[] = []
      for (let k = 0; k < 3; k++) old.push(await stale(uid, 400 * DAY + k * MIN, { status: 'abandoned', abandonedAt: Timestamp.fromMillis(Date.now() - 390 * DAY) }))
      for (let k = 0; k < 40; k++) await stale(uid, k * MIN, { status: 'credited', paymentId: `pay_w2c_admin_${k}` })

      const p1 = await list({ status: 'abandoned', pageSize: '2' })
      expect(p1.status).toBe(200)
      const i1 = p1.body.items as Array<{ orderId: string; status: string }>
      expect(i1.map(i => i.status)).toEqual(['abandoned', 'abandoned'])
      expect(p1.body.nextCursor).toBeTruthy()
      const p2 = await list({ status: 'abandoned', pageSize: '2', cursor: String(p1.body.nextCursor) })
      const i2 = p2.body.items as Array<{ orderId: string }>
      expect([...i1, ...i2].map(i => i.orderId).sort()).toEqual([...old].sort())
      expect(p2.body.nextCursor).toBeNull()

      const plain = await list({ pageSize: '25' })
      expect((plain.body.items as unknown[]).length).toBe(25)
      expect(plain.body.nextCursor).toBeTruthy()
    }, T)

    // ═══ Raw-status credit guard (one capture must not hide another payment) ═══════════════════
    it('RAW · one capture + another payment whose RAW status is unknown / missing: never credited — report shows it, enforce holds it for review with every payment id', async () => {
      const uid = await organizer()
      const oUnk = await stale(uid, HOUR); const c1 = payment(oUnk, 'captured'); const u1 = rawPayment(oUnk, { status: 'mystery' })
      const oMiss = await stale(uid, HOUR); const c2 = payment(oMiss, 'captured'); const m2 = rawPayment(oMiss, { status: undefined })

      const rep = await sweep()
      expect(rep).toMatchObject({ mode: 'report', singleMatch: 2, creditBlocked: 2, credited: 0, reviewsRecorded: 0, gatewayCalls: 4 })
      expect(await recon(oUnk)).toBeUndefined()                                  // report: no record
      expect(sentryScopes('walletTopupSweep.credit_blocked')).toBe(2)

      const enf = await enforce()
      expect(enf).toMatchObject({ singleMatch: 2, creditBlocked: 2, reviewsRecorded: 2, credited: 0, abandoned: 0, recordFailed: 0 })
      const r1 = (await recon(oUnk))!
      expect(r1).toMatchObject({ status: 'needs_review', paymentId: c1 })
      expect([...(r1.paymentIds as string[])].sort()).toEqual([c1, u1].sort())
      expect(String(r1.lastError)).toContain('raw_status_unknown')
      const r2 = (await recon(oMiss))!
      expect([...(r2.paymentIds as string[])].sort()).toEqual([c2, m2].sort())
      expect(String(r2.lastError)).toContain('raw_status_missing')
      expect(r1.nextAttemptAt).toBeUndefined()                                   // never a transient retry
      for (const o of [oUnk, oMiss]) expect((await topupDoc(o)).status).toBe('pending')   // not abandoned, not credited
      expect(await balance(uid)).toBe(0)
      expect(sentryScopes('walletTopupSweep.credit_blocked')).toBe(2)            // no repeat alert
      expect((await createTopup(uid)).body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'needs_review' })

      // the order now belongs to its review record: later sweeps do not re-check or re-write it
      const again = await enforce()
      expect(again).toMatchObject({ skippedOpenReconciliation: 2, gatewayCalls: 0, reviewsRecorded: 0 })
      expect(recMs((await recon(oUnk))!.firstSeenAt)).toBe(recMs(r1.firstSeenAt))

      // HOLD — a webhook for the captured payment on the held order is refused, not credited, across
      // redeliveries; the review record (with both payments) is kept, never downgraded
      expect((await webhook(oUnk, c1)).status).toBe(200)
      expect((await webhook(oUnk, c1)).status).toBe(200)
      expect(await balance(uid)).toBe(0)
      expect(await ledgerExists(oUnk)).toBe(false)
      expect((await recon(oUnk))!.status).toBe('needs_review')
      expect([...((await recon(oUnk))!.paymentIds as string[])].sort()).toEqual([c1, u1].sort())
    }, T)

    it('RAW · a second matching capture seen only raw, a malformed response and an incomplete one: never credited, each held for review', async () => {
      const uid = await organizer()
      const oMulti = await stale(uid, HOUR); const a1 = payment(oMulti, 'captured'); const a2 = payment(oMulti, 'failed')
      h.rawOrderOverride.set(oMulti, { items: [
        { id: a1, order_id: oMulti, status: 'captured', amount: 50_000, currency: 'INR' },
        { id: a2, order_id: oMulti, status: 'captured', amount: 50_000, currency: 'INR' },
      ] })
      const oMal = await stale(uid, HOUR); payment(oMal, 'captured')
      h.rawOrderOverride.set(oMal, { items: 'not-a-list' })
      const oInc = await stale(uid, HOUR); const i1 = payment(oInc, 'captured'); payment(oInc, 'failed')
      h.rawOrderOverride.set(oInc, { items: [{ id: i1, order_id: oInc, status: 'captured', amount: 50_000, currency: 'INR' }] })

      const r = await enforce()
      expect(r).toMatchObject({ singleMatch: 3, creditBlocked: 3, reviewsRecorded: 3, credited: 0 })
      expect(String((await recon(oMulti))!.lastError)).toContain('raw_multiple_captured')
      expect([...((await recon(oMulti))!.paymentIds as string[])].sort()).toEqual([a1, a2].sort())
      expect(String((await recon(oMal))!.lastError)).toContain('raw_response_malformed')
      expect(String((await recon(oInc))!.lastError)).toContain('raw_adapter_disagree')
      for (const o of [oMulti, oMal, oInc]) expect((await topupDoc(o)).status).toBe('pending')
      expect(await balance(uid)).toBe(0)
    }, T)

    it('RAW · a failed raw lookup while a payment is captured: uncertain — no credit, no record, cursor kept; 3 in a row open the circuit; the next run credits', async () => {
      const uid = await organizer()
      const os: string[] = []
      for (let k = 0; k < 3; k++) { const o = await stale(uid, HOUR); payment(o, 'captured'); h.rawOrderFails.add(o); os.push(o) }
      const r = await enforce()
      expect(r).toMatchObject({ circuitOpen: true, credited: 0, reviewsRecorded: 0, complete: false, gatewayCalls: 6 })
      expect(r.uncertain).toBe(3)
      for (const o of os) { expect((await topupDoc(o)).status).toBe('pending'); expect(await recon(o)).toBeUndefined() }
      expect((await adminDb.doc(CURSOR).get()).exists).toBe(false)
      expect(await balance(uid)).toBe(0)

      h.rawOrderFails.clear()
      const next = await enforce()
      expect(next).toMatchObject({ credited: 3, circuitOpen: false })
      expect(next.gatewayCalls).toBeLessThanOrEqual(6)
      expect(await balance(uid)).toBe(150_000)
    }, T)

    it('RAW · if the review record cannot be written the order is NOT credited and NOT marked safe; the next run records it', async () => {
      const uid = await organizer(); const o = await stale(uid, HOUR); const c = payment(o, 'captured'); rawPayment(o, { status: 'mystery' })
      failReconciliationWrite()
      const r = await enforce()
      vi.restoreAllMocks()
      expect(r).toMatchObject({ creditBlocked: 1, reviewsRecorded: 0, recordFailed: 1, credited: 0, complete: false })
      expect(await recon(o)).toBeUndefined()
      expect((await topupDoc(o)).status).toBe('pending')
      expect(await balance(uid)).toBe(0)
      expect((await enforce()).reviewsRecorded).toBe(1)
      expect(await recon(o)).toMatchObject({ status: 'needs_review', paymentId: c })
      expect(await balance(uid)).toBe(0)
    }, T)

    it('RAW · a valid single capture (with failed / authorised others) still credits exactly once; repeated sweeps and webhook redeliveries do not credit again', async () => {
      const uid = await organizer(); const o = await stale(uid, HOUR)
      const c = payment(o, 'captured'); payment(o, 'failed'); payment(o, 'authorized', 50_000)
      const r = await enforce()
      expect(r).toMatchObject({ credited: 1, creditBlocked: 0, gatewayCalls: 2 })
      expect(await topupDoc(o)).toMatchObject({ status: 'credited', paymentId: c })
      await enforce()
      expect((await webhook(o, c)).status).toBe(200)
      expect((await webhook(o, c)).status).toBe(200)
      await cron()
      expect(await balance(uid)).toBe(50_000)
      expect((await adminDb.collection('walletTransactions').where('orderId', '==', o).get()).size).toBe(1)
    }, T)

    // ═══ Order-level review hold, enforced on EVERY credit path ═══════════════════════════════════
    const hold = (orderId: string, uid: string, extra: Record<string, unknown> = {}) =>
      put(`walletTopupReconciliation/${orderId}`, {
        orderId, uid, amountPaise: 50_000, paymentId: 'pay_held_first', paymentIds: ['pay_held_first'],
        status: 'needs_review', attempts: 1, firstSeenAt: Timestamp.fromMillis(1_000_000), lastError: 'held for review', ...extra,
      })

    it('HOLD · webhook: a captured payment on a held order is NOT credited; acknowledged only once its id is kept on the hold; redeliveries never credit', async () => {
      const uid = await organizer(); const o = await topup(uid); await hold(o, uid); const p = payment(o, 'captured')
      for (let k = 0; k < 3; k++) expect((await webhook(o, p)).status).toBe(200)
      expect(await balance(uid)).toBe(0)
      expect(await ledgerExists(o)).toBe(false)
      expect((await topupDoc(o)).status).toBe('pending')
      const r = (await recon(o))!
      expect(r).toMatchObject({ status: 'needs_review', attempts: 1, paymentIds: ['pay_held_first', p] })
      expect(recMs(r.firstSeenAt)).toBe(1_000_000)
      expect(String(r.lastError)).toContain('TOPUP_REVIEW_HOLD')

      // evidence that cannot be kept is NOT acknowledged — Razorpay redelivers
      const p2 = payment(o, 'captured')
      failReconciliationWrite()
      const w = await webhook(o, p2)
      vi.restoreAllMocks()
      expect(w.status).toBe(500)
      expect((await webhook(o, p2)).status).toBe(200)
      expect((await recon(o))!.paymentIds).toEqual(['pay_held_first', p, p2])
      expect(await balance(uid)).toBe(0)
    }, T)

    it('HOLD · verify: a truthful review outcome (409 NEEDS_REVIEW — never "pay again", never "credited"), the payment is kept, nothing credited', async () => {
      const { classifyTopupVerifyResponse, TOPUP_OUTCOME_MESSAGES } = await import('@/lib/wallet/topupVerifyOutcome')
      const uid = await organizer(); const o = await topup(uid); await hold(o, uid); const p = payment(o, 'captured')
      const v = await verify(uid, o, p)
      expect(v).toMatchObject({ status: 409, body: { success: false, code: 'NEEDS_REVIEW' } })
      expect(classifyTopupVerifyResponse(v.status, v.body)).toEqual({ kind: 'review', message: TOPUP_OUTCOME_MESSAGES.review })
      expect(TOPUP_OUTCOME_MESSAGES.review).toMatch(/do not pay again/i)
      expect(TOPUP_OUTCOME_MESSAGES.review).not.toMatch(/credited automatically|will be credited/i)
      expect((await verify(uid, o, p)).status).toBe(409)
      expect(await balance(uid)).toBe(0)
      expect((await recon(o))!.paymentIds).toEqual(['pay_held_first', p])
      expect((await status(uid, o, p)).body).toEqual({ state: 'needs_review' })
    }, T)

    it('HOLD · retry cron: a held record is never replayed, rescheduled or counted — even with an old due date', async () => {
      const uid = await organizer(); const o = await topup(uid); const p = payment(o, 'captured')
      await hold(o, uid, { paymentId: p, paymentIds: [p], attempts: 3, nextAttemptAt: Timestamp.fromMillis(Date.now() - HOUR) })
      const before = JSON.stringify(await recon(o))
      const fetches = h.paymentFetches
      await cron(); await cron()
      expect(JSON.stringify(await recon(o))).toBe(before)
      expect(h.paymentFetches).toBe(fetches)
      expect(await balance(uid)).toBe(0)
    }, T)

    it('HOLD · sweep: a held pending order is skipped in both modes — no gateway call, no credit, the record untouched', async () => {
      const uid = await organizer(); const o = await stale(uid, HOUR); payment(o, 'captured'); await hold(o, uid)
      const before = JSON.stringify(await recon(o))
      expect(await sweep()).toMatchObject({ skippedOpenReconciliation: 1, gatewayCalls: 0, credited: 0 })
      expect(await enforce()).toMatchObject({ skippedOpenReconciliation: 1, gatewayCalls: 0, credited: 0 })
      expect(JSON.stringify(await recon(o))).toBe(before)
      expect(await balance(uid)).toBe(0)
    }, T)

    it('HOLD · resolved, pending (the retry\'s own schedule) and skipped records are NOT holds — a captured payment still credits once; unrelated orders credit normally', async () => {
      const uid = await organizer()
      const oRes = await topup(uid); await hold(oRes, uid, { status: 'resolved', resolvedAt: Timestamp.now() })
      const pRes = payment(oRes, 'captured')
      expect((await webhook(oRes, pRes)).status).toBe(200)
      expect(await balance(uid)).toBe(50_000)

      const oSkip = await topup(uid); await hold(oSkip, uid, { status: 'skipped' })
      const pSkip = payment(oSkip, 'captured')
      expect((await webhook(oSkip, pSkip)).status).toBe(200)
      expect(await balance(uid)).toBe(100_000)

      const oPend = await topup(uid); const pPend = payment(oPend, 'captured')
      await hold(oPend, uid, { status: 'pending', paymentId: pPend, paymentIds: [pPend], nextAttemptAt: Timestamp.fromMillis(Date.now() + HOUR) })
      expect((await verify(uid, oPend, pPend)).body).toMatchObject({ success: true, newBalance: 150_000 })
      expect((await verify(uid, oPend, pPend)).body).toMatchObject({ success: true, newBalance: 150_000 })   // idempotent replay
      expect((await webhook(oPend, pPend)).status).toBe(200)
      expect(await balance(uid)).toBe(150_000)

      const u2 = await organizer()
      const held = await topup(u2); await hold(held, u2)
      const free = await topup(u2); const pFree = payment(free, 'captured')
      expect((await verify(u2, free, pFree)).body).toMatchObject({ success: true, newBalance: 50_000 })
    }, T)

    it('HOLD · if the hold cannot be READ the credit fails safe — no credit, webhook 500 (redelivered), verify never claims success — and recovers once reads work', async () => {
      const uid = await organizer()
      const oHeld = await topup(uid); await hold(oHeld, uid); const pH = payment(oHeld, 'captured')
      const oFree = await topup(uid); const pF = payment(oFree, 'captured')
      failReconciliationRead()
      const w1 = await webhook(oHeld, pH)
      const w2 = await webhook(oFree, pF)
      const v = await verify(uid, oFree, pF)
      vi.restoreAllMocks()
      expect(w1.status).toBe(500)
      expect(w2.status).toBe(500)
      expect(v.body.success).not.toBe(true)
      expect(await balance(uid)).toBe(0)

      expect((await webhook(oHeld, pH)).status).toBe(200)                       // redelivery: held, not credited
      expect((await webhook(oFree, pF)).status).toBe(200)                        // redelivery: credited once
      expect(await balance(uid)).toBe(50_000)
      expect((await topupDoc(oHeld)).status).toBe('pending')
      expect((await recon(oHeld))!.paymentIds).toEqual(['pay_held_first', pH])
    }, T)

    // ═══ Final hold consistency: exhausted, messaging, flag de-duplication ═════════════════════════
    const refusalFlags = async (paymentId: string) => (await flagsFor(paymentId)).filter(f => String(f.reason).startsWith('credit_refused:'))

    it('EXHAUSTED · an unresolved exhausted record holds the order: webhook (redelivered) and verify never credit; the retry never replays it; evidence kept, never downgraded', async () => {
      const uid = await organizer(); const o = await topup(uid)
      await hold(o, uid, { status: 'exhausted', attempts: 12, exhaustedAt: Timestamp.now() })
      const p = payment(o, 'captured')
      for (let k = 0; k < 3; k++) expect((await webhook(o, p)).status).toBe(200)
      const v = await verify(uid, o, p)
      expect(v).toMatchObject({ status: 409, body: { code: 'NEEDS_REVIEW' } })
      await cron(); await cron()
      const r = (await recon(o))!
      expect(r).toMatchObject({ status: 'exhausted', attempts: 12, paymentIds: ['pay_held_first', p] })
      expect(recMs(r.firstSeenAt)).toBe(1_000_000)
      expect(r.nextAttemptAt).toBeUndefined()
      expect(await balance(uid)).toBe(0)
      expect(await ledgerExists(o)).toBe(false)
      expect((await status(uid, o, p)).body).toEqual({ state: 'needs_review' })
      expect((await createTopup(uid)).body).toMatchObject({ code: 'TOPUP_UNRESOLVED', reason: 'retry_exhausted' })
      expect(await refusalFlags(p)).toHaveLength(1)                              // 3 deliveries + verify: one flag
    }, T)

    it('FLAGS · repeated deliveries on a held order add no duplicate refusal flag; a NEW payment or a DIFFERENT reason still flags; ids, attempts and firstSeenAt kept', async () => {
      const uid = await organizer(); const o = await topup(uid); await hold(o, uid)
      const p = payment(o, 'captured')
      for (let k = 0; k < 4; k++) expect((await webhook(o, p)).status).toBe(200)
      expect(await refusalFlags(p)).toHaveLength(1)
      const p2 = payment(o, 'captured')
      await webhook(o, p2); await webhook(o, p2)
      expect(await refusalFlags(p2)).toHaveLength(1)
      // a different refusal for the SAME payment is new evidence (here: the order is no longer pending)
      await adminDb.doc(`walletTopups/${o}`).update({ status: 'abandoned' })
      await webhook(o, p)
      const reasons = (await refusalFlags(p)).map(f => f.reason).sort()
      expect(reasons).toEqual(['credit_refused:TOPUP_NOT_CREDITABLE', 'credit_refused:TOPUP_REVIEW_HOLD'])
      const r = (await recon(o))!
      expect(r).toMatchObject({ status: 'needs_review', attempts: 1, paymentIds: ['pay_held_first', p, p2] })
      expect(recMs(r.firstSeenAt)).toBe(1_000_000)
      expect([...(r.refusalKeys as string[])].sort()).toEqual([`TOPUP_NOT_CREDITABLE:${p}`, `TOPUP_REVIEW_HOLD:${p}`, `TOPUP_REVIEW_HOLD:${p2}`].sort())
      expect(await balance(uid)).toBe(0)
    }, T)

    it('FLAGS · an evidence-write failure is never acknowledged (500 → redelivered) and the redelivery records it', async () => {
      const uid = await organizer(); const o = await topup(uid); await hold(o, uid)
      const p = payment(o, 'captured')
      failReconciliationWrite()
      const w = await webhook(o, p)
      vi.restoreAllMocks()
      expect(w.status).toBe(500)
      expect((await recon(o))!.paymentIds).toEqual(['pay_held_first'])
      expect((await webhook(o, p)).status).toBe(200)
      expect((await recon(o))!.paymentIds).toEqual(['pay_held_first', p])
      expect((await refusalFlags(p)).length).toBeGreaterThanOrEqual(1)
      expect(await balance(uid)).toBe(0)
    }, T)

    it('VERIFY · when the hold cannot be read: never "credited automatically"; a readable HOLD answers review; an unheld order keeps the transient contract', async () => {
      const { classifyTopupVerifyResponse, TOPUP_OUTCOME_MESSAGES } = await import('@/lib/wallet/topupVerifyOutcome')
      const uid = await organizer()
      // (a) nothing can be read: 503 CREDIT_DEFERRED with a truthful text
      const oA = await topup(uid); await hold(oA, uid); const pA = payment(oA, 'captured')
      failReconciliationRead()
      const a = await verify(uid, oA, pA)
      vi.restoreAllMocks()
      inject.reconRead = false                                                   // (b) and (c) fail only ONE read
      expect(a).toMatchObject({ status: 503, body: { success: false, pending: true, code: 'CREDIT_DEFERRED' } })
      expect(String(a.body.error)).not.toMatch(/credited automatically|will be credited/i)
      expect(String(a.body.error)).toMatch(/do not pay again/i)
      const ca = classifyTopupVerifyResponse(a.status, a.body)
      expect(ca).toEqual({ kind: 'deferred', message: TOPUP_OUTCOME_MESSAGES.deferred })
      expect(TOPUP_OUTCOME_MESSAGES.deferred).not.toMatch(/credited automatically|will be credited/i)

      // (b) only the credit's hold check fails; the record IS a hold → review, not "credited shortly"
      const oB = await topup(uid); await hold(oB, uid); const pB = payment(oB, 'captured')
      failNextReconciliationReads(1)
      const b = await verify(uid, oB, pB)
      vi.restoreAllMocks()
      expect(b).toMatchObject({ status: 409, body: { success: false, code: 'NEEDS_REVIEW' } })
      expect(classifyTopupVerifyResponse(b.status, b.body).kind).toBe('review')
      expect((await recon(oB))!.status).toBe('needs_review')
      expect((await recon(oB))!.paymentIds).toEqual(['pay_held_first', pB])

      // (c) the same failure on an UNHELD order: the unchanged transient contract (202, retried)
      const oC = await topup(uid); const pC = payment(oC, 'captured')
      failNextReconciliationReads(1)
      const c = await verify(uid, oC, pC)
      vi.restoreAllMocks()
      expect(c).toMatchObject({ status: 202, body: { success: false, pending: true } })
      expect((await recon(oC))!.status).toBe('pending')
      expect(await balance(uid)).toBe(0)
      await makeDue(oC); await cron()
      expect(await balance(uid)).toBe(50_000)                                     // the retry credits it once
      expect((await verify(uid, oC, pC)).body).toMatchObject({ success: true, newBalance: 50_000 })
    }, T)
  })
})
