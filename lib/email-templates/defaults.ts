// Platform default email templates.
// Used when an organizer has not customized a template.
// Bodies are HTML fragments (inner body only) that wrap inside the email shell.

import type { EmailTemplate, TemplateKey } from './types'

// ─── Shared HTML helpers (email-compatible inline styles) ─────────────────────

function infoTable(rows: [string, string][]): string {
  const cells = rows.map(([label, value]) => `
    <tr>
      <td style="padding:6px 14px 6px 0;font-size:12px;color:#6b7280;white-space:nowrap;vertical-align:top;">${label}</td>
      <td style="padding:6px 0;font-size:13px;color:#111827;font-weight:500;">${value}</td>
    </tr>`).join('')
  return `<div style="background:#f9fafb;border-radius:10px;padding:14px 18px;margin:0 0 22px;border:1px solid #f3f4f6;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">${cells}</table>
  </div>`
}

function primaryBtn(label: string, url: string): string {
  return `<a href="${url}" style="display:inline-block;background:#e5277e;color:#ffffff;text-decoration:none;font-size:13.5px;font-weight:600;padding:11px 22px;border-radius:8px;margin:0 8px 8px 0;line-height:1.4;">${label}</a>`
}

function heading(text: string): string {
  return `<h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">${text}</h1>`
}

function para(text: string): string {
  return `<p style="margin:0 0 20px;font-size:14px;color:#4b5563;line-height:1.7;">${text}</p>`
}

function note(text: string): string {
  return `<p style="margin:18px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">${text}</p>`
}

// ─── Default templates ────────────────────────────────────────────────────────

const DEFAULTS: Record<TemplateKey, EmailTemplate> = {

  registration_submitted: {
    key:     'registration_submitted',
    subject: 'Registration received — {{eventName}}',
    body: [
      heading('Registration Received!'),
      para(`Hi <strong style="color:#111827;">{{attendeeName}}</strong>,<br>Thank you for registering for <strong style="color:#111827;">{{eventName}}</strong>. We have received your registration and it is under review.`),
      infoTable([
        ['Event',    '{{eventName}}'],
        ['Date',     '{{eventDate}}'],
        ['Venue',    '{{eventLocation}}'],
        ['Ticket #', '<span style="font-family:monospace;">{{ticketCode}}</span>'],
      ]),
      note('You will receive a confirmation email once your registration is reviewed. Keep this email for your records.'),
    ].join('\n'),
  },

  registration_approved: {
    key:     'registration_approved',
    subject: "You're in! Registration confirmed for {{eventName}}",
    body: [
      heading("You're Approved!"),
      para(`Hi <strong style="color:#111827;">{{attendeeName}}</strong>,<br>Great news — your registration for <strong style="color:#111827;">{{eventName}}</strong> has been approved. See you there!`),
      infoTable([
        ['Event',    '{{eventName}}'],
        ['Date',     '{{eventDate}}'],
        ['Venue',    '{{eventLocation}}'],
        ['Ticket #', '<span style="font-family:monospace;">{{ticketCode}}</span>'],
        ['Organizer','{{organizerName}}'],
      ]),
      primaryBtn('View Your Ticket', 'https://registerdesk.in/tickets/{{registrationId}}'),
      note('Keep your ticket code handy — you&rsquo;ll need it to check in at the event.'),
    ].join('\n'),
  },

  registration_rejected: {
    key:     'registration_rejected',
    subject: 'Update on your registration for {{eventName}}',
    body: [
      heading('Registration Update'),
      para(`Hi <strong style="color:#111827;">{{attendeeName}}</strong>,<br>We&rsquo;re sorry to let you know that your registration for <strong style="color:#111827;">{{eventName}}</strong> could not be approved at this time.`),
      infoTable([
        ['Event',     '{{eventName}}'],
        ['Date',      '{{eventDate}}'],
        ['Organizer', '{{organizerName}}'],
      ]),
      para('If you have any questions, please reach out to the event organizer directly.'),
      note('This decision was made by the event organizer. RegisterDesk is the platform facilitating this event.'),
    ].join('\n'),
  },

  event_reminder: {
    key:     'event_reminder',
    subject: "Reminder: {{eventName}} is coming up!",
    body: [
      heading("See You Soon!"),
      para(`Hi <strong style="color:#111827;">{{attendeeName}}</strong>,<br>Just a friendly reminder — <strong style="color:#111827;">{{eventName}}</strong> is coming up soon. We&rsquo;re looking forward to seeing you!`),
      infoTable([
        ['Event',    '{{eventName}}'],
        ['Date',     '{{eventDate}}'],
        ['Venue',    '{{eventLocation}}'],
        ['Ticket #', '<span style="font-family:monospace;">{{ticketCode}}</span>'],
      ]),
      primaryBtn('View Your Ticket', 'https://registerdesk.in/tickets/{{registrationId}}'),
      para('Please bring your ticket (digital or printed) and a valid ID for entry.'),
      note('If you can no longer attend, please contact the organizer as soon as possible.'),
    ].join('\n'),
  },

  certificate_available: {
    key:     'certificate_available',
    subject: 'Your certificate for {{eventName}} is ready',
    body: [
      heading('Your Certificate is Ready!'),
      para(`Hi <strong style="color:#111827;">{{attendeeName}}</strong>,<br>Congratulations on attending <strong style="color:#111827;">{{eventName}}</strong>! Your participation certificate is now available for download.`),
      infoTable([
        ['Event',     '{{eventName}}'],
        ['Date',      '{{eventDate}}'],
        ['Organizer', '{{organizerName}}'],
      ]),
      primaryBtn('Download Certificate', 'https://registerdesk.in/tickets/{{registrationId}}'),
      note('Your certificate is uniquely verifiable. Share it on LinkedIn or other platforms to showcase your participation.'),
    ].join('\n'),
  },
}

export function getDefaultTemplate(key: TemplateKey): EmailTemplate {
  return DEFAULTS[key]
}

export function getAllDefaultTemplates(): Record<TemplateKey, EmailTemplate> {
  return { ...DEFAULTS }
}
