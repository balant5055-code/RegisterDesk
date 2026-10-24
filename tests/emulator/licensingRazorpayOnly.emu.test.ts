// RD-LICENSE-PAYMENT-01 — event activation and capacity changes are paid through RAZORPAY
// ONLY, and never touch the communication wallet — proved against REAL Firestore by driving
// the REAL routes.
//
// ═══ WHY THIS SUITE EXISTS ═══════════════════════════════════════════════════
// Until RD-LICENSE-PAYMENT-01 the activation flow was wallet-first: purchase read
// `organizerWallets/{uid}`, took as much of the price as the balance allowed, sent only the
// remainder to Razorpay, and confirm debited the wallet and wrote a `walletTransactions` row.
// With enough balance Razorpay was skipped entirely. The communication wallet exists only for
// WhatsApp / bulk / SMS usage, so that coupling was a financial-architecture defect.
//
// The invariant this suite pins is the one that matters to an auditor:
//
//   for every activation and every capacity change,
//     communicationWalletBalanceAfter === communicationWalletBalanceBefore
//   and no `walletTransactions` row is ever written by licensing.
//
// Razorpay is replaced by an in-memory stub (the same `vi.hoisted` pattern creditPurchases
// uses), so NO request ever reaches a real gateway — `.env.local` holds live keys. Everything
// else — the routes, the transactions, the signature HMAC, the captured-payment re-check — is
// the production code.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
// RD-EVENT-COMMERCE-05F — requests carry the Publish Agreement, as the wizard's always do.
import { withPublishAgreement } from '../helpers/publishAgreement'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const SECRET = 'rd_license_payment_01_secret'

const UID   = `licpay-org-${process.pid}`
const DRAFT = `licpay-draft-${process.pid}`
const EVENT = `licpay-event-${process.pid}`

const rzp = vi.hoisted(() => ({
  seq: 0,
  orders:   [] as Array<{ id: string; amount: number; currency: string; notes?: Record<string, string> }>,
  payments: new Map<string, Record<string, unknown>>(),
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID:     'rzp_test_licpay',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string; notes?: Record<string, string> }) => {
        const order = { id: `order_licpay_${++rzp.seq}`, amount: o.amount, currency: o.currency, notes: o.notes }
        rzp.orders.push(order)
        return order
      },
      fetchPayments: async () => ({ items: [] }),
    },
    payments: {
      fetch: async (id: string) => {
        const p = rzp.payments.get(id)
        if (!p) throw new Error('payment not found')
        return p
      },
      refund: async () => ({ id: `rfnd_licpay_${++rzp.seq}` }),
    },
  },
}))

// Auth is not under test here — every route authorises the same seeded organizer.
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => ({ uid: UID, email: null }),
}))
vi.mock('@/lib/team/workspace', async orig => {
  const ctx = { callerUid: UID, workspaceUid: UID, role: 'owner', permissions: [], isOwner: true, eventIds: [], isStaffCredential: false }
  return {
    ...(await orig<typeof import('@/lib/team/workspace')>()),
    resolveWorkspaceUid:  async () => ctx,
    authorizeWorkspace:   async () => ({ ...ctx, ok: true, status: 200, error: '' }),
  }
})
// Best-effort organizer notifications after confirm — irrelevant to money, kept silent.
vi.mock('@/lib/notifications/organizerWhatsApp', () => ({ sendOrganizerWhatsApp: async () => undefined }))

const sign = (orderId: string, paymentId: string) =>
  crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex')

const req = (body: unknown) => new NextRequest('http://localhost/api/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body),
})

