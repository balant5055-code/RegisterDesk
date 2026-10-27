// RD-COMMS-ANALYTICS-02 · Communication Center › Analytics — shapes, outcome model and labels.
// CLIENT-SAFE and PURE (no Firestore, no env).
//
// ═══ THE OUTCOME MODEL ═══════════════════════════════════════════════════════
// One emailLogs row is one message. Retries update that row in place (email and WhatsApp retry
// routes), WhatsApp status webhooks only move a row FORWARD (sent → delivered → read, stale and
// duplicate events are no-ops), and the broadcast jobs never write a second row for a recipient
// they already sent. So counting rows by outcome counts messages, never retries or webhooks.
//
//   delivered  the provider CONFIRMED delivery (email webhook, or Meta delivered/read)
//   accepted   the provider ACCEPTED it; no delivery confirmation (yet) — NOT counted as delivered
//   failed     a definite refusal / bounce
//   unknown    the provider gave no definite answer (timeout, interrupted send) — may have arrived
//   skipped    never sent on purpose (opt-out, no consent, no capacity, suppressed, …)
//   queued     not yet handed to the provider
//
// "Handed to provider" = accepted + delivered + failed + unknown. Skipped and queued never are.
// The confirmed delivery rate = delivered ÷ handed, computed ONLY for channels that recorded at
// least one confirmation in the period — a channel whose provider sends no delivery reports would
// otherwise show 0 % for messages that were very likely delivered.

import { COMMUNICATION_REGISTRY } from '@/lib/communications/registry/catalog'
import { NOTIFICATION_META, type NotificationType } from '@/lib/notifications/catalog'

export type AnalyticsChannel = 'email' | 'whatsapp'
export type ChannelFilter = 'all' | AnalyticsChannel
export type Outcome = 'delivered' | 'accepted' | 'failed' | 'unknown' | 'skipped' | 'queued'
export const OUTCOMES: readonly Outcome[] = ['delivered', 'accepted', 'failed', 'unknown', 'skipped', 'queued']

export const OUTCOME_LABEL: Record<Outcome, string> = {
  delivered: 'Delivered',
  accepted:  'Accepted, not confirmed',
  failed:    'Failed',
  unknown:   'Outcome unknown',
  skipped:   'Skipped',
  queued:    'Queued',
}
export const OUTCOME_HELP: Record<Outcome, string> = {
  delivered: 'The email or WhatsApp provider confirmed delivery to the recipient.',
  accepted:  'The provider accepted the message but has not confirmed delivery. It has most likely arrived, but this is not proof.',
  failed:    'The provider refused the message or it bounced. Nothing reached the recipient.',
  unknown:   'The provider never gave a definite answer, so the message may or may not have arrived. It is never re-sent automatically.',
  skipped:   'Deliberately not sent — for example the recipient opted out, gave no WhatsApp consent, or there was no capacity.',
  queued:    'Waiting to be handed to the provider.',
}

export type OutcomeCounts = Record<Outcome, number> & { attempts: number; read: number }

export const emptyCounts = (): OutcomeCounts => ({ attempts: 0, read: 0, delivered: 0, accepted: 0, failed: 0, unknown: 0, skipped: 0, queued: 0 })

export const handedToProvider = (c: OutcomeCounts) => c.delivered + c.accepted + c.failed + c.unknown

// ─── Ranges ─────────────────────────────────────────────────────────────────

export type RangePreset = '7d' | '30d' | '90d' | 'custom'
export const RANGE_PRESETS: ReadonlyArray<{ id: Exclude<RangePreset, 'custom'>; label: string; days: number }> = [
  { id: '7d', label: 'Last 7 days', days: 7 }, { id: '30d', label: 'Last 30 days', days: 30 }, { id: '90d', label: 'Last 90 days', days: 90 },
]
export const MAX_RANGE_DAYS = 180
/** Messages read per period. Past this the figures are marked partial — never silently truncated. */
export const SCAN_CAP = 5000

// ─── Notification types (dynamic — no event-type assumption) ────────────────

export type TypeCategory = 'registration' | 'reminders' | 'event_updates' | 'certificates' | 'broadcasts' | 'refunds' | 'waitlist' | 'team' | 'other'
export const TYPE_CATEGORY_LABEL: Record<TypeCategory, string> = {
  registration:  'Registration & tickets',
  reminders:     'Event reminders',
  event_updates: 'Event updates',
  certificates:  'Certificates',
  broadcasts:    'Broadcasts',
  refunds:       'Refunds',
  waitlist:      'Waitlist',
  team:          'Messages to your team',
  other:         'Other',
}

