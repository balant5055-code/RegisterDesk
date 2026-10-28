// RD-EVENT-TYPES-01 · RD-WA-MARKETING-01 · RD-REVIEW-02 follow-ups (emulator) — the two Super Admin
// release controls and the closed-event delete guard, end to end on real Firestore through the real
// routes. Identity is mocked at the token boundary; the publishing mode is forced to manual review;
// Razorpay is a stub (no payment is requested); email / WhatsApp senders are stubbed and Meta is
// never called (templates are only created / edited here, never submitted).
//
// Global settings this suite changes (platformSettings/eventTypes, the integrations config switch)
// are put back in afterAll.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({ caller: '', admin: '' }))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_rc', RAZORPAY_KEY_SECRET: 'rc',
  razorpay: {
    orders: { create: async () => { throw new Error('release controls never create a payment order') }, fetchPayments: async () => ({ items: [] }) },
    payments: { fetch: async () => { throw new Error('no payment') }, refund: async () => { throw new Error('never refunds') } },
  },
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.caller ? { uid: h.caller, email: null } : null),
}))
vi.mock('@/lib/team/workspace', async orig => {
  const ctx = () => ({ callerUid: h.caller, workspaceUid: h.caller, role: 'owner', permissions: ['events', 'broadcasts'], isOwner: true, eventIds: [], isStaffCredential: false })
  return {
    ...(await orig<typeof import('@/lib/team/workspace')>()),
    resolveWorkspaceUid: async () => ctx(),
    authorizeWorkspace:  async () => (h.caller ? { ...ctx(), ok: true, status: 200, error: '' } : { ok: false, status: 401, error: 'Unauthorized' }),
  }
})
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => h.admin || null,
  resolveSuperAdminUid: async () => h.admin || null,
  legacyAdminClaimOnly: async () => false,
}))
vi.mock('@/lib/platform/publishing', async orig => ({
  ...(await orig<typeof import('@/lib/platform/publishing')>()),
  getPublishingMode: async () => 'manual',
}))
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/events/reviewNotifications', async orig => ({
  ...(await orig<typeof import('@/lib/events/reviewNotifications')>()),
  sendEventReviewEmail: async () => undefined,
}))
vi.mock('@/lib/notifications/organizerWhatsApp', () => ({ sendOrganizerWhatsApp: async () => undefined }))
vi.mock('@/lib/notifications/outbox', async orig => ({ ...(await orig<typeof import('@/lib/notifications/outbox')>()), scheduleOutboxDelivery: () => undefined }))
vi.mock('@/lib/whatsappTemplates/metaApi', () => ({
  submitMetaTemplate: async () => { throw new Error('Meta is never called here') },
  getMetaTemplate:    async () => ({ ok: false, error: 'not used', notFound: false }),
  findMetaTemplate:   async () => null,
}))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `rc${process.pid}`
const ORG = `${P}-org`, ADMIN = `${P}-admin`
type Json = Record<string, unknown>
const AGREEMENT = { accurateInformation: true, settlementFeePolicy: true, termsOfService: true, privacyPolicy: true }

