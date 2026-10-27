// RD-WA-TEMPLATES-01 — organizer WhatsApp message templates: shared shapes, statuses, limits and the
// variable catalog. CLIENT-SAFE (no Firestore, no env, no Node built-ins): the builder, the Super
// Admin queue and the server routes all import this one file, so a status, a limit or a variable can
// never mean one thing in the UI and another on the server.
//
// ═══ TWO LIFECYCLES, NEVER MERGED ═════════════════════════════════════════════
//   internal — RegisterDesk's own review (Super Admin, or automatic validation)
//   meta     — what Meta's API said about the submitted template
// A template can be internally approved and Meta-rejected, or Meta-approved and later paused. Only
// BOTH an internal approval of the exact content AND a sendable Meta status allow a broadcast.

export const TEMPLATE_CATEGORIES = ['utility', 'marketing', 'authentication'] as const
export type TemplateCategory = typeof TEMPLATE_CATEGORIES[number]
/** Authentication templates need Meta's one-time-password format, which this integration does not build. */
export const SUPPORTED_CATEGORIES: readonly TemplateCategory[] = ['utility', 'marketing']
export const CATEGORY_LABEL: Record<TemplateCategory, string> = { utility: 'Utility', marketing: 'Marketing', authentication: 'Authentication' }
export const CATEGORY_HINT: Record<TemplateCategory, string> = {
  utility:        'Information about a registration or event the attendee already has — confirmations, schedule changes, reminders, collection details.',
  marketing:      'Promotions, offers, invitations to other events, or anything meant to sell.',
  authentication: 'One-time passcodes. Not available for organizer templates.',
}

/** Languages offered in the builder (Meta codes). Meta resolves a template by (name, language) and never falls back. */
export const TEMPLATE_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'en', label: 'English' }, { code: 'en_US', label: 'English (US)' }, { code: 'en_GB', label: 'English (UK)' },
  { code: 'hi', label: 'Hindi' }, { code: 'ta', label: 'Tamil' }, { code: 'te', label: 'Telugu' }, { code: 'kn', label: 'Kannada' },
  { code: 'ml', label: 'Malayalam' }, { code: 'mr', label: 'Marathi' }, { code: 'bn', label: 'Bengali' }, { code: 'gu', label: 'Gujarati' },
  { code: 'pa', label: 'Punjabi' }, { code: 'ur', label: 'Urdu' },
]

export const INTERNAL_STATUSES = ['draft', 'pending_review', 'changes_requested', 'approved_for_submission', 'rejected'] as const
export type InternalStatus = typeof INTERNAL_STATUSES[number]
export const INTERNAL_STATUS_LABEL: Record<InternalStatus, string> = {
  draft: 'Draft', pending_review: 'Pending review', changes_requested: 'Changes requested',
  approved_for_submission: 'Approved for submission', rejected: 'Rejected internally',
}

/**
 * RegisterDesk's record of the Meta side. The submission states are ours; the rest are normalized
 * from Meta's own values (see metaStatus.ts) — 'unknown' is used for anything Meta sent that is not
 * listed, rather than guessing.
 */
export const META_STATUSES = [
  'not_submitted', 'submitting', 'submission_failed', 'submission_unknown',
  'pending', 'approved', 'flagged', 'rejected', 'paused', 'disabled', 'in_appeal', 'locked',
  'limit_exceeded', 'archived', 'deleted', 'unknown',
] as const
export type MetaStatus = typeof META_STATUSES[number]
export const META_STATUS_LABEL: Record<MetaStatus, string> = {
  not_submitted: 'Not submitted', submitting: 'Submitting…', submission_failed: 'Submission failed',
  submission_unknown: 'Submission outcome unknown', pending: 'In review at Meta', approved: 'Approved by Meta',
  flagged: 'Approved · quality flagged', rejected: 'Rejected by Meta', paused: 'Paused by Meta', disabled: 'Disabled by Meta',
  in_appeal: 'Appeal in progress', locked: 'Locked by Meta', limit_exceeded: 'Template limit exceeded', archived: 'Archived',
  deleted: 'Deleted at Meta', unknown: 'Status unavailable',
}
/** The ONLY Meta states that permit a send. 'flagged' is still active at Meta (quality warning). */
export const SENDABLE_META_STATUSES: ReadonlySet<MetaStatus> = new Set(['approved', 'flagged'])
/** States in which a fresh submission (or a safe retry) may be attempted. */
export const SUBMITTABLE_META_STATUSES: ReadonlySet<MetaStatus> = new Set(['not_submitted', 'submission_failed', 'submission_unknown'])

export type ReviewMode = 'manual' | 'automatic'
export const DEFAULT_REVIEW_MODE: ReviewMode = 'manual'
export function parseReviewMode(v: unknown): ReviewMode {
  return v === 'automatic' ? 'automatic' : 'manual'
}

// ─── Content ──────────────────────────────────────────────────────────────────

