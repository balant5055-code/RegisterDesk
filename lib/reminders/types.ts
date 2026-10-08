// Reminder & Automation Engine — data model (RD-REM-01). Client-safe types only.
//
// A "reminder" is a scheduled communication job dispatched by the reminders cron
// through the EXISTING notification engine (no duplicate scheduler / send code).
// Auto reminders are materialized from an event's schedule; custom reminders are
// created by the organizer. Email is the live channel; WhatsApp/SMS are modelled
// but reserved (no approved reminder template yet).

export type ReminderChannel = 'email' | 'whatsapp' | 'sms'

// Kinds the engine actively schedules + dispatches.
export type ReminderKind =
  | 'event_tomorrow'          // 24h before start   → attendees
  | 'event_today'             // morning of event    → attendees
  | 'event_starting_soon'     // 1h before start     → attendees
  | 'registration_closing'    // 24h before reg-close→ organizer (promote nudge)
  | 'early_bird_ending'       // 24h before EB end   → organizer
  | 'low_wallet'              // balance < threshold → organizer
  | 'custom'                  // organizer-authored  → attendees or organizer

export const REMINDER_KINDS: ReminderKind[] = [
  'event_tomorrow', 'event_today', 'event_starting_soon',
  'registration_closing', 'early_bird_ending', 'low_wallet', 'custom',
]

// Auto kinds (materialized from event data / wallet state). `custom` is excluded.
export const AUTO_REMINDER_KINDS: Exclude<ReminderKind, 'custom'>[] = [
  'event_tomorrow', 'event_today', 'event_starting_soon',
  'registration_closing', 'early_bird_ending', 'low_wallet',
]

export const REMINDER_KIND_LABELS: Record<ReminderKind, string> = {
  event_tomorrow:       'Event tomorrow',
  event_today:          'Event today',
  event_starting_soon:  'Event starting soon',
  registration_closing: 'Registration closing',
  early_bird_ending:    'Early bird ending',
  low_wallet:           'Low wallet balance',
  custom:               'Custom reminder',
}

export type ReminderAudience = 'attendees' | 'organizer'

// Which audience each auto kind targets.
export const KIND_AUDIENCE: Record<Exclude<ReminderKind, 'custom'>, ReminderAudience> = {
  event_tomorrow:       'attendees',
  event_today:          'attendees',
  event_starting_soon:  'attendees',
  registration_closing: 'organizer',
  early_bird_ending:    'organizer',
  low_wallet:           'organizer',
}

export type ReminderStatus =
  | 'scheduled' | 'sending' | 'sent' | 'partial' | 'failed' | 'cancelled' | 'skipped'

// Reminder-rule timing presets (hours before the anchor event). "Custom offset"
// lets an organizer/admin pick any positive value.
export const OFFSET_PRESETS: { label: string; hours: number }[] = [
  { label: 'Immediately', hours: 0 },
  { label: '1 hour',      hours: 1 },
  { label: '6 hours',     hours: 6 },
  { label: '12 hours',    hours: 12 },
  { label: '1 day',       hours: 24 },
  { label: '3 days',      hours: 72 },
  { label: '7 days',      hours: 168 },
]

// The Firestore doc (collection: scheduledReminders). `sendAt`/timestamps are
// Firestore Timestamps server-side; the client reads ISO strings via the API.
export interface ReminderDocData {
  eventId:      string | null      // event slug, or null for account-level (low_wallet/custom-to-self)
  eventName:    string
  organizerUid: string
  kind:         ReminderKind
  audience:     ReminderAudience
  channel:      ReminderChannel
  status:       ReminderStatus
  source:       'auto' | 'custom'
  subject:      string | null      // custom subject (auto kinds render from templates)
  message:      string | null      // custom message body
  counts:       { recipients: number; sent: number; failed: number; skipped: number }
  costPaise:    number
  createdBy:    string
  error:        string | null
}

// The organizer/admin-facing view row (API payload; ISO dates).
export interface ReminderRow {
  id:           string
  eventId:      string | null
  eventName:    string
  kind:         ReminderKind
  kindLabel:    string
  audience:     ReminderAudience
  channel:      ReminderChannel
  status:       ReminderStatus
  source:       'auto' | 'custom'
  subject:      string | null
  sendAt:       string | null      // ISO
  counts:       { recipients: number; sent: number; failed: number; skipped: number }
  costPaise:    number
  createdAt:    string | null
  dispatchedAt: string | null
  /** RD-COMMS-P2-F — why it was skipped / failed / resumed, in plain words (never an internal code
   *  or exception text). Null when there is nothing to explain. */
  reasonLabel:  string | null
  /** Paused part-way (time budget) and still to finish — 'scheduled' with recipients already done. */
  continuing:   boolean
  /** Resumed after an interrupted send (no one already reached was emailed again). */
  resumed:      boolean
}

export const REMINDER_STATUS_LABELS: Record<ReminderStatus, string> = {
  scheduled: 'Scheduled',
  sending:   'Sending',
  sent:      'Sent',
  partial:   'Partly sent',
  failed:    'Failed',
  cancelled: 'Cancelled',
  skipped:   'Not sent',
}

// RD-COMMS-P2-F — the reasons the reminder engine records (RD-COMMS-P2-E executionGuard + dispatch),
// in the organizer's words. Anything not listed is shown generically: an unexpected error message is
// never echoed to the page.
const REMINDER_REASON_LABELS: Record<string, string> = {
  organizer_suspended:     'Your account is suspended, so reminders are paused.',
  event_unavailable:       'The event is no longer available (removed, taken down, or not yours).',
  event_cancelled:         'The event was cancelled.',
  event_not_live:          'The event is not live (draft, under review, changes requested, unpublished or archived).',
  event_rescheduled:       'The event’s date or time changed after this reminder was scheduled — a new one is scheduled for the new time.',
  event_reminders_off:     'Automatic reminders are turned off for this event.',
  reminders_disabled:      'Reminders are switched off on the platform.',
  kind_disabled:           'This type of reminder is switched off on the platform.',
  email_disabled:          'Email sending is switched off on the platform.',
  channel_not_live:        'This channel is not available for reminders.',
  invalid_reminder:        'The reminder was incomplete and could not be sent.',
  retired:                 'This reminder type has been retired.',
  no_recipients:           'No one was eligible to receive it.',
  no_eligible_recipients:  'Everyone eligible had already received it, had unsubscribed, or is no longer an attendee.',
  stale_sending_reclaimed: 'Sending was interrupted and could not be safely resumed. No one was emailed twice.',
  guard_unavailable:       'The event’s status could not be checked, so it was not sent.',
  resumed_after_interruption: 'Sending was interrupted and is resuming — no one already reached will be emailed again.',
}

/** The plain-language reason for a reminder's state, or null when there is nothing to explain. */
export function reminderReasonLabel(status: string, error: unknown): string | null {
  const code = typeof error === 'string' ? error : ''
  if (code && REMINDER_REASON_LABELS[code]) return REMINDER_REASON_LABELS[code]
  if (status === 'failed')  return 'It could not be sent.'
  if (status === 'skipped') return 'It was not sent.'
  return null
}

export interface ReminderAnalytics {
  scheduled: number
  sent:      number
  failed:    number
  skipped:   number
  cancelled: number
  recipients:number
  costPaise: number
}
