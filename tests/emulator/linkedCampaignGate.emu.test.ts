// A donation campaign linked to an event is public — page, /causes, sitemap, donation
// orders — only while its event is public and not cancelled. Proved over real Firestore and
// the real handlers; the payment gateway is mocked (no Razorpay call is ever made).
//
// The fixture is the exact pair /api/events/publish writes for an `event_plus_donation`
// submission: events/{slug} (lifecycleStatus as the case needs) + donationCampaigns/{slug}
// with status 'active' and linkedEventSlug = slug.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/razorpay/client', () => ({ RAZORPAY_KEY_ID: 'rzp_test_linkedgate', RAZORPAY_KEY_SECRET: 'x', razorpay: {} }))
vi.mock('@/lib/razorpay/donationGateway', () => ({
  RazorpayDonationGateway: class {
    async createOrder(p: { donationId: string; amountPaise: number }) {
      return { gatewayOrderId: `order_test_${p.donationId}`, amountPaise: p.amountPaise, currency: 'INR' }
    }
    verifySignature() { return false }
  },
}))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `lcg${process.pid}`

describeEmu('linked donation campaign follows its event', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let createOrder: (req: Request) => Promise<Response>
  let listCampaigns: () => Promise<{ slug: string }[]>
  let sitemap: () => Promise<{ url: string }[]>
  let CampaignLayout: (p: { children: unknown; params: Promise<{ slug: string }> }) => Promise<unknown>
  const slugs: string[] = []
  let ipSeq = 0

  function campaignDoc(slug: string, linked: boolean) {
    return {
      slug, uid: `${P}-org`, draftId: `${P}-draft-${slug}`,
      campaignType: linked ? 'event_plus_donation' : 'donation_only',
      eventSubtype: null, visibility: 'public',
      ...(linked ? { linkedEventSlug: slug, linkedEventId: slug } : {}),
      campaignDetails: {
        basics: { title: `Gate ${slug}`, tagline: 'Synthetic', story: 'Synthetic story' },
        media: { coverImageUrl: null, promoVideoUrl: null },
        beneficiary: { name: 'Synthetic', type: 'organization', description: '', ngoName: '', ngoRegistrationNo: '' },
        goal: { targetAmountRupees: 1000, startDate: '2026-10-01', endDate: '2027-12-31', allowOverFunding: true, showGoalAmount: true },
        organizer: { name: 'Synthetic Org', email: 'org@rd.test', phone: '', website: '' },
        taxConfig: { enabled: false },
      },
      donationSettings: { amounts: { minimumAmountRupees: 10, maximumAmountRupees: null } },
      status: 'active', totalRaisedPaise: 0, donorCount: 0,
      publishedAt: new Date(), updatedAt: new Date(),
    }
  }

  /** events/{slug} + donationCampaigns/{slug}; `event` null ⇒ no event document. */
  async function seed(key: string, event: Record<string, unknown> | null, linked = true) {
    const slug = `${P}-${key}`
    slugs.push(slug)
    if (event) await adminDb.doc(`events/${slug}`).set({ slug, uid: `${P}-org`, draftId: `${P}-draft-${slug}`, eventDetails: { info: { name: `Event ${key}` } }, ...event })
    await adminDb.doc(`donationCampaigns/${slug}`).set(campaignDoc(slug, linked))
    return slug
  }

  async function order(slug: string) {
    const res = await createOrder(new NextRequest(new Request('http://localhost/api/donations/create-order', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.77.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` },
      body: JSON.stringify({ campaignSlug: slug, amountRupees: 100, donorName: 'Synthetic Donor', donorEmail: 'donor@rd.test' }),
    })))
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  const donationsFor = async (slug: string) =>
    (await adminDb.collection('donations').where('campaignSlug', '==', slug).get()).size

  async function layoutStatus(slug: string): Promise<number> {
    try {
      await CampaignLayout({ children: null, params: Promise.resolve({ slug }) })
      return 200
    } catch (e) {
      const digest = String((e as { digest?: unknown }).digest ?? '')
      if (digest.includes('404')) return 404
      throw e
    }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST: createOrder } = await import('@/app/api/donations/create-order/route') as never)
    ;({ listCampaigns } = await import('@/lib/firebase/firestore/campaigns') as never)
    ;({ default: sitemap } = await import('@/app/sitemap') as never)
    ;({ default: CampaignLayout } = await import('@/app/campaign/[slug]/layout') as never)
  }, T)

  afterAll(async () => {
    for (const s of slugs) {
      for (const d of (await adminDb.collection('donations').where('campaignSlug', '==', s).get()).docs) await d.ref.delete()
      await adminDb.doc(`donationCampaigns/${s}`).delete().catch(() => null)
      await adminDb.doc(`donationCounters/${s}`).delete().catch(() => null)
      await adminDb.doc(`events/${s}`).delete().catch(() => null)
    }
  }, T)

  // ─── donation orders ─────────────────────────────────────────────────────────

  const BLOCKED: [string, Record<string, unknown> | null][] = [
    ['pending',     { lifecycleStatus: 'pending_review' }],
    ['rejected',    { lifecycleStatus: 'draft', reviewStatus: 'rejected', rejectionReason: 'x' }],
    ['changes',     { lifecycleStatus: 'changes_requested', reviewStatus: 'changes_requested' }],
    ['unpublished', { lifecycleStatus: 'unpublished' }],
    ['archived',    { lifecycleStatus: 'archived', archivedAt: new Date() }],
    ['cancelled',   { lifecycleStatus: 'cancelled', cancelReason: 'Synthetic cancel' }],
    ['takendown',   { lifecycleStatus: 'published', moderationStatus: 'taken_down' }],
    ['noevent',     null],
  ]

  for (const [key, event] of BLOCKED) {
    it(`a campaign whose event is ${key} refuses a donation order and writes nothing`, async () => {
      const slug = await seed(key, event)
      const r = await order(slug)
      expect(r.status).toBe(404)
      expect(await donationsFor(slug)).toBe(0)
      expect(await layoutStatus(slug)).toBe(404)
    }, T)
  }

  it('an APPROVED (published) event keeps its campaign fully working', async () => {
    const slug = await seed('approved', { lifecycleStatus: 'published' })
    const r = await order(slug)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.razorpayOrderId).toMatch(/^order_test_/)
    expect(await donationsFor(slug)).toBe(1)
    expect(await layoutStatus(slug)).toBe(200)
  }, T)

  it('registration_closed and completed events keep their campaign too', async () => {
    for (const ls of ['registration_closed', 'completed']) {
      const slug = await seed(`ok-${ls}`, { lifecycleStatus: ls })
      expect((await order(slug)).status).toBe(200)
    }
  }, T)

  it('a legacy event with no lifecycleStatus but status published still counts as public', async () => {
    const slug = await seed('legacy', { status: 'published' })
    expect((await order(slug)).status).toBe(200)
  }, T)

  it('a standalone donation_only campaign (no linked event) is unaffected', async () => {
    const slug = await seed('standalone', null, false)
    expect((await order(slug)).status).toBe(200)
    expect(await layoutStatus(slug)).toBe(200)
  }, T)

  it('approval flips it: the same campaign refuses while pending, accepts once published', async () => {
    const slug = await seed('flip', { lifecycleStatus: 'pending_review' })
    expect((await order(slug)).status).toBe(404)
    await adminDb.doc(`events/${slug}`).update({ lifecycleStatus: 'published' })
    expect((await order(slug)).status).toBe(200)
  }, T)

  // ─── metadata ────────────────────────────────────────────────────────────────

  it('the campaign page metadata of a non-public linked campaign is generic and noindex', async () => {
    const { generateMetadata } = await import('@/app/campaign/[slug]/page') as unknown as {
      generateMetadata: (p: { params: Promise<{ slug: string }> }) => Promise<{ title?: unknown; robots?: unknown; alternates?: unknown; openGraph?: unknown; description?: unknown }>
    }
    const pending = await seed('meta-pending', { lifecycleStatus: 'pending_review' })
    const m = await generateMetadata({ params: Promise.resolve({ slug: pending }) })
    expect(String(m.title)).toMatch(/^Campaign Not Found/)
    expect(m.robots).toEqual({ index: false, follow: false })
    expect(m.alternates).toBeUndefined()
    expect(m.openGraph).toBeUndefined()
    expect(JSON.stringify(m)).not.toContain(`Gate ${pending}`)
    // an approved event's campaign keeps its full metadata
    const live = await seed('meta-live', { lifecycleStatus: 'published' })
    const ok = await generateMetadata({ params: Promise.resolve({ slug: live }) })
    expect(String(ok.title)).toContain(`Gate ${live}`)
  }, T)

  // ─── listings ────────────────────────────────────────────────────────────────

  it('/causes lists only campaigns whose event is public (plus standalone ones)', async () => {
    const listed = new Set((await listCampaigns()).map(c => c.slug))
    for (const [key] of BLOCKED) expect(listed.has(`${P}-${key}`), `${key} listed`).toBe(false)
    for (const key of ['approved', 'standalone']) expect(listed.has(`${P}-${key}`), `${key} missing`).toBe(true)
  }, T)

  it('the sitemap advertises only campaigns whose event is public (plus standalone ones)', async () => {
    const urls = (await sitemap()).map(e => e.url)
    const has = (key: string) => urls.some(u => u.endsWith(`/campaign/${P}-${key}`))
    for (const [key] of BLOCKED) expect(has(key), `${key} in sitemap`).toBe(false)
    for (const key of ['approved', 'standalone']) expect(has(key), `${key} missing`).toBe(true)
  }, T)
})