export type TemplateButton =
  | { type: 'url'; text: string; url: string }
  | { type: 'phone'; text: string; phone: string }
  | { type: 'quick_reply'; text: string }

export interface TemplateHeader { format: 'text' | 'image' | 'video' | 'document'; text?: string }

export interface TemplateContent {
  header?:  TemplateHeader | null
  body:     string
  footer?:  string | null
  buttons?: TemplateButton[]
}

/** A variable the ORGANIZER types when sending a broadcast (e.g. a collection time). */
export interface CustomVariable { key: string; label: string; example: string }

export interface TemplateDraftInput {
  name:            string
  category:        TemplateCategory
  language:        string
  content:         TemplateContent
  customVariables: CustomVariable[]
  /** Example values for catalog variables, overriding the catalog's own sample. */
  examples:        Record<string, string>
  eventSlug:       string | null
}

export const LIMITS = {
  nameMin: 3, nameMax: 60,
  body: 1024, header: 60, footer: 60,
  buttonText: 25, url: 2000, phone: 20,
  urlButtons: 2, phoneButtons: 1, buttonsTotal: 10,
  headerVariables: 1,
  customVariables: 8, customKeyMax: 30, labelMax: 60, exampleMax: 200,
  reasonMin: 5, reasonMax: 1000, noteMax: 2000,
  campaignValueMax: 200,
} as const

// ─── Variables ────────────────────────────────────────────────────────────────

export type VariableSource = 'recipient' | 'event' | 'campaign'
export interface CatalogVariable {
  key:         string
  label:       string
  source:      Exclude<VariableSource, 'campaign'>
  example:     string
  description: string
  /** Event types this variable applies to; absent = every event type. */
  eventTypes?: readonly string[]
}

/**
 * Filled by RegisterDesk at send time — never typed by the organizer. Event-specific values are only
 * offered for the event types that have them (a bib number exists only for sports events), so the
 * catalog does not assume a marathon.
 */
export const VARIABLE_CATALOG: readonly CatalogVariable[] = [
  { key: 'attendeeName',  label: 'Attendee name',     source: 'recipient', example: 'Priya Sharma',                       description: 'The registered attendee’s name.' },
  { key: 'ticketCode',    label: 'Ticket code',       source: 'recipient', example: 'RD-7H2K9Q',                          description: 'The attendee’s ticket / registration code.' },
  { key: 'passName',      label: 'Ticket / pass name', source: 'recipient', example: 'Full Conference Pass',              description: 'The pass or ticket type the attendee registered for.' },
  { key: 'bibNumber',     label: 'Bib number',        source: 'recipient', example: '0042',                               description: 'The attendee’s assigned bib number.', eventTypes: ['sports'] },
  { key: 'eventName',     label: 'Event name',        source: 'event',     example: 'Chennai Design Summit 2026',         description: 'The event’s published name.' },
  { key: 'eventDate',     label: 'Event date & time', source: 'event',     example: 'Saturday, 12 December 2026, 09:00',  description: 'The event’s start date and time.' },
  { key: 'eventLocation', label: 'Venue',             source: 'event',     example: 'Chennai Trade Centre, Chennai',      description: 'The venue (or online platform).' },
  { key: 'organizerName', label: 'Organizer name',    source: 'event',     example: 'Bright Events',                      description: 'Your organization’s name.' },
  { key: 'certificateUrl', label: 'Certificate link', source: 'event',     example: 'https://registerdesk.in/events/sample/certificates', description: 'This event’s certificate download page.' },
]
const CATALOG_BY_KEY = new Map(VARIABLE_CATALOG.map(v => [v.key, v]))
export function catalogVariable(key: string): CatalogVariable | undefined { return CATALOG_BY_KEY.get(key) }

/** Catalog variables available for an event type (null = not tied to one event: every variable). */
export function variablesForEventType(eventType: string | null): CatalogVariable[] {
  return VARIABLE_CATALOG.filter(v => !v.eventTypes || !eventType || v.eventTypes.includes(eventType))
}

export const CUSTOM_KEY_RE = /^[a-z][a-zA-Z0-9]{1,29}$/
export const TEMPLATE_NAME_RE = /^[a-z0-9_]+$/

// ─── Starter templates ────────────────────────────────────────────────────────

