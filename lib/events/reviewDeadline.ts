// RD-REVIEW-02 — the two 24-hour deadlines after a Super Admin requests changes. PURE: no Firebase
// import, safe on the client (countdown, tabs) and the server (transitions, cron).
//
//   request_changes ──► phase 'changes_requested'  (first window, 24 h from the request)
//                         reminders at +12 h and +22 h
//   first deadline  ──► phase 'action_required'    (second window, 24 h from that transition)
//                         notice on entry, reminder 4 h before closure
//   second deadline ──► closed ('expire_review' → lifecycleStatus 'cancelled' + reviewClosure)
//
// The lifecycle status stays 'changes_requested' through both windows: Action Required is a phase
// (lib/registrations/gate.ts and lib/broadcasts/executionGuard.ts deny by listing not-live statuses,
// so a new status would read as live). The deadline is bound to the review cycle it was set for;
// every transition compares that cycle inside its transaction.
//
// Boundaries: a deadline has passed when now >= dueAt. The browser countdown is display only —
// the server decides with these same functions.

import type { ReviewDeadlinePhase } from '@/types/events'

export const HOUR_MS = 60 * 60 * 1000
export const REVIEW_WINDOW_MS = 24 * HOUR_MS

export type ReviewReminderKey = 'h12' | 'h22' | 'ar20'

/** First-window reminders, measured from the change request (approximately 12 h and 22 h). */
const FIRST_WINDOW_REMINDERS: ReadonlyArray<{ key: ReviewReminderKey; afterMs: number }> = [
  { key: 'h12', afterMs: 12 * HOUR_MS },
  { key: 'h22', afterMs: 22 * HOUR_MS },
]
/** Second-window reminder, measured from the Action Required transition (4 h before closure). */
const SECOND_WINDOW_REMINDER: { key: ReviewReminderKey; afterMs: number } = { key: 'ar20', afterMs: 20 * HOUR_MS }

/** The deadline as the code reasons about it: every instant in epoch milliseconds. */
export interface ReviewDeadline {
  cycleId:            string
  phase:              ReviewDeadlinePhase
  changesRequestedAt: number
  changesDueAt:       number
  actionRequiredAt:   number | null
  actionDueAt:        number | null
  remindersSent:      Partial<Record<ReviewReminderKey, number>>
}

/** The next thing the scheduler must do for a deadline. */
export type ReviewDeadlineStep =
  | { kind: 'reminder'; key: ReviewReminderKey; covers: ReviewReminderKey[] }
  | { kind: 'enter_action_required' }
  | { kind: 'close' }

/** Firestore Timestamp, a serialized draft's number, or an ISO string → ms (else null). */
export function toMillis(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    try { return (v as { toMillis: () => number }).toMillis() } catch { return null }
  }
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t }
  return null
}

/** Reads a stored deadline (draft, event doc, or a serialized API row). Null when absent or malformed. */
export function readReviewDeadline(raw: unknown): ReviewDeadline | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const phase = r.phase === 'changes_requested' || r.phase === 'action_required' ? r.phase : null
  const cycleId = typeof r.cycleId === 'string' && r.cycleId ? r.cycleId : null
  const requested = toMillis(r.changesRequestedAt)
  const due = toMillis(r.changesDueAt)
  if (!phase || !cycleId || requested === null || due === null) return null
  const actionRequiredAt = toMillis(r.actionRequiredAt)
  const actionDueAt = toMillis(r.actionDueAt)
  if (phase === 'action_required' && (actionRequiredAt === null || actionDueAt === null)) return null
  const sentRaw = (r.remindersSent && typeof r.remindersSent === 'object' ? r.remindersSent : {}) as Record<string, unknown>
  const remindersSent: ReviewDeadline['remindersSent'] = {}
  for (const k of ['h12', 'h22', 'ar20'] as const) {
    const t = toMillis(sentRaw[k])
    if (t !== null) remindersSent[k] = t
  }
  return { cycleId, phase, changesRequestedAt: requested, changesDueAt: due, actionRequiredAt, actionDueAt, remindersSent }
}

/** A new first-window deadline for a change request made at `nowMs`. */
export function newChangesDeadline(cycleId: string, nowMs: number): ReviewDeadline {
  return {
    cycleId, phase: 'changes_requested',
    changesRequestedAt: nowMs, changesDueAt: nowMs + REVIEW_WINDOW_MS,
    actionRequiredAt: null, actionDueAt: null, remindersSent: {},
  }
}

