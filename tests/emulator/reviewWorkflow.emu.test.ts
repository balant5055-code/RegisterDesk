// RD-REVIEW-01 — the Super Admin ↔ organizer review cycle, end to end on the emulators.
// Real route handlers, real transactions; only the outbound channels (email provider, WhatsApp)
// are replaced, so every recipient can be asserted without a message leaving the machine.
//
//   C  request changes → both documents, the history entry, the organizer's inbox + email
//   R  resubmit → back in review, who/when/what recorded, the request it answered kept,
//      Super Admins alerted, discoverable in Event Approvals
//   H  a second cycle keeps the first; approval closes it; the timeline shows each occurrence once
//   X  refused transitions write no history, send nothing, and change nothing

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const afterQueue: Promise<unknown>[] = []
vi.mock('next/server', async orig => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { afterQueue.push(Promise.resolve().then(fn)) },
}))

const sent: { type: string; params: Record<string, unknown> }[] = []
vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      isAvailable: () => true,
      send: async (type: string, params: Record<string, unknown>) => { sent.push({ type, params }); return { success: true, messageId: `m-${sent.length}` } },
    },
  }
})
vi.mock('@/lib/notifications/organizerWhatsApp', () => ({ sendOrganizerWhatsApp: async () => undefined }))

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `rvw${process.pid}`

type Json = Record<string, unknown>