/** A draft that passes every publish requirement (free capacity 100 ⇒ no payment). */
function draftDoc(id: string, type: string, extra: Json = {}): Json {
  return {
    id, uid: ORG, status: 'draft', lifecycleStatus: 'draft', currentStep: 7, completedValues: Array(9).fill(null),
    eventType: type, eventSubtype: type === 'sports' ? 'marathon' : null, customEventSubtype: null, campaignType: 'event_only', linkedCampaign: null,
    visibility: 'public', accessControl: { type: 'open', approvedContacts: [], confirmationMode: 'auto' },
    pricing: { eventType: 'paid', feeModel: 'organizer_pays', passes: [{
      id: 'pass_0', name: 'Entry', code: 'ENTRY', description: 'General entry.', type: 'paid', price: 1500,
      earlyBirdEnabled: false, earlyBirdPrice: null, earlyBirdEndDate: '', unlimited: true, quantity: null,
      minPurchase: 1, maxPurchase: 5, hideWhenSoldOut: false, salesStartDate: '2026-01-01', salesEndDate: '2099-12-30',
      showRemainingSeats: true, visibility: 'public', featured: false, benefits: ['Kit'], customBenefits: [],
      raceDetails: null, eventType: type, eventSubtype: type === 'sports' ? 'running' : null,
      advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] }, status: 'active' }] },
    registrationForm: { template: 'standard', fields: [
      { id: 'f0', label: 'T-shirt size', type: 'select', required: true, placeholder: '', helpText: '', options: ['S', 'M', 'L'], linkedPassIds: [] }] },
    eventDetails: {
      info: { name: `Release ${id}`, tagline: 'Release controls',
        description: 'An event used to verify the release controls end to end on the emulator. '.repeat(3),
        coverImage: 'https://example.test/cover.jpg', logoUrl: 'https://example.test/logo.png', socialLinks: [] },
      schedule: { startDate: '2099-12-31', startTime: '06:00', endDate: '2099-12-31', endTime: '12:00', timezone: 'Asia/Kolkata' },
      venue: { type: 'physical', physical: { name: 'Cubbon Park', address: 'MG Road', city: 'Bengaluru', state: 'Karnataka' } },
      organizer: { name: 'Release Events', email: 'release@example.test', phone: '+919999999999', website: 'https://example.test' },
    },
    communicationBilling: null, licenseTier: 'free', publishedAt: null, registrationCapacity: 100,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  }
}

