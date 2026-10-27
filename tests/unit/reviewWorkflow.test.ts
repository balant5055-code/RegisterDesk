// RD-REVIEW-01 — the Super Admin ↔ organizer review cycle: history, attribution, notifications.
//
// Behaviour is tested on the pure pieces (history entry, revised sections, the email, the
// organizer notification); the wiring that needs Firestore (the transaction, the routes) is
// pinned on comment-stripped source here and exercised for real in
// tests/emulator/reviewWorkflow.emu.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

// ─── History entries ───────────────────────────────────────────────────────────

describe('review history entry', () => {
  it('records only the review transitions', async () => {
    const { isReviewHistoryAction } = await import('@/lib/events/reviewHistory')
    for (const a of ['approve', 'reject', 'request_changes', 'resubmit', 'republish'] as const) {
      expect(isReviewHistoryAction(a), a).toBe(true)
    }
    for (const a of ['archive', 'restore', 'cancel', 'complete', 'unpublish', 'close_registrations'] as const) {
      expect(isReviewHistoryAction(a), a).toBe(false)
    }
  })

  it('attributes admin decisions to the admin and resubmissions to the organizer', async () => {
    const { buildReviewHistoryEntry } = await import('@/lib/events/reviewHistory')
    const changes = buildReviewHistoryEntry({ action: 'request_changes', fromStatus: 'pending_review', toStatus: 'changes_requested', actorUid: 'admin-1', comment: '  Add a venue map  ' })
    expect(changes).toMatchObject({ actorRole: 'admin', actorUid: 'admin-1', comment: 'Add a venue map', reason: null, notes: null })
    const resub = buildReviewHistoryEntry({ action: 'resubmit', fromStatus: 'changes_requested', toStatus: 'pending_review', actorUid: 'member-7', changedFields: ['venueName'], revisedSections: ['eventDetails.venue'] })
    expect(resub).toMatchObject({ actorRole: 'organizer', actorUid: 'member-7', comment: null, changedFields: ['venueName'], revisedSections: ['eventDetails.venue'] })
  })

  it('keeps each field to the action it belongs to — notes only on a rejection', async () => {
    const { buildReviewHistoryEntry } = await import('@/lib/events/reviewHistory')
    const reject = buildReviewHistoryEntry({ action: 'reject', fromStatus: 'pending_review', toStatus: 'draft', actorUid: 'a', reason: 'Policy', category: 'Other', notes: 'internal', comment: 'stray' })
    expect(reject).toMatchObject({ reason: 'Policy', category: 'Other', notes: 'internal', comment: null, changedFields: [], revisedSections: [] })
    const approve = buildReviewHistoryEntry({ action: 'approve', fromStatus: 'pending_review', toStatus: 'published', actorUid: 'a', notes: 'x', changedFields: ['startDate'] })
    expect(approve).toMatchObject({ notes: null, reason: null, changedFields: [], revisedSections: [] })
  })

  it('stores an unnamed admin as null, never as someone else', async () => {
    const { buildReviewHistoryEntry } = await import('@/lib/events/reviewHistory')
    expect(buildReviewHistoryEntry({ action: 'approve', fromStatus: 'pending_review', toStatus: 'published', actorUid: null }).actorUid).toBeNull()
  })

  it('reads back defensively and finds the latest request', async () => {
    const { toReviewHistoryItem, latestReviewRequest } = await import('@/lib/events/reviewHistory')
    const at = { toDate: () => new Date('2026-10-20T10:00:00Z') }
    const items = [
      toReviewHistoryItem('3', { action: 'resubmit', actorRole: 'organizer', actorUid: 'o', at, changedFields: ['x', 3] }),
      toReviewHistoryItem('2', { action: 'request_changes', actorRole: 'admin', comment: 'Fix banner', at }),
      toReviewHistoryItem('1', { action: 'reject', actorRole: 'admin', reason: 'Old', at }),
    ]
    expect(items[0]).toMatchObject({ at: '2026-10-20T10:00:00.000Z', changedFields: ['x'], revisedSections: [], comment: null })
    expect(latestReviewRequest(items)?.id).toBe('2')
    expect(toReviewHistoryItem('z', { actorRole: 'hacker' }).actorRole).toBeNull()
  })
})

