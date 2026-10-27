// RD-NOTIFY-01 · the notification outbox, on REAL Firestore (private emulator). The email engine is
// stubbed (no provider is contacted); the Super Admin recipient resolver is stubbed to two addresses.
//
//   delivery  · sent once to every recipient; a provider failure is retried with backoff and never
//               re-sends to a recipient already reached; gives up (status failed + lastError) after
//               OUTBOX_MAX_ATTEMPTS; a live lease is never double-driven; the cron drain picks up
//               what is due; email switched off is retried, not dropped
//   staging   · the outbox doc and its in-app item commit WITH the caller's write, and not without it;
//               enqueue (webhook path) ignores a repeat
//   triggers  · event resubmission (lifecycle transaction) → Super Admin alert; a refused transition →
//               none · a wallet request decision → organizer inbox + email; a replay → no second notice
//               · a rejected request reaches only the organizer, never the admin feed

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const UID = `nob-org-${P}`

const h = vi.hoisted(() => ({
  sent: [] as { to: string; subject: string; html: string }[],
  failFor: new Set<string>(), available: true, admins: ['admin1@rd.test', 'ops@rd.test'],
}))
vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      ...real.notificationEngine,
      isAvailable: () => h.available,
      send: async (_t: unknown, p: { to: string; subject: string; html: string }) => {
        if (h.failFor.has(p.to)) return { success: false, error: 'provider down' }
        h.sent.push({ to: p.to, subject: p.subject, html: p.html })
        return { success: true, messageId: `m-${h.sent.length}` }
      },
    },
  }
})
vi.mock('@/lib/notifications/superAdminRecipients', () => ({ superAdminRecipients: async () => [...h.admins] }))

