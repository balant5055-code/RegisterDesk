// RD-REVIEW-02 (unit) — the pure review-deadline rules: the two 24-hour windows, exact boundaries,
// reminders (sent once, never in a stale burst), the scheduler pointer, the countdown tones, reading
// stored / serialized deadlines, and the Action Required listing tab.

import { describe, it, expect } from 'vitest'
import {
  HOUR_MS, REVIEW_WINDOW_MS, newChangesDeadline, enterActionRequired, markReminders, nextDeadlineStep,
  nextDeadlineAt, finalDueAt, reviewDeadlinePassed, currentDueAt, readReviewDeadline, deadlineTone,
  formatRemaining, reviewPhaseOf, toMillis,
} from '@/lib/events/reviewDeadline'
import { listingTabsForDoc, eventDocInListingTab, EVENT_LISTING_TAB_KEYS } from '@/lib/events/listingTabs'

const T0 = Date.parse('2026-10-28T06:00:00.000Z')
const first = newChangesDeadline('cyc-1', T0)

describe('first window (changes requested)', () => {
  it('is due exactly 24 hours after the request, bound to its cycle', () => {
    expect(first).toMatchObject({ cycleId: 'cyc-1', phase: 'changes_requested', changesRequestedAt: T0, changesDueAt: T0 + REVIEW_WINDOW_MS, actionRequiredAt: null, actionDueAt: null, remindersSent: {} })
  })
  it('nothing is due before 12 hours', () => {
    expect(nextDeadlineStep(first, T0)).toBeNull()
    expect(nextDeadlineStep(first, T0 + 12 * HOUR_MS - 1)).toBeNull()
  })
  it('the 12-hour reminder is due at exactly +12 h, the 22-hour one at exactly +22 h', () => {
    expect(nextDeadlineStep(first, T0 + 12 * HOUR_MS)).toEqual({ kind: 'reminder', key: 'h12', covers: ['h12'] })
    const after12 = markReminders(first, ['h12'], T0 + 12 * HOUR_MS)
    expect(nextDeadlineStep(after12, T0 + 22 * HOUR_MS - 1)).toBeNull()
    expect(nextDeadlineStep(after12, T0 + 22 * HOUR_MS)).toEqual({ kind: 'reminder', key: 'h22', covers: ['h22'] })
  })
  it('a reminder already recorded is never due again (no duplicates on a repeated run)', () => {
    const sent = markReminders(markReminders(first, ['h12'], T0 + 12 * HOUR_MS), ['h22'], T0 + 22 * HOUR_MS)
    expect(nextDeadlineStep(sent, T0 + 23 * HOUR_MS)).toBeNull()
  })
  it('a late scheduler sends only the latest due reminder and records both (no stale burst)', () => {
    expect(nextDeadlineStep(first, T0 + 22.5 * HOUR_MS)).toEqual({ kind: 'reminder', key: 'h22', covers: ['h12', 'h22'] })
  })
  it('the first deadline passes at exactly +24 h (>=), not one millisecond earlier', () => {
    expect(nextDeadlineStep(markReminders(first, ['h12', 'h22'], T0), T0 + REVIEW_WINDOW_MS - 1)).toBeNull()
    expect(nextDeadlineStep(first, T0 + REVIEW_WINDOW_MS)).toEqual({ kind: 'enter_action_required' })
  })
  it('the deadline step outranks any unsent reminder once the deadline passed', () => {
    expect(nextDeadlineStep(first, T0 + 30 * HOUR_MS)).toEqual({ kind: 'enter_action_required' })
  })
})

describe('second window (Action Required)', () => {
  const AR = T0 + REVIEW_WINDOW_MS + 7 * 60_000            // the scheduler ran 7 minutes late
  const second = enterActionRequired(first, AR)
  it('starts at the transition time and lasts exactly 24 hours; the original timestamps are kept', () => {
    expect(second).toMatchObject({ phase: 'action_required', actionRequiredAt: AR, actionDueAt: AR + REVIEW_WINDOW_MS, changesRequestedAt: T0, changesDueAt: T0 + REVIEW_WINDOW_MS, cycleId: 'cyc-1' })
  })
  it('one reminder 4 hours before closure, once', () => {
    expect(nextDeadlineStep(second, AR + 20 * HOUR_MS - 1)).toBeNull()
    expect(nextDeadlineStep(second, AR + 20 * HOUR_MS)).toEqual({ kind: 'reminder', key: 'ar20', covers: ['ar20'] })
    expect(nextDeadlineStep(markReminders(second, ['ar20'], AR + 20 * HOUR_MS), AR + 23 * HOUR_MS)).toBeNull()
  })
  it('closes at exactly the second deadline', () => {
    expect(nextDeadlineStep(second, AR + REVIEW_WINDOW_MS - 1)).not.toEqual({ kind: 'close' })
    expect(nextDeadlineStep(second, AR + REVIEW_WINDOW_MS)).toEqual({ kind: 'close' })
  })
  it('the countdown targets the deadline of the current phase', () => {
    expect(currentDueAt(first)).toBe(T0 + REVIEW_WINDOW_MS)
    expect(currentDueAt(second)).toBe(AR + REVIEW_WINDOW_MS)
  })
})

