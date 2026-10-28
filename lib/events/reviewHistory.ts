// RD-REVIEW-01 — the append-only review history of a submitted event. Server-only.
//
//   events/{slug}/reviewHistory/{entryId}
//     { action, fromStatus, toStatus, actorUid, actorRole, comment, reason, category, notes,
//       changedFields, revisedSections, at }
//
// WHY: the event documents hold only the CURRENT review state. `changesComment` and the
// rejection fields are cleared on resubmit (so a resubmitted event no longer reads as
// "changes requested"), and `changesRequestedAt` / `resubmittedAt` keep only the LATEST time —
// so a second review cycle erased the first, and nothing recorded who resubmitted. Each review
// transition now also appends one entry here, staged inside applyLifecycleTransition's
// transaction: an entry exists if and only if the transition persisted.
//
// Visibility: Admin SDK only (no firestore.rules match → default deny). `notes` is the admin's
// internal rejection note and is never part of an organizer-facing view.

import { adminDb } from '@/lib/firebase/admin'
import type { EventLifecycleStatus, LifecycleAction } from '@/types/events'

export const REVIEW_HISTORY = 'reviewHistory'
export const REVIEW_HISTORY_READ_LIMIT = 100

// RD-REVIEW-02 — also: the first submission ('submit'), the deadline steps the scheduler takes
// ('review_reminder', 'action_required'), and the two review closures ('close_review' by the owner,
// 'expire_review' by the system). Every entry carries the review cycle it belongs to.
export type ReviewHistoryAction =
  | 'submit' | 'approve' | 'reject' | 'request_changes' | 'resubmit' | 'republish'
  | 'review_reminder' | 'action_required' | 'close_review' | 'expire_review'
export type ReviewActorRole = 'admin' | 'organizer' | 'system'

const ADMIN_ACTIONS     = new Set<string>(['approve', 'reject', 'request_changes'])
const ORGANIZER_ACTIONS = new Set<string>(['submit', 'resubmit', 'republish', 'close_review'])
const SYSTEM_ACTIONS    = new Set<string>(['review_reminder', 'action_required', 'expire_review'])
/** Organizer actions that carry a content comparison (changedFields / revisedSections). */
const CONTENT_ACTIONS   = new Set<string>(['resubmit', 'republish'])

/** True for the lifecycle transitions that are part of the review workflow (and so are recorded). */
export function isReviewHistoryAction(action: LifecycleAction): action is LifecycleAction & ReviewHistoryAction {
  return ADMIN_ACTIONS.has(action) || ORGANIZER_ACTIONS.has(action) || SYSTEM_ACTIONS.has(action)
}

export function reviewActorRole(action: ReviewHistoryAction): ReviewActorRole {
  return ADMIN_ACTIONS.has(action) ? 'admin' : SYSTEM_ACTIONS.has(action) ? 'system' : 'organizer'
}

export interface ReviewHistoryInput {
  action:         ReviewHistoryAction
  fromStatus:     EventLifecycleStatus
  toStatus:       EventLifecycleStatus
  actorUid:       string | null   // null = an admin action whose caller did not name the admin
  comment?:       string | null   // request_changes
  reason?:        string | null   // reject (shown to the organizer)
  category?:      string | null   // reject
  notes?:         string | null   // reject — INTERNAL, admin-only
  changedFields?: string[]        // resubmit / republish — schedule / venue fields that changed
  revisedSections?: string[]      // resubmit / republish — every content section that changed
  /** RD-REVIEW-02 — the review cycle this entry belongs to (null for events from before cycles). */
  cycleId?:       string | null
  /** RD-REVIEW-02 — review_reminder: which reminder (h12 | h22 | ar20). */
  reminder?:      string | null
  /** RD-REVIEW-02 — the deadline (epoch ms) a deadline entry announced or enforced. */
  dueAt?:         number | null
}

// ─── What a resubmission revised ──────────────────────────────────────────────

/** JSON with object keys sorted, so two equal values always compare equal as strings. */
function stable(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
}

/**
 * The content sections a resubmission changed on the reviewed (live) document: one entry per
 * `eventDetails` section (info, schedule, venue, media, …) and per other content field. Compares
 * the live document BEFORE the copy with the copy itself, so it reports exactly what the reviewer
 * will now see differently. Timestamps are not content and are not compared.
 */