export interface StarterTemplate {
  id:          string
  title:       string
  description: string
  category:    TemplateCategory
  name:        string
  content:     TemplateContent
  customVariables: CustomVariable[]
  /** Event types the starter suits; absent = all. */
  eventTypes?: readonly string[]
}

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: 'registration_confirmation', title: 'Registration confirmation', category: 'utility', name: 'registration_confirmed',
    description: 'Confirms the registration and gives the ticket code.',
    content: { header: { format: 'text', text: 'Registration confirmed' }, body: 'Hi {{attendeeName}}, your registration for {{eventName}} is confirmed. Your ticket code is {{ticketCode}}. Please keep it handy for entry on the day.', footer: 'Sent via RegisterDesk' },
    customVariables: [],
  },
  {
    id: 'event_reminder', title: 'Event reminder', category: 'utility', name: 'event_reminder',
    description: 'A reminder ahead of the event with date and venue.',
    content: { body: 'Hi {{attendeeName}}, this is a reminder that {{eventName}} starts on {{eventDate}} at {{eventLocation}}. Your ticket code is {{ticketCode}}. We look forward to seeing you.' },
    customVariables: [],
  },
  {
    id: 'schedule_change', title: 'Date, time or venue change', category: 'utility', name: 'event_schedule_change',
    description: 'Tells registered attendees about a change to the schedule or venue.',
    content: { header: { format: 'text', text: 'Important update' }, body: 'Hi {{attendeeName}}, there is a change to {{eventName}}: {{changeDetails}}. The event is now on {{eventDate}} at {{eventLocation}}. Your registration remains valid.' },
    customVariables: [{ key: 'changeDetails', label: 'What changed', example: 'the start time has moved to 10:00' }],
  },
  {
    id: 'certificate_ready', title: 'Certificate available', category: 'utility', name: 'certificate_available',
    description: 'Lets attendees know their certificate can be downloaded.',
    content: { body: 'Hi {{attendeeName}}, your certificate for {{eventName}} is ready. You can download it here: {{certificateUrl}} Thank you for taking part.' },
    customVariables: [],
  },
  {
    id: 'collection', title: 'Kit / badge collection', category: 'utility', name: 'collection_details',
    description: 'Where and when to collect a kit, badge or event pack.',
    content: { body: 'Hi {{attendeeName}}, please collect your {{collectionItem}} for {{eventName}} on {{collectionTime}} at {{collectionPlace}}. Bring your ticket code {{ticketCode}} with you.' },
    customVariables: [
      { key: 'collectionItem',  label: 'What to collect', example: 'event kit' },
      { key: 'collectionTime',  label: 'When',            example: 'Friday 11 December, 10:00–18:00' },
      { key: 'collectionPlace', label: 'Where',           example: 'Hall B, Chennai Trade Centre' },
    ],
  },
  {
    id: 'session_update', title: 'Session or agenda update', category: 'utility', name: 'agenda_update',
    description: 'A change to a session, speaker or agenda item.',
    content: { body: 'Hi {{attendeeName}}, an update for {{eventName}}: {{sessionUpdate}}. Your registration details are unchanged.' },
    customVariables: [{ key: 'sessionUpdate', label: 'The update', example: 'the keynote now starts at 11:30 in Hall A' }],
    eventTypes: ['conference', 'workshop', 'meetup', 'exhibition', 'awards', 'cultural', 'community', 'fundraising', 'custom'],
  },
]

export function startersForEventType(eventType: string | null): StarterTemplate[] {
  return STARTER_TEMPLATES.filter(s => !s.eventTypes || !eventType || s.eventTypes.includes(eventType))
}

// ─── Views returned by the API ────────────────────────────────────────────────

export interface ValidationFinding {
  severity:   'error' | 'warning' | 'suggestion'
  code:       string
  field:      string
  message:    string
  why:        string
  suggestion?: string
}

export interface VersionView {
  version:         number
  parentVersion:   number | null
  content:         TemplateContent
  customVariables: CustomVariable[]
  examples:        Record<string, string>
  contentHash:     string
  metaName:        string
  validation:      ValidationFinding[]
  internal: {
    status:          InternalStatus
    mode:            ReviewMode | null
    submittedAt:     string | null
    decidedAt:       string | null
    /** Organizer-visible explanation of a rejection or change request. */
    decisionReason:  string | null
    decidedBySystem: boolean
  }
  meta: {
    status:          MetaStatus
    templateId:      string | null
    category:        string | null
    categoryChanged: boolean
    rejectionReason: string | null
    rejectionDetail: { reason: string | null; recommendation: string | null } | null
    otherInfo:       { title: string | null; description: string | null } | null
    lastError:       string | null
    attempts:        number
    submittedAt:     string | null
    statusAt:        string | null
    syncedAt:        string | null
  }
  createdAt:       string | null
}

export interface HistoryView {
  id:      string
  at:      string | null
  action:  string
  version: number | null
  actor:   'organizer' | 'super_admin' | 'system' | 'meta'
  summary: string
}

export interface TemplateSummary {
  id:             string
  name:           string
  category:       TemplateCategory
  language:       string
  eventSlug:      string | null
  latestVersion:  number
  activeVersion:  number | null
  internalStatus: InternalStatus
  metaStatus:     MetaStatus
  updatedAt:      string | null
  organizerUid?:  string
}

export interface TemplateDetail extends TemplateSummary {
  revision: number
  versions: VersionView[]
  history:  HistoryView[]
}

/** A template a broadcast may use right now (organizer composer). */
export interface SendableTemplateView {
  id: string; name: string; version: number; language: string; category: string
  content: TemplateContent; customVariables: CustomVariable[]
}
