// RD-LAUNCH-02 — the ONE contact-enquiry model and validator.
//
// The public contact form used to call `setSubmitted(true)` and nothing else: no
// request, no record, no email — a green success panel over a discarded message
// (RD-LAUNCH-01 P0-1). This module is the shared contract between the form and the
// endpoint, so the browser and the server validate against the same rules and neither
// can drift.
//
// Pure and dependency-free so both sides can import it.

/** Everything the public form collects. All values arrive as strings. */
export interface EnquiryInput {
  fullName:     string
  workEmail:    string
  message:      string
  organization?: string
  phone?:       string
  country?:     string
  eventType?:   string
  attendees?:   string
  demoDate?:    string
  subject?:     string
}

export interface EnquiryFieldError {
  field:   keyof EnquiryInput
  message: string
}

// Caps are generous for a genuine enquiry and small enough that a single request can
// never write an oversized document. Message is the only long field.
export const ENQUIRY_LIMITS = {
  short:   200,
  message: 5_000,
} as const

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Validate an enquiry payload.
 *
 * Returns the field errors — empty means valid. The messages are the ones the form
 * already showed, so server rejections read identically to client ones.
 */
export function validateEnquiry(raw: unknown): EnquiryFieldError[] {
  const b = (raw ?? {}) as Record<string, unknown>
  const errors: EnquiryFieldError[] = []

  const fullName  = str(b.fullName)
  const workEmail = str(b.workEmail)
  const message   = str(b.message)

  if (!fullName)  errors.push({ field: 'fullName',  message: 'Please enter your full name.' })
  if (!workEmail) errors.push({ field: 'workEmail', message: 'Please enter your work email.' })
  else if (!EMAIL_RE.test(workEmail)) errors.push({ field: 'workEmail', message: 'Enter a valid email address.' })
  if (!message)   errors.push({ field: 'message',   message: 'Tell us a little about your event.' })

  // Oversize is rejected rather than silently truncated: a 10,000-character "message"
  // is not a genuine enquiry, and quietly cutting someone's text would be worse.
  if (message.length > ENQUIRY_LIMITS.message) {
    errors.push({ field: 'message', message: 'Please keep your message under 5,000 characters.' })
  }
  for (const k of ['fullName', 'workEmail', 'organization', 'phone', 'country', 'eventType', 'attendees', 'demoDate', 'subject'] as const) {
    if (str(b[k]).length > ENQUIRY_LIMITS.short) {
      errors.push({ field: k, message: 'This value is too long.' })
    }
  }

  return errors
}

/**
 * Normalise a validated payload into exactly the fields we store.
 *
 * Only what the person actually typed. No IP address, no user agent, no referrer, no
 * fingerprinting — an enquiry record needs the enquiry, not the enquirer's device.
 */
export function normaliseEnquiry(raw: unknown): EnquiryInput {
  const b = (raw ?? {}) as Record<string, unknown>
  const cap = (v: unknown, n: number) => str(v).slice(0, n)
  return {
    fullName:     cap(b.fullName,  ENQUIRY_LIMITS.short),
    workEmail:    cap(b.workEmail, ENQUIRY_LIMITS.short).toLowerCase(),
    message:      cap(b.message,   ENQUIRY_LIMITS.message),
    organization: cap(b.organization, ENQUIRY_LIMITS.short) || undefined,
    phone:        cap(b.phone,     ENQUIRY_LIMITS.short) || undefined,
    country:      cap(b.country,   ENQUIRY_LIMITS.short) || undefined,
    eventType:    cap(b.eventType, ENQUIRY_LIMITS.short) || undefined,
    attendees:    cap(b.attendees, ENQUIRY_LIMITS.short) || undefined,
    demoDate:     cap(b.demoDate,  ENQUIRY_LIMITS.short) || undefined,
    subject:      cap(b.subject,   ENQUIRY_LIMITS.short) || undefined,
  }
}

/** Escape before interpolating attendee-supplied text into the notification HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The internal notification body. Plain, complete and readable — this goes to the
 * support inbox, not to a customer, so it prioritises having every detail in one place
 * over presentation.
 */
export function buildEnquiryEmailHtml(e: EnquiryInput, receivedAt: string): string {
  const row = (label: string, value?: string) =>
    value
      ? `<tr><td style="padding:6px 12px 6px 0;color:#64748b;font:500 13px system-ui,sans-serif;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>`
        + `<td style="padding:6px 0;color:#0f172a;font:400 13px system-ui,sans-serif">${escapeHtml(value)}</td></tr>`
      : ''

  return [
    '<div style="max-width:640px;margin:0 auto;padding:24px;font-family:system-ui,sans-serif">',
    '<h1 style="margin:0 0 4px;font-size:18px;color:#0f172a">New Contact Enquiry</h1>',
    `<p style="margin:0 0 20px;font-size:13px;color:#64748b">Received ${escapeHtml(receivedAt)}</p>`,
    '<table style="border-collapse:collapse;width:100%">',
    row('Name',       e.fullName),
    row('Email',      e.workEmail),
    row('Phone',      e.phone),
    row('Company',    e.organization),
    row('Country',    e.country),
    row('Event type', e.eventType),
    row('Attendees',  e.attendees),
    row('Demo date',  e.demoDate),
    row('Subject',    e.subject),
    '</table>',
    '<p style="margin:20px 0 6px;font:600 13px system-ui,sans-serif;color:#0f172a">Message</p>',
    `<div style="white-space:pre-wrap;padding:12px;border:1px solid #e2e8f0;border-radius:8px;font:400 13px system-ui,sans-serif;color:#0f172a">${escapeHtml(e.message)}</div>`,
    `<p style="margin:20px 0 0;font-size:12px;color:#64748b">Reply directly to <a href="mailto:${escapeHtml(e.workEmail)}">${escapeHtml(e.workEmail)}</a>.</p>`,
    '</div>',
  ].join('')
}
