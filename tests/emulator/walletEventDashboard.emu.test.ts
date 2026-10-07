// RD-WALLET-EVT-01 — the organizer's event-wise Wallet on REAL Firestore (private emulator),
// through the REAL routes. Identity is stubbed at the token boundary only (lib/team/access
// verifyCaller), as in the W1 suite. Every list / detail / transactions call runs with ALL
// Firestore write APIs trapped: the dashboard reads, and only reads. Figures are checked against
// the existing owners of each value — the License Center route and activation-status — rather
// than re-derived here.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `wevt${process.pid}`

const h = vi.hoisted(() => ({ who: '', writes: [] as string[] }))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))
vi.mock('@/lib/razorpay/client', () => new Proxy({}, {
  get(_t, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined
    throw new Error(`payment provider touched: ${String(key)}`)
  },
}))

describeEmu('RD-WALLET-EVT-01 · organizer event-wise Wallet (real Firestore, read-only)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  const cleanup: string[] = []
  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); cleanup.push(path) }
  const ts = (n: number) => FS.Timestamp.fromMillis(Date.UTC(2026, 8, 1) + n * 60_000)

  const U = `${P}_owner`, V = `${P}_other`
  const slugA = `${P}-conf`, slugE = `${P}-work`, slugD = `${P}-cancel`, slugV = `${P}-vslug`
  const [dA, dE, dB, dC, dD, dX, dV] = ['dA', 'dE', 'dB', 'dC', 'dD', 'dX', 'dV'].map(s => `${P}_${s}`)

  const draft = (name: string, extra: Record<string, unknown>, slug?: string, sched?: Record<string, unknown>) => ({
    eventDetails: { info: { name }, ...(slug ? { seo: { urlSlug: slug } } : {}), ...(sched ? { schedule: sched } : {}) },
    ...extra,
  })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    for (const uid of [U, V]) await put(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })

    // A — published, capacity licence, upcoming; services; payments; usage; ledger charges; photos.
    await put(`users/${U}/eventDrafts/${dA}`, draft('Annual Conference', { status: 'published', lifecycleStatus: 'published', eventType: 'conference', updatedAt: ts(6) }, slugA, { startDate: '2099-01-10', endDate: '2099-01-11', timezone: 'Asia/Kolkata' }))
    await put(`events/${slugA}`, { uid: U, draftId: dA, totalCapacity: 200 })
    await put(`eventLicenses/${slugA}`, { organizerUid: U, eventId: slugA, commercialModel: 'capacity', tier: 'free', version: 2, status: 'active', amountPaise: 50_000, orderId: `lic_${dA}` })
    await put(`registrationCounters/${slugA}`, { totalCount: 37 })
    await put(`eventServiceAllowances/${dA}`, {
      draftId: dA, organizerUid: U,
      whatsapp: { purchased: 100, consumed: 30, onExhausted: 'block' },
      certificates: { purchased: 50, consumed: 50, onExhausted: 'wallet_payg' },
      media: { purchased: 20, consumed: 0, onExhausted: 'block' },
    })
    await put(`licenseOrders/lic_${dA}`, { orderId: `lic_${dA}`, eventId: dA, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 50_000, currency: 'INR', paidAt: ts(1), createdAt: ts(1), updatedAt: ts(1) })
    await put(`licenseOrders/cap_${slugA}_1`, { orderId: `cap_${slugA}_1`, eventId: slugA, organizerUid: U, purpose: 'capacity_increase', status: 'paid', amountPaise: 20_000, currency: 'INR', paidAt: ts(2), createdAt: ts(2), updatedAt: ts(2) })
    await put(`licenseOrders/add_${dA}_1`, { orderId: `add_${dA}_1`, eventId: dA, organizerUid: U, purpose: 'addon', status: 'refunded', amountPaise: 3_000, currency: 'INR', paidAt: ts(3), createdAt: ts(3), updatedAt: ts(3) })
    await put(`licenseOrders/add_${dA}_2`, { orderId: `add_${dA}_2`, eventId: dA, organizerUid: U, purpose: 'addon', status: 'created', amountPaise: 9_999, currency: 'INR', paidAt: null, createdAt: ts(4), updatedAt: ts(4) })
    await put(`walletTransactions/license_${dA}`, { organizerUid: U, type: 'license_charge', amountPaise: 1_000, createdAt: ts(1), metadata: {} })
    for (const [i, ch] of [[1, 'whatsapp'], [2, 'whatsapp'], [3, 'email']] as const) {
      await put(`communicationUsage/${P}_u${i}`, { organizerUid: U, eventId: slugA, eventSlug: slugA, channel: ch, quantity: 1, costPaise: ch === 'whatsapp' ? 100 : 0, createdAt: ts(i) })
    }
    await put(`communicationUsage/${P}_uV`, { organizerUid: V, eventSlug: slugV, channel: 'whatsapp', quantity: 5, costPaise: 500, createdAt: ts(1) })
    await put(`walletTransactions/${P}_t1`, { organizerUid: U, type: 'whatsapp_charge', amountPaise: 100, balancePaise: 9_900, status: 'completed', referenceType: 'communication', referenceId: 'r1', description: 'WA 1', metadata: { eventId: slugA, eventSlug: slugA, channel: 'whatsapp', units: 1 }, createdAt: ts(10) })
    await put(`walletTransactions/${P}_t2`, { organizerUid: U, type: 'whatsapp_charge', amountPaise: 100, balancePaise: 9_800, status: 'completed', referenceType: 'communication', referenceId: 'r2', description: 'WA 2', metadata: { eventId: slugA, eventSlug: slugA, channel: 'whatsapp', units: 1 }, createdAt: ts(11) })
    await put(`walletTransactions/${P}_t3`, { organizerUid: U, type: 'certificate_charge', amountPaise: 190, balancePaise: 9_610, status: 'completed', referenceType: 'communication', referenceId: 'c1', description: 'Cert', metadata: { eventId: dA, certificateId: 'c1', channel: 'certificate', units: 1 }, createdAt: ts(12) })
    await put(`walletTransactions/${P}_t4`, { organizerUid: U, type: 'broadcast_whatsapp', amountPaise: 400, balancePaise: 9_210, status: 'completed', referenceType: 'communication', referenceId: 'cmp', description: 'Broadcast', metadata: { campaignId: 'cmp1', units: 4, channel: 'whatsapp' }, createdAt: ts(13) })
    await put(`walletTransactions/${P}_t5`, { organizerUid: U, type: 'fund_added', amountPaise: 10_000, balancePaise: 19_210, status: 'completed', referenceType: 'razorpay', referenceId: 'o1', description: 'Top-up', metadata: {}, createdAt: ts(14) })
    await put(`walletTransactions/${P}_tV`, { organizerUid: V, type: 'whatsapp_charge', amountPaise: 999, balancePaise: 0, status: 'completed', referenceType: 'communication', referenceId: 'rv', description: 'V', metadata: { eventSlug: slugA }, createdAt: ts(15) })
    for (const [i, status, owner] of [[1, 'ready', U], [2, 'ready', U], [3, 'ready', U], [4, 'processing', U], [5, 'ready', V]] as const) {
      await put(`mediaAssets/${P}_m${i}`, { organizerUid: owner, eventId: dA, status })
    }

    // E — published, historical TIER licence, live.
    await put(`users/${U}/eventDrafts/${dE}`, draft('Community Workshop', { status: 'published', lifecycleStatus: 'published', eventType: 'corporate', updatedAt: ts(5) }, slugE, { startDate: '2000-01-01', endDate: '2099-12-31' }))
    await put(`events/${slugE}`, { uid: U, draftId: dE })
    await put(`eventLicenses/${slugE}`, { organizerUid: U, eventId: slugE, tier: 'starter', version: 1, status: 'active', amountPaise: 0, orderId: null })
    await put(`registrationCounters/${slugE}`, { totalCount: 5 })
    // B — donation-only campaign.
    await put(`users/${U}/eventDrafts/${dB}`, draft('Relief Fund', { status: 'published', lifecycleStatus: 'published', campaignType: 'donation_only', eventType: 'ngo', updatedAt: ts(4) }))
    // C — not live yet, activation PAID with capacity 300 (prepaid).
    await put(`users/${U}/eventDrafts/${dC}`, draft('Draft Expo', { status: 'draft', lifecycleStatus: 'draft', eventType: 'expo', updatedAt: ts(3) }))
    await put(`licenseOrders/lic_${dC}`, { orderId: `lic_${dC}`, eventId: dC, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 45_000, currency: 'INR', capacityChange: { capacity: 300 }, paidAt: ts(5), createdAt: ts(5), updatedAt: ts(5) })
    // D — cancelled, never licensed.
    await put(`users/${U}/eventDrafts/${dD}`, draft('Cancelled Meetup', { status: 'published', lifecycleStatus: 'cancelled', updatedAt: ts(2) }, slugD))
    // X — U's draft CLAIMING V's slug: V's data must never surface.
    await put(`users/${U}/eventDrafts/${dX}`, draft('Borrowed Slug', { status: 'draft', lifecycleStatus: 'draft', updatedAt: ts(1) }, slugV))
    // V — another workspace.
    await put(`users/${V}/eventDrafts/${dV}`, draft('Other Org Event', { status: 'published', lifecycleStatus: 'published', updatedAt: ts(9) }, slugV))
    await put(`events/${slugV}`, { uid: V, draftId: dV, totalCapacity: 1000 })
    await put(`eventLicenses/${slugV}`, { organizerUid: V, eventId: slugV, commercialModel: 'capacity', tier: 'free', version: 2, status: 'active', amountPaise: 1, orderId: null })
    await put(`registrationCounters/${slugV}`, { totalCount: 999 })
  }, T)
  afterAll(async () => { for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null) }, T)
  afterEach(() => { vi.restoreAllMocks(); h.who = '' })

  function trapWrites() {
    h.writes = []
    const trap = (proto: object, names: string[], label: string) => {
      for (const name of names) vi.spyOn(proto as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(() => {
        h.writes.push(`${label}.${name}`); throw new Error(`write attempted: ${label}.${name}`)
      })
    }
    trap(FS.DocumentReference.prototype, ['set', 'update', 'delete', 'create'], 'DocumentReference')
    trap(FS.CollectionReference.prototype, ['add'], 'CollectionReference')
    trap(FS.WriteBatch.prototype, ['set', 'update', 'delete', 'create', 'commit'], 'WriteBatch')
    trap(FS.Firestore.prototype, ['runTransaction', 'batch', 'bulkWriter', 'recursiveDelete'], 'Firestore')
  }
  const json = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> })
  async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    h.who = uid; trapWrites()
    try { return await fn() } finally { vi.restoreAllMocks(); h.who = '' }
  }
  const list = async (uid: string, qs: Record<string, string> = {}) => as(uid, async () => {
    const { GET } = await import('@/app/api/organizer/wallet/events/route')
    return json(await GET(new NextRequest(`http://localhost/api/organizer/wallet/events?${new URLSearchParams(qs)}`, { headers: { authorization: 'Bearer t' } })))
  })
  const detail = async (uid: string, draftId: string) => as(uid, async () => {
    const { GET } = await import('@/app/api/organizer/wallet/events/[draftId]/route')
    return json(await GET(new NextRequest(`http://localhost/api/organizer/wallet/events/${draftId}`, { headers: { authorization: 'Bearer t' } }), { params: Promise.resolve({ draftId }) }))
  })
  const txns = async (uid: string, qs: Record<string, string> = {}) => as(uid, async () => {
    const { GET } = await import('@/app/api/organizer/wallet/transactions/route')
    return json(await GET(new NextRequest(`http://localhost/api/organizer/wallet/transactions?${new URLSearchParams(qs)}`, { headers: { authorization: 'Bearer t' } })))
  })
  type Row = import('@/lib/wallet/eventWalletView').WalletEventRow
  const allRows = async (uid: string, qs: Record<string, string> = {}): Promise<Row[]> => {
    const out: Row[] = []
    let cursor: string | null = null
    for (let i = 0; i < 20; i++) {
      const r = await list(uid, { ...qs, ...(cursor ? { cursor } : {}) })
      expect(r.status).toBe(200)
      out.push(...(r.body.events as Row[]))
      cursor = r.body.nextCursor as string | null
      if (!cursor) break
    }
    return out
  }

  it('authorization: no caller → refused; every read is write-free', async () => {
    const r = await list('')
    expect([401, 403]).toContain(r.status)
    await allRows(U)
    expect(h.writes).toEqual([])
  }, T)

  it('scoping: only the workspace’s own events; another workspace’s data never surfaces (even under a claimed slug)', async () => {
    const rows = await allRows(U)
    expect(rows.map(r => r.draftId).sort()).toEqual([dA, dB, dC, dD, dE, dX].sort())
    const x = rows.find(r => r.draftId === dX)!
    expect(x.slug).toBeNull()                                                    // V's slug is not trusted for U
    expect(x.registrations).toEqual({ state: 'not_applicable', reason: 'not_published' })
    expect(x.whatsappBilledMessages).toBeNull()
    expect(JSON.stringify(rows)).not.toContain('999')                            // V's counter
    expect((await allRows(V)).map(r => r.draftId)).toEqual([dV])
    expect((await detail(U, dV)).status).toBe(404)                               // V's event via U
    expect((await detail(U, `${P}_nope`)).status).toBe(404)
    expect((await detail(U, 'bad/../id')).status).toBe(404)
  }, T)

  it('registrations equal the License Center (capacity AND tier licences); services equal activation-status', async () => {
    const rows = await allRows(U)
    const a = rows.find(r => r.draftId === dA)!, e = rows.find(r => r.draftId === dE)!
    expect(a.registrations).toEqual({ state: 'limited', limit: 200, used: 37, remaining: 163, capacityModel: true })
    const lc = async (slug: string) => as(U, async () => {
      const { GET } = await import('@/app/api/organizer/licenses/[eventId]/route')
      return json(await GET(new NextRequest(`http://localhost/api/organizer/licenses/${slug}`, { headers: { authorization: 'Bearer t' } }), { params: Promise.resolve({ eventId: slug }) }))
    })
    for (const [row, slug] of [[a, slugA], [e, slugE]] as const) {
      const d = (await lc(slug)).body.detail as { registrationLimit: number | null; used: number; remaining: number | null }
      if (d.registrationLimit === null) expect(row.registrations).toMatchObject({ state: 'unlimited', used: d.used })
      else expect(row.registrations).toMatchObject({ state: 'limited', limit: d.registrationLimit, used: d.used, remaining: d.remaining })
    }
    const act = await as(U, async () => {
      const { GET } = await import('@/app/api/licensing/activation-status/route')
      return json(await GET(new NextRequest(`http://localhost/api/licensing/activation-status?eventId=${dA}`, { headers: { authorization: 'Bearer t' } })))
    })
    const s = act.body.services as { purchased: Record<string, number>; consumed: Record<string, number>; remaining: Record<string, number> }
    for (const k of ['whatsapp', 'certificates', 'media'] as const) {
      expect(a.services![k]).toMatchObject({ purchased: s.purchased[k], consumed: s.consumed[k], remaining: s.remaining[k] })
    }
    expect(a.services!.whatsapp.onExhausted).toBe('block')
    expect(a.services!.certificates.onExhausted).toBe('wallet_payg')
    expect(h.writes).toEqual([])
  }, T)

  it('RD-PHOTO-01 · photos follow the upload gate: PAID units only (no free base); photos of THIS workspace only', async () => {
    const a = (await allRows(U)).find(r => r.draftId === dA)!
    expect(a.photos).toEqual({ state: 'limited', baseCap: 0, purchased: 20, cap: 20, stored: { ok: true, value: 3 }, maxAdditional: 2980 })
  }, T)

  it('edge cases: donation campaign, prepaid draft, cancelled event without a licence', async () => {
    const rows = await allRows(U)
    const by = (id: string) => rows.find(r => r.draftId === id)!
    expect(by(dB).registrations).toEqual({ state: 'not_applicable', reason: 'donation_campaign' })
    expect(by(dC).registrations).toEqual({ state: 'prepaid', paidCapacity: 300 })
    expect(by(dC).paidPaise).toEqual({ ok: true, value: 45_000 })
    expect(by(dD).registrations).toEqual({ state: 'not_applicable', reason: 'no_licence' })
    expect(by(dD).phase).toBe('cancelled')
    expect(by(dB).services!.whatsapp.purchased).toBe(0)
  }, T)

  it('paid = only PAID orders of the event (slug- AND draft-keyed); WhatsApp outside the allowance from usage records', async () => {
    const a = (await allRows(U)).find(r => r.draftId === dA)!
    expect(a.paidPaise).toEqual({ ok: true, value: 70_000 })                     // 50 000 activation + 20 000 capacity; refunded / created excluded
    expect(a.whatsappBilledMessages).toEqual({ ok: true, value: 2 })             // V's usage excluded
  }, T)

  it('detail: verified payments, attributable communication + wallet charges, License Center wallet figure, links', async () => {
    const r = await detail(U, dA)
    expect(r.status).toBe(200)
    const d = r.body as unknown as import('@/lib/wallet/eventWalletView').WalletEventDetail
    expect(d.payments.map(p => [p.purpose, p.status, p.amountPaise])).toEqual([
      ['Add-on', 'refunded', 3_000], ['Capacity increase', 'paid', 20_000], ['Activation', 'paid', 50_000],
    ])
    expect(d.communication).toEqual({
      emailMessages: { ok: true, value: 1 }, whatsappMessages: { ok: true, value: 2 },
      walletChargesPaise: { ok: true, value: 390 }, walletChargeCount: { ok: true, value: 3 },   // 2 WhatsApp + 1 certificate; broadcast + V excluded
    })
    const lc = await as(U, async () => {
      const { GET } = await import('@/app/api/organizer/licenses/[eventId]/route')
      return json(await GET(new NextRequest(`http://localhost/api/organizer/licenses/${slugA}`, { headers: { authorization: 'Bearer t' } }), { params: Promise.resolve({ eventId: slugA }) }))
    })
    expect(d.licenceWalletPaidPaise).toBe((lc.body.detail as { billing: { walletUsedPaise: number } }).billing.walletUsedPaise)
    expect(d.links).toEqual({ licenceCenter: `/dashboard/settings/billing/licenses/${slugA}`, servicesPurchase: `/dashboard/events/new/visibility?draftId=${dA}` })
    expect(h.writes).toEqual([])
  }, T)

  it('filters, search and pagination (each event exactly once across pages)', async () => {
    expect((await allRows(U, { phase: 'cancelled' })).map(r => r.draftId)).toEqual([dD])
    expect((await allRows(U, { phase: 'live' })).map(r => r.draftId).sort()).toEqual([dE, dB].sort())   // B: published, no dates
    expect((await allRows(U, { phase: 'upcoming' })).map(r => r.draftId).sort()).toEqual([dA, dC, dX].sort())
    expect((await allRows(U, { search: 'WORKSHOP' })).map(r => r.draftId)).toEqual([dE])
    const paged = await allRows(U, { limit: '2' })
    expect(paged.map(r => r.draftId)).toEqual([dA, dE, dB, dC, dD, dX])            // newest first, none repeated
  }, T)

  it('transactions: event filter returns only rows that reference the event; another workspace’s draft is 404; unfiltered unchanged', async () => {
    const f = await txns(U, { event: dA })
    expect(f.status).toBe(200)
    expect((f.body.transactions as Array<{ id: string }>).map(t => t.id).sort()).toEqual([`${P}_t1`, `${P}_t2`, `${P}_t3`].sort())
    expect(f.body.event).toEqual({ draftId: dA, name: 'Annual Conference' })
    expect((await txns(U, { event: dV })).status).toBe(404)
    expect((await txns(U, { event: 'bad id' })).status).toBe(400)
    const all = await txns(U)
    const ids = (all.body.transactions as Array<{ id: string }>).map(t => t.id)
    for (const t of ['t1', 't2', 't3', 't4', 't5']) expect(ids).toContain(`${P}_${t}`)
    expect(ids).not.toContain(`${P}_tV`)
    expect(h.writes).toEqual([])
  }, T)
})