/** The keys the senders actually write (lib/registrations/*, reminders, certificates, broadcasts). */
const KNOWN_KEYS: Record<string, { label: string; category: TypeCategory }> = {
  registration_submitted:    { label: 'Registration received',     category: 'registration' },
  registration_confirmation: { label: 'Registration confirmation', category: 'registration' },
  registration_approved:     { label: 'Registration approved',     category: 'registration' },
  registration_rejected:     { label: 'Registration rejected',     category: 'registration' },
  registration_cancelled:    { label: 'Registration cancelled',    category: 'registration' },
  refund_confirmed:          { label: 'Refund confirmation',       category: 'refunds' },
  waitlist_joined:           { label: 'Waitlist joined',           category: 'waitlist' },
  spot_available:            { label: 'Waitlist spot available',   category: 'waitlist' },
  event_reminder:            { label: 'Event reminder',            category: 'reminders' },
  certificate_ready:         { label: 'Certificate ready',         category: 'certificates' },
  broadcast:                 { label: 'Broadcast',                 category: 'broadcasts' },
}
const CATEGORY_OF_NOTIFICATION: Partial<Record<string, TypeCategory>> = {
  REGISTRATION_CONFIRMATION: 'registration', REGISTRATION_APPROVED: 'registration', REGISTRATION_REJECTED: 'registration',
  REGISTRATION_CANCELLED: 'registration', TICKET_RESENT: 'registration', REFUND_SUCCESS: 'refunds',
  WAITLIST_JOINED: 'waitlist', WAITLIST_SPOT_AVAILABLE: 'waitlist', CERTIFICATE_READY: 'certificates',
  EVENT_UPDATED: 'event_updates', EVENT_CANCELLED: 'event_updates', EVENT_LOCATION: 'event_updates', KIT_COLLECTION: 'event_updates',
}
const REGISTRY_NAME = new Map(COMMUNICATION_REGISTRY.map(e => [String(e.id), e.displayName]))

export const humanizeKey = (k: string) => k.replace(/[_-]+/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()).trim() || 'Unlabelled'

/** Label + category for a stored templateKey. Unknown keys stay visible as "Other", never dropped. */
export function describeTemplateKey(key: string): { label: string; category: TypeCategory } {
  const known = KNOWN_KEYS[key]
  if (known) return known
  const cat = CATEGORY_OF_NOTIFICATION[key]
  const name = REGISTRY_NAME.get(key)
  if (cat) return { label: name ?? humanizeKey(key), category: cat }
  if (name) {
    const group = NOTIFICATION_META[key as NotificationType]?.group
    return { label: name, category: group === 'platform' ? 'team' : 'other' }
  }
  return { label: key ? humanizeKey(key) : 'Unlabelled', category: 'other' }
}

// ─── Response ───────────────────────────────────────────────────────────────

export interface ChannelSummary {
  channel:  AnalyticsChannel
  counts:   OutcomeCounts
  /** delivered ÷ handed to provider; null when this channel recorded no confirmations in the period. */
  deliveryRate: number | null
  /** accepted + delivered ÷ handed to provider; null when nothing was handed over. */
  acceptanceRate: number | null
  confirmationsRecorded: boolean
}

export interface PeriodSummary {
  from: string; to: string                  // inclusive local dates (YYYY-MM-DD)
  counts: OutcomeCounts
  channels: Record<AnalyticsChannel, ChannelSummary>
  /** Rate over the channels that record confirmations (rateChannels); null when none do. */
  deliveryRate: number | null
  rateChannels: AnalyticsChannel[]
  scanned: number
  truncated: boolean
}

export interface TrendBucket { key: string; label: string; email: OutcomeCounts; whatsapp: OutcomeCounts }

export interface TypeRow { category: TypeCategory; label: string; counts: OutcomeCounts; deliveryRate: number | null }

export type TemplateKind = 'transactional' | 'whatsapp_custom' | 'whatsapp_platform' | 'email_broadcast' | 'broadcast_unknown'
export interface TemplateRow {
  key:      string
  label:    string
  kind:     TemplateKind
  channel:  AnalyticsChannel
  category: string | null
  version:  number | null
  counts:   OutcomeCounts
  deliveryRate: number | null
  failureRate:  number | null
  lastActivity: string | null
  /** In-app link: the template's own page, or the filtered message history. */
  href:     string | null
}

export interface CapacitySummary {
  /** The SAME figures as Communications › Usage (lib/communications/usage → capacityFigures). */
  figures:  {
    purchased: number; used: number | null; inProgress: number | null; returned: number | null
    refunded: number; carriedIn: number; carriedOut: number; available: number
  } | null
  /** WhatsApp messages skipped in the period because no capacity covered them (history only). */
  capacitySkipped: number
  unavailableReason: string | null
}

export interface Insight {
  kind:   'action' | 'info'
  id:     string
  title:  string
  detail: string
  href:   string | null
  cta:    string | null
}

export interface CommunicationAnalyticsResponse {
  scope: { kind: 'event' | 'all'; eventId: string | null; eventName: string | null; timezone: string }
  filters: { range: RangePreset; channel: ChannelFilter; type: TypeCategory | null }
  bucket: 'day' | 'week'
  current:  PeriodSummary
  previous: PeriodSummary | null
  /** False when either period is partial or the previous one is empty — no deltas are shown then. */
  comparable: boolean
  trend:     TrendBucket[]
  /** Previous period's attempts per day, aligned by position with `trend` (day buckets only; null for weeks). */
  previousTrend: number[] | null
  types:     TypeRow[]
  templates: TemplateRow[]
  capacity:  CapacitySummary | null
  insights:  Insight[]
  generatedAt: string
}
