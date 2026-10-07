// RD-CLOSE · Super Admin authority, capacity-only events, carry-forward on the LIVE lifecycle.
// Real routes, real Firestore, real Auth (emulator) — tokens are minted through the Auth emulator,
// the Super Admin is configured through ADMIN_UIDS exactly as in production.
//
//   #10 — financial admin reads: Super Admin (ADMIN_UIDS) yes; legacy `admin: true` claim alone no;
//         organizer no. Mixed views (stats) withhold money for the claim-only admin.
//         Organizer side: owner / finance member may open the Event Wallet API; check-in member and a
//         suspended organizer may not.
//   #6  — a capacity-only event (no service ledger) is listed for Super Admin and has a per-event
//         reconciliation view; the ledger is reported "not applicable", never invented.
//   #7  — carry-forward destinations are judged by the LIVE event, never the draft's own fields.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

// No payment provider is reachable: any real use of the Razorpay client throws.
vi.mock('@/lib/razorpay/client', () => new Proxy({}, {
  get(_t, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined
    if (key === 'RAZORPAY_KEY_ID' || key === 'RAZORPAY_KEY_SECRET') return 'rzp_test_closure'
    throw new Error(`payment provider touched: ${String(key)}`)
  },
}))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `cls${process.pid}`

describeEmu('RD-CLOSE · authority, capacity-only events, carry-forward lifecycle', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let FS: typeof import('firebase-admin/firestore')
  const docs: string[] = [], trees: string[] = [], users: string[] = []
  const savedAdminUids = process.env.ADMIN_UIDS
  const tok: Record<string, string> = {}
  const uidOf: Record<string, string> = {}

  async function mkUser(key: string, opts: { claim?: boolean } = {}) {
    const u = await adminAuth.createUser({ email: `${P}-${key}@rd.test`, password: 'Passw0rd!x', emailVerified: true })
    users.push(u.uid); uidOf[key] = u.uid
    if (opts.claim) await adminAuth.setCustomUserClaims(u.uid, { admin: true })
    const custom = await adminAuth.createCustomToken(u.uid)
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const key2 = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-api-key'
    const r = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key2}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })
    tok[key] = (await r.json() as { idToken: string }).idToken
  }
  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); docs.push(path) }
  const req = (url: string, who: string | null) => new NextRequest(`http://localhost${url}`, { headers: who ? { authorization: `Bearer ${tok[who]}` } : {} })
  const status = async (p: Promise<Response>) => (await p).status

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    await mkUser('super', { claim: true })
    await mkUser('plain', { claim: true })     // legacy claim only — NOT in ADMIN_UIDS
    await mkUser('owner')
    await mkUser('finance')
    await mkUser('gate')
    await mkUser('suspended')
    process.env.ADMIN_UIDS = uidOf.super
    const O = uidOf.owner
    for (const k of ['owner', 'suspended']) await put(`users/${uidOf[k]}`, { uid: uidOf[k], role: 'organizer', accountStatus: k === 'suspended' ? 'suspended' : 'active', emailVerified: true, workspaceOwner: true })
    for (const [k, role, perms] of [['finance', 'finance', ['wallet', 'settlements', 'transactions']], ['gate', 'checkin_staff', ['checkin']]] as const) {
      await put(`teamMembers/${P}-${k}`, { organizerUid: O, memberUid: uidOf[k], email: `${P}-${k}@rd.test`, role, permissions: perms, eventIds: [], status: 'active',
        invitedBy: O, invitedAt: new Date(), acceptedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), inviteToken: null })
      await put(`users/${uidOf[k]}`, { uid: uidOf[k], role: 'organizer', accountStatus: 'active', emailVerified: true })
    }
    // ── a CAPACITY-ONLY event (no service ledger): two paid capacity purchases ──
    const D = `${P}-capd`, S = `${P}-caps`
    await put(`users/${O}/eventDrafts/${D}`, { status: 'published', lifecycleStatus: 'published', eventDetails: { info: { name: 'Capacity Only Run' }, seo: { urlSlug: S } } })
    await put(`events/${S}`, { uid: O, draftId: D, slug: S, lifecycleStatus: 'published', totalCapacity: 600, eventDetails: { info: { name: 'Capacity Only Run' } } })
    await put(`eventLicenses/${S}`, { eventId: S, organizerUid: O, orderId: `lic_${D}`, commercialModel: 'capacity', capacity: 600, tier: 'free', version: 2, status: 'active' })
    await put(`registrationCounters/${S}`, { eventSlug: S, totalCount: 120 })
    await put(`licenseOrders/lic_${D}`, { orderId: `lic_${D}`, eventId: D, organizerUid: O, purpose: 'activation', status: 'paid', amountPaise: 47_200, capacityChange: { capacity: 400 }, paidAt: FS.Timestamp.now() })
    await put(`licenseOrders/cap_${S}_1`, { orderId: `cap_${S}_1`, eventId: S, organizerUid: O, purpose: 'capacity', status: 'paid', amountPaise: 35_400, capacityChange: { capacity: 600, previousCapacity: 400 }, paidAt: FS.Timestamp.now() })
    // the owner's communication balance (Wallet page header etc.)
    await put(`organizerWallets/${O}`, { balancePaise: 12_345, currency: 'INR' })
  }, T)

  afterAll(async () => {
    if (savedAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = savedAdminUids
    for (const p of docs) await adminDb.doc(p).delete().catch(() => null)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const c of ['walletServiceRequests', 'walletServiceRequestsLocks']) {
      const qs = await adminDb.collection(c).where('organizerUid', '==', uidOf.owner ?? '-').get().catch(() => null)
      for (const d of qs?.docs ?? []) await d.ref.delete().catch(() => null)
    }
    for (const u of users) await adminAuth.deleteUser(u).catch(() => null)
  }, T)

  // ═══ #10 · Super Admin authority ═══════════════════════════════════════════════════════════
  it('financial admin reads: ADMIN_UIDS yes · legacy claim only 403 SUPER_ADMIN_REQUIRED · organizer 403 · anonymous 403', async () => {
    const routes: Array<[string, () => Promise<{ GET: (r: NextRequest, c?: never) => Promise<Response> }>, string]> = [
      ['wallet-management', () => import('@/app/api/admin/wallet-management/route') as never, '/api/admin/wallet-management?view=events'],
      ['communications (spend)', () => import('@/app/api/admin/communications/route') as never, '/api/admin/communications'],
      ['licenses', () => import('@/app/api/admin/licenses/route') as never, '/api/admin/licenses'],
      ['transactions', () => import('@/app/api/admin/transactions/route') as never, '/api/admin/transactions'],
      ['media-credits ledger', () => import('@/app/api/admin/media-credits/ledger/route') as never, '/api/admin/media-credits/ledger'],
      ['media-credits refunds', () => import('@/app/api/admin/media-credits/refunds/route') as never, '/api/admin/media-credits/refunds'],
      ['finance-reports', () => import('@/app/api/admin/finance-reports/route') as never, '/api/admin/finance-reports'],
      ['failed-refunds', () => import('@/app/api/admin/failed-refunds/route') as never, '/api/admin/failed-refunds'],
      ['clawbacks', () => import('@/app/api/admin/clawbacks/route') as never, '/api/admin/clawbacks'],
      ['service-allowances reconciliation', () => import('@/app/api/admin/service-allowances/reconciliation/route') as never, '/api/admin/service-allowances/reconciliation'],
      ['wallet-service-requests', () => import('@/app/api/admin/wallet-service-requests/route') as never, '/api/admin/wallet-service-requests'],
    ]
    for (const [name, load, url] of routes) {
      const { GET } = await load()
      const plain = await GET(req(url, 'plain'))
      expect(plain.status, `${name} · claim-only`).toBe(403)
      expect(((await plain.json()) as { code?: string }).code, `${name} · code`).toBe('SUPER_ADMIN_REQUIRED')
      expect(await status(GET(req(url, 'owner'))), `${name} · organizer`).toBe(403)
      expect(await status(GET(req(url, null))), `${name} · anonymous`).toBe(403)
      expect(await status(GET(req(url, 'super'))), `${name} · super`).not.toBe(403)
    }
  }, T)

  // RD-SEC-01 · was "withhold every money field for the legacy-claim admin": that caller is no longer
  // an admin of any kind (two roles), so it gets no stats at all — redacted or otherwise.
  it('mixed views (stats): the legacy-claim caller is refused outright; the Super Admin gets the full view', async () => {
    const { GET } = await import('@/app/api/admin/stats/route')
    const plainRes = await GET(req('/api/admin/stats', 'plain'))
    expect([401, 403]).toContain(plainRes.status)
    const plain = await plainRes.json() as Record<string, unknown>
    expect(plain).not.toHaveProperty('lifetimeGrossPaise')
    expect(plain).not.toHaveProperty('organizerCount')
    const sup = await (await GET(req('/api/admin/stats', 'super'))).json() as Record<string, unknown>
    expect(sup.financialRedacted).toBeUndefined()
    expect(typeof sup.lifetimeGrossPaise).toBe('number')
  }, T)

  it('organizer Event Wallet API: owner + finance member yes · check-in member and suspended organizer no', async () => {
    const { GET } = await import('@/app/api/organizer/wallet/events/[draftId]/route')
    const call = (who: string) => GET(req(`/api/organizer/wallet/events/${P}-capd`, who), { params: Promise.resolve({ draftId: `${P}-capd` }) } as never)
    expect(await status(call('owner'))).toBe(200)
    expect(await status(call('finance'))).toBe(200)
    expect(await status(call('gate'))).toBe(403)
    expect([401, 403]).toContain(await status(call('suspended')))
    // an unknown / another workspace's event id is not found, never another organizer's data
    const other = await GET(req(`/api/organizer/wallet/events/${P}-nope`, 'owner'), { params: Promise.resolve({ draftId: `${P}-nope` }) } as never)
    expect(other.status).toBe(404)
  }, T)

  // ═══ #6 · capacity-only events in Super Admin ═════════════════════════════════════════════════
  it('a capacity-only event is listed and has a per-event reconciliation view (no invented ledger)', async () => {
    const svc = await import('@/lib/admin/walletManagementService')
    const list = await svc.listEventServices({ organizerUid: uidOf.owner })
    const row = list.rows.find(r => r.draftId === `${P}-capd`)
    expect(row, 'listed').toBeTruthy()
    expect(row!.ledgerExists).toBe(false)
    expect(row!.slug).toBe(`${P}-caps`)
    expect(row!.license).toMatchObject({ exists: true, commercialModel: 'capacity', capacity: 600 })
    expect(row!.registrations).toBe(120)
    const detail = await svc.getEventWalletDetail({ slug: `${P}-caps` })
    expect(detail!.serviceLedger).toBe('not_applicable')
    expect(detail!.organizerUid).toBe(uidOf.owner)
    expect(detail!.orders.map(o => o.orderId).sort()).toEqual([`cap_${P}-caps_1`, `lic_${P}-capd`].sort())
    expect(detail!.orders.every(o => o.status === 'paid')).toBe(true)
    // also reachable by draft id, and through the Super Admin API
    expect((await svc.getEventWalletDetail({ draftId: `${P}-capd` }))!.slug).toBe(`${P}-caps`)
    const { GET } = await import('@/app/api/admin/wallet-management/route')
    expect(await status(GET(req(`/api/admin/wallet-management?view=event&slug=${P}-caps`, 'super')))).toBe(200)
    expect(await status(GET(req(`/api/admin/wallet-management?view=event&slug=${P}-caps`, 'plain')))).toBe(403)
    expect(await status(GET(req(`/api/admin/wallet-management?view=event&slug=${P}-missing`, 'super')))).toBe(404)
  }, T)

  // ═══ #7 · carry-forward destinations use the LIVE lifecycle ═══════════════════════════════════
  it('carry-forward: valid live destination · draft-open/live-closed refused · draft-closed/live-open allowed · unpublished allowed · deleted / foreign refused · closed between submit and approval refused', async () => {
    const O = uidOf.owner
    const sr = await import('@/lib/wallet/serviceRequests')
    // Source: a closed event with 20 unused prepaid WhatsApp units.
    const SRC = `${P}-src`
    await put(`users/${O}/eventDrafts/${SRC}`, { status: 'published', lifecycleStatus: 'completed', completedAt: FS.Timestamp.fromMillis(Date.now() - 3 * 3_600_000), eventDetails: { info: { name: 'Source' }, seo: { urlSlug: SRC } } })
    await put(`events/${SRC}`, { uid: O, draftId: SRC, lifecycleStatus: 'completed', completedAt: FS.Timestamp.fromMillis(Date.now() - 3 * 3_600_000) })
    await adminDb.doc(`eventServiceAllowances/${SRC}`).set({ draftId: SRC, organizerUid: O, whatsapp: { purchased: 20, consumed: 0, onExhausted: 'block' }, appliedOrders: { [`lic_${SRC}`]: true } }); trees.push(`eventServiceAllowances/${SRC}`)
    await put(`licenseOrders/lic_${SRC}`, { orderId: `lic_${SRC}`, eventId: SRC, organizerUid: O, purpose: 'activation', status: 'paid', amountPaise: 23_600, serviceItems: [{ service: 'whatsapp', quantity: 20, unitPricePaise: 1000, basePaise: 20_000, gstRatePercent: 18, gstPaise: 3_600, totalPaise: 23_600, onExhausted: 'block' }], paidAt: FS.Timestamp.now() })
    const dest = async (key: string, draftLife: string, live: string | null, foreignLive = false) => {
      const id = `${P}-dst-${key}`
      await put(`users/${O}/eventDrafts/${id}`, { status: draftLife === 'draft' ? 'draft' : 'published', lifecycleStatus: draftLife, eventDetails: { info: { name: `Dest ${key}` }, seo: { urlSlug: id } } })
      if (live) await put(`events/${id}`, { uid: foreignLive ? `${P}-someone-else` : O, draftId: id, lifecycleStatus: live })
      trees.push(`eventServiceAllowances/${id}`)
      return id
    }
    const submit = (destinationDraftId: string) => sr.submitServiceRequests({ uid: O, callerUid: O, kind: 'carry_forward', draftId: SRC, services: ['whatsapp'], destinationDraftId, note: 'closure test' })
    const code = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return (e as { code?: string }).code ?? String(e) } }

    // 2 · draft says open, live event closed → refused
    expect(await code(submit(await dest('a', 'published', 'completed')))).toBe('DESTINATION_INVALID')
    // 5 · destination deleted → refused
    expect(await code(submit(`${P}-dst-deleted`))).toBe('DESTINATION_REQUIRED')
    // 6 · draft slug points at ANOTHER organizer's (closed) live event → its lifecycle is ignored; the
    //     draft is treated as this organizer's unpublished draft (open), never as that event
    const forged = await dest('f', 'published', 'completed', true)
    // 4 · unpublished destination (draft claims completed, no live event) → open, allowed
    const unpublished = await dest('u', 'completed', null)
    // 3 · draft says closed, live event open → allowed (the live lifecycle decides)
    const liveOpen = await dest('o', 'completed', 'published')
    // 1 · a valid live destination → allowed, approved, units moved
    const valid = await dest('v', 'published', 'published')
    for (const [name, id] of [['forged', forged], ['unpublished', unpublished], ['live-open', liveOpen]] as const) {
      const r = await submit(id)
      expect(r[0].status, name).toBe('submitted')
      await sr.decideServiceRequest({ adminUid: uidOf.super, id: r[0].id, action: 'reject', reason: 'closure test cleanup' })
    }
    const ok = await submit(valid)
    // 7 · the destination closes between submission and approval → the approval refuses (live read in-txn)
    await adminDb.doc(`events/${valid}`).set({ lifecycleStatus: 'completed', completedAt: FS.Timestamp.now() }, { merge: true })
    expect(await code(sr.decideServiceRequest({ adminUid: uidOf.super, id: ok[0].id, action: 'approve', reason: 'closure test' }))).toBe('DESTINATION_INVALID')
    await adminDb.doc(`events/${valid}`).set({ lifecycleStatus: 'published', completedAt: FS.FieldValue.delete() }, { merge: true })
    const approved = await sr.decideServiceRequest({ adminUid: uidOf.super, id: ok[0].id, action: 'approve', reason: 'closure test' })
    expect(approved.request.status).toBe('approved')
    expect(((await adminDb.doc(`eventServiceAllowances/${valid}`).get()).data() as { whatsapp: { carriedIn: number } }).whatsapp.carriedIn).toBe(20)
    expect(((await adminDb.doc(`eventServiceAllowances/${SRC}`).get()).data() as { whatsapp: { carriedOut: number } }).whatsapp.carriedOut).toBe(20)
    // the carried-in units are NOT refundable as the destination's own purchase
    const view = await sr.getEventRequests(O, valid)
    const wa = view!.services.find(s => s.state.service === 'whatsapp')!
    expect(wa.state.carriedIn).toBe(20)
    expect(wa.state.ownUnused).toBe(0)
  }, T)
})
