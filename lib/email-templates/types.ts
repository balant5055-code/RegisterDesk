// Shared types for the email template system.
// Safe to import from both client and server components.

// ─── Keys ─────────────────────────────────────────────────────────────────────

export type TemplateKey =
  | 'registration_submitted'
  | 'registration_approved'
  | 'registration_rejected'
  | 'event_reminder'
  | 'certificate_available'

export const TEMPLATE_KEYS: TemplateKey[] = [
  'registration_submitted',
  'registration_approved',
  'registration_rejected',
  'event_reminder',
  'certificate_available',
]

// ─── Template shapes ──────────────────────────────────────────────────────────

export interface EmailTemplate {
  key:     TemplateKey
  subject: string
  body:    string   // HTML fragment — inner body only, no <html>/<body> wrapper
}

export interface EmailTemplateRecord extends EmailTemplate {
  isCustomized: boolean
  updatedAt:    string | null  // ISO string; null = platform default in use
}

// ─── Per-template metadata ────────────────────────────────────────────────────

export interface TemplateMeta {
  key:         TemplateKey
  label:       string
  description: string
  trigger:     string
}

export const TEMPLATE_META: Record<TemplateKey, TemplateMeta> = {
  registration_submitted: {
    key:         'registration_submitted',
    label:       'Registration Submitted',
    description: 'Sent immediately when an attendee submits a registration form.',
    trigger:     'On registration submit',
  },
  registration_approved: {
    key:         'registration_approved',
    label:       'Registration Approved',
    description: 'Sent when you approve a pending registration. Includes the ticket.',
    trigger:     'On organizer approval',
  },
  registration_rejected: {
    key:         'registration_rejected',
    label:       'Registration Rejected',
    description: 'Sent when you reject a pending registration.',
    trigger:     'On organizer rejection',
  },
  event_reminder: {
    key:         'event_reminder',
    label:       'Event Reminder',
    description: 'Reminder email sent to confirmed attendees before the event.',
    trigger:     'Scheduled reminder',
  },
  certificate_available: {
    key:         'certificate_available',
    label:       'Certificate Available',
    description: 'Sent when a participation certificate is generated for an attendee.',
    trigger:     'On certificate generation',
  },
}

// ─── Variables ────────────────────────────────────────────────────────────────

export interface TemplateVariable {
  name:        string   // e.g. "{{attendeeName}}"
  key:         string   // e.g. "attendeeName"
  description: string
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { name: '{{attendeeName}}',   key: 'attendeeName',   description: 'Attendee full name' },
  { name: '{{eventName}}',      key: 'eventName',      description: 'Event name' },
  { name: '{{eventDate}}',      key: 'eventDate',      description: 'Formatted event date' },
  { name: '{{ticketCode}}',     key: 'ticketCode',     description: 'Unique ticket code' },
  { name: '{{registrationId}}', key: 'registrationId', description: 'Registration ID' },
  { name: '{{organizerName}}',  key: 'organizerName',  description: 'Organizer / org name' },
  { name: '{{eventLocation}}',  key: 'eventLocation',  description: 'Venue or online link' },
]

// Sample values shown in the live preview panel
export const SAMPLE_VARS: Record<string, string> = {
  attendeeName:   'Priya Sharma',
  eventName:      'DevConf 2026',
  eventDate:      'Saturday, 15 March 2026',
  ticketCode:     'RD-A1B2C3D4',
  registrationId: 'reg_abc123xyz',
  organizerName:  'Your Organization',
  eventLocation:  'Bandra Kurla Complex, Mumbai',
}

/**
 * Centralized HTML escaper for substituted variable VALUES. Escapes the five
 * HTML-significant characters so attendee-controlled data (names, etc.) cannot
 * inject markup when inserted into an HTML email body. `&` is escaped first to
 * avoid double-encoding the entities produced by the later replacements.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Replace all {{variable}} tokens with either real or sample values.
 *
 * `escapeValues: true` HTML-escapes each substituted VALUE before insertion —
 * REQUIRED whenever the result is inserted into an HTML context (e.g. an email
 * body). The template itself is never escaped, so the organizer's (already
 * sanitized) template HTML is preserved and values are escaped exactly once.
 * Leave it off for plain-text contexts (e.g. the email Subject header), where
 * escaping would surface literal entities.
 */
export function substituteVariables(
  template: string,
  values:   Record<string, string>,
  opts:     { escapeValues?: boolean } = {},
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) return `{{${key}}}`
    return opts.escapeValues ? escapeHtml(value) : value
  })
}