/** The deadline after the first window expired at `nowMs`: the second window starts now. */
export function enterActionRequired(d: ReviewDeadline, nowMs: number): ReviewDeadline {
  return { ...d, phase: 'action_required', actionRequiredAt: nowMs, actionDueAt: nowMs + REVIEW_WINDOW_MS }
}

/**
 * The instant after which the organizer can no longer resubmit or close voluntarily. Normally the
 * second deadline; if the scheduler has not yet opened the second window, it is the first deadline
 * plus one window — so a stalled scheduler never extends the total time.
 */
export function finalDueAt(d: ReviewDeadline): number {
  return d.actionDueAt ?? d.changesDueAt + REVIEW_WINDOW_MS
}

/** True once the organizer's last chance has passed (resubmission / voluntary close refused). */
export function reviewDeadlinePassed(d: ReviewDeadline, nowMs: number): boolean {
  return nowMs >= finalDueAt(d)
}

/** The deadline the organizer currently works against (the countdown target). */
export function currentDueAt(d: ReviewDeadline): number {
  return d.phase === 'action_required' && d.actionDueAt !== null ? d.actionDueAt : d.changesDueAt
}

/**
 * What the scheduler must do now, or null when nothing is due yet. When several reminders fell due
 * together (a late scheduler), only the latest is sent and the earlier ones are recorded as covered
 * — the organizer never receives a burst of stale reminders.
 */
export function nextDeadlineStep(d: ReviewDeadline, nowMs: number): ReviewDeadlineStep | null {
  if (d.phase === 'changes_requested') {
    if (nowMs >= d.changesDueAt) return { kind: 'enter_action_required' }
    const due = FIRST_WINDOW_REMINDERS.filter(r => d.remindersSent[r.key] === undefined && nowMs >= d.changesRequestedAt + r.afterMs)
    if (due.length === 0) return null
    return { kind: 'reminder', key: due[due.length - 1].key, covers: due.map(r => r.key) }
  }
  if (d.actionDueAt === null || d.actionRequiredAt === null) return null
  if (nowMs >= d.actionDueAt) return { kind: 'close' }
  const r = SECOND_WINDOW_REMINDER
  if (d.remindersSent[r.key] === undefined && nowMs >= d.actionRequiredAt + r.afterMs) return { kind: 'reminder', key: r.key, covers: [r.key] }
  return null
}

/** When the scheduler must next look at this deadline (stored as `reviewDeadlineNextAt`). */
export function nextDeadlineAt(d: ReviewDeadline): number {
  if (d.phase === 'changes_requested') {
    const pending = FIRST_WINDOW_REMINDERS.filter(r => d.remindersSent[r.key] === undefined).map(r => d.changesRequestedAt + r.afterMs)
    return Math.min(d.changesDueAt, ...pending)
  }
  const due = d.actionDueAt ?? d.changesDueAt + REVIEW_WINDOW_MS
  const reminderAt = d.actionRequiredAt !== null && d.remindersSent.ar20 === undefined ? d.actionRequiredAt + SECOND_WINDOW_REMINDER.afterMs : Infinity
  return Math.min(due, reminderAt)
}

/** Records that a reminder (and any it covers) was sent at `nowMs`. */
export function markReminders(d: ReviewDeadline, keys: ReviewReminderKey[], nowMs: number): ReviewDeadline {
  const remindersSent = { ...d.remindersSent }
  for (const k of keys) remindersSent[k] = nowMs
  return { ...d, remindersSent }
}

// ─── Display ──────────────────────────────────────────────────────────────────

/** Countdown urgency: neutral > 12 h, warning 4–12 h, critical < 4 h, expired at or after the deadline. */
export type DeadlineTone = 'neutral' | 'warning' | 'critical' | 'expired'

export function deadlineTone(remainingMs: number): DeadlineTone {
  if (remainingMs <= 0) return 'expired'
  if (remainingMs < 4 * HOUR_MS) return 'critical'
  if (remainingMs <= 12 * HOUR_MS) return 'warning'
  return 'neutral'
}

/** "5h 03m 09s" — hours are not rolled into days (a window is at most 24 h). Never negative. */
export function formatRemaining(remainingMs: number): string {
  const s = Math.max(0, Math.floor(remainingMs / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`
}

/**
 * The deadline phase of an event document, for listing and cards: 'action_required' only while the
 * event is still in changes_requested and its deadline is in the second phase. Legacy events
 * (no deadline) are never Action Required.
 */
export function reviewPhaseOf(lifecycleStatus: string, rawDeadline: unknown): ReviewDeadlinePhase | null {
  if (lifecycleStatus !== 'changes_requested') return null
  return readReviewDeadline(rawDeadline)?.phase ?? null
}
