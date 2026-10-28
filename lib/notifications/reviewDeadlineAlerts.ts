// RD-REVIEW-02 — organizer notices for the review deadlines (reminders, Action Required, closure).
// Pure builders of outbox messages: staged by the caller IN the transaction that records the step,
// so a notice exists if and only if the step persisted, and retried by the outbox drain if email
// delivery fails. Email + the organizer inbox only (WhatsApp needs approved Meta templates).
//
// Ids are deterministic per (cycle, step): a step that already happened never stages a second
// notice, because the same transaction checks the deadline state before staging.
//
// Content rule (outbox header): identities, statuses and links only.

import type { OutboxMessageInput } from './outbox'
import type { ReviewReminderKey } from '@/lib/events/reviewDeadline'
import type { ReviewClosureSource } from '@/types/events'

const idPart = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80)

/** The wizard entry point for this event (the same relay every other deep link uses). */
export function reviewEditPath(draftId: string): string {
  return `/dashboard/events/new/visibility?draftId=${encodeURIComponent(draftId)}`
}

/** "28 Oct 2026, 5:30 pm IST" — deadlines are shown in IST, like the other operator notices. */
export function istAt(ms: number): string {
  return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST'
}

// ─── What closure means for prepaid services (the EXISTING rules, stated once) ─────────────────
// Mirrors lib/wallet/serviceRequestRules.ts (REFUND_WINDOW_HOURS, REQUESTABLE_SERVICES,
// CARRYABLE_SERVICES) — tests/unit/reviewLifecycleContracts.test.ts fails if they drift. Closing
// never refunds anything by itself; these are requests the event owner may make, each reviewed by
// RegisterDesk. No promise that every service can be moved or refunded.

/** Hours after closure in which a REFUND request may be submitted (carry-forward has no window). */
export const CLOSURE_REFUND_WINDOW_HOURS = 24
/** Where the owner makes those requests. */
export const EVENT_WALLET_PATH = '/dashboard/wallet'

/** One short line (cards, the Action Required notice). */
export const CLOSURE_SERVICES_SHORT =
  `Nothing is refunded automatically. After closure, the event owner can request a refund of eligible unused prepaid services within ${CLOSURE_REFUND_WINDOW_HOURS} hours, from the Event Wallet.`

/** The full statement (the confirmation dialog, the closure notice). */
export const CLOSURE_SERVICES_DETAIL =
  'Closing never refunds anything automatically, and your purchase records are kept. ' +
  'If this event has unused prepaid services, the event owner can make a request from the Event Wallet, which RegisterDesk reviews: ' +
  `a refund of unused units bought for this event (registration capacity, WhatsApp messages, certificates, photos and ID badges) must be requested within ${CLOSURE_REFUND_WINDOW_HOURS} hours of closure; ` +
  'unused WhatsApp, certificate, photo and ID-badge units can instead be moved to another of your open events (registration capacity cannot be moved). ' +
  'Units already used, still held for messages in progress, or moved in from another event are not eligible.'

interface Base {
  organizerUid: string
  draftId:      string
  cycleId:      string
  eventName:    string
  /** The Super Admin's requested changes (organizer-visible). */
  changesComment: string
}

const name = (b: Base) => b.eventName.trim() || 'Your event'
const requested = (b: Base) => ({ label: 'Requested changes', value: b.changesComment.trim().slice(0, 300) || '—' })

function message(b: Base, step: string, m: Omit<OutboxMessageInput, 'id' | 'audience' | 'inbox' | 'metadata'> & { severity: 'warning' | 'error' | 'info'; actionRequired: boolean }): OutboxMessageInput {
  return {
    id: `review-dl_${idPart(b.cycleId)}_${step}`,
    audience: { kind: 'organizer', organizerUid: b.organizerUid },
    subject: m.subject, heading: m.heading, intro: m.intro, facts: m.facts, path: m.path, ctaLabel: m.ctaLabel,
    inbox: { category: 'approval', type: 'event_review_deadline', severity: m.severity, actionRequired: m.actionRequired, eventId: b.draftId, eventName: name(b) },
    metadata: { draftId: b.draftId, cycleId: b.cycleId, step },
  }
}

/** First-window reminder (h12 / h22) or the second-window reminder (ar20). */
export function reviewReminderNotice(b: Base & { key: ReviewReminderKey; dueAtMs: number }): OutboxMessageInput {
  const second = b.key === 'ar20'
  return message(b, `reminder-${b.key}`, {
    subject: second ? `Action required: ${name(b)} closes soon` : `Reminder: changes requested for ${name(b)}`,
    heading: second ? 'Your event will be closed soon' : 'Changes are still requested',
    intro: second
      ? `${name(b)} will be closed automatically at the deadline below unless you edit and resubmit it. After closure it can no longer be edited or resubmitted. ${CLOSURE_SERVICES_SHORT}`
      : `RegisterDesk asked for changes to ${name(b)}. Edit the event and submit it for review again before the deadline below.`,
    facts: [{ label: 'Event', value: name(b) }, requested(b), { label: second ? 'Closes at' : 'Deadline', value: istAt(b.dueAtMs) }],
    path: reviewEditPath(b.draftId), ctaLabel: 'Edit event',
    severity: second ? 'error' : 'warning', actionRequired: true,
  })
}

/** The first deadline passed: the event is now in Action Required (second 24-hour window). */
export function actionRequiredNotice(b: Base & { closesAtMs: number }): OutboxMessageInput {
  return message(b, 'action-required', {
    subject: `Action required: ${name(b)}`,
    heading: 'Your event needs action',
    intro: `The deadline for the requested changes to ${name(b)} has passed. You can still edit and resubmit it, or close it. If you do nothing, it will be closed automatically at the time below. ${CLOSURE_SERVICES_SHORT}`,
    facts: [{ label: 'Event', value: name(b) }, requested(b), { label: 'Closes at', value: istAt(b.closesAtMs) }],
    path: '/dashboard/events?tab=action_required', ctaLabel: 'Open Action Required',
    severity: 'error', actionRequired: true,
  })
}

/** The event was closed — by its owner, or because the second deadline passed. */
export function reviewClosedNotice(b: Base & { source: ReviewClosureSource; closedAtMs: number }): OutboxMessageInput {
  const expired = b.source === 'deadline_expired'
  return message(b, `closed-${b.source}`, {
    subject: expired ? `${name(b)} was closed` : `You closed ${name(b)}`,
    heading: 'Event closed',
    intro: expired
      ? `${name(b)} was closed automatically because the requested changes were not submitted before the deadline. It can no longer be edited or resubmitted. ${CLOSURE_SERVICES_DETAIL}`
      : `You closed ${name(b)}. It can no longer be edited or resubmitted. ${CLOSURE_SERVICES_DETAIL}`,
    facts: [
      { label: 'Event', value: name(b) }, { label: 'Closed', value: istAt(b.closedAtMs) },
      { label: 'Closed by', value: expired ? 'Automatic (deadline passed)' : 'You' },
      { label: 'Refund requests until', value: istAt(b.closedAtMs + CLOSURE_REFUND_WINDOW_HOURS * 3_600_000) },
    ],
    path: EVENT_WALLET_PATH, ctaLabel: 'Open Event Wallet',
    severity: 'info', actionRequired: false,
  })
}
