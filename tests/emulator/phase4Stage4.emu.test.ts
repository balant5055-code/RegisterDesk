// RD-PHASE4-S4 — Financial Controls & Audit Logging, proved against REAL Firestore through the REAL routes.
//
//   D1 Super Admin only (a legacy `admin: true` claim is refused) · D2 settlement maker-checker ·
//   D3 mandatory reasons · D4 review-hold workflow · D5 payout destination binding · D6 audit
//   integrity (atomic for database-only changes, durable-failure recording after gateway actions) ·
//   D7 financial audit readers · F1–F11.
//
// Razorpay is an in-memory stub (no request leaves the process — .env.local holds LIVE keys).
// Identity is mocked at the token boundary only (the admin resolvers / verifyCaller); everything
// else is the real code on the private emulator.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// RD-SEC-01 · two roles only. A legacy-claim caller is no longer a "plain admin": routes refuse it
// at the admin door like any non-admin (bare 403/401) or, behind requireSuperAdmin, with
// SUPER_ADMIN_REQUIRED. Either way it must be an AUTHORIZATION refusal — never a validation code
// (REASON_REQUIRED etc.), which would mean it got past the door.
const PLAIN_REFUSED: ReadonlyArray<string | undefined> = ['SUPER_ADMIN_REQUIRED', undefined]


const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const SUPER = `p4s4-super-${P}`, SUPER2 = `p4s4-super2-${P}`, PLAIN = `p4s4-plain-${P}`

const h = vi.hoisted(() => ({
  who: '' as string,
  admin: '' as string,
  refunds: new Map<string, Array<{ id: string; amount: number; status: string }>>(),
  refundCalls: 0,
  lookupPlan: [] as Array<'normal' | 'throw'>,
  supers: [] as string[], plains: [] as string[],
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_p4s4', RAZORPAY_KEY_SECRET: 'p4s4',
  razorpay: {
    payments: {
      fetchMultipleRefund: async (paymentId: string) => {
        if ((h.lookupPlan.shift() ?? 'normal') === 'throw') throw new Error('simulated Razorpay lookup failure')
        return { entity: 'collection', count: (h.refunds.get(paymentId) ?? []).length, items: h.refunds.get(paymentId) ?? [] }
      },
      refund: async (paymentId: string, o: { amount: number }) => {
        h.refundCalls++
        const r = { id: `rfnd_p4s4_${h.refundCalls}_${Math.random().toString(36).slice(2, 7)}`, amount: o.amount, status: 'processed' }
        h.refunds.set(paymentId, [...(h.refunds.get(paymentId) ?? []), r])
        return r
      },
    },
  },
}))
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.supers.includes(h.admin) ? h.admin : null),
  legacyAdminClaimOnly: async () => h.plains.includes(h.admin),
  resolveSuperAdminUid: async () => (h.supers.includes(h.admin) ? h.admin : null),
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))
vi.mock('@/lib/cron/auth', async orig => ({
  ...(await orig<typeof import('@/lib/cron/auth')>()),
  isAuthorizedCron: () => true,
}))

