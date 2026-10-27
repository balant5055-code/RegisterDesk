// RD-FEATURE-REQ-01 · notification audit — Feature Requests on REAL Firestore + Auth (emulators),
// through the REAL outbox and the REAL recipient resolvers. Only the email engine is stubbed: no
// provider is ever contacted, and every "send" is recorded here with the outcome the test chose.
//
//   recipients · a new request reaches the support inbox + every ACTIVE ADMIN_UIDS account — never a
//                disabled one, never a claim-only "admin"; the organizer notice reaches the
//                workspace owner's address
//   queue      · new request → Super Admin feed + outbox; status change / response → organizer inbox
//                + outbox; internal notes, priority, rollout and duplicate links never notify and
//                never appear in any notification
//   no dupes   · an unchanged save (NO_CHANGE) or a stale one (409) stages nothing; a delivered
//                message is never re-sent by a later drain
//   delivery   · a definite failure is retried (backoff) for the unreached recipient only, then sent;
//                gives up → 'failed' + lastError; suppressed / no-definite-answer → 'unconfirmed',
//                never re-sent, never 'sent'; email unavailable → retried, not 'sent'

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/config/resolveBrandingConfig', async orig => ({
  ...(await orig<typeof import('@/lib/config/resolveBrandingConfig')>()),
  getBrandingConfig: async () => ({ supportEmail: 'Support@RD.test' }),
}))

type Outcome = 'ok' | 'fail' | 'suppressed' | 'unknown' | 'throw'
const h = vi.hoisted(() => ({
  sent: [] as { to: string; subject: string; html: string }[],
  attempts: [] as { to: string; subject: string }[],
  outcome: new Map<string, Outcome>(), available: true,
}))
vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      ...real.notificationEngine,
      isAvailable: () => h.available,
      send: async (_t: unknown, p: { to: string; subject: string; html: string }) => {
        h.attempts.push({ to: p.to, subject: p.subject })
        const o = h.outcome.get(p.to.toLowerCase()) ?? 'ok'
        if (o === 'throw') throw new Error('socket closed')
        if (o === 'fail') return { success: false, error: 'rejected by provider' }
        if (o === 'suppressed') return { success: false, suppressed: true, error: 'recipient suppressed' }
        if (o === 'unknown') return { success: false, deliveryUnknown: true, error: 'timeout' }
        h.sent.push({ to: p.to, subject: p.subject, html: p.html })
        return { success: true, messageId: `m-${h.sent.length}` }
      },
    },
  }
})

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `frn${process.pid}`
const ORG = `${P}-org`, ADMIN_A = `${P}-adm-a`, ADMIN_B = `${P}-adm-b`, ADMIN_OFF = `${P}-adm-off`, CLAIM = `${P}-claim`, TEAM = `${P}-team`
const mail = (uid: string) => `${uid}@rd.test`
const SECRET_NOTE = 'INTERNAL-ONLY: competitor X pays us for this, do not tell'
type Json = Record<string, unknown>

