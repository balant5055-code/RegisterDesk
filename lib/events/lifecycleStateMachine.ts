// Pure event-lifecycle state machine — NO side effects, NO Firebase import.
// Extracted from lifecycle.ts so it can be unit-tested in isolation (the rest of
// lifecycle.ts pulls in the Admin SDK). lifecycle.ts re-exports these, so every
// existing importer of '@/lib/events/lifecycle' is unaffected.

import type { EventLifecycleStatus, LifecycleAction } from '@/types/events'

// ─── State machine ────────────────────────────────────────────────────────────

export const VALID_TRANSITIONS: Partial<Record<EventLifecycleStatus, EventLifecycleStatus[]>> = {
  // A previously-submitted event that was rejected sits in 'draft' but its event
  // doc + license already exist, so 'resubmit' (draft → pending_review) is valid.
  draft:                ['pending_review'],
  pending_review:       ['published', 'draft', 'changes_requested', 'cancelled'],
  changes_requested:    ['pending_review', 'draft', 'cancelled'],
  // Unpublish now takes a live event to 'unpublished' (NOT 'draft'). The event
  // doc + paid Event License are preserved for a payment-free republish.
  published:            ['registration_closed', 'completed', 'cancelled', 'archived', 'unpublished'],
  registration_closed:  ['published', 'cancelled'],
  completed:            ['archived'],
  cancelled:            ['archived'],
  // Republish: an unpublished event goes back through admin review (never straight
  // to published) — a pure lifecycle transition that reuses the existing license.
  unpublished:          ['pending_review'],
  // Restore: an archived event returns to the PRIVATE 'unpublished' state (never
  // straight back to public). Re-launch is then the normal republish → review flow.
  archived:             ['unpublished'],
  // First submit (draft → published/pending_review) is handled by /api/events/publish.
  // approve = pending_review → published, reject = pending_review → draft,
  // request_changes = pending_review → changes_requested, resubmit → pending_review,
  // republish = unpublished → pending_review.
}

export function targetStatus(action: LifecycleAction): EventLifecycleStatus {
  switch (action) {
    case 'close_registrations':  return 'registration_closed'
    case 'reopen_registrations': return 'published'
    case 'complete':             return 'completed'
    case 'cancel':               return 'cancelled'
    case 'archive':              return 'archived'
    case 'unpublish':            return 'unpublished'
    case 'approve':              return 'published'
    case 'reject':               return 'draft'
    case 'request_changes':      return 'changes_requested'
    case 'resubmit':             return 'pending_review'
    case 'republish':            return 'pending_review'
    case 'restore':              return 'unpublished'
  }
}

export function isValidTransition(from: EventLifecycleStatus, to: EventLifecycleStatus): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to)
}

// ─── Derive lifecycleStatus from a raw Firestore document ─────────────────────
// Used for backward-compat: documents written before lifecycleStatus existed.

export function deriveLifecycleStatus(d: Record<string, unknown>): EventLifecycleStatus {
  if (typeof d.lifecycleStatus === 'string') return d.lifecycleStatus as EventLifecycleStatus
  // The legacy `status` field carries draft | pending_review | published — map it
  // faithfully. A draft still under review must NOT be treated as 'published'
  // (that mis-read was the root cause of the "'published' → 'published'" error).
  const s = typeof d.status === 'string' ? d.status : ''
  if (s === 'draft' || s === 'pending_review' || s === 'published') {
    return s as EventLifecycleStatus
  }
  return 'published'   // very old docs with no recognizable status → assume live
}