describeEmu('RD-NOTIFY-01 · notification outbox (real Firestore)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let ob: typeof import('@/lib/notifications/outbox')
  let alerts: typeof import('@/lib/notifications/actionAlerts')
  const cleanup = new Set<string>()
  let n = 0

  const msg = (over: Partial<import('@/lib/notifications/outbox').OutboxMessageInput> = {}) => ({
    id: `nob-${P}-${++n}`, audience: { kind: 'super_admins' as const }, adminKind: 'event_review' as const,
    subject: 'Subject <b>x</b>', heading: 'Heading', intro: 'Intro', facts: [{ label: 'Event', value: 'Run & Ride' }],
    path: '/admin/events/x', ctaLabel: 'Open', ...over,
  })
  const outbox = async (id: string) => (await db.doc(`notificationOutbox/${id}`).get()).data() as Record<string, unknown> | undefined
  const track = (id: string) => { cleanup.add(`notificationOutbox/${id}`); cleanup.add(`adminNotifications/${id}`) }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ob = await import('@/lib/notifications/outbox')
    alerts = await import('@/lib/notifications/actionAlerts')
    await db.doc(`users/${UID}`).set({ uid: UID, name: 'Org One', email: 'org1@rd.test', role: 'organizer' })
  }, T)
  beforeEach(() => { h.sent = []; h.failFor = new Set(); h.available = true })
  afterAll(async () => {
    for (const p of cleanup) await db.recursiveDelete(db.doc(p)).catch(() => null)
    await db.recursiveDelete(db.doc(`users/${UID}`)).catch(() => null)
  }, T)

  // ── delivery ────────────────────────────────────────────────────────────────
  it('staged with the caller\'s write: outbox + admin feed item; delivered once to every Super Admin; escaped', async () => {
    const m = msg(); track(m.id)
    const b = db.batch(); b.set(db.doc(`users/${UID}/scratch/a${n}`), { x: 1 }); ob.stageOutboxMessage(b, m); await b.commit()
    cleanup.add(`users/${UID}/scratch/a${n}`)
    expect(await outbox(m.id)).toMatchObject({ status: 'pending', attempts: 0 })
    expect((await db.doc(`adminNotifications/${m.id}`).get()).data()).toMatchObject({ kind: 'event_review', title: 'Subject <b>x</b>', href: '/admin/events/x', readBy: {} })

    expect(await ob.deliverOutboxMessage(m.id)).toBe('sent')
    expect(h.sent.map(s => s.to).sort()).toEqual(['admin1@rd.test', 'ops@rd.test'])
    expect(h.sent[0].html).toContain('Run &amp; Ride')
    expect(h.sent[0].html).not.toContain('<b>x</b>')
    expect(await outbox(m.id)).toMatchObject({ status: 'sent', lastError: null })
    expect((await outbox(m.id))?.nextAttemptAt).toBeUndefined()

    h.sent = []
    expect(await ob.deliverOutboxMessage(m.id)).toBe('done')           // never re-sent
    expect(h.sent).toEqual([])
  }, T)

  it('nothing is staged when the caller\'s write fails', async () => {
    const m = msg(); track(m.id)
    await expect(db.runTransaction(async tx => { ob.stageOutboxMessage(tx, m); throw new Error('caller refused') })).rejects.toThrow('caller refused')
    expect(await outbox(m.id)).toBeUndefined()
    expect((await db.doc(`adminNotifications/${m.id}`).get()).exists).toBe(false)
  }, T)

  it('a partial failure retries ONLY the unreached recipient, with backoff; then succeeds', async () => {
    const m = msg(); track(m.id)
    expect(await ob.enqueueOutboxMessage(m)).toBe('queued')
    h.failFor.add('ops@rd.test')
    const t0 = Date.now()
    expect(await ob.deliverOutboxMessage(m.id, t0)).toBe('retry')
    const d = await outbox(m.id) as { status: string; attempts: number; lastError: string; nextAttemptAt: { toMillis(): number }; delivered: Record<string, boolean> }
    expect(d).toMatchObject({ status: 'pending', attempts: 1 })
    expect(d.lastError).toContain('ops@rd.test')
    expect(d.nextAttemptAt.toMillis()).toBeGreaterThanOrEqual(t0 + 60_000)
    expect(Object.keys(d.delivered)).toEqual([ob.recipientKey('admin1@rd.test')])

    h.failFor.clear(); h.sent = []
    expect(await ob.deliverOutboxMessage(m.id)).toBe('sent')
    expect(h.sent.map(s => s.to)).toEqual(['ops@rd.test'])            // admin1 is NOT emailed twice
  }, T)

  it('gives up after OUTBOX_MAX_ATTEMPTS: status failed + lastError (observable, not dropped)', async () => {
    const m = msg(); track(m.id)
    await ob.enqueueOutboxMessage(m)
    h.failFor = new Set(h.admins)
    let last = ''
    for (let i = 0; i < ob.OUTBOX_MAX_ATTEMPTS; i++) last = await ob.deliverOutboxMessage(m.id)
    expect(last).toBe('failed')
    const d = await outbox(m.id) as Record<string, unknown>
    expect(d).toMatchObject({ status: 'failed', attempts: ob.OUTBOX_MAX_ATTEMPTS })
    expect(String(d.lastError)).toContain('provider down')
    expect(d.nextAttemptAt).toBeUndefined()                            // no longer picked up by the drain
  }, T)

  it('a live lease is never double-driven; email switched off is retried, not dropped; enqueue ignores a repeat', async () => {
    const m = msg(); track(m.id)
    await ob.enqueueOutboxMessage(m)
    expect(await ob.enqueueOutboxMessage(m)).toBe('duplicate')
    await db.doc(`notificationOutbox/${m.id}`).update({ status: 'sending', leaseUntil: new Date(Date.now() + 60_000) })
    expect(await ob.deliverOutboxMessage(m.id)).toBe('busy')
    await db.doc(`notificationOutbox/${m.id}`).update({ status: 'pending', leaseUntil: null })
    h.available = false
    expect(await ob.deliverOutboxMessage(m.id)).toBe('retry')
    expect(await outbox(m.id)).toMatchObject({ status: 'pending', lastError: 'email channel disabled' })
    expect(h.sent).toEqual([])
  }, T)

  it('the cron drain delivers what is due and leaves what is not', async () => {
    const due = msg(); const later = msg(); track(due.id); track(later.id)
    await ob.enqueueOutboxMessage(due); await ob.enqueueOutboxMessage(later)
    await db.doc(`notificationOutbox/${later.id}`).update({ nextAttemptAt: new Date(Date.now() + 3_600_000) })
    await ob.drainOutbox(200)
    expect(await outbox(due.id)).toMatchObject({ status: 'sent' })
    expect(await outbox(later.id)).toMatchObject({ status: 'pending' })
  }, T)

  // ── triggers ────────────────────────────────────────────────────────────────
  it('an event resubmission alerts the Super Admins (staged in the lifecycle transaction); a refused transition alerts nobody', async () => {
    const { applyLifecycleTransition } = await import('@/lib/events/lifecycle')
    const d = `nob-ev-${P}`
    cleanup.add(`users/${UID}/eventDrafts/${d}`)
    await db.doc(`users/${UID}/eventDrafts/${d}`).set({ status: 'changes_requested', lifecycleStatus: 'changes_requested', reviewStatus: 'changes_requested', eventDetails: { info: { name: 'City Run' } } })
    const before = (await db.collection('notificationOutbox').where('audience.kind', '==', 'super_admins').get()).docs.map(x => x.id)

    expect(await applyLifecycleTransition(UID, d, 'resubmit')).toMatchObject({ success: true, lifecycleStatus: 'pending_review' })
    const created = (await db.collection('notificationOutbox').where('audience.kind', '==', 'super_admins').get()).docs.filter(x => !before.includes(x.id))
    expect(created).toHaveLength(1)
    track(created[0].id)
    expect(created[0].id).toMatch(new RegExp(`^evt-review_resubmitted_${d}_\\d+$`))
    expect(created[0].data()).toMatchObject({ subject: 'Event resubmitted for review: City Run' })
    expect((created[0].data().facts as { label: string; value: string }[])).toContainEqual({ label: 'Organizer', value: 'Org One <org1@rd.test>' })
    expect((await db.doc(`adminNotifications/${created[0].id}`).get()).exists).toBe(true)

    // pending_review → resubmit again is not a valid transition: nothing staged
    expect((await applyLifecycleTransition(UID, d, 'resubmit')).success).toBe(false)
    const after = (await db.collection('notificationOutbox').where('audience.kind', '==', 'super_admins').get()).docs.filter(x => !before.includes(x.id))
    expect(after).toHaveLength(1)
  }, T)

  it('a wallet request decision notifies the ORGANIZER (inbox + email) once; never the admin feed; a replay adds nothing', async () => {
    const { decideServiceRequest } = await import('@/lib/wallet/serviceRequests')
    const rid = `nobReq${P}`
    cleanup.add(`walletServiceRequests/${rid}`)
    await db.doc(`walletServiceRequests/${rid}`).set({
      kind: 'refund', status: 'submitted', organizerUid: UID, submittedBy: UID, service: 'whatsapp', quantity: 120,
      sourceDraftId: `nob-d-${P}`, sourceName: 'City Run', sourceSlug: null, destinationDraftId: null, destinationName: null,
      groupId: null, refundUpperBoundPaise: 2400, valuation: [], approvedAmountPaise: null, externalReference: null,
      organizerNote: 'unused', history: [], createdAt: new Date(), updatedAt: new Date(),
    })
    const r1 = await decideServiceRequest({ adminUid: `nob-admin-${P}`, id: rid, action: 'reject', reason: 'Window closed for this event' })
    expect(r1.already).toBe(false)
    const id = `svc-req_${rid}_rejected`
    cleanup.add(`notificationOutbox/${id}`); cleanup.add(`users/${UID}/notifications/${id}`)
    expect(await outbox(id)).toMatchObject({ audience: { kind: 'organizer', organizerUid: UID }, subject: 'Your refund request was not approved — City Run' })
    expect((await db.doc(`users/${UID}/notifications/${id}`).get()).data()).toMatchObject({ category: 'wallet', read: false, link: `/dashboard/wallet?eventId=nob-d-${P}` })
    expect((await db.doc(`adminNotifications/${id}`).get()).exists).toBe(false)

    // The decision already scheduled delivery itself (outside a request scope it runs immediately);
    // wait for THAT delivery — calling deliver again here would rightly be refused by the lease.
    for (let i = 0; i < 50 && (await outbox(id))?.status !== 'sent'; i++) await new Promise(r => setTimeout(r, 100))
    expect(await outbox(id)).toMatchObject({ status: 'sent' })
    // Scoped to THIS message: the previous test's background delivery may still be finishing.
    const mine = () => h.sent.filter(s => s.subject === 'Your refund request was not approved — City Run')
    expect(mine().map(s => s.to)).toEqual(['org1@rd.test'])
    expect(await ob.deliverOutboxMessage(id)).toBe('done')                     // and never twice
    expect(mine()).toHaveLength(1)
    expect(mine()[0].html).toContain('Window closed for this event')        // a rejection explains itself

    const r2 = await decideServiceRequest({ adminUid: `nob-admin-${P}`, id: rid, action: 'reject', reason: 'again' })
    expect(r2.already).toBe(true)
    expect((await db.collection(`users/${UID}/notifications`).where('type', '==', 'service_request_rejected').get()).size).toBe(1)
  }, T)

  it('builders never put payout values in content; ids are unique per occurrence', () => {
    const a = alerts.payoutProfileAlert({ historyId: 'h1', created: false, wasVerified: true, changedFields: ['accountNumber', 'ifscCode'], organizer: { uid: 'u1', name: 'Org', email: 'o@x.test' }, when: 'now' })
    const text = JSON.stringify(a)
    expect(text).toContain('accountNumber')                                   // field NAME only
    expect(text).not.toMatch(/\d{9,}/)                                         // no account-number-like value
    expect(a.subject).toBe('Verified payout profile changed: Org')
    expect(alerts.eventReviewAlert({ submission: 'submitted', draftId: 'd', slug: 's', eventName: 'E', organizer: { uid: 'u', name: '', email: '' }, at: new Date(1), when: 'w' }).id)
      .not.toBe(alerts.eventReviewAlert({ submission: 'submitted', draftId: 'd', slug: 's', eventName: 'E', organizer: { uid: 'u', name: '', email: '' }, at: new Date(2), when: 'w' }).id)
  })
})