describeEmu('feature request notifications — recipients, queue, delivery, retries', () => {
  let db: import('firebase-admin/firestore').Firestore
  let auth: import('firebase-admin/auth').Auth
  let svc: typeof import('@/lib/featureRequests/service')
  let ob: typeof import('@/lib/notifications/outbox')
  let recipients: typeof import('@/lib/notifications/superAdminRecipients')
  let prevAdminUids: string | undefined
  const requestIds: string[] = []
  const DAY = 24 * 60 * 60_000

  const submit = async (title = 'Bulk-edit pass prices') => {
    const { id } = await svc.createFeatureRequest({
      workspaceUid: ORG, callerUid: TEAM,
      input: { title, problem: 'Changing many pass prices one by one takes far too long before launch.', proposal: 'Select several passes and set a new price once; saves an hour per event.', eventId: null, eventType: 'sports', organizerPriority: 'high' },
    })
    requestIds.push(id)
    return id
  }
  const outbox = async (id: string) => (await db.doc(`notificationOutbox/${id}`).get()).data() as Json | undefined
  /** Every organizer notice staged for ORG, oldest first (single-field equality: no index). */
  const orgNotices = async (requestId: string) => (await db.collection('notificationOutbox').where('audience.organizerUid', '==', ORG).get())
    .docs.filter(d => d.id.startsWith(`feature-request_${requestId}_`)).map(d => ({ id: d.id, ...d.data() as Json }))
  const allText = (o: Json) => JSON.stringify(o)
  // The drain sees EVERY due message in the emulator; assertions look only at this test's own mail.
  const sentFor = (title: string) => h.sent.filter(s => s.subject.includes(title)).map(s => s.to.toLowerCase()).sort()
  const triedFor = (title: string) => h.attempts.filter(a => a.subject.includes(title)).map(a => a.to.toLowerCase()).sort()

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db, adminAuth: auth } = await import('@/lib/firebase/admin'))
    svc = await import('@/lib/featureRequests/service')
    ob = await import('@/lib/notifications/outbox')
    recipients = await import('@/lib/notifications/superAdminRecipients')
    for (const uid of [ORG, ADMIN_A, ADMIN_B, ADMIN_OFF, CLAIM, TEAM]) {
      await auth.deleteUser(uid).catch(() => null)
      await auth.createUser({ uid, email: mail(uid), emailVerified: true, disabled: uid === ADMIN_OFF })
    }
    await auth.setCustomUserClaims(CLAIM, { admin: true, isAdmin: true, role: 'superadmin' })
    await db.doc(`users/${ORG}`).set({ uid: ORG, email: mail(ORG), name: 'Org Owner', organizationName: 'Dawn Runners', role: 'organizer', workspaceOwner: true })
    prevAdminUids = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = [ADMIN_A, ADMIN_B, ADMIN_OFF, `${P}-ghost`].join(',')
  }, T)

  beforeEach(() => { h.sent = []; h.attempts = []; h.outcome = new Map(); h.available = true })

  afterAll(async () => {
    if (prevAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = prevAdminUids
    for (const id of requestIds) {
      await db.recursiveDelete(db.doc(`featureRequests/${id}`)).catch(() => null)
      await db.doc(`adminNotifications/feature-request_${id}`).delete().catch(() => null)
      await db.doc(`notificationOutbox/feature-request_${id}`).delete().catch(() => null)
      for (const d of (await db.collection('adminAuditLogs').where('entityId', '==', id).get().catch(() => null))?.docs ?? []) await d.ref.delete()
    }
    for (const d of (await db.collection('notificationOutbox').where('audience.organizerUid', '==', ORG).get()).docs) await d.ref.delete()
    await db.recursiveDelete(db.doc(`users/${ORG}`)).catch(() => null)
    for (const d of (await db.collection('featureRequestQuota').where('workspaceUid', '==', ORG).get()).docs) await d.ref.delete()
    for (const uid of [ORG, ADMIN_A, ADMIN_B, ADMIN_OFF, CLAIM, TEAM]) await auth.deleteUser(uid).catch(() => null)
  }, T)

  it('recipient resolution: support inbox + every active ADMIN_UIDS account; never disabled, unknown or claim-only', async () => {
    const list = (await recipients.superAdminRecipients()).map(e => e.toLowerCase()).sort()
    expect(list).toEqual(['support@rd.test', mail(ADMIN_A), mail(ADMIN_B)].sort())
    expect(list).not.toContain(mail(ADMIN_OFF))
    expect(list).not.toContain(mail(CLAIM))
  }, T)

  it('a new request queues ONE Super Admin notice (feed + outbox) and emails every Super Admin once', async () => {
    const id = await submit('Bulk <b>edit</b> pass prices')
    const nid = `feature-request_${id}`
    const feed = (await db.doc(`adminNotifications/${nid}`).get()).data() as Json
    expect(feed).toMatchObject({ kind: 'feature_request', href: `/admin/feature-requests?id=${id}` })
    const o = await outbox(nid)
    expect(o).toMatchObject({ status: 'pending', attempts: 0, audience: { kind: 'super_admins' } })
    // the submitting team member is not an addressee — recipients are resolved at delivery time
    expect(allText(o!)).not.toContain(mail(TEAM))

    expect(await ob.deliverOutboxMessage(nid)).toBe('sent')
    expect(h.sent.map(s => s.to.toLowerCase()).sort()).toEqual(['support@rd.test', mail(ADMIN_A), mail(ADMIN_B)].sort())
    expect(h.sent[0].html).toContain('Bulk &lt;b&gt;edit&lt;/b&gt; pass prices')              // escaped
    expect(h.sent[0].html).toContain(`/admin/feature-requests?id=${id}`)
    const after = await outbox(nid)
    expect(after).toMatchObject({ status: 'sent', lastError: null })
    expect(Object.keys(after!.delivered as Json)).toHaveLength(3)
    expect(after!.nextAttemptAt).toBeUndefined()                                             // off the drain query

    // a later drain / a second driver never re-sends a delivered message
    expect(await ob.deliverOutboxMessage(nid)).toBe('done')
    await ob.drainOutbox(50, Date.now() + DAY)
    expect(sentFor('Bulk <b>edit</b>')).toHaveLength(3)
  }, T)

  it('status change + response → organizer inbox + email; internal notes, priority and rollout never leak; repeats add nothing', async () => {
    const id = await submit()
    await svc.adminAddNote({ id, adminUid: ADMIN_A, text: SECRET_NOTE })
    expect(await orgNotices(id)).toHaveLength(0)                                             // a note notifies nobody

    await svc.adminUpdateRequest({ id, adminUid: ADMIN_A, patch: { adminPriority: 'p0', rollout: { scope: 'event_types', eventSlugs: [], organizerUids: [], eventTypes: ['sports'], flagKey: null, enforced: false } } as never })
    expect(await orgNotices(id)).toHaveLength(0)                                             // internal-only change

    const res = await svc.adminUpdateRequest({ id, adminUid: ADMIN_A, patch: { status: 'under_review', expectedStatus: 'submitted', organizerResponse: 'Thanks — reviewing for the next release.' } as never })
    expect(res).toMatchObject({ status: 'under_review', notified: true })
    const [n] = await orgNotices(id)
    expect(n).toMatchObject({ status: 'pending', audience: { kind: 'organizer', organizerUid: ORG } })
    const inbox = (await db.doc(`users/${ORG}/notifications/${n.id}`).get()).data() as Json
    expect(inbox).toMatchObject({ category: 'system', type: 'feature_request_under_review', link: `/dashboard/feature-requests?id=${id}`, read: false })
    expect(String(inbox.body)).toContain('reviewing for the next release')

    expect(await ob.deliverOutboxMessage(n.id)).toBe('sent')
    expect(h.sent.map(s => s.to)).toEqual([mail(ORG)])                                       // the workspace owner only
    for (const text of [allText(n), allText(inbox), h.sent[0].html]) {
      expect(text).not.toContain('INTERNAL-ONLY')
      expect(text).not.toMatch(/p0|event_types|rollout|adminPriority/i)
    }

    // an identical save is refused and stages nothing; so is a stale one
    await expect(svc.adminUpdateRequest({ id, adminUid: ADMIN_A, patch: { status: 'under_review', organizerResponse: 'Thanks — reviewing for the next release.' } as never })).rejects.toMatchObject({ code: 'NO_CHANGE' })
    await expect(svc.adminUpdateRequest({ id, adminUid: ADMIN_B, patch: { status: 'planned', expectedStatus: 'submitted' } as never })).rejects.toMatchObject({ code: 'STALE' })
    expect(await orgNotices(id)).toHaveLength(1)
  }, T)

  it('a response edit with no status change notifies the organizer once; clearing it does not', async () => {
    const id = await submit()
    await svc.adminUpdateRequest({ id, adminUid: ADMIN_A, patch: { organizerResponse: 'We like this — more soon.' } as never })
    const list = await orgNotices(id)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ subject: expect.stringContaining('New reply'), intro: expect.stringContaining('updated its reply') })
    expect((await db.doc(`users/${ORG}/notifications/${list[0].id}`).get()).data()).toMatchObject({ type: 'feature_request_response' })
    await svc.adminUpdateRequest({ id, adminUid: ADMIN_A, patch: { organizerResponse: null } as never })
    expect(await orgNotices(id)).toHaveLength(1)
  }, T)

  it('a definite failure retries only the unreached recipient, with backoff, via the cron drain', async () => {
    const title = `Retry case ${P}`
    const id = await submit(title)
    const nid = `feature-request_${id}`
    h.outcome.set(mail(ADMIN_B), 'fail')
    const t0 = Date.now()
    expect(await ob.deliverOutboxMessage(nid, t0)).toBe('retry')
    let o = await outbox(nid)
    expect(o).toMatchObject({ status: 'pending', attempts: 1 })
    expect(String(o!.lastError)).toContain(`${mail(ADMIN_B)}: rejected by provider`)
    expect((o!.nextAttemptAt as { toMillis(): number }).toMillis()).toBe(t0 + 60_000)        // first backoff = 1 min
    expect(sentFor(title)).toEqual(['support@rd.test', mail(ADMIN_A)].sort())

    // not due yet: the drain leaves it alone
    h.sent = []; h.attempts = []
    await ob.drainOutbox(50, t0 + 30_000)
    expect(triedFor(title)).toEqual([])

    h.outcome.delete(mail(ADMIN_B))
    await ob.drainOutbox(50, t0 + 61_000)
    expect(sentFor(title)).toEqual([mail(ADMIN_B)])                                          // nobody reached twice
    o = await outbox(nid)
    expect(o).toMatchObject({ status: 'sent', lastError: null, attempts: 1 })
  }, T)

  it('a thrown send and a switched-off email channel are retried — never reported sent', async () => {
    const id = await submit()
    const nid = `feature-request_${id}`
    h.available = false
    expect(await ob.deliverOutboxMessage(nid)).toBe('retry')
    expect(await outbox(nid)).toMatchObject({ status: 'pending', lastError: 'email channel disabled' })
    h.available = true
    h.outcome.set('support@rd.test', 'throw')
    expect(await ob.deliverOutboxMessage(nid, Date.now() + DAY)).toBe('retry')
    const o = await outbox(nid)
    expect(o).toMatchObject({ status: 'pending', attempts: 2 })
    expect(String(o!.lastError)).toContain('socket closed')
  }, T)

  it('gives up after OUTBOX_MAX_ATTEMPTS: status failed + lastError, and the organizer notice is still in their inbox', async () => {
    const id = await submit()
    await svc.adminUpdateRequest({ id, adminUid: ADMIN_A, patch: { status: 'declined', organizerResponse: 'Out of scope for this year, sorry.' } as never })
    const [n] = await orgNotices(id)
    h.outcome.set(mail(ORG), 'fail')
    let outcome = ''
    for (let i = 0; i < ob.OUTBOX_MAX_ATTEMPTS; i++) outcome = await ob.deliverOutboxMessage(n.id, Date.now() + (i + 1) * DAY)
    expect(outcome).toBe('failed')
    const o = await outbox(n.id)
    expect(o).toMatchObject({ status: 'failed', attempts: ob.OUTBOX_MAX_ATTEMPTS })
    expect(String(o!.lastError)).toContain(mail(ORG))
    expect(o!.nextAttemptAt).toBeUndefined()
    expect((await db.doc(`users/${ORG}/notifications/${n.id}`).get()).exists).toBe(true)
    expect(h.sent).toHaveLength(0)
    expect(await ob.deliverOutboxMessage(n.id, Date.now() + 30 * DAY)).toBe('done')
  }, T)

  it('suppressed or no-definite-answer recipients end "unconfirmed": never re-sent, never reported sent', async () => {
    const title = `Unconfirmed case ${P}`
    const id = await submit(title)
    const nid = `feature-request_${id}`
    h.outcome.set(mail(ADMIN_A), 'suppressed')
    h.outcome.set(mail(ADMIN_B), 'unknown')
    expect(await ob.deliverOutboxMessage(nid)).toBe('unconfirmed')
    const o = await outbox(nid)
    expect(o!.status).toBe('unconfirmed')
    expect(Object.keys(o!.delivered as Json)).toEqual([ob.recipientKey('support@rd.test')])
    expect(o!.skipped).toEqual({ [ob.recipientKey(mail(ADMIN_A))]: 'suppressed', [ob.recipientKey(mail(ADMIN_B))]: 'unconfirmed' })
    expect(String(o!.lastError)).toMatch(/suppressed.*\|.*no definite answer|no definite answer.*\|.*suppressed/)
    expect(o!.nextAttemptAt).toBeUndefined()

    h.outcome.clear(); h.attempts = []
    await ob.drainOutbox(50, Date.now() + DAY)
    expect(await ob.deliverOutboxMessage(nid, Date.now() + DAY)).toBe('done')
    expect(triedFor(title)).toEqual([])
  }, T)

  it('a no-answer recipient alongside a failing one: the failure is retried, the no-answer is not re-sent', async () => {
    const id = await submit()
    const nid = `feature-request_${id}`
    h.outcome.set(mail(ADMIN_A), 'unknown')
    h.outcome.set(mail(ADMIN_B), 'fail')
    const t0 = Date.now()
    expect(await ob.deliverOutboxMessage(nid, t0)).toBe('retry')
    h.outcome.clear(); h.attempts = []
    expect(await ob.deliverOutboxMessage(nid, t0 + 61_000)).toBe('unconfirmed')
    expect(h.attempts.map(a => a.to)).toEqual([mail(ADMIN_B)])
    expect((await outbox(nid))!.status).toBe('unconfirmed')
  }, T)
})
