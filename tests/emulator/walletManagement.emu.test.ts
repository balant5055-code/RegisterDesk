// RD-WALLET-W2.e — Super Admin Wallet Management on REAL Firestore (private emulator), through
// the REAL route and the REAL requireSuperAdmin gate. Identity is stubbed at the token boundary
// only (lib/admin/auth): 'super' is in ADMIN_UIDS, 'plain' holds only the legacy admin claim.
// Every authorized call runs with ALL Firestore write APIs trapped and the payment provider
// trapped, and the data is snapshotted before/after: the console reads, and only reads.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `w2e_${process.pid}`

const h = vi.hoisted(() => ({ writes: [] as string[], gatewayTouched: 0, paymentEventsTouched: [] as string[] }))
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', async orig => ({
  ...(await orig<typeof import('@/lib/admin/auth')>()),
  resolveAdminUid: async (header: string | null) => (header === 'Bearer super' ? 'super-uid' : null),
  legacyAdminClaimOnly: async (header: string | null) => header === 'Bearer plain',
  resolveSuperAdminUid: async (header: string | null) => (header === 'Bearer super' ? 'super-uid' : null),
}))
vi.mock('@/lib/razorpay/client', () => new Proxy({}, {
  get(_t, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined
    h.gatewayTouched++
    throw new Error(`payment provider touched: ${String(key)}`)
  },
}))

