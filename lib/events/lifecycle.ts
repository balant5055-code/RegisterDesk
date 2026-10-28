// Server-only: uses Firebase Admin SDK.
// Contains the event lifecycle state machine and the shared transition function
// called by the status / cancel / archive API routes.

import { randomUUID }    from 'crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb }       from '@/lib/firebase/admin'
import type { EventLifecycleStatus, LifecycleAction, EventReviewMeta } from '@/types/events'
import { targetStatus, isValidTransition, deriveLifecycleStatus, isReviewClosed, blockedByReviewClosure } from './lifecycleStateMachine'
import { liveEventBelongsTo } from './liveEventRef'
import { buildLiveContentSync } from './editing/liveContentSync'
import { stageOutboxMessage, scheduleOutboxDelivery, istNow, type OutboxMessageInput } from '@/lib/notifications/outbox'
import { eventReviewAlert } from '@/lib/notifications/actionAlerts'
import { reviewReminderNotice, actionRequiredNotice, reviewClosedNotice } from '@/lib/notifications/reviewDeadlineAlerts'
import { resolveOrganizerEmailIdentity } from '@/lib/organizer/emailIdentity'
import { stageAdminAudit, type AdminAuditParams } from '@/lib/admin/audit'
import { REVIEW_HISTORY, buildReviewHistoryEntry, isReviewHistoryAction, reviewActorRole, revisedSections } from './reviewHistory'
import {
  readReviewDeadline, newChangesDeadline, enterActionRequired, markReminders, nextDeadlineStep,
  nextDeadlineAt, reviewDeadlinePassed, currentDueAt, type ReviewDeadline,
} from './reviewDeadline'

// Re-export the pure state machine so existing importers of this module are
// unaffected (the machine now lives in ./lifecycleStateMachine for testability).
export { targetStatus, isValidTransition, deriveLifecycleStatus, isArchivedEvent } from './lifecycleStateMachine'
export { VALID_TRANSITIONS } from './lifecycleStateMachine'

// ─── Core transition function ─────────────────────────────────────────────────

export interface TransitionResult {
  success:          boolean
  lifecycleStatus?: EventLifecycleStatus
  error?:           string
  statusCode:       number
  /** RD-REVIEW-01 — id of the reviewHistory entry this transition appended (review actions only). */
  reviewEntryId?:   string
  /** RD-REVIEW-02 — a stable reason for a refusal the caller may want to explain. */
  code?:            'STATUS_CHANGED' | 'REVIEW_CYCLE_STALE' | 'DEADLINE_PASSED' | 'REVIEW_CLOSED' | 'NOT_DUE' | 'USE_CLOSE_EVENT'
  /** RD-REVIEW-02 — the review cycle the event is in after the transition. */
  reviewCycleId?:   string | null
}

/** RD-REVIEW-02 — preconditions and side records checked / staged INSIDE the transition's transaction. */
export interface TransitionOptions {
  /** The draft must be in exactly this lifecycle status when the transaction reads it. */
  expectedStatus?:  EventLifecycleStatus
  /** The stored review cycle must equal this (null = an event from before review cycles). Undefined = not checked. */
  expectedCycleId?: string | null
  /** Admin audit row staged in the same transaction (the transition and its audit commit together). */
  audit?:           AdminAuditParams
  /** Organizer-visible reason recorded with a review closure. */
  closureReason?:   string
}

/** RD-REVIEW-02 — the admin decisions: each may only answer an event that is pending review. */
const ADMIN_REVIEW_ACTIONS = new Set<LifecycleAction>(['approve', 'reject', 'request_changes'])

/** RD-REVIEW-02 — a deadline as stored (Firestore Timestamps). */
function storedDeadline(d: ReviewDeadline): Record<string, unknown> {
  const ts = (ms: number | null) => (ms === null ? null : Timestamp.fromMillis(ms))
  const sent: Record<string, Timestamp> = {}
  for (const [k, v] of Object.entries(d.remindersSent)) if (typeof v === 'number') sent[k] = Timestamp.fromMillis(v)
  return {
    cycleId: d.cycleId, phase: d.phase,
    changesRequestedAt: ts(d.changesRequestedAt), changesDueAt: ts(d.changesDueAt),
    actionRequiredAt: ts(d.actionRequiredAt), actionDueAt: ts(d.actionDueAt),
    remindersSent: sent,
  }
}

