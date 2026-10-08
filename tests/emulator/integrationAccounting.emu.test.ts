// RD-INTEG — DEEP INTEGRATION AUDIT + FIX PASS, proved against REAL Firestore (emulator).
//
//   Broadcast billing = "charge on Meta accept" (product decision, 2026-10-05):
//     • wallet-funded: charged for every recipient up front, the unaccepted share credited back
//       when the campaign ends (one deterministic refund row, idempotent)
//     • prepaid-funded: one unit per recipient up front, unaccepted units released to the event
//     • no provider / nothing sent ⇒ everything returned
//     • cancelled mid-run / crashed before settling ⇒ the cron sweep settles it
//     • a webhook "failed" AFTER acceptance does not refund (the message stays charged)
//     • the event Wallet shows the NET charge; usage rows carry the net cost
//   Transactional WhatsApp: usage row once per message, with what was actually charged.
//   Admin licence refund: the refunded order's unused prepaid units are retired (D1).
//
// The Meta provider is an in-memory stub. No request leaves the process; no real money moves.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { withWaOptIn, seedConsentingRegistrations } from '../helpers/whatsappConsentFixture'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const UID = `integ-org-${P}`
const PRICE = 50   // paise per WhatsApp message (mocked configuration below)

const h = vi.hoisted(() => ({
  /** last 10 digits → provider outcome. Absent ⇒ accepted. */
  outcome: new Map<string, 'ok' | 'reject' | 'timeout'>(),
  sends: [] as string[],
  noProvider: false,
}))

