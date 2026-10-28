// RD-SETTLE-PAY-01 — Super Admin "Mark as Paid", proved against REAL Firestore through the REAL route
// (PATCH /api/admin/settlements/[id]).
//
//   • required: UTR (server format) and Reason (3–500); OPTIONAL: Bank Reference, Paid By, Payment Notes —
//     each omitted alone, all omitted, all empty strings, all populated;
//   • D1 Super Admin only, with the REAL ADMIN_UIDS parsing (only the Firebase token check is mocked):
//     empty / single / padded lists; a non-admin and a legacy-claim-only caller are refused;
//   • D2 maker-checker: the approver is refused (with the single-admin message when only one is configured),
//     a different Super Admin succeeds;
//   • duplicate and concurrent submissions debit the wallet ONCE; invalid states are refused;
//   • the approval and the payment are each audited once.
//
// Emulator only (refuses a non-demo project). No request leaves the process.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const SUPER = `smp-super-${P}`, SUPER2 = `smp-super2-${P}`, OUTSIDER = `smp-outsider-${P}`, CLAIM = `smp-claim-${P}`

const h = vi.hoisted(() => ({ who: '' as string, admin: '' as string }))

// Identity is mocked at the TOKEN boundary only: verifyIdToken returns the acting uid (and the legacy claim for
// CLAIM). Whether that uid is a Super Admin is decided by the real lib/admin/auth.ts reading ADMIN_UIDS.
vi.mock('@/lib/firebase/admin', async orig => {
  const real = await orig<typeof import('@/lib/firebase/admin')>()
  return {
    ...real,
    adminAuth: new Proxy(real.adminAuth, {
      get: (t, k) => k === 'verifyIdToken'
        ? async () => { if (!h.admin) throw new Error('no token'); return { uid: h.admin, ...(h.admin === CLAIM ? { admin: true } : {}) } }
        : Reflect.get(t, k),
    }),
  }
})
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

