// FINAL WALLET FINANCIAL / DATA-CORRECTNESS AUDIT (2026-10-05) — real Firestore (private emulator),
// real settlement (activateAddonOrder), real consumption (reserveServiceUnits), real routes.
//
// Every expected figure here is computed INDEPENDENTLY from the purchase lines the test creates
// (quantity, unit price, GST) and the business rules — never read back from the implementation:
//   • usage consumes the OLDEST purchase line first;
//   • only unused units of the event's own purchases are refundable / carryable;
//   • each unit is worth (its line's paid total ÷ its line's quantity), floored per line;
//   • a refund never exceeds what was paid; refunded / carried units never become usable again.
// No payment provider is reachable (the Razorpay client throws if touched).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `wfa${process.pid}`

const h = vi.hoisted(() => ({ who: '', superUid: '', plainUid: '' }))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.who && h.who === h.superUid ? h.who : null),
  legacyAdminClaimOnly: async () => !!h.who && h.who === h.plainUid,
  resolveSuperAdminUid: async () => (h.who && h.who === h.superUid ? h.superUid : null),
}))
vi.mock('@/lib/razorpay/client', () => new Proxy({}, {
  get(_t, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined
    throw new Error(`payment provider touched: ${String(key)}`)
  },
}))

type Body = Record<string, unknown>
const GST = 18
/** Independent re-statement of the GST rule (integer paise, half-up). */
const lineTotal = (qty: number, unit: number) => qty * unit + Math.round((qty * unit * GST) / 100)

