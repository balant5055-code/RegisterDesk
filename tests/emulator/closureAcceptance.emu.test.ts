// RD-CLOSE · #1 — a provider-ACCEPTED WhatsApp message stays billable exactly once, whatever fails
// locally. Real Firestore (emulator); the Meta provider is an in-memory stub that records the
// biz_opaque_callback_data each send carried, so Meta's status webhook can be replayed.
//
// Invariant under test: one accepted message (one wamid) = one usage record = one charge = one log row.
//
//   1  accepted + persistence succeeds
//   2  accepted + sent-marker (broadcast acceptance) write fails      → recovered by webhook, late-charged once
//   3  accepted + usage write fails (confirmation, atomic record)     → nothing half-written; webhook recovers
//   4  accepted + wallet-transaction write fails transiently          → retry persists it, charged once
//   5  retry after partial persistence                                → the record is all-or-nothing; replay is a no-op
//   6  duplicate recovery (concurrent webhooks)                       → one charge
//   7  provider callback after recovery (delivered/read/failed)      → no new charge, no reversal
//   8  out-of-order callback (webhook BEFORE the sender's write)      → one charge
//   9  process crash between provider call and persistence           → never re-sent; webhook recovers
//   10 repeated reconciliation                                        → stable
//   +  transport timeout that Meta did accept                         → billed when the webhook proves it
//   +  retry that Meta accepts as a NEW message                       → billed separately

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const UID = `close-org-${P}`
const PRICE = 50

const h = vi.hoisted(() => ({
  outcome: new Map<string, 'ok' | 'reject' | 'timeout'>(),
  sends: [] as Array<{ to: string; wamid: string | null; callbackData?: string }>,
  failBroadcastFor: new Set<string>(),     // recipient ids whose acceptance write always throws
  failMessage: 0,                          // the next N message-acceptance writes throw
  beforeReturn: null as null | ((wamid: string, cb?: string) => Promise<void>),
  seq: 0,
}))

