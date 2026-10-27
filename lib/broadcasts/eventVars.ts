// RD-BCAST-VARS · The broadcast personalisation variables that come from the EVENT, and the
// rule for variables the composer does not offer. SERVER-ONLY (uses the shared email date format).
//
// The composer advertises {{eventDate}}, {{eventLocation}} and {{organizerName}} and its preview
// shows sample values for them — but the send used to substitute empty strings, so attendees got
// "Join us on  at ." These are now resolved from the live event document (the same fields the
// confirmation email and reminders use) and the organizer's branding, once per job.

import { fmtEmailDate } from '@/lib/email'
import { TEMPLATE_VARIABLES } from '@/lib/email-templates/types'

export interface BroadcastEventVars { eventDate: string; eventLocation: string; organizerName: string }

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Event date / venue / organizer name for a broadcast, from the published event document. */
export function broadcastEventVars(eventDoc: unknown, organizerName: string | null | undefined): BroadcastEventVars {
  const details = rec(rec(eventDoc).eventDetails)
  const startDate = str(rec(details.schedule).startDate)
  const startTime = str(rec(details.schedule).startTime)
  const venue = rec(details.venue)
  const online = rec(venue.online)
  const physical = rec(venue.physical)
  const eventLocation = str(venue.type) === 'online'
    ? (str(online.platform) ? `${str(online.platform)} (Online)` : 'Online')
    : [str(physical.name), str(physical.city)].filter(Boolean).join(', ')
  const date = startDate ? (fmtEmailDate(startDate) || startDate) : ''
  return {
    eventDate: date && startTime ? `${date}, ${startTime}` : date,
    eventLocation,
    organizerName: str(organizerName),
  }
}

const KNOWN = new Set(TEMPLATE_VARIABLES.map(v => v.key))

/** `{{variables}}` used in the text that the composer does not offer (they would be sent literally). */
export function unknownBroadcastVariables(...texts: string[]): string[] {
  const found = new Set<string>()
  for (const t of texts) for (const m of t.matchAll(/\{\{(\w+)\}\}/g)) if (!KNOWN.has(m[1])) found.add(m[1])
  return [...found]
}

export function unknownVariablesMessage(names: string[]): string {
  return `Unknown variable${names.length === 1 ? '' : 's'} ${names.map(n => `{{${n}}}`).join(', ')} — ` +
    `it would be sent as written. Use only: ${TEMPLATE_VARIABLES.map(v => v.name).join(', ')}.`
}
