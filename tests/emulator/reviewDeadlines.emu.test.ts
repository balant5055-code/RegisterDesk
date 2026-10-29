// RD-REVIEW-02 — the review lifecycle with its two 24-hour deadlines, end to end on the emulators.
// Real routes and real transactions: publish (first submission), the admin review route, resubmit,
// close-review, the draft save / edit routes, the licence purchase route's guard, and the scheduler
// route. Identity is mocked at the token boundary; the publishing mode is forced to manual review;
// Razorpay is a stub (no payment is ever requested here); outbound email / WhatsApp are captured.
// Time is advanced by moving the STORED deadline back, so the code under test runs on its real clock.
//
// The numbered items refer to the RD-REVIEW-02 test matrix.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => {
  // The cron gate reads CRON_SECRET once, when lib/env loads: set it before any import.
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'rv2-cron-secret-for-emulator-tests'
  return { caller: '', workspace: '', admin: '', engineFails: false, sent: 0 }
})

// RD-EVENT-TYPES-01 — this suite submits a Conference event to show the lifecycle is type-agnostic,
// so every type is switched on here; the default-off refusals are covered by releaseControls.emu.
vi.mock('@/lib/events/eventTypeAvailabilityServer', async orig => ({
  ...(await orig<typeof import('@/lib/events/eventTypeAvailabilityServer')>()),
  getEventTypeAvailability: async () => ({ availability: Object.fromEntries((await import('@/lib/events/eventTypeAvailability')).EVENT_TYPE_IDS.map(t => [t, true])), unavailable: false }),
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_rv2', RAZORPAY_KEY_SECRET: 'rv2',
  razorpay: {
    orders: { create: async () => { throw new Error('RD-REVIEW-02 never creates a payment order') }, fetchPayments: async () => ({ items: [] }) },
    payments: { fetch: async () => { throw new Error('no payment') }, refund: async () => { throw new Error('RD-REVIEW-02 never refunds') } },
  },
}))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.caller ? { uid: h.caller, email: null } : null),
}))
vi.mock('@/lib/team/workspace', async orig => {
  const ctx = () => ({ callerUid: h.caller, workspaceUid: h.workspace, role: h.caller === h.workspace ? 'owner' : 'manager', permissions: ['events'], isOwner: h.caller === h.workspace, eventIds: [], isStaffCredential: false })
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
vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      isAvailable: () => true,
      send: async () => { h.sent++; return h.engineFails ? { success: false, error: 'provider down' } : { success: true, messageId: `m-${h.sent}` } },
    },
  }
})

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `rv2${process.pid}`
const ORG = `${P}-org`, MEMBER = `${P}-mgr`, OTHER = `${P}-other`, ADMIN = `${P}-admin`
const HOUR = 3_600_000
type Json = Record<string, unknown>

/** A draft that passes every publish requirement (free capacity 100 ⇒ no payment). */
function draftDoc(id: string, type: string, extra: Json = {}): Json {
  const base: Json = {
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
      info: { name: `Review ${id}`, tagline: 'Review deadlines',
        description: 'An event used to verify the review deadline lifecycle end to end. '.repeat(3),
        coverImage: 'https://example.test/cover.jpg', logoUrl: 'https://example.test/logo.png', socialLinks: [] },
      schedule: { startDate: '2099-12-31', startTime: '06:00', endDate: '2099-12-31', endTime: '12:00', timezone: 'Asia/Kolkata' },
      venue: { type: 'physical', physical: { name: 'Cubbon Park', address: 'MG Road', city: 'Bengaluru', state: 'Karnataka' } },
      organizer: { name: 'Review Events', email: 'review@example.test', phone: '+919999999999', website: 'https://example.test' },
    },
    communicationBilling: null, licenseTier: 'free', publishedAt: null, registrationCapacity: 100,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
  }
  return { ...base, ...extra }
}