vi.mock('@/lib/whatsapp', async orig => {
  const real = await orig<typeof import('@/lib/whatsapp')>()
  return {
    ...real,
    getMetaProvider: async () => ({
      sendTemplate: async (m: { to?: string; callbackData?: string }) => {
        const to = String(m.to ?? '')
        const r = h.outcome.get(to.slice(-10)) ?? 'ok'
        const wamid = `wamid.close.${P}.${++h.seq}`
        // A timeout: Meta may have accepted it (we record its wamid for the "webhook" later).
        h.sends.push({ to, wamid: r === 'reject' ? null : wamid, callbackData: m.callbackData })
        if (r === 'ok') {
          if (h.beforeReturn) { const f = h.beforeReturn; h.beforeReturn = null; await f(wamid, m.callbackData) }
          return { success: true, messageId: wamid }
        }
        if (r === 'timeout') {
          if (h.beforeReturn) { const f = h.beforeReturn; h.beforeReturn = null; await f(wamid, m.callbackData) }
          return { success: false, error: 'The operation was aborted due to timeout' }
        }
        return { success: false, httpStatus: 400, code: 131026, error: 'Message undeliverable' }
      },
    }),
    hasWhatsAppTemplate: () => true,
    resolveWhatsAppTemplateByType: (_t: unknown, to: string) => ({ ok: true, message: { to, templateName: 'close_test' } }),
    resolveWhatsAppTemplate: (_t: unknown, to: string) => ({ ok: true, message: { to, templateName: 'close_test' } }),
  }
})
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => {
    const c = await real.getCommunicationConfig()
    return { ...c, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: PRICE, walletChargeAttendeeNotifications: true } }
  } }
})
// Failure injection around the REAL acceptance writes (default: no failure → unchanged).
vi.mock('@/lib/whatsapp/acceptance', async orig => {
  const real = await orig<typeof import('@/lib/whatsapp/acceptance')>()
  return {
    ...real,
    withPersistRetry: <X,>(fn: () => Promise<X>) => real.withPersistRetry(fn, 4, 1),
    recordBroadcastAcceptance: async (a: Parameters<typeof real.recordBroadcastAcceptance>[0]) => {
      if (a.source === 'send' && h.failBroadcastFor.has(a.recipientId)) throw new Error('simulated Firestore write failure (sent marker)')
      return real.recordBroadcastAcceptance(a)
    },
    recordMessageAcceptance: async (a: Parameters<typeof real.recordMessageAcceptance>[0]) => {
      if (h.failMessage > 0) { h.failMessage--; throw new Error('simulated Firestore write failure (usage / wallet / log)') }
      return real.recordMessageAcceptance(a)
    },
  }
})
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => undefined }))
vi.mock('@/lib/crm/service', () => ({ crmRecordBroadcastBatch: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', () => ({ notifyBroadcastComplete: () => undefined }))
vi.mock('@/lib/whatsapp/failureReason', async orig => ({ ...(await orig<typeof import('@/lib/whatsapp/failureReason')>()), isRetryableWhatsAppFailure: () => false }))

describeEmu('RD-CLOSE · WhatsApp acceptance is billable exactly once', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let send: typeof import('@/lib/broadcasts/send')
  let recovery: typeof import('@/lib/whatsapp/acceptanceRecovery')
  let confirm: typeof import('@/lib/registrations/sendWhatsAppConfirmation')
  let waJob: typeof import('@/lib/broadcasts/whatsappJob')
  const docs = new Set<string>(), trees = new Set<string>()
  let n = 0
  const walletRef = () => adminDb.doc(`organizerWallets/${UID}`)
  const balance = async () => ((await walletRef().get()).data()?.balancePaise as number | undefined) ?? 0
  const phone = (i: number) => `+9198766${String(10000 + i).slice(-5)}`
  const webhook = (wamid: string, callbackData: string | undefined, status: 'sent' | 'delivered' | 'read' | 'failed' = 'sent') =>
    recovery.reconcileWhatsAppAcceptance({ wamid, status, timestampMs: Date.now(), callbackData })
  const usageCount = async () => (await adminDb.collection('communicationUsage').where('organizerUid', '==', UID).get()).docs
  const charges = async () => (await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).docs

  async function event(opts: { prepaid?: number } = {}) {
    const k = ++n, d = `close-d${k}-${P}`, slug = `close-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`); docs.add(`users/${UID}/eventDrafts/${d}`)
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).set({ status: 'published', lifecycleStatus: 'published', eventDetails: { info: { name: `Close ${k}` }, seo: { urlSlug: slug } } })
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true }, eventDetails: { info: { name: `Close ${k}` } } })
    if (opts.prepaid) await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: opts.prepaid, consumed: 0, onExhausted: 'block' } })
    return { d, slug }
  }
  async function reg(slug: string, i: number, ph: string) {
    const id = `close-r-${slug}-${i}`
    docs.add(`registrations/${id}`)
    await adminDb.doc(`registrations/${id}`).set({ organizerUid: UID, eventSlug: slug, status: 'confirmed', ticketCode: `T${i}`, attendee: { name: `A${i}`, email: `a${i}@example.test`, phone: ph } })
    return id
  }
  async function campaign(slug: string, recipientCount: number) {
    const id = `close-c${++n}-${P}`
    docs.add(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({
      organizerUid: UID, createdBy: UID, eventId: slug, eventSlug: slug, eventName: 'Close', channel: 'whatsapp', audience: 'all',
      subject: '', html: '', templateType: 'EVENT_REMINDER', variables: {}, recipientCount, successCount: 0, failCount: 0, status: 'draft', actualCostPaise: 0,
    })
    return id
  }
  const camp = async (id: string) => (await adminDb.doc(`broadcastCampaigns/${id}`).get()).data() as Record<string, unknown>
  const wait = () => new Promise(r => setTimeout(r, 300))

  async function wipe() {
    for (const p of docs) await adminDb.doc(p).delete().catch(() => null)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const col of ['walletTransactions', 'communicationUsage', 'emailLogs'])
      for (const d of (await adminDb.collection(col).where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('whatsappBroadcastJobs').where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(d.ref)
    await walletRef().delete().catch(() => null)
    docs.clear(); trees.clear()
    h.outcome.clear(); h.sends.length = 0; h.failBroadcastFor.clear(); h.failMessage = 0; h.beforeReturn = null
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    send = await import('@/lib/broadcasts/send')
    recovery = await import('@/lib/whatsapp/acceptanceRecovery')
    confirm = await import('@/lib/registrations/sendWhatsAppConfirmation')
    waJob = await import('@/lib/broadcasts/whatsappJob')
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active' }, { merge: true })
  }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null) }, T)
  beforeEach(wipe, T)

  const args = (regId: string, slug: string) => ({ registrationId: regId, organizerUid: UID, eventSlug: slug, attendeeName: 'A', eventName: 'E', ticketCode: 'T' })

  // ── 1 ──
  it('1 · accepted + persisted: one usage record, one charge, one log row, status sent — all keyed by the wamid', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 1_000 })
    const r = await reg(slug, 1, phone(1))
    await confirm.sendWhatsAppConfirmation(args(r, slug))
    const wamid = h.sends[0].wamid!
    expect(h.sends[0].callbackData).toBe(`rd1:reg:${r}:wa_reg_${r}`)
    expect(await balance()).toBe(1_000 - PRICE)
    expect((await adminDb.doc(`communicationUsage/wa_msg_${wamid}`).get()).data()).toMatchObject({ quantity: 1, costPaise: PRICE, providerMessageId: wamid })
    expect((await adminDb.doc(`walletTransactions/whatsapp_${r}`).get()).data()).toMatchObject({ amountPaise: PRICE, metadata: { messageId: wamid } })
    expect((await adminDb.doc(`emailLogs/wa_${wamid}`).get()).data()).toMatchObject({ status: 'sent', providerMessageId: wamid })
    expect((await adminDb.doc(`registrations/${r}`).get()).data()).toMatchObject({ whatsappStatus: 'sent', whatsappMessageId: wamid })
  }, T)

  // ── 2 ──
  it('2 · broadcast sent-marker write fails → refunded at settlement, then the webhook recovers it and charges it back ONCE', async () => {
    const { d, slug } = await event()
    await walletRef().set({ balancePaise: 10_000 })
    for (let i = 0; i < 3; i++) await reg(slug, i, phone(20 + i))
    h.failBroadcastFor.add('r0000001')
    const id = await campaign(slug, 3)
    await send.startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 3 })
    await wait()
    let c = await camp(id)
    expect(c.billingSettlement).toBe('settled')
    expect(c.billedUnits).toBe(2)
    expect(await balance()).toBe(10_000 - 2 * PRICE)
    const lost = h.sends.find(s => s.callbackData?.endsWith(':r0000001'))!
    const jobId = String(c.whatsappJobId)
    expect((await adminDb.doc(`whatsappBroadcastJobs/${jobId}/recipients/r0000001`).get()).data()!.sent).toBeUndefined()
    expect((await adminDb.doc(`whatsappBroadcastJobs/${jobId}/recipients/r0000001`).get()).data()!.pendingAttemptAt).toBeTruthy()

    // Meta's status webhook for that message (a "sent" status — the acceptance proof).
    h.failBroadcastFor.clear()
    expect(await webhook(lost.wamid!, lost.callbackData)).toBe('late_charged')
    c = await camp(id)
    expect(c.billedUnits).toBe(3)
    expect(c.refundedUnits).toBe(0)
    expect(c.actualCostPaise).toBe(3 * PRICE)
    expect(await balance()).toBe(10_000 - 3 * PRICE)
    expect((await adminDb.doc(`communicationUsage/bc_${id}`).get()).data()).toMatchObject({ quantity: 3, costPaise: 3 * PRICE })
    // ── 6 · duplicate recovery / 7 · later callbacks ──
    expect(await webhook(lost.wamid!, lost.callbackData, 'delivered')).toBe('already')
    await Promise.all([webhook(lost.wamid!, lost.callbackData, 'read'), webhook(lost.wamid!, lost.callbackData, 'failed')])
    expect(await balance()).toBe(10_000 - 3 * PRICE)
    const { getWalletEventDetail } = await import('@/lib/wallet/eventWalletService')
    expect((await getWalletEventDetail(UID, d))?.communication.walletChargesPaise).toEqual({ ok: true, value: 3 * PRICE })
  }, T)

  // ── 3 / 5 ──
  it('3 · confirmation: every acceptance write fails → NOTHING half-written; the webhook persists it whole, once', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 1_000 })
    const r = await reg(slug, 3, phone(30))
    h.failMessage = 99
    await confirm.sendWhatsAppConfirmation(args(r, slug))
    const s = h.sends[0]
    expect(await balance()).toBe(1_000)
    expect(await usageCount()).toHaveLength(0)
    expect(await charges()).toHaveLength(0)
    h.failMessage = 0
    expect(await webhook(s.wamid!, s.callbackData)).toBe('recovered')
    expect(await balance()).toBe(1_000 - PRICE)
    expect(await usageCount()).toHaveLength(1)
    expect((await adminDb.doc(`emailLogs/wa_${s.wamid}`).get()).exists).toBe(true)
    expect((await adminDb.doc(`registrations/${r}`).get()).data()!.whatsappStatus).toBe('sent')
    // ── 10 · repeated reconciliation ──
    for (let i = 0; i < 3; i++) expect(await webhook(s.wamid!, s.callbackData, 'delivered')).toBe('already')
    expect(await balance()).toBe(1_000 - PRICE)
    expect(await charges()).toHaveLength(1)
  }, T)

  // ── 4 ──
  it('4 · a transient failure of the charge/usage write is retried: charged exactly once', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 1_000 })
    const r = await reg(slug, 4, phone(40))
    h.failMessage = 2
    await confirm.sendWhatsAppConfirmation(args(r, slug))
    expect(await balance()).toBe(1_000 - PRICE)
    expect(await charges()).toHaveLength(1)
    expect(await usageCount()).toHaveLength(1)
  }, T)

  // ── 8 ──
  it('8 · out-of-order: the webhook lands BEFORE the sender records it → one charge', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 1_000 })
    const r = await reg(slug, 8, phone(80))
    h.beforeReturn = async (wamid, cb) => { expect(await webhook(wamid, cb)).toBe('recovered') }
    await confirm.sendWhatsAppConfirmation(args(r, slug))
    expect(await balance()).toBe(1_000 - PRICE)
    expect(await charges()).toHaveLength(1)
    expect(await usageCount()).toHaveLength(1)
  }, T)

  // ── 9 ──
  it('9 · a crash between the provider call and persistence: never re-sent on resume; the webhook recovers it', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 5_000 })
    const id = await campaign(slug, 2)
    const billing = await import('@/lib/communications/billing')
    await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: 2 })
    const job = await waJob.createWhatsAppBroadcastJob(id, (await camp(id)) as never, [0, 1].map(i => ({
      id: `rr${i}`, data: { attendee: { name: `A${i}`, email: `a${i}@x.test`, phone: phone(90 + i) }, ticketCode: '' },
    })) as never)
    await adminDb.doc(`broadcastCampaigns/${id}`).update({ whatsappJobId: job.jobId })
    // The previous worker handed r0000000 to Meta (accepted as wamid X) and died before recording it.
    const { FieldValue } = await import('firebase-admin/firestore')
    await adminDb.doc(`whatsappBroadcastJobs/${job.jobId}/recipients/r0000000`).update({ pendingAttemptAt: FieldValue.serverTimestamp() })
    await waJob.processWhatsAppBroadcastChunk(job.jobId)
    await wait()
    expect(h.sends.map(s => s.callbackData)).toEqual([`rd1:bc:${job.jobId}:r0000001`])   // r0000000 NOT re-sent
    expect((await adminDb.doc(`whatsappBroadcastJobs/${job.jobId}/recipients/r0000000`).get()).data()).toMatchObject({ indeterminate: true })
    let c = await camp(id)
    expect(c.billedUnits).toBe(1)
    expect(await balance()).toBe(5_000 - PRICE)
    // Meta's webhook for the message the dead worker sent.
    expect(await webhook(`wamid.crashed.${P}`, `rd1:bc:${job.jobId}:r0000000`)).toBe('late_charged')
    c = await camp(id)
    expect(c.billedUnits).toBe(2)
    expect(await balance()).toBe(5_000 - 2 * PRICE)
    // one log row for that recipient: the interrupted (unknown) row is UPGRADED, not duplicated
    expect((await adminDb.doc(`emailLogs/bcfail_${job.jobId}_r0000000`).get()).data()).toMatchObject({ status: 'sent', providerMessageId: `wamid.crashed.${P}` })
    expect((await adminDb.doc(`emailLogs/wa_wamid.crashed.${P}`).get()).exists).toBe(false)
  }, T)

  it('+ a transport TIMEOUT that Meta did accept is billed when the webhook proves it (prepaid unit re-taken)', async () => {
    const { d, slug } = await event({ prepaid: 5 })
    await walletRef().set({ balancePaise: 1_000 })
    const r = await reg(slug, 11, phone(110))
    h.outcome.set(phone(110).slice(-10), 'timeout')
    await confirm.sendWhatsAppConfirmation(args(r, slug))
    await wait()   // the unknown status is a fire-and-forget write
    expect((await adminDb.doc(`registrations/${r}`).get()).data()!.whatsappStatus).toBe('unknown')
    expect(((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data() as { whatsapp: { consumed: number } }).whatsapp.consumed).toBe(0)
    const s = h.sends[0]
    expect(await webhook(s.wamid!, s.callbackData)).toBe('recovered')
    expect(((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data() as { whatsapp: { consumed: number } }).whatsapp.consumed).toBe(1)
    expect(await balance()).toBe(1_000)                               // prepaid: no wallet charge
    expect((await adminDb.doc(`registrations/${r}`).get()).data()!.whatsappStatus).toBe('sent')
    expect(await usageCount()).toHaveLength(1)
  }, T)

  it('review #2 · the webhook proves acceptance BEFORE the sender times out: unit kept, status stays sent, one log row', async () => {
    const { d, slug } = await event({ prepaid: 5 })
    await walletRef().set({ balancePaise: 1_000 })
    const r = await reg(slug, 21, phone(210))
    h.outcome.set(phone(210).slice(-10), 'timeout')
    h.beforeReturn = async (wamid, cb) => { expect(await webhook(wamid, cb)).toBe('recovered') }
    await confirm.sendWhatsAppConfirmation(args(r, slug))
    await wait()
    expect(((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data() as { whatsapp: { consumed: number } }).whatsapp.consumed).toBe(1)
    expect((await adminDb.doc(`registrations/${r}`).get()).data()!.whatsappStatus).toBe('sent')
    const logs = (await adminDb.collection('emailLogs').where('registrationId', '==', r).get()).docs
    expect(logs).toHaveLength(1)
    expect(logs[0].data().status).toBe('sent')
    expect(await usageCount()).toHaveLength(1)
  }, T)

  it('review #3 · timeout first, webhook later: the unknown row is UPGRADED in place (one row)', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 1_000 })
    const r = await reg(slug, 22, phone(220))
    h.outcome.set(phone(220).slice(-10), 'timeout')
    await confirm.sendWhatsAppConfirmation(args(r, slug))
    await wait()
    let logs = (await adminDb.collection('emailLogs').where('registrationId', '==', r).get()).docs
    expect(logs).toHaveLength(1)
    expect(logs[0].data().deliveryUnknown).toBe(true)
    const s = h.sends[0]
    expect(await webhook(s.wamid!, s.callbackData)).toBe('recovered')
    logs = (await adminDb.collection('emailLogs').where('registrationId', '==', r).get()).docs
    expect(logs).toHaveLength(1)
    expect(logs[0].data()).toMatchObject({ status: 'sent', providerMessageId: s.wamid })
    expect(logs[0].data().deliveryUnknown).toBeUndefined()
    expect(await balance()).toBe(1_000 - PRICE)
  }, T)

  it('review #1 · an acceptance that lands between settlement\'s count and its commit is caught up exactly once', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 5_000 })
    const id = await campaign(slug, 2)
    const billing = await import('@/lib/communications/billing')
    await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: 2 })
    const job = await waJob.createWhatsAppBroadcastJob(id, (await camp(id)) as never, [0, 1].map(i => ({
      id: `rq${i}`, data: { attendee: { name: `A${i}`, email: `a${i}@x.test`, phone: phone(230 + i) }, ticketCode: '' },
    })) as never)
    await adminDb.doc(`broadcastCampaigns/${id}`).update({ whatsappJobId: job.jobId, status: 'partial' })
    // r0 accepted ("recorded" — not yet settled); settlement then commits with a STALE count of 0.
    const { recordBroadcastAcceptance } = await import('@/lib/whatsapp/acceptance')
    expect(await recordBroadcastAcceptance({ jobId: job.jobId, recipientId: 'r0000000', wamid: `wamid.race.${P}`, source: 'webhook' })).toBe('recorded')
    await billing.settleBroadcastBilling(id, 0)
    const c = await camp(id)
    expect(c.billedUnits).toBe(1)
    expect(c.billingCatchUp).toBe('done')
    expect(await balance()).toBe(5_000 - PRICE)
    // idempotent
    const { reconcileBroadcastBilledUnits } = await import('@/lib/whatsapp/acceptance')
    expect(await reconcileBroadcastBilledUnits(id)).toBe(0)
    expect(await balance()).toBe(5_000 - PRICE)
  }, T)

  it('review #4 · a broadcast TRANSPORT failure is indeterminate: a page re-run never re-sends it', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 5_000 })
    await reg(slug, 0, phone(240))
    h.outcome.set(phone(240).slice(-10), 'timeout')
    const id = await campaign(slug, 1)
    await send.startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 1 })
    await wait()
    const jobId = String((await camp(id)).whatsappJobId)
    expect((await adminDb.doc(`whatsappBroadcastJobs/${jobId}/recipients/r0000000`).get()).data()).toMatchObject({ indeterminate: true })
    // a re-run of that page (e.g. after a crash before the commit) does not send again
    await adminDb.doc(`whatsappBroadcastJobs/${jobId}`).update({ status: 'processing', cursor: null, lockedUntil: null })
    h.outcome.clear()
    await waJob.processWhatsAppBroadcastChunk(jobId)
    expect(h.sends).toHaveLength(1)
  }, T)

  it('+ a REJECTED send is never billable, and a webhook can never arrive for it', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 1_000 })
    const r = await reg(slug, 12, phone(120))
    h.outcome.set(phone(120).slice(-10), 'reject')
    await confirm.sendWhatsAppConfirmation(args(r, slug))
    expect(await balance()).toBe(1_000)
    expect(await usageCount()).toHaveLength(0)
  }, T)

  it('+ a retry that Meta accepts is a NEW message: billed once more, under its own wamid', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 1_000 })
    const r = await reg(slug, 13, phone(130))
    await confirm.sendWhatsAppConfirmation(args(r, slug))
    const { acceptConfirmation } = await import('@/lib/registrations/whatsappConfirmationAcceptance')
    await acceptConfirmation({ registrationId: r, organizerUid: UID, eventSlug: slug, eventName: 'E', attendeeName: 'A', email: 'a@x.test', phone: phone(130), wamid: `wamid.retry.${P}`, fromAllowance: false, writeLog: false, source: 'retry' })
    expect(await balance()).toBe(1_000 - 2 * PRICE)
    expect((await adminDb.doc(`walletTransactions/whatsapp_${r}__wamid.retry.${P}`).get()).exists).toBe(true)
    expect(await usageCount()).toHaveLength(2)
  }, T)

  it('+ a forged / unknown callback reference changes nothing', async () => {
    await walletRef().set({ balancePaise: 1_000 })
    expect(await webhook('wamid.x', 'rd1:reg:does-not-exist')).toBe('missing')
    expect(await webhook('wamid.y', 'garbage')).toBe('no_ref')
    expect(await webhook('wamid.z', 'rd1:bc:nojob:r0000000')).toBe('missing')
    expect(await balance()).toBe(1_000)
  }, T)
})