// ─── What a resubmission revised ──────────────────────────────────────────────

describe('revisedSections', () => {
  it('reports each changed eventDetails section and other content field', async () => {
    const { revisedSections } = await import('@/lib/events/reviewHistory')
    const before = {
      eventDetails: { info: { name: 'A', desc: 'old' }, schedule: { startDate: '2027-01-01' }, media: { a: 1 } },
      pricing: { passes: [{ id: 'p1', price: 0 }] },
      registrationForm: { fields: [] },
      accessControl: null,
    }
    const update = {
      eventDetails: { info: { desc: 'new', name: 'A' }, schedule: { startDate: '2027-01-01' } },
      pricing: { passes: [{ price: 0, id: 'p1' }] },
      registrationForm: { fields: [{ id: 'f' }] },
      accessControl: null,
    }
    // key order is not a change; a removed section is
    expect(revisedSections(before, update)).toEqual(['eventDetails.info', 'eventDetails.media', 'registrationForm'])
  })

  it('is empty when nothing changed', async () => {
    const { revisedSections } = await import('@/lib/events/reviewHistory')
    const doc = { eventDetails: { info: { name: 'A' } }, pricing: null }
    expect(revisedSections(doc, { eventDetails: { info: { name: 'A' } }, pricing: null })).toEqual([])
  })
})

// ─── The review email ──────────────────────────────────────────────────────────

describe('review email', () => {
  it('links the organizer to the event when a URL is given', async () => {
    const { renderReviewEmail } = await import('@/lib/notifications/templates/review')
    const html = renderReviewEmail('changes_requested', { to: 'o@x.test', eventName: 'Run', comment: 'Fix <b>map</b>', eventUrl: 'https://app.test/dashboard/events/d1?tab=setup' }).html
    expect(html).toContain('href="https://app.test/dashboard/events/d1?tab=setup"')
    expect(html).toContain('Edit and resubmit')
    expect(html).toContain('Fix &lt;b&gt;map&lt;/b&gt;')
  })

  it('is unchanged when no URL is given', async () => {
    const { renderReviewEmail } = await import('@/lib/notifications/templates/review')
    const { emailShell } = await import('@/lib/email/templates/base')
    const out = renderReviewEmail('approved', { to: 'o@x.test', eventName: 'Run' })
    expect(out.html).toBe(emailShell(out.subject, '<p>Good news — <strong>Run</strong> has been <strong>approved</strong> and is now live and accepting registrations.</p>'))
  })
})

// ─── Organizer notification: recipient, link, dedupe ─────────────────────────────