describeEmu('RD-LICENSE-PAYMENT-01 · activation is Razorpay-only, the communication wallet is untouched', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let purchase:        (r: NextRequest) => Promise<Response>
  let confirm:         (r: NextRequest) => Promise<Response>
  let capacityOrder:   (r: NextRequest) => Promise<Response>
  let capacityConfirm: (r: NextRequest) => Promise<Response>

  const walletRef = () => adminDb.doc(`organizerWallets/${UID}`)
  const balance   = async () => ((await walletRef().get()).data()?.balancePaise ?? null) as number | null
  const licenceTxns = async () => {
    const all = await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()
    return all.docs.filter(d => d.id.startsWith('license_') || d.id.startsWith('capacity_') || d.data().type === 'license_charge')
  }

  async function seedDraft(capacity: number) {
    await adminDb.doc(`users/${UID}/eventDrafts/${DRAFT}`).set({
      id: DRAFT, uid: UID, status: 'draft', eventType: 'sports', licenseTier: 'free', registrationCapacity: capacity,
    })
  }
  async function setWallet(paise: number | null) {
    if (paise === null) await walletRef().delete().catch(() => null)
    else await walletRef().set({ balancePaise: paise, currency: 'INR' })
  }
  /** Simulate the organizer paying the Razorpay order in the checkout modal. */
  function pay(order: { id: string; amount: number }, over: Record<string, unknown> = {}) {
    const paymentId = `pay_licpay_${++rzp.seq}`
    rzp.payments.set(paymentId, { id: paymentId, order_id: order.id, amount: order.amount, currency: 'INR', status: 'captured', ...over })
    return { razorpay_order_id: order.id, razorpay_payment_id: paymentId, razorpay_signature: sign(order.id, paymentId) }
  }

  async function wipe() {
    for (const col of ['licenseOrders', 'licenseHistory']) {
      const s = await adminDb.collection(col).where('eventId', 'in', [DRAFT, EVENT]).get()
      for (const d of s.docs) await d.ref.delete()
    }
    for (const d of (await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    // The verification-failure cases flag their payments, exactly as production does.
    for (const d of (await adminDb.collection('suspiciousPayments').where('entityId', 'in', [DRAFT, EVENT]).get()).docs) await d.ref.delete()
    await adminDb.doc(`users/${UID}/eventDrafts/${DRAFT}`).delete().catch(() => null)
    await adminDb.doc(`events/${EVENT}`).delete().catch(() => null)
    await adminDb.doc(`eventLicenses/${EVENT}`).delete().catch(() => null)
    await walletRef().delete().catch(() => null)
    rzp.orders.length = 0
    rzp.payments.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;purchase        = withPublishAgreement((await import('@/app/api/licensing/purchase/route')).POST)
    ;({ POST: confirm }         = await import('@/app/api/licensing/checkout/confirm/route'))
    ;({ POST: capacityOrder }   = await import('@/app/api/licensing/capacity/order/route'))
    ;({ POST: capacityConfirm } = await import('@/app/api/licensing/capacity/confirm/route'))
  }, T)
  afterAll(wipe, T)
  beforeEach(wipe, T)

  // ═══ A · capacity ≤ 100 — nothing to pay, no wallet, no gateway ══════════════
  it('A · capacity 100 needs no payment and never touches the wallet or Razorpay', async () => {
    await seedDraft(100); await setWallet(500_000)
    const res  = await purchase(req({ eventId: DRAFT, capacity: 100 }))
    const body = await res.json() as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(body.pricePaise).toBe(0)
    expect(body.checkout ?? null).toBeNull()
    expect(body).not.toHaveProperty('walletUsePaise')
    expect(rzp.orders).toHaveLength(0)
    expect(await balance()).toBe(500_000)
    expect(await licenceTxns()).toHaveLength(0)
  }, T)

  // ═══ B/C/D · capacity 1206 — Razorpay for the FULL ₹1,957.62 whatever the wallet holds ═
  for (const [label, wallet] of [['C · ₹5,000 in the communication wallet', 500_000], ['D · ₹0 communication wallet', 0], ['D · no wallet document at all', null]] as const) {
    it(`B/${label}: Razorpay order = 195762, confirm activates, wallet unchanged`, async () => {
      await seedDraft(1206); await setWallet(wallet)
      const before = await balance()

      const pRes  = await purchase(req({ eventId: DRAFT, capacity: 1206 }))
      const pBody = await pRes.json() as { ok?: boolean; pricePaise?: number; checkout?: { razorpayOrderId: string; amountPaise: number } | null }
      expect(pRes.status).toBe(200)
      expect(pBody.ok).toBe(true)
      expect(pBody.pricePaise).toBe(195_762)
      expect(pBody).not.toHaveProperty('walletUsePaise')
      expect(pBody).not.toHaveProperty('remainderPaise')
      // The Razorpay order is for the WHOLE price — never a remainder.
      expect(rzp.orders).toHaveLength(1)
      expect(rzp.orders[0].amount).toBe(195_762)
      expect(pBody.checkout?.amountPaise).toBe(195_762)

      // The capacity order is saved BEFORE checkout, carrying the server's snapshot.
      const created = (await adminDb.doc(`licenseOrders/lic_${DRAFT}`).get()).data()!
      expect(created.status).toBe('created')
      expect(created.razorpayAmountPaise).toBe(195_762)
      expect(created.amountPaise).toBe(195_762)
      expect(created.capacityChange).toMatchObject({ capacity: 1206, chargeableCapacity: 1106, basePaise: 165_900, gstPaise: 29_862, totalPaise: 195_762 })

      const cRes  = await confirm(req({ eventId: DRAFT, ...pay(rzp.orders[0]) }))
      const cBody = await cRes.json() as Record<string, unknown>
      expect(cRes.status).toBe(200)
      expect(cBody.success).toBe(true)
      expect(cBody.razorpayAmountPaise).toBe(195_762)
      expect(cBody).not.toHaveProperty('walletUsePaise')

      const paid = (await adminDb.doc(`licenseOrders/lic_${DRAFT}`).get()).data()!
      expect(paid.status).toBe('paid')
      expect(paid.commercialModel).toBe('capacity')
      expect(paid.capacityChange.capacity).toBe(1206)

      // THE invariant.
      expect(await balance()).toBe(before)
      expect(await licenceTxns()).toHaveLength(0)
    }, T)
  }

  // ═══ F · the payment verification is unweakened ═════════════════════════════
  for (const [label, over, sig] of [
    ['a captured amount one paisa short', { amount: 195_761 }, null],
    ['a non-INR currency',                 { currency: 'USD' },  null],
    ['a payment that is not captured',     { status: 'created' }, null],
    ['a forged signature',                 {},                    'deadbeef'],
  ] as const) {
    it(`F · refuses ${label} — nothing activated, wallet unchanged`, async () => {
      await seedDraft(1206); await setWallet(500_000)
      await purchase(req({ eventId: DRAFT, capacity: 1206 }))
      const p = pay(rzp.orders[0], over)
      const res = await confirm(req({ eventId: DRAFT, ...p, ...(sig ? { razorpay_signature: sig } : {}) }))
      expect(res.status).toBe(400)
      expect((await adminDb.doc(`licenseOrders/lic_${DRAFT}`).get()).data()!.status).toBe('created')
      expect(await balance()).toBe(500_000)
      expect(await licenceTxns()).toHaveLength(0)
    }, T)
  }

  it('F · confirm without any payment details is refused for a payable order', async () => {
    await seedDraft(1206); await setWallet(500_000)
    await purchase(req({ eventId: DRAFT, capacity: 1206 }))
    const res = await confirm(req({ eventId: DRAFT }))
    expect(res.status).toBe(400)
    expect((await adminDb.doc(`licenseOrders/lic_${DRAFT}`).get()).data()!.status).toBe('created')
    expect(await balance()).toBe(500_000)
  }, T)

  it('confirming twice settles once (idempotent) and still never touches the wallet', async () => {
    await seedDraft(1206); await setWallet(500_000)
    await purchase(req({ eventId: DRAFT, capacity: 1206 }))
    const p = pay(rzp.orders[0])
    expect((await confirm(req({ eventId: DRAFT, ...p }))).status).toBe(200)
    const again = await confirm(req({ eventId: DRAFT, ...p }))
    expect(again.status).toBe(200)
    expect(((await again.json()) as { alreadyPaid?: boolean }).alreadyPaid).toBe(true)
    expect(await balance()).toBe(500_000)
    expect(await licenceTxns()).toHaveLength(0)
  }, T)

  // ═══ legacy split orders — created before this change — fail closed ══════════
  it('a pre-change wallet-split activation order is refused, not activated at a discount', async () => {
    await seedDraft(1206); await setWallet(500_000)
    const snapshot = { purpose: 'activation', operation: 'activation', capacity: 1206, previousCapacity: null, freeCapacity: 100,
      chargeableCapacity: 1106, activationRatePaise: 150, basePaise: 165_900, gstRatePercent: 18, gstPaise: 29_862, totalPaise: 195_762 }
    await adminDb.doc(`licenseOrders/lic_${DRAFT}`).set({
      orderId: `lic_${DRAFT}`, eventId: DRAFT, organizerUid: UID, tier: 'free', fromTier: null, purpose: 'purchase',
      amountPaise: 195_762, currency: 'INR', status: 'created', razorpayOrderId: 'order_legacy_split',
      razorpayPaymentId: null, razorpayAmountPaise: 95_762,            // ₹1,000 was planned from the wallet
      commercialModel: 'capacity', capacityChange: snapshot, createdAt: new Date(), updatedAt: new Date(), paidAt: null,
    })
    const legacy = { id: 'order_legacy_split', amount: 95_762 }
    const res = await confirm(req({ eventId: DRAFT, ...pay(legacy) }))
    expect(res.status).toBe(409)
    expect((await adminDb.doc(`licenseOrders/lic_${DRAFT}`).get()).data()!.status).toBe('created')
    expect(await balance()).toBe(500_000)
    expect(await licenceTxns()).toHaveLength(0)
  }, T)

  it('purchase supersedes an unpaid pre-change split order with a FULL-price Razorpay order', async () => {
    await seedDraft(1206); await setWallet(500_000)
    await adminDb.doc(`licenseOrders/lic_${DRAFT}`).set({
      orderId: `lic_${DRAFT}`, eventId: DRAFT, organizerUid: UID, tier: 'free', fromTier: null, purpose: 'purchase',
      amountPaise: 195_762, currency: 'INR', status: 'created', razorpayOrderId: 'order_legacy_unpaid',
      razorpayPaymentId: null, razorpayAmountPaise: 95_762, createdAt: new Date(), updatedAt: new Date(), paidAt: null,
    })
    const res  = await purchase(req({ eventId: DRAFT, capacity: 1206 }))
    const body = await res.json() as { checkout?: { razorpayOrderId: string; amountPaise: number } }
    expect(res.status).toBe(200)
    expect(body.checkout?.amountPaise).toBe(195_762)
    expect(body.checkout?.razorpayOrderId).not.toBe('order_legacy_unpaid')
    const order = (await adminDb.doc(`licenseOrders/lic_${DRAFT}`).get()).data()!
    expect(order.razorpayAmountPaise).toBe(195_762)
    expect(await balance()).toBe(500_000)
  }, T)

  // ═══ E · capacity increase 1206 → 2000 — the FULL ₹1,405.38 through Razorpay ═══
  async function seedPublished(capacity: number) {
    await adminDb.doc(`events/${EVENT}`).set({ uid: UID, draftId: EVENT, totalCapacity: capacity, pricing: { eventType: 'paid' } })
    await adminDb.doc(`eventLicenses/${EVENT}`).set({
      eventId: EVENT, organizerUid: UID, tier: 'free', status: 'active', version: 2,
      amountPaise: 195_762, orderId: `lic_${EVENT}`, commercialModel: 'capacity', capacity,
    })
  }

  it('E · increase 1206 → 2000: Razorpay order = 140538, applied, wallet unchanged', async () => {
    await seedPublished(1206); await setWallet(500_000)
    const oRes  = await capacityOrder(req({ eventId: EVENT, capacity: 2000 }))
    const oBody = await oRes.json() as { orderId: string; quote: { chargeableCapacity: number; basePaise: number; gstPaise: number; totalPaise: number }; checkout: { razorpayOrderId: string; amountPaise: number } | null }
    expect(oRes.status).toBe(200)
    expect(oBody.quote).toMatchObject({ chargeableCapacity: 794, basePaise: 119_100, gstPaise: 21_438, totalPaise: 140_538 })
    expect(oBody).not.toHaveProperty('walletUsePaise')
    expect(rzp.orders).toHaveLength(1)
    expect(rzp.orders[0].amount).toBe(140_538)
    expect(oBody.checkout?.amountPaise).toBe(140_538)

    const order = rzp.orders[0]
    const cRes = await capacityConfirm(req({ eventId: EVENT, orderId: oBody.orderId, ...pay(order) }))
    expect(cRes.status).toBe(200)
    expect((await adminDb.doc(`events/${EVENT}`).get()).data()!.totalCapacity).toBe(2000)
    expect(await balance()).toBe(500_000)
    expect(await licenceTxns()).toHaveLength(0)
  }, T)

  it('E · a capacity-change payment for the wrong amount is refused and the capacity stays', async () => {
    await seedPublished(1206); await setWallet(500_000)
    const oBody = await (await capacityOrder(req({ eventId: EVENT, capacity: 2000 }))).json() as { orderId: string }
    const res = await capacityConfirm(req({ eventId: EVENT, orderId: oBody.orderId, ...pay(rzp.orders[0], { amount: 140_000 }) }))
    expect(res.status).toBe(400)
    expect((await adminDb.doc(`events/${EVENT}`).get()).data()!.totalCapacity).toBe(1206)
    expect(await balance()).toBe(500_000)
  }, T)

  it('E · a pre-change wallet-covered capacity order can no longer settle without a payment', async () => {
    await seedPublished(1206); await setWallet(500_000)
    const oBody = await (await capacityOrder(req({ eventId: EVENT, capacity: 2000 }))).json() as { orderId: string }
    // Rewrite it into the shape the old wallet-first code produced: nothing left for Razorpay.
    await adminDb.doc(`licenseOrders/${oBody.orderId}`).set({ razorpayAmountPaise: 0, razorpayOrderId: null }, { merge: true })
    const res = await capacityConfirm(req({ eventId: EVENT, orderId: oBody.orderId }))
    expect(res.status).toBe(409)
    expect((await adminDb.doc(`events/${EVENT}`).get()).data()!.totalCapacity).toBe(1206)
    expect(await balance()).toBe(500_000)
    expect(await licenceTxns()).toHaveLength(0)
  }, T)

  // ═══ communication billing is untouched by licensing — and (RD-WA-BLOCK-01) never funds a NEW message ═════
  it('RD-WA-BLOCK-01 · a WhatsApp broadcast with no event capacity is refused; the communication wallet is not charged', async () => {
    const { chargeAndStartCampaign } = await import('@/lib/communications/billing')
    await setWallet(500_000)
    const campaignId = `licpay-camp-${process.pid}`
    await adminDb.doc(`broadcastCampaigns/${campaignId}`).set({ organizerUid: UID, status: 'draft', channel: 'whatsapp' })
    const r = await chargeAndStartCampaign({ campaignId, organizerUid: UID, channel: 'whatsapp', recipientCount: 10 })
    // Owner decision 2026-10-24: event capacity or nothing — the legacy balance no longer funds new messages.
    expect(r).toEqual({ ok: false, reason: 'allowance_required' })
    expect(await balance()).toBe(500_000)
    expect((await adminDb.doc(`walletTransactions/broadcast_${campaignId}`).get()).exists).toBe(false)
    await adminDb.doc(`broadcastCampaigns/${campaignId}`).delete()
  }, T)
})
