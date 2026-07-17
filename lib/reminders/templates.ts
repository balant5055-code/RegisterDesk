// Reminder email templates — build {subject, html} per kind by REUSING the shared
// email shell (lib/email/templates/base). No new email rendering system.

import { emailShell, btn, escHtml } from '@/lib/email/templates/base'
import type { ReminderKind } from './types'

export interface ReminderContent { subject: string; html: string }

export interface ReminderTemplateInput {
  kind:           ReminderKind
  eventName:      string
  recipientName?: string
  eventDateLabel?: string
  eventTimeLabel?: string
  venueLabel?:    string
  eventUrl?:      string
  customSubject?: string
  customMessage?: string
  balanceLabel?:  string
}

const p = (s: string) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#374151;">${s}</p>`
const heading = (s: string) => `<p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#111827;">${s}</p>`

function eventMeta(input: ReminderTemplateInput): string {
  const rows: string[] = []
  if (input.eventDateLabel) rows.push(`📅 <strong>${escHtml(input.eventDateLabel)}</strong>${input.eventTimeLabel ? ` · ${escHtml(input.eventTimeLabel)}` : ''}`)
  if (input.venueLabel)     rows.push(`📍 ${escHtml(input.venueLabel)}`)
  if (rows.length === 0) return ''
  return `<div style="margin:0 0 16px;padding:12px 14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;color:#374151;line-height:1.7;">${rows.join('<br>')}</div>`
}

/** Build the reminder email content for a kind. Pure. */
export function buildReminderContent(input: ReminderTemplateInput): ReminderContent {
  const name = input.recipientName?.trim() ? escHtml(input.recipientName.trim()) : 'there'
  const ev   = escHtml(input.eventName)
  const cta  = input.eventUrl ? btn('View event', input.eventUrl) : ''

  switch (input.kind) {
    case 'custom': {
      const subject = input.customSubject?.trim() || `Reminder: ${input.eventName}`
      const body = (input.customMessage ?? '')
        .split(/\n{2,}/).map(par => p(escHtml(par).replace(/\n/g, '<br>'))).join('')
      return { subject, html: emailShell(subject, `${heading(subject)}${body}${cta}`) }
    }
    case 'event_tomorrow': {
      const subject = `Tomorrow: ${input.eventName}`
      return { subject, html: emailShell(subject, `${heading(`See you tomorrow at ${ev}`)}${p(`Hi ${name}, this is a friendly reminder that <strong>${ev}</strong> is tomorrow.`)}${eventMeta(input)}${cta}`) }
    }
    case 'event_today': {
      const subject = `Today: ${input.eventName}`
      return { subject, html: emailShell(subject, `${heading(`${ev} is today`)}${p(`Hi ${name}, <strong>${ev}</strong> is happening today. We look forward to seeing you!`)}${eventMeta(input)}${cta}`) }
    }
    case 'event_starting_soon': {
      const subject = `Starting soon: ${input.eventName}`
      return { subject, html: emailShell(subject, `${heading(`${ev} starts soon`)}${p(`Hi ${name}, <strong>${ev}</strong> is starting soon. Get ready!`)}${eventMeta(input)}${cta}`) }
    }
    case 'registration_closing': {
      const subject = `Registration closing soon: ${input.eventName}`
      return { subject, html: emailShell(subject, `${heading('Registration is closing soon')}${p(`Registration for <strong>${ev}</strong> closes soon. Consider a final promotion push to fill remaining seats.`)}${cta}`) }
    }
    case 'early_bird_ending': {
      const subject = `Early bird ending: ${input.eventName}`
      return { subject, html: emailShell(subject, `${heading('Early bird pricing is ending')}${p(`Early bird pricing for <strong>${ev}</strong> is ending soon. This is a good moment to remind prospective attendees.`)}${cta}`) }
    }
    case 'low_wallet': {
      const subject = 'Low wallet balance'
      return { subject, html: emailShell(subject, `${heading('Your wallet balance is low')}${p(`Your organizer wallet balance is ${escHtml(input.balanceLabel ?? 'low')}. Top up to keep paid communications (WhatsApp/SMS) running for your events.`)}${input.eventUrl ? btn('Top up wallet', input.eventUrl) : ''}`) }
    }
  }
}
