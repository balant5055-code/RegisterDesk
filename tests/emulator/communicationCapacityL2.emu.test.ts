// RD-COMMS-L2 — the ONE organizer definition of communication capacity on REAL Firestore (emulator).
//
// Real broadcast funding + settlement build the scenario Purchased 1,000 · Used 554 ·
// In progress 86 · Returned 80 · Available 480 (with 120 carried in), and Communications › Usage
// and License & Services (the real quote route) then report the SAME figures. The ledger is only
// read: what the two surfaces show is checked against the ledger's own available figure.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const UID = `capl2-org-${P}`

vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => { const c = await real.getCommunicationConfig(); return { ...c, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: 50 } } } }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['events', 'broadcasts', 'wallet'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))

describeEmu('RD-COMMS-L2 · one capacity definition on Usage and License & Services (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let billing: typeof import('@/lib/communications/billing')
  const docs = new Set<string>(), trees = new Set<string>()
  let n = 0

  async function event(whatsapp: Record<string, number> | null) {
    const k = ++n, d = `capl2-d${k}-${P}`, slug = `capl2-ev${k}-${P}`
    docs.add(`users/${UID}/eventDrafts/${d}`); trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`users/${UID}/eventDrafts/${d}`).set({ status: 'draft', eventDetails: { info: { name: `L2 ${k}` }, seo: { urlSlug: slug } } })
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true } })
    if (whatsapp) await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { onExhausted: 'block', consumed: 0, ...whatsapp } })
    return { d, slug }
  }
  async function broadcast(slug: string, units: number) {
    const id = `capl2-c${++n}-${P}`
    docs.add(`broadcastCampaigns/${id}`); docs.add(`communicationUsage/bc_${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({
      organizerUid: UID, createdBy: UID, eventId: slug, eventSlug: slug, eventName: 'L2', channel: 'whatsapp',
      audience: 'all', templateType: 'EVENT_UPDATED', variables: {}, recipientCount: units, successCount: 0, failCount: 0, status: 'draft', actualCostPaise: 0,
    })
    expect(await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: units })).toEqual({ ok: true, costPaise: 0 })
    return id
  }
  const both = async (d: string) => {
    const { getEventCommunicationUsage } = await import('@/lib/communications/usage')
    const { POST } = await import('@/app/api/licensing/checkout/quote/route')
    const usage = (await getEventCommunicationUsage(UID, d, { includeLegacyBalance: false }))!
    const res = await POST(new NextRequest('http://localhost/api/licensing/checkout/quote', {
      method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ eventId: d, services: {} }),
    }))
    expect(res.status).toBe(200)
    const quote = await res.json() as { coverage: { communication: { whatsapp: Record<string, unknown> } } }
    const usageFigures: Record<string, unknown> = { ...usage.whatsapp }
    delete usageFigures.manageHref
    return { usage: usageFigures as Omit<typeof usage.whatsapp, 'manageHref'>, license: quote.coverage.communication.whatsapp }
  }
  const ledgerAvailable = async (d: string) => {
    const { ledgerLine, availableUnits } = await import('@/lib/licensing/serviceAllowanceLedger')
    return availableUnits(ledgerLine((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data() as never, 'whatsapp'))
  }

  async function wipe() {
    for (const p of docs) await adminDb.doc(p).delete().catch(() => null)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const d of (await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    docs.clear(); trees.clear()
  }
  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    billing = await import('@/lib/communications/billing')
  }, T)
  beforeEach(wipe, T)
  afterAll(wipe, T)

  it('scenario 1,000 / 554 / 86 / 80 / 480: built by real funding + settlement; both surfaces agree with each other and the ledger', async () => {
    const { d, slug } = await event({ purchased: 1_000, carriedIn: 120, consumed: 534 })     // 534 already used (e.g. confirmations)
    const settledOne = await broadcast(slug, 100)                                            // takes 100…
    await adminDb.doc(`broadcastCampaigns/${settledOne}`).update({ status: 'sent' })
    expect(await billing.settleBroadcastBilling(settledOne, 20)).toMatchObject({ settled: true, billedUnits: 20, refundedUnits: 80 })   // …keeps 20, returns 80
    await broadcast(slug, 86)                                                                // still sending: 86 in progress

    const { usage, license } = await both(d)
    expect(usage).toEqual({ purchased: 1_000, used: 554, inProgress: 86, returned: 80, refunded: 0, carriedIn: 120, carriedOut: 0, available: 480 })
    expect(license).toEqual(usage)
    expect(usage.available).toBe(await ledgerAvailable(d))                                    // the ledger stays the source of truth
    expect(usage.available).not.toBe(usage.purchased - (usage.used as number))
  }, T)

  it('carried-out and refunded capacity are their own figures (not Returned); both surfaces agree', async () => {
    const { d } = await event({ purchased: 1_000, consumed: 200, carriedOut: 300, refunded: 100 })
    const { usage, license } = await both(d)
    expect(usage).toEqual({ purchased: 1_000, used: 200, inProgress: 0, returned: 0, refunded: 100, carriedIn: 0, carriedOut: 300, available: 400 })
    expect(license).toEqual(usage)
    expect(usage.available).toBe(await ledgerAvailable(d))
  }, T)

  it('fully consumed, and zero capacity: both surfaces agree', async () => {
    const full = await event({ purchased: 500, consumed: 500 })
    const a = await both(full.d)
    expect(a.usage).toMatchObject({ purchased: 500, used: 500, inProgress: 0, available: 0 })
    expect(a.license).toEqual(a.usage)

    const none = await event(null)
    const b = await both(none.d)
    expect(b.usage).toEqual({ purchased: 0, used: 0, inProgress: 0, returned: 0, refunded: 0, carriedIn: 0, carriedOut: 0, available: 0 })
    expect(b.license).toEqual(b.usage)
  }, T)

  it('another event’s broadcasts never count toward this event', async () => {
    const mine = await event({ purchased: 100 })
    const other = await event({ purchased: 100 })
    await broadcast(other.slug, 40)
    const { usage, license } = await both(mine.d)
    expect(usage).toMatchObject({ inProgress: 0, used: 0, available: 100 })
    expect(license).toEqual(usage)
  }, T)
})