describeEmu('release controls · event type availability, Marketing templates, closed-event delete guard', () => {
  let db: import('firebase-admin/firestore').Firestore
  type R = (req: NextRequest, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>
  let typesAdmin: { GET: R; PUT: R }, typesOrganizer: R, createDraft: R, saveDraft: R, duplicate: R, publish: R, review: R, resubmit: R, deleteEvent: R
  let governance: { GET: R; PUT: R }
  let svc: typeof import('@/lib/whatsappTemplates/service')
  let priorTypes: Json | undefined
  let priorMarketing = false
  const drafts = new Set<string>(), slugs = new Set<string>(), templates = new Set<string>()
  let seq = 0

  const req = (body?: unknown, method = 'POST') => new NextRequest('http://localhost/api/test', {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const getReq = () => new NextRequest('http://localhost/api/test', { headers: { Authorization: 'Bearer t' } })
  const p = (k: string, v: string) => ({ params: Promise.resolve({ [k]: v }) })
  const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) as Json })
  const asOrg = () => { h.caller = ORG; h.admin = '' }
  const asAdmin = () => { h.admin = ADMIN; h.caller = '' }
  const nextId = () => { const id = `${P}-d${++seq}`; drafts.add(id); return id }
  const setTypes = async (enabled: Record<string, boolean>, reason = 'Release control emulator test') => { asAdmin(); return json(await typesAdmin.PUT(req({ enabled, reason }, 'PUT'))) }
  const setMarketing = async (on: boolean) => { asAdmin(); return json(await governance.PUT(req({ marketingTemplatesEnabled: on, reason: 'Release control emulator test' }, 'PUT'))) }
  const audits = async (action: string) => (await db.collection('adminAuditLogs').where('action', '==', action).where('adminUid', '==', ADMIN).get()).docs.map(d => d.data() as Json)

  const tplInput = (name: string, category: 'utility' | 'marketing') => ({
    name, category, language: 'en', eventSlug: null, examples: {},
    customVariables: [{ key: 'collectionTime', label: 'When', example: 'Friday 10:00' }],
    content: { header: null, body: 'Hi {{attendeeName}}, please collect your pack for {{eventName}} on {{collectionTime}} at the help desk. Thank you.', footer: 'Sent via RegisterDesk', buttons: [] },
  })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    typesAdmin     = await import('@/app/api/admin/settings/event-types/route') as unknown as { GET: R; PUT: R }
    typesOrganizer = (await import('@/app/api/organizer/event-types/route')).GET as R
    createDraft    = (await import('@/app/api/organizer/drafts/route')).POST as R
    saveDraft      = (await import('@/app/api/organizer/drafts/[draftId]/route')).PATCH as R
    duplicate      = (await import('@/app/api/organizer/events/[eventId]/duplicate/route')).POST as R
    publish        = (await import('@/app/api/events/publish/route')).POST as R
    review         = (await import('@/app/api/admin/events/[slug]/review/route')).POST as R
    resubmit       = (await import('@/app/api/organizer/events/[eventId]/resubmit/route')).POST as R
    deleteEvent    = (await import('@/app/api/organizer/events/[eventId]/route')).DELETE as R
    governance     = await import('@/app/api/admin/whatsapp-templates/governance/route') as unknown as { GET: R; PUT: R }
    svc            = await import('@/lib/whatsappTemplates/service')
    await db.doc(`users/${ORG}`).set({ uid: ORG, email: `${ORG}@rd.test`, name: ORG, role: 'organizer', workspaceOwner: true, accountStatus: 'active', emailVerified: true })
    priorTypes = (await db.doc('platformSettings/eventTypes').get()).data()
    await db.doc('platformSettings/eventTypes').delete()          // launch defaults for this suite
    asAdmin()
    priorMarketing = (await json(await governance.GET(getReq()))).body.marketingTemplatesEnabled === true
    if (priorMarketing) await setMarketing(false)
  }, T)

  afterAll(async () => {
    if (!db) return
    const wipe = async (q: FirebaseFirestore.Query) => { for (const d of (await q.get()).docs) await d.ref.delete().catch(() => null) }
    if (priorTypes) await db.doc('platformSettings/eventTypes').set(priorTypes)
    else await db.doc('platformSettings/eventTypes').delete().catch(() => null)
    asAdmin()
    const nowOn = (await json(await governance.GET(getReq()))).body.marketingTemplatesEnabled === true
    if (nowOn !== priorMarketing) await setMarketing(priorMarketing)
    for (const id of drafts) {
      await db.doc(`users/${ORG}/eventDrafts/${id}`).delete().catch(() => null)
      await db.doc(`publishBaselines/${id}`).delete().catch(() => null)
      await db.doc(`eventServiceAllowances/${id}`).delete().catch(() => null)
      await wipe(db.collection('adminNotifications').where('metadata.draftId', '==', id))
    }
    await wipe(db.collection(`users/${ORG}/eventDrafts`))
    for (const s of slugs) {
      for (const sub of ['reviewHistory', 'changeLog', 'editHistory']) await wipe(db.collection(`events/${s}/${sub}`))
      for (const c of ['events', 'eventLicenses', 'registrationCounters']) await db.doc(`${c}/${s}`).delete().catch(() => null)
      await wipe(db.collection('adminAuditLogs').where('entityId', '==', s))
    }
    for (const id of templates) {
      for (const sub of ['versions', 'history']) await wipe(db.collection(`whatsappTemplates/${id}/${sub}`))
      await db.doc(`whatsappTemplates/${id}`).delete().catch(() => null)
    }
    await wipe(db.collection('adminAuditLogs').where('adminUid', '==', ADMIN))
    await db.doc(`users/${ORG}`).delete().catch(() => null)
  }, T)

  // ── Event type availability ───────────────────────────────────────────────────────────────────

  it('launch defaults: organizers see Sports, Custom and Fundraising available, the rest Coming Soon', async () => {
    asOrg()
    const r = await json(await typesOrganizer(getReq()))
    expect(r.status).toBe(200)
    const a = r.body.availability as Record<string, boolean>
    expect(Object.keys(a).filter(k => a[k]).sort()).toEqual(['custom', 'fundraising', 'sports'])
    expect(Object.values(a).filter(v => !v)).toHaveLength(7)
  }, T)

  it('only a Super Admin may read or change the switches; a reason is required', async () => {
    asOrg()
    expect((await typesAdmin.GET(getReq())).status).toBe(403)
    expect((await typesAdmin.PUT(req({ enabled: { conference: true }, reason: 'organizer attempt' }, 'PUT'))).status).toBe(403)
    expect((await setTypes({ conference: true }, 'no')).status).toBe(400)
    expect((await setTypes({ notAType: true })).status).toBe(400)
    expect((await db.doc('platformSettings/eventTypes').get()).exists).toBe(false)
  }, T)

  it('a new draft of a disabled type is refused (direct API call); an enabled type is created', async () => {
    asOrg()
    const refused = await json(await createDraft(req({ seed: { eventType: 'conference' } })))
    expect(refused.status).toBe(403)
    expect(refused.body.code).toBe('EVENT_TYPE_UNAVAILABLE')
    const ok = await json(await createDraft(req({ seed: { eventType: 'sports' } })))
    expect(ok.status).toBe(201)
    drafts.add(ok.body.id as string)
  }, T)

  it('a draft cannot be switched to a disabled type; an existing draft of a disabled type stays editable', async () => {
    const sportsId = nextId(), confId = nextId()
    await db.doc(`users/${ORG}/eventDrafts/${sportsId}`).set(draftDoc(sportsId, 'sports'))
    await db.doc(`users/${ORG}/eventDrafts/${confId}`).set(draftDoc(confId, 'conference'))
    asOrg()
    const sw = await json(await saveDraft(req({ eventType: 'conference' }, 'PATCH'), p('draftId', sportsId)))
    expect(sw.status).toBe(403)
    expect((await db.doc(`users/${ORG}/eventDrafts/${sportsId}`).get()).get('eventType')).toBe('sports')
    const resave = await json(await saveDraft(req({ eventType: 'conference', currentStep: 3 }, 'PATCH'), p('draftId', confId)))
    expect(resave.status, JSON.stringify(resave.body)).toBe(200)
    expect((await db.doc(`users/${ORG}/eventDrafts/${confId}`).get()).get('currentStep')).toBe(3)
    const away = await json(await saveDraft(req({ eventType: 'custom' }, 'PATCH'), p('draftId', confId)))
    expect(away.status).toBe(200)
  }, T)

  it('duplicating an event of a disabled type is refused; the source is untouched', async () => {
    const id = nextId()
    await db.doc(`users/${ORG}/eventDrafts/${id}`).set(draftDoc(id, 'awards'))
    asOrg()
    const r = await json(await duplicate(req({}), p('eventId', id)))
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('EVENT_TYPE_UNAVAILABLE')
    expect((await db.collection(`users/${ORG}/eventDrafts`).where('eventType', '==', 'awards').get()).size).toBe(1)
  }, T)

  it('first submission of a disabled-type draft is refused with nothing written; enabling it (no deploy) lets it through', async () => {
    const id = nextId()
    await db.doc(`users/${ORG}/eventDrafts/${id}`).set(draftDoc(id, 'conference'))
    asOrg()
    const refused = await json(await publish(req({ draftId: id, agreement: AGREEMENT })))
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ canPublish: false, reason: 'EVENT_TYPE_UNAVAILABLE' })
    const d0 = (await db.doc(`users/${ORG}/eventDrafts/${id}`).get()).data()!
    expect(d0.status).toBe('draft')
    expect(d0.publishedAt).toBeNull()

    const on = await setTypes({ conference: true })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    const audit = await audits('platform.event_type_availability_changed')
    expect(audit.length).toBeGreaterThanOrEqual(1)
    expect(audit.some(a => (a.after as Json | undefined) && JSON.stringify(a.after).includes('"conference":true'))).toBe(true)

    asOrg()
    const ok = await json(await publish(req({ draftId: id, agreement: AGREEMENT })))
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const slug = ok.body.slug as string
    slugs.add(slug)
    expect((await db.doc(`events/${slug}`).get()).get('lifecycleStatus')).toBe('pending_review')

    // Disabling the type again never touches the submitted event: its review workflow continues.
    expect((await setTypes({ conference: false })).status).toBe(200)
    asAdmin()
    const cycle = (await db.doc(`events/${slug}`).get()).get('reviewCycleId') as string
    const rc = await json(await review(req({ action: 'request_changes', comment: 'Please add the venue landmark.', reviewCycleId: cycle }), p('slug', slug)))
    expect(rc.status, JSON.stringify(rc.body)).toBe(200)
    asOrg()
    const rs = await json(await resubmit(req({}), p('eventId', id)))
    expect(rs.status, JSON.stringify(rs.body)).toBe(200)
    expect((await db.doc(`events/${slug}`).get()).get('lifecycleStatus')).toBe('pending_review')
  }, T)

  // ── WhatsApp Marketing templates ──────────────────────────────────────────────────────────────

  it('Marketing is off by default: create is refused server-side, Utility still works', async () => {
    asAdmin()
    expect((await json(await governance.GET(getReq()))).body.marketingTemplatesEnabled).toBe(false)
    const caller = { workspaceUid: ORG, callerUid: ORG }
    await expect(svc.createTemplate({ caller, input: tplInput(`rc_mkt_${process.pid}`, 'marketing') })).rejects.toMatchObject({ code: 'MARKETING_DISABLED', status: 403 })
    const util = await svc.createTemplate({ caller, input: tplInput(`rc_utl_${process.pid}`, 'utility') })
    templates.add(util.id)
    // A Utility draft cannot be turned into Marketing while it is off.
    await expect(svc.updateDraft({ caller, id: util.id, version: 1, expectedRevision: 1, input: tplInput(`rc_utl_${process.pid}`, 'marketing') } as never))
      .rejects.toMatchObject({ code: 'MARKETING_DISABLED' })
    expect((await db.doc(`whatsappTemplates/${util.id}/versions/v1`).get()).get('category')).toBe('utility')
  }, T)

  it('only a Super Admin switches Marketing on (reason required, audited); then Marketing can be created', async () => {
    asOrg()
    expect((await governance.PUT(req({ marketingTemplatesEnabled: true, reason: 'organizer attempt' }, 'PUT'))).status).toBe(403)
    asAdmin()
    expect((await json(await governance.PUT(req({ marketingTemplatesEnabled: true, reason: 'x' }, 'PUT')))).status).toBe(400)
    const on = await setMarketing(true)
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect((await setMarketing(true)).body.code).toBe('NO_CHANGE')
    const audit = await audits('platform.whatsapp_marketing_templates_changed')
    expect(audit.some(a => (a.after as Json).whatsappMarketingTemplatesEnabled === true)).toBe(true)
    const caller = { workspaceUid: ORG, callerUid: ORG }
    const mkt = await svc.createTemplate({ caller, input: tplInput(`rc_mkt2_${process.pid}`, 'marketing') })
    templates.add(mkt.id)
    expect((await db.doc(`whatsappTemplates/${mkt.id}/versions/v1`).get()).get('category')).toBe('marketing')
    // Switching it off again keeps the existing Marketing template and its history.
    expect((await setMarketing(false)).status).toBe(200)
    expect((await db.doc(`whatsappTemplates/${mkt.id}`).get()).exists).toBe(true)
  }, T)

  // ── Closed-event delete guard ─────────────────────────────────────────────────────────────────

  it('an archived event closed during review cannot be permanently deleted; its record and review history stay', async () => {
    const id = nextId(), slug = `${P}-closed`
    slugs.add(slug)
    const closure = { source: 'deadline_expired', closedAt: new Date(), cycleId: 'c1' }
    await db.doc(`users/${ORG}/eventDrafts/${id}`).set(draftDoc(id, 'sports', {
      status: 'cancelled', lifecycleStatus: 'archived', archivedAt: new Date(), publishedAt: new Date('2026-01-02T00:00:00Z'),
      reviewClosure: closure, eventDetails: { ...(draftDoc(id, 'sports').eventDetails as Json), seo: { urlSlug: slug } },
    }))
    await db.doc(`events/${slug}`).set({ uid: ORG, organizerUid: ORG, draftId: id, lifecycleStatus: 'archived', reviewClosure: closure, eventType: 'sports' })
    await db.doc(`events/${slug}/reviewHistory/h1`).set({ action: 'request_changes', at: new Date(), actorRole: 'admin' })
    asOrg()
    const r = await json(await deleteEvent(new NextRequest('http://localhost/api/test', { method: 'DELETE', headers: { Authorization: 'Bearer t' } }), p('eventId', id)))
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('REVIEW_CLOSED')
    expect((await db.doc(`users/${ORG}/eventDrafts/${id}`).get()).exists).toBe(true)
    expect((await db.doc(`events/${slug}`).get()).exists).toBe(true)
    expect((await db.collection(`events/${slug}/reviewHistory`).get()).size).toBe(1)
  }, T)
})
