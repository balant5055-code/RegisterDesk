// Server-only: uses Firebase Admin SDK.
// Contains the event lifecycle state machine and the shared transition function
// called by the status / cancel / archive API routes.

import { FieldValue }    from 'firebase-admin/firestore'
import { adminDb }       from '@/lib/firebase/admin'
import type { EventLifecycleStatus, LifecycleAction, EventReviewMeta } from '@/types/events'
import { targetStatus, isValidTransition, deriveLifecycleStatus } from './lifecycleStateMachine'

// Re-export the pure state machine so existing importers of this module are
// unaffected (the machine now lives in ./lifecycleStateMachine for testability).
export { targetStatus, isValidTransition, deriveLifecycleStatus } from './lifecycleStateMachine'
export { VALID_TRANSITIONS } from './lifecycleStateMachine'

// ─── Core transition function ─────────────────────────────────────────────────

export interface TransitionResult {
  success:          boolean
  lifecycleStatus?: EventLifecycleStatus
  error?:           string
  statusCode:       number
}

export async function applyLifecycleTransition(
  uid:           string,
  eventId:       string,
  action:        LifecycleAction,
  cancelReason?: string,
  review?:       EventReviewMeta,
  actorUid?:     string,   // caller uid for audit (defaults to uid / workspace owner)
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
    draftUpdate.rejectionNotes    = review?.rejectionNotes    ?? ''
    eventUpdate.rejectedAt        = now
    eventUpdate.reviewStatus      = 'rejected'
    eventUpdate.rejectionReason   = review?.rejectionReason   ?? ''
    eventUpdate.rejectionCategory = review?.rejectionCategory ?? ''
    eventUpdate.rejectionNotes    = review?.rejectionNotes    ?? ''
  }
  if (action === 'request_changes') {
    draftUpdate.changesRequestedAt = now
    draftUpdate.reviewStatus       = 'changes_requested'
    draftUpdate.changesComment     = review?.changesComment ?? ''
    eventUpdate.changesRequestedAt = now
    eventUpdate.reviewStatus       = 'changes_requested'
    eventUpdate.changesComment     = review?.changesComment ?? ''
  }
  if (action === 'resubmit') {
    // Organizer resubmits after edits: back to review, clearing prior review notes.
    draftUpdate.status            = 'pending_review'
    draftUpdate.publishedAt       = now   // submit time for the new review cycle
    draftUpdate.resubmittedAt     = now
    draftUpdate.reviewStatus      = null
    draftUpdate.rejectionReason   = null
    draftUpdate.rejectionCategory = null
    draftUpdate.rejectionNotes    = null
    draftUpdate.changesComment    = null
    eventUpdate.publishedAt       = now
    eventUpdate.resubmittedAt     = now
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
    draftUpdate.reviewStatus      = null
    draftUpdate.rejectionReason   = null
    draftUpdate.rejectionCategory = null
    draftUpdate.rejectionNotes    = null
    draftUpdate.changesComment    = null
    eventUpdate.publishedAt       = now
    eventUpdate.republishedAt     = now
    eventUpdate.reviewStatus      = null
    eventUpdate.rejectionReason   = null
    eventUpdate.rejectionCategory = null
    eventUpdate.rejectionNotes    = null
    eventUpdate.changesComment    = null
  }

  // ── 5. Resolve public slug (needed to update events/{slug}) ───────────────
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null

  // ── 6. Atomic batch: update draft + published event doc ───────────────────
  const batch = adminDb.batch()
  batch.update(draftRef, draftUpdate)

  if (slug) {
    const eventRef  = adminDb.collection('events').doc(slug)
    const eventSnap = await eventRef.get()
    if (eventSnap.exists) {
      batch.update(eventRef, eventUpdate)
    }
  }

  await batch.commit()

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

  return { success: true, lifecycleStatus: newStatus, statusCode: 200 }
}
