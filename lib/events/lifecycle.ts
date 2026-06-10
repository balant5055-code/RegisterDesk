// Server-only: uses Firebase Admin SDK.
// Contains the event lifecycle state machine and the shared transition function
// called by the status / cancel / archive API routes.

import { FieldValue }    from 'firebase-admin/firestore'
import { adminDb }       from '@/lib/firebase/admin'
import type { EventLifecycleStatus, LifecycleAction } from '@/types/events'

// ─── State machine ────────────────────────────────────────────────────────────

const VALID_TRANSITIONS: Partial<Record<EventLifecycleStatus, EventLifecycleStatus[]>> = {
  published:            ['registration_closed', 'completed', 'cancelled', 'draft'],
  registration_closed:  ['published', 'cancelled'],
  completed:            ['archived'],
  cancelled:            ['archived'],
  // draft → published is handled by the existing /api/events/publish endpoint
  // published → draft is the 'unpublish' action
}

export function targetStatus(action: LifecycleAction): EventLifecycleStatus {
  switch (action) {
    case 'close_registrations':  return 'registration_closed'
    case 'reopen_registrations': return 'published'
    case 'complete':             return 'completed'
    case 'cancel':               return 'cancelled'
    case 'archive':              return 'archived'
    case 'unpublish':            return 'draft'
  }
}

export function isValidTransition(from: EventLifecycleStatus, to: EventLifecycleStatus): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to)
}

// ─── Derive lifecycleStatus from a raw Firestore document ─────────────────────
// Used for backward-compat: existing documents don't have lifecycleStatus yet.

export function deriveLifecycleStatus(d: Record<string, unknown>): EventLifecycleStatus {
  if (typeof d.lifecycleStatus === 'string') return d.lifecycleStatus as EventLifecycleStatus
  if (d.status === 'draft') return 'draft'
  // Legacy published events: check eventDetails.status.status for informal states
  const details  = (d.eventDetails as Record<string, unknown>) ?? {}
  const evStatus = ((details.status as Record<string, unknown>) ?? {}).status
  if (evStatus === 'cancelled') return 'cancelled'
  return 'published'
}

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
    draftUpdate.archivedAt  = now
    eventUpdate.archivedAt  = now
  }
  if (action === 'unpublish') {
    // Reset legacy status field so dashboard's d.status === 'published' filter excludes this draft
    draftUpdate.status       = 'draft'
    draftUpdate.unpublishedAt = now
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

  return { success: true, lifecycleStatus: newStatus, statusCode: 200 }
}