describe('organizer review notification', () => {
  const send   = vi.fn()
  const inbox  = vi.fn()
  const logs   = vi.fn()
  let available = true

  beforeEach(() => {
    vi.resetModules()
    send.mockReset().mockResolvedValue({ success: true, messageId: 'm-1' })
    inbox.mockReset().mockResolvedValue('n-1')
    logs.mockReset()
    available = true
    vi.doMock('@/lib/notifications', () => ({
      notificationEngine: { isAvailable: () => available, send },
      NotificationType: { EVENT_SUBMITTED: 'EVENT_SUBMITTED', EVENT_APPROVED: 'EVENT_APPROVED', EVENT_REJECTED: 'EVENT_REJECTED', EVENT_CHANGES_REQUESTED: 'EVENT_CHANGES_REQUESTED', EVENT_RESUBMITTED: 'EVENT_RESUBMITTED' },
      NotificationChannel: { EMAIL: 'email' },
    }))
    vi.doMock('@/lib/notifications/organizerWhatsApp', () => ({ sendOrganizerWhatsApp: async () => undefined }))
    vi.doMock('@/lib/email-logs/write', () => ({ writeEmailLog: logs }))
    vi.doMock('@/lib/organizer/emailIdentity', () => ({ resolveOrganizerEmailIdentity: async () => ({ email: 'owner@org.test', name: 'Owner' }) }))
    vi.doMock('@/lib/notifications/inbox/notify', () => ({ notifyEventReviewed: inbox }))
  })

  it('emails the workspace owner with the edit link and keys the inbox item to the decision', async () => {
    const { sendEventReviewEmail } = await import('@/lib/events/reviewNotifications')
    await sendEventReviewEmail({ organizerUid: 'ws-1', eventName: 'Run', kind: 'changes_requested', comment: 'Add map', eventId: 'd1', occurrenceId: 'h-9' })
    expect(send).toHaveBeenCalledTimes(1)
    const [type, params] = send.mock.calls[0]
    expect(type).toBe('EVENT_CHANGES_REQUESTED')
    expect(params).toMatchObject({ to: 'owner@org.test', comment: 'Add map' })
    expect(params.eventUrl).toMatch(/\/dashboard\/events\/d1\?tab=setup$/)
    expect(inbox).toHaveBeenCalledWith(expect.objectContaining({ workspaceUid: 'ws-1', eventId: 'd1', kind: 'changes_requested', occurrenceId: 'h-9' }))
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', recipientEmail: 'owner@org.test' }))
  })

  it('records a skip — never a send — when email is unavailable', async () => {
    available = false
    const { sendEventReviewEmail } = await import('@/lib/events/reviewNotifications')
    await sendEventReviewEmail({ organizerUid: 'ws-1', eventName: 'Run', kind: 'approved', eventId: 'd1' })
    expect(send).not.toHaveBeenCalled()
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }))
  })

  it('records a failure when the provider refuses', async () => {
    send.mockResolvedValue({ success: false, error: 'bounced' })
    const { sendEventReviewEmail } = await import('@/lib/events/reviewNotifications')
    await sendEventReviewEmail({ organizerUid: 'ws-1', eventName: 'Run', kind: 'rejected', reason: 'No', eventId: 'd1' })
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'bounced' }))
  })

  it('sends the decisions that need action to Setup, the rest to the event', async () => {
    const { reviewEventPath } = await import('@/lib/events/reviewNotifications')
    expect(reviewEventPath('changes_requested', 'd 1')).toBe('/dashboard/events/d%201?tab=setup')
    expect(reviewEventPath('rejected', 'd1')).toBe('/dashboard/events/d1?tab=setup')
    expect(reviewEventPath('approved', 'd1')).toBe('/dashboard/events/d1')
    expect(reviewEventPath('resubmitted', null)).toBeNull()
  })
})

describe('organizer inbox item', () => {
  it('is idempotent per decision and opens Setup for an action-required decision', async () => {
    vi.resetModules()
    vi.doUnmock('@/lib/notifications/inbox/notify')   // mocked by the describe above
    const write = vi.fn(async () => 'id')
    vi.doMock('@/lib/notifications/inbox/write', () => ({ writeNotification: write }))
    vi.doMock('@/lib/wallet/communicationBalance', () => ({ COMMUNICATION_BALANCE_HREF: '/x' }))
    vi.doMock('@/lib/reports/format', () => ({ fmtMoney: (n: number) => String(n) }))
    const { notifyEventReviewed } = await import('@/lib/notifications/inbox/notify')
    await notifyEventReviewed({ workspaceUid: 'ws', eventName: 'Run', eventId: 'd1', kind: 'changes_requested', comment: 'Map', occurrenceId: 'h/1' })
    await notifyEventReviewed({ workspaceUid: 'ws', eventName: 'Run', eventId: 'd1', kind: 'approved' })
    const [first, second] = write.mock.calls.map(c => (c as unknown[])[0] as Record<string, unknown>)
    expect(first).toMatchObject({ workspaceUid: 'ws', link: '/dashboard/events/d1?tab=setup', actionRequired: true, dedupeId: 'event-review-changes_requested-h_1' })
    expect(second).toMatchObject({ link: '/dashboard/events/d1', dedupeId: undefined })
  })
})