vi.mock('@/lib/whatsapp', async orig => {
  const real = await orig<typeof import('@/lib/whatsapp')>()
  return {
    ...real,
    getMetaProvider: async () => (h.noProvider ? null : {
      sendTemplate: async (m: { to?: string }) => {
        const to = String(m.to ?? '')
        h.sends.push(to)
        const r = h.outcome.get(to.slice(-10)) ?? 'ok'
        if (r === 'ok') return { success: true, messageId: `wamid.${P}.${h.sends.length}` }
        if (r === 'timeout') return { success: false, error: 'The operation was aborted due to timeout' }
        return { success: false, httpStatus: 400, code: 131026, error: 'Message undeliverable' }
      },
    }),
    hasWhatsAppTemplate: () => true,
    resolveWhatsAppTemplateByType: (_t: unknown, to: string) => ({ ok: true, message: { to, templateName: 'integ_test' } }),
    resolveWhatsAppTemplate: (_t: unknown, to: string) => ({ ok: true, message: { to, templateName: 'integ_test' } }),
  }
})
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return {
    ...real,
    getCommunicationConfig: async () => {
      const c = await real.getCommunicationConfig()
      return { ...c, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: PRICE, walletChargeAttendeeNotifications: true } }
    },
  }
})
// No outbound side effects from completion.
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => undefined }))
vi.mock('@/lib/crm/service', () => ({ crmRecordBroadcastBatch: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', () => ({ notifyBroadcastComplete: () => undefined }))
// The broadcast retry loop sleeps between attempts on a retryable refusal — not under test here.
vi.mock('@/lib/whatsapp/failureReason', async orig => ({ ...(await orig<typeof import('@/lib/whatsapp/failureReason')>()), isRetryableWhatsAppFailure: () => false }))

describeEmu('RD-INTEG · communication accounting on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let send: typeof import('@/lib/broadcasts/send')
  let billing: typeof import('@/lib/communications/billing')
  let sweep: typeof import('@/lib/broadcasts/settlementSweep')
  let waJob: typeof import('@/lib/broadcasts/whatsappJob')
  const docs = new Set<string>(), trees = new Set<string>()
  // RD-COMMS-WA-CONSENT — synthetic recipients get real, opted-in registration docs (see helper).
  const consenting = async <R extends { id: string; data: { attendee: { phone?: string } } }>(rs: R[]): Promise<R[]> => { await seedConsentingRegistrations(adminDb, rs, docs); return rs }
  let n = 0

  const walletRef = () => adminDb.doc(`organizerWallets/${UID}`)
  const balance = async () => ((await walletRef().get()).data()?.balancePaise as number | undefined) ?? 0
  const phone = (i: number) => `+9198765${String(10000 + i).slice(-5)}`

  async function event(opts: { prepaid?: number } = {}) {
    const k = ++n
    const d = `integ-d${k}-${P}`, slug = `integ-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`); docs.add(`users/${UID}/eventDrafts/${d}`)
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).set({
      status: 'published', lifecycleStatus: 'published',
      eventDetails: { info: { name: `Integ ${k}`, startDate: '2099-01-01', endDate: '2099-01-02' }, seo: { urlSlug: slug } },
    })
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true } })
    if (opts.prepaid) {
      await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: opts.prepaid, consumed: 0, onExhausted: 'block' } })
    }
    return { d, slug }
  }

  async function regs(slug: string, phones: string[]) {
    for (const [i, ph] of phones.entries()) {
      const id = `integ-r-${slug}-${i}`
      docs.add(`registrations/${id}`)
      await adminDb.doc(`registrations/${id}`).set(withWaOptIn({
        organizerUid: UID, eventSlug: slug, status: 'confirmed', ticketCode: `T${i}`,
        attendee: { name: `A${i}`, email: `a${i}@example.test`, phone: ph },
      }))
    }
  }

  async function campaign(slug: string, recipientCount: number, extra: Record<string, unknown> = {}) {
    const id = `integ-c${++n}-${P}`
    docs.add(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({
      organizerUid: UID, createdBy: UID, eventId: slug, eventSlug: slug, eventName: 'Integ', channel: 'whatsapp',
      audience: 'all', subject: '', html: '', templateType: 'EVENT_UPDATED', variables: {},
      recipientCount, successCount: 0, failCount: 0, status: 'draft', actualCostPaise: 0, ...extra,
    })
    return id
  }
  const camp = async (id: string) => (await adminDb.doc(`broadcastCampaigns/${id}`).get()).data() as Record<string, unknown>
  const txn  = async (id: string) => (await adminDb.doc(`walletTransactions/${id}`).get())
  const usageFor = async (campaignId: string) => (await adminDb.collection('communicationUsage').where('campaignId', '==', campaignId).get()).docs.map(d => d.data())
  const ledger = async (d: string) => (await adminDb.doc(`eventServiceAllowances/${d}`).get()).data() as { whatsapp?: { consumed?: number; purchased?: number; refunded?: number } } | undefined
  const settleWait = () => new Promise(r => setTimeout(r, 400))   // fire-and-forget usage/log writes

  async function wipe() {
    for (const p of docs) await adminDb.doc(p).delete().catch(() => null)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const col of ['walletTransactions', 'communicationUsage', 'emailLogs', 'licenseHistory'])
      for (const d of (await adminDb.collection(col).where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection(waJob.WHATSAPP_BROADCAST_JOBS).where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(d.ref)
    await walletRef().delete().catch(() => null)
    docs.clear(); trees.clear()
    h.outcome.clear(); h.sends.length = 0; h.noProvider = false
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    send    = await import('@/lib/broadcasts/send')
    billing = await import('@/lib/communications/billing')
    sweep   = await import('@/lib/broadcasts/settlementSweep')
    waJob   = await import('@/lib/broadcasts/whatsappJob')
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active', emailVerified: true }, { merge: true })
  }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null) }, T)
  beforeEach(wipe, T)

  // ═══ 1 · wallet-funded broadcast ════════════════════════════════════════════
  it('wallet: 5 charged up front, 3 accepted ⇒ 2 credited back; usage + event Wallet show the net', async () => {
    const { d, slug } = await event()
    await walletRef().set({ balancePaise: 100_000, currency: 'INR' })
    await regs(slug, [phone(1), phone(2), phone(3), phone(4), 'abc'])
    h.outcome.set(phone(4).slice(-10), 'reject')
    const id = await campaign(slug, 5)

    const r = await send.startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 5 })
    expect(r).toEqual({ ok: true, costPaise: 5 * PRICE })
    await settleWait()

    const c = await camp(id)
    expect(c.status).toBe('partial')
    expect(c.successCount).toBe(3)
    // RD-COMMS-WA-CONSENT (phone binding) — 'abc' can hold no consent (an opt-in is bound to a valid
    // number), so it is no longer selected: 4 recipients, 1 refused. Every money figure is unchanged.
    expect(c.failCount).toBe(1)
    expect(c.billingSettlement).toBe('settled')
    expect(c.billedUnits).toBe(3)
    expect(c.refundedUnits).toBe(2)
    expect(c.refundedPaise).toBe(2 * PRICE)
    expect(c.actualCostPaise).toBe(3 * PRICE)
    expect(c.chargedCostPaise).toBe(5 * PRICE)

    expect(await balance()).toBe(100_000 - 3 * PRICE)
    const charge = (await txn(`broadcast_${id}`)).data()!
    expect(charge.amountPaise).toBe(5 * PRICE)
    expect((charge.metadata as Record<string, unknown>).eventSlug).toBe(slug)
    const refund = (await txn(`broadcast_refund_${id}`)).data()!
    expect(refund.type).toBe('refund')
    expect(refund.amountPaise).toBe(2 * PRICE)
    expect((refund.metadata as Record<string, unknown>).units).toBe(2)
    expect((refund.metadata as Record<string, unknown>).eventSlug).toBe(slug)

    const usage = await usageFor(id)
    expect(usage).toHaveLength(1)
    expect(usage[0].quantity).toBe(3)
    expect(usage[0].costPaise).toBe(3 * PRICE)

    // Idempotent: a second settlement (cron sweep / replayed terminal hook) changes nothing.
    const again = await billing.settleBroadcastBilling(id, 5)
    expect(again.already).toBe(true)
    expect(await balance()).toBe(100_000 - 3 * PRICE)

    // The event Wallet nets the credit out of what it reports as charged to the balance.
    const { getWalletEventDetail } = await import('@/lib/wallet/eventWalletService')
    const detail = await getWalletEventDetail(UID, d)
    expect(detail?.communication.walletChargesPaise).toEqual({ ok: true, value: 3 * PRICE })
  }, T)

  it('a webhook "failed" for an ACCEPTED message does not refund it (charged on accept)', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 10_000, currency: 'INR' })
    await regs(slug, [phone(11), phone(12)])
    const id = await campaign(slug, 2)
    await send.startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 2 })
    await settleWait()
    expect(await balance()).toBe(10_000 - 2 * PRICE)

    const { applyWhatsAppDeliveryStatus } = await import('@/lib/email-logs/whatsappStatus')
    const logs = (await adminDb.collection('emailLogs').where('campaignId', '==', id).get()).docs
    const wamid = logs.map(l => l.data().providerMessageId).find(Boolean) as string
    await applyWhatsAppDeliveryStatus({ wamid, status: 'failed', timestampMs: Date.now(), error: 'undeliverable' })
    await billing.settleBroadcastBilling(id, 0)   // even a forced re-settle cannot move money twice
    expect(await balance()).toBe(10_000 - 2 * PRICE)
    expect((await txn(`broadcast_refund_${id}`)).exists).toBe(false)
  }, T)

  // ═══ 2 · prepaid-funded broadcast ═══════════════════════════════════════════
  // RD-COMMS-P2-A — the timed-out recipient has no verdict: its unit is HELD (a late acceptance uses
  // it; the sweep returns it after the webhook window). Only the invalid one goes back now.
  it('prepaid: 4 units reserved, 2 accepted (1 timeout HELD, 1 invalid) ⇒ 1 unit back to the event; wallet untouched', async () => {
    const { d, slug } = await event({ prepaid: 10 })
    await walletRef().set({ balancePaise: 7_000, currency: 'INR' })
    await regs(slug, [phone(21), phone(22), phone(23), 'not-a-phone'])
    h.outcome.set(phone(23).slice(-10), 'timeout')
    const id = await campaign(slug, 4)

    const r = await send.startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 4 })
    expect(r).toEqual({ ok: true, costPaise: 0 })
    await settleWait()

    expect((await ledger(d))!.whatsapp!.consumed).toBe(3)
    const u = (await adminDb.doc(`eventServiceAllowances/${d}/usage/bc_${id}`).get()).data()!
    expect(u.quantity).toBe(3)
    const c = await camp(id)
    expect(c.billedUnits).toBe(2)
    expect(c.unknownHeldUnits).toBe(1)
    expect(c.refundedUnits).toBe(1)
    expect(c.fundedBy).toBe('prepaid_allowance')
    expect(await balance()).toBe(7_000)
    const usage = await usageFor(id)
    expect(usage[0].quantity).toBe(2)
    expect(usage[0].costPaise).toBe(0)
  }, T)

  // ═══ 3 · nothing reached WhatsApp ═══════════════════════════════════════════
  it('no provider ⇒ campaign failed and the whole charge is returned', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 5_000, currency: 'INR' })
    await regs(slug, [phone(31), phone(32), phone(33)])
    const id = await campaign(slug, 3)
    h.noProvider = true

    await send.startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 3 })
    const c = await camp(id)
    expect(c.status).toBe('failed')
    expect(c.failReason).toBe('provider_unavailable')
    expect(c.billingSettlement).toBe('settled')
    expect(c.actualCostPaise).toBe(0)
    expect(await balance()).toBe(5_000)
    expect((await txn(`broadcast_refund_${id}`)).data()!.amountPaise).toBe(3 * PRICE)
  }, T)

  it('a scheduled campaign is never sent to more people than it paid for', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 5_000, currency: 'INR' })
    await regs(slug, [phone(41), phone(42), phone(43)])   // 3 registered by send time
    const id = await campaign(slug, 2, { status: 'scheduled' })   // previewed + charged for 2
    await send.startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 2 })
    await settleWait()
    expect(h.sends).toHaveLength(2)
    const c = await camp(id)
    expect(c.unbilledRecipientsSkipped).toBe(1)
    expect(await balance()).toBe(5_000 - 2 * PRICE)
  }, T)

  // ═══ 4 · the backstop sweep ═════════════════════════════════════════════════
  it('cancelled mid-run with nobody holding the job ⇒ the sweep returns the unsent share', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 5_000, currency: 'INR' })
    const id = await campaign(slug, 3)
    const started = await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: 3 })
    expect(started.ok).toBe(true)
    const c0 = await camp(id)
    const job = await waJob.createWhatsAppBroadcastJob(id, c0 as never, await consenting([0, 1, 2].map(i => ({
      id: `r${i}`, data: { attendee: { name: `A${i}`, email: `a${i}@x.test`, phone: phone(50 + i) }, ticketCode: '' },
    }))) as never)
    await adminDb.doc(`${waJob.WHATSAPP_BROADCAST_JOBS}/${job.jobId}/recipients/r0000000`).update({ sent: true })
    const { Timestamp: Ts } = await import('firebase-admin/firestore')
    // Quiet for longer than a worker's page could take (the sweep's grace window).
    await adminDb.doc(`${waJob.WHATSAPP_BROADCAST_JOBS}/${job.jobId}`).update({ status: 'cancelled', lockedUntil: null, updatedAt: Ts.fromMillis(Date.now() - 10 * 60_000) })
    await adminDb.doc(`broadcastCampaigns/${id}`).update({ whatsappJobId: job.jobId, status: 'cancelled' })

    const out = await sweep.sweepBroadcastSettlements()
    expect(out.settled).toBeGreaterThanOrEqual(1)
    const c = await camp(id)
    expect(c.billingSettlement).toBe('settled')
    expect(c.billedUnits).toBe(1)
    expect(await balance()).toBe(5_000 - PRICE)
  }, T)

  it('a job still leased is never settled under a live worker', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 5_000, currency: 'INR' })
    const id = await campaign(slug, 2)
    await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: 2 })
    const job = await waJob.createWhatsAppBroadcastJob(id, (await camp(id)) as never, await consenting([0, 1].map(i => ({
      id: `r${i}`, data: { attendee: { name: `A${i}`, email: `a${i}@x.test`, phone: phone(60 + i) }, ticketCode: '' },
    }))) as never)
    const { Timestamp } = await import('firebase-admin/firestore')
    await adminDb.doc(`${waJob.WHATSAPP_BROADCAST_JOBS}/${job.jobId}`).update({ status: 'processing', lockedUntil: Timestamp.fromMillis(Date.now() + 60_000) })
    await adminDb.doc(`broadcastCampaigns/${id}`).update({ whatsappJobId: job.jobId, status: 'cancelled' })
    await sweep.sweepBroadcastSettlements()
    expect((await camp(id)).billingSettlement).toBe('pending')
    expect(await balance()).toBe(5_000 - 2 * PRICE)
  }, T)

  // ═══ 5 · transactional WhatsApp usage ═══════════════════════════════════════
  it('a confirmation records ONE usage row with what was actually charged; a replay adds nothing', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 1_000, currency: 'INR' })
    await regs(slug, [phone(71)])
    const regId = `integ-r-${slug}-0`
    const { sendWhatsAppConfirmation } = await import('@/lib/registrations/sendWhatsAppConfirmation')
    const args = { registrationId: regId, organizerUid: UID, eventSlug: slug, attendeeName: 'A', eventName: 'E', ticketCode: 'T' }
    await sendWhatsAppConfirmation(args)
    await settleWait()
    expect(await balance()).toBe(1_000 - PRICE)
    // RD-CLOSE — one usage record per ACCEPTED message (keyed by its wamid)
    const rows = (await adminDb.collection('communicationUsage').where('organizerUid', '==', UID).get()).docs
    expect(rows).toHaveLength(1)
    const u = rows[0].data()
    expect(u.quantity).toBe(1)
    expect(u.costPaise).toBe(PRICE)
    await sendWhatsAppConfirmation(args)   // already sent ⇒ nothing
    await settleWait()
    expect(await balance()).toBe(1_000 - PRICE)
    expect((await adminDb.collection('communicationUsage').where('organizerUid', '==', UID).get()).size).toBe(1)
  }, T)

  it('a confirmation the provider refuses is neither charged nor counted', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 1_000, currency: 'INR' })
    await regs(slug, [phone(81)])
    h.outcome.set(phone(81).slice(-10), 'reject')
    const regId = `integ-r-${slug}-0`
    const { sendWhatsAppConfirmation } = await import('@/lib/registrations/sendWhatsAppConfirmation')
    await sendWhatsAppConfirmation({ registrationId: regId, organizerUid: UID, eventSlug: slug, attendeeName: 'A', eventName: 'E', ticketCode: 'T' })
    await settleWait()
    expect(await balance()).toBe(1_000)
    expect((await adminDb.collection('communicationUsage').where('organizerUid', '==', UID).get()).size).toBe(0)
  }, T)

  it('a LEGACY charge (no event on it) settled after deploy never makes the event Wallet negative', async () => {
    const { d, slug } = await event()
    await walletRef().set({ balancePaise: 10_000, currency: 'INR' })
    const id = await campaign(slug, 4)
    await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: 4 })
    // Simulate a pre-deploy charge row: no eventSlug/eventId in its metadata.
    await adminDb.doc(`walletTransactions/broadcast_${id}`).update({ metadata: { campaignId: id, units: 4, channel: 'whatsapp' } })
    await adminDb.doc(`broadcastCampaigns/${id}`).update({ status: 'failed' })
    await billing.settleBroadcastBilling(id, 1)
    const refund = (await txn(`broadcast_refund_${id}`)).data()!
    expect(refund.amountPaise).toBe(3 * PRICE)
    expect((refund.metadata as Record<string, unknown>).eventSlug).toBeUndefined()
    const { getWalletEventDetail } = await import('@/lib/wallet/eventWalletService')
    expect((await getWalletEventDetail(UID, d))?.communication.walletChargesPaise).toEqual({ ok: true, value: 0 })
    expect(await balance()).toBe(10_000 - PRICE)
  }, T)

  // ═══ 6 · admin licence refund retires the order's unused prepaid units (D1) ═══
  it('licence refund: unused units of the refunded order are retired; consumed units stay; exactly once', async () => {
    const { d, slug } = await event()
    const orderId = `lic_${d}`
    docs.add(`licenseOrders/${orderId}`); docs.add(`eventLicenses/${slug}`); docs.add(`walletTransactions/license_refund_${slug}`)
    const item = { service: 'whatsapp', quantity: 100, unitPricePaise: 45, basePaise: 4_500, gstRatePercent: 18, gstPaise: 810, totalPaise: 5_310, onExhausted: 'block' }
    await adminDb.doc(`licenseOrders/${orderId}`).set({ orderId, eventId: d, organizerUid: UID, status: 'paid', amountPaise: 5_310, serviceItems: [item], purpose: 'activation' })
    await adminDb.doc(`eventLicenses/${slug}`).set({ eventId: slug, organizerUid: UID, orderId, commercialModel: 'capacity', capacity: 100, tier: 'free', version: 2, status: 'active' })
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, appliedOrders: { [orderId]: true }, whatsapp: { purchased: 100, consumed: 30, onExhausted: 'block' } })

    const { applyLicenseAction } = await import('@/lib/admin/licenseAdminService')
    // Refused while a broadcast for the event is unsettled (its reserved units would come back later).
    const open = await campaign(slug, 1, { status: 'sending', billingSettlement: 'pending' })
    await expect(applyLicenseAction(slug, { action: 'refund', reason: 'integration test refund' }, `integ-admin-${P}`)).rejects.toThrow(/has not finished settling/)
    await adminDb.doc(`broadcastCampaigns/${open}`).delete()
    // Refused while an event-service refund exists (the full order refund would pay those units twice).
    const sr = `integ-sr-${P}`; docs.add(`walletServiceRequests/${sr}`)
    await adminDb.doc(`walletServiceRequests/${sr}`).set({ kind: 'refund', status: 'approved', sourceDraftId: d, organizerUid: UID, service: 'whatsapp', quantity: 10 })
    await expect(applyLicenseAction(slug, { action: 'refund', reason: 'integration test refund' }, `integ-admin-${P}`)).rejects.toThrow(/refund those units twice/)
    await adminDb.doc(`walletServiceRequests/${sr}`).delete()
    const res = await applyLicenseAction(slug, { action: 'refund', reason: 'integration test refund' }, `integ-admin-${P}`)
    expect(res.refund?.servicesRetired).toEqual({ whatsapp: 70 })
    const l = (await ledger(d))!
    expect(l.whatsapp!.purchased).toBe(30)
    expect(l.whatsapp!.consumed).toBe(30)
    const o = (await adminDb.doc(`licenseOrders/${orderId}`).get()).data()!
    expect(o.status).toBe('refunded')
    expect(o.servicesRetiredOnRefund).toEqual({ whatsapp: 70 })

    // The reconciliation report agrees with the ledger after the refund.
    const { reconcileAllowance } = await import('@/lib/licensing/allowanceReconciliation')
    const recon = reconcileAllowance(l as never, [{ ...(o as never), orderId }], Array.from({ length: 30 }, () => ({ service: 'whatsapp', quantity: 1 })))
    expect(recon.issues).toEqual([])
    expect(recon.lines.find(x => x.service === 'whatsapp')!.issues).toEqual([])

    // A second refund is refused and retires nothing more.
    await expect(applyLicenseAction(slug, { action: 'refund', reason: 'again' }, `integ-admin-${P}`)).rejects.toThrow()
    expect((await ledger(d))!.whatsapp!.purchased).toBe(30)
    for (const x of (await adminDb.collection('adminAuditLogs').where('entityId', '==', slug).get()).docs) await x.ref.delete()
  }, T)
})
