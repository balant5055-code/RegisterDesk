// RD-REVIEW-02 (unit) — the review lifecycle's pure rules and the source contracts that keep them
// wired: closure semantics, review-history roles and privacy, deterministic notices, the
// transaction preconditions (expected status + review cycle), owner-only closure, the edit locks,
// the scheduler's auth and schedule, financial isolation, and the organizer / admin UI wiring.
// Behaviour on real Firestore through the real routes: tests/emulator/reviewDeadlines.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const LIFECYCLE = code(read('lib/events/lifecycle.ts'))
const REVIEW    = code(read('app/api/admin/events/[slug]/review/route.ts'))
const CLOSE     = code(read('app/api/organizer/events/[eventId]/close-review/route.ts'))
const CRON      = code(read('app/api/cron/review-deadlines/route.ts'))

describe('closure semantics (pure)', async () => {
  const { targetStatus, isReviewClosed, blockedByReviewClosure, isValidTransition } = await import('@/lib/events/lifecycleStateMachine')
  it('a review closure is a cancellation (every existing guard already treats it as terminal, not live)', () => {
    expect(targetStatus('close_review')).toBe('cancelled')
    expect(targetStatus('expire_review')).toBe('cancelled')
    expect(isValidTransition('changes_requested', 'cancelled')).toBe(true)
  })
  it('the marker is recognised only with a known source', () => {
    expect(isReviewClosed({ reviewClosure: { source: 'organizer' } })).toBe(true)
    expect(isReviewClosed({ reviewClosure: { source: 'deadline_expired' } })).toBe(true)
    expect(isReviewClosed({ reviewClosure: { source: 'admin' } })).toBe(false)
    expect(isReviewClosed({ lifecycleStatus: 'cancelled' })).toBe(false)     // an ordinary cancellation
    expect(isReviewClosed(null)).toBe(false)
  })
  it('restore, republish and resubmit are refused on a review-closed event (reopening is a Super Admin matter)', () => {
    for (const a of ['restore', 'republish', 'resubmit'] as const) expect(blockedByReviewClosure(a)).toBe(true)
    for (const a of ['archive', 'approve', 'cancel', 'complete'] as const) expect(blockedByReviewClosure(a)).toBe(false)
  })
})

describe('review history (pure)', async () => {
  const { buildReviewHistoryEntry, reviewActorRole, isReviewHistoryAction } = await import('@/lib/events/reviewHistory')
  it('attributes each new action to the right role', () => {
    expect(reviewActorRole('submit')).toBe('organizer')
    expect(reviewActorRole('close_review')).toBe('organizer')
    expect(reviewActorRole('review_reminder')).toBe('system')
    expect(reviewActorRole('action_required')).toBe('system')
    expect(reviewActorRole('expire_review')).toBe('system')
    expect(reviewActorRole('approve')).toBe('admin')
    expect(isReviewHistoryAction('close_review')).toBe(true)
    expect(isReviewHistoryAction('expire_review')).toBe(true)
    expect(isReviewHistoryAction('cancel')).toBe(false)
  })
  it('every entry carries its review cycle; reminders and deadlines are recorded', () => {
    const e = buildReviewHistoryEntry({ action: 'review_reminder', fromStatus: 'changes_requested', toStatus: 'changes_requested', actorUid: null, cycleId: 'cyc', reminder: 'h12', dueAt: 123 })
    expect(e).toMatchObject({ action: 'review_reminder', actorRole: 'system', actorUid: null, cycleId: 'cyc', reminder: 'h12', dueAt: 123, notes: null })
  })
  it('the internal rejection note is recorded ONLY on a reject entry; a closure reason is organizer-visible', () => {
    expect(buildReviewHistoryEntry({ action: 'reject', fromStatus: 'pending_review', toStatus: 'draft', actorUid: 'a', reason: 'r', notes: 'internal' }).notes).toBe('internal')
    expect(buildReviewHistoryEntry({ action: 'close_review', fromStatus: 'changes_requested', toStatus: 'cancelled', actorUid: 'o', reason: 'no longer running', notes: 'x' }))
      .toMatchObject({ reason: 'no longer running', notes: null })
  })
})

