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
