// RD-COMMS-P2-A — WhatsApp entitlement & billing correctness, on REAL Firestore (emulator).
//
//   A1  a WhatsApp broadcast with zero billable units is refused, and a started campaign with no
//       recorded charge delivers to NO ONE (never "uncapped");
//   A2  the legacy-balance drain is atomic: concurrent sends on a balance worth one message fund
//       exactly one, never go negative, never send free;
//   A3  allowNegativeBalance cannot make the WhatsApp legacy path go below zero;
//   A4  webhook recovery settles against the send's own hold — the reserve/release race cannot
//       produce a free message, and an unfundable recovery is recorded unbilled, never negative;
//   A5  abandoned holds are returned by the sweep — exactly once, never an ACCEPTED one;
//   plus: a broadcast recipient whose outcome was unknown keeps its unit at settlement, and a late
//   acceptance consumes it (no free late send); duplicate webhooks stay idempotent; the prepaid
//   final unit is never over-consumed.
// No request leaves the process; no real money moves.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const UID = `p2a-org-${P}`
const PRICE = 50

const h = vi.hoisted(() => ({ allowNegative: false, sends: 0 }))

// RD-WA-BLOCK-01 — production no longer funds a NEW WhatsApp message from the legacy balance (blocked
// when event capacity is exhausted). This suite exercises the acceptance / settlement MECHANICS that
// still apply to legacy money taken before that change (holds, charge-backs, credit-backs), using a
// legacy-funded send as its fixture — so it re-enables the old funding rule for THIS suite only.
vi.mock('@/lib/communications/capacity', async orig => {
  const real = await orig<typeof import('@/lib/communications/capacity')>()
  return { ...real, legacyBalanceCanFundNewWhatsApp: real.legacyBalanceCanFund }
})
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return {
    ...real,
    getCommunicationConfig: async () => {
      const c = await real.getCommunicationConfig()
      return { ...c, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: PRICE } }
    },
  }
})
vi.mock('@/lib/wallet/resolveWalletConfig', async orig => {
  const real = await orig<typeof import('@/lib/wallet/resolveWalletConfig')>()
  return { ...real, getWalletConfig: async () => ({ ...(await real.getWalletConfig()), allowNegativeBalance: h.allowNegative }) }
})
vi.mock('@/lib/whatsapp', async orig => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  getMetaProvider: async () => ({ sendTemplate: async () => { h.sends++; return { success: true, messageId: `wamid.p2a.${h.sends}` } } }),
}))