const req = (body?: unknown, method = 'POST') => new NextRequest('http://localhost/api/test', {
  method, headers: { 'Content-Type': 'application/json', authorization: 'Bearer t' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
const ctx = <K extends string>(k: K, v: string) => ({ params: Promise.resolve({ [k]: v } as Record<K, string>) })

describeEmu('RD-PHASE4-S4 · financial controls & audit logging on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let Transaction: typeof import('firebase-admin/firestore').Transaction
  const cleanup = new Set<string>()
  const savedAdminUids = process.env.ADMIN_UIDS

  const auditRows = async (entityId: string, action?: string) => {
    let q = adminDb.collection('adminAuditLogs').where('entityId', '==', entityId) as FirebaseFirestore.Query
    if (action) q = q.where('action', '==', action)
    return (await q.get()).docs.map(d => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
  }
  /** Fail the audit-row create INSIDE the transaction; nothing in that transaction may commit. */
  const failAuditCreate = (prefix = 'adminAuditLogs/') => {
    const real = Transaction.prototype.create
    return vi.spyOn(Transaction.prototype, 'create').mockImplementation(function (this: InstanceType<typeof Transaction>, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
      if (ref.path.startsWith(prefix)) throw new Error('injected audit failure')
      return real.call(this, ref, data)
    } as never)
  }
  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); cleanup.add(path) }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    h.supers = [SUPER, SUPER2]; h.plains = [PLAIN]
    process.env.ADMIN_UIDS = `${SUPER},${SUPER2}`
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Timestamp, Transaction } = await import('firebase-admin/firestore'))
  }, T)
  afterAll(async () => {
    process.env.ADMIN_UIDS = savedAdminUids
    for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null)
  }, T)
  beforeEach(() => { h.who = ''; h.admin = ''; h.refunds.clear(); h.refundCalls = 0; h.lookupPlan = [] })
  afterEach(() => { vi.restoreAllMocks() })

  // ─── fixtures ───────────────────────────────────────────────────────────────
  const PROFILE_MS = Date.parse('2026-09-01T10:00:00.000Z')
  async function organizer(tag: string, walletAvailable = 100_000) {
    const uid = `p4s4-org-${tag}-${P}`
    await put(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })
    await put(`organizerRevenueWallets/${uid}`, { organizerUid: uid, availablePaise: walletAvailable, pendingPaise: 0, settledPaise: 0, inTransitPaise: 0 })
    // Legacy PLAINTEXT payout fields are accepted by decryptPii — enough to prove masking.
    await put(`organizerPayoutProfiles/${uid}`, {
      uid, accountHolderName: 'Test Holder', payoutMethod: 'bank', bankName: 'HDFC Bank',
      accountNumber: '123456789012', ifscCode: 'HDFC0001234', upiId: null, panNumber: 'ABCDE1234F', gstNumber: null,
      isVerified: true, verifiedAt: Timestamp.fromMillis(PROFILE_MS + 1000), verifiedBy: SUPER, verifiedVersion: PROFILE_MS,
      rejectionNote: null, createdAt: Timestamp.fromMillis(PROFILE_MS), updatedAt: Timestamp.fromMillis(PROFILE_MS + 1000),
    })
    return uid
  }
  const requestSettlement = async (org: string, amountPaise: number) => {
    const { POST } = await import('@/app/api/organizer/settlements/route')
    h.who = org
    const r = await json(await POST(req({ amountPaise })))
    h.who = ''
    if (r.status === 201) cleanup.add(`settlementRequests/${r.body.id as string}`)
    return r
  }
  const settle = async (id: string, body: Record<string, unknown>) => {
    const { PATCH } = await import('@/app/api/admin/settlements/[id]/route')
    return json(await PATCH(req(body, 'PATCH'), ctx('id', id)))
  }
  const walletOf = async (uid: string) => (await adminDb.doc(`organizerRevenueWallets/${uid}`).get()).data()!

  // ═══ Settlements — D1 / D2 / D3 / D5 / F1 ════════════════════════════════════════════════
  it('SET · the request snapshots the VERIFIED destination (masked) and is audited with the organizer as actor', async () => {
    const org = await organizer('snap')
    const r = await requestSettlement(org, 10_000)
    expect(r.status).toBe(201)
    const s = (await adminDb.doc(`settlementRequests/${r.body.id as string}`).get()).data()!
    expect(s.payoutDestination).toMatchObject({ verifiedVersion: PROFILE_MS, verifiedBy: SUPER, method: 'bank' })
    expect(JSON.stringify(s.payoutDestination)).not.toContain('123456789012')
    const rows = await auditRows(r.body.id as string, 'settlement.requested')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ adminUid: org, actorRole: 'organizer' })
  }, T)

  it('SET · legacy admin claim and missing/short reasons are refused; nothing changes', async () => {
    const org = await organizer('auth')
    const id = (await requestSettlement(org, 5_000)).body.id as string
    h.admin = PLAIN
    const a = await settle(id, { action: 'approve', reason: 'plain admin tries' })
    expect(a.status).toBe(403); expect(PLAIN_REFUSED).toContain(a.body.code)
    h.admin = SUPER
    expect((await settle(id, { action: 'approve' })).body.code).toBe('REASON_REQUIRED')
    expect((await settle(id, { action: 'approve', reason: 'ok' })).body.code).toBe('REASON_TOO_SHORT')
    expect((await settle(id, { action: 'approve', reason: 'x'.repeat(501) })).body.code).toBe('REASON_TOO_LONG')
    expect((await adminDb.doc(`settlementRequests/${id}`).get()).data()!.status).toBe('pending')
    expect(await auditRows(id, 'settlement.approved')).toHaveLength(0)
  }, T)

  it('SET · F1 approve with NO adminNote persists its audit row (actor, role, reason, before/after); D2 the approver cannot mark it paid; a DIFFERENT Super Admin can', async () => {
    const org = await organizer('mc')
    const id = (await requestSettlement(org, 20_000)).body.id as string
    h.admin = SUPER
    const ap = await settle(id, { action: 'approve', reason: 'documents checked' })
    expect(ap.status).toBe(200)
    expect((await adminDb.doc(`settlementRequests/${id}`).get()).data()).toMatchObject({ status: 'approved', approvedBy: SUPER })
    const [row] = await auditRows(id, 'settlement.approved')
    expect(row).toMatchObject({ adminUid: SUPER, actorRole: 'super_admin', reason: 'documents checked', before: { status: 'pending' }, after: { status: 'approved', approvedBy: SUPER } })
    expect((row.metadata as Record<string, unknown>).adminNote).toBeNull()        // the F1 bug was `undefined` here

    const walletBefore = await walletOf(org)
    const same = await settle(id, { action: 'paid', reason: 'paid by the approver', utrNumber: 'UTR123' })
    expect(same.status).toBe(409); expect(same.body.code).toBe('MAKER_CHECKER_REQUIRED')
    expect(await walletOf(org)).toEqual(walletBefore)
    expect((await adminDb.doc(`settlementRequests/${id}`).get()).data()!.status).toBe('approved')

    h.admin = SUPER2
    const paid = await settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber: 'UTR123' })
    expect(paid.status).toBe(200)
    expect((await adminDb.doc(`settlementRequests/${id}`).get()).data()).toMatchObject({ status: 'paid', paidByAdmin: SUPER2, approvedBy: SUPER, utrNumber: 'UTR123' })
    const w = await walletOf(org)
    expect(w.availablePaise).toBe(walletBefore.availablePaise - 20_000)
    expect(w.settledPaise).toBe(walletBefore.settledPaise + 20_000)
    expect(w.inTransitPaise).toBe(0)
    const [p] = await auditRows(id, 'settlement.paid')
    expect(p).toMatchObject({ adminUid: SUPER2, actorRole: 'super_admin', reason: 'bank transfer sent', metadata: { approvedBy: SUPER, makerChecker: 'distinct_approver', destinationBinding: 'bound' } })
    expect(JSON.stringify(p)).not.toContain('123456789012')
  }, T)

  it('SET · D2 with only ONE Super Admin configured the response says exactly what to do — and never bypasses', async () => {
    const org = await organizer('single')
    const id = (await requestSettlement(org, 1_000)).body.id as string
    h.admin = SUPER
    await settle(id, { action: 'approve', reason: 'documents checked' })
    process.env.ADMIN_UIDS = SUPER
    try {
      const r = await settle(id, { action: 'paid', reason: 'only admin', utrNumber: 'UTR1' })
      expect(r.status).toBe(409); expect(r.body.code).toBe('MAKER_CHECKER_REQUIRED')
      expect(String(r.body.error)).toMatch(/Only one Super Admin is configured/)
    } finally { process.env.ADMIN_UIDS = `${SUPER},${SUPER2}` }
    expect((await adminDb.doc(`settlementRequests/${id}`).get()).data()!.status).toBe('approved')
  }, T)

  it('SET · D5 a re-verified (changed) destination blocks the payout; a legacy request without a snapshot keeps the old rule (flagged)', async () => {
    const org = await organizer('dest')
    const id = (await requestSettlement(org, 3_000)).body.id as string
    h.admin = SUPER
    await settle(id, { action: 'approve', reason: 'documents checked' })
    // the organizer changed their bank details and they were verified again → a NEW binding version
    await adminDb.doc(`organizerPayoutProfiles/${org}`).update({ verifiedVersion: PROFILE_MS + 99_000 })
    h.admin = SUPER2
    const before = await walletOf(org)
    const r = await settle(id, { action: 'paid', reason: 'pay it', utrNumber: 'UTR9' })
    expect(r.status).toBe(409); expect(r.body.code).toBe('DESTINATION_CHANGED')
    expect(await walletOf(org)).toEqual(before)

    // legacy: an approved request from before D5 (no snapshot, no approvedBy)
    const legacy = `p4s4-legacy-${P}`
    await put(`settlementRequests/${legacy}`, { organizerUid: org, amountPaise: 1_000, status: 'approved', requestedAt: Timestamp.now(), approvedAt: Timestamp.now(), paidAt: null, adminNote: '' })
    const lr = await settle(legacy, { action: 'paid', reason: 'legacy payout', utrNumber: 'UTR10' })
    expect(lr.status).toBe(200)
    const [row] = await auditRows(legacy, 'settlement.paid')
    expect(row.metadata).toMatchObject({ makerChecker: 'legacy_no_approver', destinationBinding: 'legacy_unbound' })
  }, T)

  it('SET · D6 atomicity: if the audit row cannot be written, the payout does not happen (wallet and status unchanged)', async () => {
    const org = await organizer('atomic')
    const id = (await requestSettlement(org, 4_000)).body.id as string
    h.admin = SUPER
    await settle(id, { action: 'approve', reason: 'documents checked' })
    h.admin = SUPER2
    const before = await walletOf(org)
    failAuditCreate()
    const r = await settle(id, { action: 'paid', reason: 'pay it', utrNumber: 'UTR11' })
    vi.restoreAllMocks()
    expect(r.status).toBe(500)
    expect(await walletOf(org)).toEqual(before)
    expect((await adminDb.doc(`settlementRequests/${id}`).get()).data()!.status).toBe('approved')
    expect(await auditRows(id, 'settlement.paid')).toHaveLength(0)
  }, T)

  it('SET · reject: reason required, hold released and the audit row staged in the same transaction', async () => {
    const org = await organizer('rej')
    const id = (await requestSettlement(org, 6_000)).body.id as string
    expect((await walletOf(org)).inTransitPaise).toBe(6_000)
    h.admin = SUPER
    const r = await settle(id, { action: 'reject', adminNote: 'bank mismatch' })     // adminNote is the reason fallback
    expect(r.status).toBe(200)
    expect((await walletOf(org)).inTransitPaise).toBe(0)
    const [row] = await auditRows(id, 'settlement.rejected')
    expect(row).toMatchObject({ reason: 'bank mismatch', actorRole: 'super_admin', metadata: { releasedHoldPaise: 6_000 } })
  }, T)

  // ═══ Payout profile review — D5 / F2 ═════════════════════════════════════════════════════
  const review = async (uid: string, body: Record<string, unknown>) => {
    const { PATCH } = await import('@/app/api/admin/payout-profiles/[uid]/route')
    return json(await PATCH(req(body, 'PATCH'), ctx('uid', uid)))
  }
  it('PAY · verify needs Super Admin, a reason and the reviewed version; a STALE review is refused and writes nothing', async () => {
    const org = await organizer('verify')
    await adminDb.doc(`organizerPayoutProfiles/${org}`).update({ isVerified: false, verifiedVersion: null })
    const iso = new Date(PROFILE_MS + 1000).toISOString()
    h.admin = PLAIN
    expect(PLAIN_REFUSED).toContain((await review(org, { action: 'verify', reason: 'looks right', expectedUpdatedAt: iso })).body.code)
    h.admin = SUPER
    expect((await review(org, { action: 'verify', reason: 'looks right' })).body.code).toBe('EXPECTED_VERSION_REQUIRED')
    expect((await review(org, { action: 'verify', expectedUpdatedAt: iso })).body.code).toBe('REASON_REQUIRED')
    const stale = await review(org, { action: 'verify', reason: 'looks right', expectedUpdatedAt: new Date(PROFILE_MS).toISOString() })
    expect(stale.status).toBe(409); expect(stale.body.code).toBe('STALE_PAYOUT_PROFILE')
    expect((await adminDb.doc(`organizerPayoutProfiles/${org}`).get()).data()!.isVerified).toBe(false)
    expect((await adminDb.collection('payoutProfileHistory').where('organizerUid', '==', org).get()).size).toBe(0)
  }, T)

  it('PAY · verify binds the reviewed version, appends a MASKED admin history entry and an audit row — in one transaction; concurrent verifies of one version: exactly one wins', async () => {
    const org = await organizer('verify2')
    await adminDb.doc(`organizerPayoutProfiles/${org}`).update({ isVerified: false, verifiedVersion: null })
    const iso = new Date(PROFILE_MS + 1000).toISOString()
    h.admin = SUPER
    const rs = await Promise.all([0, 1, 2].map(() => review(org, { action: 'verify', reason: 'details match', expectedUpdatedAt: iso })))
    expect(rs.filter(r => r.status === 200)).toHaveLength(1)
    expect(rs.filter(r => r.status === 409).every(r => r.body.code === 'STALE_PAYOUT_PROFILE')).toBe(true)
    const p = (await adminDb.doc(`organizerPayoutProfiles/${org}`).get()).data()!
    expect(p).toMatchObject({ isVerified: true, verifiedBy: SUPER, verifiedVersion: PROFILE_MS + 1000 })
    const hist = (await adminDb.collection('payoutProfileHistory').where('organizerUid', '==', org).get()).docs.map(d => d.data())
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ action: 'admin_verified', source: 'admin_review', actorUid: SUPER, reason: 'details match', changedFields: [] })
    expect(JSON.stringify(hist[0])).not.toMatch(/123456789012|ABCDE1234F|HDFC0001234/)
    const audit = await auditRows(org, 'payout_profile.verified')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ reason: 'details match', actorRole: 'super_admin', after: { isVerified: true, verifiedVersion: PROFILE_MS + 1000 } })
    expect(JSON.stringify(audit[0])).not.toMatch(/123456789012|ABCDE1234F/)

    const rej = await review(org, { action: 'reject', rejectionNote: 'name does not match PAN' })
    expect(rej.status).toBe(200)
    const h2 = (await adminDb.collection('payoutProfileHistory').where('organizerUid', '==', org).where('action', '==', 'admin_rejected').get()).docs
    expect(h2).toHaveLength(1)
    expect(h2[0].data()).toMatchObject({ verificationReset: true, reason: 'name does not match PAN' })
    expect((await adminDb.doc(`organizerPayoutProfiles/${org}`).get()).data()!.verifiedVersion).toBeNull()
  }, T)

  // ═══ Fund release — D1 / D3 / F11 ════════════════════════════════════════════════════════
  it('REL · manual release: Super Admin + reason, audited; the cron release writes a SYSTEM audit row', async () => {
    const org = `p4s4-rel-${P}`
    const seedTx = async (id: string) => {
      await put(`organizerRevenueWallets/${org}`, { organizerUid: org, availablePaise: 0, pendingPaise: 700, settledPaise: 0, inTransitPaise: 0 })
      await put(`platformTransactions/${id}`, { organizerUid: org, status: 'completed', releaseStatus: 'pending', paidAt: Timestamp.fromMillis(Date.now() - 30 * 86_400_000), netSettlementPaise: 700 })
    }
    await seedTx(`p4s4-ptx-a-${P}`)
    const { POST } = await import('@/app/api/admin/finance/release-funds/route')
    h.admin = PLAIN
    expect((await json(await POST(req({ reason: 'release now' })))).body.code).toBe('SUPER_ADMIN_REQUIRED')
    h.admin = SUPER
    expect((await json(await POST(req({})))).body.code).toBe('REASON_REQUIRED')
    expect((await adminDb.doc(`platformTransactions/p4s4-ptx-a-${P}`).get()).data()!.releaseStatus).toBe('pending')
    const reason = `manual release ${P}`
    const ok = await json(await POST(req({ reason })))
    expect(ok.status).toBe(200)
    expect((await adminDb.doc(`platformTransactions/p4s4-ptx-a-${P}`).get()).data()!.releaseStatus).toBe('released')
    const manual = (await adminDb.collection('adminAuditLogs').where('action', '==', 'finance.release_funds').where('reason', '==', reason).get()).docs
    expect(manual).toHaveLength(1)
    expect(manual[0].data()).toMatchObject({ adminUid: SUPER, actorRole: 'super_admin' })

    await seedTx(`p4s4-ptx-b-${P}`)
    const since = Timestamp.now()
    const cron = await import('@/app/api/cron/release-funds/route')
    expect((await cron.GET(req(undefined, 'GET'))).status).toBe(200)
    expect((await adminDb.doc(`platformTransactions/p4s4-ptx-b-${P}`).get()).data()!.releaseStatus).toBe('released')
    const auto = (await adminDb.collection('adminAuditLogs').where('action', '==', 'finance.auto_release').where('createdAt', '>=', since).get()).docs
    expect(auto.length).toBeGreaterThanOrEqual(1)
    expect(auto[0].data()).toMatchObject({ adminUid: 'system:cron_release_funds', actorRole: 'system' })
  }, T)

  // ═══ Clawbacks / plan — D1 / D3 / D6 ═════════════════════════════════════════════════════
  it('CLAW · waive/recover: Super Admin + reason; the audit commits with the resolution or neither does', async () => {
    const id = `p4s4-claw-${P}`
    await put(`walletClawbacks/${id}`, { clawbackId: id, organizerUid: `p4s4-o-${P}`, sourceType: 'registration', sourceId: 'r', transactionId: 't', reversalAmountPaise: 500, recoveredAmountPaise: 0, outstandingAmountPaise: 500, status: 'open', reason: 'refund', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), resolvedAt: null, resolvedBy: null })
    const { PATCH } = await import('@/app/api/admin/clawbacks/[id]/route')
    h.admin = PLAIN
    expect((await json(await PATCH(req({ action: 'waive', reason: 'write it off' }, 'PATCH'), ctx('id', id)))).status).toBe(403)
    h.admin = SUPER
    expect((await json(await PATCH(req({ action: 'waive' }, 'PATCH'), ctx('id', id)))).body.code).toBe('REASON_REQUIRED')
    failAuditCreate()
    await expect(PATCH(req({ action: 'waive', reason: 'write it off' }, 'PATCH'), ctx('id', id))).rejects.toThrow(/injected audit failure/)
    vi.restoreAllMocks()
    expect((await adminDb.doc(`walletClawbacks/${id}`).get()).data()!.status).toBe('open')
    const ok = await json(await PATCH(req({ action: 'waive', reason: 'write it off' }, 'PATCH'), ctx('id', id)))
    expect(ok.status).toBe(200)
    const rows = await auditRows(id, 'clawback.waived')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reason: 'write it off', actorRole: 'super_admin', before: { status: 'open' }, after: { status: 'waived' } })
  }, T)

  // RD-LEGACY-01 — the comp-tier lever is RETIRED: Super Admin still gated, then 410, nothing written.
  it('PLAN · the comp tier is retired: non-admin 403, Super Admin 410 PLAN_RETIRED; no write, no audit row', async () => {
    const org = `p4s4-plan-${P}`
    await put(`users/${org}`, { uid: org, role: 'organizer' })
    const { PATCH } = await import('@/app/api/admin/organizers/[uid]/plan/route')
    h.admin = PLAIN
    expect((await json(await PATCH(req({ overrideTier: 'growth', reason: 'support comp' }, 'PATCH'), ctx('uid', org)))).body.code).toBe('SUPER_ADMIN_REQUIRED')
    h.admin = SUPER
    const r = await json(await PATCH(req({ overrideTier: 'growth', reason: 'support comp' }, 'PATCH'), ctx('uid', org)))
    expect([r.status, r.body.code]).toEqual([410, 'PLAN_RETIRED'])
    expect((await adminDb.doc(`users/${org}`).get()).data()!.entitlementOverrideTier).toBeUndefined()
    expect(await auditRows(org, 'plan.changed')).toHaveLength(0)
  }, T)

  // ═══ Licences — D1 / F8 / F3 ═════════════════════════════════════════════════════════════
  const licence = async (tag: string, extra: Record<string, unknown> = {}) => {
    const slug = `p4s4-lic-${tag}-${P}`
    await put(`events/${slug}`, { uid: `p4s4-lo-${P}`, slug, draftId: `d-${slug}`, lifecycleStatus: 'published' })
    await put(`eventLicenses/${slug}`, { eventId: slug, organizerUid: `p4s4-lo-${P}`, tier: 'starter', status: 'active', version: 1, orderId: null, ...extra })
    return slug
  }
  const licAct = async (slug: string, body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/admin/licenses/[eventId]/route')
    return json(await POST(req(body), ctx('eventId', slug)))
  }
  it('LIC · F8 concurrent overlay actions never undo each other (the overlay is read inside the transaction)', async () => {
    const slug = await licence('conc')
    h.admin = SUPER
    for (let i = 0; i < 3; i++) {
      const [a, b] = await Promise.all([
        // RD-LEGACY-01 — overrideFeatures is retired (410); the race is exercised with overridePrice.
        licAct(slug, { action: 'overridePrice', pricePaise: 1_000 + i, reason: 'price change' }),
        licAct(slug, { action: 'overrideLimit', limitKey: 'maxTeamMembers', limitValue: 10 + i, reason: 'limit change' }),
      ])
      expect([a.status, b.status]).toEqual([200, 200])
      const admin = (await adminDb.doc(`eventLicenses/${slug}`).get()).data()!.admin as Record<string, Record<string, unknown>>
      expect(admin.pricePaiseOverride).toBe(1_000 + i)
      expect(admin.limitOverrides.maxTeamMembers).toBe(10 + i)
    }
    const hist = (await adminDb.collection('licenseHistory').where('eventId', '==', slug).get()).docs
    expect(hist).toHaveLength(6)
    for (const d of hist) expect((await adminDb.doc(`adminAuditLogs/license_${d.id}`).get()).exists).toBe(true)
  }, T)

  it('LIC · F3 once the gateway refunded, a failed history/audit write does NOT turn into a failure — it is recorded for reconciliation', async () => {
    const slug = await licence('refund', { orderId: `lic_p4s4_${P}` })
    await put(`licenseOrders/lic_p4s4_${P}`, { orderId: `lic_p4s4_${P}`, status: 'paid', razorpayPaymentId: `pay_lic_${P}`, amountPaise: 5_000, organizerUid: `p4s4-lo-${P}` })
    cleanup.add(`walletTransactions/license_refund_${slug}`)
    h.admin = SUPER
    failAuditCreate('licenseHistory/')
    const r = await licAct(slug, { action: 'refund', reason: 'customer cancelled' })
    vi.restoreAllMocks()
    expect(r.status).toBe(200)
    expect(r.body.refund).toEqual({ gatewayRefunded: true, walletCreditedPaise: 0 })
    expect(r.body.reconciliation).toEqual(['license_cancel_audit_failed'])
    expect(h.refundCalls).toBe(1)
    const rec = await auditRows(slug, 'license.refund_audit_recovered')
    expect(rec).toHaveLength(1)
    expect(rec[0]).toMatchObject({ reason: 'customer cancelled', actorRole: 'super_admin', metadata: { gatewayRefunded: true } })
    // a retry never refunds twice
    expect((await licAct(slug, { action: 'refund', reason: 'customer cancelled' })).status).toBe(409)
    expect(h.refundCalls).toBe(1)
  }, T)

  // RD-SEC-01 · was "addNote stays admin": no claim-only admin tier any more — addNote is refused too.
  it('LIC · D1 every licence action is Super Admin only (addNote included); reasons are 3–500 chars', async () => {
    const slug = await licence('perm')
    h.admin = PLAIN
    for (const body of [{ action: 'extendExpiry', expiryDays: 30 }, { action: 'forceConsume' }, { action: 'reissue' }, { action: 'overrideLimit', limitKey: 'maxRegistrations', limitValue: 50 }]) {
      const r = await licAct(slug, { ...body, reason: 'plain admin tries' })
      expect(r.status, JSON.stringify(body)).toBe(403); expect(PLAIN_REFUSED).toContain(r.body.code)
    }
    expect((await licAct(slug, { action: 'addNote', note: 'a plain note' })).status).toBe(403)
    h.admin = SUPER
    expect((await licAct(slug, { action: 'addNote', note: 'a super note' })).status).toBe(200)
    expect((await licAct(slug, { action: 'extendExpiry', expiryDays: 30, reason: 'no' })).body.code).toBe('REASON_TOO_SHORT')
    expect((await licAct(slug, { action: 'extendExpiry', expiryDays: 30, reason: 'extend for the rerun' })).status).toBe(200)
    const [row] = await auditRows(slug, 'license.expiry_extended')
    expect(row).toMatchObject({ reason: 'extend for the rerun', actorRole: 'super_admin' })
  }, T)

  // ═══ Coupons — F11 append-only create ════════════════════════════════════════════════════
  it('COUP · concurrent creates of ONE code: exactly one succeeds (append-only), with exactly one audit row', async () => {
    const code = `P4S4${P}`
    cleanup.add(`licenseCoupons/${code}`)
    const { POST } = await import('@/app/api/admin/license-coupons/route')
    h.admin = SUPER
    const results = await Promise.all([0, 1, 2].map(async i => json(await POST(req({ reason: 'launch promo', coupon: { code, type: 'percentage', value: 10 + i } })))))
    expect(results.filter(r => r.status === 201)).toHaveLength(1)
    expect(results.filter(r => r.status === 409)).toHaveLength(2)
    expect(await auditRows(code, 'license_coupon.created')).toHaveLength(1)
  }, T)

  // ═══ Refunds — F4 / F5 ═══════════════════════════════════════════════════════════════════
  it('REG · F4 the registration refund needs a reason; its audit names the Super Admin, amount and gateway refund id', async () => {
    const org = `p4s4-regorg-${P}`, regId = `p4s4-reg-${P}`, orderId = `order_p4s4_${P}`, paymentId = `pay_reg_${P}`
    await put(`registrations/${regId}`, { organizerUid: org, eventSlug: `p4s4-ev-${P}`, paymentStatus: 'paid' })
    await put(`paymentIntents/${orderId}`, { orderId, registrationId: regId, paymentId, amount: 12_300, provider: 'razorpay' })
    const { POST } = await import('@/app/api/organizer/registrations/[registrationId]/refund/route')
    h.admin = SUPER
    expect((await json(await POST(req({}), ctx('registrationId', regId)))).body.code).toBe('REASON_REQUIRED')
    expect(h.refundCalls).toBe(0)
    const r = await json(await POST(req({ reason: 'event cancelled for this attendee' }), ctx('registrationId', regId)))
    expect(r.status).toBe(200)
    expect(h.refundCalls).toBe(1)
    const [row] = await auditRows(regId, 'registration.refunded')
    expect(row).toMatchObject({
      adminUid: SUPER, actorRole: 'super_admin', reason: 'event cancelled for this attendee',
      metadata: { refundAmountPaise: 12_300, refundId: r.body.refundId, paymentId, orderId },
    })
    const regAudit = (await adminDb.collection(`registrations/${regId}/auditLog`).get()).docs.map(d => d.data())
    expect(regAudit).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'refunded', actor: SUPER, actorType: 'super_admin' })]))
  }, T)

  it('DON · F5 fail-closed existing-refund lookup: adopt an unrecorded refund; refuse when uncertain; never a second refund', async () => {
    const mk = async (tag: string) => {
      const id = `p4s4-don-${tag}-${P}`, pay = `pay_don_${tag}_${P}`
      await put(`donations/${id}`, { id, status: 'successful', organizerUid: `p4s4-do-${P}`, razorpayPaymentId: pay, amountPaise: 10_000, campaignId: 'c', campaignSlug: `p4s4-camp-${P}`, refundedAmountPaise: 0, pendingRefundPaise: 0 })
      return { id, pay }
    }
    const { POST } = await import('@/app/api/organizer/donations/[donationId]/refund/route')
    const refund = async (id: string, amountPaise: number) => json(await POST(req({ amountPaise, reason: 'donor asked for a refund' }), ctx('donationId', id)))
    h.admin = SUPER

    const a = await mk('adopt')
    h.refunds.set(a.pay, [{ id: `rfnd_lost_${P}`, amount: 4_000, status: 'processed' }])      // a lost response
    cleanup.add(`donationRefunds/rfnd_lost_${P}`)
    const ra = await refund(a.id, 4_000)
    expect(ra.status).toBe(200); expect(ra.body.refundId).toBe(`rfnd_lost_${P}`)
    expect(h.refundCalls).toBe(0)

    const u = await mk('uncertain')
    h.refunds.set(u.pay, [{ id: `rfnd_other_${P}`, amount: 1_234, status: 'processed' }])
    const ru = await refund(u.id, 4_000)
    expect(ru.status).toBe(409); expect(ru.body.code).toBe('REFUND_STATUS_UNCERTAIN')
    expect((await adminDb.doc(`donations/${u.id}`).get()).data()!.pendingRefundPaise).toBe(0)

    const t = await mk('throw')
    h.lookupPlan = ['throw']
    expect((await refund(t.id, 4_000)).body.code).toBe('REFUND_STATUS_UNCERTAIN')
    expect(h.refundCalls).toBe(0)

    // a RECORDED earlier refund is not "unrecorded": the new partial refund proceeds, once
    const n = await mk('normal')
    h.refunds.set(n.pay, [{ id: `rfnd_known_${P}`, amount: 1_000, status: 'processed' }])
    await put(`donationRefunds/rfnd_known_${P}`, { id: `rfnd_known_${P}`, donationId: n.id })
    const rn = await refund(n.id, 2_000)
    expect(rn.status).toBe(200)
    expect(h.refundCalls).toBe(1)
    cleanup.add(`donationRefunds/${rn.body.refundId as string}`)
  }, T)

  // ═══ Review holds — D4 / F7 ══════════════════════════════════════════════════════════════
  const hold = async (tag: string, over: Record<string, unknown> = {}) => {
    const id = `duplicate_hold_order_p4s4_${tag}_${P}`
    await put(`failedRefunds/${id}`, { orderId: `order_p4s4_${tag}_${P}`, paymentId: `pay_hold_${tag}_${P}`, amountPaise: 5_000, reason: 'duplicate', registrationId: null, kind: 'duplicate_hold', status: 'review', ...over })
    return id
  }
  const reviewHold = async (id: string, body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/admin/failed-refunds/[id]/review/route')
    return json(await POST(req(body), ctx('id', id)))
  }
  const retry = async (id: string) => {
    const { POST } = await import('@/app/api/admin/failed-refunds/[id]/retry/route')
    return json(await POST(req({ reason: 'refund the approved hold' }), ctx('id', id)))
  }
  it('HOLD · a hold is refunded only after an explicit, reasoned, audited Super Admin approval — once', async () => {
    const id = await hold('approve')
    h.admin = PLAIN
    expect(PLAIN_REFUSED).toContain((await reviewHold(id, { action: 'approve_refund', reason: 'duplicate confirmed' })).body.code)
    h.admin = SUPER
    expect((await retry(id)).status).toBe(409)                                  // not approved
    expect((await reviewHold(id, { action: 'approve_refund' })).body.code).toBe('REASON_REQUIRED')
    const rs = await Promise.all([0, 1].map(() => reviewHold(id, { action: 'approve_refund', reason: 'duplicate confirmed' })))
    expect(rs.filter(r => r.status === 200)).toHaveLength(1)
    expect(rs.find(r => r.status === 409)?.body.code).toBe('NOT_IN_REVIEW')
    const rec = (await adminDb.doc(`failedRefunds/${id}`).get()).data()!
    expect(rec).toMatchObject({ status: 'open', reviewApproval: { by: SUPER, reason: 'duplicate confirmed' }, paymentId: `pay_hold_approve_${P}` })
    expect(await auditRows(id, 'failed_refund.review_refund_approved')).toHaveLength(1)
    // an approved hold still cannot be closed by the generic resolve/ignore
    const { PATCH } = await import('@/app/api/admin/failed-refunds/[id]/route')
    expect((await json(await PATCH(req({ action: 'ignored', reason: 'keep the money' }, 'PATCH'), ctx('id', id)))).status).toBe(409)
    expect(h.refundCalls).toBe(0)
    expect((await retry(id)).status).toBe(200)
    expect((await retry(id)).status).toBe(409)
    expect(h.refundCalls).toBe(1)
    const [row] = await auditRows(id, 'failed_refund.retry')
    expect(row).toMatchObject({ reason: 'refund the approved hold', metadata: { reviewApprovedBy: SUPER, holdKind: 'duplicate_hold' } })
  }, T)

  it('HOLD · an OPEN hold without a review approval (either kind) is never refunded by retry', async () => {
    h.admin = SUPER
    for (const kind of ['duplicate_hold', 'settlement_hold']) {
      const id = await hold(`open-${kind}`, { kind, status: 'open' })
      const r = await retry(id)
      expect(r.status, kind).toBe(409)
      expect((await adminDb.doc(`failedRefunds/${id}`).get()).data()!.status, kind).toBe('open')
    }
    expect(h.refundCalls).toBe(0)
  }, T)

  it('HOLD · resolve needs VERIFIED evidence (gateway refunded, or a registration settled for the order); otherwise nothing changes', async () => {
    h.admin = SUPER
    const none = await hold('none')
    const n = await reviewHold(none, { action: 'resolve', reason: 'handled elsewhere' })
    expect(n.status).toBe(409); expect(n.body.code).toBe('HOLD_OUTCOME_UNVERIFIED')
    expect((await adminDb.doc(`failedRefunds/${none}`).get()).data()!.status).toBe('review')

    const gw = await hold('gw')
    h.refunds.set(`pay_hold_gw_${P}`, [{ id: 'rfnd_dash', amount: 5_000, status: 'processed' }])
    const g = await reviewHold(gw, { action: 'resolve', reason: 'refunded from the dashboard' })
    expect(g.status).toBe(200); expect(g.body.evidence).toBe('refunded_at_gateway')
    expect((await adminDb.doc(`failedRefunds/${gw}`).get()).data()).toMatchObject({ status: 'resolved', reviewEvidence: { kind: 'refunded_at_gateway', refundedPaise: 5_000 } })

    const reg = await hold('reg')
    await put(`registrations/p4s4-recovered-${P}`, { paymentOrderId: `order_p4s4_reg_${P}`, organizerUid: 'x' })
    const rr = await reviewHold(reg, { action: 'resolve', reason: 'registration recovered' })
    expect(rr.status).toBe(200); expect(rr.body.evidence).toBe('registration_settled')
    expect(await auditRows(reg, 'failed_refund.review_resolved')).toHaveLength(1)
    expect(h.refundCalls).toBe(0)
  }, T)

  // ═══ D6 · audit failure after an EXTERNAL action is durably recorded ════════════════════════
  it('AUD · logAdminActionOrRecord never throws; a failed write lands in adminAuditFailures (correlated)', async () => {
    const { logAdminActionOrRecord, ADMIN_AUDIT_FAILURES } = await import('@/lib/admin/audit')
    const { CollectionReference } = await import('firebase-admin/firestore')
    const realAdd = CollectionReference.prototype.add
    vi.spyOn(CollectionReference.prototype, 'add').mockImplementation(function (this: InstanceType<typeof CollectionReference>, data: FirebaseFirestore.DocumentData) {
      if (this.id === 'adminAuditLogs') return Promise.reject(new Error('injected audit write failure'))
      return realAdd.call(this, data)
    } as never)
    const entityId = `p4s4-auditfail-${P}`
    const ok = await logAdminActionOrRecord({ adminUid: SUPER, actorRole: 'super_admin', action: 'media_credit_grant.created', entityType: 'media_credit_grant', entityId, reason: 'goodwill', correlation: { grantId: entityId, maybe: undefined } })
    vi.restoreAllMocks()
    expect(ok).toBe(false)
    const fails = (await adminDb.collection(ADMIN_AUDIT_FAILURES).where('audit.entityId', '==', entityId).get()).docs
    expect(fails).toHaveLength(1)
    for (const d of fails) cleanup.add(`${ADMIN_AUDIT_FAILURES}/${d.id}`)
    expect(fails[0].data()).toMatchObject({ status: 'open', audit: { action: 'media_credit_grant.created', reason: 'goodwill', correlation: { grantId: entityId } } })
    expect('maybe' in (fails[0].data().audit.correlation as object)).toBe(false)      // undefined stripped (F1 class)
  }, T)

  // ═══ D7 · financial audit readers ════════════════════════════════════════════════════════
  // RD-SEC-01 · was "Event360 / Organizer360 hide financial rows from a plain admin": the claim-only
  // admin now reads no timeline at all; the Super Admin still sees every row.
  it('D7 · the audit-log viewer and the event/organizer timelines are Super Admin only', async () => {
    const logs = await import('@/app/api/admin/audit-logs/route')
    h.admin = PLAIN
    expect((await json(await logs.GET(req(undefined, 'GET')))).body.code).toBe('SUPER_ADMIN_REQUIRED')
    h.admin = SUPER
    expect((await logs.GET(req(undefined, 'GET'))).status).toBe(200)

    const slug = `p4s4-d7-${P}`, org = `p4s4-d7org-${P}`
    await put(`events/${slug}`, { uid: org, slug, lifecycleStatus: 'published' })
    await put(`users/${org}`, { uid: org, role: 'organizer', email: 'x@rd.test' })
    const now = Timestamp.now()
    await put(`adminAuditLogs/p4s4-d7-fin-${P}`, { adminUid: SUPER, action: 'pricing_override.set', entityType: 'event', entityId: slug, createdAt: now })
    await put(`adminAuditLogs/p4s4-d7-mod-${P}`, { adminUid: SUPER, action: 'event.taken_down', entityType: 'event', entityId: slug, createdAt: now })
    await put(`adminAuditLogs/p4s4-d7-ofin-${P}`, { adminUid: SUPER, action: 'plan.changed', entityType: 'billing', entityId: org, createdAt: now })
    await put(`adminAuditLogs/p4s4-d7-omod-${P}`, { adminUid: SUPER, action: 'organizer.suspended', entityType: 'organizer', entityId: org, createdAt: now })

    const tl = await import('@/app/api/admin/events/[slug]/timeline/route')
    const actions = async () => ((await json(await tl.GET(req(undefined, 'GET'), ctx('slug', slug)))).body.entries as Array<{ action: string }>).map(e => e.action)
    h.admin = PLAIN
    expect([401, 403]).toContain((await tl.GET(req(undefined, 'GET'), ctx('slug', slug))).status)
    h.admin = SUPER
    expect(await actions()).toEqual(expect.arrayContaining(['event.taken_down', 'pricing_override.set']))

    const ot = await import('@/app/api/admin/organizers/[uid]/timeline/route')
    const oActions = async () => ((await json(await ot.GET(req(undefined, 'GET'), ctx('uid', org)))).body.entries as Array<{ action: string }>).map(e => e.action)
    h.admin = PLAIN
    expect([401, 403]).toContain((await ot.GET(req(undefined, 'GET'), ctx('uid', org))).status)
    h.admin = SUPER
    expect(await oActions()).toEqual(expect.arrayContaining(['organizer.suspended', 'plan.changed']))
  }, T)

  // ═══ Closeout · Super Admin review of adminAuditFailures ═══════════════════════════════════
  const failuresApi = async () => import('@/app/api/admin/audit-failures/route')
  const failureApi  = async () => import('@/app/api/admin/audit-failures/[id]/route')
  const seedFailure = async (tag: string, at: number, over: Record<string, unknown> = {}) => {
    const id = `p4s4c-fail-${tag}-${P}`
    await put(`adminAuditFailures/${id}`, {
      audit: {
        adminUid: SUPER, action: 'media_credit_grant.created', entityType: 'media_credit_grant', entityId: `p4s4c-ent-${tag}-${P}`,
        actorRole: 'super_admin', reason: 'goodwill credit', correlation: { grantId: `g-${tag}` }, metadata: { credits: 10 },
        createdAt: Timestamp.fromMillis(at),
      },
      error: 'write failed: Bearer abc.def.ghi token=s3cr3tValue for ops@registerdesk.test key AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      status: 'open', createdAt: Timestamp.fromMillis(at), ...over,
    })
    cleanup.add(`adminAuditLogs/recovered_${id}`)
    return id
  }
  const failGet  = async (id: string) => json(await (await failureApi()).GET(req(undefined, 'GET'), ctx('id', id)))
  const failPost = async (id: string, body: Record<string, unknown>) => json(await (await failureApi()).POST(req(body), ctx('id', id)))

  it('FAIL · the failed-audit review is Super Admin only (list, detail and reconcile)', async () => {
    const id = await seedFailure('auth', Date.now() - 60_000)
    h.admin = PLAIN
    const { GET } = await failuresApi()
    expect((await json(await GET(req(undefined, 'GET')))).body.code).toBe('SUPER_ADMIN_REQUIRED')
    expect(PLAIN_REFUSED).toContain((await failGet(id)).body.code)
    expect(PLAIN_REFUSED).toContain((await failPost(id, { action: 'replay', reason: 'plain admin tries' })).body.code)
    h.admin = ''
    expect((await json(await GET(req(undefined, 'GET')))).status).toBe(403)
    expect((await adminDb.doc(`adminAuditFailures/${id}`).get()).data()!.status).toBe('open')
  }, T)

  it('FAIL · list filters by status / entity, shows operation references and REDACTS the error', async () => {
    const id = await seedFailure('list', Date.now() - 30_000)
    h.admin = SUPER
    const { GET } = await failuresApi()
    const r = await json(await GET(new NextRequest(`http://localhost/api/test?status=open&entityId=p4s4c-ent-list-${P}`, { headers: { authorization: 'Bearer t' } })))
    expect(r.status).toBe(200)
    const items = r.body.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id, status: 'open', audit: { action: 'media_credit_grant.created', entityId: `p4s4c-ent-list-${P}`, correlation: { grantId: 'g-list' }, reason: 'goodwill credit' } })
    const err = String(items[0].error)
    expect(err).not.toMatch(/abc\.def|s3cr3tValue|ops@registerdesk\.test|AAAAAAAAAAAAAAAAAAAAAAAA/)
    expect(err).toMatch(/Bearer \[redacted\]/)
    const none = await json(await GET(new NextRequest(`http://localhost/api/test?status=resolved&entityId=p4s4c-ent-list-${P}`, { headers: { authorization: 'Bearer t' } })))
    expect(none.body.items).toEqual([])
    expect((await json(await GET(new NextRequest('http://localhost/api/test?status=bogus', { headers: { authorization: 'Bearer t' } })))).body.code).toBe('INVALID_STATUS')
  }, T)

  it('FAIL · replay re-creates the missing row ONCE (original time, recovery stamps), resolves the record and audits itself', async () => {
    const at = Date.now() - 120_000
    const id = await seedFailure('replay', at)
    h.admin = SUPER
    expect((await failPost(id, { action: 'replay' })).body.code).toBe('REASON_REQUIRED')
    expect((await failPost(id, { action: 'delete', reason: 'not an action' })).body.code).toBe('INVALID_ACTION')
    expect((await failPost(id, { action: 'mark_present', reason: 'row should be there' })).body.code).toBe('NO_MATCHING_AUDIT_ROW')
    const rs = await Promise.all([0, 1, 2].map(() => failPost(id, { action: 'replay', reason: 'restore the missing audit row' })))
    expect(rs.filter(r => r.status === 200)).toHaveLength(1)
    expect(rs.filter(r => r.status === 409)).toHaveLength(2)
    const row = (await adminDb.doc(`adminAuditLogs/recovered_${id}`).get()).data()!
    expect(row).toMatchObject({ action: 'media_credit_grant.created', entityId: `p4s4c-ent-replay-${P}`, adminUid: SUPER, recoveredFromFailureId: id, recoveredBy: SUPER, recoveryReason: 'restore the missing audit row' })
    expect((row.createdAt as { toMillis: () => number }).toMillis()).toBe(at)
    const f = (await adminDb.doc(`adminAuditFailures/${id}`).get()).data()!
    expect(f).toMatchObject({ status: 'resolved', resolution: { kind: 'replayed', by: SUPER, reason: 'restore the missing audit row', recoveredAuditId: `recovered_${id}` } })
    const self = await auditRows(id, 'audit_failure.replayed')
    expect(self).toHaveLength(1)
    expect(self[0]).toMatchObject({ actorRole: 'super_admin', reason: 'restore the missing audit row', entityType: 'audit_failure' })
    for (const s of self) cleanup.add(`adminAuditLogs/${s.id}`)
    expect((await failPost(id, { action: 'replay', reason: 'again' })).body.code).toBe('NOT_OPEN')
  }, T)

  it('FAIL · mark_present only when the SERVER finds the original row near the failure time; no write to the audit log', async () => {
    const at = Date.now() - 90_000
    const id = await seedFailure('present', at)
    await put(`adminAuditLogs/p4s4c-orig-${P}`, { adminUid: SUPER, action: 'media_credit_grant.created', entityType: 'media_credit_grant', entityId: `p4s4c-ent-present-${P}`, createdAt: Timestamp.fromMillis(at + 2_000) })
    h.admin = SUPER
    const d = await failGet(id)
    expect(d.status).toBe(200)
    expect((d.body.existingMatches as Array<{ id: string }>).map(m => m.id)).toEqual([`p4s4c-orig-${P}`])
    const r = await failPost(id, { action: 'mark_present', reason: 'the original write landed' })
    expect(r.status).toBe(200); expect(r.body.resolution).toBe('already_present')
    expect((await adminDb.doc(`adminAuditLogs/recovered_${id}`).get()).exists).toBe(false)
    const self = await auditRows(id, 'audit_failure.resolved_present')
    expect(self).toHaveLength(1)
    expect(self[0].metadata).toMatchObject({ matchedAuditIds: [`p4s4c-orig-${P}`] })
    for (const s of self) cleanup.add(`adminAuditLogs/${s.id}`)
  }, T)

  it('FAIL · the real writer (logAdminActionOrRecord) produces a record this review can replay', async () => {
    const { logAdminActionOrRecord } = await import('@/lib/admin/audit')
    const { CollectionReference } = await import('firebase-admin/firestore')
    const realAdd = CollectionReference.prototype.add
    vi.spyOn(CollectionReference.prototype, 'add').mockImplementation(function (this: InstanceType<typeof CollectionReference>, data: FirebaseFirestore.DocumentData) {
      if (this.id === 'adminAuditLogs') return Promise.reject(new Error('injected: Bearer zzz.yyy'))
      return realAdd.call(this, data)
    } as never)
    const entityId = `p4s4c-real-${P}`
    expect(await logAdminActionOrRecord({ adminUid: SUPER, actorRole: 'super_admin', action: 'donation.refund_initiated', entityType: 'donation', entityId, reason: 'donor refund', metadata: { refundId: 'rfnd_x' } })).toBe(false)
    vi.restoreAllMocks()
    const fid = (await adminDb.collection('adminAuditFailures').where('audit.entityId', '==', entityId).get()).docs[0].id
    cleanup.add(`adminAuditFailures/${fid}`); cleanup.add(`adminAuditLogs/recovered_${fid}`)
    h.admin = SUPER
    expect((await failGet(fid)).body.item).toMatchObject({ error: 'injected: Bearer [redacted]', audit: { action: 'donation.refund_initiated', entityId } })
    expect((await failPost(fid, { action: 'replay', reason: 'restore donation audit' })).status).toBe(200)
    expect((await adminDb.doc(`adminAuditLogs/recovered_${fid}`).get()).data()).toMatchObject({ action: 'donation.refund_initiated', entityId, reason: 'donor refund', metadata: { refundId: 'rfnd_x' } })
  }, T)
})
