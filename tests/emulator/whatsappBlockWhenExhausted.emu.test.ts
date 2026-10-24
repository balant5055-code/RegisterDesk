// RD-WA-BLOCK-01 — owner decision 2026-10-24: a NEW WhatsApp message is funded ONLY by the event's
// prepaid WhatsApp capacity; when it is exhausted the message is BLOCKED. The legacy organizer
// balance no longer funds new messages. REAL Firestore (emulator), the REAL production rule (no
// mock of the capacity module here). No request leaves the process; no money moves.
//
//   B1  transactional sends (confirmation / retry / certificate share reserveWhatsAppFunding):
//       capacity left ⇒ funded by a unit; exhausted or none bought ⇒ refused, even with a legacy
//       balance that would cover it, and the balance is untouched;
//   B2  a broadcast the capacity does not cover is refused even with a covering legacy balance;
//   B3  the composer quote says the same thing (no "funded by legacy balance");
//   B4  an acceptance with no usable hold and no capacity is recorded UNBILLED (never charged to
//       the legacy balance, never a silent free message);
//   B5  a legacy hold taken BEFORE the change still settles against itself (settlement unchanged).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const UID = `wab-org-${P}`
const PRICE = 50

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

describeEmu('RD-WA-BLOCK-01 · WhatsApp is blocked when event capacity is exhausted', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let funding: typeof import('@/lib/whatsapp/funding')
  let acceptance: typeof import('@/lib/whatsapp/acceptance')
  let billing: typeof import('@/lib/communications/billing')
  let quote: typeof import('@/lib/communications/capacityQuote')
  const docs = new Set<string>(), trees = new Set<string>()
  let n = 0

  const walletRef = () => adminDb.doc(`organizerWallets/${UID}`)
  const balance = async () => ((await walletRef().get()).data()?.balancePaise as number | undefined) ?? null
  const consumed = async (d: string) => ((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data()?.whatsapp?.consumed as number | undefined) ?? 0
  const ledgerRows = async () => (await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).docs

  async function event(whatsapp?: { purchased: number; consumed?: number }) {
    const k = ++n
    const d = `wab-d${k}-${P}`, slug = `wab-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true } })
    if (whatsapp) await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: whatsapp.purchased, consumed: whatsapp.consumed ?? 0, onExhausted: 'block' } })
    return { d, slug }
  }
  const key = (draftId: string | null, tag: string) => {
    const unitKey = `wa_reg_wab${++n}${tag}`
    docs.add(`whatsappHolds/${unitKey}`)
    return { organizerUid: UID, draftId, unitKey, holdLedgerId: `whatsapp_wab${n}${tag}` }
  }
  const req = (k: ReturnType<typeof key>, slug: string) => ({
    ...k, legacyPricePaise: PRICE, source: 'test',
    ledger: { referenceId: k.unitKey, description: 'test', eventSlug: slug, metadata: {} },
  })
  const accept = (k: ReturnType<typeof key>, slug: string, wamid: string) => acceptance.recordMessageAcceptance({
    organizerUid: UID, eventSlug: slug, eventName: 'WAB', wamid, templateKey: 'registration_confirmation',
    funding: { draftId: k.draftId, unitKey: k.unitKey, holdLedgerId: k.holdLedgerId, legacyPricePaise: PRICE },
    ledgerReferenceId: k.unitKey, ledgerDescription: 'test', ledgerMetadata: {}, log: null, source: 'webhook',
  })
  const wamid = (tag: string) => { const w = `wamid.wab.${P}.${++n}.${tag}`; docs.add(`communicationUsage/${acceptance.messageUsageId(w)}`); return w }

  async function wipe() {
    for (const p of docs) await adminDb.doc(p).delete().catch(() => null)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const d of await ledgerRows()) await d.ref.delete()
    for (const d of (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(d.ref)
    await walletRef().delete().catch(() => null)
    docs.clear(); trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    funding = await import('@/lib/whatsapp/funding')
    acceptance = await import('@/lib/whatsapp/acceptance')
    billing = await import('@/lib/communications/billing')
    quote = await import('@/lib/communications/capacityQuote')
  }, T)
  beforeEach(wipe, T)
  afterAll(wipe, T)

  it('B1 · a transactional send uses a unit while capacity lasts, then is refused — a covering legacy balance funds nothing', async () => {
    const { d, slug } = await event({ purchased: 1 })
    await walletRef().set({ balancePaise: 10_000, currency: 'INR' })
    expect(await funding.reserveWhatsAppFunding(req(key(d, 'a'), slug))).toEqual({ ok: true, mode: 'allowance', costPaise: 0 })
    expect(await consumed(d)).toBe(1)
    expect(await funding.reserveWhatsAppFunding(req(key(d, 'b'), slug))).toEqual({ ok: false, reason: 'allowance_exhausted' })
    expect(await balance()).toBe(10_000)
    expect(await ledgerRows()).toHaveLength(0)
  }, T)

  it('B1b · an event with NO WhatsApp capacity bought is refused (allowance_required) whatever the legacy balance', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 10_000, currency: 'INR' })
    expect(await funding.reserveWhatsAppFunding(req(key(null, 'c'), slug))).toEqual({ ok: false, reason: 'allowance_required' })
    expect(await balance()).toBe(10_000)
  }, T)

  it('B2 · a broadcast beyond the capacity is refused even with a covering legacy balance; nothing is charged', async () => {
    const { d, slug } = await event({ purchased: 3 })
    await walletRef().set({ balancePaise: 10_000, currency: 'INR' })
    const id = `wab-c-${P}`
    await adminDb.doc(`broadcastCampaigns/${id}`).set({ organizerUid: UID, eventSlug: slug, status: 'draft', channel: 'whatsapp', recipientCount: 5 })
    expect(await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: 5 })).toEqual({ ok: false, reason: 'allowance_exhausted' })
    expect(await balance()).toBe(10_000)
    expect(await consumed(d)).toBe(0)
  }, T)

  it('B3 · the composer quote agrees: covered by capacity ⇒ funded; beyond it ⇒ insufficient, never "legacy balance"', async () => {
    const { slug } = await event({ purchased: 3 })
    await walletRef().set({ balancePaise: 10_000, currency: 'INR' })
    const within = await quote.quoteWhatsAppBroadcastCapacity({ organizerUid: UID, eventSlug: slug, recipientCount: 3 })
    expect(within).toMatchObject({ sufficient: true, fundedBy: 'event_capacity' })
    const beyond = await quote.quoteWhatsAppBroadcastCapacity({ organizerUid: UID, eventSlug: slug, recipientCount: 5 })
    expect(beyond).toMatchObject({ sufficient: false, fundedBy: null, shortfall: 2 })
  }, T)

  it('B4 · an acceptance with no usable hold and no capacity is recorded UNBILLED — the legacy balance is not charged', async () => {
    const { slug } = await event({ purchased: 1, consumed: 1 })
    await walletRef().set({ balancePaise: 10_000, currency: 'INR' })
    const w = wamid('late')
    expect(await accept(key(null, 'late'), slug, w)).toMatchObject({ already: false, chargedPaise: 0, chargeSkipped: true })
    expect((await adminDb.doc(`communicationUsage/${acceptance.messageUsageId(w)}`).get()).data()).toMatchObject({ chargeSkipped: 'no_capacity', costPaise: 0 })
    expect(await balance()).toBe(10_000)
  }, T)

  it('B5 · a legacy hold taken BEFORE the change still settles against itself on acceptance (charged once)', async () => {
    const { slug } = await event()
    await walletRef().set({ balancePaise: 10_000 - PRICE, currency: 'INR' })
    const k = key(null, 'old')
    // the shape funding.ts wrote for a legacy-funded hold before RD-WA-BLOCK-01
    await adminDb.doc(`walletTransactions/${k.holdLedgerId}`).set({
      organizerUid: UID, type: 'whatsapp_charge', amountPaise: PRICE, balancePaise: 10_000 - PRICE, status: 'completed',
      referenceType: 'communication', referenceId: k.unitKey, description: 'pre-change hold',
      metadata: { eventSlug: slug, channel: 'whatsapp', units: 1, unitKey: k.unitKey, hold: true }, holdState: 'held', createdAt: new Date(),
    })
    await adminDb.doc(`whatsappHolds/${k.unitKey}`).set({ organizerUid: UID, draftId: null, unitKey: k.unitKey, holdLedgerId: k.holdLedgerId, source: 'test', mode: 'legacy', amountPaise: PRICE, createdAt: new Date() })
    const w = wamid('old')
    expect(await accept(k, slug, w)).toMatchObject({ already: false, chargedPaise: PRICE, chargeSkipped: false })
    expect(await balance()).toBe(10_000 - PRICE)                       // charged once, by the existing hold
    expect((await adminDb.doc(`walletTransactions/${k.holdLedgerId}`).get()).data()).toMatchObject({ holdState: 'accepted' })
  }, T)
})