describeEmu('RD-COMMS-P2-A · WhatsApp funding & billing on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let funding: typeof import('@/lib/whatsapp/funding')
  let acceptance: typeof import('@/lib/whatsapp/acceptance')
  let billing: typeof import('@/lib/communications/billing')
  const docs = new Set<string>(), trees = new Set<string>()
  let n = 0

  const walletRef = () => adminDb.doc(`organizerWallets/${UID}`)
  const balance = async () => ((await walletRef().get()).data()?.balancePaise as number | undefined) ?? null
  const consumed = async (d: string) => ((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data()?.whatsapp?.consumed as number | undefined) ?? 0
  const ledgerRows = async () => (await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).docs

  async function event(whatsapp?: { purchased: number; consumed?: number }) {
    const k = ++n
    const d = `p2a-d${k}-${P}`, slug = `p2a-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true } })
    if (whatsapp) await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: whatsapp.purchased, consumed: whatsapp.consumed ?? 0, onExhausted: 'block' } })
    return { d, slug }
  }
  const key = (draftId: string | null, tag: string) => {
    const unitKey = `wa_reg_p2a${++n}${tag}`
    docs.add(`whatsappHolds/${unitKey}`)
    return { organizerUid: UID, draftId, unitKey, holdLedgerId: `whatsapp_p2a${n}${tag}` }
  }
  const req = (k: ReturnType<typeof key>, slug: string) => ({
    ...k, legacyPricePaise: PRICE, source: 'test',
    ledger: { referenceId: k.unitKey, description: 'test', eventSlug: slug, metadata: {} },
  })
  const accept = (k: ReturnType<typeof key>, slug: string, wamid: string) => acceptance.recordMessageAcceptance({
    organizerUid: UID, eventSlug: slug, eventName: 'P2A', wamid, templateKey: 'registration_confirmation',
    funding: { draftId: k.draftId, unitKey: k.unitKey, holdLedgerId: k.holdLedgerId, legacyPricePaise: PRICE },
    ledgerReferenceId: k.unitKey, ledgerDescription: 'test', ledgerMetadata: {}, log: null, source: 'webhook',
  })
  const wamid = (tag: string) => { const w = `wamid.p2a.${P}.${++n}.${tag}`; docs.add(`communicationUsage/${acceptance.messageUsageId(w)}`); return w }

  async function wipe() {
    for (const p of docs) await adminDb.doc(p).delete().catch(() => null)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const d of await ledgerRows()) await d.ref.delete()
    for (const c of ['broadcastCampaigns', 'registrations']) for (const d of (await adminDb.collection(c).where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(d.ref)
    await walletRef().delete().catch(() => null)
    docs.clear(); trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
    funding = await import('@/lib/whatsapp/funding')
    acceptance = await import('@/lib/whatsapp/acceptance')
    billing = await import('@/lib/communications/billing')
  }, T)
  beforeEach(async () => { h.allowNegative = false; h.sends = 0; await wipe() }, T)
  afterAll(wipe, T)

  // ── A1 ────────────────────────────────────────────────────────────────────
  it('A1 · zero billable units: refused at start, and a "sending" campaign with no recorded charge reaches NO ONE', async () => {
    const { slug } = await event({ purchased: 100 })
    for (const i of [1, 2]) {
      const r = `p2a-reg${i}-${P}`
      await adminDb.doc(`registrations/${r}`).set({ organizerUid: UID, eventSlug: slug, status: 'confirmed', attendee: { name: `A${i}`, email: `a${i}@x.test`, phone: `+9198765432${i}0` }, createdAt: Timestamp.now() })
    }
    const camp = (id: string, extra: Record<string, unknown>) => adminDb.doc(`broadcastCampaigns/${id}`).set({
      organizerUid: UID, createdBy: UID, eventId: slug, eventSlug: slug, eventName: 'P2A', channel: 'whatsapp', audience: 'all',
      subject: 's', templateType: 'EVENT_UPDATED', variables: {}, recipientCount: 0, successCount: 0, failCount: 0, actualCostPaise: 0, ...extra,
    })
    // Scheduled with 0 recipients: the start refuses it and charges nothing.
    await camp(`p2a-c0-${P}`, { status: 'scheduled' })
    expect(await billing.chargeAndStartCampaign({ campaignId: `p2a-c0-${P}`, organizerUid: UID, channel: 'whatsapp', recipientCount: 0 }))
      .toEqual({ ok: false, reason: 'no_recipients' })
    expect((await adminDb.doc(`broadcastCampaigns/p2a-c0-${P}`).get()).data()).toMatchObject({ status: 'failed', failReason: 'no_recipients', chargedUnits: 0 })
    // A campaign that somehow reached 'sending' with NO chargedUnits (the old bypass shape): the
    // audience (2 phones) is resolved again but capped to 0 — nothing is sent.
    await camp(`p2a-c1-${P}`, { status: 'sending' })
    const { deliverBroadcastCampaign } = await import('@/lib/broadcasts/send')
    await deliverBroadcastCampaign(`p2a-c1-${P}`)
    expect(h.sends).toBe(0)
    expect((await adminDb.collection('whatsappBroadcastJobs').where('campaignId', '==', `p2a-c1-${P}`).get()).empty).toBe(true)
  }, T)

  // ── A2 ────────────────────────────────────────────────────────────────────
  it('A2 · five concurrent legacy-funded sends on a balance worth ONE: exactly one funded, none free, never negative', async () => {
    const { slug } = await event()                                   // no capacity at all
    await walletRef().set({ balancePaise: PRICE, currency: 'INR' })
    const keys = [1, 2, 3, 4, 5].map(i => key(null, `c${i}`))
    const out = await Promise.all(keys.map(k => funding.reserveWhatsAppFunding(req(k, slug))))
    expect(out.filter(o => o.ok)).toEqual([{ ok: true, mode: 'legacy', costPaise: PRICE }])
    expect(out.filter(o => !o.ok).every(o => !o.ok && o.reason === 'allowance_required')).toBe(true)
    expect(await balance()).toBe(0)
    expect((await ledgerRows()).map(d => d.data())).toEqual([expect.objectContaining({ type: 'whatsapp_charge', amountPaise: PRICE, holdState: 'held' })])
  }, T)

  // ── A3 ────────────────────────────────────────────────────────────────────
  it('A3 · allowNegativeBalance=true cannot push the WhatsApp legacy path below zero (hold, recovery, broadcast charge-back)', async () => {
    h.allowNegative = true
    const { slug } = await event()
    await walletRef().set({ balancePaise: PRICE - 1, currency: 'INR' })
    // The hold refuses…
    const k = key(null, 'neg')
    expect(await funding.reserveWhatsAppFunding(req(k, slug))).toEqual({ ok: false, reason: 'allowance_required' })
    // …a recovered acceptance with no hold is recorded unbilled, not charged into the negative…
    const w = wamid('neg')
    expect(await accept(k, slug, w)).toMatchObject({ already: false, chargedPaise: 0, chargeSkipped: true })
    expect((await adminDb.doc(`communicationUsage/${acceptance.messageUsageId(w)}`).get()).data()).toMatchObject({ chargeSkipped: 'no_capacity', costPaise: 0 })
    // …and a wallet-funded broadcast cannot even start on it.
    const id = `p2a-cneg-${P}`
    await adminDb.doc(`broadcastCampaigns/${id}`).set({ organizerUid: UID, eventSlug: slug, status: 'draft', channel: 'whatsapp', recipientCount: 1 })
    expect(await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: 1 })).toEqual({ ok: false, reason: 'allowance_required' })
    expect(await balance()).toBe(PRICE - 1)
  }, T)

  // ── A4 ────────────────────────────────────────────────────────────────────
  it('A4 · webhook acceptance racing the sender\'s release: never a free message, exactly one unit', async () => {
    for (let round = 0; round < 6; round++) {
      const { d, slug } = await event({ purchased: 1 })
      const k = key(d, `race${round}`)
      expect(await funding.reserveWhatsAppFunding(req(k, slug))).toMatchObject({ ok: true, mode: 'allowance' })
      const w = wamid(`race${round}`)
      const [released, acc] = await Promise.all([funding.releaseWhatsAppFunding(k), accept(k, slug, w)])
      const usage = (await adminDb.doc(`communicationUsage/${acceptance.messageUsageId(w)}`).get()).data()!
      expect(acc.chargeSkipped).toBe(false)                         // never recorded free
      expect(usage.chargeSkipped).toBeUndefined()
      expect(await consumed(d)).toBe(1)                              // exactly one unit pays for it
      // Whichever won, the unit that pays is marked accepted (and so can never be released again).
      const units = (await adminDb.collection(`eventServiceAllowances/${d}/usage`).get()).docs.map(u => u.data())
      expect(units).toHaveLength(1)
      expect(units[0].acceptedWamid).toBe(w)
      expect(typeof released).toBe('boolean')
    }
  }, T)

  it('A4 · recovery for a legacy-funded send settles against ITS hold (charged once), and an unfundable one is never negative', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 500, currency: 'INR' })
    const k = key(null, 'leg')
    expect(await funding.reserveWhatsAppFunding(req(k, slug))).toMatchObject({ ok: true, mode: 'legacy' })
    const w = wamid('leg')
    expect(await accept(k, slug, w)).toMatchObject({ chargedPaise: PRICE, chargeSkipped: false })
    expect(await accept(k, slug, w)).toMatchObject({ already: true })              // 9 · duplicate webhook: idempotent
    expect(await balance()).toBe(500 - PRICE)                                       // ONE debit (the hold)
    expect((await adminDb.doc(`walletTransactions/${k.holdLedgerId}`).get()).data()).toMatchObject({ holdState: 'accepted', metadata: expect.objectContaining({ messageId: w }) })
    expect(await funding.releaseWhatsAppFunding(k)).toBe(false)                     // accepted ⇒ never given back
    expect(await balance()).toBe(500 - PRICE)
  }, T)

  // ── A5 ────────────────────────────────────────────────────────────────────
  it('A5 · an abandoned hold (prepaid and legacy) is returned by the sweep once the window passes — exactly once', async () => {
    const { d, slug } = await event({ purchased: 5 })
    await walletRef().set({ balancePaise: 500, currency: 'INR' })
    const ka = key(d, 'abA'), kl = key(null, 'abL')
    await funding.reserveWhatsAppFunding(req(ka, slug))
    await funding.reserveWhatsAppFunding(req(kl, slug))
    expect(await consumed(d)).toBe(1); expect(await balance()).toBe(500 - PRICE)
    // Inside the window nothing is touched (a legitimate send may still be in flight).
    expect((await funding.releaseExpiredWhatsAppHolds()).released).toBe(0)
    const later = Date.now() + funding.HOLD_RELEASE_AFTER_MS + 60_000
    expect((await funding.releaseExpiredWhatsAppHolds(later)).released).toBe(2)
    expect(await consumed(d)).toBe(0)
    expect(await balance()).toBe(500)
    expect((await adminDb.doc(`walletTransactions/${funding.holdReleaseLedgerId(kl.holdLedgerId)}`).get()).data()).toMatchObject({ type: 'refund', amountPaise: PRICE })
    // Idempotent: nothing left to return, nothing returned twice.
    expect((await funding.releaseExpiredWhatsAppHolds(later)).released).toBe(0)
    expect(await funding.releaseWhatsAppFunding(kl)).toBe(false)
    expect(await balance()).toBe(500)
  }, T)

  it('A5 · the sweep never returns a unit Meta ACCEPTED', async () => {
    const { d, slug } = await event({ purchased: 5 })
    const k = key(d, 'acc')
    await funding.reserveWhatsAppFunding(req(k, slug))
    await accept(k, slug, wamid('acc'))
    // Even with a stale index row re-pointing at it, an accepted unit stays consumed.
    await adminDb.doc(`whatsappHolds/${k.unitKey}`).set({ organizerUid: UID, draftId: d, unitKey: k.unitKey, holdLedgerId: k.holdLedgerId, createdAt: Timestamp.fromMillis(0) })
    await funding.releaseExpiredWhatsAppHolds()
    expect(await consumed(d)).toBe(1)
  }, T)

  // ── prepaid final unit ────────────────────────────────────────────────────
  it('10 · prepaid final unit: five concurrent sends on 1 remaining unit ⇒ exactly one funded, consumed never exceeds purchased', async () => {
    const { d, slug } = await event({ purchased: 3, consumed: 2 })
    const out = await Promise.all([1, 2, 3, 4, 5].map(i => funding.reserveWhatsAppFunding(req(key(d, `f${i}`), slug))))
    expect(out.filter(o => o.ok)).toHaveLength(1)
    expect(out.filter(o => !o.ok).every(o => !o.ok && o.reason === 'allowance_exhausted')).toBe(true)
    expect(await consumed(d)).toBe(3)
  }, T)

  // ── broadcast: unknown outcomes are HELD, a late acceptance uses the held unit ──
  it('broadcast · an unknown-outcome recipient keeps its unit at settlement; its late acceptance costs nothing more and is never free', async () => {
    const { d, slug } = await event({ purchased: 10 })
    const id = `p2a-bc-${P}`, jobId = `p2a-job-${P}`
    trees.add(`whatsappBroadcastJobs/${jobId}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({ organizerUid: UID, createdBy: UID, eventSlug: slug, eventId: slug, eventName: 'P2A', status: 'draft', channel: 'whatsapp', recipientCount: 3 })
    expect(await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: 3 })).toEqual({ ok: true, costPaise: 0 })
    expect(await consumed(d)).toBe(3)
    await adminDb.doc(`whatsappBroadcastJobs/${jobId}`).set({ campaignId: id, organizerUid: UID })
    const rec = (r: string, data: Record<string, unknown>) => adminDb.doc(`whatsappBroadcastJobs/${jobId}/recipients/${r}`).set(data)
    await rec('r1', { sent: true }); await rec('r2', { indeterminate: true }); await rec('r3', { failureReason: 'INVALID' })
    await adminDb.doc(`broadcastCampaigns/${id}`).update({ whatsappJobId: jobId, status: 'partial' })

    const s = await billing.settleBroadcastBilling(id, 1)
    expect(s).toMatchObject({ billedUnits: 1, refundedUnits: 1 })                  // r3 returned; r2 HELD
    expect(await consumed(d)).toBe(2)
    expect((await adminDb.doc(`broadcastCampaigns/${id}`).get()).data()).toMatchObject({ unknownHeldUnits: 1 })

    expect(await acceptance.recordBroadcastAcceptance({ jobId, recipientId: 'r2', wamid: wamid('bc'), source: 'webhook' })).toBe('late_held')
    expect(await consumed(d)).toBe(2)                                               // nothing taken again
    expect((await adminDb.doc(`broadcastCampaigns/${id}`).get()).data()).toMatchObject({ unknownHeldUnits: 0, billedUnits: 2 })
    expect(await acceptance.reconcileBroadcastBilledUnits(id)).toBe(0)             // nothing missing, nothing charged twice
    expect(await consumed(d)).toBe(2)
  }, T)

  it('broadcast · held units with no acceptance are returned after the webhook window — once', async () => {
    const { d, slug } = await event({ purchased: 10 })
    const id = `p2a-bh-${P}`, jobId = `p2a-jobh-${P}`
    trees.add(`whatsappBroadcastJobs/${jobId}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({ organizerUid: UID, createdBy: UID, eventSlug: slug, eventId: slug, eventName: 'P2A', status: 'draft', channel: 'whatsapp', recipientCount: 2 })
    await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: 2 })
    await adminDb.doc(`whatsappBroadcastJobs/${jobId}`).set({ campaignId: id, organizerUid: UID })
    await adminDb.doc(`whatsappBroadcastJobs/${jobId}/recipients/r1`).set({ indeterminate: true })
    await adminDb.doc(`whatsappBroadcastJobs/${jobId}/recipients/r2`).set({ indeterminate: true })
    await adminDb.doc(`broadcastCampaigns/${id}`).update({ whatsappJobId: jobId, status: 'failed' })
    await billing.settleBroadcastBilling(id, 0)
    expect(await consumed(d)).toBe(2)                                               // both held
    expect(await billing.releaseHeldBroadcastUnits(id)).toBe(0)                    // inside the window
    const later = Date.now() + funding.HOLD_RELEASE_AFTER_MS + 60_000
    expect(await billing.releaseHeldBroadcastUnits(id, later)).toBe(2)
    expect(await consumed(d)).toBe(0)
    expect(await billing.releaseHeldBroadcastUnits(id, later)).toBe(0)             // idempotent
  }, T)

  // ── 13 · historical wallet rows ───────────────────────────────────────────
  it('historical wallet rows are left exactly as they were', async () => {
    const { slug } = await event()
    const hist = adminDb.doc(`walletTransactions/whatsapp_hist_${P}`)
    const row = { organizerUid: UID, type: 'whatsapp_charge', amountPaise: 35, balancePaise: 965, status: 'completed', referenceType: 'communication', referenceId: 'hist', description: 'Historical', metadata: { messageId: 'wamid.hist' } }
    await hist.set(row)
    await walletRef().set({ balancePaise: 500, currency: 'INR' })
    const k = key(null, 'hist')
    await funding.reserveWhatsAppFunding(req(k, slug))
    await funding.releaseWhatsAppFunding(k)
    expect((await hist.get()).data()).toEqual(row)
  }, T)
})
