// RD-CE-FIX H4 / M3 / M4 — the Create Event money races, end to end on real Firestore.
//
//   H4  checkout started → capacity lowered to free → publish → the OLD payment is captured.
//       Before: purchase answered "₹0" without settling the pending order, publish ignored it, and the
//       late payment then activated after publish (money captured, units granted, capacity never
//       applied). Now: publish settles a pending order first (captured → activated; unknown → refuse)
//       and SUPERSEDES an unpaid one atomically with the event, so a late capture is HELD for review.
//   M3  paid 500 → draft trimmed to 300 → publish used to consume the paid order and store 300.
//       Now refused (CAPACITY_BELOW_PAID) — paid capacity is never silently given up.
//   M4  a second captured payment on an already-paid order used to be acknowledged and dropped.
//       Now recorded as an idempotent hold (failedRefunds/license_dup_{payment}); nothing granted twice.
//
// Real route handlers: purchase, checkout/confirm, publish and the Razorpay webhook. Only Razorpay,
// the caller and outbound notifications are mocked.

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { withPublishAgreement } from '../helpers/publishAgreement'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const SECRET = 'rd_ce_fix_races_secret'
const WHSEC = 'whsec_ce_fix_races'
const UID = `ceraces-org-${process.pid}`

const rzp = vi.hoisted(() => ({
  seq: 0,
  payments: new Map<string, Record<string, unknown>>(),
  captures: new Map<string, Array<Record<string, unknown>> | 'throw'>(),
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_ceraces', RAZORPAY_KEY_SECRET: SECRET,
  razorpay: {
    orders: {
      create: async (o: { amount: number; currency: string }) => ({ id: `order_ceraces_${++rzp.seq}`, amount: o.amount, currency: o.currency }),
      fetchPayments: async (orderId: string) => {
        const c = rzp.captures.get(orderId)
        if (c === 'throw') throw new Error('razorpay unavailable')
        return { items: c ?? [] }
      },
    },
    payments: {
      fetch: async (id: string) => { const p = rzp.payments.get(id); if (!p) throw new Error('payment not found'); return p },
      refund: async () => { throw new Error('no automatic refunds') },
    },
  },
}))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: WHSEC }))
vi.mock('@/lib/team/access', async orig => ({ ...(await orig<typeof import('@/lib/team/access')>()), verifyCaller: async () => ({ uid: UID, email: null }) }))
vi.mock('@/lib/team/workspace', async orig => {
  const ctx = { callerUid: UID, workspaceUid: UID, role: 'owner', permissions: ['events'], isOwner: true, eventIds: [], isStaffCredential: false }
  return { ...(await orig<typeof import('@/lib/team/workspace')>()), resolveWorkspaceUid: async () => ctx, authorizeWorkspace: async () => ({ ...ctx, ok: true, status: 200, error: '' }) }
})
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/events/reviewNotifications', () => ({ sendEventReviewEmail: async () => undefined }))
vi.mock('@/lib/notifications/organizerWhatsApp', () => ({ sendOrganizerWhatsApp: async () => undefined }))
vi.mock('@/lib/notifications/servicePurchase', () => ({ scheduleServicePurchaseNotification: () => undefined }))

const sign = (orderId: string, paymentId: string) => crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex')
const req = (body: unknown) => new NextRequest('http://localhost/api/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body),
})

function draftDoc(id: string, capacity: number) {
  return {
    id, status: 'draft', lifecycleStatus: 'draft', currentStep: 7, completedValues: Array(9).fill(null),
    eventType: 'sports', eventSubtype: 'running', customEventSubtype: null, campaignType: null, linkedCampaign: null,
    visibility: 'public', accessControl: { type: 'open', approvedContacts: [], confirmationMode: 'auto' },
    pricing: { eventType: 'paid', feeModel: 'organizer_pays', passes: [{
      id: 'pass_0', name: '10K', code: 'TENK', description: 'Ten kilometres.', type: 'paid', price: 1500,
      earlyBirdEnabled: false, earlyBirdPrice: null, earlyBirdEndDate: '', unlimited: true, quantity: null,
      minPurchase: 1, maxPurchase: 5, salesStartDate: '2026-01-01', salesEndDate: '2099-12-30', status: 'active',
      visibility: 'public', benefits: [], customBenefits: [], raceDetails: null, eventType: 'sports', eventSubtype: 'running' }] },
    registrationForm: { template: 'standard', fields: [{ id: 'f0', label: 'T-shirt', type: 'select', required: true, options: ['S', 'M'] }] },
    eventDetails: {
      info: { name: `Races ${id}`, fullDesc: 'A race used to verify Create Event payment races. '.repeat(4) },
      schedule: { startDate: '2099-12-31', startTime: '06:00', endDate: '2099-12-31', endTime: '12:00', timezone: 'Asia/Kolkata' },
      venue: { type: 'physical', physical: { name: 'Cubbon Park', addressLine1: 'MG Road', city: 'Bengaluru', state: 'Karnataka' } },
      organizer: { name: 'Races Co', email: 'races@example.test', phone: '+919999999999' },
    },
    communicationBilling: null, licenseTier: 'free', publishedAt: null, registrationCapacity: capacity,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
  }
}