describe('the organizer\'s last chance (server-decided)', () => {
  it('resubmission is allowed throughout both windows and refused at the final deadline', () => {
    const second = enterActionRequired(first, T0 + REVIEW_WINDOW_MS)
    expect(reviewDeadlinePassed(first, T0 + 30 * HOUR_MS)).toBe(false)        // late, but in the second window
    expect(reviewDeadlinePassed(second, finalDueAt(second) - 1)).toBe(false)
    expect(reviewDeadlinePassed(second, finalDueAt(second))).toBe(true)
  })
  it('a stalled scheduler never extends the total time (first deadline + 24 h)', () => {
    expect(finalDueAt(first)).toBe(T0 + 2 * REVIEW_WINDOW_MS)
    expect(reviewDeadlinePassed(first, T0 + 2 * REVIEW_WINDOW_MS)).toBe(true)
  })
})

describe('scheduler pointer', () => {
  it('points at the earliest pending step in each phase', () => {
    expect(nextDeadlineAt(first)).toBe(T0 + 12 * HOUR_MS)
    expect(nextDeadlineAt(markReminders(first, ['h12'], T0))).toBe(T0 + 22 * HOUR_MS)
    expect(nextDeadlineAt(markReminders(first, ['h12', 'h22'], T0))).toBe(T0 + REVIEW_WINDOW_MS)
    const second = enterActionRequired(markReminders(first, ['h12', 'h22'], T0), T0 + REVIEW_WINDOW_MS)
    expect(nextDeadlineAt(second)).toBe(T0 + REVIEW_WINDOW_MS + 20 * HOUR_MS)
    expect(nextDeadlineAt(markReminders(second, ['ar20'], T0))).toBe(T0 + 2 * REVIEW_WINDOW_MS)
  })
})

describe('reading a stored deadline (backward compatible)', () => {
  const ts = (ms: number) => ({ toMillis: () => ms })
  it('reads Firestore Timestamps, serialized numbers and ISO strings alike', () => {
    const stored = { cycleId: 'c', phase: 'changes_requested', changesRequestedAt: ts(T0), changesDueAt: ts(T0 + REVIEW_WINDOW_MS), actionRequiredAt: null, actionDueAt: null, remindersSent: { h12: ts(T0 + 1) } }
    expect(readReviewDeadline(stored)).toEqual({ ...first, cycleId: 'c', remindersSent: { h12: T0 + 1 } })
    expect(readReviewDeadline({ ...stored, changesRequestedAt: T0, changesDueAt: new Date(T0 + REVIEW_WINDOW_MS).toISOString() })?.changesDueAt).toBe(T0 + REVIEW_WINDOW_MS)
    expect(toMillis('not a date')).toBeNull()
  })
  it('absent, legacy or malformed data is no deadline at all', () => {
    for (const v of [undefined, null, 'x', {}, { phase: 'changes_requested' }, { cycleId: 'c', phase: 'weird', changesRequestedAt: T0, changesDueAt: T0 },
      { cycleId: 'c', phase: 'action_required', changesRequestedAt: T0, changesDueAt: T0 }]) {
      expect(readReviewDeadline(v)).toBeNull()
    }
  })
})

describe('countdown display', () => {
  it('tones: neutral > 12 h, warning 4–12 h, critical < 4 h, expired at 0', () => {
    expect(deadlineTone(12 * HOUR_MS + 1)).toBe('neutral')
    expect(deadlineTone(12 * HOUR_MS)).toBe('warning')
    expect(deadlineTone(4 * HOUR_MS)).toBe('warning')
    expect(deadlineTone(4 * HOUR_MS - 1)).toBe('critical')
    expect(deadlineTone(1)).toBe('critical')
    expect(deadlineTone(0)).toBe('expired')
    expect(deadlineTone(-5)).toBe('expired')
  })
  it('formats hours, minutes and seconds, never negative', () => {
    expect(formatRemaining(5 * HOUR_MS + 3 * 60_000 + 9_000)).toBe('5h 03m 09s')
    expect(formatRemaining(-1)).toBe('0h 00m 00s')
  })
})

describe('Action Required listing tab', () => {
  const doc = (over: Record<string, unknown>) => ({ lifecycleStatus: 'changes_requested', status: 'pending_review', ...over })
  const second = enterActionRequired(first, T0 + REVIEW_WINDOW_MS)
  it('the new tab is part of the listing SSOT', () => {
    expect(EVENT_LISTING_TAB_KEYS).toContain('action_required')
  })
  it('RD-REVIEW-03 — a changes-requested event is under Action Required in BOTH windows, never Drafts', () => {
    expect(listingTabsForDoc(doc({ reviewDeadline: first }))).toEqual(['action_required'])
    expect(listingTabsForDoc(doc({ reviewDeadline: second }))).toEqual(['action_required'])
    for (const dl of [first, second]) expect(eventDocInListingTab(doc({ reviewDeadline: dl }), 'drafts')).toBe(false)
  })
  it('RD-REVIEW-03 — legacy changes-requested events (no deadline) are under Action Required too; other statuses are unaffected', () => {
    expect(listingTabsForDoc(doc({}))).toEqual(['action_required'])
    expect(listingTabsForDoc({ lifecycleStatus: 'draft', status: 'draft' })).toEqual(['drafts'])
    expect(listingTabsForDoc({ lifecycleStatus: 'pending_review', status: 'pending_review' })).toEqual(['active'])
    expect(reviewPhaseOf('published', second)).toBeNull()
    expect(listingTabsForDoc({ lifecycleStatus: 'cancelled', reviewDeadline: second })).toEqual(['archived'])
  })
})
