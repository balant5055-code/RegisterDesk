// RD-WALLET-REQ — organizer refund / carry-forward requests for unused prepaid event service units,
// and the Super Admin decisions on them, through the REAL routes on REAL Firestore (private
// emulator). Identity is stubbed at the token boundary only: organizers at lib/team/access
// verifyCaller, admins at lib/admin/auth (SUPER is in ADMIN_UIDS; PLAIN holds only legacy admin:true).
// No payment provider is reachable: any touch of the Razorpay client throws.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `wreq${process.pid}`

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
type Svc = { service: string; purchased: number; consumed: number | null; unusedUnits: number; refund: Body; carryForward: Body; state: Body }

describeEmu('RD-WALLET-REQ · refund and carry-forward requests (real routes, real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
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
  // D6 — closure stamps as the lifecycle writer sets them (server clock), relative to now.
  const closedDaysAgo = (days: number) => FS.Timestamp.fromMillis(Date.now() - days * 86_400_000)
  // 2026-10-06 — the refund window is 24 HOURS, so "recently closed" fixtures are hours old.
  const closedHoursAgo = (hours: number) => FS.Timestamp.fromMillis(Date.now() - hours * 3_600_000)
  const ts = (n: number) => FS.Timestamp.fromMillis(Date.UTC(2026, 8, 1) + n * 60_000)

  const U = `${P}_org`, V = `${P}_other`, SUPER = `${P}_super`, PLAIN = `${P}_plain`
  const [S, S2, S3, O, R, DST, DST2, CLOSED2, VEV] = ['S', 'S2', 'S3', 'O', 'R', 'DST', 'DST2', 'C2', 'VEV'].map(x => `${P}_${x}`)
  const draft = (name: string, lifecycleStatus: string, extra: Record<string, unknown> = {}) => ({
    eventDetails: { info: { name } }, status: lifecycleStatus === 'draft' ? 'draft' : 'published', lifecycleStatus, updatedAt: ts(1), ...extra,
  })
  const waItem = (quantity: number, totalPaise: number) => ({
    service: 'whatsapp', quantity, unitPricePaise: 1000, basePaise: quantity * 1000, gstRatePercent: 18, gstPaise: totalPaise - quantity * 1000, totalPaise, onExhausted: 'block',
  })
  const ledger = async (draftId: string, owner: string, lines: Record<string, unknown>, usage: Record<string, number> = {}) => {
    await adminDb.doc(`eventServiceAllowances/${draftId}`).set({ draftId, organizerUid: owner, ...lines })
    ledgers.push(draftId)
    for (const [service, quantity] of Object.entries(usage)) {
      await adminDb.doc(`eventServiceAllowances/${draftId}/usage/seed_${service}`).set({ service, quantity, source: 'seed', createdAt: ts(1) })
    }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    h.superUid = SUPER; h.plainUid = PLAIN
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    for (const uid of [U, V]) await put(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })

    // S — completed: WhatsApp 100 bought (₹1,180 incl. GST), 30 used; certificates fully used.
    await put(`users/${U}/eventDrafts/${S}`, draft('Spring Marathon', 'completed', { completedAt: closedHoursAgo(6) }))
    await ledger(S, U, { whatsapp: { purchased: 100, consumed: 30, onExhausted: 'block' }, certificates: { purchased: 50, consumed: 50, onExhausted: 'block' }, appliedOrders: { [`lic_${S}`]: true } }, { whatsapp: 30, certificates: 50 })
    await put(`licenseOrders/lic_${S}`, { orderId: `lic_${S}`, eventId: S, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 300_000, serviceItems: [waItem(100, 118_000), { ...waItem(50, 59_000), service: 'certificates' }], createdAt: ts(1) })
    // S2 — cancelled: WhatsApp 40 bought in two orders, none used (carry-forward + concurrency).
    await put(`users/${U}/eventDrafts/${S2}`, draft('Cancelled Expo', 'cancelled', { cancelledAt: closedHoursAgo(5) }))
    await ledger(S2, U, { whatsapp: { purchased: 40, consumed: 0, onExhausted: 'wallet_payg' } })
    await put(`licenseOrders/lic_${S2}`, { orderId: `lic_${S2}`, eventId: S2, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 30_000, serviceItems: [waItem(30, 35_400)], createdAt: ts(1) })
    await put(`licenseOrders/add_${S2}_1`, { orderId: `add_${S2}_1`, eventId: S2, organizerUid: U, purpose: 'addon', status: 'paid', amountPaise: 11_800, serviceItems: [waItem(10, 11_800)], createdAt: ts(2) })
    // S3 — archived: 10 bought, none used (units change between submit and approval).
    await put(`users/${U}/eventDrafts/${S3}`, draft('Old Workshop', 'archived', { completedAt: closedHoursAgo(8), archivedAt: closedHoursAgo(4) }))
    await ledger(S3, U, { whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    await put(`licenseOrders/lic_${S3}`, { orderId: `lic_${S3}`, eventId: S3, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 11_800, serviceItems: [waItem(10, 11_800)], createdAt: ts(1) })
    // O — still published (open). R — completed but the ledger does not match its paid orders.
    await put(`users/${U}/eventDrafts/${O}`, draft('Live Conference', 'published'))
    await ledger(O, U, { whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    await put(`licenseOrders/lic_${O}`, { orderId: `lic_${O}`, eventId: O, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 11_800, serviceItems: [waItem(10, 11_800)], createdAt: ts(1) })
    await put(`users/${U}/eventDrafts/${R}`, draft('Unreconciled Fest', 'completed', { completedAt: closedHoursAgo(5) }))
    await ledger(R, U, { whatsapp: { purchased: 50, consumed: 0, onExhausted: 'block' } })
    // Destinations: DST open (no ledger yet), DST2 open (closed later), CLOSED2 completed, donation draft.
    await put(`users/${U}/eventDrafts/${DST}`, draft('Autumn Run', 'published'))
    await put(`users/${U}/eventDrafts/${DST2}`, draft('Winter Run', 'draft'))
    await put(`users/${U}/eventDrafts/${CLOSED2}`, draft('Past Gala', 'completed'))
    await put(`users/${U}/eventDrafts/${P}_DON`, draft('Relief Drive', 'published', { campaignType: 'donation_only' }))
    // V — another workspace's closed event with unused units.
    await put(`users/${V}/eventDrafts/${VEV}`, draft('Other Org Race', 'completed'))
    await ledger(VEV, V, { whatsapp: { purchased: 20, consumed: 0, onExhausted: 'block' } })
    await put(`licenseOrders/lic_${VEV}`, { orderId: `lic_${VEV}`, eventId: VEV, organizerUid: V, purpose: 'purchase', status: 'paid', amountPaise: 23_600, serviceItems: [waItem(20, 23_600)], createdAt: ts(1) })

    // Activity (filters + pagination).
    for (let i = 0; i < 7; i++) {
      await put(`walletTransactions/${P}_tx${i}`, {
        organizerUid: U, type: i % 2 === 0 ? 'fund_added' : 'whatsapp_charge', amountPaise: 100 + i, balancePaise: 0, status: 'completed',
        referenceType: 'manual', referenceId: `r${i}`, description: `t${i}`, metadata: i % 2 === 0 ? {} : { eventSlug: `${P}-slug` },
        createdAt: FS.Timestamp.fromDate(new Date(`2026-09-0${i + 1}T06:00:00Z`)),
      })
      await put(`communicationUsage/${P}_cu${i}`, {
        organizerUid: U, eventSlug: i < 4 ? `${P}-slug` : '', eventId: 'inconsistent', channel: i % 2 === 0 ? 'email' : 'whatsapp', quantity: 1, costPaise: 0,
        createdAt: FS.Timestamp.fromDate(new Date(`2026-09-0${i + 1}T06:00:00Z`)),
      })
    }
    await put(`users/${U}/eventDrafts/${P}_SLUGGED`, draft('Slugged Event', 'published', { eventDetails: { info: { name: 'Slugged Event' }, seo: { urlSlug: `${P}-slug` } } }))
    await put(`walletTransactions/${P}_txV`, { organizerUid: V, type: 'fund_added', amountPaise: 5, status: 'completed', metadata: {}, createdAt: FS.Timestamp.fromDate(new Date('2026-09-03T06:00:00Z')) })
  }, T)

  afterAll(async () => {
    for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null)
    for (const id of ledgers) await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${id}`)).catch(() => null)
    for (const c of ['walletServiceRequests', 'walletServiceRequestsLocks']) {
      for (const who of [U, V]) {
        const qs = await adminDb.collection(c).where('organizerUid', '==', who).get().catch(() => null)
        for (const d of qs?.docs ?? []) await d.ref.delete().catch(() => null)
      }
    }
    const audits = await adminDb.collection('adminAuditLogs').where('adminUid', '==', SUPER).get().catch(() => null)
    for (const d of audits?.docs ?? []) await d.ref.delete().catch(() => null)
  }, T)
  afterEach(() => { h.who = '' })

  const json = async (res: Response) => ({ status: res.status, body: await res.json() as Body })
  const req = (url: string, method = 'GET', body?: unknown) => new NextRequest(`http://localhost${url}`, {
    method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const orgGet = async (uid: string, qs: string) => {
    h.who = uid
    const { GET } = await import('@/app/api/organizer/wallet/service-requests/route')
    return json(await GET(req(`/api/organizer/wallet/service-requests${qs}`)))
  }
  const orgPost = async (uid: string, body: Body) => {
    h.who = uid
    const { POST } = await import('@/app/api/organizer/wallet/service-requests/route')
    return json(await POST(req('/api/organizer/wallet/service-requests', 'POST', body)))
  }
  const adminList = async (uid: string, qs: string) => {
    h.who = uid
    const { GET } = await import('@/app/api/admin/wallet-service-requests/route')
    return json(await GET(req(`/api/admin/wallet-service-requests${qs}`)))
  }
  const adminGet = async (uid: string, id: string) => {
    h.who = uid
    const { GET } = await import('@/app/api/admin/wallet-service-requests/[id]/route')
    return json(await GET(req(`/api/admin/wallet-service-requests/${id}`), { params: Promise.resolve({ id }) }))
  }
  const decide = async (uid: string, id: string, body: Body) => {
    h.who = uid
    const { POST } = await import('@/app/api/admin/wallet-service-requests/[id]/route')
    return json(await POST(req(`/api/admin/wallet-service-requests/${id}`, 'POST', body), { params: Promise.resolve({ id }) }))
  }
  const line = async (draftId: string, service = 'whatsapp') =>
    ((await adminDb.doc(`eventServiceAllowances/${draftId}`).get()).data()?.[service] ?? {}) as Record<string, number>
  // The organizer view (2026-10-02): services[] = { state, refund, carryForward } — flattened here.
  const svc = (body: Body, service = 'whatsapp'): Svc => {
    const v = (body.services as Array<{ state: Body; refund: Body; carryForward: Body }>).find(x => x.state.service === service)!
    return { service, purchased: v.state.purchased as number, consumed: v.state.used as number | null, unusedUnits: v.state.ownUnused as number, refund: v.refund, carryForward: v.carryForward, state: v.state }
  }
  const auditsFor = async (id: string) => (await adminDb.collection('adminAuditLogs').where('entityId', '==', id).get()).docs.map(d => d.data())
  const REASON = 'Checked the ledger and the paid order.'

  // ── organizer: eligibility ──────────────────────────────────────────────────────────────────
  it('a closed event shows the server-derived unused units, the paid-for upper bound, and why others are not eligible', async () => {
    const r = await orgGet(U, `?event=${S}`)
    expect(r.status).toBe(200)
    expect(r.body.closed).toBe(true)
    expect(r.body.canSubmit).toBe(true)
    expect(svc(r.body)).toMatchObject({ purchased: 100, consumed: 30, unusedUnits: 70, refund: { eligible: true, quantity: 70, upperBoundPaise: 82_600 }, carryForward: { eligible: true, quantity: 70 } })
    expect(svc(r.body, 'certificates')).toMatchObject({ unusedUnits: 0, refund: { eligible: false, code: 'NOTHING_UNUSED' } })
    // Photos: nothing bought here. Capacity: the draft has no live event (no slug).
    expect(svc(r.body, 'media')).toMatchObject({ refund: { eligible: false, code: 'NOT_APPLICABLE' } })
    expect(svc(r.body, 'registrations')).toMatchObject({ refund: { eligible: false, code: 'NOT_APPLICABLE' }, carryForward: { eligible: false, code: 'SERVICE_NOT_SUPPORTED' } })
    const dest = (r.body.destinations as Array<{ draftId: string }>).map(d => d.draftId)
    expect(dest).toEqual(expect.arrayContaining([DST, DST2, O]))
    for (const x of [S, S2, CLOSED2, `${P}_DON`, VEV]) expect(dest).not.toContain(x)
  }, T)

  it('an open event cannot request a post-closure refund; an unreconciled ledger requires review', async () => {
    expect(svc((await orgGet(U, `?event=${O}`)).body).refund).toMatchObject({ eligible: false, code: 'EVENT_NOT_CLOSED' })
    const open = await orgPost(U, { kind: 'refund', draftId: O, service: 'whatsapp' })
    expect(open.status).toBe(409); expect(open.body.code).toBe('EVENT_NOT_CLOSED')
    expect(svc((await orgGet(U, `?event=${R}`)).body).refund).toMatchObject({ eligible: false, code: 'LEDGER_UNRECONCILED' })
    expect((await orgPost(U, { kind: 'refund', draftId: R, service: 'whatsapp' })).status).toBe(409)
  }, T)

  it('other workspaces’ events are invisible; client-sent amounts, quantities and unsupported services are refused', async () => {
    expect((await orgGet(U, `?event=${VEV}`)).status).toBe(404)
    expect((await orgPost(U, { kind: 'refund', draftId: VEV, service: 'whatsapp' })).status).toBe(404)
    const cross = await orgPost(U, { kind: 'carry_forward', draftId: S3, service: 'whatsapp', destinationDraftId: VEV })
    expect(cross.status).toBe(400); expect(cross.body.code).toBe('DESTINATION_REQUIRED')
    for (const k of ['quantity', 'amountPaise', 'approvedAmountPaise', 'organizerUid']) {
      const r = await orgPost(U, { kind: 'refund', draftId: S, service: 'whatsapp', [k]: 1 })
      expect(r.status, k).toBe(400); expect(r.body.code, k).toBe('FIELD_NOT_ALLOWED')
    }
    expect((await orgPost(U, { kind: 'refund', draftId: S, service: 'sms' })).body.code).toBe('SERVICE_NOT_SUPPORTED')
    expect((await orgPost(U, { kind: 'refund', draftId: S, service: 'media' })).body.code).toBe('NOT_APPLICABLE')
    expect((await orgGet('', `?event=${S}`)).status).toBe(401)
    expect((await adminDb.collection('walletServiceRequests').where('organizerUid', '==', U).get()).size).toBe(0)
  }, T)

  // ── refunds ──────────────────────────────────────────────────────────────────────────────────
  let refundId = ''
  it('submitting a refund records the server’s quantity and bound, moves nothing, and blocks a second request for the same units', async () => {
    const r = await orgPost(U, { kind: 'refund', draftId: S, service: 'whatsapp', note: 'Event over' })
    expect(r.status).toBe(201)
    const q = r.body.request as Body
    expect(q).toMatchObject({ kind: 'refund', status: 'submitted', quantity: 70, refundUpperBoundPaise: 82_600, approvedAmountPaise: null, externalReference: null })
    refundId = q.id as string
    expect(await line(S)).toMatchObject({ purchased: 100, consumed: 30 })
    expect((await line(S)).refunded).toBeUndefined()
    expect((await orgPost(U, { kind: 'refund', draftId: S, service: 'whatsapp' })).body.code).toBe('REQUEST_OPEN')
    expect((await orgPost(U, { kind: 'carry_forward', draftId: S, service: 'whatsapp', destinationDraftId: DST })).body.code).toBe('REQUEST_OPEN')
    expect(((await orgGet(U, `?event=${S}`)).body.requests as Body[]).map(x => x.id)).toEqual([refundId])
  }, T)

  it('concurrent submits for the same units create exactly one request', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => orgPost(U, { kind: 'refund', draftId: S3, service: 'whatsapp' })))
    expect(results.filter(r => r.status === 201)).toHaveLength(1)
    expect(results.filter(r => r.status === 409)).toHaveLength(3)
    const open = (await adminDb.collection('walletServiceRequests').where('sourceDraftId', '==', S3).get()).docs.filter(d => d.get('status') === 'submitted')
    expect(open).toHaveLength(1)
  }, T)

  it('only a Super Admin (ADMIN_UIDS) can list, read or decide — legacy admin:true and organizers are refused', async () => {
    for (const who of [PLAIN, U, '']) {
      expect((await adminList(who, '?kind=refund')).status, who || 'anon').toBe(403)
      expect((await adminGet(who, refundId)).status, who || 'anon').toBe(403)
      expect((await decide(who, refundId, { action: 'reject', reason: REASON })).status, who || 'anon').toBe(403)
    }
    const l = await adminList(SUPER, '?kind=refund&status=submitted')
    expect(l.status).toBe(200)
    expect((l.body.requests as Body[]).some(x => x.id === refundId)).toBe(true)
    expect((await adminDb.doc(`walletServiceRequests/${refundId}`).get()).get('status')).toBe('submitted')
  }, T)

  it('a reason is required; the amount must be set and within the paid-for bound; processed needs an approved refund first', async () => {
    expect((await decide(SUPER, refundId, { action: 'approve', approvedAmountPaise: 1000 })).body.code).toBe('REASON_REQUIRED')
    expect((await decide(SUPER, refundId, { action: 'approve', reason: REASON })).body.code).toBe('AMOUNT_REQUIRED')
    expect((await decide(SUPER, refundId, { action: 'approve', reason: REASON, approvedAmountPaise: 82_601 })).body.code).toBe('AMOUNT_ABOVE_LIMIT')
    expect((await decide(SUPER, refundId, { action: 'mark_processed', reason: REASON, externalReference: 'rfnd_X1', refundedAmountPaise: 1 })).body.code).toBe('INVALID_STATE')
    expect((await decide(SUPER, refundId, { action: 'reject', reason: REASON, externalReference: 'rfnd_X1' })).body.code).toBe('EXTERNAL_REFERENCE_NOT_ALLOWED')
    expect((await adminDb.doc(`walletServiceRequests/${refundId}`).get()).get('status')).toBe('submitted')
    expect((await line(S)).refunded).toBeUndefined()
    expect(await auditsFor(refundId)).toHaveLength(0)
  }, T)

  it('the Super Admin view re-derives the current units and bound', async () => {
    const g = await adminGet(SUPER, refundId)
    expect(g.status).toBe(200)
    expect(g.body.current).toMatchObject({ currentUnusedUnits: 70, currentUpperBoundPaise: 82_600, valuation: [{ orderId: `lic_${S}`, units: 70, valuePaise: 82_600 }] })
    expect((g.body.current as Body).state).toMatchObject({ purchased: 100, used: 30, ownUnused: 70, paidPaise: 118_000 })
  }, T)

  it('concurrent approvals apply once: the units leave the ledger once, one audit row, and approved ≠ refunded', async () => {
    const results = await Promise.all(Array.from({ length: 3 }, () => decide(SUPER, refundId, { action: 'approve', reason: REASON, approvedAmountPaise: 80_000 })))
    expect(results.every(r => r.status === 200)).toBe(true)
    expect(results.filter(r => r.body.already === false)).toHaveLength(1)
    expect(await line(S)).toMatchObject({ purchased: 100, consumed: 30, refunded: 70 })
    const doc = (await adminDb.doc(`walletServiceRequests/${refundId}`).get()).data()!
    expect(doc).toMatchObject({ status: 'approved', approvedAmountPaise: 80_000, externalReference: null })
    const audits = await auditsFor(refundId)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: 'wallet_service_request.approved', entityType: 'wallet_service_request', adminUid: SUPER, reason: REASON, actorRole: 'super_admin' })
    expect(audits[0].metadata).toMatchObject({ quantity: 70, approvedAmountPaise: 80_000, upperBoundPaise: 82_600, sourceDraftId: S })
    const org = svc((await orgGet(U, `?event=${S}`)).body)
    expect(org).toMatchObject({ unusedUnits: 0, refund: { eligible: false, code: 'NOTHING_UNUSED' }, carryForward: { eligible: false, code: 'NOTHING_UNUSED' } })
    expect((await orgPost(U, { kind: 'carry_forward', draftId: S, service: 'whatsapp', destinationDraftId: DST })).body.code).toBe('NOTHING_UNUSED')
    expect(((await orgGet(U, `?event=${S}`)).body.requests as Body[])[0]).toMatchObject({ status: 'approved', approvedAmountPaise: 80_000 })
  }, T)

  it('processed requires the external reference; a repeat changes nothing; a different reference is refused', async () => {
    expect((await decide(SUPER, refundId, { action: 'mark_processed', reason: REASON })).body.code).toBe('EXTERNAL_REFERENCE_INVALID')
    // Refund-history S2 — the amount ACTUALLY refunded is required, whole paise, 0 ≤ refunded ≤ approved.
    const ref = { action: 'mark_processed', reason: 'Refunded at the gateway.', externalReference: 'rfnd_ABC123' }
    expect((await decide(SUPER, refundId, ref)).body.code).toBe('REFUNDED_AMOUNT_REQUIRED')
    expect((await decide(SUPER, refundId, { ...ref, refundedAmountPaise: 1.5 })).body.code).toBe('REFUNDED_AMOUNT_REQUIRED')
    expect((await decide(SUPER, refundId, { ...ref, refundedAmountPaise: -1 })).body.code).toBe('REFUNDED_AMOUNT_INVALID')
    expect((await decide(SUPER, refundId, { ...ref, refundedAmountPaise: 80_001 })).body.code).toBe('REFUNDED_AMOUNT_INVALID')
    expect((await decide(SUPER, refundId, { action: 'approve', reason: REASON, refundedAmountPaise: 1 })).body.code).toBe('REFUNDED_AMOUNT_NOT_ALLOWED')
    // approved ₹800 · actually refunded ₹720 (a 10% shortfall, the ₹2,000 / ₹1,800 case)
    const ok = await decide(SUPER, refundId, { ...ref, refundedAmountPaise: 72_000 })
    expect(ok.status).toBe(200); expect(ok.body.already).toBe(false)
    expect((ok.body.request as Body)).toMatchObject({ status: 'processed', externalReference: 'rfnd_ABC123', approvedAmountPaise: 80_000, refundedAmountPaise: 72_000 })
    expect(((ok.body.request as Body).processed as Body)).toMatchObject({ by: SUPER, externalReference: 'rfnd_ABC123', refundedAmountPaise: 72_000 })
    const again = await decide(SUPER, refundId, { ...ref, refundedAmountPaise: 72_000 })
    expect(again.body.already).toBe(true)
    expect((await decide(SUPER, refundId, { ...ref, refundedAmountPaise: 70_000 })).body.code).toBe('ALREADY_PROCESSED')   // same ref, different amount
    expect((await decide(SUPER, refundId, { action: 'mark_processed', reason: REASON, externalReference: 'rfnd_OTHER', refundedAmountPaise: 72_000 })).body.code).toBe('ALREADY_PROCESSED')
    // the approved amount is never rewritten; the audit row carries both
    const stored = (await adminDb.doc(`walletServiceRequests/${refundId}`).get()).data()!
    expect(stored).toMatchObject({ approvedAmountPaise: 80_000, refundedAmountPaise: 72_000 })
    expect((await auditsFor(refundId)).find(a => a.action === 'wallet_service_request.processed')!.metadata).toMatchObject({ approvedAmountPaise: 80_000, refundedAmountPaise: 72_000, externalReference: 'rfnd_ABC123' })
    // the organizer sees the amounts and reference, never the Super Admin's identity
    const mine = ((await orgGet(U, '')).body.requests as Body[]).find(x => x.id === refundId)!
    expect(mine).toMatchObject({ approvedAmountPaise: 80_000, refundedAmountPaise: 72_000, externalReference: 'rfnd_ABC123' })
    expect((mine.decision as Body).by).toBe(''); expect((mine.processed as Body).by).toBe('')
    expect((mine.history as Body[]).filter(hh => hh.role === 'super_admin').every(hh => hh.by === '')).toBe(true)
    // S3 — reconciliation: refunded units match the ledger; the 10% shortfall is reported; nothing is written
    const svcMod = await import('@/lib/wallet/serviceRequests')
    const ledgerBefore = JSON.stringify((await adminDb.doc(`eventServiceAllowances/${S}`).get()).data())
    const reqBefore = JSON.stringify((await adminDb.doc(`walletServiceRequests/${refundId}`).get()).data())
    const rec = await svcMod.reconcileServiceRefunds({ limit: 100 })
    const row = rec.rows.find(x => x.requestId === refundId)!
    expect(row).toMatchObject({ status: 'processed', approvedQuantity: 70, approvedAmountPaise: 80_000, refundedQuantity: 70, refundedAmountPaise: 72_000, outstandingPaise: 8_000 })
    expect(rec.findings.filter(f => f.sourceDraftId === S && f.code === 'LEDGER_REFUNDED_MISMATCH')).toHaveLength(0)
    expect(rec.findings.find(f => f.requestId === refundId)).toMatchObject({ code: 'PARTIALLY_REFUNDED', detail: { outstandingPaise: 8_000 } })
    expect(JSON.stringify((await adminDb.doc(`eventServiceAllowances/${S}`).get()).data())).toBe(ledgerBefore)
    expect(JSON.stringify((await adminDb.doc(`walletServiceRequests/${refundId}`).get()).data())).toBe(reqBefore)
    // a ledger that disagrees with the approved requests is detected (then restored)
    await adminDb.doc(`eventServiceAllowances/${S}`).update({ 'whatsapp.refunded': 71 })
    const bad = await svcMod.reconcileServiceRefunds({ limit: 100 })
    expect(bad.findings.find(f => f.sourceDraftId === S && f.service === 'whatsapp' && f.code === 'LEDGER_REFUNDED_MISMATCH')).toMatchObject({ detail: { approvedRefundUnits: 70, ledgerRefunded: 71 } })
    await adminDb.doc(`eventServiceAllowances/${S}`).update({ 'whatsapp.refunded': 70 })
    expect((await decide(SUPER, refundId, { action: 'reject', reason: REASON })).body.code).toBe('INVALID_STATE')
    expect((await auditsFor(refundId)).map(a => a.action).sort()).toEqual(['wallet_service_request.approved', 'wallet_service_request.processed'])
    expect(await line(S)).toMatchObject({ refunded: 70 })
    const hist = ((await adminDb.doc(`walletServiceRequests/${refundId}`).get()).get('history') as Body[]).map(x => x.action)
    expect(hist).toEqual(['submitted', 'approved', 'processed'])
  }, T)

  it('units used after submission refuse the approval (nothing changes)', async () => {
    const id = (await adminDb.collection('walletServiceRequests').where('sourceDraftId', '==', S3).get()).docs[0].id
    const { reserveServiceUnits } = await import('@/lib/licensing/serviceAllowanceLedger')
    expect((await reserveServiceUnits({ draftId: S3, service: 'whatsapp', unitKey: `${P}_late`, source: 'test' })).mode).toBe('allowance')
    const r = await decide(SUPER, id, { action: 'approve', reason: REASON, approvedAmountPaise: 100 })
    expect(r.status).toBe(409); expect(r.body.code).toBe('UNITS_CHANGED')
    expect((await line(S3)).refunded).toBeUndefined()
    const rej = await decide(SUPER, id, { action: 'reject', reason: 'Units were used after the request.' })
    expect(rej.status).toBe(200)
    expect((await auditsFor(id)).map(a => a.action)).toEqual(['wallet_service_request.rejected'])
    // The lock is released: the organizer can request the 9 units still unused.
    const again = await orgPost(U, { kind: 'refund', draftId: S3, service: 'whatsapp' })
    expect(again.status).toBe(201); expect((again.body.request as Body).quantity).toBe(9)
  }, T)

  // ── carry-forward ────────────────────────────────────────────────────────────────────────────
  it('carry-forward: rejection changes nothing; approval moves the units atomically, once, into the destination ledger', async () => {
    const first = await orgPost(U, { kind: 'carry_forward', draftId: S2, service: 'whatsapp', destinationDraftId: DST })
    expect(first.status).toBe(201)
    const rid = (first.body.request as Body).id as string
    expect((first.body.request as Body)).toMatchObject({ quantity: 40, destination: { draftId: DST, name: 'Autumn Run' }, refundUpperBoundPaise: null })
    expect((await decide(SUPER, rid, { action: 'reject', reason: '' })).body.code).toBe('REASON_REQUIRED')
    expect((await decide(SUPER, rid, { action: 'mark_processed', reason: REASON, externalReference: 'ref_123', refundedAmountPaise: 1 })).body.code).toBe('INVALID_STATE')
    expect((await decide(SUPER, rid, { action: 'reject', reason: 'Wrong destination event.' })).status).toBe(200)
    expect(await line(S2)).toEqual({ purchased: 40, consumed: 0, onExhausted: 'wallet_payg' })
    expect((await adminDb.doc(`eventServiceAllowances/${DST}`).get()).exists).toBe(false)

    const second = await orgPost(U, { kind: 'carry_forward', draftId: S2, service: 'whatsapp', destinationDraftId: DST })
    const id2 = (second.body.request as Body).id as string
    const results = await Promise.all(Array.from({ length: 3 }, () => decide(SUPER, id2, { action: 'approve', reason: REASON })))
    expect(results.every(r => r.status === 200)).toBe(true)
    expect(results.filter(r => r.body.already === false)).toHaveLength(1)
    expect(await line(S2)).toMatchObject({ purchased: 40, consumed: 0, carriedOut: 40 })
    const dst = (await adminDb.doc(`eventServiceAllowances/${DST}`).get()).data()!
    ledgers.push(DST)
    expect(dst).toMatchObject({ draftId: DST, organizerUid: U, whatsapp: { carriedIn: 40 } })
    expect(dst.whatsapp.purchased).toBeUndefined()                         // never "paid" on the destination
    expect((await auditsFor(id2)).map(a => a.action)).toEqual(['wallet_service_request.approved'])
    // The same units can no longer be refunded or carried again.
    const after = svc((await orgGet(U, `?event=${S2}`)).body)
    expect(after).toMatchObject({ unusedUnits: 0, refund: { eligible: false, code: 'NOTHING_UNUSED' } })
    // Carried-in units are neither refundable nor carryable from the destination (it is open anyway).
    const { viewOf } = await import('@/lib/licensing/serviceAllowanceLedger')
    expect(viewOf(dst as never)).toMatchObject({ purchased: { whatsapp: 0 }, carriedIn: { whatsapp: 40 }, remaining: { whatsapp: 40 } })
  }, T)

  it('the destination USES carried-in units, then falls back to pay-as-you-go (no policy was agreed there)', async () => {
    const { reserveServiceUnits } = await import('@/lib/licensing/serviceAllowanceLedger')
    const take = (k: string, quantity = 1) => reserveServiceUnits({ draftId: DST, service: 'whatsapp', unitKey: `${P}_${k}`, quantity, source: 'test' })
    expect(await take('a', 39)).toEqual({ mode: 'allowance', already: false })
    expect(await take('b')).toEqual({ mode: 'allowance', already: false })
    expect(await take('c')).toEqual({ mode: 'none' })
    expect(await line(DST)).toMatchObject({ carriedIn: 40, consumed: 40 })
  }, T)

  it('a destination that closed after the request was submitted refuses the approval', async () => {
    const r = await orgPost(U, { kind: 'carry_forward', draftId: CLOSED2, service: 'whatsapp', destinationDraftId: DST2 })
    expect(r.status).toBe(409)                                               // CLOSED2 has no units at all
    // Use S3's remaining refund request? It is open — reject it, then carry S3 → DST2 and close DST2.
    const open = (await adminDb.collection('walletServiceRequests').where('sourceDraftId', '==', S3).get()).docs.find(d => d.get('status') === 'submitted')!
    await decide(SUPER, open.id, { action: 'reject', reason: 'Switching to carry-forward.' })
    const cf = await orgPost(U, { kind: 'carry_forward', draftId: S3, service: 'whatsapp', destinationDraftId: DST2 })
    expect(cf.status).toBe(201)
    await lifecycle(U, DST2, { lifecycleStatus: 'completed', status: 'published' })
    const d = await decide(SUPER, (cf.body.request as Body).id as string, { action: 'approve', reason: REASON })
    expect(d.status).toBe(409); expect(d.body.code).toBe('DESTINATION_INVALID')
    expect((await line(S3)).carriedOut).toBeUndefined()
    expect((await adminDb.doc(`eventServiceAllowances/${DST2}`).get()).exists).toBe(false)
  }, T)

  it('the admin queue filters by organizer, service, event and date (bounded, paged)', async () => {
    const all = await adminList(SUPER, `?kind=carry_forward&status=all&organizer=${U}`)
    expect(all.status).toBe(200)
    expect((all.body.requests as Body[]).length).toBeGreaterThanOrEqual(3)
    expect((await adminList(SUPER, `?kind=carry_forward&status=all&organizer=${V}`)).body.requests).toEqual([])
    const byEvent = await adminList(SUPER, `?kind=carry_forward&status=all&event=autumn`)
    expect((byEvent.body.requests as Body[]).every(x => (x.destination as Body | null)?.name === 'Autumn Run')).toBe(true)
    expect((await adminList(SUPER, '?kind=refund&status=all&service=certificates')).body.requests).toEqual([])
    expect((await adminList(SUPER, '?kind=refund&status=all&from=2000-01-01&to=2000-01-02')).body.requests).toEqual([])
    expect((await adminList(SUPER, '?kind=refund&status=all&from=2026-02-02&to=2026-01-01')).status).toBe(400)
    expect((await adminList(SUPER, '?kind=refund&status=bogus')).status).toBe(400)
  }, T)

  // ── The 24-hour refund window (2026-10-06; D6 had 30 days) and coupons (Option A) ─────────────
  const seedClosed = async (key: string, stamps: Record<string, unknown>, order: Record<string, unknown> = {}, lifecycle = 'completed') => {
    const id = `${P}_${key}`
    await put(`users/${U}/eventDrafts/${id}`, draft(`D6 ${key}`, lifecycle, stamps))
    await ledger(id, U, { whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    await put(`licenseOrders/lic_${id}`, { orderId: `lic_${id}`, eventId: id, organizerUid: U, purpose: 'purchase', status: 'paid', amountPaise: 11_800, serviceItems: [waItem(10, 11_800)], createdAt: ts(1), ...order })
    return id
  }

  it('24h window through the API: closed 25 h ago ⇒ refused (409) server-side; carry-forward has no window', async () => {
    const late = await seedClosed('late', { completedAt: closedHoursAgo(25) })
    const r = await orgGet(U, `?event=${late}`)
    expect(svc(r.body)).toMatchObject({ refund: { eligible: false, code: 'REFUND_WINDOW_CLOSED' }, carryForward: { eligible: true, quantity: 10 } })
    const post = await orgPost(U, { kind: 'refund', draftId: late, service: 'whatsapp' })
    expect(post.status).toBe(409); expect(post.body.code).toBe('REFUND_WINDOW_CLOSED')
    expect(Date.parse(r.body.refundDeadline as string) - Date.parse(r.body.closedAt as string)).toBe(24 * 3_600_000)
    // a client-supplied clock / deadline is never read: the server decides from its own clock
    const forged = await orgPost(U, { kind: 'refund', draftId: late, service: 'whatsapp', nowMs: 0, windowAt: 0, refundDeadline: '2099-01-01T00:00:00Z', closedAt: new Date().toISOString() })
    expect(forged.status).toBe(409); expect(forged.body.code).toBe('REFUND_WINDOW_CLOSED')

    const inTime = await seedClosed('intime', { completedAt: closedHoursAgo(23) })
    expect(svc((await orgGet(U, `?event=${inTime}`)).body).refund).toMatchObject({ eligible: true, quantity: 10, upperBoundPaise: 11_800 })
  }, T)

  // The exact boundary, on the real server code + Firestore, with the clock pinned:
  // closed 2026-10-10 10:00:00 ⇒ in time strictly before 2026-10-11 10:00:00, refused at/after it.
  const CLOSED = Date.parse('2026-10-10T10:00:00Z'), HOUR = 3_600_000
  for (const [lc, stamp] of [['completed', 'completedAt'], ['cancelled', 'cancelledAt'], ['archived', 'archivedAt']] as const) {
    it(`24h boundary · ${lc}: 23h59m eligible · 24h refused · 24h+1s refused (view AND submit)`, async () => {
      const id = await seedClosed(`b-${lc}`, { [stamp]: FS.Timestamp.fromMillis(CLOSED) }, {}, lc)
      const svcMod = await import('@/lib/wallet/serviceRequests')
      const refundAt = async (ms: number) => (await svcMod.getEventRequests(U, id, CLOSED + ms))!.services.find(s => s.state.service === 'whatsapp')!.refund
      expect(await refundAt(23 * HOUR + 59 * 60_000)).toMatchObject({ eligible: true, quantity: 10 })
      expect(await refundAt(24 * HOUR - 1)).toMatchObject({ eligible: true })
      expect(await refundAt(24 * HOUR)).toMatchObject({ eligible: false, code: 'REFUND_WINDOW_CLOSED' })
      expect(await refundAt(24 * HOUR + 1_000)).toMatchObject({ eligible: false, code: 'REFUND_WINDOW_CLOSED' })
      const view = (await svcMod.getEventRequests(U, id, CLOSED))!
      expect(view.closedAt).toBe('2026-10-10T10:00:00.000Z'); expect(view.refundDeadline).toBe('2026-10-11T10:00:00.000Z')
      // the server's own verdict the Wallet displays (never the browser clock)
      expect((await svcMod.getEventRequests(U, id, CLOSED + 24 * HOUR - 1))!.refundWindowOpen).toBe(true)
      expect((await svcMod.getEventRequests(U, id, CLOSED + 24 * HOUR))!.refundWindowOpen).toBe(false)
      await expect(svcMod.submitServiceRequests({ uid: U, callerUid: U, kind: 'refund', draftId: id, services: ['whatsapp'], note: '', nowMs: CLOSED + 24 * HOUR }))
        .rejects.toMatchObject({ code: 'REFUND_WINDOW_CLOSED' })
      const [ok] = await svcMod.submitServiceRequests({ uid: U, callerUid: U, kind: 'refund', draftId: id, services: ['whatsapp'], note: '', nowMs: CLOSED + 23 * HOUR + 59 * 60_000 })
      expect(ok).toMatchObject({ status: 'submitted', quantity: 10 })
      // Refund-history S1 — the window evidence is SNAPSHOTTED as accepted
      const snapshot = { closureAt: '2026-10-10T10:00:00.000Z', deadlineAt: '2026-10-11T10:00:00.000Z', submittedAt: new Date(CLOSED + 23 * HOUR + 59 * 60_000).toISOString(), submittedWithinWindow: true }
      expect(ok.window).toEqual(snapshot)
      expect((await adminDb.doc(`walletServiceRequests/${ok.id}`).get()).get('window')).toEqual(snapshot)
      // Super Admin evidence: judged at the server's submission instant (23h59m) ⇒ inside the window,
      // with the event's lifecycle, closure and deadline
      const adminView = await svcMod.getAdminRequest(ok.id) as unknown as { current: { event: Record<string, unknown> } }
      expect(adminView.current.event).toMatchObject({ lifecycle: lc, closedAt: '2026-10-10T10:00:00.000Z', refundDeadline: '2026-10-11T10:00:00.000Z', submittedWithinWindow: true })
      // S1 — restore and re-close the event 2 days later: the CURRENT evidence follows the new closure,
      // the historical snapshot on the request does not change.
      await lifecycle(U, id, { restoredAt: FS.Timestamp.fromMillis(CLOSED + 30 * HOUR), lifecycleStatus: 'completed', completedAt: FS.Timestamp.fromMillis(CLOSED + 48 * HOUR) })
      const later = await svcMod.getAdminRequest(ok.id) as unknown as { request: { window: unknown }; current: { event: Record<string, unknown> } }
      expect(later.current.event.closedAt).toBe(new Date(CLOSED + 48 * HOUR).toISOString())
      expect(later.request.window).toEqual(snapshot)
      // a duplicate request for the same units is refused while the first is open
      await expect(svcMod.submitServiceRequests({ uid: U, callerUid: U, kind: 'refund', draftId: id, services: ['whatsapp'], note: '', nowMs: CLOSED + HOUR }))
        .rejects.toMatchObject({ code: 'REQUEST_OPEN' })
    }, T)
  }

  it('D6 window: no recorded closure fails closed; a restore starts a new closure', async () => {
    const unknown = await seedClosed('nostamp', {})
    expect(svc((await orgGet(U, `?event=${unknown}`)).body)).toMatchObject({ refund: { eligible: false, code: 'CLOSURE_DATE_UNKNOWN' }, carryForward: { eligible: true } })
    // cancelled 60 d ago → archived → restored 10 d ago → completed 2 h ago: the window runs from the NEW closure.
    const reopened = await seedClosed('reopened', { cancelledAt: closedDaysAgo(60), archivedAt: closedDaysAgo(59), restoredAt: closedDaysAgo(10), completedAt: closedHoursAgo(2) })
    const v = await orgGet(U, `?event=${reopened}`)
    expect(svc(v.body).refund).toMatchObject({ eligible: true })
    expect(Math.round((Date.now() - Date.parse(v.body.closedAt as string)) / 3_600_000)).toBe(2)
  }, T)

  it('the window is a SUBMISSION rule: a request made in time can still be approved after 24 h', async () => {
    const id = await seedClosed('slowreview', { completedAt: closedHoursAgo(23) })
    const sub = await orgPost(U, { kind: 'refund', draftId: id, service: 'whatsapp' })
    expect(sub.status).toBe(201)
    await lifecycle(U, id, { completedAt: closedDaysAgo(40) })
    const ok = await decide(SUPER, (sub.body.request as Body).id as string, { action: 'approve', reason: REASON, approvedAmountPaise: 11_800 })
    expect(ok.status).toBe(200)
    expect(await line(id)).toMatchObject({ refunded: 10 })
  }, T)

  // D6 Option A: the coupon discounted the ACTIVATION fee (₹5 off a ₹50 activation); the WhatsApp line
  // (10 × ₹11.80 incl. GST) was charged in full, so it is refundable in full — no allocation.
  const COUPON_ORDER = { couponCode: 'SAVE10', discountPaise: 500, originalPricePaise: 16_800, finalPricePaise: 16_300, amountPaise: 16_300 }

  it('D6 Option A: units bought in a coupon order are refundable at the line’s full paid amount (incl. GST)', async () => {
    const id = await seedClosed('coupon', { completedAt: closedHoursAgo(3) }, COUPON_ORDER)
    const v = await orgGet(U, `?event=${id}`)
    expect(svc(v.body)).toMatchObject({ refund: { eligible: true, quantity: 10, upperBoundPaise: 11_800 }, carryForward: { eligible: true, quantity: 10 } })
    const post = await orgPost(U, { kind: 'refund', draftId: id, service: 'whatsapp' })
    expect(post.status).toBe(201)
    expect(post.body.request).toMatchObject({ quantity: 10, refundUpperBoundPaise: 11_800 })
  }, T)

  it('D6 Option A at approval: the full line amount can be approved; above it is refused; it applies once', async () => {
    const id = await seedClosed('coupon-approve', { completedAt: closedHoursAgo(3) }, COUPON_ORDER)
    const sub = await orgPost(U, { kind: 'refund', draftId: id, service: 'whatsapp' })
    const rid = (sub.body.request as Body).id as string
    expect((await adminGet(SUPER, rid)).body.current).toMatchObject({ currentUpperBoundPaise: 11_800 })
    expect((await decide(SUPER, rid, { action: 'approve', reason: REASON, approvedAmountPaise: 11_801 })).body.code).toBe('AMOUNT_ABOVE_LIMIT')
    const results = await Promise.all([1, 2].map(() => decide(SUPER, rid, { action: 'approve', reason: REASON, approvedAmountPaise: 11_800 })))
    expect(results.every(r => r.status === 200)).toBe(true)
    expect(results.filter(r => r.body.already === false)).toHaveLength(1)
    expect(await line(id)).toMatchObject({ refunded: 10 })
    expect((await auditsFor(rid)).map(a => a.action)).toEqual(['wallet_service_request.approved'])
    // The order itself is untouched: the activation discount stays where it was given.
    expect((await adminDb.doc(`licenseOrders/lic_${id}`).get()).data()).toMatchObject({ discountPaise: 500, amountPaise: 16_300 })
  }, T)

  it('organizers never see another workspace’s requests', async () => {
    h.who = V
    const { GET } = await import('@/app/api/organizer/wallet/service-requests/route')
    const v = await json(await GET(req('/api/organizer/wallet/service-requests')))
    expect(v.body.requests).toEqual([])
    const u = await orgGet(U, '')
    expect((u.body.requests as Body[]).length).toBeGreaterThan(0)
    expect((u.body.requests as Body[]).every(x => x.organizerUid === U)).toBe(true)
  }, T)

  // ── activity filters ─────────────────────────────────────────────────────────────────────────
  it('transactions: direction and date filters, stable cursor pages, own rows only', async () => {
    h.who = U
    const { GET } = await import('@/app/api/organizer/wallet/transactions/route')
    const get = async (qs: string) => json(await GET(req(`/api/organizer/wallet/transactions?${qs}`)))
    const credits = await get('direction=credit&from=2026-09-01&to=2026-09-07')
    expect((credits.body.transactions as Body[]).map(t => t.id)).toEqual([`${P}_tx6`, `${P}_tx4`, `${P}_tx2`, `${P}_tx0`])
    const ids: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 5; i++) {
      const p = await get(`limit=3&from=2026-09-01&to=2026-09-07${cursor ? `&cursor=${cursor}` : ''}`)
      ids.push(...(p.body.transactions as Body[]).map(t => t.id as string))
      cursor = p.body.nextCursor as string | null
      if (!cursor) break
    }
    expect(ids).toEqual([6, 5, 4, 3, 2, 1, 0].map(i => `${P}_tx${i}`))
    const range = await get('from=2026-09-03&to=2026-09-04')
    expect((range.body.transactions as Body[]).map(t => t.id)).toEqual([`${P}_tx3`, `${P}_tx2`])
  }, T)

  it('usage: attributed by eventSlug only, with channel filter and pagination', async () => {
    h.who = U
    const { GET } = await import('@/app/api/organizer/wallet/usage/route')
    const get = async (qs: string) => json(await GET(req(`/api/organizer/wallet/usage?${qs}`)))
    const ev = await get(`event=${P}_SLUGGED&from=2026-09-01&to=2026-09-07`)
    expect((ev.body.usage as Body[]).map(u => u.id)).toEqual([3, 2, 1, 0].map(i => `${P}_cu${i}`))
    const wa = await get(`event=${P}_SLUGGED&channel=whatsapp&limit=1`)
    expect((wa.body.usage as Body[]).map(u => u.id)).toEqual([`${P}_cu3`])
    const next = await get(`event=${P}_SLUGGED&channel=whatsapp&limit=1&cursor=${wa.body.nextCursor as string}`)
    expect((next.body.usage as Body[]).map(u => u.id)).toEqual([`${P}_cu1`])
    expect((await get(`event=${VEV}`)).status).toBe(404)
    // A draft with no public slug can have nothing attributed (eventId is never used).
    expect((await get(`event=${S}`)).body.usage).toEqual([])
  }, T)
})