describeEmu('RD-CE-FIX H4/M3/M4 · Create Event payment races', () => {
  let db: import('firebase-admin/firestore').Firestore
  let publish: (r: NextRequest) => Promise<Response>
  let purchase: (r: NextRequest) => Promise<Response>
  let confirm: (r: NextRequest) => Promise<Response>
  let webhook: (r: NextRequest) => Promise<Response>
  const P = process.pid

  const lic = async (d: string) => (await db.doc(`licenseOrders/lic_${d}`).get()).data() as Record<string, unknown> | undefined
  const startCheckout = async (d: string, capacity: number) => {
    const r = await purchase(req({ eventId: d, capacity }))
    const body = await r.json() as { razorpayOrderId?: string; amountPaise?: number; razorpayAmountPaise?: number }
    const o = await lic(d)
    expect(o?.status, JSON.stringify(body)).toBe('created')
    return { rzpOrder: o!.razorpayOrderId as string, amount: o!.razorpayAmountPaise as number }
  }
  const capture = (orderId: string, amount: number, pay: string) => {
    const p = { id: pay, status: 'captured', amount, currency: 'INR', order_id: orderId }
    rzp.payments.set(pay, p)
    return p
  }
  const pay = async (d: string, orderId: string, amount: number, payId: string) => {
    capture(orderId, amount, payId)
    return confirm(req({ eventId: d, razorpay_order_id: orderId, razorpay_payment_id: payId, razorpay_signature: sign(orderId, payId) }))
  }
  const doPublish = async (d: string) => {
    const r = await publish(req({ draftId: d }))
    return { status: r.status, body: await r.json() as Record<string, unknown> }
  }
  const webhookCaptured = async (entity: { id: string; order_id: string; amount: number }) => {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { status: 'captured', currency: 'INR', ...entity } } } })
    const sig = crypto.createHmac('sha256', WHSEC).update(body).digest('hex')
    return webhook(new NextRequest('http://localhost/api/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body }))
  }

  beforeAll(async () => {
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ POST: publish } = await import('@/app/api/events/publish/route')); publish = withPublishAgreement(publish)
    ;({ POST: purchase } = await import('@/app/api/licensing/purchase/route')); purchase = withPublishAgreement(purchase)
    ;({ POST: confirm } = await import('@/app/api/licensing/checkout/confirm/route'))
    ;({ POST: webhook } = await import('@/app/api/webhooks/razorpay/route'))
    await db.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active', email: `${UID}@rd.test`, workspaceOwner: true })
  }, T)

  it('H4 (exact audit scenario): checkout → capacity lowered → publish → old payment captured ⇒ HELD, never granted', async () => {
    const d = `cer-h4-${P}`
    await db.doc(`users/${UID}/eventDrafts/${d}`).set(draftDoc(d, 500))
    const { rzpOrder, amount } = await startCheckout(d, 500)
    await db.doc(`users/${UID}/eventDrafts/${d}`).update({ registrationCapacity: 100 })   // back to free
    const pub = await doPublish(d)
    expect(pub.status, JSON.stringify(pub.body)).toBe(200)
    const slug = pub.body.slug as string
    expect((await db.doc(`events/${slug}`).get()).get('totalCapacity')).toBe(100)
    // the pending checkout was superseded atomically with the event
    const now = await lic(d)
    expect([now?.status, now?.failReason, now?.razorpayOrderId]).toEqual(['failed', 'superseded', null])
    const archive = (await db.doc(`licenseOrders/lic_${d}__sup_${rzpOrder}`).get()).data()
    expect([archive?.status, archive?.failReason, archive?.razorpayOrderId]).toEqual(['failed', 'superseded', rzpOrder])
    // the OLD payment is captured afterwards — via the browser confirm …
    const late = await pay(d, rzpOrder, amount, `pay_ceraces_h4_${P}`)
    expect(late.status).toBe(409)
    expect((await late.json() as { code?: string }).code).toBe('PAYMENT_HELD')
    // … and via the webhook (same payment): still exactly one hold, nothing granted
    expect((await webhookCaptured({ id: `pay_ceraces_h4_${P}`, order_id: rzpOrder, amount })).status).toBe(200)
    const holds = await db.collection('failedRefunds').where('paymentId', '==', `pay_ceraces_h4_${P}`).get()
    expect(holds.size).toBe(1)
    expect(holds.docs[0].get('reason')).toBe('superseded_paid')
    expect((await db.doc(`events/${slug}`).get()).get('totalCapacity')).toBe(100)
    expect((await lic(d))?.status).toBe('failed')
  }, T)

  it('payment captured before publish but never confirmed (browser closed) ⇒ publish settles it and honours it', async () => {
    const d = `cer-heal-${P}`
    await db.doc(`users/${UID}/eventDrafts/${d}`).set(draftDoc(d, 500))
    const { rzpOrder, amount } = await startCheckout(d, 500)
    const p = capture(rzpOrder, amount, `pay_ceraces_heal_${P}`)
    rzp.captures.set(rzpOrder, [p])
    const pub = await doPublish(d)
    expect(pub.status, JSON.stringify(pub.body)).toBe(200)
    expect((await db.doc(`events/${pub.body.slug as string}`).get()).get('totalCapacity')).toBe(500)
    const o = await lic(d)
    expect([o?.status, o?.consumed, o?.razorpayPaymentId]).toEqual(['paid', true, `pay_ceraces_heal_${P}`])
  }, T)

  it('a payment status that cannot be established publishes nothing and changes nothing', async () => {
    const d = `cer-unk-${P}`
    await db.doc(`users/${UID}/eventDrafts/${d}`).set(draftDoc(d, 500))
    const { rzpOrder } = await startCheckout(d, 500)
    rzp.captures.set(rzpOrder, 'throw')
    await db.doc(`users/${UID}/eventDrafts/${d}`).update({ registrationCapacity: 100 })
    const pub = await doPublish(d)
    expect(pub.status).toBe(409)
    expect(pub.body.reason).toBe('PAYMENT_STATUS_UNCONFIRMED')
    expect((await lic(d))?.status).toBe('created')
    expect((await db.doc(`users/${UID}/eventDrafts/${d}`).get()).get('publishedAt')).toBeNull()
  }, T)

  it('M3: paid for 500, draft trimmed to 300 ⇒ refused; publishing at the paid capacity works and consumes once', async () => {
    const d = `cer-m3-${P}`
    await db.doc(`users/${UID}/eventDrafts/${d}`).set(draftDoc(d, 500))
    const { rzpOrder, amount } = await startCheckout(d, 500)
    expect((await pay(d, rzpOrder, amount, `pay_ceraces_m3_${P}`)).status).toBe(200)
    await db.doc(`users/${UID}/eventDrafts/${d}`).update({ registrationCapacity: 300 })
    const refused = await doPublish(d)
    expect(refused.status).toBe(409)
    expect(refused.body.reason).toBe('CAPACITY_BELOW_PAID')
    expect((await lic(d))?.consumed).not.toBe(true)
    await db.doc(`users/${UID}/eventDrafts/${d}`).update({ registrationCapacity: 500 })
    const ok = await doPublish(d)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await db.doc(`events/${ok.body.slug as string}`).get()).get('totalCapacity')).toBe(500)
    expect((await lic(d))?.consumed).toBe(true)
  }, T)

  it('M4: a SECOND captured payment on a paid order is held (confirm + webhook), once; nothing is granted twice', async () => {
    const d = `cer-m4-${P}`
    await db.doc(`users/${UID}/eventDrafts/${d}`).set(draftDoc(d, 500))
    const { rzpOrder, amount } = await startCheckout(d, 500)
    expect((await pay(d, rzpOrder, amount, `pay_ceraces_m4a_${P}`)).status).toBe(200)
    const before = await lic(d)
    // the same payment again (a replay) is a no-op
    expect((await pay(d, rzpOrder, amount, `pay_ceraces_m4a_${P}`)).status).toBe(200)
    // a DIFFERENT payment on the same paid order
    const second = await pay(d, rzpOrder, amount, `pay_ceraces_m4b_${P}`)
    expect(second.status).toBe(409)
    expect((await second.json() as { code?: string }).code).toBe('PAYMENT_HELD')
    expect((await webhookCaptured({ id: `pay_ceraces_m4b_${P}`, order_id: rzpOrder, amount })).status).toBe(200)
    const hold = await db.doc(`failedRefunds/license_dup_pay_ceraces_m4b_${P}`).get()
    expect(hold.exists).toBe(true)
    expect([hold.get('status'), hold.get('amountPaise'), hold.get('creditedPaymentId')]).toEqual(['open', amount, `pay_ceraces_m4a_${P}`])
    expect((hold.get('detectedBy') as string[]).sort()).toEqual(['confirm', 'webhook'])
    expect((await db.collection('failedRefunds').where('paymentId', '==', `pay_ceraces_m4a_${P}`).get()).size).toBe(0)
    const after = await lic(d)
    expect([after?.status, after?.razorpayPaymentId, after?.amountPaise]).toEqual([before?.status, before?.razorpayPaymentId, before?.amountPaise])
  }, T)
})
