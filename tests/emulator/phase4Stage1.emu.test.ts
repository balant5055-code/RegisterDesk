// RD-PHASE4-S1 — authorization fixes C1, C3, C4, proved against REAL Firestore through the REAL routes.
//
//   C1 · organizer pricing override: the live event is resolved through the reverse-pointer check AND
//        must belong to the caller's workspace; the licensed ceiling comes from server-only licence
//        data, never from the client-writable draft.licenseTier; event scope uses authorizeEvent.
//   C3 · failed-refund resolve/ignore: Super Admin only, reason required, transactional (never
//        overwrites a retry in flight or a completed one).
//   C4 · failed-refund retry: the gateway's existing refunds are checked first — an existing refund is
//        ADOPTED (no second refund), an uncertain lookup issues NOTHING and leaves the record open.
//
// Razorpay is an in-memory stub (no request leaves the process). Identity is mocked at the token
// boundary only (verifyCaller / the admin resolvers); workspace, membership and scope resolution are
// the real code reading real teamMembers rows.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const OWNER = `p4s1-owner-${P}`, VICTIM = `p4s1-victim-${P}`, MANAGER = `p4s1-mgr-${P}`, GATE = `p4s1-gate-${P}`, FIN = `p4s1-fin-${P}`
const SUPER = `p4s1-super-${P}`, PLAIN = `p4s1-plainadmin-${P}`

const h = vi.hoisted(() => ({
  who: '' as string,                         // organizer-side caller uid ('' ⇒ unauthenticated)
  admin: '' as string,                       // admin-side caller uid
  refunds: new Map<string, Array<{ id: string; amount: number; status: string }>>(),   // gateway refunds per payment
  refundCalls: 0,
  lookupPlan: [] as Array<'normal' | 'throw' | 'malformed'>,
  refundPlan: [] as Array<'ok' | 'throw' | 'timeout_after_success'>,
  superUid: '', plainUid: '',
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_p4s1', RAZORPAY_KEY_SECRET: 'p4s1',
  razorpay: {
    payments: {
      fetchMultipleRefund: async (paymentId: string) => {
        const mode = h.lookupPlan.shift() ?? 'normal'
        if (mode === 'throw') throw new Error('simulated Razorpay lookup failure')
        if (mode === 'malformed') return { entity: 'collection' }
        return { entity: 'collection', count: (h.refunds.get(paymentId) ?? []).length, items: h.refunds.get(paymentId) ?? [] }
      },
      refund: async (paymentId: string, o: { amount: number }) => {
        h.refundCalls++
        const mode = h.refundPlan.shift() ?? 'ok'
        if (mode === 'throw') throw new Error('simulated Razorpay refund failure')
        const r = { id: `rfnd_p4s1_${h.refundCalls}_${Math.random().toString(36).slice(2, 7)}`, amount: o.amount, status: 'processed' }
        h.refunds.set(paymentId, [...(h.refunds.get(paymentId) ?? []), r])
        if (mode === 'timeout_after_success') throw new Error('simulated gateway timeout (refund WAS processed)')
        return r
      },
    },
  },
}))
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.admin === h.superUid ? h.admin : null),
  legacyAdminClaimOnly: async () => !!h.plainUid && h.admin === h.plainUid,
  resolveSuperAdminUid: async () => (h.admin === h.superUid ? h.superUid : null),
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))

const req = (body: unknown) => new NextRequest('http://localhost/api/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer t' }, body: JSON.stringify(body),
})
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })

describeEmu('RD-PHASE4-S1 · C1 / C3 / C4 on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  const cleanup = new Set<string>()

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    h.superUid = SUPER; h.plainUid = PLAIN
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    for (const u of [OWNER, VICTIM]) {
      await adminDb.doc(`users/${u}`).set({ uid: u, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true }); cleanup.add(`users/${u}`)
    }
    for (const [m, role, eventIds] of [[MANAGER, 'manager', ['some-other-event']], [GATE, 'checkin_staff', ['some-other-event']], [FIN, 'finance', []]] as const) {
      await adminDb.doc(`teamMembers/${OWNER}_${m}`).set({ organizerUid: OWNER, memberUid: m, role, status: 'active', eventIds, email: `${m}@rd.test` })
      cleanup.add(`teamMembers/${OWNER}_${m}`)
    }
  }, T)
  afterAll(async () => { for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null) }, T)
  beforeEach(() => {
    h.who = ''; h.admin = ''; h.refunds.clear(); h.refundCalls = 0; h.lookupPlan = []; h.refundPlan = []
  })

  // RD-PHASE4-S3 — the organizer route no longer accepts convenienceFee (403 PRICING_NOT_ORGANIZER_EDITABLE);
  // these ownership / scope guarantees are exercised with the one field it still accepts, registrationLimit.
  // ═══ C1 · organizer pricing override ═══════════════════════════════════════════════════════
  const override = async (draftId: string, body: Record<string, unknown>) => {
    const { PATCH } = await import('@/app/api/organizer/events/[eventId]/pricing-override/route')
    return json(await PATCH(req(body), { params: Promise.resolve({ eventId: draftId }) }))
  }
  async function draft(uid: string, id: string, slug: string | null, extra: Record<string, unknown> = {}) {
    await adminDb.doc(`users/${uid}/eventDrafts/${id}`).set({ id, uid, status: 'draft', licenseTier: 'starter', eventDetails: { seo: slug ? { urlSlug: slug } : {} }, ...extra })
    cleanup.add(`users/${uid}/eventDrafts/${id}`)
  }
  async function liveEvent(slug: string, uid: string, draftId: string, tier = 'starter') {
    await adminDb.doc(`events/${slug}`).set({ uid, draftId, slug, lifecycleStatus: 'published' }); cleanup.add(`events/${slug}`)
    await adminDb.doc(`eventLicenses/${slug}`).set({ eventId: slug, organizerUid: uid, tier, status: 'active' }); cleanup.add(`eventLicenses/${slug}`)
  }

  it('C1 · a draft whose slug names ANOTHER organizer’s event is refused and NOTHING is written anywhere', async () => {
    const vSlug = `p4s1-victim-ev-${P}`, vDraft = `p4s1-vd-${P}`, aDraft = `p4s1-ad-${P}`
    await liveEvent(vSlug, VICTIM, vDraft)
    await draft(OWNER, aDraft, vSlug)                                   // client-writable slug pointed at the victim
    h.who = OWNER
    const r = await override(aDraft, { registrationLimit: 50 })
    expect([403, 404, 409]).toContain(r.status)
    expect((await adminDb.doc(`events/${vSlug}`).get()).data()!.organizerOverride).toBeUndefined()
    expect((await adminDb.doc(`users/${OWNER}/eventDrafts/${aDraft}`).get()).data()!.organizerOverride).toBeUndefined()
  }, T)

  it('C1 · a colliding draft id does not help: the live event must belong to THIS workspace', async () => {
    const slug = `p4s1-collide-${P}`, sameId = `p4s1-collide-d-${P}`
    await liveEvent(slug, VICTIM, sameId)                               // victim's event, same draft id
    await draft(OWNER, sameId, slug)
    h.who = OWNER
    const r = await override(sameId, { registrationLimit: 5 })
    expect(r.status).toBe(404)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.organizerOverride).toBeUndefined()
  }, T)

  it('C1 · a FORGED draft.licenseTier cannot raise the ceiling (trusted tier = the live licence)', async () => {
    const { resolveEffectiveLicense } = await import('@/lib/platform/pricing')
    const starterMax = (await resolveEffectiveLicense({ license: { tier: 'starter' } })).maxRegistrations.value
    const entMax     = (await resolveEffectiveLicense({ license: { tier: 'enterprise' } })).maxRegistrations.value
    expect(typeof starterMax === 'number' && (entMax === null || (typeof entMax === 'number' && entMax > starterMax))).toBe(true)
    const slug = `p4s1-forge-${P}`, d = `p4s1-forge-d-${P}`
    await liveEvent(slug, OWNER, d, 'starter')
    await draft(OWNER, d, slug, { licenseTier: 'enterprise' })         // forged client-side
    h.who = OWNER
    const over = await override(d, { registrationLimit: (starterMax as number) + 1 })
    expect(over.status).toBe(400)                                       // above the TRUSTED (starter) ceiling
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.organizerOverride).toBeUndefined()
  }, T)

  it('C1 · the OWNER of the event still sets a valid override (draft + live event); an unpublished draft stays draft-only', async () => {
    const slug = `p4s1-ok-${P}`, d = `p4s1-ok-d-${P}`
    await liveEvent(slug, OWNER, d)
    await draft(OWNER, d, slug)
    h.who = OWNER
    const r = await override(d, { registrationLimit: 12 })
    expect(r.status).toBe(200)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.organizerOverride).toMatchObject({ registrationLimit: 12, updatedBy: OWNER })
    expect((await adminDb.doc(`users/${OWNER}/eventDrafts/${d}`).get()).data()!.organizerOverride).toMatchObject({ registrationLimit: 12 })
    const u = `p4s1-unpub-d-${P}`
    await draft(OWNER, u, `p4s1-unpub-${P}`)                            // slug reserved, no live event yet
    expect((await override(u, { registrationLimit: 3 })).status).toBe(200)
    expect((await adminDb.doc(`users/${OWNER}/eventDrafts/${u}`).get()).data()!.organizerOverride).toMatchObject({ registrationLimit: 3 })
  }, T)

  it('C1 · team access follows the canonical rules: a gate-only or finance member is refused; unauthenticated is 401', async () => {
    const slug = `p4s1-team-${P}`, d = `p4s1-team-d-${P}`
    await liveEvent(slug, OWNER, d)
    await draft(OWNER, d, slug)
    for (const m of [GATE, FIN]) {
      h.who = m
      const r = await override(d, { registrationLimit: 7 })
      expect(r.status, m).toBe(403)
    }
    h.who = ''
    expect((await override(d, { registrationLimit: 7 })).status).toBe(401)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.organizerOverride).toBeUndefined()
  }, T)

  // ═══ C3 · failed-refund resolve / ignore ═══════════════════════════════════════════════════
  const frPatch = async (id: string, body: Record<string, unknown>) => {
    const { PATCH } = await import('@/app/api/admin/failed-refunds/[id]/route')
    return json(await PATCH(req(body), { params: Promise.resolve({ id }) }))
  }
  const frRetry = async (id: string) => {
    const { POST } = await import('@/app/api/admin/failed-refunds/[id]/retry/route')
    // RD-PHASE4-S4 · D3 — a retry now carries a reason.
    return json(await POST(req({ reason: 'retry the refund' }), { params: Promise.resolve({ id }) }))
  }
  async function hold(tag: string, over: Record<string, unknown> = {}) {
    const id = `p4s1-fr-${tag}-${P}`
    await adminDb.doc(`failedRefunds/${id}`).set({
      orderId: `order_p4s1_${tag}`, paymentId: `pay_p4s1_${tag}_${P}`, amountPaise: 5_000, reason: 'test',
      registrationId: null, status: 'open', kind: 'license_remainder_hold', ...over,
    })
    cleanup.add(`failedRefunds/${id}`)
    return id
  }
  const frOf = async (id: string) => (await adminDb.doc(`failedRefunds/${id}`).get()).data()!

  it('C3 · resolve/ignore: plain admin 403; Super Admin needs a real reason; the reason and actor are recorded', async () => {
    const id = await hold('c3a')
    h.admin = PLAIN
    expect((await frPatch(id, { action: 'resolved', reason: 'paid outside razorpay' })).status).toBe(403)
    h.admin = SUPER
    for (const reason of [undefined, '', '   ', 'x']) {
      expect((await frPatch(id, { action: 'resolved', reason })).status, String(reason)).toBe(400)
    }
    expect((await frOf(id)).status).toBe('open')
    const ok = await frPatch(id, { action: 'ignored', reason: 'duplicate of a settled record' })
    expect(ok.status).toBe(200)
    expect(await frOf(id)).toMatchObject({ status: 'ignored', ignoredBy: SUPER, ignoredReason: 'duplicate of a settled record' })
    const audit = (await adminDb.collection('adminAuditLogs').where('entityId', '==', id).get()).docs.map(d => d.data())
    expect(audit.some(a => a.adminUid === SUPER && a.action === 'failed_refund.ignored' && a.metadata?.reason === 'duplicate of a settled record')).toBe(true)
    for (const d of (await adminDb.collection('adminAuditLogs').where('entityId', '==', id).get()).docs) cleanup.add(`adminAuditLogs/${d.id}`)
  }, T)

  it('C3 · a record being retried or already retried/resolved can NOT be closed', async () => {
    h.admin = SUPER
    for (const status of ['retrying', 'retried', 'resolved', 'ignored', 'review']) {
      const id = await hold(`c3b-${status}`, { status })
      const r = await frPatch(id, { action: 'resolved', reason: 'manual check done' })
      expect(r.status, status).toBe(409)
      expect((await frOf(id)).status, status).toBe(status)
    }
  }, T)

  it('C3 · resolve RACING a retry: exactly one transition wins; a resolved record is never refunded', async () => {
    h.admin = SUPER
    for (let i = 0; i < 3; i++) {
      const id = await hold(`c3race-${i}`)
      const calls0 = h.refundCalls
      const [a, b] = await Promise.all([frRetry(id), frPatch(id, { action: 'resolved', reason: 'refunded by bank transfer' })])
      const final = (await frOf(id)).status
      const winners = [a.status, b.status].filter(s => s === 200)
      expect(winners, `round ${i}`).toHaveLength(1)
      if (final === 'resolved') expect(h.refundCalls - calls0).toBe(0)
      else { expect(final).toBe('retried'); expect(h.refundCalls - calls0).toBe(1) }
    }
  }, T)

  // ═══ C4 · retry never refunds twice ═══════════════════════════════════════════════════════
  it('C4 · an EXISTING gateway refund (a timed-out earlier attempt) is adopted — no second refund call', async () => {
    const id = await hold('c4found')
    const { paymentId, amountPaise } = await frOf(id)
    h.refunds.set(paymentId, [{ id: 'rfnd_earlier', amount: amountPaise, status: 'processed' }])
    h.admin = SUPER
    const r = await frRetry(id)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ refundId: 'rfnd_earlier', status: 'retried', reconciled: true })
    expect(h.refundCalls).toBe(0)
    expect(await frOf(id)).toMatchObject({ status: 'retried', retryRefundId: 'rfnd_earlier', reconciledExistingRefund: true })
  }, T)

  it('C4 · lookup FAILS, is MALFORMED, or finds a DIFFERENT refund → nothing is refunded; the record stays open', async () => {
    h.admin = SUPER
    for (const mode of ['throw', 'malformed', 'other_amount', 'two_matches'] as const) {
      const id = await hold(`c4unc-${mode}`)
      const { paymentId, amountPaise } = await frOf(id)
      if (mode === 'throw' || mode === 'malformed') h.lookupPlan = [mode]
      if (mode === 'other_amount') h.refunds.set(paymentId, [{ id: 'rfnd_partial', amount: amountPaise - 100, status: 'processed' }])
      if (mode === 'two_matches') h.refunds.set(paymentId, [{ id: 'r1', amount: amountPaise, status: 'processed' }, { id: 'r2', amount: amountPaise, status: 'pending' }])
      const r = await frRetry(id)
      expect(r.status, mode).toBe(409)
      expect(r.body.code, mode).toBe('REFUND_STATUS_UNCERTAIN')
      expect(h.refundCalls, mode).toBe(0)
      expect((await frOf(id)).status, mode).toBe('open')
    }
  }, T)

  it('C4 · a FAILED earlier refund does not count: a normal retry with no live refund proceeds exactly once', async () => {
    const id = await hold('c4none')
    const { paymentId, amountPaise } = await frOf(id)
    h.refunds.set(paymentId, [{ id: 'rfnd_failed', amount: amountPaise, status: 'failed' }])
    h.admin = SUPER
    const r = await frRetry(id)
    expect(r.status).toBe(200)
    expect(r.body.reconciled).toBeUndefined()
    expect(h.refundCalls).toBe(1)
    expect((await frRetry(id)).status).toBe(409)                        // already retried
    expect(h.refundCalls).toBe(1)
  }, T)

  it('C4 · gateway TIMEOUT after the refund was processed: the next retry adopts it — ONE refund in total', async () => {
    const id = await hold('c4timeout')
    const { paymentId } = await frOf(id)
    h.admin = SUPER
    h.refundPlan = ['timeout_after_success']
    const first = await frRetry(id)
    expect(first.status).toBe(502)
    expect((await frOf(id)).status).toBe('open')
    const second = await frRetry(id)
    expect(second.status).toBe(200)
    expect(second.body.reconciled).toBe(true)
    expect(h.refundCalls).toBe(1)
    expect(h.refunds.get(paymentId)).toHaveLength(1)
  }, T)

  it('C4 · CONCURRENT retries issue at most one refund; plain admin is refused', async () => {
    const id = await hold('c4conc')
    h.admin = PLAIN
    expect((await frRetry(id)).status).toBe(403)
    h.admin = SUPER
    const rs = await Promise.all([0, 1, 2, 3].map(() => frRetry(id)))
    expect(rs.filter(r => r.status === 200)).toHaveLength(1)
    expect(h.refundCalls).toBe(1)
    expect((await frOf(id)).status).toBe('retried')
  }, T)

  it('C4 · a duplicate hold is still never auto-refunded', async () => {
    const id = await hold('c4dup', { kind: 'duplicate_hold', status: 'open' })
    h.admin = SUPER
    expect((await frRetry(id)).status).toBe(409)
    expect(h.refundCalls).toBe(0)
  }, T)
})
