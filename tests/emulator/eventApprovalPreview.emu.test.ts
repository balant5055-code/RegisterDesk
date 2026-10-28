// Super Admin event approval — preview, authorization, and "approval publishes exactly what
// was reviewed". Real Firestore + Auth emulators, real route handlers, synthetic fixtures only.
//
//   P  a pending event 404s publicly but its full public page is previewable by a Super Admin;
//      every other principal is refused the preview and every review action
//   L  resubmit (after request-changes AND after rejection) and republish (after unpublish)
//      make the reviewable snapshot the LATEST draft; approval publishes that snapshot and
//      never anything written to the draft afterwards
//   G  the copy is refused (and nothing changes) when it would break the commercial freeze

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/events/reviewNotifications', () => ({ sendEventReviewEmail: async () => undefined }))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `eap${process.pid}`

type Json = Record<string, unknown>

describeEmu('event approval: preview, authorization and reviewed-content publication', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let review: (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>
  let preview: (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>
  let saveDraft: (req: Request, ctx: { params: Promise<{ draftId: string }> }) => Promise<Response>
  let resubmit: (req: Request, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let republish: (req: Request, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let status: (req: Request, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let findPublicEvent: (slug: string) => Promise<Json | null>
  let EventLayout: (p: { children: unknown; params: Promise<{ slug: string }> }) => Promise<unknown>

  const ORG = `${P}-org`, ADMIN = `${P}-admin`, OTHER = `${P}-other`, CLAIM = `${P}-claim`
  const tokens: Record<string, string> = {}
  const created: { uid: string; draftId: string; slug: string }[] = []
  let prevAdminUids: string | undefined

  async function idToken(uid: string): Promise<string> {
    const custom = await adminAuth.createCustomToken(uid)
    const key  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'fake-api-key'
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const res  = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })
    const body = await res.json() as { idToken?: string }
    if (!body.idToken) throw new Error(`no idToken: ${JSON.stringify(body)}`)
    return body.idToken
  }

  const req = (url: string, token: string | null, method = 'GET', body?: unknown) =>
    new NextRequest(new Request(url, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }))

  /** A draft that passes validateEventPublish — the shape the wizard writes. */
  function draftContent(desc: string, extra: Json = {}): Json {
    return {
      eventType: 'conference', eventSubtype: null, campaignType: null, visibility: 'public',
      pricing: { eventType: 'free', passes: [{ id: 'p1', name: 'General', description: '', price: 0, quantity: 100, unlimited: false, status: 'active', visibility: 'public' }] },
      eventDetails: {
        info: { name: 'Approval Probe Summit', shortDesc: 'Short blurb', fullDesc: desc },
        schedule: { startDate: '2027-03-01', startTime: '09:00', endDate: '2027-03-01', endTime: '17:00', timezone: 'Asia/Kolkata' },
        venue: { type: 'physical', physical: { name: 'Main Hall', addressLine1: '1 Road', city: 'Chennai', state: 'TN', pincode: '600001', country: 'IN' } },
        organizer: { name: 'Probe Org', email: 'org@rd.test' },
        faq: [{ question: 'Parking?', answer: 'Yes' }],
        ...extra,
      },
      registrationForm: {
        template: 'custom', fields: [], conditionalRules: [], settings: {}, registrationRules: {},
        sections: [{ id: 's1', title: 'Attendee', description: '', fields: [{
          id: 'f1', label: 'Full Name', type: 'text', required: true, visible: true, placeholder: '', helperText: '',
          options: [], validation: {}, section: 's1', conditionalLogic: null, passVisibility: 'all' }] }],
      },
      accessControl: null,
    }
  }

  /** The state /api/events/publish leaves: draft + events/{slug}, both pending_review. */
  async function seedSubmitted(key: string, desc: string) {
    const draftId = `${P}-d-${key}`, slug = `${P}-${key}`
    const content = draftContent(desc)
    const ed = { ...(content.eventDetails as Json), seo: { urlSlug: slug } }
    await adminDb.doc(`users/${ORG}/eventDrafts/${draftId}`).set({
      ...content, eventDetails: ed, id: draftId, status: 'pending_review', lifecycleStatus: 'pending_review',
      publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    })
    await adminDb.doc(`events/${slug}`).set({
      slug, uid: ORG, draftId, eventType: content.eventType, eventSubtype: null, campaignType: null, visibility: 'public',
      pricing: content.pricing, eventDetails: ed, registrationForm: content.registrationForm, accessControl: null,
      planType: 'free_event', totalCapacity: 100, lifecycleStatus: 'pending_review', publishedAt: new Date(), updatedAt: new Date(),
    })
    created.push({ uid: ORG, draftId, slug })
    return { draftId, slug }
  }

  const ctxSlug  = (slug: string) => ({ params: Promise.resolve({ slug }) })
  const ctxEvent = (eventId: string) => ({ params: Promise.resolve({ eventId }) })
  const liveDesc = async (slug: string) =>
    (((await adminDb.doc(`events/${slug}`).get()).data()!.eventDetails as Json).info as Json).fullDesc
  // RD-REVIEW-02 — a decision names the review cycle it reviewed: the event's CURRENT cycle (null for
  // an event seeded without one), read here as the review page would have loaded it.
  const doReview = async (slug: string, body: Json, who = ADMIN) => {
    const reviewCycleId = (((await adminDb.doc(`events/${slug}`).get()).data() ?? {}).reviewCycleId as string | undefined) ?? null
    return review(req(`http://localhost/api/admin/events/${slug}/review`, tokens[who] ?? null, 'POST', { reviewCycleId, ...body }), ctxSlug(slug))
  }
  async function editDraft(draftId: string, desc: string, extra: Json = {}) {
    const snap = (await adminDb.doc(`users/${ORG}/eventDrafts/${draftId}`).get()).data()!
    const ed = { ...(draftContent(desc, extra).eventDetails as Json), seo: (snap.eventDetails as Json).seo }
    const res = await saveDraft(req(`http://localhost/api/organizer/drafts/${draftId}`, tokens[ORG], 'PATCH', { eventDetails: ed }), { params: Promise.resolve({ draftId }) })
    expect(res.status, await res.clone().text()).toBe(200)
  }
  async function layoutStatus(slug: string): Promise<number> {
    try { await EventLayout({ children: null, params: Promise.resolve({ slug }) }); return 200 }
    catch (e) { if (String((e as { digest?: unknown }).digest ?? '').includes('404')) return 404; throw e }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ POST: review } = await import('@/app/api/admin/events/[slug]/review/route') as never)
    ;({ GET: preview } = await import('@/app/api/admin/events/[slug]/preview/route') as never)
    ;({ PATCH: saveDraft } = await import('@/app/api/organizer/drafts/[draftId]/route') as never)
    ;({ POST: resubmit } = await import('@/app/api/organizer/events/[eventId]/resubmit/route') as never)
    ;({ POST: republish } = await import('@/app/api/organizer/events/[eventId]/republish/route') as never)
    ;({ POST: status } = await import('@/app/api/organizer/events/[eventId]/status/route') as never)
    ;({ findPublicEvent } = await import('@/lib/events/publicEventAccess') as never)
    ;({ default: EventLayout } = await import('@/app/events/[slug]/layout') as never)

    for (const [uid, claims] of [[ORG, null], [ADMIN, null], [OTHER, null], [CLAIM, { admin: true, isAdmin: true, role: 'superadmin' }]] as const) {
      await adminAuth.createUser({ uid, email: `${uid}@rd.test`, password: 'ApprovalPassw0rd!', emailVerified: true })
      if (claims) await adminAuth.setCustomUserClaims(uid, claims)
      await adminDb.doc(`users/${uid}`).set({ uid, email: `${uid}@rd.test`, name: uid, role: 'organizer', workspaceOwner: true, accountStatus: 'active', emailVerified: true, createdAt: new Date() })
    }
    prevAdminUids = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = [prevAdminUids, ADMIN].filter(Boolean).join(',')
    for (const u of [ORG, ADMIN, OTHER, CLAIM]) tokens[u] = await idToken(u)
  }, T)

  afterAll(async () => {
    if (prevAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = prevAdminUids
    for (const c of created) {
      await adminDb.doc(`users/${c.uid}/eventDrafts/${c.draftId}`).delete().catch(() => null)
      await adminDb.doc(`events/${c.slug}`).delete().catch(() => null)
      for (const d of (await adminDb.collection(`events/${c.slug}/changeLog`).get()).docs) await d.ref.delete()
      await adminDb.doc(`registrationCounters/${c.slug}`).delete().catch(() => null)
      await adminDb.doc(`publishBaselines/${c.draftId}`).delete().catch(() => null)
      for (const d of (await adminDb.collection('adminAuditLogs').where('entityId', '==', c.slug).get()).docs) await d.ref.delete()
    }
    for (const u of [ORG, ADMIN, OTHER, CLAIM]) {
      await adminDb.doc(`users/${u}`).delete().catch(() => null)
      await adminAuth.deleteUser(u).catch(() => null)
    }
  }, T)

  // ─── P · preview + authorization ─────────────────────────────────────────────

  it('P1 · a pending event 404s publicly but a Super Admin previews its full public page', async () => {
    const { slug } = await seedSubmitted('p1', 'The pending description')
    expect(await findPublicEvent(slug)).toBeNull()
    expect(await layoutStatus(slug)).toBe(404)

    const res = await preview(req(`http://localhost/api/admin/events/${slug}/preview`, tokens[ADMIN]), ctxSlug(slug))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
    expect(res.headers.get('x-robots-tag')).toMatch(/noindex/)
    const body = await res.json() as { lifecycleStatus: string; props: Json; review: Json }
    expect(body.lifecycleStatus).toBe('pending_review')
    // rendered as it will look once approved
    expect(body.props).toMatchObject({
      slug, lifecycleStatus: 'published', title: 'Approval Probe Summit', description: 'The pending description',
      eventType: 'conference', venueName: 'Main Hall, Chennai',
    })
    expect((body.props.passes as Json[]).map(p => p.name)).toEqual(['General'])
    expect(body.props.faq).toEqual([{ question: 'Parking?', answer: 'Yes' }])
    expect(body.review).toMatchObject({ registrationFields: [{ label: 'Full Name', type: 'text', required: true }] })
    // nothing beyond public props + the review appendix
    const text = JSON.stringify(body)
    for (const secret of ['publishAgreement', 'totalCapacity', 'workspaceOwner', 'draftId', 'uid']) expect(text).not.toContain(`"${secret}"`)
  }, T)

  it('P2 · organizers, legacy-claim holders and anonymous callers get no preview and no review action', async () => {
    const { slug } = await seedSubmitted('p2', 'Guarded')
    for (const who of [ORG, OTHER, CLAIM, null] as const) {
      const pr = await preview(req(`http://localhost/api/admin/events/${slug}/preview`, who ? tokens[who] : null), ctxSlug(slug))
      expect(pr.status, `preview as ${who}`).toBe(403)
      for (const action of [{ action: 'approve' }, { action: 'reject', reason: 'nope nope' }, { action: 'request_changes', comment: 'fix it' }]) {
        const r = await review(req(`http://localhost/api/admin/events/${slug}/review`, who ? tokens[who] : null, 'POST', action), ctxSlug(slug))
        expect(r.status, `${action.action} as ${who}`).toBe(401)
      }
    }
    // the organizer's own lifecycle route cannot approve either
    const self = await status(req(`http://localhost/api/organizer/events/x/status`, tokens[ORG], 'POST', { action: 'approve' }), ctxEvent(`${P}-d-p2`))
    expect(self.status).toBe(400)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.lifecycleStatus).toBe('pending_review')
  }, T)

  it('P4 · the review appendix lists EVERY ticket, the applied fee model, rules and warnings — and never secrets', async () => {
    const slug = `${P}-p4`
    created.push({ uid: ORG, draftId: `${P}-d-p4`, slug })
    const pass = (o: Json) => ({ id: String(o.id), name: String(o.name), description: '', type: 'paid', price: 500, unlimited: false, quantity: 50,
      minPurchase: 1, maxPurchase: 4, status: 'active', visibility: 'public', earlyBirdEnabled: false, salesStartDate: '', salesEndDate: '',
      advancedSettings: { refundable: true, transferable: false, waitlist: false, groupBooking: true }, ...o })
    await adminDb.doc(`events/${slug}`).set({
      slug, uid: ORG, draftId: `${P}-d-p4`, eventType: 'sports', eventSubtype: 'marathon', visibility: 'private',
      pricing: { eventType: 'paid', feeModel: 'attendee_pays', currency: 'INR', registrationOpenDate: '', registrationEndDate: '', passes: [
        pass({ id: 'a', name: 'Full Marathon', code: 'FM', earlyBirdEnabled: true, earlyBirdPrice: 400, earlyBirdEndDate: '2020-01-01',
          raceDetails: { category: '42K', customCategory: '', minAge: 18, maxAge: null } }),
        pass({ id: 'b', name: 'Hidden VIP', visibility: 'invite_only', price: 2000 }),
        pass({ id: 'c', name: 'Retired Pass', status: 'inactive' }),
        pass({ id: 'd', name: 'Crew Comp', type: 'complimentary', price: 0 }),
        pass({ id: 'e', name: 'Closed Sales', salesStartDate: '2020-01-01', salesEndDate: '2020-02-01' }),
      ] },
      eventDetails: {
        info: { name: 'Appendix Probe Marathon', shortDesc: 's', fullDesc: 'f' },
        // already over → the existing publish validation must surface a warning
        schedule: { startDate: '2020-03-01', startTime: '06:00', endDate: '2020-03-01', endTime: '12:00', timezone: 'Asia/Kolkata' },
        venue: { type: 'physical', physical: { name: 'Beach', city: 'Chennai' } },
        organizer: { name: 'Org', email: 'org@rd.test' },
        seo: { urlSlug: slug, metaTitle: 'SEO Title', metaDescription: 'SEO Desc', keywords: ['run', 'chennai'] },
      },
      registrationForm: { template: 'custom', sections: [], fields: [], registrationRules: { requireLogin: true, limitPerEmail: true, requireMobileVerification: true } },
      accessControl: { type: 'approved_contacts', confirmationMode: 'manual',
        inviteCode: { code: 'TOPSECRET99' },
        approvedContacts: [{ id: '1', name: 'Hidden Person', email: 'hidden.person@rd.test', mobileNumber: '+919111111111', memberId: 'X', addedAt: '' }] },
      planType: 'paid_event', totalCapacity: 500, lifecycleStatus: 'pending_review', publishedAt: new Date(), updatedAt: new Date(),
    })
    // the draft approval transitions through (as /api/events/publish leaves it)
    await adminDb.doc(`users/${ORG}/eventDrafts/${P}-d-p4`).set({
      id: `${P}-d-p4`, status: 'pending_review', lifecycleStatus: 'pending_review', eventDetails: { seo: { urlSlug: slug } },
      publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    })
    const res = await preview(req(`http://localhost/api/admin/events/${slug}/preview`, tokens[ADMIN]), ctxSlug(slug))
    expect(res.status).toBe(200)
    const text = await res.text()
    // privacy: neither the invite code nor any approved contact leaves the server
    for (const secret of ['TOPSECRET99', 'hidden.person', 'Hidden Person', '9111111111']) expect(text, secret).not.toContain(secret)
    const { review } = JSON.parse(text) as { review: Json }
    const passes = review.passes as Json[]
    expect(passes.map(p => p.name)).toEqual(['Full Marathon', 'Hidden VIP', 'Retired Pass', 'Crew Comp', 'Closed Sales'])
    const byName = Object.fromEntries(passes.map(p => [p.name, p]))
    expect(byName['Hidden VIP']).toMatchObject({ visibility: 'invite_only', publiclyListed: false, pricePaise: 200000 })
    expect(byName['Retired Pass']).toMatchObject({ status: 'inactive', publiclyListed: false })
    expect(byName['Crew Comp']).toMatchObject({ type: 'complimentary', isFree: true, fees: null })
    expect(byName['Full Marathon']).toMatchObject({
      code: 'FM', minPurchase: 1, maxPurchase: 4, flags: { refundable: true, groupBooking: true, transferable: false, waitlist: false },
      earlyBird: { enabled: true, pricePaise: 40000, endDate: '2020-01-01' }, raceDetails: { category: '42K', minAge: 18 },
    })
    expect(byName['Closed Sales'].saleState).toBe('ended')
    // fee model: what checkout actually applies (organizer pays), not the stored 'attendee_pays'
    const pricing = review.pricing as Json
    expect((pricing.feeCollection as Json).storedValue).toBe('attendee_pays')
    expect(String((pricing.feeCollection as Json).applied)).toMatch(/^Organizer pays/)
    const fees = byName['Full Marathon'].fees as Json | null
    expect((pricing.feeCollection as Json).feesAvailable).toBe(true)
    expect(fees).not.toBeNull()
    expect(fees!.attendeePaysPaise).toBe(50000)                    // organizer pays → ticket price only
    expect(Number(fees!.platformFeePaise)).toBeGreaterThan(0)
    expect(Number(fees!.organizerNetPaise)).toBe(50000 - Number(fees!.platformFeePaise) - Number(fees!.gatewayFeeEstimatePaise))
    expect(review.access).toEqual({ mode: 'approved_contacts', inviteCodeConfigured: true, approvedContactCount: 1, approvedContactsWithEmail: 1 })
    expect(review.seo).toMatchObject({ metaTitle: 'SEO Title', metaDescription: 'SEO Desc', keywords: ['run', 'chennai'] })
    const rules = review.registrationRules as Json[]
    expect(rules.find(r => r.label === 'Require sign-in')).toMatchObject({ value: 'Yes', enforcement: 'enforced' })
    expect(rules.find(r => r.label === 'Require mobile verification')).toMatchObject({ value: 'Yes', enforcement: 'configured_only' })
    // warnings come from the existing rules and do not block approval
    const warnings = (review.warnings as Json[]).map(w => String(w.id))
    expect(warnings).toContain('schedule_past')
    expect(warnings.some(w => w.startsWith('sales_ended:Closed Sales'))).toBe(true)
    expect((await doReview(slug, { action: 'approve' })).status).toBe(200)
  }, T)

  it('P3 · review still requires pending_review (409 otherwise)', async () => {
    const { slug } = await seedSubmitted('p3', 'Once')
    expect((await doReview(slug, { action: 'approve' })).status).toBe(200)
    expect((await doReview(slug, { action: 'approve' })).status).toBe(409)
    expect((await doReview(slug, { action: 'reject', reason: 'too late' })).status).toBe(409)
  }, T)

  // ─── L · the reviewed snapshot is the published snapshot ─────────────────────

  it('L1 · request changes → corrected draft → resubmit: the reviewable snapshot is the CORRECTION, and approval publishes it', async () => {
    const { draftId, slug } = await seedSubmitted('l1', 'Version one')
    expect((await doReview(slug, { action: 'request_changes', comment: 'Please fix the description' })).status).toBe(200)

    await editDraft(draftId, 'Version two — corrected', { faq: [{ question: 'Parking?', answer: 'Yes, free' }] })
    expect(await liveDesc(slug)).toBe('Version one')          // a draft edit alone touches nothing live

    const rs = await resubmit(req(`http://localhost/api/organizer/events/${draftId}/resubmit`, tokens[ORG], 'POST', {}), ctxEvent(draftId))
    expect(rs.status, await rs.clone().text()).toBe(200)
    const live = (await adminDb.doc(`events/${slug}`).get()).data()!
    expect(live.lifecycleStatus).toBe('pending_review')
    expect(await liveDesc(slug)).toBe('Version two — corrected')
    expect(((live.eventDetails as Json).seo as Json).urlSlug).toBe(slug)
    expect(await findPublicEvent(slug)).toBeNull()            // still not public until approved

    const pv = await (await preview(req(`http://localhost/api/admin/events/${slug}/preview`, tokens[ADMIN]), ctxSlug(slug))).json() as { props: Json }
    expect(pv.props.description).toBe('Version two — corrected')
    expect(pv.props.faq).toEqual([{ question: 'Parking?', answer: 'Yes, free' }])

    // the organizer keeps editing the draft DURING review — that must not ride along on approval
    await editDraft(draftId, 'Version three — never reviewed')

    expect((await doReview(slug, { action: 'approve' })).status).toBe(200)
    const pub = await findPublicEvent(slug)
    expect(pub?.lifecycleStatus).toBe('published')
    expect(await liveDesc(slug)).toBe('Version two — corrected')
    expect(await layoutStatus(slug)).toBe(200)
  }, T)

  it('L2 · reject → corrected draft → resubmit: same guarantee', async () => {
    const { draftId, slug } = await seedSubmitted('l2', 'Rejected original')
    expect((await doReview(slug, { action: 'reject', reason: 'Misleading description' })).status).toBe(200)
    await editDraft(draftId, 'Honest rewrite')
    const rs = await resubmit(req(`http://localhost/api/organizer/events/${draftId}/resubmit`, tokens[ORG], 'POST', {}), ctxEvent(draftId))
    expect(rs.status, await rs.clone().text()).toBe(200)
    expect(await liveDesc(slug)).toBe('Honest rewrite')
    const ev = (await adminDb.doc(`events/${slug}`).get()).data()!
    expect(ev.lifecycleStatus).toBe('pending_review')
    expect(ev.rejectionReason).toBeNull()                     // the review cycle resets as before
    expect((await doReview(slug, { action: 'approve' })).status).toBe(200)
    expect(await liveDesc(slug)).toBe('Honest rewrite')
  }, T)

  it('L3 · unpublish → edit → republish: back to review with the edit, public only after approval', async () => {
    const { draftId, slug } = await seedSubmitted('l3', 'Live once')
    expect((await doReview(slug, { action: 'approve' })).status).toBe(200)
    const un = await status(req('http://localhost/x', tokens[ORG], 'POST', { action: 'unpublish' }), ctxEvent(draftId))
    expect(un.status).toBe(200)
    expect(await findPublicEvent(slug)).toBeNull()

    await editDraft(draftId, 'Relaunch copy')
    const rp = await republish(req(`http://localhost/api/organizer/events/${draftId}/republish`, tokens[ORG], 'POST', {}), ctxEvent(draftId))
    expect(rp.status, await rp.clone().text()).toBe(200)
    expect((await adminDb.doc(`events/${slug}`).get()).data()!.lifecycleStatus).toBe('pending_review')
    expect(await liveDesc(slug)).toBe('Relaunch copy')
    expect(await findPublicEvent(slug)).toBeNull()            // no self-publish through republish
    expect((await doReview(slug, { action: 'approve' })).status).toBe(200)
    expect(await liveDesc(slug)).toBe('Relaunch copy')
  }, T)

  // ─── G · the copy keeps the commercial freeze ────────────────────────────────

  it('G1 · a resubmit that changes a ticket price is refused and changes nothing', async () => {
    const { draftId, slug } = await seedSubmitted('g1', 'Priced')
    expect((await doReview(slug, { action: 'request_changes', comment: 'Fix the copy' })).status).toBe(200)
    const draftRef = adminDb.doc(`users/${ORG}/eventDrafts/${draftId}`)
    const pricing = (await draftRef.get()).data()!.pricing as Json
    await draftRef.update({
      pricing: { ...pricing, eventType: 'paid', passes: [{ ...(pricing.passes as Json[])[0], price: 500 }] },
      'eventDetails.info.fullDesc': 'Sneaky price change',
    })
    const rs = await resubmit(req(`http://localhost/api/organizer/events/${draftId}/resubmit`, tokens[ORG], 'POST', {}), ctxEvent(draftId))
    expect(rs.status).toBe(409)
    const ev = (await adminDb.doc(`events/${slug}`).get()).data()!
    expect(ev.lifecycleStatus).toBe('changes_requested')      // not back in review
    expect(await liveDesc(slug)).toBe('Priced')
    expect(((ev.pricing as Json).passes as Json[])[0].price).toBe(0)
  }, T)
})
