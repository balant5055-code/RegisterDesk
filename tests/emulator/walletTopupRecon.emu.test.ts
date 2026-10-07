// RD-WALLET-W2.d · S2 — the read-only communication-wallet reconciliation collectors, on REAL
// Firestore (private emulator). Proves: every discrepancy category is found with the right
// confidence, pages + stateless cursors cover everything exactly once, repeated runs agree,
// deadlines / budgets defer instead of guessing, and the collectors perform ZERO writes and never
// touch a payment provider.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `w2d_${process.pid}`

const h = vi.hoisted(() => ({ gatewayTouched: 0, writes: [] as string[] }))
// Any use of the Razorpay client fails the run: S1–S2 must never reach a payment provider.
vi.mock('@/lib/razorpay/client', () => new Proxy({}, {
  get(_t, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined
    h.gatewayTouched++
    throw new Error(`payment provider touched: ${String(key)}`)
  },
}))

describeEmu('RD-WALLET-W2.d · S2 read-only collectors on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let R: typeof import('@/lib/reconciliation/walletTopups')
  const cleanup: string[] = []
  const ts = (min: number) => FS.Timestamp.fromMillis(Date.UTC(2026, 8, 1) + min * 60_000)

  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); cleanup.push(path) }
  const O = (k: string) => `ord_${P}_${k}`
  const U = (k: string) => `${P}_${k}`
  const TU = U('topup_owner')

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    R = await import('@/lib/reconciliation/walletTopups')

    // ── top-ups (every category) ──
    const credited = (k: string, extra: Record<string, unknown> = {}) =>
      put(`walletTopups/${O(k)}`, { orderId: O(k), uid: TU, amountPaise: 50_000, currency: 'INR', status: 'credited', paymentId: `pay_${k}`, ...extra })
    const ledgerFor = (k: string, id = `topup_${O(k)}`, extra: Record<string, unknown> = {}) =>
      put(`walletTransactions/${id}`, { organizerUid: TU, type: 'fund_added', amountPaise: 50_000, balancePaise: 50_000, orderId: O(k), paymentId: `pay_${k}`, status: 'completed', ...extra })
    await credited('a'); await ledgerFor('a'); await put(`walletTopupReconciliation/${O('a')}`, { orderId: O('a'), uid: TU, status: 'resolved' })
    await credited('b'); await ledgerFor('b'); await ledgerFor('b', `${P}_dup_row_b`)
    await put(`walletTopups/${O('c')}`, { orderId: O('c'), uid: TU, amountPaise: 50_000, status: 'pending' }); await ledgerFor('c')
    await put(`walletTopups/${O('d')}`, { orderId: O('d'), uid: TU, amountPaise: 50_000, status: 'pending' })
    await put(`walletTopupReconciliation/${O('d')}`, { orderId: O('d'), uid: TU, status: 'resolved' })
    await credited('e'); await ledgerFor('e'); await put(`walletTopupReconciliation/${O('e')}`, { orderId: O('e'), uid: TU, status: 'needs_review' })
    await credited('f')                                                                          // legacy: no ledger row
    await credited('g'); await ledgerFor('g', undefined, { amountPaise: 40_000 })
    await credited('h'); await ledgerFor('h', undefined, { paymentId: 'pay_someone_else' })
    await put(`walletTopups/${O('i')}`, { orderId: O('i'), uid: TU, status: 'credited' })        // malformed: no amount
    await put(`walletTopups/${O('j')}`, { orderId: O('j'), uid: TU, amountPaise: 50_000, status: 'weird' })
    await put(`walletTopupReconciliation/${O('k')}`, { orderId: O('k'), uid: TU, status: 'needs_review' })   // orphan: no top-up
    await put(`walletTopupReconciliation/dup_${P}_bad`, { status: 'duplicate_payment' })         // malformed: no orderId

    // ── wallets (each judged by its own ledger chain) ──
    const wallet = (k: string, balancePaise: unknown) => put(`organizerWallets/${U(k)}`, { balancePaise, currency: 'INR' })
    let n = 0
    const tx = (k: string, type: string, amountPaise: number, balancePaise: number, at: number | null, extra: Record<string, unknown> = {}) =>
      put(`walletTransactions/${U(k)}_row_${++n}`, { organizerUid: U(k), type, amountPaise, balancePaise, status: 'completed', ...(at === null ? {} : { createdAt: ts(at) }), ...extra })
    await wallet('w1', 800);  await tx('w1', 'fund_added', 1000, 1000, 1); await tx('w1', 'whatsapp_charge', 200, 800, 2)
    await wallet('w2', 900);  await tx('w2', 'fund_added', 1000, 1000, 1); await tx('w2', 'whatsapp_charge', 200, 800, 2)
    await wallet('w3', 1500); await tx('w3', 'fund_added', 1000, 1500, 1)                         // 500 before the ledger began
    await wallet('w4', 1100); await tx('w4', 'fund_added', 1000, 1000, 1); await tx('w4', 'adjustment', 100, 1100, 2)
    await wallet('w5', 700);  await tx('w5', 'fund_added', 1000, 1000, 1); await tx('w5', 'whatsapp_charge', 200, 700, 2)
    await wallet('w6', 1000); await tx('w6', 'fund_added', 1000, 1000, 1); await tx('w6', 'whatsapp_charge', 100, 900, null)   // no createdAt
    await wallet('w7', 0)
    await wallet('w8', 500)
    await wallet('w9', 'abc')
    await wallet('w10', 500)
    await tx('w10', 'fund_added', 300, 300, 1); await tx('w10', 'fund_added', 300, 600, 2); await tx('w10', 'whatsapp_charge', 100, 500, 3)
    await tx('w10', 'refund', 100, 600, 4);     await tx('w10', 'certificate_charge', 100, 500, 5)
  }, T)
  afterAll(async () => { for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null) }, T)
  afterEach(() => { vi.restoreAllMocks() })

  // ── the read-only proof: trap every write API; snapshot the data before and after ──
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
  }
  const ours = (id: string | null | undefined) => typeof id === 'string' && id.includes(P)
  async function snapshot() {
    const out: Record<string, unknown> = {}
    for (const c of ['walletTopups', 'walletTopupReconciliation', 'walletTransactions', 'organizerWallets', 'reconciliationCursors', 'reconciliationReports', 'adminAuditLogs']) {
      const s = await adminDb.collection(c).get()
      out[c] = s.docs.filter(d => c === 'reconciliationCursors' || c === 'reconciliationReports' || c === 'adminAuditLogs' || ours(d.id) || ours(String((d.data() as { organizerUid?: unknown }).organizerUid ?? '')))
        .map(d => [d.id, d.data()]).sort()
    }
    return JSON.stringify(out)
  }
  /** Runs `fn` with every write trapped; asserts zero writes, no provider use, identical data. */
  async function readOnly<Tn>(fn: () => Promise<Tn>): Promise<Tn> {
    const before = await snapshot()
    h.writes = []; h.gatewayTouched = 0
    trapWrites()
    let result: Tn
    try { result = await fn() } finally { vi.restoreAllMocks() }
    expect(h.writes).toEqual([])
    expect(h.gatewayTouched).toBe(0)
    expect(await snapshot()).toBe(before)
    return result!
  }
  async function allPages<F extends { orderId?: string | null; uid?: string | null; recordId?: string }, Pg extends { findings: F[]; nextCursor: string | null; complete: boolean; scanned: number }>(
    run: (cursor: string | null) => Promise<Pg>,
  ) {
    const findings: F[] = []
    let cursor: string | null = null, pages = 0, scanned = 0, complete = false
    do {
      const pg: Pg = await run(cursor)
      findings.push(...pg.findings); scanned += pg.scanned; pages++
      cursor = pg.nextCursor; complete = pg.complete
    } while (cursor !== null && pages < 500)
    return { findings, pages, scanned, complete }
  }
  const key = (f: { code: string; confidence: string }) => `${f.code}:${f.confidence}`

  it('top-ups: every category found with the right confidence — reading only', async () => {
    const { findings, complete } = await readOnly(() => allPages(c => R.reconcileTopupsPage({ cursor: c, limit: 500 })))
    expect(complete).toBe(true)
    const by = (k: string) => findings.filter(f => f.orderId === O(k)).map(key).sort()
    expect(by('a')).toEqual([])
    expect(by('b')).toEqual(['duplicate_credit:confirmed'])
    expect(by('c')).toEqual(['ledger_without_credit:confirmed'])
    expect(by('d')).toEqual(['resolved_without_credit:confirmed'])
    expect(by('e')).toEqual(['hold_on_credited_topup:confirmed'])
    expect(by('f')).toEqual(['credit_without_ledger:inconclusive'])                              // legacy, never a loss
    expect(by('g')).toEqual(['ledger_amount_mismatch:confirmed'])
    expect(by('h')).toEqual(['ledger_payment_mismatch:confirmed'])
    expect(by('i')).toEqual(['topup_malformed:inconclusive'])
    expect(by('j')).toEqual(['topup_status_unknown:inconclusive'])
    // no raw payloads: a finding carries ids, codes and small scalar details only
    for (const f of findings.filter(x => ours(x.orderId))) {
      expect(Object.keys(f).sort()).toEqual(expect.arrayContaining(['code', 'confidence', 'orderId', 'scope', 'uid']))
      for (const v of Object.values(f.detail ?? {})) expect(['string', 'number', 'boolean'].includes(typeof v) || v === null).toBe(true)
    }
  }, T)

  it('reconciliation records: an orphan (no top-up) is probable, a malformed record inconclusive', async () => {
    const { findings } = await readOnly(() => allPages(c => R.reconcileTopupRecordsPage({ cursor: c, limit: 500 })))
    expect(findings.filter(f => f.recordId === O('k')).map(key)).toEqual(['reconciliation_without_topup:probable'])
    expect(findings.filter(f => f.recordId === `dup_${P}_bad`).map(key)).toEqual(['reconciliation_malformed:inconclusive'])
    expect(findings.filter(f => f.recordId === O('a') || f.recordId === O('e'))).toEqual([])
  }, T)

  it('wallets: balance claims only on an unbroken chain from 0; everything else inconclusive with its reason', async () => {
    const { findings, complete } = await readOnly(() => allPages(c => R.reconcileCommunicationWalletsPage({ cursor: c, limit: 100 })))
    expect(complete).toBe(true)
    const by = (k: string) => findings.filter(f => f.uid === U(k))
    expect(by('w1')).toEqual([])                                                                  // verified
    expect(by('w2').map(key)).toEqual(['balance_mismatch:confirmed'])
    expect(by('w2')[0].detail).toMatchObject({ walletBalancePaise: 900, ledgerBalancePaise: 800, deltaPaise: 100 })
    const reason = (k: string) => by(k).map(f => `${key(f)}:${f.detail?.reason}`)
    expect(reason('w3')).toEqual(['balance_unverifiable:inconclusive:ledger_history_incomplete'])   // legacy
    expect(reason('w4')).toEqual(['balance_unverifiable:inconclusive:ledger_type_ambiguous'])       // adjustment
    expect(reason('w5')).toEqual(['balance_unverifiable:inconclusive:ledger_chain_gap'])
    expect(reason('w6')).toEqual(['balance_unverifiable:inconclusive:ledger_rows_unaccounted'])     // a row without createdAt
    expect(by('w7')).toEqual([])                                                                  // empty and zero
    expect(reason('w8')).toEqual(['balance_unverifiable:inconclusive:ledger_history_incomplete'])   // balance, no rows
    expect(reason('w9')).toEqual(['balance_unverifiable:inconclusive:wallet_malformed'])
    expect(by('w10')).toEqual([])                                                                 // 5-row chain verifies
  }, T)

  it('wallets: a per-wallet row budget truncates to inconclusive (never a guess) and flags the page', async () => {
    const { pages, findings, truncatedSeen } = await readOnly(async () => {
      let cursor: string | null = null, pages = 0, truncatedSeen = false
      const findings: Array<{ uid: string; detail?: Record<string, unknown> }> = []
      do {
        const pg = await R.reconcileCommunicationWalletsPage({ cursor, limit: 100, ledgerRowsPerWallet: 3 })
        findings.push(...pg.findings); truncatedSeen ||= pg.truncated; cursor = pg.nextCursor; pages++
      } while (cursor !== null && pages < 100)
      return { pages, findings, truncatedSeen }
    })
    expect(pages).toBeGreaterThan(0)
    expect(truncatedSeen).toBe(true)
    expect(findings.filter(f => f.uid === U('w10')).map(f => f.detail?.reason)).toEqual(['ledger_scan_truncated'])
    expect(findings.filter(f => f.uid === U('w1'))).toEqual([])                                   // 2 rows: within budget
  }, T)

  it('pagination: small pages + stateless cursors reach every entity exactly once and match a single big page', async () => {
    const big = await readOnly(() => allPages(c => R.reconcileTopupsPage({ cursor: c, limit: 500 })))
    const small = await readOnly(() => allPages(c => R.reconcileTopupsPage({ cursor: c, limit: 3 })))
    expect(small.pages).toBeGreaterThan(3)
    expect(small.scanned).toBe(big.scanned)
    const norm = (fs: Array<{ orderId?: string | null; code: string; confidence: string }>) => fs.filter(f => ours(f.orderId)).map(f => `${f.orderId}|${key(f)}`).sort()
    expect(norm(small.findings)).toEqual(norm(big.findings))

    const wBig = await readOnly(() => allPages(c => R.reconcileCommunicationWalletsPage({ cursor: c, limit: 100 })))
    const wSmall = await readOnly(() => allPages(c => R.reconcileCommunicationWalletsPage({ cursor: c, limit: 2 })))
    expect(wSmall.scanned).toBe(wBig.scanned)
    const wNorm = (fs: Array<{ uid?: string | null; code: string; confidence: string; detail?: Record<string, unknown> }>) =>
      fs.filter(f => ours(f.uid)).map(f => `${f.uid}|${key(f)}|${f.detail?.reason ?? ''}`).sort()
    expect(wNorm(wSmall.findings)).toEqual(wNorm(wBig.findings))
  }, T)

  it('repeatability: the same cursor over the same data gives the same page', async () => {
    const first  = await readOnly(() => R.reconcileTopupsPage({ cursor: null, limit: 4 }))
    const again  = await readOnly(() => R.reconcileTopupsPage({ cursor: null, limit: 4 }))
    expect(JSON.stringify(again)).toBe(JSON.stringify(first))
    const next1 = await readOnly(() => R.reconcileTopupsPage({ cursor: first.nextCursor, limit: 4 }))
    const next2 = await readOnly(() => R.reconcileTopupsPage({ cursor: first.nextCursor, limit: 4 }))
    expect(JSON.stringify(next2)).toBe(JSON.stringify(next1))
    const w1 = await readOnly(() => R.reconcileCommunicationWalletsPage({ cursor: null, limit: 5 }))
    const w2 = await readOnly(() => R.reconcileCommunicationWalletsPage({ cursor: null, limit: 5 }))
    expect(JSON.stringify(w2)).toBe(JSON.stringify(w1))
  }, T)

  it('incomplete scans: a passed deadline processes nothing, defers the page and keeps the cursor', async () => {
    for (const run of [
      (c: string | null) => R.reconcileTopupsPage({ cursor: c, limit: 5, deadlineAtMs: Date.now() - 1 }),
      (c: string | null) => R.reconcileTopupRecordsPage({ cursor: c, limit: 5, deadlineAtMs: Date.now() - 1 }),
      (c: string | null) => R.reconcileCommunicationWalletsPage({ cursor: c, limit: 5, deadlineAtMs: Date.now() - 1 }),
    ]) {
      const pg = await readOnly(() => run('0'))
      expect(pg).toMatchObject({ scanned: 0, complete: false, nextCursor: '0', findings: [] })
      expect(pg.deferred).toBeGreaterThan(0)
    }
  }, T)
})
