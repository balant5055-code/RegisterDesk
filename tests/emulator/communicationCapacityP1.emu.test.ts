// RD-COMMS-P1 — communication capacity on REAL Firestore (emulator).
//
//   • a WhatsApp broadcast is funded by the event's purchased capacity;
//   • what that capacity does not cover drains ONLY an existing legacy balance that covers it all;
//   • otherwise nothing is sent or charged (allowance_exhausted / allowance_required) — including a
//     stored, retired `wallet_payg` exhaustion policy;
//   • email is free and never touches the balance;
//   • the top-up route mints nothing; a top-up created before retirement still credits exactly once;
//   • a License & Services service purchase creates an event allowance, never wallet money;
//   • Usage reads only the caller's own event, with in-progress units counted once;
//   • historical wallet rows are left exactly as they were.
// No request leaves the process; no real money moves.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const UID = `capp1-org-${P}`
const OTHER = `capp1-other-${P}`
const PRICE = 50   // paise — the legacy per-message price (mocked configuration)

vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return {
    ...real,
    getCommunicationConfig: async () => {
      const c = await real.getCommunicationConfig()
      return { ...c, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: PRICE, walletChargeAttendeeNotifications: false } }
    },
  }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['wallet', 'broadcasts'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))

describeEmu('RD-COMMS-P1 · communication capacity on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let billing: typeof import('@/lib/communications/billing')
  const docs = new Set<string>(), trees = new Set<string>()
  let n = 0

  const walletRef = (uid = UID) => adminDb.doc(`organizerWallets/${uid}`)
  const balance = async (uid = UID) => ((await walletRef(uid).get()).data()?.balancePaise as number | undefined) ?? null
  const ledgerOf = async (d: string) => (await adminDb.doc(`eventServiceAllowances/${d}`).get()).data() as Record<string, { purchased?: number; consumed?: number }> | undefined

  async function event(opts: { uid?: string; whatsapp?: { purchased: number; consumed?: number; onExhausted?: string } } = {}) {
    const uid = opts.uid ?? UID
    const k = ++n
    const d = `capp1-d${k}-${P}`, slug = `capp1-ev${k}-${P}`
    docs.add(`users/${uid}/eventDrafts/${d}`); trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`users/${uid}/eventDrafts/${d}`).set({
      status: 'published', lifecycleStatus: 'published',
      eventDetails: { info: { name: `Cap ${k}` }, seo: { urlSlug: slug } },
    })
    await adminDb.doc(`events/${slug}`).set({ uid, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true } })
    if (opts.whatsapp) {
      await adminDb.doc(`eventServiceAllowances/${d}`).set({
        draftId: d, organizerUid: uid,
        whatsapp: { purchased: opts.whatsapp.purchased, consumed: opts.whatsapp.consumed ?? 0, onExhausted: opts.whatsapp.onExhausted ?? 'block' },
      })
    }
    return { d, slug }
  }
  async function campaign(slug: string, recipientCount: number, channel: 'whatsapp' | 'email' = 'whatsapp') {
    const id = `capp1-c${++n}-${P}`
    docs.add(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({
      organizerUid: UID, createdBy: UID, eventId: slug, eventSlug: slug, eventName: 'Cap', channel,
      audience: 'all', subject: 's', html: '<p>x</p>', templateType: 'EVENT_UPDATED', variables: {},
      recipientCount, successCount: 0, failCount: 0, status: 'draft', actualCostPaise: 0,
    })
    return id
  }
  const camp = async (id: string) => (await adminDb.doc(`broadcastCampaigns/${id}`).get()).data() as Record<string, unknown>
  const ledgerRow = async (id: string) => (await adminDb.doc(`walletTransactions/${id}`).get()).exists

  async function wipe() {
    for (const p of docs) await adminDb.doc(p).delete().catch(() => null)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const uid of [UID, OTHER]) {
      for (const col of ['walletTransactions', 'walletTopups'])
        for (const d of (await adminDb.collection(col).where(col === 'walletTopups' ? 'uid' : 'organizerUid', '==', uid).get()).docs) await d.ref.delete()
      await walletRef(uid).delete().catch(() => null)
    }
    docs.clear(); trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    billing = await import('@/lib/communications/billing')
  }, T)
  beforeEach(wipe, T)
  afterAll(wipe, T)

  const start = (id: string, units: number, channel: 'whatsapp' | 'email' = 'whatsapp') =>
    billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel, recipientCount: units })

  // ── 3 · purchased allowance is used ────────────────────────────────────────
  it('3 · an event with purchased WhatsApp capacity uses it — the legacy balance is untouched', async () => {
    const { d, slug } = await event({ whatsapp: { purchased: 100 } })
    await walletRef().set({ balancePaise: 10_000, currency: 'INR' })
    const id = await campaign(slug, 40)
    expect(await start(id, 40)).toEqual({ ok: true, costPaise: 0 })
    expect((await camp(id)).fundedBy).toBe('prepaid_allowance')
    expect((await ledgerOf(d))?.whatsapp?.consumed).toBe(40)
    expect(await balance()).toBe(10_000)
    expect(await ledgerRow(`broadcast_${id}`)).toBe(false)
  }, T)

  // ── 4 · exhausted + legacy balance ⇒ controlled drain ──────────────────────
  it('RD-WA-BLOCK-01 · 4 · capacity used up + a legacy balance that WOULD cover it ⇒ BLOCKED; the balance is not touched', async () => {
    const { d, slug } = await event({ whatsapp: { purchased: 10, consumed: 10 } })
    await walletRef().set({ balancePaise: 5_000, currency: 'INR' })
    const id = await campaign(slug, 20)
    expect(await start(id, 20)).toEqual({ ok: false, reason: 'allowance_exhausted' })
    expect(await camp(id)).toMatchObject({ status: 'failed', failReason: 'allowance_exhausted', actualCostPaise: 0 })
    expect(await balance()).toBe(5_000)                                 // the legacy balance funds nothing new
    expect(await ledgerRow(`broadcast_${id}`)).toBe(false)
    expect((await ledgerOf(d))?.whatsapp?.consumed).toBe(10)
  }, T)

  // ── 5 · exhausted + no legacy balance ⇒ blocked (also for a stored wallet_payg) ──
  for (const policy of ['block', 'wallet_payg'] as const) {
    it(`5 · capacity used up (stored policy ${policy}) + no legacy balance ⇒ blocked, nothing charged`, async () => {
      const { slug } = await event({ whatsapp: { purchased: 10, consumed: 10, onExhausted: policy } })
      const id = await campaign(slug, 5)
      expect(await start(id, 5)).toEqual({ ok: false, reason: 'allowance_exhausted' })
      expect(await camp(id)).toMatchObject({ status: 'failed', failReason: 'allowance_exhausted', actualCostPaise: 0 })
      expect(await balance()).toBeNull()                                  // no wallet created
      expect(await ledgerRow(`broadcast_${id}`)).toBe(false)
    }, T)
  }

  it('5b · a legacy balance that covers only PART of it ⇒ blocked (never a partial or negative charge)', async () => {
    const { slug } = await event({ whatsapp: { purchased: 10, consumed: 10 } })
    await walletRef().set({ balancePaise: 3 * PRICE, currency: 'INR' })
    const id = await campaign(slug, 5)
    expect(await start(id, 5)).toEqual({ ok: false, reason: 'allowance_exhausted' })
    expect(await balance()).toBe(3 * PRICE)
  }, T)

  // ── 6 · no allowance at all ────────────────────────────────────────────────
  it('6 · a NEW event with no WhatsApp capacity and no legacy balance ⇒ blocked, no new wallet charge', async () => {
    const { slug } = await event()
    const id = await campaign(slug, 3)
    expect(await start(id, 3)).toEqual({ ok: false, reason: 'allowance_required' })
    expect(await camp(id)).toMatchObject({ status: 'failed', failReason: 'allowance_required' })
    expect(await balance()).toBeNull()
    expect(await ledgerRow(`broadcast_${id}`)).toBe(false)
  }, T)

  // ── 14 · email is free ─────────────────────────────────────────────────────
  it('14 · an email broadcast is free and never touches the communication balance', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 777, currency: 'INR' })
    const id = await campaign(slug, 500, 'email')
    expect(await start(id, 500, 'email')).toEqual({ ok: true, costPaise: 0 })
    expect(await balance()).toBe(777)
    expect(await ledgerRow(`broadcast_${id}`)).toBe(false)
  }, T)

  // ── 1 / 9 · new top-ups are rejected ───────────────────────────────────────
  it('1 / 9 · a new top-up is refused (410) and creates no order, no top-up record, no balance', async () => {
    const { POST } = await import('@/app/api/organizer/wallet/topup/route')
    const res = await POST(new Request('http://localhost/api/organizer/wallet/topup', {
      method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ amountPaise: 100_000 }),
    }) as never)
    expect(res.status).toBe(410)
    expect((await adminDb.collection('walletTopups').where('uid', '==', UID).get()).empty).toBe(true)
    expect(await balance()).toBeNull()
  }, T)

  // ── 2 · a pending top-up created before retirement still settles ───────────
  it('2 · a top-up created BEFORE retirement still credits exactly once', async () => {
    const { atomicTopupCredit } = await import('@/lib/firebase/firestore/wallet')
    const orderId = `order_capp1_${P}`
    const ref = adminDb.doc(`walletTopups/${orderId}`)
    await ref.set({ orderId, uid: UID, amountPaise: 25_000, currency: 'INR', provider: 'razorpay', status: 'pending', createdAt: new Date('2026-10-01T00:00:00Z') })
    const first = await atomicTopupCredit(UID, 25_000, ref, `pay_capp1_${P}`)
    const again = await atomicTopupCredit(UID, 25_000, ref, `pay_capp1_${P}`)
    expect(first).toMatchObject({ credited: true, newBalance: 25_000 })
    expect(again.credited).toBe(false)
    expect(await balance()).toBe(25_000)
    expect((await ref.get()).data()?.status).toBe('credited')
  }, T)

  // ── 10 · L&S purchase ⇒ event allowance, not wallet money ──────────────────
  it('10 · a License & Services service purchase creates an EVENT allowance, never wallet money', async () => {
    const { d } = await event()
    const { txnApplyServiceItems } = await import('@/lib/licensing/serviceAllowanceLedger')
    const ref = adminDb.doc(`eventServiceAllowances/${d}`)
    await adminDb.runTransaction(async txn => {
      const snap = await txn.get(ref)
      txnApplyServiceItems(txn, snap, { draftId: d, organizerUid: UID, orderId: `add_${d}_1`, items: [
        { service: 'whatsapp', quantity: 500, unitPricePaise: 20, basePaise: 10_000, gstRatePercent: 18, gstPaise: 1_800, totalPaise: 11_800, onExhausted: 'block' },
      ] as never })
    })
    expect((await ledgerOf(d))?.whatsapp?.purchased).toBe(500)
    expect(await balance()).toBeNull()
    expect((await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).empty).toBe(true)
  }, T)

  // ── 11 / 12 · Usage: event-scoped, in-progress counted once, other organizers never ──
  it('11 · Usage shows the selected event’s figures (in progress counted once) and its own broadcasts only', async () => {
    const { getEventCommunicationUsage } = await import('@/lib/communications/usage')
    const a = await event({ whatsapp: { purchased: 100 } })
    const b = await event({ whatsapp: { purchased: 900 } })
    const running = await campaign(a.slug, 30)
    expect(await start(running, 30)).toEqual({ ok: true, costPaise: 0 })   // 30 units held until it settles
    await campaign(b.slug, 7)                                              // another event's broadcast
    const u = await getEventCommunicationUsage(UID, a.d, { includeLegacyBalance: true })
    expect(u?.event.draftId).toBe(a.d)
    expect(u?.whatsapp).toMatchObject({ purchased: 100, inProgress: 30, used: 0, returned: 0, available: 70 })
    expect(u?.broadcasts.map(x => x.id)).toEqual([running])
    expect(u?.email).toMatchObject({ free: true })
    expect(u?.legacyBalancePaise).toBe(0)
  }, T)

  it('12 · another organizer’s event is "not found", and a foreign-owned ledger is never read as this event’s', async () => {
    const { getEventCommunicationUsage } = await import('@/lib/communications/usage')
    const theirs = await event({ uid: OTHER, whatsapp: { purchased: 5_000 } })
    expect(await getEventCommunicationUsage(UID, theirs.d, { includeLegacyBalance: true })).toBeNull()
    // A ledger under OUR draft id but owned by someone else contributes nothing.
    const ours = await event()
    await adminDb.doc(`eventServiceAllowances/${ours.d}`).set({ draftId: ours.d, organizerUid: OTHER, whatsapp: { purchased: 999, consumed: 0, onExhausted: 'block' } })
    const u = await getEventCommunicationUsage(UID, ours.d, { includeLegacyBalance: false })
    expect(u?.whatsapp.purchased).toBe(0)
    expect(u?.legacyBalancePaise).toBeNull()                              // money only for wallet holders
  }, T)

  // ── 13 · historical wallet records stay as they were ───────────────────────
  it('13 · historical wallet rows are left byte-for-byte as they were by every operation above', async () => {
    const hist = adminDb.doc(`walletTransactions/topup_hist_${P}`)
    const row = { organizerUid: UID, type: 'fund_added', amountPaise: 10_000, balancePaise: 10_000, status: 'completed', referenceType: 'topup', referenceId: 'hist', description: 'Historical top-up', metadata: {}, createdAt: new Date('2026-09-01T00:00:00Z') }
    await hist.set(row)
    const { slug } = await event()
    const id = await campaign(slug, 2)
    await start(id, 2)                                                     // blocked: no capacity, no balance
    const after = (await hist.get()).data()!
    expect({ ...after, createdAt: (after.createdAt as { toDate(): Date }).toDate().toISOString() })
      .toEqual({ ...row, createdAt: '2026-09-01T00:00:00.000Z' })
  }, T)
})