describeEmu('RD-WALLET-W2.e · Wallet Management (read-only, Super Admin) on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let GET: (req: NextRequest) => Promise<Response>
  const cleanup: string[] = []
  const MEDIA_ONLY = `${P}_media_only`
  const U = `${P}_org`, SLUG = `${P}-run`, DRAFT = `${P}_draft`, R1 = `${P}_refund`
  const ts = (min: number) => FS.Timestamp.fromMillis(Date.UTC(2026, 8, 1) + min * 60_000)
  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); cleanup.push(path) }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ GET } = await import('@/app/api/admin/wallet-management/route'))

    await put(`users/${U}`, { uid: U, name: 'W2E Organizer', email: `${P}@example.test`, role: 'organizer' })
    // communication wallet with a verifiable ledger chain: +1000 → −200 = 800
    await put(`organizerWallets/${U}`, { balancePaise: 80_000, currency: 'INR', updatedAt: ts(5) })
    await put(`walletTransactions/topup_${P}_o1`, { organizerUid: U, type: 'fund_added', amountPaise: 100_000, balancePaise: 100_000, orderId: `${P}_o1`, paymentId: `${P}_pay1`, status: 'completed', referenceType: 'razorpay', createdAt: ts(1) })
    await put(`walletTransactions/whatsapp_${P}_r1`, { organizerUid: U, type: 'whatsapp_charge', amountPaise: 20_000, balancePaise: 80_000, status: 'completed', referenceType: 'communication', createdAt: ts(2) })
    await put(`walletTopups/${P}_o1`, { orderId: `${P}_o1`, uid: U, amountPaise: 100_000, currency: 'INR', status: 'credited', paymentId: `${P}_pay1`, createdAt: ts(0) })
    await put(`walletTopups/${P}_o2`, { orderId: `${P}_o2`, uid: U, amountPaise: 50_000, currency: 'INR', status: 'pending', createdAt: ts(3) })
    await put(`walletTransactions/topup_${P}_o2`, { organizerUid: `${P}_other`, type: 'fund_added', amountPaise: 50_000, balancePaise: 50_000, orderId: `${P}_o2`, status: 'completed', createdAt: ts(3) })   // ledger without credit
    await put(`walletTopupReconciliation/${P}_o2`, { orderId: `${P}_o2`, uid: U, status: 'needs_review', paymentIds: [`${P}_pay2`], attempts: 1, lastError: 'held for review' })
    // event services: live event → licence (capacity) + counter + allowance ledger
    await put(`events/${SLUG}`, { uid: U, draftId: DRAFT, eventDetails: { info: { name: 'W2E Run' } } })
    await put(`eventLicenses/${SLUG}`, { eventId: SLUG, organizerUid: U, tier: 'growth', status: 'active', commercialModel: 'capacity', capacity: 500, amountPaise: 0 })
    await put(`registrationCounters/${SLUG}`, { totalCount: 120 })
    await put(`eventServiceAllowances/${DRAFT}`, { draftId: DRAFT, organizerUid: U, whatsapp: { purchased: 100, consumed: 30, onExhausted: 'block' }, certificates: { purchased: 50, consumed: 0, onExhausted: null }, media: { purchased: 200, consumed: 0, onExhausted: null } })
    // media credits
    await put(`mediaCreditWallets/${U}`, { organizerUid: U, schemaVersion: 1, balance: 40, heldCredits: 5, refundHeldCredits: 2, lifetimeGranted: 60, lifetimeConsumed: 20, updatedAt: ts(4) })
    // W2.e.1 — an organizer with ONLY a media-credit wallet (no communication wallet)
    await put(`users/${MEDIA_ONLY}`, { uid: MEDIA_ONLY, name: 'Media Only Org', role: 'organizer' })
    await put(`mediaCreditWallets/${MEDIA_ONLY}`, { organizerUid: MEDIA_ONLY, schemaVersion: 1, balance: 7, heldCredits: 0, lifetimeGranted: 7, lifetimeConsumed: 0, updatedAt: ts(4) })
    await put(`mediaCreditRefunds/${R1}`, { refundId: R1, schemaVersion: 1, organizerUid: U, credits: 10, purchaseId: `${P}_purchase`, reason: 'event cancelled', status: 'requested', requestedBy: U, decidedBy: null, decisionNote: null, purchaseAmountPaise: 5_000, createdAt: ts(6) })
  }, T)
  afterAll(async () => { for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null) }, T)
  afterEach(() => { vi.restoreAllMocks() })

  const call = (auth: string | null, qs: Record<string, string>) =>
    GET(new NextRequest(`http://localhost/api/admin/wallet-management?${new URLSearchParams(qs)}`, { headers: auth ? { authorization: auth } : {} }))

  function trapWrites() {
    const trap = (proto: object, names: string[], label: string) => {
      for (const name of names) {
        vi.spyOn(proto as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(() => {
          h.writes.push(`${label}.${name}`)
          throw new Error(`write attempted: ${label}.${name}`)
        })
      }
    }
    trap(FS.DocumentReference.prototype, ['set', 'update', 'delete', 'create'], 'DocumentReference')
    trap(FS.CollectionReference.prototype, ['add'], 'CollectionReference')
    trap(FS.WriteBatch.prototype, ['set', 'update', 'delete', 'create', 'commit'], 'WriteBatch')
    trap(FS.Transaction.prototype, ['set', 'update', 'delete', 'create'], 'Transaction')
    trap(FS.Firestore.prototype, ['runTransaction', 'batch', 'bulkWriter', 'recursiveDelete'], 'Firestore')
    // W2.d S3 — record (and call through) every collection / doc / collection-group access, so a
    // read of paymentEvents is caught even though reads are otherwise allowed.
    for (const name of ['collection', 'doc', 'collectionGroup'] as const) {
      const real = FS.Firestore.prototype[name] as (...a: unknown[]) => unknown
      vi.spyOn(FS.Firestore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (typeof args[0] === 'string' && args[0].includes('paymentEvents')) h.paymentEventsTouched.push(`${name}:${args[0]}`)
        return real.apply(this, args)
      })
    }
  }
  const COLLS = ['users', 'organizerWallets', 'walletTransactions', 'walletTopups', 'walletTopupReconciliation', 'events', 'eventLicenses',
    'registrationCounters', 'eventServiceAllowances', 'mediaCreditWallets', 'mediaCreditRefunds', 'reconciliationCursors', 'reconciliationReports', 'adminAuditLogs']
  async function snapshot() {
    const out: Record<string, unknown> = {}
    for (const c of COLLS) out[c] = (await adminDb.collection(c).get()).docs.map(d => [d.id, d.data()]).sort()
    return JSON.stringify(out)
  }
  /** One authorized call with every write trapped; returns status + body. */
  async function superRead(qs: Record<string, string>) {
    const before = await snapshot()
    h.writes = []; h.gatewayTouched = 0; h.paymentEventsTouched = []
    trapWrites()
    let res: Response
    try { res = await call('Bearer super', qs) } finally { vi.restoreAllMocks() }
    expect(h.writes).toEqual([])
    expect(h.gatewayTouched).toBe(0)
    expect(h.paymentEventsTouched).toEqual([])
    expect(await snapshot()).toBe(before)
    return { status: res!.status, body: await res!.json() as Record<string, unknown> }
  }

  it('authorization: no token → 403; legacy admin:true only → 403 SUPER_ADMIN_REQUIRED; Super Admin → 200 — for every view', async () => {
    for (const view of ['overview', 'organizers', 'events', 'transactions', 'refunds', 'reconciliation']) {
      const anon = await call(null, { view })
      expect(anon.status, view).toBe(403)
      expect(await anon.json()).toEqual({ error: 'Forbidden' })
      const plain = await call('Bearer plain', { view })
      expect(plain.status, view).toBe(403)
      expect(await plain.json()).toMatchObject({ code: 'SUPER_ADMIN_REQUIRED' })
    }
    const detail = await call('Bearer plain', { view: 'organizer', uid: U })
    expect(detail.status).toBe(403)
    expect((await superRead({ view: 'overview' })).status).toBe(200)
  }, T)

  it('overview: aggregates only, and the unavailable sources are stated', async () => {
    const { status, body } = await superRead({ view: 'overview' })
    expect(status).toBe(200)
    const c = body.communication as Record<string, unknown>
    expect(c.wallets as number).toBeGreaterThanOrEqual(1)
    expect((c.topupsByStatus as Record<string, number>).credited).toBeGreaterThanOrEqual(1)
    expect((c.openReconciliation as Record<string, number>).needs_review).toBeGreaterThanOrEqual(1)
    expect(((body.media as Record<string, unknown>).openRefunds as Record<string, number>).requested).toBeGreaterThanOrEqual(1)
    expect(Object.keys(body.unavailable as object).sort()).toEqual(['carryForward', 'communicationRefunds', 'mediaUsage', 'smsAllowance'])
  }, T)

  it('organizer wallets: paged by document id; search by exact uid or email; communication + media balances', async () => {
    const seen: string[] = []
    let cursor: string | null = null, pages = 0
    do {
      const { body } = await superRead({ view: 'organizers', limit: '1', ...(cursor ? { cursor } : {}) })
      for (const r of body.rows as Array<{ uid: string }>) seen.push(r.uid)
      cursor = body.nextCursor as string | null; pages++
    } while (cursor && pages < 200)
    expect(seen).toContain(U)
    expect(seen).toContain(MEDIA_ONLY)                                                     // W2.e.1 — media-only wallets page too
    expect(new Set(seen).size).toBe(seen.length)                                           // each once
    expect([...seen].sort()).toEqual(seen.slice().sort())                                  // in document-id order
    const big = await superRead({ view: 'organizers', limit: '50' })
    const rowsBig = big.body.rows as Array<{ uid: string; communication: { exists: boolean }; media: { exists: boolean; balance: number | null } }>
    expect(rowsBig.find(r => r.uid === MEDIA_ONLY)).toMatchObject({ communication: { exists: false }, media: { exists: true, balance: 7 } })

    for (const search of [U, `${P}@example.test`]) {
      const { body } = await superRead({ view: 'organizers', search })
      expect(body.rows).toEqual([expect.objectContaining({
        uid: U, name: 'W2E Organizer',
        communication: expect.objectContaining({ exists: true, balancePaise: 80_000, balanceValid: true }),
        media: { exists: true, balance: 40, heldCredits: 5, refundHeldCredits: 2 },
      })])
    }
    expect((await superRead({ view: 'organizers', search: 'nobody@example.test' })).body.rows).toEqual([])
  }, T)

  it('organizer detail: W2.d ledger verdict, top-ups, held records, events with capacity + allowances, media credits', async () => {
    const { status, body } = await superRead({ view: 'organizer', uid: U })
    expect(status).toBe(200)
    expect(body.walletCheck).toEqual({ verdict: 'verified', finding: null })
    expect((body.topups as Array<{ orderId: string }>).map(t => t.orderId)).toEqual([`${P}_o2`, `${P}_o1`])   // newest first
    expect(body.reconciliationRecords).toEqual([expect.objectContaining({ id: `${P}_o2`, status: 'needs_review', paymentIds: [`${P}_pay2`] })])
    const ev = (body.events as Array<Record<string, unknown>>).find(e => e.draftId === DRAFT)!
    expect(ev).toMatchObject({
      slug: SLUG, name: 'W2E Run', organizerUid: U, registrations: 120,
      license: { exists: true, tier: 'growth', status: 'active', capacity: 500, capacityRecorded: true },
      services: {
        whatsapp: { purchased: 100, consumed: 30, remaining: 70, onExhausted: 'block' },
        certificates: { purchased: 50, consumed: 0, remaining: 50 },
        media: { purchased: 200, consumed: null, remaining: null },                       // usage is not a ledger counter
      },
    })
    expect((body.media as Record<string, unknown>).wallet).toMatchObject({ balance: 40, heldCredits: 5, refundHeldCredits: 2 })
    expect(((body.media as Record<string, unknown>).refunds as Array<{ refundId: string }>).map(r => r.refundId)).toEqual([R1])
    expect((await superRead({ view: 'organizer', uid: 'bad uid!' })).status).toBe(400)
  }, T)

  it('event services: allowance ledgers with licence capacity, filterable by organizer', async () => {
    const { body } = await superRead({ view: 'events', organizerUid: U })
    expect((body.rows as Array<{ draftId: string }>).map(r => r.draftId)).toEqual([DRAFT])
    expect(body.nextCursor).toBeNull()
  }, T)

  it('transactions: per organizer, newest first, signed by the wallet rule; sign filter; paging', async () => {
    const all = await superRead({ view: 'transactions', organizerUid: U })
    const rows = all.body.rows as Array<{ id: string; sign: string; type: string }>
    expect(rows.map(r => [r.id, r.sign])).toEqual([[`whatsapp_${P}_r1`, 'debit'], [`topup_${P}_o1`, 'credit']])
    const credits = await superRead({ view: 'transactions', organizerUid: U, sign: 'credit' })
    expect((credits.body.rows as Array<{ id: string }>).map(r => r.id)).toEqual([`topup_${P}_o1`])
    const p1 = await superRead({ view: 'transactions', organizerUid: U, limit: '1' })
    expect((p1.body.rows as Array<{ id: string }>).map(r => r.id)).toEqual([`whatsapp_${P}_r1`])
    const p2 = await superRead({ view: 'transactions', organizerUid: U, limit: '1', cursor: String(p1.body.nextCursor) })
    expect((p2.body.rows as Array<{ id: string }>).map(r => r.id)).toEqual([`topup_${P}_o1`])
    expect(p2.body.nextCursor).toBeNull()
  }, T)

  it('refund requests: media-credit refunds by recorded status', async () => {
    const { body } = await superRead({ view: 'refunds', status: 'requested' })
    expect((body.rows as Array<{ refundId: string }>).map(r => r.refundId)).toContain(R1)
    const settled = await superRead({ view: 'refunds', status: 'settled' })
    expect((settled.body.rows as Array<{ refundId: string }>).map(r => r.refundId)).not.toContain(R1)
  }, T)

  it('reconciliation: the W2.d report with its confidence, read-only', async () => {
    let cursor: string | null = null, pages = 0
    const findings: Array<{ orderId?: string; code: string; confidence: string }> = []
    do {
      const { body } = await superRead({ view: 'reconciliation', kind: 'topups', ...(cursor ? { cursor } : {}) })
      findings.push(...(body.findings as typeof findings)); cursor = body.nextCursor as string | null; pages++
    } while (cursor && pages < 100)
    expect(findings.filter(f => f.orderId === `${P}_o2`).map(f => `${f.code}:${f.confidence}`)).toEqual(['ledger_without_credit:confirmed'])
    expect(findings.filter(f => f.orderId === `${P}_o1`)).toEqual([])
  }, T)

  it('bad input: an unknown view or a missing uid is a 400, not a guess', async () => {
    expect((await superRead({ view: 'nonsense' })).status).toBe(400)
    expect((await superRead({ view: 'organizer' })).status).toBe(400)
  }, T)

  // ═══ W2.d S3 · gateway evidence (mock-only; production not enabled) ═══════════════════════════
  it('S3 · gateway=1: still Super Admin only; in production it is NOT ENABLED — no provider call, no paymentEvents access, no writes, S2 findings unchanged', async () => {
    for (const auth of [null, 'Bearer plain']) {
      const res = await call(auth, { view: 'reconciliation', kind: 'topups', gateway: '1' })
      expect(res.status).toBe(403)
    }
    const plain = await superRead({ view: 'reconciliation', kind: 'topups' })
    const withGateway = await superRead({ view: 'reconciliation', kind: 'topups', gateway: '1' })
    expect(withGateway.status).toBe(200)
    expect(withGateway.body.gateway).toEqual({
      enabled: false, source: 'disabled', reason: 'gateway_verification_not_enabled',
      findings: [], checked: 0, creditsVerified: 0, deferred: expect.any(Number), calls: 0, circuitOpen: false,
      // G1 — position fields; nothing is checked, so nothing is missing and there is no resume point
      pageCandidates: expect.any(Number), missing: 0, pageComplete: expect.any(Boolean), nextAfter: null,
      pageUnverifiable: expect.any(Number),                                               // F3 — counted, never checked
    })
    expect(withGateway.body.findings).toEqual(plain.body.findings)                        // S2 untouched
    expect(plain.body.gateway).toBeUndefined()                                             // on demand only
  }, T)

  it('S3 · with an injected MOCK provider (tests only): gateway findings are labelled mock, reads stay read-only, data unchanged', async () => {
    const { getReconciliationPage } = await import('@/lib/admin/walletManagementService')
    const { createMockGatewayProvider } = await import('@/lib/reconciliation/walletTopupsGateway')
    const mock = createMockGatewayProvider({
      orderPayments: { [`${P}_o2`]: { items: [{ id: `${P}_mockpay`, order_id: `${P}_o2`, status: 'captured', amount: 50_000, currency: 'INR' }] } },
    })
    const before = await snapshot()
    h.writes = []; h.gatewayTouched = 0; h.paymentEventsTouched = []
    trapWrites()
    let page: Awaited<ReturnType<typeof getReconciliationPage>>
    try { page = await getReconciliationPage({ kind: 'topups', gateway: true, limit: 500 }, { gatewayProvider: mock }) } finally { vi.restoreAllMocks() }
    expect(h.writes).toEqual([])
    expect(h.gatewayTouched).toBe(0)                                                       // the real client is never touched
    expect(h.paymentEventsTouched).toEqual([])
    expect(await snapshot()).toBe(before)
    const g = (page! as { gateway?: { enabled: boolean; source: string; findings: Array<{ orderId: string; code: string; confidence: string; source: string }> } }).gateway!
    expect(g).toMatchObject({ enabled: true, source: 'mock' })
    const ours = g.findings.filter(f => f.orderId === `${P}_o2`)
    // RegisterDesk holds the order pending (and a recorded payment id the mock list does not show)
    expect(ours.map(f => `${f.code}:${f.confidence}`).sort()).toEqual(['gateway_captured_without_credit:confirmed', 'gateway_list_incomplete:inconclusive'])
    for (const f of g.findings) expect(f.source).toBe('mock')
    expect(mock.calls).toContain(`orderPayments:${P}_o2`)
  }, T)

  it('G1/G2 · with the injected MOCK: "Check next" walks every flagged order once — within a page and across pages — read-only', async () => {
    const { getReconciliationPage } = await import('@/lib/admin/walletManagementService')
    const { createMockGatewayProvider } = await import('@/lib/reconciliation/walletTopupsGateway')
    const { GATEWAY_START, nextGatewayPosition } = await import('@/app/(admin)/admin/wallet-management/gatewayProgress')
    // 24 consecutive flagged top-ups (an unknown status is always flagged). With 20-row pages, one
    // page holds ≥ 12 of them (> 10 per request → in-page continuation), and there are ≥ 2 pages.
    const ours = Array.from({ length: 24 }, (_, i) => `${P}_g${String(i + 1).padStart(2, '0')}`)
    for (const id of ours) await put(`walletTopups/${id}`, { orderId: id, uid: U, amountPaise: 10_000, currency: 'INR', status: 'mystery_state', createdAt: ts(7) })
    const mock = createMockGatewayProvider({ orderPayments: Object.fromEntries(ours.map(id => [id, { items: [] }])) })

    const before = await snapshot()
    h.writes = []; h.gatewayTouched = 0; h.paymentEventsTouched = []
    trapWrites()
    const cursors = new Set<string | null>()
    let inPage = 0
    try {
      let pos: { cursor: string | null; after: string | null } | null = GATEWAY_START
      for (let n = 0; pos && n < 500; n++) {
        cursors.add(pos.cursor)
        const page = await getReconciliationPage({ kind: 'topups', gateway: true, limit: 20, cursor: pos.cursor, gatewayAfter: pos.after }, { gatewayProvider: mock }) as
          { nextCursor: string | null; gateway: import('@/lib/admin/walletManagementService').GatewayPageReport }
        expect(page.gateway.calls).toBeLessThanOrEqual(25)
        expect(page.gateway.checked).toBeLessThanOrEqual(10)
        if (!page.gateway.pageComplete) inPage++
        pos = nextGatewayPosition(pos, page.gateway, page.nextCursor)
      }
      expect(pos).toBeNull()                                                       // the walk reached the end
    } finally { vi.restoreAllMocks() }
    expect(h.writes).toEqual([])
    expect(h.gatewayTouched).toBe(0)
    expect(h.paymentEventsTouched).toEqual([])
    expect(await snapshot()).toBe(before)

    const checked = mock.calls.map(c => c.split(':')[1])
    expect(new Set(checked).size).toBe(checked.length)                           // no order checked twice
    for (const id of ours) expect(checked, id).toContain(id)                     // none skipped
    expect(inPage).toBeGreaterThan(0)                                            // continued inside a page
    expect(cursors.size).toBeGreaterThan(1)                                      // and across pages
  }, T)
})