describe('private admin notes never reach the organizer', async () => {
  const { serializeDraft } = await import('@/lib/events/draftWrite')
  it('serializeDraft strips rejectionNotes (older data may still carry it)', () => {
    const out = serializeDraft('d1', { rejectionReason: 'shown', rejectionNotes: 'INTERNAL', eventDetails: { info: { name: 'x' } } })
    expect(out).not.toHaveProperty('rejectionNotes')
    expect(out).toMatchObject({ id: 'd1', rejectionReason: 'shown' })
  })
  it('reject no longer copies the note onto the draft or the event document', () => {
    expect(LIFECYCLE).toContain('draftUpdate.rejectionNotes    = null')
    expect(LIFECYCLE).toContain('eventUpdate.rejectionNotes    = null')
    expect(LIFECYCLE).not.toMatch(/rejectionNotes\s*=\s*review\?\.rejectionNotes/)
  })
})

describe('deadline notices (pure)', async () => {
  const { reviewReminderNotice, actionRequiredNotice, reviewClosedNotice, reviewEditPath } = await import('@/lib/notifications/reviewDeadlineAlerts')
  const base = { organizerUid: 'org', draftId: 'd1', cycleId: 'cyc-1', eventName: 'Run', changesComment: 'Add the venue' }
  it('ids are deterministic per (cycle, step) — a repeated step can never create a second notice', () => {
    expect(reviewReminderNotice({ ...base, key: 'h12', dueAtMs: 1 }).id).toBe('review-dl_cyc-1_reminder-h12')
    expect(reviewReminderNotice({ ...base, key: 'h12', dueAtMs: 999 }).id).toBe('review-dl_cyc-1_reminder-h12')
    expect(actionRequiredNotice({ ...base, closesAtMs: 1 }).id).toBe('review-dl_cyc-1_action-required')
    expect(reviewClosedNotice({ ...base, source: 'deadline_expired', closedAtMs: 1 }).id).toBe('review-dl_cyc-1_closed-deadline_expired')
    expect(reviewReminderNotice({ ...base, cycleId: 'cyc-2', key: 'h12', dueAtMs: 1 }).id).not.toBe('review-dl_cyc-1_reminder-h12')
  })
  it('go to the organizer only, in the inbox as action-required, with the edit link', () => {
    const n = reviewReminderNotice({ ...base, key: 'ar20', dueAtMs: 1 })
    expect(n.audience).toEqual({ kind: 'organizer', organizerUid: 'org' })
    expect(n.inbox).toMatchObject({ category: 'approval', actionRequired: true, eventId: 'd1' })
    expect(n.path).toBe(reviewEditPath('d1'))
    expect(reviewEditPath('d 1')).toBe('/dashboard/events/new/visibility?draftId=d%201')
  })
  it('the closure notice states the existing request rules and links to the Event Wallet', () => {
    const closedAt = Date.parse('2026-10-28T06:00:00Z')
    const n = reviewClosedNotice({ ...base, source: 'organizer', closedAtMs: closedAt })
    expect(n.intro).toMatch(/never refunds anything automatically/i)
    expect(n.intro).toMatch(/within 24 hours of closure/)
    expect(n.intro).toMatch(/registration capacity cannot be moved/)
    expect(n.intro.length).toBeLessThanOrEqual(1000)                       // the outbox caps intro at 1000
    expect(n.path).toBe('/dashboard/wallet')
    expect(n.facts.find(f => f.label === 'Refund requests until')?.value).toBe(new Date(closedAt + 24 * 3_600_000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST')
    expect(n.inbox?.actionRequired).toBe(false)
  })
})

describe('closure copy matches the EXISTING service request rules (no promise beyond them)', async () => {
  const rules = await import('@/lib/wallet/serviceRequestRules')
  const copy = await import('@/lib/notifications/reviewDeadlineAlerts')
  it('the refund window is the real one', () => {
    expect(copy.CLOSURE_REFUND_WINDOW_HOURS).toBe(rules.REFUND_WINDOW_HOURS)
  })
  it('a cancelled event is closed for requests (so a review closure opens the existing window)', () => {
    expect(rules.isClosedLifecycle('cancelled')).toBe(true)
  })
  it('refundable services are exactly the requestable ones; registration capacity is never described as movable', () => {
    expect([...rules.REQUESTABLE_SERVICES].sort()).toEqual(['certificates', 'media', 'print_badges', 'registrations', 'whatsapp'])
    expect(rules.CARRYABLE_SERVICES).not.toContain('registrations')
    expect([...rules.CARRYABLE_SERVICES].sort()).toEqual(['certificates', 'media', 'print_badges', 'whatsapp'])
    expect(copy.CLOSURE_SERVICES_DETAIL).toMatch(/registration capacity, WhatsApp messages, certificates, photos and ID badges/)
    expect(copy.CLOSURE_SERVICES_DETAIL).toMatch(/WhatsApp, certificate, photo and ID-badge units can instead be moved/)
    expect(copy.CLOSURE_SERVICES_DETAIL).not.toMatch(/all (unused )?(services|credits) (can|will) be (moved|transferred|refunded)/i)
  })
  it('the dialog and the card use the shared statement', () => {
    expect(code(read('app/(dashboard)/dashboard/events/EventsClient.tsx'))).toContain('+ CLOSURE_SERVICES_DETAIL,')
    expect(code(read('app/(dashboard)/dashboard/events/EventCard.tsx'))).toContain('{CLOSURE_SERVICES_SHORT}')
  })
})

describe('transaction preconditions (source contracts)', () => {
  const txn = LIFECYCLE.slice(LIFECYCLE.indexOf('const txnFailure = await adminDb.runTransaction('), LIFECYCLE.indexOf('if (txnFailure) return txnFailure'))
  it('status, review cycle and deadline are checked on the TRANSACTIONAL snapshot', () => {
    expect(txn).toContain('if (requiredStatus && freshStatus !== requiredStatus)')
    expect(txn).toContain('if (opts.expectedCycleId !== undefined && storedCycle !== opts.expectedCycleId)')
    expect(txn).toContain("code: 'REVIEW_CYCLE_STALE'")
    expect(txn).toContain("code: 'DEADLINE_PASSED'")
    expect(txn).toContain("code: 'NOT_DUE'")
    expect(txn).toContain("code: 'REVIEW_CLOSED'")
  })
  it('admin decisions require pending_review and agreement with the live document', () => {
    expect(LIFECYCLE).toContain("const ADMIN_REVIEW_ACTIONS = new Set<LifecycleAction>(['approve', 'reject', 'request_changes'])")
    expect(txn).toContain("ADMIN_REVIEW_ACTIONS.has(action) ? 'pending_review'")
    expect(txn).toContain('deriveLifecycleStatus(eventData) !== freshStatus')
  })
  it('the first deadline is created only inside the change request\'s transaction', () => {
    expect(txn).toContain('const dl = newChangesDeadline(cycleAfter, nowMs)')
    expect(LIFECYCLE.slice(0, LIFECYCLE.indexOf('const txnFailure'))).not.toContain('newChangesDeadline(')
  })
  it('audit rows and closure notices are staged in the same transaction', () => {
    expect(txn).toContain('stageAdminAudit(txn, {')
    expect(txn).toContain('if (closureNotice) stageOutboxMessage(txn, closureNotice)')
  })
  it('a resubmission / republish opens a new cycle and ends the old deadline', () => {
    expect(LIFECYCLE).toContain('draftUpdate.reviewCycleId        = newCycleId')
    expect(LIFECYCLE).toContain('draftUpdate.reviewDeadline       = FieldValue.delete()')
    expect(LIFECYCLE).toContain('eventUpdate.reviewDeadlineNextAt = null')
  })
})

describe('routes (source contracts)', () => {
  it('the admin review route requires the reviewed cycle and passes it into the transaction', () => {
    expect(REVIEW).toContain("hasOwnProperty.call(body, 'reviewCycleId')")
    expect(REVIEW).toContain("expectedStatus: 'pending_review'")
    expect(REVIEW).toContain('expectedCycleId,')
    expect(REVIEW).not.toContain('logAdminAction(')                 // no post-commit, lossy audit
  })
  it('the first submission opens cycle 1 and is recorded in the history inside the publish transaction', () => {
    const pub = code(read('app/api/events/publish/route.ts'))
    expect(pub).toContain("const reviewCycleId   = terminalStatus === 'pending_review' ? randomUUID() : null")
    expect(pub).toContain("action: 'submit', fromStatus: 'draft', toStatus: 'pending_review'")
  })
  it('closing is owner-only, needs explicit confirmation and names the cycle', () => {
    expect(CLOSE).toContain('if (authz.callerUid !== authz.workspaceUid)')
    expect(CLOSE).toContain("code: 'OWNER_ONLY'")
    expect(CLOSE).toContain('body.confirm !== true')
    expect(CLOSE).toContain("expectedStatus: 'changes_requested'")
    expect(CLOSE).toContain("action: 'event.review_closed'")
  })
  it('closed events cannot be edited through the draft save or the edit route', () => {
    const drafts = code(read('app/api/organizer/drafts/[draftId]/route.ts'))
    const save = drafts.slice(drafts.indexOf('export async function PATCH'), drafts.indexOf('export async function DELETE'))
    expect(save.indexOf('isReviewClosed(snap.data()')).toBeGreaterThan(save.indexOf('runTransaction'))
    expect(save.indexOf('isReviewClosed(snap.data()')).toBeLessThan(save.indexOf('txn.update(ref'))
    const edit = code(read('app/api/organizer/events/[eventId]/edit/route.ts'))
    expect(edit.indexOf('if (isReviewClosed(d))')).toBeGreaterThan(0)
    // Hardening — the write is a transaction that RE-READS the draft and refuses a closure that
    // committed after the first check (it used to be a blind batch).
    expect(edit).not.toContain('adminDb.batch()')
    const txn = edit.slice(edit.indexOf('await adminDb.runTransaction(async txn => {'))
    expect(txn.indexOf('isReviewClosed(fresh.data()')).toBeGreaterThan(0)
    expect(txn.indexOf('isReviewClosed(fresh.data()')).toBeLessThan(txn.indexOf('txn.update(draftRef, draftUpdate)'))
  })
  it('an ordinary cancel cannot end a changes request (only the recorded review closure can)', () => {
    expect(LIFECYCLE).toContain("if (action === 'cancel' && freshStatus === 'changes_requested') {")
    expect(LIFECYCLE).toContain("code: 'USE_CLOSE_EVENT'")
  })
  it('an add-on paid after a review closure is refused through the existing hold path, inside the settlement transaction', () => {
    const dc = code(read('lib/licensing/draftCommerce.ts'))
    const settle = dc.slice(dc.indexOf('export async function activateAddonOrder('))
    expect(settle).toContain('const reviewClosed = live.some(d => isReviewClosed(d.data()))')
    expect(settle.indexOf('reviewClosed ||')).toBeLessThan(settle.indexOf('txnApplyServiceItems('))
    expect(settle).toContain("...(reviewClosed ? { failDetail: ADDON_EVENT_REVIEW_CLOSED } : {})")
    // the callers' handling is unchanged: the SAME refusal kind, so both record the manual-refund hold
    expect(settle).toContain("return 'licence_inactive'")
    const confirm = code(read('app/api/licensing/checkout/confirm/route.ts'))
    expect(confirm).toContain("if (result === 'licence_inactive') {")
    expect(confirm.indexOf('holdLicenceInactiveAddon({', confirm.indexOf("if (result === 'licence_inactive') {")))
      .toBeLessThan(confirm.indexOf('ADDON_EVENT_REVIEW_CLOSED', confirm.indexOf("if (result === 'licence_inactive') {")))
  })
  it('resubmission keeps the shared, event-type-aware publish validation', () => {
    const r = code(read('app/api/organizer/events/[eventId]/resubmit/route.ts'))
    expect(r).toContain('validateEventPublish({')
    expect(r).toContain("eventType:            typeof d.eventType    === 'string' ? d.eventType    : null")
    expect(r).toContain('governPublish({ eventId, draft: d, slug, confirmed })')
  })
})

describe('scheduler (source contracts)', () => {
  it('the cron route authorizes first and processes a bounded, ordered batch', () => {
    expect(CRON.indexOf('if (!isAuthorizedCron(req)) return cronUnauthorized()')).toBeLessThan(CRON.indexOf("adminDb.collection('events')"))
    expect(CRON).toContain(".where('reviewDeadlineNextAt', '<=', Timestamp.fromMillis(start))")
    expect(CRON).toContain(".orderBy('reviewDeadlineNextAt', 'asc')")
    expect(CRON).toContain('.limit(BATCH)')
  })
  it('it is scheduled every 10 minutes, before the outbox drain', () => {
    const wf = read('.github/workflows/cron-recovery.yml')
    expect(wf).toContain("cron: '*/10 * * * *'")
    expect(wf).toContain('$CRON_BASE_URL/api/cron/review-deadlines')
    expect(wf.indexOf('name: review-deadlines')).toBeLessThan(wf.indexOf('name: ops-alerts'))
  })
})

describe('financial isolation (source contracts)', () => {
  const MONEY = /@\/lib\/(wallet|licensing|refunds|razorpay|payments|settlements|fees)\b|organizerWallets|walletTransactions|eventServiceAllowances|licenseOrders/
  it('the lifecycle, the closure route, the scheduler and the notices touch no money, licence, allowance or registration', () => {
    for (const f of ['lib/events/lifecycle.ts', 'app/api/organizer/events/[eventId]/close-review/route.ts', 'app/api/cron/review-deadlines/route.ts', 'lib/events/reviewDeadline.ts', 'lib/notifications/reviewDeadlineAlerts.ts']) {
      expect(code(read(f)), f).not.toMatch(MONEY)
      expect(code(read(f)), f).not.toMatch(/collection\('registrations'\)|registrations\//)
    }
  })
})

describe('organizer and admin UI (source contracts)', () => {
  const CARD = code(read('app/(dashboard)/dashboard/events/EventCard.tsx'))
  const CLIENT = code(read('app/(dashboard)/dashboard/events/EventsClient.tsx'))
  const EDITOR = code(read('app/(dashboard)/dashboard/events/new/page.tsx'))
  it('the changes-requested card offers exactly Edit Event (the editor) and Close Event — no Resubmit button', () => {
    const panel = CARD.slice(CARD.indexOf('function ReviewRequestPanel('), CARD.indexOf('export function EventCard('))
    expect(panel).toContain('href={editEventHref(event)}')
    expect(panel).toContain('Edit Event')
    expect(panel).toContain('Close Event')
    expect(panel).not.toMatch(/Resubmit/)
    expect(CARD).toContain("needsResubmit(event) && event.lifecycleStatus !== 'changes_requested'")
  })
  it('closing asks for confirmation first; a cancelled dialog sends nothing', () => {
    const h = CLIENT.slice(CLIENT.indexOf('const onCloseReview = useCallback('), CLIENT.indexOf('const cardActions'))
    expect(h.indexOf('if (!ok) return')).toBeGreaterThan(h.indexOf('await confirm({'))
    expect(h.indexOf('if (!ok) return')).toBeLessThan(h.indexOf('/close-review'))
    expect(h).toContain('reviewCycleId: event.reviewCycleId ?? null')
  })
  it('the editor\'s own Submit for review resubmits a changes-requested event (no second editor or flow)', () => {
    expect(EDITOR).toContain("phase === 'review' && isChangesRequested ? (")
    expect(EDITOR).toContain('`/api/organizer/events/${encodeURIComponent(draftId)}/resubmit`')
    expect(EDITOR).toContain("nextLabel={publishState === 'publishing' ? 'Submitting…' : 'Submit for review'}")
  })
  it('the Review step actually RECEIVES the review fields, and a changes-requested event opens on Review (browser-QA regression)', () => {
    const memo = EDITOR.slice(EDITOR.indexOf('const reviewInitialData = useMemo(() => ({'), EDITOR.indexOf('const reviewInitialData = useMemo(() => ({') + 1600)
    for (const f of ['lifecycleStatus:      reviewFields.lifecycleStatus', 'reviewDeadline:       reviewFields.reviewDeadline',
      'reviewCycleId:        reviewFields.reviewCycleId', 'changesComment:       reviewFields.changesComment']) {
      expect(memo, f).toContain(f)
    }
    expect(EDITOR).toContain(": changesRequested ? indexOfStep(draftFlow, 'review')")
  })
  it('the countdown only displays a server-stored deadline', () => {
    const c = code(read('components/events/ReviewDeadlineCountdown.tsx'))
    expect(c).toContain('const remaining = dueAt - now')
    expect(c).not.toMatch(/REVIEW_WINDOW_MS|24 \* 60/)
    expect(c).toContain('role="timer"')
  })
  it('admin decisions send the cycle they were loaded with', () => {
    const adm = code(read('app/(admin)/admin/event-approvals/PageClient.tsx'))
    expect(adm).toContain('body: JSON.stringify({ ...body, reviewCycleId: row.reviewCycleId ?? null })')
  })
})