const reviewCycleOf = (d: Record<string, unknown>): string | null =>
  typeof d.reviewCycleId === 'string' && d.reviewCycleId ? d.reviewCycleId : null

const eventNameOf = (d: Record<string, unknown>): string => {
  const info = ((d.eventDetails as Record<string, unknown> | undefined)?.info ?? {}) as { name?: unknown }
  return typeof info.name === 'string' ? info.name.trim() : ''
}

export async function applyLifecycleTransition(
  uid:           string,
  eventId:       string,
  action:        LifecycleAction,
  cancelReason?: string,
  review?:       EventReviewMeta,
  actorUid?:     string,   // caller uid for audit (defaults to uid / workspace owner)
  opts:          TransitionOptions = {},
): Promise<TransitionResult> {
  // ── 1. Load draft (uid in path proves ownership) ───────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) {
    return { success: false, error: 'Event not found', statusCode: 404 }
  }

  const d             = draftSnap.data() as Record<string, unknown>
  const currentStatus = deriveLifecycleStatus(d)
  const newStatus     = targetStatus(action)

  // ── 2. Validate transition ────────────────────────────────────────────────
  if (!isValidTransition(currentStatus, newStatus)) {
    return {
      success:    false,
      error:      `Cannot transition from '${currentStatus}' to '${newStatus}'`,
      statusCode: 409,
    }
  }

  // ── 3. Cancel-specific validation ─────────────────────────────────────────
  if (action === 'cancel') {
    if (!cancelReason || cancelReason.trim().length < 5) {
      return {
        success:    false,
        error:      'A cancellation reason is required (minimum 5 characters)',
        statusCode: 400,
      }
    }
  }

  // ── 4. Build update payload ────────────────────────────────────────────────
  const now = FieldValue.serverTimestamp()

  const draftUpdate: Record<string, unknown> = { lifecycleStatus: newStatus, updatedAt: now }
  const eventUpdate: Record<string, unknown> = { lifecycleStatus: newStatus, updatedAt: now }

  if (action === 'cancel') {
    draftUpdate.cancelledAt  = now
    draftUpdate.cancelledBy  = uid
    draftUpdate.cancelReason = cancelReason!.trim()
    eventUpdate.cancelledAt  = now
    eventUpdate.cancelledBy  = uid
    eventUpdate.cancelReason = cancelReason!.trim()
  }
  if (action === 'complete') {
    draftUpdate.completedAt = now
    eventUpdate.completedAt = now
  }
  if (action === 'archive') {
    // Legacy binary status = "not live" (mirrors unpublish/restore) so every
    // `status === 'published'` reader (events-list card, dashboard health item)
    // stops treating an archived event as published. lifecycleStatus stays the
    // authoritative field; dashboard totals key on publishedAt, so they are
    // unaffected (an archived event keeps its publishedAt).
    draftUpdate.status      = 'draft'
    draftUpdate.archivedAt  = now
    eventUpdate.status      = 'draft'
    eventUpdate.archivedAt  = now
  }
  if (action === 'restore') {
    // Archived → Unpublished (still PRIVATE). Mirrors the unpublished field-state so
    // the event behaves exactly like any other unpublished event (404 publicly; the
    // only way back to live is republish → admin review). Pure lifecycle write — NO
    // Razorpay / license / order / wallet / registration / certificate writes, so the
    // existing paid Event License is reused forever.
    draftUpdate.status      = 'draft'   // legacy binary = "not live" (backward compat)
    draftUpdate.restoredAt  = now
    draftUpdate.archivedAt  = null      // no longer archived
    eventUpdate.restoredAt  = now
    eventUpdate.archivedAt  = null
  }
  if (action === 'unpublish') {
    // lifecycleStatus becomes 'unpublished' (default newStatus above). The legacy
    // `status` binary is kept as 'draft' (= "not live") for backward compatibility,
    // so every existing `status === 'published'` reader still excludes this event.
    // The events/{slug} doc + paid Event License are PRESERVED for a payment-free
    // republish (no license/order/wallet/registration/certificate writes here).
    draftUpdate.status       = 'draft'
    draftUpdate.unpublishedAt = now
  }
  if (action === 'approve') {
    // Admin approval goes live: sync the legacy status field and stamp publish time.
    draftUpdate.status      = 'published'
    draftUpdate.publishedAt = now
    draftUpdate.approvedAt  = now
    draftUpdate.reviewStatus = null
    eventUpdate.publishedAt = now
    eventUpdate.approvedAt  = now
    eventUpdate.reviewStatus = null
    // Review duration = approval time − submit time (the event's publishedAt was
    // stamped at submit while it sat in pending_review). Recorded for admin stats.
    const submittedTs = d.publishedAt as { toDate?: () => Date } | undefined
    if (submittedTs && typeof submittedTs.toDate === 'function') {
      eventUpdate.reviewDurationMs = Math.max(0, Date.now() - submittedTs.toDate().getTime())
    }
  }
  if (action === 'reject') {
    // Admin rejection returns the event to draft (legacy status excludes it) and
    // records the reason so the organizer can see it and resubmit.
    draftUpdate.status            = 'draft'
    draftUpdate.rejectedAt        = now
    draftUpdate.reviewStatus      = 'rejected'
    draftUpdate.rejectionReason   = review?.rejectionReason   ?? ''
    draftUpdate.rejectionCategory = review?.rejectionCategory ?? ''
    eventUpdate.rejectedAt        = now
    eventUpdate.reviewStatus      = 'rejected'
    eventUpdate.rejectionReason   = review?.rejectionReason   ?? ''
    eventUpdate.rejectionCategory = review?.rejectionCategory ?? ''
    // RD-REVIEW-02 — the rejection NOTES are the admin's internal note: they live only in the
    // admin-only review history, never on the organizer-readable draft or the event document.
    // Null also clears a note an older version of this code copied here.
    draftUpdate.rejectionNotes    = null
    eventUpdate.rejectionNotes    = null
  }
  if (action === 'request_changes') {
    draftUpdate.changesRequestedAt = now
    draftUpdate.reviewStatus       = 'changes_requested'
    draftUpdate.changesComment     = review?.changesComment ?? ''
    draftUpdate.changesRequestedBy = actorUid ?? null
    eventUpdate.changesRequestedAt = now
    eventUpdate.reviewStatus       = 'changes_requested'
    eventUpdate.changesComment     = review?.changesComment ?? ''
    eventUpdate.changesRequestedBy = actorUid ?? null
  }
  if (action === 'resubmit') {
    // Organizer resubmits after edits: back to review, clearing prior review notes.
    draftUpdate.status            = 'pending_review'
    draftUpdate.publishedAt       = now   // submit time for the new review cycle
    draftUpdate.resubmittedAt     = now
    draftUpdate.resubmittedBy     = actorUid ?? uid
    draftUpdate.resubmissionCount = FieldValue.increment(1)
    draftUpdate.reviewStatus      = null
    draftUpdate.rejectionReason   = null
    draftUpdate.rejectionCategory = null
    draftUpdate.rejectionNotes    = null
    draftUpdate.changesComment    = null
    eventUpdate.publishedAt       = now
    eventUpdate.resubmittedAt     = now
    eventUpdate.resubmittedBy     = actorUid ?? uid
    eventUpdate.resubmissionCount = FieldValue.increment(1)
    eventUpdate.reviewStatus      = null
    eventUpdate.rejectionReason   = null
    eventUpdate.rejectionCategory = null
    eventUpdate.rejectionNotes    = null
    eventUpdate.changesComment    = null
  }
  if (action === 'republish') {
    // Organizer republishes a previously-unpublished event: back to admin review
    // (NEVER straight to published). Mirrors resubmit — a pure lifecycle transition
    // that does NOT re-run the publish transaction, so the existing events/{slug}
    // doc and its paid Event License are reused (no Razorpay, no licenseOrder,
    // no eventLicense creation). No payment can ever be requested here.
    draftUpdate.status            = 'pending_review'
    draftUpdate.publishedAt       = now   // submit time for the new review cycle
    draftUpdate.republishedAt     = now
    draftUpdate.republishedBy     = actorUid ?? uid
    draftUpdate.reviewStatus      = null
    draftUpdate.rejectionReason   = null
    draftUpdate.rejectionCategory = null
    draftUpdate.rejectionNotes    = null
    draftUpdate.changesComment    = null
    eventUpdate.publishedAt       = now
    eventUpdate.republishedAt     = now
    eventUpdate.republishedBy     = actorUid ?? uid
    eventUpdate.reviewStatus      = null
    eventUpdate.rejectionReason   = null
    eventUpdate.rejectionCategory = null
    eventUpdate.rejectionNotes    = null
    eventUpdate.changesComment    = null
  }

  // ── 4b. RD-REVIEW-02 — review cycles and deadlines ─────────────────────────
  // One clock for every instant this transition derives (deadline arithmetic needs a real number,
  // so it cannot be the serverTimestamp sentinel). The new cycle id is fixed before the
  // transaction, so a retried attempt writes the same id.
  const nowMs   = Date.now()
  const nowTs   = Timestamp.fromMillis(nowMs)
  const newCycleId = randomUUID()
  const startsCycle = action === 'resubmit' || action === 'republish'
  const isClosure   = action === 'close_review' || action === 'expire_review'
  if (startsCycle) {
    // A new submission = a new review cycle; the previous cycle's deadline ends here.
    draftUpdate.reviewCycleId        = newCycleId
    draftUpdate.reviewCycleStartedAt = nowTs
    draftUpdate.reviewDeadline       = FieldValue.delete()
    eventUpdate.reviewCycleId        = newCycleId
    eventUpdate.reviewCycleStartedAt = nowTs
    eventUpdate.reviewDeadline       = FieldValue.delete()
    eventUpdate.reviewDeadlineNextAt = null
  }
  if (action === 'approve' || action === 'reject') {
    // A decision ends the cycle's open deadline (there is none while pending review; this also
    // clears a stale one left by data written before the deadline existed).
    draftUpdate.reviewDeadline       = FieldValue.delete()
    eventUpdate.reviewDeadline       = FieldValue.delete()
    eventUpdate.reviewDeadlineNextAt = null
  }
  if (isClosure) {
    // A review closure is a cancellation (every existing guard treats 'cancelled' as terminal and
    // not live) plus the `reviewClosure` marker that says why. The deadline record is KEPT (it is
    // the evidence of both windows); only the scheduler pointer is cleared.
    const closedBy = action === 'close_review' ? (actorUid ?? uid) : null
    const reason   = (opts.closureReason ?? '').trim().slice(0, 500)
      || (action === 'close_review' ? 'Closed by the organizer during review' : 'Requested changes were not submitted before the deadline')
    for (const u of [draftUpdate, eventUpdate]) {
      u.cancelledAt  = now
      u.cancelledBy  = closedBy ?? uid
      u.cancelReason = reason
      // The request is no longer open: readers that key on reviewStatus (the event workspace banner,
      // the dashboard's "changes requested" count) must not keep asking for changes. What was
      // requested stays in changesComment, the review history and reviewClosure.
      u.reviewStatus = null
    }
    eventUpdate.reviewDeadlineNextAt = null
    // reviewClosure itself is written inside the transaction (it records the transactional cycle).
    opts = { ...opts, closureReason: reason }
  }

  // ── 5. Resolve public slug (needed to update events/{slug}) ───────────────
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null

  // ── 6. Atomic commit (M3 — TOCTOU-safe) ───────────────────────────────────
  // Re-read + re-validate the draft's lifecycle INSIDE a transaction before writing, so
  // two concurrent transitions can't both pass validation against stale state and
  // interleave into an illegal lifecycle. Firestore additionally aborts+retries if the
  // draft (or the public event doc) changes between the transactional read and commit.
  // Same state machine, same update payloads — only the blind batch became a transaction.
  const eventRef = slug ? adminDb.collection('events').doc(slug) : null
  // Resubmit and republish send the event BACK TO REVIEW, so they also make events/{slug} — the
  // snapshot the Super Admin previews and approval publishes — the LATEST draft content, through
  // the same rule Save Changes applies (lib/events/editing/liveContentSync: content fields only,
  // commercial + identity freeze, value rules, sold-count floor). Approve copies nothing, so a
  // draft edit made during review can never reach the public page unreviewed.
  const syncsContent = action === 'resubmit' || action === 'republish'
  const counterRef   = syncsContent && slug ? adminDb.collection('registrationCounters').doc(slug) : null
  let contentChanged: string[] = []
  // RD-REVIEW-01 — every review transition appends one history entry, staged in the same
  // transaction, so an entry exists if and only if the transition persisted. The id is fixed
  // before the transaction, so a retried attempt rewrites the same entry, never a second one.
  const historyRef = isReviewHistoryAction(action) && eventRef ? eventRef.collection(REVIEW_HISTORY).doc() : null
  let reviewEntryId: string | undefined
  let contentRevised: string[] = []
  // RD-NOTIFY-01 — sending an event BACK to review alerts the Super Admins, staged in the same
  // transaction as the transition (no alert for a transition that did not persist). Built once,
  // before the transaction, so a retried transaction keeps one id.
  const reviewAlert = action === 'resubmit' || action === 'republish'
    ? await resolveOrganizerEmailIdentity(uid).catch(() => ({ name: '', email: '' })).then(o => eventReviewAlert({
        submission: action === 'resubmit' ? 'resubmitted' : 'republished', draftId: eventId, slug,
        eventName: typeof (details.info as { name?: unknown } | undefined)?.name === 'string' ? String((details.info as { name: string }).name).trim() : '',
        organizer: { uid, name: o.name, email: o.email }, at: new Date(), when: istNow(),
      }))
    : null
  // What the (last, committed) transaction attempt staged — read only after a successful commit.
  let staged: { cycleAfter: string | null; closureNoticeId: string | null } = { cycleAfter: null, closureNoticeId: null }
  const txnFailure = await adminDb.runTransaction(async (txn): Promise<TransitionResult | null> => {
    const freshDraft = await txn.get(draftRef)
    if (!freshDraft.exists) {
      return { success: false, error: 'Event not found', statusCode: 404 }
    }
    const freshStatus = deriveLifecycleStatus(freshDraft.data() as Record<string, unknown>)
    if (!isValidTransition(freshStatus, newStatus)) {
      return {
        success:    false,
        error:      `Cannot transition from '${freshStatus}' to '${newStatus}'`,
        statusCode: 409,
      }
    }
    // ── RD-REVIEW-02 — preconditions on the TRANSACTIONAL snapshot ──
    const fresh0 = freshDraft.data() as Record<string, unknown>
    // An admin decision answers only an event that is pending review, and a review closure only one
    // whose changes were requested — whatever else the generic machine would allow (approve and
    // reopen-registrations share the target 'published'; reject and a draft share 'draft').
    const requiredStatus: EventLifecycleStatus | undefined = opts.expectedStatus
      ?? (ADMIN_REVIEW_ACTIONS.has(action) ? 'pending_review' : isClosure ? 'changes_requested' : undefined)
    if (requiredStatus && freshStatus !== requiredStatus) {
      return { success: false, error: `This event is '${freshStatus}', not '${requiredStatus}'. Reload and try again.`, statusCode: 409, code: 'STATUS_CHANGED' }
    }
    // An event whose changes were requested is closed ONLY through the review closure (owner-only,
    // confirmed, recorded as reviewClosure). An ordinary cancel would leave no marker, and a cancelled
    // → archived → restored → republished event would then escape the review deadline.
    if (action === 'cancel' && freshStatus === 'changes_requested') {
      return { success: false, error: 'This event is waiting for the changes RegisterDesk requested. Edit and resubmit it, or use Close Event.', statusCode: 409, code: 'USE_CLOSE_EVENT' }
    }
    if (blockedByReviewClosure(action) && isReviewClosed(fresh0)) {
      return { success: false, error: 'This event was closed during review and can no longer be resubmitted, restored or republished.', statusCode: 409, code: 'REVIEW_CLOSED' }
    }
    const storedCycle = reviewCycleOf(fresh0)
    if (opts.expectedCycleId !== undefined && storedCycle !== opts.expectedCycleId) {
      return { success: false, error: 'This review is out of date: the event was resubmitted or changed since it was loaded. Reload and review the current version.', statusCode: 409, code: 'REVIEW_CYCLE_STALE' }
    }
    // A deadline belongs to one cycle; one left over from another cycle is not this event's deadline.
    const rawDeadline = readReviewDeadline(fresh0.reviewDeadline)
    const deadline = rawDeadline && rawDeadline.cycleId === storedCycle ? rawDeadline : null
    if ((action === 'resubmit' || action === 'close_review') && freshStatus === 'changes_requested' && deadline && reviewDeadlinePassed(deadline, nowMs)) {
      return { success: false, error: 'The deadline for these changes has passed, so the event is being closed. It can no longer be resubmitted.', statusCode: 409, code: 'DEADLINE_PASSED' }
    }
    if (action === 'expire_review' && !(deadline && deadline.phase === 'action_required' && deadline.actionDueAt !== null && nowMs >= deadline.actionDueAt)) {
      return { success: false, error: 'The review deadline has not passed.', statusCode: 409, code: 'NOT_DUE' }
    }
    // All reads must precede writes: read the public event doc before staging updates.
    let eventExists = false
    let eventData: Record<string, unknown> | undefined
    if (eventRef) {
      const eventSnap = await txn.get(eventRef)
      eventExists = eventSnap.exists
      eventData   = eventSnap.data()
      // RD-CE-FIX C1 · the slug came from the client-writable draft. A live document that is not
      // THIS workspace's event for THIS draft is never touched, and the transition is refused so
      // the draft cannot drift from its real live page.
      if (eventExists && !liveEventBelongsTo(eventSnap.data(), uid, eventId)) {
        return { success: false, error: 'Event not found', statusCode: 404 }
      }
      // RD-REVIEW-02 — an admin decision is about the reviewed (live) document: it must agree with
      // the draft, so a decision can never land on an event whose live state moved underneath it.
      if (ADMIN_REVIEW_ACTIONS.has(action) && eventExists && eventData && deriveLifecycleStatus(eventData) !== freshStatus) {
        return { success: false, error: 'This event changed while it was being reviewed. Reload and try again.', statusCode: 409, code: 'STATUS_CHANGED' }
      }
    }
    let contentUpdate: Record<string, unknown> = {}
    if (syncsContent && eventRef && eventExists && eventData && slug) {
      const counterSnap = counterRef ? await txn.get(counterRef) : null
      const sync = buildLiveContentSync(
        freshDraft.data() as Record<string, unknown>,
        eventData,
        slug,
        (counterSnap?.data()?.passCounts ?? {}) as Record<string, number>,
      )
      // A refused copy refuses the whole transition: nothing is written, the event stays where it
      // was, and the organizer is told what to undo — the same answer Save Changes gives.
      if (!sync.ok) return { success: false, error: sync.message, statusCode: sync.status }
      contentUpdate  = sync.update
      contentChanged = sync.changed
      contentRevised = revisedSections(eventData, sync.update)
    }
    const fresh = freshDraft.data() as Record<string, unknown>
    if (action === 'resubmit') {
      // The request being answered is cleared above, so keep it as `lastReviewRequest` — what the
      // Super Admin compares the resubmission against. Read from the transactional snapshot.
      const rejected = fresh.reviewStatus === 'rejected'
      const lastReviewRequest = {
        kind:    rejected ? 'rejected' : 'changes_requested',
        comment: (rejected ? fresh.rejectionReason : fresh.changesComment) ?? null,
        at:      (rejected ? fresh.rejectedAt : fresh.changesRequestedAt) ?? null,
      }
      draftUpdate.lastReviewRequest = lastReviewRequest
      eventUpdate.lastReviewRequest = lastReviewRequest
    }
    // ── RD-REVIEW-02 — cycle / deadline / closure writes (from the transactional snapshot) ──
    // The cycle this transition belongs to: a new one when it starts a cycle; otherwise the stored
    // one (a change request on an event submitted before cycles existed opens one now, so its
    // deadline is bound to something every later step can compare against).
    let cycleAfter: string | null = startsCycle ? newCycleId : storedCycle
    let entryDueAt: number | null = null
    if (action === 'request_changes') {
      if (!cycleAfter) {
        cycleAfter = newCycleId
        draftUpdate.reviewCycleId = newCycleId
        eventUpdate.reviewCycleId = newCycleId
      }
      // The first 24-hour window starts with THIS commit (a failed transaction leaves no deadline).
      const dl = newChangesDeadline(cycleAfter, nowMs)
      draftUpdate.reviewDeadline       = storedDeadline(dl)
      eventUpdate.reviewDeadline       = storedDeadline(dl)
      eventUpdate.reviewDeadlineNextAt = Timestamp.fromMillis(nextDeadlineAt(dl))
      entryDueAt = dl.changesDueAt
    }
    let closureNotice: OutboxMessageInput | null = null
    if (isClosure) {
      const source = action === 'close_review' ? 'organizer' as const : 'deadline_expired' as const
      const closure = {
        source, cycleId: storedCycle, closedAt: nowTs,
        closedBy: action === 'close_review' ? (actorUid ?? uid) : null, reason: opts.closureReason ?? null,
      }
      draftUpdate.reviewClosure = closure
      eventUpdate.reviewClosure = closure
      entryDueAt = deadline?.actionDueAt ?? null
      if (storedCycle) {
        closureNotice = reviewClosedNotice({
          organizerUid: uid, draftId: eventId, cycleId: storedCycle, eventName: eventNameOf(fresh0),
          changesComment: typeof fresh0.changesComment === 'string' ? fresh0.changesComment : '', source, closedAtMs: nowMs,
        })
      }
    }
    if (historyRef && eventExists && isReviewHistoryAction(action)) {
      const role = reviewActorRole(action)
      txn.set(historyRef, {
        ...buildReviewHistoryEntry({
          // An admin decision is attributed only to the admin the route names — never defaulted to
          // the organizer. Only an organizer action may fall back to the workspace owner; a system
          // action has no actor.
          action, fromStatus: freshStatus, toStatus: newStatus,
          actorUid: role === 'system' ? null : actorUid ?? (role === 'organizer' ? uid : null),
          comment: review?.changesComment,
          reason: isClosure ? opts.closureReason : review?.rejectionReason,
          category: review?.rejectionCategory, notes: review?.rejectionNotes,
          changedFields: contentChanged, revisedSections: contentRevised,
          cycleId: cycleAfter, dueAt: entryDueAt,
        }),
        at: FieldValue.serverTimestamp(),
      })
      reviewEntryId = historyRef.id
    }
    txn.update(draftRef, draftUpdate)
    if (eventRef && eventExists) txn.update(eventRef, { ...contentUpdate, ...eventUpdate })
    if (reviewAlert) stageOutboxMessage(txn, reviewAlert)
    if (closureNotice) stageOutboxMessage(txn, closureNotice)
    if (opts.audit) {
      stageAdminAudit(txn, {
        ...opts.audit,
        correlation: { ...(opts.audit.correlation ?? {}), draftId: eventId, slug: slug ?? null, reviewCycleId: cycleAfter, reviewEntryId: reviewEntryId ?? null },
      })
    }
    staged = { cycleAfter, closureNoticeId: closureNotice?.id ?? null }
    return null   // success — writes staged for commit
  })
  if (txnFailure) return txnFailure   // a concurrent change / precondition failed the transition
  if (reviewAlert) scheduleOutboxDelivery(reviewAlert.id)
  if (staged.closureNoticeId) scheduleOutboxDelivery(staged.closureNoticeId)

  // Schedule / venue changes carried by the copy get the same change-log entry Save Changes
  // writes (fire-and-forget; never fails the transition).
  if (syncsContent && slug && contentChanged.length > 0) {
    void adminDb.collection('events').doc(slug).collection('changeLog').add({
      changedFields: contentChanged,
      changedAt:     FieldValue.serverTimestamp(),
      changedBy:     actorUid ?? uid,
    }).catch(() => { /* best-effort change log */ })
  }

  // ── 7. Audit (fire-and-forget) — archive / restore only ───────────────────
  // Uses the existing organizer audit collection (teamAuditLogs), the same one the
  // delete route writes to. Never blocks or fails the transition.
  if (action === 'archive' || action === 'restore') {
    void adminDb.collection('teamAuditLogs').add({
      organizerUid: uid,
      actorUid:     actorUid ?? uid,
      action:       action === 'archive' ? 'event.archived' : 'event.restored',
      entityType:   'event',
      entityId:     eventId,
      metadata:     { slug: slug ?? null, lifecycleStatus: newStatus },
      createdAt:    FieldValue.serverTimestamp(),
    }).catch(() => { /* best-effort audit */ })
  }

  return { success: true, lifecycleStatus: newStatus, statusCode: 200, reviewEntryId, reviewCycleId: staged.cycleAfter }
}