describeEmu('event review workflow: changes requested → resubmission → approval', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  type SlugRoute  = (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>
  type EventRoute = (req: Request, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let review: SlugRoute, history: SlugRoute, timeline: SlugRoute
  let resubmit: EventRoute
  let saveDraft: (req: Request, ctx: { params: Promise<{ draftId: string }> }) => Promise<Response>
  let approvals: (req: NextRequest) => Promise<Response>
  let stats: (req: NextRequest) => Promise<Response>

  const ORG = `${P}-org`, ADMIN = `${P}-admin`, OTHER = `${P}-other`
  const tokens: Record<string, string> = {}
  const created: { draftId: string; slug: string }[] = []
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
  const ctxSlug  = (slug: string) => ({ params: Promise.resolve({ slug }) })
  const ctxEvent = (eventId: string) => ({ params: Promise.resolve({ eventId }) })
  const flush = async () => { while (afterQueue.length) await afterQueue.shift() }

  function draftContent(desc: string): Json {
    return {
      eventType: 'conference', eventSubtype: null, campaignType: null, visibility: 'public',
      pricing: { eventType: 'free', passes: [{ id: 'p1', name: 'General', description: '', price: 0, quantity: 100, unlimited: false, status: 'active', visibility: 'public' }] },
      eventDetails: {
        info: { name: 'Review Cycle Summit', shortDesc: 'Short blurb', fullDesc: desc },
        schedule: { startDate: '2027-03-01', startTime: '09:00', endDate: '2027-03-01', endTime: '17:00', timezone: 'Asia/Kolkata' },
        venue: { type: 'physical', physical: { name: 'Main Hall', addressLine1: '1 Road', city: 'Chennai', state: 'TN', pincode: '600001', country: 'IN' } },
        organizer: { name: 'Probe Org', email: 'org@rd.test' },
        faq: [{ question: 'Parking?', answer: 'Yes' }],
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

  async function seedSubmitted(key: string) {
    const draftId = `${P}-d-${key}`, slug = `${P}-${key}`
    const content = draftContent('First description')
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
    created.push({ draftId, slug })
    return { draftId, slug }
  }

  async function editDraft(draftId: string, desc: string) {
    const snap = (await adminDb.doc(`users/${ORG}/eventDrafts/${draftId}`).get()).data()!
    const ed = { ...(draftContent(desc).eventDetails as Json), seo: (snap.eventDetails as Json).seo }
    const res = await saveDraft(req(`http://localhost/api/organizer/drafts/${draftId}`, tokens[ORG], 'PATCH', { eventDetails: ed }), { params: Promise.resolve({ draftId }) })
    expect(res.status, await res.clone().text()).toBe(200)
  }

  // RD-REVIEW-02 — a decision names the review cycle it reviewed: the event's CURRENT cycle (null for
  // an event seeded without one), read here as the review page would have loaded it.
  const doReview = async (slug: string, body: Json, who: string | null = ADMIN) => {
    const reviewCycleId = (((await adminDb.doc(`events/${slug}`).get()).data() ?? {}).reviewCycleId as string | undefined) ?? null
    const res = await review(req(`http://localhost/api/admin/events/${slug}/review`, who ? tokens[who] : null, 'POST', { reviewCycleId, ...body }), ctxSlug(slug))
    await flush()
    return res
  }
  const doResubmit = async (draftId: string, who = ORG) => {
    const res = await resubmit(req(`http://localhost/api/organizer/events/${draftId}/resubmit`, tokens[who], 'POST', {}), ctxEvent(draftId))
    await flush()
    return res
  }
  const historyDocs = async (slug: string) =>
    (await adminDb.collection(`events/${slug}/reviewHistory`).orderBy('at', 'asc').get()).docs.map(d => ({ id: d.id, ...d.data() } as Json))
  const inbox = async (draftId: string) =>
    (await adminDb.collection(`users/${ORG}/notifications`).where('eventId', '==', draftId).get()).docs.map(d => ({ id: d.id, ...d.data() } as Json))
  const queue = async (status?: string) => {
    const res = await approvals(req(`http://localhost/api/admin/event-approvals${status ? `?status=${status}` : ''}`, tokens[ADMIN]))
    expect(res.status).toBe(200)
    return (await res.json() as { events: Json[] }).events
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ POST: review }    = await import('@/app/api/admin/events/[slug]/review/route') as never)
    ;({ GET: history }    = await import('@/app/api/admin/events/[slug]/review-history/route') as never)
    ;({ GET: timeline }   = await import('@/app/api/admin/events/[slug]/timeline/route') as never)
    ;({ POST: resubmit }  = await import('@/app/api/organizer/events/[eventId]/resubmit/route') as never)
    ;({ PATCH: saveDraft } = await import('@/app/api/organizer/drafts/[draftId]/route') as never)
    ;({ GET: approvals }  = await import('@/app/api/admin/event-approvals/route') as never)
    ;({ GET: stats }      = await import('@/app/api/admin/event-approvals/stats/route') as never)

    for (const uid of [ORG, ADMIN, OTHER]) {
      await adminAuth.createUser({ uid, email: `${uid}@rd.test`, password: 'ReviewPassw0rd!', emailVerified: true })
      await adminDb.doc(`users/${uid}`).set({ uid, email: `${uid}@rd.test`, name: uid, role: 'organizer', workspaceOwner: true, accountStatus: 'active', emailVerified: true, createdAt: new Date() })
    }
    prevAdminUids = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = [prevAdminUids, ADMIN].filter(Boolean).join(',')
    for (const u of [ORG, ADMIN, OTHER]) tokens[u] = await idToken(u)
  }, T)

  afterAll(async () => {
    await flush()
    if (prevAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = prevAdminUids
    const wipe = async (q: FirebaseFirestore.Query) => { for (const d of (await q.get()).docs) await d.ref.delete() }
    for (const c of created) {
      await adminDb.doc(`users/${ORG}/eventDrafts/${c.draftId}`).delete().catch(() => null)
      await wipe(adminDb.collection(`events/${c.slug}/reviewHistory`))
      await wipe(adminDb.collection(`events/${c.slug}/changeLog`))
      await adminDb.doc(`events/${c.slug}`).delete().catch(() => null)
      await adminDb.doc(`registrationCounters/${c.slug}`).delete().catch(() => null)
      await adminDb.doc(`publishBaselines/${c.draftId}`).delete().catch(() => null)
      await wipe(adminDb.collection('adminAuditLogs').where('entityId', '==', c.slug))
      for (const d of (await adminDb.collection('adminNotifications').where('metadata.draftId', '==', c.draftId).get()).docs) {
        await adminDb.doc(`notificationOutbox/${d.id}`).delete().catch(() => null)
        await d.ref.delete()
      }
    }
    await wipe(adminDb.collection(`users/${ORG}/notifications`))
    await wipe(adminDb.collection('emailLogs').where('organizerUid', '==', ORG))
    for (const u of [ORG, ADMIN, OTHER]) {
      await adminDb.doc(`users/${u}`).delete().catch(() => null)
      await adminAuth.deleteUser(u).catch(() => null)
    }
  }, T)

  // ─── C · request changes ─────────────────────────────────────────────────────

  it('C · request changes persists the comment, records the admin, and tells the organizer where to act', async () => {
    const { draftId, slug } = await seedSubmitted('c')
    sent.length = 0
    const res = await doReview(slug, { action: 'request_changes', comment: 'Please add the venue map' })
    expect(res.status, await res.clone().text()).toBe(200)

    for (const path of [`users/${ORG}/eventDrafts/${draftId}`, `events/${slug}`]) {
      expect((await adminDb.doc(path).get()).data(), path).toMatchObject({
        lifecycleStatus: 'changes_requested', reviewStatus: 'changes_requested',
        changesComment: 'Please add the venue map', changesRequestedBy: ADMIN,
      })
    }
    const h = await historyDocs(slug)
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ action: 'request_changes', actorRole: 'admin', actorUid: ADMIN, comment: 'Please add the venue map', fromStatus: 'pending_review', toStatus: 'changes_requested' })

    // organizer: one inbox item, keyed to this decision, opening Setup; one email to the owner
    const items = await inbox(draftId)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: `event-review-changes_requested-${h[0].id}`, type: 'EVENT_CHANGES_REQUESTED', actionRequired: true, link: `/dashboard/events/${draftId}?tab=setup`, read: false })
    const mails = sent.filter(s => s.type === 'EVENT_CHANGES_REQUESTED')
    expect(mails).toHaveLength(1)
    expect(mails[0].params).toMatchObject({ to: `${ORG}@rd.test`, comment: 'Please add the venue map' })
    expect(String(mails[0].params.eventUrl)).toMatch(new RegExp(`/dashboard/events/${draftId}\\?tab=setup$`))
    // no Super Admin alert for an admin's own decision
    expect((await adminDb.collection('adminNotifications').where('metadata.draftId', '==', draftId).get()).size).toBe(0)

    // discoverable: in the changes-requested queue with the comment, absent from pending
    expect((await queue()).some(r => r.slug === slug)).toBe(false)
    expect((await queue('changes_requested')).find(r => r.slug === slug)).toMatchObject({
      status: 'changes_requested', changesComment: 'Please add the venue map', resubmissionCount: 0,
    })
    const s = await (await stats(req('http://localhost/api/admin/event-approvals/stats', tokens[ADMIN]))).json() as Json
    expect(Number(s.awaitingChanges)).toBeGreaterThanOrEqual(1)
  }, T)

  // ─── R · resubmit ────────────────────────────────────────────────────────────

  it('R · resubmission returns the event to review with who, when, what changed, and the request it answers', async () => {
    const { draftId, slug } = created.find(c => c.slug.endsWith('-c'))!
    await editDraft(draftId, 'Now with a venue map')
    sent.length = 0
    const res = await doResubmit(draftId)
    expect(res.status, await res.clone().text()).toBe(200)

    for (const path of [`users/${ORG}/eventDrafts/${draftId}`, `events/${slug}`]) {
      const d = (await adminDb.doc(path).get()).data()!
      expect(d, path).toMatchObject({ lifecycleStatus: 'pending_review', reviewStatus: null, changesComment: null, resubmittedBy: ORG, resubmissionCount: 1 })
      expect(d.lastReviewRequest, path).toMatchObject({ kind: 'changes_requested', comment: 'Please add the venue map' })
      expect(d.resubmittedAt?.toDate?.()).toBeInstanceOf(Date)
    }
    const h = await historyDocs(slug)
    expect(h.map(e => e.action)).toEqual(['request_changes', 'resubmit'])
    expect(h[1]).toMatchObject({ actorRole: 'organizer', actorUid: ORG, fromStatus: 'changes_requested', toStatus: 'pending_review' })
    expect(h[1].revisedSections).toContain('eventDetails.info')
    // the reviewed snapshot carries the revision
    expect((((await adminDb.doc(`events/${slug}`).get()).data()!.eventDetails as Json).info as Json).fullDesc).toBe('Now with a venue map')

    // Super Admins: one bell item + one outbox message, and the email went to the admin account
    const feed = await adminDb.collection('adminNotifications').where('metadata.draftId', '==', draftId).get()
    expect(feed.size).toBe(1)
    expect(feed.docs[0].data()).toMatchObject({ kind: 'event_review', href: `/admin/events/${encodeURIComponent(slug)}` })
    expect((await adminDb.doc(`notificationOutbox/${feed.docs[0].id}`).get()).exists).toBe(true)
    expect(sent.some(s => s.type === 'CUSTOM_EMAIL' && s.params.to === `${ADMIN}@rd.test`)).toBe(true)
    // the organizer's confirmation went to the organizer, not to an admin
    expect(sent.filter(s => s.type === 'EVENT_RESUBMITTED').map(s => s.params.to)).toEqual([`${ORG}@rd.test`])

    // Event Approvals: back in pending, marked as a resubmission answering the request
    expect((await queue()).find(r => r.slug === slug)).toMatchObject({
      status: 'pending_review', resubmissionCount: 1,
      lastReviewRequest: { kind: 'changes_requested', comment: 'Please add the venue map' },
    })
    expect((await queue('changes_requested')).some(r => r.slug === slug)).toBe(false)

    const hr = await (await history(req(`http://localhost/api/admin/events/${slug}/review-history`, tokens[ADMIN]), ctxSlug(slug))).json() as { current: Json; entries: Json[] }
    expect(hr.current).toMatchObject({ lifecycleStatus: 'pending_review', changesComment: null, resubmissionCount: 1 })
    expect(hr.entries.map(e => e.action)).toEqual(['resubmit', 'request_changes'])   // newest first
  }, T)

  // ─── H · a second cycle, then approval ───────────────────────────────────────

  it('H · a second cycle keeps the first; approval closes it; the timeline lists each occurrence once', async () => {
    const { draftId, slug } = created.find(c => c.slug.endsWith('-c'))!
    expect((await doReview(slug, { action: 'request_changes', comment: 'Also add parking details' })).status).toBe(200)
    await editDraft(draftId, 'Venue map and parking')
    expect((await doResubmit(draftId)).status).toBe(200)
    expect((await doReview(slug, { action: 'approve' })).status).toBe(200)

    const h = await historyDocs(slug)
    expect(h.map(e => e.action)).toEqual(['request_changes', 'resubmit', 'request_changes', 'resubmit', 'approve'])
    expect(h.filter(e => e.action === 'request_changes').map(e => e.comment)).toEqual(['Please add the venue map', 'Also add parking details'])
    expect(h[4]).toMatchObject({ actorRole: 'admin', actorUid: ADMIN, toStatus: 'published' })
    const ev = (await adminDb.doc(`events/${slug}`).get()).data()!
    expect(ev).toMatchObject({ lifecycleStatus: 'published', resubmissionCount: 2, lastReviewRequest: { comment: 'Also add parking details' } })

    // one inbox item per decision — two change requests stay two items
    const items = await inbox(draftId)
    expect(items.filter(i => i.type === 'EVENT_CHANGES_REQUESTED')).toHaveLength(2)

    const tl = await (await timeline(req(`http://localhost/api/admin/events/${slug}/timeline`, tokens[ADMIN]), ctxSlug(slug))).json() as { entries: Json[] }
    const review = tl.entries.filter(e => e.source === 'review')
    expect(review).toHaveLength(5)
    expect(review.some(e => String(e.detail).includes('Also add parking details'))).toBe(true)
    // superseded by the history: no lifecycle or audit duplicates of the same decisions
    expect(tl.entries.filter(e => e.source === 'lifecycle' && ['approved', 'changes_requested', 'resubmitted'].includes(String(e.action)))).toEqual([])
    expect(tl.entries.filter(e => e.source === 'audit' && String(e.action).startsWith('event.'))).toEqual([])
  }, T)

  it('H2 · delivering the same decision twice leaves one inbox item', async () => {
    const { draftId, slug } = created.find(c => c.slug.endsWith('-c'))!
    const first = (await historyDocs(slug)).find(e => e.action === 'request_changes')!
    const { sendEventReviewEmail } = await import('@/lib/events/reviewNotifications')
    await sendEventReviewEmail({ organizerUid: ORG, eventName: 'Review Cycle Summit', kind: 'changes_requested', comment: 'x', eventId: draftId, occurrenceId: String(first.id) })
    const items = (await inbox(draftId)).filter(i => i.id === `event-review-changes_requested-${first.id}`)
    expect(items).toHaveLength(1)
  }, T)

  // ─── X · refusals ────────────────────────────────────────────────────────────

  it('X · refused transitions write no history and send nothing', async () => {
    const { draftId, slug } = await seedSubmitted('x')
    sent.length = 0

    // resubmitting an event that is already in review
    expect((await doResubmit(draftId)).status).toBe(409)
    // a non-admin reviewing; no credentials at all
    expect((await doReview(slug, { action: 'request_changes', comment: 'Not my call' }, OTHER)).status).toBe(401)
    expect((await doReview(slug, { action: 'request_changes', comment: 'Anonymous' }, null)).status).toBe(401)
    // another organizer resubmitting someone else's event
    expect((await doReview(slug, { action: 'request_changes', comment: 'Real request' })).status).toBe(200)
    sent.length = 0
    expect((await doResubmit(draftId, OTHER)).status).toBe(404)
    // reviewing an event that is waiting on its organizer
    expect((await doReview(slug, { action: 'approve' })).status).toBe(409)

    expect((await historyDocs(slug)).map(e => e.action)).toEqual(['request_changes'])
    expect(sent).toEqual([])
    expect((await adminDb.doc(`events/${slug}`).get()).data()).toMatchObject({ lifecycleStatus: 'changes_requested', changesComment: 'Real request' })
    expect((await adminDb.collection('adminNotifications').where('metadata.draftId', '==', draftId).get()).size).toBe(0)

    // the history is admin-only
    expect((await history(req(`http://localhost/api/admin/events/${slug}/review-history`, tokens[ORG]), ctxSlug(slug))).status).toBe(403)
  }, T)
})