// ─── Wiring (source contracts) ─────────────────────────────────────────────────

describe('wiring', () => {
  const LIFECYCLE = code(read('lib/events/lifecycle.ts'))

  it('stages the history entry INSIDE the transition transaction', () => {
    const txn = LIFECYCLE.slice(LIFECYCLE.indexOf('adminDb.runTransaction('), LIFECYCLE.indexOf('if (txnFailure) return txnFailure'))
    expect(txn).toContain('txn.set(historyRef,')
    // before the draft write, so all writes follow all reads
    expect(txn.indexOf('txn.set(historyRef,')).toBeLessThan(txn.indexOf('txn.update(draftRef, draftUpdate)'))
    expect(LIFECYCLE).toContain('eventRef.collection(REVIEW_HISTORY).doc()')
  })

  it('never attributes an admin decision to the organizer', () => {
    expect(LIFECYCLE).toContain("actorUid: actorUid ?? (reviewActorRole(action) === 'organizer' ? uid : null)")
  })

  it('records who resubmitted, how often, and the request it answered', () => {
    expect(LIFECYCLE).toContain('draftUpdate.resubmittedBy     = actorUid ?? uid')
    expect(LIFECYCLE).toContain('eventUpdate.resubmissionCount = FieldValue.increment(1)')
    expect(LIFECYCLE).toContain('eventUpdate.lastReviewRequest = lastReviewRequest')
  })

  it('leaves the RD-NOTIFY-01 Super Admin alert in place', () => {
    expect(LIFECYCLE).toContain("const reviewAlert = action === 'resubmit' || action === 'republish'")
    expect(LIFECYCLE).toContain('if (reviewAlert) stageOutboxMessage(txn, reviewAlert)')
    expect(LIFECYCLE).toContain('if (reviewAlert) scheduleOutboxDelivery(reviewAlert.id)')
  })

  it('passes the real actor from every review route', () => {
    expect(code(read('app/api/admin/events/[slug]/review/route.ts')))
      .toContain('applyLifecycleTransition(uid, draftId, action, undefined, review, adminUid)')
    expect(code(read('app/api/organizer/events/[eventId]/resubmit/route.ts')))
      .toContain("applyLifecycleTransition(uid, eventId, 'resubmit', undefined, undefined, authz.callerUid)")
    expect(code(read('app/api/organizer/events/[eventId]/republish/route.ts')))
      .toContain("applyLifecycleTransition(uid, eventId, 'republish', undefined, undefined, authz.callerUid)")
  })

  it('notifies only after a successful transition, keyed to its history entry', () => {
    const route = code(read('app/api/admin/events/[slug]/review/route.ts'))
    expect(route.indexOf('if (!result.success)')).toBeLessThan(route.indexOf('sendEventReviewEmail('))
    expect(route).toContain('const occurrenceId = result.reviewEntryId')
  })

  it('lists the changes_requested queue and hides decisions outside review', () => {
    expect(code(read('app/api/admin/event-approvals/route.ts'))).toContain(".where('lifecycleStatus', '==', queue)")
    const ui = code(read('app/(admin)/admin/event-approvals/PageClient.tsx'))
    expect(ui).toContain("r.status === 'pending_review' && (<>")
    expect(ui).toContain('/review-history')
    expect(ui).not.toContain('Organizer pays (fixed)')
  })

  it('deletes the history with the event', () => {
    expect(code(read('lib/events/eventDeletion.ts'))).toContain("name: 'reviewHistory'")
  })
})