// ─── RD-REVIEW-02 · review deadline scheduler step ────────────────────────────

export type DeadlineAdvanceOutcome =
  | 'reminder_sent' | 'action_required' | 'closed'
  | 'not_due' | 'stale_cleared' | 'skipped' | 'missing' | 'failed'

/**
 * Takes the ONE step that is due for this event's review deadline (a reminder, the move into Action
 * Required, or the closure), or nothing. Idempotent and safe to run concurrently: every step
 * re-reads the draft inside a transaction and compares status, review cycle and deadline state
 * before writing, and the reminder / phase record is written in the same transaction as its
 * notice — so a repeated or overlapping run finds nothing left to do. Never moves money.
 */
export async function advanceReviewDeadline(uid: string, draftId: string, slug: string, nowMs = Date.now()): Promise<DeadlineAdvanceOutcome> {
  const draftRef = adminDb.doc(`users/${uid}/eventDrafts/${draftId}`)
  const eventRef = adminDb.collection('events').doc(slug)
  let notice: OutboxMessageInput | null = null
  let close: { cycleId: string } | null = null
  const outcome = await adminDb.runTransaction(async (txn): Promise<DeadlineAdvanceOutcome> => {
    notice = null; close = null
    const [ds, es] = await Promise.all([txn.get(draftRef), txn.get(eventRef)])
    if (!ds.exists || !es.exists) return 'missing'
    if (!liveEventBelongsTo(es.data(), uid, draftId)) return 'missing'
    const d = ds.data() as Record<string, unknown>
    const cycle = reviewCycleOf(d)
    const dl = readReviewDeadline(d.reviewDeadline)
    // Not (or no longer) in a deadline: clear the scheduler pointer so it is never picked up again.
    if (deriveLifecycleStatus(d) !== 'changes_requested' || !dl || dl.cycleId !== cycle || isReviewClosed(d)) {
      txn.update(eventRef, { reviewDeadlineNextAt: null })
      return 'stale_cleared'
    }
    const step = nextDeadlineStep(dl, nowMs)
    if (!step) {
      txn.update(eventRef, { reviewDeadlineNextAt: Timestamp.fromMillis(nextDeadlineAt(dl)) })
      return 'not_due'
    }
    if (step.kind === 'close') { close = { cycleId: dl.cycleId }; return 'closed' }

    const base = {
      organizerUid: uid, draftId, cycleId: dl.cycleId, eventName: eventNameOf(d),
      changesComment: typeof d.changesComment === 'string' ? d.changesComment : '',
    }
    const next = step.kind === 'reminder' ? markReminders(dl, step.covers, nowMs) : enterActionRequired(dl, nowMs)
    notice = step.kind === 'reminder'
      ? reviewReminderNotice({ ...base, key: step.key, dueAtMs: currentDueAt(next) })
      : actionRequiredNotice({ ...base, closesAtMs: next.actionDueAt ?? currentDueAt(next) })
    const stored = storedDeadline(next)
    txn.update(draftRef, { reviewDeadline: stored, updatedAt: FieldValue.serverTimestamp() })
    txn.update(eventRef, { reviewDeadline: stored, reviewDeadlineNextAt: Timestamp.fromMillis(nextDeadlineAt(next)) })
    txn.set(eventRef.collection(REVIEW_HISTORY).doc(), {
      ...buildReviewHistoryEntry({
        action: step.kind === 'reminder' ? 'review_reminder' : 'action_required',
        fromStatus: 'changes_requested', toStatus: 'changes_requested', actorUid: null,
        cycleId: dl.cycleId, reminder: step.kind === 'reminder' ? step.key : null, dueAt: currentDueAt(next),
      }),
      at: FieldValue.serverTimestamp(),
    })
    if (step.kind === 'enter_action_required') {
      stageAdminAudit(txn, {
        adminUid: 'system', actorRole: 'system', action: 'event.review_action_required', entityType: 'event', entityId: slug,
        before: { phase: 'changes_requested', changesDueAt: dl.changesDueAt }, after: { phase: 'action_required', actionDueAt: next.actionDueAt },
        correlation: { draftId, slug, organizerUid: uid, reviewCycleId: dl.cycleId },
      })
    }
    stageOutboxMessage(txn, notice)
    return step.kind === 'reminder' ? 'reminder_sent' : 'action_required'
  }).catch((err): DeadlineAdvanceOutcome => {
    console.error('[review-deadline] step failed:', { slug, draftId, err })
    return 'failed'
  })
  const staged = notice as OutboxMessageInput | null
  if (outcome !== 'failed' && staged) scheduleOutboxDelivery(staged.id)
  const pendingClose = close as { cycleId: string } | null
  if (outcome === 'closed' && pendingClose) {
    // The closure is the shared lifecycle transition: it re-checks status, cycle and that the second
    // deadline really passed, inside its own transaction (a resubmission or an approval that won the
    // race makes it a no-op refusal).
    const r = await applyLifecycleTransition(uid, draftId, 'expire_review', undefined, undefined, undefined, {
      expectedStatus: 'changes_requested', expectedCycleId: pendingClose.cycleId,
      audit: {
        adminUid: 'system', actorRole: 'system', action: 'event.review_expired', entityType: 'event', entityId: slug,
        reason: 'Requested changes were not submitted before the second deadline',
        before: { lifecycleStatus: 'changes_requested', phase: 'action_required' }, after: { lifecycleStatus: 'cancelled', reviewClosure: 'deadline_expired' },
      },
    }).catch(err => { console.error('[review-deadline] closure failed:', { slug, draftId, err }); return null })
    if (!r) return 'failed'
    return r.success ? 'closed' : 'skipped'
  }
  return outcome
}
