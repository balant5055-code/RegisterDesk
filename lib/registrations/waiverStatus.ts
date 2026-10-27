// RD-WAIVER-01 — a registration's waiver status, from the RECORD and nothing else.
// Browser-safe (no node:crypto), because the participant export runs client-side too.
// The fields are written by lib/registrations/waiver.ts `waiverRegistrationFields`.

export type WaiverStatus = 'Accepted' | 'Not accepted' | ''

/**
 * 'Accepted'     — the attendee accepted, and the time was recorded.
 * 'Not accepted' — the event required a waiver when this registration was written, and no
 *                  acceptance was recorded (walk-in, import, or written before RD-WAIVER-01
 *                  ever stamped one).
 * ''             — nothing recorded: the event required no waiver for this registration.
 */
export function waiverStatusOf(reg: unknown): WaiverStatus {
  const r = reg && typeof reg === 'object' ? reg as Record<string, unknown> : {}
  if (r.waiverAccepted === true && typeof r.waiverAcceptedAt === 'string' && r.waiverAcceptedAt) return 'Accepted'
  if (r.waiverRequired === true) return 'Not accepted'
  return ''
}
