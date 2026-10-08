// RD-COMMS-M3 · Shared WhatsApp capacity — transparency only. Client-safe, pure.
//
// Broadcasts and transactional WhatsApp messages (confirmations, certificate notices, retries) use
// ONE event capacity pool. Nothing is reserved for future notifications: a broadcast may use any
// capacity available right now (the server's all-or-nothing funding check stays the authority).
// This only TELLS the organizer when an allowed broadcast takes a large share of what is left.
//
// Every number is the server's capacity quote (lib/communications/capacityQuote) — no second
// calculation. When event capacity funds a broadcast it takes exactly `required` units, so what
// remains afterwards is `available − required`.
//
// Rule: warn when the broadcast is funded by the event's capacity and uses at least HALF of the
// capacity available now — the first step (50%) of the platform's capacity-alert ladder
// (50/70/85/95/100%). A broadcast that is short of capacity is blocked elsewhere (no warning
// needed), and one paid from the legacy balance does not touch the event's capacity at all.

import type { RecipientCapacity } from './recipientCount'

/** The share of available capacity at or above which an allowed broadcast is flagged. */
export const LARGE_BROADCAST_SHARE = 0.5

export interface BroadcastCapacityWarning {
  required:       number
  available:      number
  remainingAfter: number
}

export function broadcastCapacityWarning(capacity: RecipientCapacity | null | undefined): BroadcastCapacityWarning | null {
  if (!capacity || !capacity.sufficient || capacity.fundedBy !== 'event_capacity') return null
  const { required, available } = capacity
  if (required <= 0 || available <= 0 || required > available) return null
  if (required < available * LARGE_BROADCAST_SHARE) return null
  return { required, available, remainingAfter: available - required }
}

/** The organizer-facing sentence. Never implies anything is reserved. */
export function broadcastCapacityWarningText(w: BroadcastCapacityWarning): string {
  const n = (v: number) => v.toLocaleString('en-IN')
  const msgs = (v: number) => `${n(v)} WhatsApp message${v === 1 ? '' : 's'}`
  return `This broadcast will use ${n(w.required)} of your ${msgs(w.available)} available. `
    + `${w.remainingAfter === 0 ? 'No messages' : `${n(w.remainingAfter)} message${w.remainingAfter === 1 ? '' : 's'}`} will remain available. `
    + 'Registration confirmations and other WhatsApp notifications use the same capacity, so future notifications may require additional capacity.'
}