describeEmu('RD-REVIEW-02 · review cycles, the two 24-hour deadlines and review closure', () => {
  let db: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let Transaction: typeof import('firebase-admin/firestore').Transaction
  type R = (req: NextRequest, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>
  let publish: R, review: R, resubmit: R, closeReview: R, saveDraft: R, getDraft: R, editRoute: R, purchase: R, cron: R, restore: R, archive: R, republish: R
  let cancelRoute: R, statusRoute: R
  let applyLifecycleTransition: typeof import('@/lib/events/lifecycle').applyLifecycleTransition
  let deliverOutboxMessage: typeof import('@/lib/notifications/outbox').deliverOutboxMessage
  const drafts = new Set<string>(), slugs = new Set<string>()
  let seq = 0

  const req = (body?: unknown, auth = 'Bearer t') => new NextRequest('http://localhost/api/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const getReq = () => new NextRequest('http://localhost/api/test', { headers: { Authorization: 'Bearer t' } })
  const p = (k: string, v: string) => ({ params: Promise.resolve({ [k]: v }) })
  const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) as Json })
  const asOrg = (uid = ORG, workspace = ORG) => { h.caller = uid; h.workspace = workspace; h.admin = '' }
  const asAdmin = () => { h.admin = ADMIN; h.caller = ''; h.workspace = '' }

  const draftOf = async (id: string) => (await db.doc(`users/${ORG}/eventDrafts/${id}`).get()).data() as Json
  const eventOf = async (slug: string) => (await db.doc(`events/${slug}`).get()).data() as Json
  const history = async (slug: string) => (await db.collection(`events/${slug}/reviewHistory`).orderBy('at', 'asc').get()).docs.map(d => d.data() as Json)
  const outboxIds = async (prefix: string) => (await db.collection('notificationOutbox').where('__name__', '>=', prefix).where('__name__', '<', `${prefix}`).get()).docs.map(d => d.id)
  const audits = async (slug: string, action: string) => (await db.collection('adminAuditLogs').where('entityId', '==', slug).where('action', '==', action).get()).docs.map(d => d.data() as Json)

  /** A real first submission (manual review): returns the draft id and the live slug. */
  async function submitted(type: string = 'sports') {
    const id = `${P}-d${++seq}`
    drafts.add(id)
    await db.doc(`users/${ORG}/eventDrafts/${id}`).set(draftDoc(id, type))
    asOrg()
    const r = await json(await publish(req({ draftId: id, agreement: { accurateInformation: true, settlementFeePolicy: true, termsOfService: true, privacyPolicy: true } })))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const slug = r.body.slug as string
    slugs.add(slug)
    return { id, slug }
  }
  const decide = async (slug: string, body: Json) => { asAdmin(); return json(await review(req(body), p('slug', slug))) }
  const cycleOf = async (slug: string) => ((await eventOf(slug)).reviewCycleId as string | undefined) ?? null
  async function requestChanges(slug: string, comment = 'Please add the venue landmark.') {
    const r = await decide(slug, { action: 'request_changes', comment, reviewCycleId: await cycleOf(slug) })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  }
  // A team member acts in the owner's workspace; any other organizer acts in their OWN workspace.
  const doResubmit = async (id: string, as = ORG) => { asOrg(as, as === MEMBER ? ORG : as); return json(await resubmit(req({}), p('eventId', id))) }
  const doClose = async (id: string, body: Json, as = ORG, workspace = ORG) => { asOrg(as, workspace); return json(await closeReview(req(body), p('eventId', id))) }
  const runCron = async (auth = `Bearer ${process.env.CRON_SECRET}`) => json(await cron(req(undefined, auth)))

  /** Moves every instant of the stored deadline `ms` into the past (draft + event), as if time passed. */
  async function age(id: string, slug: string, ms: number) {
    const { readReviewDeadline, nextDeadlineAt } = await import('@/lib/events/reviewDeadline')
    const dl = readReviewDeadline((await draftOf(id)).reviewDeadline)!
    const sh = (v: number | null) => (v === null ? null : v - ms)
    const moved = { ...dl, changesRequestedAt: sh(dl.changesRequestedAt)!, changesDueAt: sh(dl.changesDueAt)!, actionRequiredAt: sh(dl.actionRequiredAt), actionDueAt: sh(dl.actionDueAt),
      remindersSent: Object.fromEntries(Object.entries(dl.remindersSent).map(([k, v]) => [k, (v as number) - ms])) }
    const ts = (v: number | null) => (v === null ? null : Timestamp.fromMillis(v))
    const stored = { cycleId: moved.cycleId, phase: moved.phase, changesRequestedAt: ts(moved.changesRequestedAt), changesDueAt: ts(moved.changesDueAt),
      actionRequiredAt: ts(moved.actionRequiredAt), actionDueAt: ts(moved.actionDueAt),
      remindersSent: Object.fromEntries(Object.entries(moved.remindersSent).map(([k, v]) => [k, Timestamp.fromMillis(v as number)])) }
    await db.doc(`users/${ORG}/eventDrafts/${id}`).update({ reviewDeadline: stored })
    await db.doc(`events/${slug}`).update({ reviewDeadline: stored, reviewDeadlineNextAt: Timestamp.fromMillis(nextDeadlineAt(moved)) })
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ Timestamp, Transaction } = await import('firebase-admin/firestore'))
    publish     = (await import('@/app/api/events/publish/route')).POST as R
    review      = (await import('@/app/api/admin/events/[slug]/review/route')).POST as R
    resubmit    = (await import('@/app/api/organizer/events/[eventId]/resubmit/route')).POST as R
    closeReview = (await import('@/app/api/organizer/events/[eventId]/close-review/route')).POST as R
    saveDraft   = (await import('@/app/api/organizer/drafts/[draftId]/route')).PATCH as R
    getDraft    = (await import('@/app/api/organizer/drafts/[draftId]/route')).GET as R
    editRoute   = (await import('@/app/api/organizer/events/[eventId]/edit/route')).PATCH as R
    purchase    = (await import('@/app/api/licensing/purchase/route')).POST as R
    cron        = (await import('@/app/api/cron/review-deadlines/route')).POST as R
    restore     = (await import('@/app/api/organizer/events/[eventId]/restore/route')).POST as R
    archive     = (await import('@/app/api/organizer/events/[eventId]/archive/route')).POST as R
    republish   = (await import('@/app/api/organizer/events/[eventId]/republish/route')).POST as R
    cancelRoute = (await import('@/app/api/organizer/events/[eventId]/cancel/route')).POST as R
    statusRoute = (await import('@/app/api/organizer/events/[eventId]/status/route')).POST as R
    ;({ applyLifecycleTransition } = await import('@/lib/events/lifecycle'))
    ;({ deliverOutboxMessage } = await import('@/lib/notifications/outbox'))
    for (const uid of [ORG, MEMBER, OTHER]) {
      await db.doc(`users/${uid}`).set({ uid, email: `${uid}@rd.test`, name: uid, role: 'organizer', workspaceOwner: uid !== MEMBER, accountStatus: 'active', emailVerified: true })
    }
  }, T)
  beforeEach(() => { h.engineFails = false; vi.restoreAllMocks() })

  afterAll(async () => {
    const wipe = async (q: FirebaseFirestore.Query) => { for (const d of (await q.get()).docs) await d.ref.delete().catch(() => null) }
    for (const id of drafts) {
      await db.doc(`users/${ORG}/eventDrafts/${id}`).delete().catch(() => null)
      await db.doc(`licenseOrders/lic_${id}`).delete().catch(() => null)
      await db.doc(`eventServiceAllowances/${id}`).delete().catch(() => null)
      await db.doc(`publishBaselines/${id}`).delete().catch(() => null)
      await wipe(db.collection('adminNotifications').where('metadata.draftId', '==', id))
    }
    for (const s of slugs) {
      for (const sub of ['reviewHistory', 'changeLog', 'editHistory']) await wipe(db.collection(`events/${s}/${sub}`))
      await db.doc(`events/${s}`).delete().catch(() => null)
      await db.doc(`eventLicenses/${s}`).delete().catch(() => null)
      await db.doc(`registrationCounters/${s}`).delete().catch(() => null)
      await wipe(db.collection('adminAuditLogs').where('entityId', '==', s))
    }
    await wipe(db.collection('notificationOutbox').where('__name__', '>=', 'review-dl_').where('__name__', '<', 'review-dl_'))
    await wipe(db.collection('notificationOutbox').where('__name__', '>=', 'evt-review_').where('__name__', '<', 'evt-review_'))
    await wipe(db.collection(`users/${ORG}/notifications`))
    await db.doc(`organizerWallets/${ORG}`).delete().catch(() => null)
    for (const uid of [ORG, MEMBER, OTHER]) await db.doc(`users/${uid}`).delete().catch(() => null)
  }, T)

  // ─── submission, cycles, stale decisions ──────────────────────────────────────

  it('1 · the first submission opens a review cycle (draft + event) and records it in the history', async () => {
    const { id, slug } = await submitted()
    const [d, e] = [await draftOf(id), await eventOf(slug)]
    expect(e.lifecycleStatus).toBe('pending_review')
    expect(typeof e.reviewCycleId).toBe('string')
    expect(d.reviewCycleId).toBe(e.reviewCycleId)
    const hist = await history(slug)
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ action: 'submit', actorRole: 'organizer', actorUid: ORG, cycleId: e.reviewCycleId, fromStatus: 'draft', toStatus: 'pending_review' })
  }, T)

  // RD-REVIEW-03 — returned for changes: Action Required (not Drafts) at once, the Super Admin's EXACT words
  // in the list and the editor, then a resubmission back to review with the history kept — for several types.
  it('RD-REVIEW-03 · changes requested → Action Required immediately with the exact comment → editor → resubmit, for every type', async () => {
    const { GET: listEvents } = await import('@/app/api/organizer/events/route')
    const list = async (tab: string) => {
      asOrg()
      const r = await json(await listEvents(new NextRequest(`http://localhost/api/organizer/events?tab=${tab}&limit=50`, { headers: { Authorization: 'Bearer t' } })))
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return (r.body.events as Json[])
    }
    for (const type of ['sports', 'conference', 'exhibition', 'workshop', 'fundraising', 'custom']) {
      const { id, slug } = await submitted(type)
      const comment = `Change the ${type} venue map: add gate numbers ${P}-${type}.`   // exactly what the Super Admin types
      await requestChanges(slug, comment)

      // A — Action Required straight away (first deadline window), never Drafts
      const ar = (await list('action_required')).find(e => e.draftId === id)
      expect(ar, `${type} under Action Required`).toBeTruthy()
      expect(ar).toMatchObject({ lifecycleStatus: 'changes_requested', changesComment: comment, reviewDeadline: { phase: 'changes_requested' } })
      expect((await list('drafts')).some(e => e.draftId === id), `${type} not under Drafts`).toBe(false)
      expect((await list('active')).some(e => e.draftId === id), `${type} not under Active`).toBe(false)

      // B — the exact words persist on the documents the organizer screens read (and survive a re-read)
      expect((await draftOf(id)).changesComment).toBe(comment)
      expect((await eventOf(slug)).changesComment).toBe(comment)
      asOrg()
      const ed = await json(await getDraft(getReq(), p('draftId', id)))
      expect(ed.status).toBe(200)
      expect((ed.body.draft as Json)).toMatchObject({ lifecycleStatus: 'changes_requested', changesComment: comment })

      // C — the organizer edits and resubmits through the review workflow
      asOrg()
      const ed0 = (await draftOf(id)).eventDetails as Json
      const edited = { ...ed0, info: { ...(ed0.info as Json), tagline: `Updated for review ${type}` } }
      const save = await json(await saveDraft(req({ eventDetails: edited }), p('draftId', id)))
      expect(save.status, JSON.stringify(save.body)).toBe(200)
      const rs = await doResubmit(id)
      expect(rs.status, JSON.stringify(rs.body)).toBe(200)
      expect(await eventOf(slug)).toMatchObject({ lifecycleStatus: 'pending_review', reviewStatus: null, changesComment: null })
      expect((await list('active')).some(e => e.draftId === id), `${type} back under Active (in review)`).toBe(true)
      expect((await list('action_required')).some(e => e.draftId === id)).toBe(false)
      // the review history keeps the request and its words
      const hist = await history(slug)
      expect(hist.map(e => e.action)).toEqual(['submit', 'request_changes', 'resubmit'])
      expect(hist[1]).toMatchObject({ actorRole: 'admin', comment })
    }
  }, T)

  it('2/3/6/8/26 · request changes → first deadline (only on commit) → resubmit (new cycle, no new charge) → approve publishes it', async () => {
    for (const type of ['sports', 'conference'] as const) {
      const { id, slug } = await submitted(type)
      const cycle1 = await cycleOf(slug)
      const ordersBefore = (await db.collection('licenseOrders').where('eventId', '==', id).get()).size
      const licBefore = (await db.doc(`eventLicenses/${slug}`).get()).data()
      const t0 = Date.now()
      await requestChanges(slug)
      const e1 = await eventOf(slug)
      const dl = e1.reviewDeadline as Json
      expect(e1.lifecycleStatus).toBe('changes_requested')
      expect(dl).toMatchObject({ cycleId: cycle1, phase: 'changes_requested' })
      const req0 = (dl.changesRequestedAt as FirebaseFirestore.Timestamp).toMillis()
      expect(req0).toBeGreaterThanOrEqual(t0 - 5_000)
      expect((dl.changesDueAt as FirebaseFirestore.Timestamp).toMillis() - req0).toBe(24 * HOUR)
      expect((e1.reviewDeadlineNextAt as FirebaseFirestore.Timestamp).toMillis()).toBe(req0 + 12 * HOUR)
      expect((await draftOf(id)).reviewDeadline).toEqual(dl)
      expect(await audits(slug, 'event.changes_requested')).toHaveLength(1)

      const rs = await doResubmit(id)
      expect(rs.status, JSON.stringify(rs.body)).toBe(200)
      const e2 = await eventOf(slug)
      expect(e2.lifecycleStatus).toBe('pending_review')
      expect(e2.reviewCycleId).not.toBe(cycle1)
      expect(rs.body.reviewCycleId).toBe(e2.reviewCycleId)
      expect(e2.reviewDeadline).toBeUndefined()
      expect(e2.reviewDeadlineNextAt).toBeNull()
      expect((await db.collection('licenseOrders').where('eventId', '==', id).get()).size).toBe(ordersBefore)
      expect((await db.doc(`eventLicenses/${slug}`).get()).data()).toEqual(licBefore)

      const ap = await decide(slug, { action: 'approve', reviewCycleId: e2.reviewCycleId })
      expect(ap.status, JSON.stringify(ap.body)).toBe(200)
      expect((await eventOf(slug)).lifecycleStatus).toBe('published')
      expect((await history(slug)).map(x => x.action)).toEqual(['submit', 'request_changes', 'resubmit', 'approve'])
      expect(await audits(slug, 'event.approved')).toHaveLength(1)
    }
  }, T)

  it('4/5 · a decision made on an older cycle, or with no cycle at all, is refused and changes nothing', async () => {
    const { id, slug } = await submitted()
    const old = await cycleOf(slug)
    await requestChanges(slug)
    expect((await doResubmit(id)).status).toBe(200)
    const stale = await decide(slug, { action: 'approve', reviewCycleId: old })
    expect(stale).toMatchObject({ status: 409, body: { code: 'REVIEW_CYCLE_STALE' } })
    const staleCr = await decide(slug, { action: 'request_changes', comment: 'old view', reviewCycleId: old })
    expect(staleCr.body.code).toBe('REVIEW_CYCLE_STALE')
    const none = await decide(slug, { action: 'approve' })
    expect(none).toMatchObject({ status: 400, body: { code: 'REVIEW_CYCLE_REQUIRED' } })
    expect((await eventOf(slug)).lifecycleStatus).toBe('pending_review')
    expect((await history(slug)).filter(x => x.action === 'approve')).toHaveLength(0)
    expect(await audits(slug, 'event.approved')).toHaveLength(0)
  }, T)

  it('6 · if the change request cannot commit (audit write fails), no deadline exists', async () => {
    const { slug } = await submitted()
    const real = Transaction.prototype.create
    vi.spyOn(Transaction.prototype, 'create').mockImplementation(function (this: InstanceType<typeof Transaction>, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
      if (ref.path.startsWith('adminAuditLogs/')) throw new Error('injected audit failure')
      return real.call(this, ref, data)
    } as never)
    const r = await decide(slug, { action: 'request_changes', comment: 'will not commit', reviewCycleId: await cycleOf(slug) }).catch(() => ({ status: 500, body: {} }))
    vi.restoreAllMocks()
    expect(r.status).toBeGreaterThanOrEqual(500)
    const e = await eventOf(slug)
    expect(e.lifecycleStatus).toBe('pending_review')
    expect(e.reviewDeadline).toBeUndefined()
    expect(e.reviewDeadlineNextAt ?? null).toBeNull()
  }, T)

  // ─── reminders, Action Required, scheduler idempotency ────────────────────────

  it('7/9/10/20/21 · reminders once each, then Action Required exactly once; repeated runs add nothing; no secret ⇒ 401', async () => {
    expect((await runCron('Bearer wrong')).status).toBe(401)
    expect((await runCron('')).status).toBe(401)
    const { id, slug } = await submitted()
    const cycle = await cycleOf(slug)
    await requestChanges(slug)
    const base = `review-dl_${cycle}_`
    await runCron()
    expect(await outboxIds(base)).toEqual([])                                   // nothing due yet

    await age(id, slug, 12 * HOUR)
    await runCron(); await runCron()
    expect(await outboxIds(base)).toEqual([`${base}reminder-h12`])
    await age(id, slug, 10 * HOUR)
    await runCron(); await runCron()
    expect((await outboxIds(base)).sort()).toEqual([`${base}reminder-h12`, `${base}reminder-h22`])

    await age(id, slug, 2 * HOUR)                                               // first deadline reached
    const before = Date.now()
    await runCron()
    const e = await eventOf(slug)
    const dl = e.reviewDeadline as Json
    expect(e.lifecycleStatus).toBe('changes_requested')                         // a PHASE, not a status
    expect(dl.phase).toBe('action_required')
    const arAt = (dl.actionRequiredAt as FirebaseFirestore.Timestamp).toMillis()
    expect(arAt).toBeGreaterThanOrEqual(before - 5_000)
    expect((dl.actionDueAt as FirebaseFirestore.Timestamp).toMillis() - arAt).toBe(24 * HOUR)
    expect(dl.changesDueAt).toBeDefined()                                       // first deadline kept
    await runCron(); await runCron()
    expect(((await eventOf(slug)).reviewDeadline as Json).actionRequiredAt).toEqual(dl.actionRequiredAt)
    expect((await outboxIds(base)).sort()).toEqual([`${base}action-required`, `${base}reminder-h12`, `${base}reminder-h22`])
    const hist = await history(slug)
    expect(hist.filter(x => x.action === 'review_reminder')).toHaveLength(2)
    expect(hist.filter(x => x.action === 'action_required')).toHaveLength(1)
    expect(hist.find(x => x.action === 'action_required')).toMatchObject({ actorRole: 'system', actorUid: null, cycleId: cycle })
    expect(await audits(slug, 'event.review_action_required')).toHaveLength(1)
    const inbox = (await db.collection(`users/${ORG}/notifications`).where('eventId', '==', id).get()).docs.map(d => d.data())
    expect(inbox.filter(n => n.type === 'event_review_deadline')).toHaveLength(3)
  }, T)

  it('11/12 · Action Required stays editable and a late resubmission (second window) is accepted', async () => {
    const { id, slug } = await submitted()
    await requestChanges(slug)
    await age(id, slug, 24 * HOUR)
    await runCron()
    expect(((await eventOf(slug)).reviewDeadline as Json).phase).toBe('action_required')
    asOrg()
    const d = await draftOf(id)
    const ed = { ...(d.eventDetails as Json), info: { ...((d.eventDetails as Json).info as Json), tagline: 'Fixed as requested' } }
    expect((await saveDraft(req({ eventDetails: ed }), p('draftId', id))).status).toBe(200)
    const rs = await doResubmit(id)
    expect(rs.status, JSON.stringify(rs.body)).toBe(200)
    const e = await eventOf(slug)
    expect(e.lifecycleStatus).toBe('pending_review')
    expect(((e.eventDetails as Json).info as Json).tagline).toBe('Fixed as requested')    // the reviewed copy is the new one
    expect(e.reviewDeadline).toBeUndefined()
  }, T)

  // ─── voluntary closure ───────────────────────────────────────────────────────

  it('13/14/15 · only the owner may close, only with confirmation; a repeat is a no-op; closure is recorded', async () => {
    const { id, slug } = await submitted()
    // not permitted while merely pending review
    expect((await doClose(id, { confirm: true, reviewCycleId: await cycleOf(slug) })).status).toBe(409)
    await requestChanges(slug)
    const cycle = await cycleOf(slug)
    expect((await doClose(id, { confirm: true, reviewCycleId: cycle }, MEMBER, ORG))).toMatchObject({ status: 403, body: { code: 'OWNER_ONLY' } })
    expect((await doClose(id, { reviewCycleId: cycle }))).toMatchObject({ status: 400, body: { code: 'CONFIRMATION_REQUIRED' } })
    expect((await doClose(id, { confirm: true, reviewCycleId: 'someone-elses-cycle' })).body.code).toBe('REVIEW_CYCLE_STALE')
    expect((await eventOf(slug)).lifecycleStatus).toBe('changes_requested')

    const ok = await doClose(id, { confirm: true, reviewCycleId: cycle, reason: 'Event postponed indefinitely' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const e = await eventOf(slug)
    expect(e.lifecycleStatus).toBe('cancelled')
    expect(e.reviewClosure).toMatchObject({ source: 'organizer', cycleId: cycle, closedBy: ORG, reason: 'Event postponed indefinitely' })
    expect(e.reviewStatus).toBeNull()                                            // no longer "asking for changes"
    expect(e.changesComment).toBe('Please add the venue landmark.')             // the request itself is kept
    expect((await draftOf(id)).reviewClosure).toMatchObject({ source: 'organizer' })
    expect(e.reviewDeadlineNextAt).toBeNull()
    expect((await doClose(id, { confirm: true, reviewCycleId: cycle }))).toMatchObject({ status: 200, body: { alreadyClosed: true } })
    expect((await history(slug)).filter(x => x.action === 'close_review')).toHaveLength(1)
    expect(await audits(slug, 'event.review_closed')).toHaveLength(1)
    expect(await outboxIds(`review-dl_${cycle}_closed-organizer`)).toHaveLength(1)
  }, T)

  // ─── automatic closure + financial and edit guarantees ─────────────────────────

  it('16/27/28/29 · the second deadline closes the event; nothing financial changes; it can no longer be edited, resubmitted, bought for or reopened', async () => {
    const { id, slug } = await submitted()
    // money and entitlement records that must survive untouched
    await db.doc(`organizerWallets/${ORG}`).set({ balancePaise: 12_345, currency: 'INR' })
    await db.doc(`eventServiceAllowances/${id}`).set({ organizerUid: ORG, whatsapp: { purchased: 500, consumed: 20, carriedIn: 0, carriedOut: 0, refunded: 0 } })
    const snap = async () => ({
      wallet: (await db.doc(`organizerWallets/${ORG}`).get()).data(),
      allowance: (await db.doc(`eventServiceAllowances/${id}`).get()).data(),
      licence: (await db.doc(`eventLicenses/${slug}`).get()).data(),
      orders: (await db.collection('licenseOrders').where('eventId', '==', id).get()).docs.map(d => [d.id, d.data()]),
      registrations: (await db.collection('registrations').where('eventSlug', '==', slug).get()).size,
      refunds: (await db.collection('walletServiceRequests').where('draftId', '==', id).get()).size,
      counter: (await db.doc(`registrationCounters/${slug}`).get()).data() ?? null,
    })
    const before = await snap()
    await requestChanges(slug)
    const cycle = await cycleOf(slug)
    await age(id, slug, 24 * HOUR); await runCron()                               // → Action Required
    await age(id, slug, 24 * HOUR)                                                // second deadline reached
    const c = await runCron()
    expect(c.body.outcomes).toMatchObject({ closed: 1 })
    const e = await eventOf(slug)
    expect(e.lifecycleStatus).toBe('cancelled')
    expect(e.reviewClosure).toMatchObject({ source: 'deadline_expired', cycleId: cycle, closedBy: null })
    expect(e.reviewStatus).toBeNull()
    expect((e.reviewDeadline as Json).phase).toBe('action_required')            // both windows kept as evidence
    expect((await history(slug)).find(x => x.action === 'expire_review')).toMatchObject({ actorRole: 'system', actorUid: null, cycleId: cycle })
    expect(await audits(slug, 'event.review_expired')).toHaveLength(1)
    expect(await outboxIds(`review-dl_${cycle}_closed-deadline_expired`)).toHaveLength(1)
    await runCron()
    expect((await history(slug)).filter(x => x.action === 'expire_review')).toHaveLength(1)
    expect(await snap()).toEqual(before)                                          // 27

    // 28 · no new purchase
    asOrg()
    const buy = await json(await purchase(req({ eventId: id, tier: 'free', capacity: 500, services: { whatsapp: 100 }, agreement: { accurateInformation: true, settlementFeePolicy: true, termsOfService: true, privacyPolicy: true } })))
    expect(buy).toMatchObject({ status: 409, body: { failureReason: 'already_licensed' } })   // refused before any order
    // 29 · no edit / resubmit / reopen through any ordinary organizer route
    const d = await draftOf(id)
    expect((await json(await saveDraft(req({ eventDetails: d.eventDetails }), p('draftId', id))))).toMatchObject({ status: 409, body: { code: 'REVIEW_CLOSED' } })
    expect((await editRoute(req({ tagline: 'sneaky' }), p('eventId', id))).status).toBe(409)
    expect((await doResubmit(id)).status).toBe(409)
    asOrg()
    expect((await archive(req({}), p('eventId', id))).status).toBe(200)          // archiving a closed event is allowed…
    const rest = await json(await restore(req({}), p('eventId', id)))
    expect(rest.status).toBe(409)                                                // …but it can never come back
    expect((await republish(req({}), p('eventId', id))).status).toBe(409)
    expect((await eventOf(slug)).reviewClosure).toMatchObject({ source: 'deadline_expired' })
  }, T)

  // ─── races ───────────────────────────────────────────────────────────────────

  it('17/18 · a closure decided for an old cycle cannot close the resubmitted event, nor overwrite a publication', async () => {
    const { id, slug } = await submitted()
    await requestChanges(slug)
    const old = await cycleOf(slug)
    expect((await doResubmit(id)).status).toBe(200)                              // resubmission won the race
    const late = await applyLifecycleTransition(ORG, id, 'expire_review', undefined, undefined, undefined, { expectedStatus: 'changes_requested', expectedCycleId: old })
    expect(late.success).toBe(false)
    expect((await eventOf(slug)).lifecycleStatus).toBe('pending_review')
    const ap = await decide(slug, { action: 'approve', reviewCycleId: await cycleOf(slug) })
    expect(ap.status).toBe(200)
    const afterApproval = await applyLifecycleTransition(ORG, id, 'expire_review', undefined, undefined, undefined, { expectedStatus: 'changes_requested', expectedCycleId: old })
    expect(afterApproval.success).toBe(false)
    // a stale scheduler pointer on a published event is cleared, never acted on
    await db.doc(`events/${slug}`).update({ reviewDeadlineNextAt: Timestamp.fromMillis(Date.now() - 1000) })
    await runCron()
    const e = await eventOf(slug)
    expect(e.lifecycleStatus).toBe('published')
    expect(e.reviewClosure).toBeUndefined()
    expect(e.reviewDeadlineNextAt).toBeNull()
  }, T)

  it('19 · a voluntary close racing a resubmission ends in exactly one valid state', async () => {
    for (let i = 0; i < 3; i++) {
      const { id, slug } = await submitted()
      await requestChanges(slug)
      const cycle = await cycleOf(slug)
      asOrg()
      const [a, b] = await Promise.all([
        closeReview(req({ confirm: true, reviewCycleId: cycle }), p('eventId', id)).then(json),
        resubmit(req({}), p('eventId', id)).then(json),
      ])
      const e = await eventOf(slug)
      const closed = e.lifecycleStatus === 'cancelled'
      expect([a.status === 200 && !a.body.alreadyClosed, b.status === 200].filter(Boolean)).toHaveLength(1)
      if (closed) { expect(e.reviewClosure).toMatchObject({ source: 'organizer' }); expect(b.status).toBe(409) }
      else { expect(e.lifecycleStatus).toBe('pending_review'); expect(e.reviewClosure).toBeUndefined(); expect(a.status).toBe(409) }
    }
  }, T)

  // ─── hardening: cancel loophole, edit race, add-on paid after closure ─────────

  it('H1 · an ordinary cancel cannot end a changes request (cancel and status routes); only Close Event can', async () => {
    const { id, slug } = await submitted()
    await requestChanges(slug)
    asOrg()
    const c1 = await json(await cancelRoute(req({ cancelReason: 'skip the deadline please' }), p('eventId', id)))
    expect(c1.status).toBe(409)
    const c2 = await json(await statusRoute(req({ action: 'cancel', cancelReason: 'skip the deadline please' }), p('eventId', id)))
    expect(c2.status).toBe(409)
    const e = await eventOf(slug)
    expect(e.lifecycleStatus).toBe('changes_requested')
    expect(e.cancelledAt).toBeUndefined()
    // …the same event can still be closed the recorded way, and then never restored
    expect((await doClose(id, { confirm: true, reviewCycleId: await cycleOf(slug) })).status).toBe(200)
    asOrg()
    expect((await archive(req({}), p('eventId', id))).status).toBe(200)
    expect((await restore(req({}), p('eventId', id))).status).toBe(409)
  }, T)

  it('H2 · a closure that commits between the edit route\'s first check and its write is still refused', async () => {
    const { id, slug } = await submitted()
    await requestChanges(slug)
    const cycle = await cycleOf(slug)
    const before = (((await draftOf(id)).eventDetails as Json).info as Json).tagline
    // Close the event at the worst moment: after the route's pre-check, just before its write.
    const real = db.runTransaction.bind(db)
    const spy = vi.spyOn(db, 'runTransaction').mockImplementationOnce((async (fn: never, o?: never) => {
      spy.mockRestore()
      const r = await applyLifecycleTransition(ORG, id, 'close_review', undefined, undefined, ORG, { expectedStatus: 'changes_requested', expectedCycleId: cycle })
      expect(r.success).toBe(true)
      return real(fn, o)
    }) as never)
    asOrg()
    const res = await json(await editRoute(req({ tagline: 'written after closure?' }), p('eventId', id)))
    expect(res.status).toBe(409)
    expect((((await draftOf(id)).eventDetails as Json).info as Json).tagline).toBe(before)
    expect((await eventOf(slug)).reviewClosure).toMatchObject({ source: 'organizer' })
  }, T)

  it('H3 · an add-on checkout paid after a review closure grants nothing; the payment is held for review, never refunded', async () => {
    const { id, slug } = await submitted()
    const { priceServiceItem } = await import('@/lib/licensing/serviceAllowances')
    const { activateAddonOrder, holdLicenceInactiveAddon, ADDON_EVENT_REVIEW_CLOSED } = await import('@/lib/licensing/draftCommerce')
    const item = priceServiceItem('whatsapp', 100, { unitPricePaise: 20, gstRatePercent: 18 } as never)
    const orderId = `add_${id}_rv2`
    await db.doc(`licenseOrders/${orderId}`).set({
      orderId, purpose: 'addon', status: 'created', eventId: id, organizerUid: ORG, tier: 'free', commercialModel: 'capacity',
      serviceItems: [item], capacityChange: null, amountPaise: item.totalPaise, razorpayAmountPaise: item.totalPaise,
      razorpayOrderId: 'order_rv2_addon', createdAt: new Date(), updatedAt: new Date(),
    })
    await db.doc(`eventServiceAllowances/${id}`).set({ organizerUid: ORG, pendingAddonOrderId: orderId, whatsapp: { purchased: 0, consumed: 0, carriedIn: 0, carriedOut: 0, refunded: 0 } })
    // the checkout was opened while the event was in review; the owner then closed it
    await requestChanges(slug)
    expect((await doClose(id, { confirm: true, reviewCycleId: await cycleOf(slug) })).status).toBe(200)

    const r = await activateAddonOrder({ orderId, razorpayOrderId: 'order_rv2_addon', razorpayPaymentId: 'pay_rv2_addon' })
    expect(r).toBe('licence_inactive')                                      // the existing refusal → callers hold it
    const o = (await db.doc(`licenseOrders/${orderId}`).get()).data()!
    expect(o).toMatchObject({ status: 'failed', failReason: 'licence_inactive', failDetail: ADDON_EVENT_REVIEW_CLOSED })
    const ledger = (await db.doc(`eventServiceAllowances/${id}`).get()).data()!
    expect(ledger.whatsapp.purchased).toBe(0)                               // nothing granted
    expect(ledger.pendingAddonOrderId).toBeNull()                          // the add-on slot is released
    expect(ledger.appliedOrders?.[orderId]).toBeUndefined()
    // a replay is the same refusal (the confirm route / webhook then complete the same hold)
    expect(await activateAddonOrder({ orderId, razorpayOrderId: 'order_rv2_addon', razorpayPaymentId: 'pay_rv2_addon' })).toBe('licence_inactive')
    const held = await holdLicenceInactiveAddon({ orderId, razorpayOrderId: 'order_rv2_addon', paymentId: 'pay_rv2_addon', amountPaise: item.totalPaise, eventId: id, organizerUid: ORG, detectedBy: 'confirm' })
    const hold = (await db.doc(`failedRefunds/${held.holdId}`).get()).data()!
    expect(hold).toMatchObject({ reason: 'lifecycle_ineligible', paymentId: 'pay_rv2_addon' })
    expect(JSON.stringify(hold)).not.toMatch(/"status":"(refunded|processed)"/)   // the stub would throw on any refund call
    await db.doc(`failedRefunds/${held.holdId}`).delete()
    await db.doc(`licenseOrders/${orderId}`).delete()
  }, T)

  // ─── access, privacy, legacy, notification failure ────────────────────────────

  it('22/23/24 · other organizers cannot act; non-admins cannot decide; private rejection notes never reach the organizer', async () => {
    const { id, slug } = await submitted()
    await requestChanges(slug)
    const cycle = await cycleOf(slug)
    expect((await doClose(id, { confirm: true, reviewCycleId: cycle }, OTHER, OTHER)).status).toBe(404)
    expect((await doResubmit(id, OTHER).catch(() => ({ status: 404 }))).status).toBeGreaterThanOrEqual(400)
    asOrg()
    expect((await review(req({ action: 'approve', reviewCycleId: cycle }), p('slug', slug))).status).toBe(401)

    expect((await doResubmit(id)).status).toBe(200)
    const rj = await decide(slug, { action: 'reject', reason: 'Venue not verifiable', category: 'content', notes: 'INTERNAL: organizer flagged before', reviewCycleId: await cycleOf(slug) })
    expect(rj.status).toBe(200)
    expect((await draftOf(id)).rejectionNotes ?? null).toBeNull()
    expect((await eventOf(slug)).rejectionNotes ?? null).toBeNull()
    asOrg()
    const g = await json(await getDraft(getReq(), p('draftId', id)))
    expect(JSON.stringify(g.body)).not.toContain('INTERNAL: organizer flagged before')
    expect((g.body.draft as Json).rejectionReason).toBe('Venue not verifiable')
    expect((await history(slug)).find(x => x.action === 'reject')).toMatchObject({ notes: 'INTERNAL: organizer flagged before' })   // admin-only store
  }, T)

  it('25 · events from before review cycles keep working: a null-cycle decision, no deadline unless changes are requested again', async () => {
    const { id, slug } = await submitted()
    // simulate a pre-RD-REVIEW-02 document: no cycle on either copy, changes already requested
    const { FieldValue } = await import('firebase-admin/firestore')
    for (const ref of [db.doc(`users/${ORG}/eventDrafts/${id}`), db.doc(`events/${slug}`)]) {
      await ref.update({ reviewCycleId: FieldValue.delete(), reviewCycleStartedAt: FieldValue.delete(), lifecycleStatus: 'changes_requested', changesComment: 'legacy request' })
    }
    await runCron()
    expect((await eventOf(slug)).lifecycleStatus).toBe('changes_requested')     // never expired (D9)
    expect((await doResubmit(id)).status).toBe(200)                              // the legacy event resubmits…
    const cyc = await cycleOf(slug)
    expect(typeof cyc).toBe('string')                                            // …and now has a cycle
    // and a legacy pending event (no cycle) is decided with an explicit null
    await db.doc(`events/${slug}`).update({ reviewCycleId: FieldValue.delete() })
    await db.doc(`users/${ORG}/eventDrafts/${id}`).update({ reviewCycleId: FieldValue.delete() })
    const cr = await decide(slug, { action: 'request_changes', comment: 'again', reviewCycleId: null })
    expect(cr.status, JSON.stringify(cr.body)).toBe(200)
    const e = await eventOf(slug)
    expect(typeof e.reviewCycleId).toBe('string')                                // a cycle is opened for the deadline
    expect((e.reviewDeadline as Json).cycleId).toBe(e.reviewCycleId)
  }, T)

  it('30 · a failing email provider never undoes a lifecycle step; the notice stays retryable', async () => {
    const { id, slug } = await submitted()
    await requestChanges(slug)
    const cycle = await cycleOf(slug)
    await age(id, slug, 12 * HOUR)
    h.engineFails = true
    await runCron()
    const noticeId = `review-dl_${cycle}_reminder-h12`
    const outcome = await deliverOutboxMessage(noticeId)
    expect(['retry', 'failed']).toContain(outcome)
    const ob = (await db.doc(`notificationOutbox/${noticeId}`).get()).data()!
    expect(ob.status).not.toBe('sent')
    expect(((await eventOf(slug)).reviewDeadline as Json).remindersSent).toHaveProperty('h12')   // the step persisted
    h.engineFails = false
  }, T)
})