describeEmu('Wallet financial audit (real settlement, real consumption, real routes)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let svcs: typeof import('@/lib/licensing/serviceAllowances')
  let ledgerMod: typeof import('@/lib/licensing/serviceAllowanceLedger')
  let commerce: typeof import('@/lib/licensing/draftCommerce')
  const cleanup: string[] = []
  const ledgers: string[] = []
  // RD-CE-FIX M2 — production shape: publish and every lifecycle transition mirror the lifecycle and
  // closure stamps onto the SERVER-written live event, and the Wallet now reads them THERE (the draft
  // is client-written). So a seeded non-draft event also gets its live document, as publish makes it.
  const LIFE_KEYS = ['lifecycleStatus', 'completedAt', 'cancelledAt', 'archivedAt', 'restoredAt']
  const mirrorLive = async (path: string, data: Record<string, unknown>) => {
    const m = /^users\/([^/]+)\/eventDrafts\/([^/]+)$/.exec(path)
    if (!m || typeof data.lifecycleStatus !== 'string' || data.lifecycleStatus === 'draft') return
    const seo = ((data.eventDetails as Record<string, unknown> | undefined)?.seo as Record<string, unknown> | undefined) ?? {}
    const slug = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : m[2]
    if (slug === m[2] && !seo.urlSlug) await adminDb.doc(path).set({ eventDetails: { seo: { urlSlug: slug } } }, { merge: true })
    await adminDb.doc(`events/${slug}`).set({ uid: m[1], draftId: m[2], ...Object.fromEntries(LIFE_KEYS.filter(k => k in data).map(k => [k, data[k]])) }, { merge: true })
    cleanup.push(`events/${slug}`)
  }
  /** A lifecycle change, applied where the server applies it: the draft AND its live event. */
  const lifecycle = async (uid: string, id: string, patch: Record<string, unknown>) => {
    await adminDb.doc(`users/${uid}/eventDrafts/${id}`).update(patch)
    const slug = (((await adminDb.doc(`users/${uid}/eventDrafts/${id}`).get()).get('eventDetails.seo.urlSlug')) as string | undefined) ?? id
    await adminDb.doc(`events/${slug}`).set({ uid, draftId: id, ...patch }, { merge: true })
    cleanup.push(`events/${slug}`)
  }
  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); cleanup.push(path); await mirrorLive(path, data) }
  const ago = (d: number) => FS.Timestamp.fromMillis(Date.now() - d * 86_400_000)
  // 2026-10-06 — the refund window is 24 HOURS from closure: "recently closed" is hours old.
  const closedAgo = (hours: number) => FS.Timestamp.fromMillis(Date.now() - hours * 3_600_000)

  const U = `${P}_org`, V = `${P}_other`, SUPER = `${P}_super`, PLAIN = `${P}_plain`
  const ev = (k: string) => `${P}_${k}`
  const closedDraft = (name: string, extra: Record<string, unknown> = {}) => ({
    eventDetails: { info: { name } }, status: 'published', lifecycleStatus: 'completed', completedAt: closedAgo(3), updatedAt: ago(1), ...extra,
  })

  /** A genuinely consistent add-on order in `created` state, exactly as purchaseAddon writes it. */
  let seq = 0
  const order = async (draftId: string, lines: Array<[string, number, number, Record<string, unknown>?]>, over: Record<string, unknown> = {}) => {
    const items = lines.map(([s, q, unit, extra]) => ({
      ...svcs.priceServiceItem(s as never, q, { enabled: true, unitPricePaise: unit, gstRatePercent: GST, minQuantity: 1, onExhausted: 'block' } as never),
      ...(extra ?? {}),
    }))
    const amount = items.reduce((n, i) => n + i.totalPaise, 0)
    const id = `add_${draftId}_${++seq}`
    await put(`licenseOrders/${id}`, {
      orderId: id, eventId: draftId, organizerUid: U, tier: 'starter', fromTier: null, purpose: 'addon',
      amountPaise: amount, currency: 'INR', status: 'created', razorpayOrderId: `order_${id}`, razorpayPaymentId: null,
      razorpayAmountPaise: amount, serviceItems: items, servicesTotalPaise: amount,
      createdAt: FS.Timestamp.now(), updatedAt: FS.Timestamp.now(), paidAt: null, ...over,
    })
    return { id, items, amount }
  }
  const settle = (id: string) => commerce.activateAddonOrder({ orderId: id, razorpayOrderId: `order_${id}`, razorpayPaymentId: `pay_${id}` })
  const consume = (draftId: string, service: string, quantity: number, key = `${P}_${Math.random()}`) =>
    ledgerMod.reserveServiceUnits({ draftId, service: service as never, unitKey: key, quantity, source: 'audit' })
  const line = async (draftId: string, s: string) => ((await adminDb.doc(`eventServiceAllowances/${draftId}`).get()).data()?.[s] ?? {}) as Record<string, number>

  const json = async (res: Response) => ({ status: res.status, body: await res.json() as Body })
  const req = (url: string, method = 'GET', body?: unknown) => new NextRequest(`http://localhost${url}`, {
    method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const view = async (draftId: string, who = U) => {
    h.who = who
    const { GET } = await import('@/app/api/organizer/wallet/service-requests/route')
    return json(await GET(req(`/api/organizer/wallet/service-requests?event=${draftId}`)))
  }
  const svc = (body: Body, service: string) => (body.services as Array<{ state: Body; refund: Body; carryForward: Body }>).find(x => x.state.service === service)!
  const submit = async (b: Body, who = U) => {
    h.who = who
    const { POST } = await import('@/app/api/organizer/wallet/service-requests/route')
    return json(await POST(req('/api/organizer/wallet/service-requests', 'POST', b)))
  }
  const decide = async (id: string, b: Body, who = SUPER) => {
    h.who = who
    const { POST } = await import('@/app/api/admin/wallet-service-requests/[id]/route')
    return json(await POST(req(`/api/admin/wallet-service-requests/${id}`, 'POST', b), { params: Promise.resolve({ id }) }))
  }
  const adminGet = async (id: string) => {
    h.who = SUPER
    const { GET } = await import('@/app/api/admin/wallet-service-requests/[id]/route')
    return json(await GET(req(`/api/admin/wallet-service-requests/${id}`), { params: Promise.resolve({ id }) }))
  }
  const REASON = 'Audit: verified against the order lines.'
  /** The ledger invariant for a metered service: purchased + carriedIn = consumed + available + carriedOut + refunded. */
  const invariant = (l: Record<string, number>) => {
    const n = (v: number | undefined) => v ?? 0
    const available = Math.max(0, n(l.purchased) + n(l.carriedIn) - n(l.consumed) - n(l.carriedOut) - n(l.refunded))
    expect(n(l.purchased) + n(l.carriedIn)).toBe(n(l.consumed) + available + n(l.carriedOut) + n(l.refunded))
    expect(available).toBeGreaterThanOrEqual(0)
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    h.superUid = SUPER; h.plainUid = PLAIN
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    svcs = await import('@/lib/licensing/serviceAllowances')
    ledgerMod = await import('@/lib/licensing/serviceAllowanceLedger')
    commerce = await import('@/lib/licensing/draftCommerce')
    for (const uid of [U, V]) await put(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })
    for (const k of ['A', 'B', 'C', 'E', 'G', 'R']) { await put(`users/${U}/eventDrafts/${ev(k)}`, closedDraft(`Audit ${k}`)); ledgers.push(ev(k)) }
    await put(`users/${U}/eventDrafts/${ev('D')}`, { eventDetails: { info: { name: 'Audit D (open)' } }, status: 'published', lifecycleStatus: 'published', updatedAt: ago(0) })
    ledgers.push(ev('D'))
    await put(`users/${U}/eventDrafts/${ev('LATE')}`, closedDraft('Audit late', { completedAt: ago(31) }))
    ledgers.push(ev('LATE'))
    await put(`users/${V}/eventDrafts/${ev('VX')}`, closedDraft('Other organizer'))
  }, T)
  afterAll(async () => {
    for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null)
    for (const id of ledgers) await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${id}`)).catch(() => null)
    for (const c of ['walletServiceRequests', 'walletServiceRequestsLocks']) {
      const qs = await adminDb.collection(c).where('organizerUid', '==', U).get().catch(() => null)
      for (const d of qs?.docs ?? []) await d.ref.delete().catch(() => null)
    }
    const audits = await adminDb.collection('adminAuditLogs').where('adminUid', '==', SUPER).get().catch(() => null)
    for (const d of audits?.docs ?? []) await d.ref.delete().catch(() => null)
    const hist = await adminDb.collection('licenseHistory').where('organizerUid', '==', U).get().catch(() => null)
    for (const d of hist?.docs ?? []) await d.ref.delete().catch(() => null)
  }, T)
  afterEach(() => { h.who = '' })

  // ═══ 2 · purchase accounting ═══════════════════════════════════════════════════════════════════
  let A1: Awaited<ReturnType<typeof order>>, A2: Awaited<ReturnType<typeof order>>
  let bBefore: Body
  it('only VERIFIED settlement adds entitlement — once per order, whatever is replayed', async () => {
    // Event B (isolation control): 200 WhatsApp, settled before anything happens to A.
    const B1 = await order(ev('B'), [['whatsapp', 200, 120]])
    expect(await settle(B1.id)).toBe('ok')
    bBefore = svc((await view(ev('B'))).body, 'whatsapp').state

    A1 = await order(ev('A'), [['whatsapp', 500, 100]])            // 500 × ₹1.00 + 18% GST
    A2 = await order(ev('A'), [['whatsapp', 300, 150]])            // 300 × ₹1.50 + 18% GST
    expect(A1.amount).toBe(lineTotal(500, 100))
    expect(A2.amount).toBe(lineTotal(300, 150))
    // Duplicate callbacks + webhook for the SAME order, concurrently, then a later replay.
    const r1 = await Promise.all([settle(A1.id), settle(A1.id), settle(A1.id)])
    expect(r1.filter(r => r === 'ok')).toHaveLength(1)
    expect(r1.filter(r => r === 'already')).toHaveLength(2)
    expect(await settle(A1.id)).toBe('already')
    expect(await line(ev('A'), 'whatsapp')).toMatchObject({ purchased: 500 })
    expect(await settle(A2.id)).toBe('ok')
    // A failed payment, an inconsistent (tampered) order, and an abandoned checkout add NOTHING.
    const failed = await order(ev('A'), [['whatsapp', 999, 100]], { status: 'failed' })
    expect(await settle(failed.id)).toBe('not_payable')
    const tampered = await order(ev('A'), [['whatsapp', 50, 100]], { amountPaise: 1 })
    expect(await settle(tampered.id)).toBe('inconsistent')
    await order(ev('A'), [['whatsapp', 77, 100]])                  // created, never settled
    expect(await line(ev('A'), 'whatsapp')).toMatchObject({ purchased: 800 })
    const st = svc((await view(ev('A'))).body, 'whatsapp').state
    expect(st).toMatchObject({ purchased: 800, paidPaise: A1.amount + A2.amount })
    expect((st.lots as Body[]).map(l => l.orderId).sort()).toEqual([A1.id, A2.id].sort())   // only PAID lines
  }, T)

  // ═══ 3 · FIFO valuation ═══════════════════════════════════════════════════════════════════════
  it('consuming 520 uses ALL of the older line and 20 of the newer; the 280 unused are valued at the NEWER line’s price', async () => {
    expect((await consume(ev('A'), 'whatsapp', 520)).mode).toBe('allowance')
    const w = svc((await view(ev('A'))).body, 'whatsapp')
    expect(w.state).toMatchObject({ purchased: 800, used: 520, remaining: 280, ownUnused: 280 })
    const expected = Math.floor((280 * A2.amount) / 300)                 // 280 of A2's 300 units
    expect(w.refund).toMatchObject({ eligible: true, quantity: 280, upperBoundPaise: expected })
    expect(w.refund.valuation).toEqual([{ orderId: A2.id, units: 280, valuePaise: expected }])
    // NOT the blended average (total paid ÷ total purchased × remaining):
    const blended = Math.floor((280 * (A1.amount + A2.amount)) / 800)
    expect(blended).not.toBe(expected)
    expect(expected).toBeLessThanOrEqual(A2.amount)
  }, T)

  // ═══ 4 · partial refund, no re-use ════════════════════════════════════════════════════════════
  let refundA = ''
  it('refund of exactly the 280 unused; after approval they are gone for good and the invariant holds', async () => {
    const s = await submit({ kind: 'refund', draftId: ev('A'), service: 'whatsapp' })
    expect(s.status).toBe(201)
    refundA = (s.body.request as Body).id as string
    expect(s.body.request).toMatchObject({ quantity: 280, refundUpperBoundPaise: Math.floor((280 * A2.amount) / 300) })
    // Organizer and Super Admin see the SAME state for the same event + service (one derivation).
    const orgState = svc((await view(ev('A'))).body, 'whatsapp').state
    const adm = await adminGet(refundA)
    expect((adm.body.current as Body).state).toEqual(orgState)
    expect((await decide(refundA, { action: 'approve', reason: REASON, approvedAmountPaise: Math.floor((280 * A2.amount) / 300) + 1 })).body.code).toBe('AMOUNT_ABOVE_LIMIT')
    expect((await decide(refundA, { action: 'approve', reason: REASON, approvedAmountPaise: Math.floor((280 * A2.amount) / 300) })).status).toBe(200)
    const l = await line(ev('A'), 'whatsapp')
    expect(l).toMatchObject({ purchased: 800, consumed: 520, refunded: 280 })
    invariant(l)
    // A refunded unit can never be consumed again.
    expect(await consume(ev('A'), 'whatsapp', 1)).toEqual({ mode: 'exhausted', policy: 'block' })
    expect(svc((await view(ev('A'))).body, 'whatsapp').refund).toMatchObject({ eligible: false, code: 'NOTHING_UNUSED' })
  }, T)

  // ═══ 7 · cross-event isolation ════════════════════════════════════════════════════════════════
  it('everything done to A left B untouched; another organizer can neither see nor touch A', async () => {
    expect(svc((await view(ev('B'))).body, 'whatsapp').state).toEqual(bBefore)
    const b = await line(ev('B'), 'whatsapp')
    expect(b.purchased).toBe(200)
    expect(b.consumed ?? 0).toBe(0)
    expect(b.refunded ?? 0).toBe(0)
    expect(((await view(ev('B'))).body.requests as Body[])).toEqual([])
    expect((await view(ev('A'), V)).status).toBe(404)
    expect((await submit({ kind: 'refund', draftId: ev('A'), service: 'whatsapp' }, V)).status).toBe(404)
    expect((await view(ev('VX'))).status).toBe(404)
    expect((await submit({ kind: 'carry_forward', draftId: ev('B'), service: 'whatsapp', destinationDraftId: ev('VX') })).body.code).toBe('DESTINATION_REQUIRED')
  }, T)

  // ═══ 6 · carry-forward ↔ refund — the same unit can never take both paths ════════════════════
  it('refund and carry-forward race for the same units: exactly one request; carried-in units are never "purchased"', async () => {
    const C1 = await order(ev('C'), [['whatsapp', 100, 200]])
    expect(await settle(C1.id)).toBe('ok')
    const race = await Promise.all([
      submit({ kind: 'refund', draftId: ev('C'), service: 'whatsapp' }),
      submit({ kind: 'carry_forward', draftId: ev('C'), service: 'whatsapp', destinationDraftId: ev('D') }),
    ])
    expect(race.filter(r => r.status === 201)).toHaveLength(1)
    const winner = race.find(r => r.status === 201)!.body.request as Body
    expect((await decide(winner.id as string, { action: 'reject', reason: 'Audit: re-submit as carry-forward.' })).status).toBe(200)
    const cf = await submit({ kind: 'carry_forward', draftId: ev('C'), service: 'whatsapp', destinationDraftId: ev('D') })
    expect(cf.status).toBe(201)
    expect((await decide((cf.body.request as Body).id as string, { action: 'approve', reason: REASON })).status).toBe(200)
    // Source: the 100 left; it cannot ALSO be refunded.
    invariant(await line(ev('C'), 'whatsapp'))
    expect(await line(ev('C'), 'whatsapp')).toMatchObject({ purchased: 100, carriedOut: 100 })
    expect((await submit({ kind: 'refund', draftId: ev('C'), service: 'whatsapp' })).body.code).toBe('NOTHING_UNUSED')
    // Destination: 100 carried in, NOT purchased; using 30 of them is never a "fresh purchase".
    expect(await line(ev('D'), 'whatsapp')).toMatchObject({ carriedIn: 100 })
    expect((await line(ev('D'), 'whatsapp')).purchased).toBeUndefined()
    expect((await consume(ev('D'), 'whatsapp', 30)).mode).toBe('allowance')
    const d = svc((await view(ev('D'))).body, 'whatsapp').state
    expect(d).toMatchObject({ purchased: 0, carriedIn: 100, used: 30, remaining: 70, ownUnused: 0, paidPaise: 0 })
    invariant(await line(ev('D'), 'whatsapp'))
    // Even once D closes, carried-in units are neither refundable nor carried on.
    await lifecycle(U, ev('D'), { lifecycleStatus: 'completed', completedAt: ago(0) })
    const dc = svc((await view(ev('D'))).body, 'whatsapp')
    expect(dc.refund).toMatchObject({ eligible: false, code: 'NOTHING_UNUSED' })
    expect(dc.carryForward).toMatchObject({ eligible: false, code: 'NOTHING_UNUSED' })
  }, T)

  // ═══ 11 · usage racing a refund approval ══════════════════════════════════════════════════════
  it('usage and refund approval race: never both — never a negative balance, never a refund of used units', async () => {
    const E1 = await order(ev('E'), [['whatsapp', 100, 100]])
    expect(await settle(E1.id)).toBe('ok')
    await consume(ev('E'), 'whatsapp', 50)
    const s = await submit({ kind: 'refund', draftId: ev('E'), service: 'whatsapp' })
    const id = (s.body.request as Body).id as string
    const cap = Math.floor((50 * E1.amount) / 100)
    const [approval, use] = await Promise.all([
      decide(id, { action: 'approve', reason: REASON, approvedAmountPaise: cap }),
      consume(ev('E'), 'whatsapp', 10, `${P}_race`),
    ])
    const l = await line(ev('E'), 'whatsapp')
    invariant(l)
    expect((l.consumed ?? 0) + (l.refunded ?? 0)).toBeLessThanOrEqual(100)
    if (approval.status === 200) {
      expect(use).toEqual({ mode: 'exhausted', policy: 'block' })    // approved first: those 50 are gone
      expect(l).toMatchObject({ consumed: 50, refunded: 50 })
    } else {
      expect(use.mode).toBe('allowance')                              // used first: the approval refuses
      expect(approval.status).toBe(409)
      expect(l.refunded).toBeUndefined()
      expect(l.consumed).toBe(60)
    }
  }, T)

  // ═══ 9/10 · money: GST rounding, awkward unit prices, per-line floors ════════════════════════════
  it('awkward amounts: the cap is the sum of per-line floors and never exceeds what was paid', async () => {
    const G1 = await order(ev('G'), [['whatsapp', 3, 333]])       // base ₹9.99, GST rounds
    const G2 = await order(ev('G'), [['whatsapp', 7, 847]])       // base ₹59.29, GST rounds
    expect(await settle(G1.id)).toBe('ok')
    expect(await settle(G2.id)).toBe('ok')
    await consume(ev('G'), 'whatsapp', 5)                          // G1's 3 + 2 of G2's 7
    const w = svc((await view(ev('G'))).body, 'whatsapp')
    const expected = Math.floor((5 * G2.amount) / 7)
    expect(w.refund).toMatchObject({ eligible: true, quantity: 5, upperBoundPaise: expected })
    expect(expected).toBeLessThanOrEqual((5 * G2.amount) / 7)     // never rounds UP
    expect(expected + G1.amount).toBeLessThanOrEqual(G1.amount + G2.amount)
    const s = await submit({ kind: 'refund', draftId: ev('G'), service: 'whatsapp' })
    expect((await decide((s.body.request as Body).id as string, { action: 'approve', reason: REASON, approvedAmountPaise: expected })).status).toBe(200)
    expect(svc((await view(ev('G'))).body, 'whatsapp').refund).toMatchObject({ code: 'NOTHING_UNUSED' })
  }, T)

  // ═══ 5 · refund all unused — four services, independent figures ═══════════════════════════════
  it('refund all: one request per service WITH unused units, each with its own quantity and value; approving one leaves the others', async () => {
    const R = ev('R'), slug = `${P}-r`
    // Capacity: 300 activated (200 paid at ₹354), 120 registered ⇒ 20 paid used, 180 paid unused.
    await adminDb.doc(`users/${U}/eventDrafts/${R}`).update({ 'eventDetails.seo.urlSlug': slug })
    await put(`events/${slug}`, { uid: U, draftId: R, totalCapacity: 300, lifecycleStatus: 'completed', completedAt: closedAgo(3) })
    await put(`eventLicenses/${slug}`, { organizerUid: U, eventId: slug, commercialModel: 'capacity', capacity: 300 })
    await put(`registrationCounters/${slug}`, { totalCount: 120 })
    await put(`licenseOrders/lic_${R}`, { orderId: `lic_${R}`, eventId: R, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 35_400, commercialModel: 'capacity',
      capacityChange: { operation: 'activation', capacity: 300, previousCapacity: null, freeCapacity: 100, activationRatePaise: 150, chargeableCapacity: 200, basePaise: 30_000, gstRatePercent: 18, gstPaise: 5_400, totalPaise: 35_400, terms: {} },
      paidAt: ago(5), createdAt: ago(5) })
    // WhatsApp 100 (30 used), certificates 50 (ALL used), photos 40 paid with 10 stored (10 used — RD-PHOTO-01: no free base).
    const R1 = await order(R, [['whatsapp', 100, 100], ['certificates', 50, 300], ['media', 40, 200, { baseCapAtPurchase: 100 }]])
    expect(await settle(R1.id)).toBe('ok')
    await consume(R, 'whatsapp', 30); await consume(R, 'certificates', 50)
    const batch = adminDb.batch()
    for (let i = 0; i < 10; i++) { batch.set(adminDb.doc(`mediaAssets/${P}_m${i}`), { organizerUid: U, eventId: R, status: 'ready' }); cleanup.push(`mediaAssets/${P}_m${i}`) }
    await batch.commit()
    const wa = R1.items.find(i => i.service === 'whatsapp')!, ph = R1.items.find(i => i.service === 'media')!
    const expected: Record<string, { q: number; v: number }> = {
      registrations: { q: 180, v: Math.floor((180 * 35_400) / 200) },
      whatsapp:      { q: 70,  v: Math.floor((70 * wa.totalPaise) / 100) },
      media:         { q: 30,  v: Math.floor((30 * ph.totalPaise) / 40) },
    }
    const r = await submit({ kind: 'refund', draftId: R, services: 'all' })
    expect(r.status).toBe(201)
    const reqs = r.body.requests as Body[]
    expect(reqs.map(x => x.service).sort()).toEqual(['media', 'registrations', 'whatsapp'])     // NOT certificates
    for (const x of reqs) {
      expect(x.source).toMatchObject({ draftId: R })
      expect(x).toMatchObject({ quantity: expected[x.service as string].q, refundUpperBoundPaise: expected[x.service as string].v })
    }
    expect(new Set(reqs.map(x => x.groupId)).size).toBe(1)
    // Approve ONLY WhatsApp: capacity and photos are untouched.
    const waReq = reqs.find(x => x.service === 'whatsapp')!
    expect((await decide(waReq.id as string, { action: 'approve', reason: REASON, approvedAmountPaise: expected.whatsapp.v })).status).toBe(200)
    expect((await adminDb.doc(`events/${slug}`).get()).get('totalCapacity')).toBe(300)
    expect((await line(R, 'media')).refunded).toBeUndefined()
    expect(await line(R, 'whatsapp')).toMatchObject({ purchased: 100, consumed: 30, refunded: 70 })
  }, T)

  // ═══ 8 · capacity refund racing registrations ════════════════════════════════════════════════
  it('capacity: a refund approval racing registrations never leaves capacity below registrations, deletes none, and never re-opens refunded capacity', async () => {
    const R = ev('R'), slug = `${P}-r`
    const capReq = (await adminDb.collection('walletServiceRequests').where('sourceDraftId', '==', R).get()).docs.find(d => d.get('service') === 'registrations')!
    // The REAL registration transaction's capacity rule (lib/firebase/firestore/registrations.ts):
    // read the event's capacity and the counter in one transaction; register only below capacity.
    const register = () => adminDb.runTransaction(async txn => {
      const [e, c] = await Promise.all([txn.get(adminDb.doc(`events/${slug}`)), txn.get(adminDb.doc(`registrationCounters/${slug}`))])
      const cap = e.get('totalCapacity') as number, n = (c.get('totalCount') as number) ?? 0
      if (n >= cap) return false
      txn.set(adminDb.doc(`registrationCounters/${slug}`), { totalCount: n + 1 }, { merge: true })
      return true
    })
    const results = await Promise.all([
      decide(capReq.id, { action: 'approve', reason: REASON, approvedAmountPaise: Math.floor((180 * 35_400) / 200) }),
      ...Array.from({ length: 5 }, () => register()),
    ])
    const approval = results[0] as { status: number }
    const cap = (await adminDb.doc(`events/${slug}`).get()).get('totalCapacity') as number
    const count = (await adminDb.doc(`registrationCounters/${slug}`).get()).get('totalCount') as number
    expect(count).toBeLessThanOrEqual(cap)
    expect(count).toBeGreaterThanOrEqual(120)                                   // nothing deleted
    if (approval.status === 200) {
      expect(cap).toBe(120)                                                      // 300 − 180, approved before any new registration
      expect(count).toBe(120)
      expect(await register()).toBe(false)                                      // refunded capacity never re-opens
    } else {
      expect(approval.status).toBe(409)                                          // registrations won: units changed
      expect(cap).toBe(300)
    }
  }, T)

  // ═══ 13/19 · abuse and the 30-day window, enforced server-side ═══════════════════════════════
  it('client-supplied quantities / amounts are refused; legacy admin and organizers cannot decide; the window is server-side', async () => {
    for (const k of ['quantity', 'amountPaise', 'approvedAmountPaise', 'refundUpperBoundPaise', 'organizerUid', 'status']) {
      expect((await submit({ kind: 'refund', draftId: ev('B'), service: 'whatsapp', [k]: 1 })).body.code, k).toBe('FIELD_NOT_ALLOWED')
    }
    const L1 = await order(ev('LATE'), [['whatsapp', 10, 100]])
    expect(await settle(L1.id)).toBe('ok')
    expect((await submit({ kind: 'refund', draftId: ev('LATE'), service: 'whatsapp' })).body.code).toBe('REFUND_WINDOW_CLOSED')
    for (const who of [U, PLAIN]) expect((await decide(refundA, { action: 'reject', reason: REASON }, who)).status).toBe(403)
    // The organizer can never turn an approved refund into "refunded" (or re-approve it).
    expect((await decide(refundA, { action: 'mark_processed', reason: REASON, externalReference: 'rfnd_X' }, U)).status).toBe(403)
  }, T)
})