describeEmu('RD-SETTLE-PAY-01 · Mark as Paid on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  const cleanup = new Set<string>()
  const savedAdminUids = process.env.ADMIN_UIDS
  const BOTH = `${SUPER},${SUPER2}`

  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); cleanup.add(path) }
  const auditRows = async (entityId: string, action: string) =>
    (await adminDb.collection('adminAuditLogs').where('entityId', '==', entityId).where('action', '==', action).get())
      .docs.map(d => d.data() as Record<string, unknown>)
  const settlementOf = async (id: string) => (await adminDb.doc(`settlementRequests/${id}`).get()).data()!
  const walletOf = async (uid: string) => (await adminDb.doc(`organizerRevenueWallets/${uid}`).get()).data()!

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    process.env.ADMIN_UIDS = BOTH
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
  }, T)
  afterAll(async () => {
    process.env.ADMIN_UIDS = savedAdminUids
    for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null)
    const refs = await adminDb.collection('payoutTransferReferences').where('organizerUid', '>=', 'smp-org-').where('organizerUid', '<', 'smp-org-').get()
    for (const d of refs.docs) await d.ref.delete().catch(() => null)
    for (const id of cleanup) {
      if (!id.startsWith('settlementRequests/')) continue
      const rows = await adminDb.collection('adminAuditLogs').where('entityId', '==', id.split('/')[1]).get()
      for (const d of rows.docs) await d.ref.delete().catch(() => null)
    }
  }, T)
  beforeEach(() => { h.who = ''; h.admin = ''; process.env.ADMIN_UIDS = BOTH })

  // ─── fixtures ───────────────────────────────────────────────────────────────
  const PROFILE_MS = Date.parse('2026-09-01T10:00:00.000Z')
  let seq = 0
  async function organizer(walletAvailable = 100_000) {
    const uid = `smp-org-${++seq}-${P}`
    await put(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })
    await put(`organizerRevenueWallets/${uid}`, { organizerUid: uid, availablePaise: walletAvailable, pendingPaise: 0, settledPaise: 0, inTransitPaise: 0 })
    await put(`organizerPayoutProfiles/${uid}`, {
      uid, accountHolderName: 'Test Holder', payoutMethod: 'bank', bankName: 'HDFC Bank',
      accountNumber: '123456789012', ifscCode: 'HDFC0001234', upiId: null, panNumber: 'ABCDE1234F', gstNumber: null,
      isVerified: true, verifiedAt: Timestamp.fromMillis(PROFILE_MS + 1000), verifiedBy: SUPER, verifiedVersion: PROFILE_MS,
      rejectionNote: null, createdAt: Timestamp.fromMillis(PROFILE_MS), updatedAt: Timestamp.fromMillis(PROFILE_MS + 1000),
    })
    return uid
  }
  const settle = async (id: string, body: Record<string, unknown>, as: string) => {
    const { PATCH } = await import('@/app/api/admin/settlements/[id]/route')
    h.admin = as
    try { return await json(await PATCH(req(body, 'PATCH'), ctx(id))) } finally { h.admin = '' }
  }
  /** A request the organizer made, approved by SUPER. */
  async function approved(amountPaise = 5_000) {
    const org = await organizer()
    const { POST } = await import('@/app/api/organizer/settlements/route')
    h.who = org
    const r = await json(await POST(req({ amountPaise })))
    h.who = ''
    expect(r.status).toBe(201)
    const id = r.body.id as string
    cleanup.add(`settlementRequests/${id}`)
    const ap = await settle(id, { action: 'approve', reason: 'documents checked' }, SUPER)
    expect(ap.status).toBe(200)
    return { id, org }
  }
  let utrSeq = 0
  const utr = () => `SMP${P}N${++utrSeq}`

  // ─── optional fields ─────────────────────────────────────────────────────────
  it('each optional field may be omitted on its own; only the supplied ones are stored', async () => {
    const full = { bankReference: 'NEFT ref 77', paidBy: 'Accounts team', paymentNotes: 'one batch' }
    for (const drop of ['bankReference', 'paidBy', 'paymentNotes'] as const) {
      const { id } = await approved()
      const body: Record<string, unknown> = { action: 'paid', reason: 'bank transfer sent', utrNumber: utr(), ...full }
      delete body[drop]
      const r = await settle(id, body, SUPER2)
      expect(r.status, drop).toBe(200)
      const s = await settlementOf(id)
      expect(s.status).toBe('paid')
      expect(s, drop).not.toHaveProperty(drop)
      for (const k of Object.keys(full).filter(k => k !== drop)) expect(s[k], k).toBe(full[k as keyof typeof full])
    }
  }, T)

  it('all optional fields omitted — or sent as empty / whitespace strings — is a valid payout', async () => {
    for (const extra of [{}, { bankReference: '', paidBy: '', paymentNotes: '' }, { bankReference: '  ', paidBy: ' ', paymentNotes: '\t' }]) {
      const { id, org } = await approved(7_000)
      const before = await walletOf(org)
      const u = utr()
      const r = await settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber: u, ...extra }, SUPER2)
      expect(r.status, JSON.stringify(extra)).toBe(200)
      const s = await settlementOf(id)
      expect(s).toMatchObject({ status: 'paid', paidByAdmin: SUPER2, utrNumber: u })
      for (const k of ['bankReference', 'paidBy', 'paymentNotes']) expect(s).not.toHaveProperty(k)
      const w = await walletOf(org)
      expect(w.availablePaise).toBe(before.availablePaise - 7_000)
      expect(w.settledPaise).toBe(before.settledPaise + 7_000)
      const [row] = await auditRows(id, 'settlement.paid')
      expect(row.metadata).toMatchObject({ bankReference: null, paidBy: null, approvedBy: SUPER, makerChecker: 'distinct_approver' })
    }
  }, T)

  it('all optional fields populated are stored trimmed and audited', async () => {
    const { id } = await approved()
    const r = await settle(id, { action: 'paid', reason: '  bank transfer sent  ', utrNumber: utr(), bankReference: ' NEFT12345 ', paidBy: ' Razorpay ', paymentNotes: ' two batches ' }, SUPER2)
    expect(r.status).toBe(200)
    expect(await settlementOf(id)).toMatchObject({ bankReference: 'NEFT12345', paidBy: 'Razorpay', paymentNotes: 'two batches' })
    const [row] = await auditRows(id, 'settlement.paid')
    expect(row).toMatchObject({ adminUid: SUPER2, reason: 'bank transfer sent', metadata: { bankReference: 'NEFT12345', paidBy: 'Razorpay' } })
  }, T)

  // ─── required fields ────────────────────────────────────────────────────────
  it('Reason: missing, empty, whitespace-only, too short and too long are refused with the reason code; nothing changes', async () => {
    const { id, org } = await approved()
    const before = await walletOf(org)
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'REASON_REQUIRED'], [{ reason: '' }, 'REASON_REQUIRED'], [{ reason: '    ' }, 'REASON_REQUIRED'],
      [{ reason: ' ab ' }, 'REASON_TOO_SHORT'], [{ reason: 'x'.repeat(501) }, 'REASON_TOO_LONG'],
    ]
    for (const [extra, codeExpected] of cases) {
      const r = await settle(id, { action: 'paid', utrNumber: utr(), ...extra }, SUPER2)
      expect(r.status, codeExpected).toBe(400)
      expect(r.body.code).toBe(codeExpected)
    }
    expect((await settlementOf(id)).status).toBe('approved')
    expect(await walletOf(org)).toEqual(before)
    expect(await auditRows(id, 'settlement.paid')).toHaveLength(0)
  }, T)

  it('Reason at the bounds (3 and 500 characters) is accepted', async () => {
    for (const reason of ['abc', 'x'.repeat(500)]) {
      const { id } = await approved()
      expect((await settle(id, { action: 'paid', reason, utrNumber: utr() }, SUPER2)).status).toBe(200)
    }
  }, T)

  it('UTR: missing, empty and malformed are refused, naming the UTR; nothing changes', async () => {
    const { id, org } = await approved()
    const before = await walletOf(org)
    for (const utrNumber of [undefined, '', '   ']) {
      const r = await settle(id, { action: 'paid', reason: 'bank transfer sent', ...(utrNumber === undefined ? {} : { utrNumber }) }, SUPER2)
      expect(r.status).toBe(422); expect(String(r.body.error)).toMatch(/utrNumber is required/)
    }
    for (const utrNumber of ['NEFT/12345', 'A'.repeat(65)]) {
      const r = await settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber }, SUPER2)
      expect(r.status).toBe(422); expect(r.body.code).toBe('UTR_INVALID')
    }
    expect((await settlementOf(id)).status).toBe('approved')
    expect(await walletOf(org)).toEqual(before)
  }, T)

  // ─── authorization & ADMIN_UIDS ──────────────────────────────────────────────
  it('D1: a non-admin and a legacy-claim-only caller are refused before any validation', async () => {
    const { id } = await approved()
    const outsider = await settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber: utr() }, OUTSIDER)
    expect(outsider).toMatchObject({ status: 403, body: { error: 'Forbidden' } })
    const claim = await settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber: utr() }, CLAIM)
    expect(claim.status).toBe(403); expect(claim.body.code).toBe('SUPER_ADMIN_REQUIRED')
    const anon = await settle(id, { action: 'paid', reason: 'x' }, '')
    expect(anon.status).toBe(403)
    expect((await settlementOf(id)).status).toBe('approved')
  }, T)

  it('missing ADMIN_UIDS (empty or unset) refuses every caller — fail closed', async () => {
    const { id } = await approved()
    for (const raw of ['', ' , ', undefined]) {
      if (raw === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = raw
      const r = await settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber: utr() }, SUPER2)
      expect(r.status, JSON.stringify(raw)).toBe(403)
    }
    process.env.ADMIN_UIDS = BOTH
    expect((await settlementOf(id)).status).toBe('approved')
  }, T)

  it('D2: the approver is refused (single-admin message when only one is configured); never bypassed', async () => {
    const { id, org } = await approved()
    const before = await walletOf(org)
    const two = await settle(id, { action: 'paid', reason: 'paid by the approver', utrNumber: utr() }, SUPER)
    expect(two.status).toBe(409); expect(two.body.code).toBe('MAKER_CHECKER_REQUIRED')
    expect(String(two.body.error)).toMatch(/Ask another Super Admin to record the payout/)
    process.env.ADMIN_UIDS = SUPER
    const one = await settle(id, { action: 'paid', reason: 'paid by the approver', utrNumber: utr() }, SUPER)
    expect(one.status).toBe(409); expect(one.body.code).toBe('MAKER_CHECKER_REQUIRED')
    expect(String(one.body.error)).toMatch(/Only one Super Admin is configured/)
    // a duplicate entry is still ONE Super Admin
    process.env.ADMIN_UIDS = `${SUPER}, ${SUPER} `
    expect(String((await settle(id, { action: 'paid', reason: 'paid by the approver', utrNumber: utr() }, SUPER)).body.error)).toMatch(/Only one Super Admin is configured/)
    expect((await settlementOf(id)).status).toBe('approved')
    expect(await walletOf(org)).toEqual(before)
    expect(await auditRows(id, 'settlement.paid')).toHaveLength(0)
  }, T)

  it('D2: a different Super Admin from a padded ADMIN_UIDS list records it; approval and payment each audited once', async () => {
    const { id } = await approved()
    process.env.ADMIN_UIDS = `  ${SUPER} ,  ${SUPER2}  ,`
    const r = await settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber: utr() }, SUPER2)
    expect(r).toMatchObject({ status: 200, body: { id, status: 'paid' } })
    expect(await settlementOf(id)).toMatchObject({ status: 'paid', approvedBy: SUPER, paidByAdmin: SUPER2 })
    const approvals = await auditRows(id, 'settlement.approved')
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ adminUid: SUPER, actorRole: 'super_admin', reason: 'documents checked' })
    const paid = await auditRows(id, 'settlement.paid')
    expect(paid).toHaveLength(1)
    expect(paid[0]).toMatchObject({ adminUid: SUPER2, actorRole: 'super_admin', metadata: { approvedBy: SUPER, makerChecker: 'distinct_approver' } })
  }, T)

  // ─── duplicates & states ─────────────────────────────────────────────────────
  it('a repeated submission is refused and the wallet is debited ONCE', async () => {
    const { id, org } = await approved(9_000)
    const before = await walletOf(org)
    const u = utr()
    expect((await settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber: u }, SUPER2)).status).toBe(200)
    const again = await settle(id, { action: 'paid', reason: 'bank transfer sent', utrNumber: u }, SUPER2)
    expect(again.status).toBe(409); expect(String(again.body.error)).toMatch(/current: 'paid'/)
    expect((await walletOf(org)).availablePaise).toBe(before.availablePaise - 9_000)
    expect(await auditRows(id, 'settlement.paid')).toHaveLength(1)
  }, T)

  it('two concurrent submissions: exactly one records the payout', async () => {
    const { id, org } = await approved(4_000)
    const before = await walletOf(org)
    const u = utr()
    const { PATCH } = await import('@/app/api/admin/settlements/[id]/route')
    h.admin = SUPER2
    const results = await Promise.all([0, 1].map(async () => json(await PATCH(req({ action: 'paid', reason: 'bank transfer sent', utrNumber: u }, 'PATCH'), ctx(id)))))
    h.admin = ''
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    expect((await walletOf(org)).availablePaise).toBe(before.availablePaise - 4_000)
    expect(await auditRows(id, 'settlement.paid')).toHaveLength(1)
  }, T)

  it('the same UTR cannot record a second payout', async () => {
    const a = await approved(), b = await approved()
    const u = utr()
    expect((await settle(a.id, { action: 'paid', reason: 'bank transfer sent', utrNumber: u }, SUPER2)).status).toBe(200)
    const r = await settle(b.id, { action: 'paid', reason: 'bank transfer sent', utrNumber: u.toLowerCase() }, SUPER2)
    expect(r.status).toBe(409); expect(r.body.code).toBe('UTR_IN_USE')
    expect((await settlementOf(b.id)).status).toBe('approved')
  }, T)

  it('invalid states: pending, rejected and unknown settlements cannot be marked paid', async () => {
    const org = await organizer()
    const pending = `smp-pending-${P}`, rejected = `smp-rejected-${P}`
    await put(`settlementRequests/${pending}`, { organizerUid: org, amountPaise: 1_000, status: 'pending', requestedAt: Timestamp.now(), approvedAt: null, paidAt: null, adminNote: '' })
    await put(`settlementRequests/${rejected}`, { organizerUid: org, amountPaise: 1_000, status: 'rejected', requestedAt: Timestamp.now(), approvedAt: null, paidAt: null, adminNote: '' })
    const p = await settle(pending, { action: 'paid', reason: 'bank transfer sent', utrNumber: utr() }, SUPER2)
    expect(p.status).toBe(409); expect(String(p.body.error)).toMatch(/current: 'pending'/)
    const x = await settle(rejected, { action: 'paid', reason: 'bank transfer sent', utrNumber: utr() }, SUPER2)
    expect(x.status).toBe(409); expect(String(x.body.error)).toMatch(/current: 'rejected'/)
    const missing = await settle(`smp-missing-${P}`, { action: 'paid', reason: 'bank transfer sent', utrNumber: utr() }, SUPER2)
    expect(missing.status).toBe(404)
    expect((await walletOf(org)).availablePaise).toBe(100_000)
  }, T)

  it('the console list exposes the approver (for the up-front D2 warning) to Super Admins only', async () => {
    const { id } = await approved()
    const { GET } = await import('@/app/api/admin/settlements/route')
    h.admin = SUPER2
    const list = await json(await GET(req(undefined, 'GET')))
    h.admin = ''
    expect(list.status).toBe(200)
    const row = (list.body.settlements as Array<Record<string, unknown>>).find(s => s.id === id)
    expect(row).toMatchObject({ id, status: 'approved', approvedBy: SUPER })
    h.admin = OUTSIDER
    expect((await GET(req(undefined, 'GET'))).status).toBe(403)
    h.admin = ''
  }, T)
})