export function revisedSections(before: Record<string, unknown>, update: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of Object.keys(update).sort()) {
    const next = update[key]
    const prev = before[key]
    if (key === 'eventDetails' && next && typeof next === 'object' && !Array.isArray(next)) {
      const n = next as Record<string, unknown>
      const p = (prev && typeof prev === 'object' ? prev : {}) as Record<string, unknown>
      for (const sub of Array.from(new Set([...Object.keys(n), ...Object.keys(p)])).sort()) {
        if (stable(n[sub]) !== stable(p[sub])) out.push(`eventDetails.${sub}`)
      }
    } else if (stable(next) !== stable(prev)) {
      out.push(key)
    }
  }
  return out
}

/** The stored shape, minus `at` (the caller adds the server timestamp). */
export function buildReviewHistoryEntry(i: ReviewHistoryInput): Record<string, unknown> {
  const clean = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    action:        i.action,
    fromStatus:    i.fromStatus,
    toStatus:      i.toStatus,
    actorUid:      i.actorUid,
    actorRole:     reviewActorRole(i.action),
    comment:       i.action === 'request_changes' ? clean(i.comment) : null,
    // A closure's reason is organizer-visible (who / why the event was closed); a rejection's
    // reason is the one already shown to the organizer.
    reason:        i.action === 'reject' || i.action === 'close_review' || i.action === 'expire_review' ? clean(i.reason) : null,
    category:      i.action === 'reject' ? clean(i.category) : null,
    notes:         i.action === 'reject' ? clean(i.notes) : null,
    changedFields: CONTENT_ACTIONS.has(i.action) && Array.isArray(i.changedFields) ? i.changedFields.slice(0, 50) : [],
    revisedSections: CONTENT_ACTIONS.has(i.action) && Array.isArray(i.revisedSections) ? i.revisedSections.slice(0, 50) : [],
    cycleId:       clean(i.cycleId),
    reminder:      i.action === 'review_reminder' ? clean(i.reminder) : null,
    dueAt:         typeof i.dueAt === 'number' && Number.isFinite(i.dueAt) ? i.dueAt : null,
  }
}

// ─── Read model ───────────────────────────────────────────────────────────────

export interface ReviewHistoryItem {
  id:            string
  action:        ReviewHistoryAction
  fromStatus:    string | null
  toStatus:      string | null
  actorUid:      string | null
  actorRole:     ReviewActorRole | null
  comment:       string | null
  reason:        string | null
  category:      string | null
  notes:         string | null
  changedFields: string[]
  revisedSections: string[]
  cycleId:       string | null
  reminder:      string | null
  dueAt:         string | null
  at:            string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    try { return (ts as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  return null
}

export function toReviewHistoryItem(id: string, x: Record<string, unknown>): ReviewHistoryItem {
  const role = x.actorRole === 'admin' || x.actorRole === 'organizer' || x.actorRole === 'system' ? x.actorRole : null
  const dueAt = typeof x.dueAt === 'number' && Number.isFinite(x.dueAt) ? new Date(x.dueAt).toISOString() : null
  return {
    id,
    action:        x.action as ReviewHistoryAction,
    fromStatus:    str(x.fromStatus),
    toStatus:      str(x.toStatus),
    actorUid:      str(x.actorUid),
    actorRole:     role,
    comment:       str(x.comment),
    reason:        str(x.reason),
    category:      str(x.category),
    notes:         str(x.notes),
    changedFields: Array.isArray(x.changedFields) ? x.changedFields.filter((f): f is string => typeof f === 'string') : [],
    revisedSections: Array.isArray(x.revisedSections) ? x.revisedSections.filter((f): f is string => typeof f === 'string') : [],
    cycleId:       str(x.cycleId),
    reminder:      str(x.reminder),
    dueAt,
    at:            tsToISO(x.at),
  }
}

/** Newest first, bounded. Never throws — an unreadable history is an empty one. */
export async function readReviewHistory(slug: string, limit = REVIEW_HISTORY_READ_LIMIT): Promise<ReviewHistoryItem[]> {
  try {
    const snap = await adminDb.collection('events').doc(slug).collection(REVIEW_HISTORY)
      .orderBy('at', 'desc').limit(limit).get()
    return snap.docs.map(d => toReviewHistoryItem(d.id, d.data() as Record<string, unknown>))
  } catch (err) {
    console.error('[reviewHistory] read failed:', slug, err)
    return []
  }
}

/** The most recent admin request the organizer was asked to address, if any. */
export function latestReviewRequest(items: ReviewHistoryItem[]): ReviewHistoryItem | null {
  return items.find(i => i.action === 'request_changes' || i.action === 'reject') ?? null
}
