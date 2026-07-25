// RD-COMMS-01 Phase 2 — Channel capability SSOT + pure state machine (isomorphic).
//
// THE single source of truth for "which communication channels actually have a
// transport" and how to derive a channel's ChannelState/HealthStatus from real runtime
// signals. Pure + isomorphic (no server imports) so client UI can import the capability
// facts directly and stop faking "Active"/"Enabled" for channels that cannot send.
//
// This module encodes STATIC facts (transport implemented? billed?) — the dynamic
// signals (configured/enabled/funded/healthy) are passed in by the server resolver.

import type { CommChannelId, ChannelState, HealthStatus } from './types'

/** Static, universal capability facts per channel. Grounded in the RD-COMMS audits:
 *  Email (SES) and WhatsApp (Meta) have real transports; SMS and Push do not. */
export interface ChannelCapability {
  id:            CommChannelId
  label:         string
  /** A real send transport exists. false ⇒ the channel can NEVER be 'active'. */
  implemented:   boolean
  /** Charged per message (from the prepaid wallet). Email is free. */
  paid:          boolean
  /** Short billing label for honest UI ('Free', 'Per message', 'Unavailable'). */
  billingLabel:  string
  /** The provider reports post-send delivery status (delivered/read). Email (SES) does NOT
   *  today — no SES/SNS bounce webhook is wired — so its delivery stops at "accepted".
   *  WhatsApp (Meta) DOES. Drives honest Accepted-vs-Delivered semantics + the "connect
   *  delivery tracking" health recommendation. */
  deliveryReceipts: boolean
}

export const CHANNEL_CAPABILITIES: Record<CommChannelId, ChannelCapability> = {
  email:    { id: 'email',    label: 'Email',    implemented: true,  paid: false, billingLabel: 'Free',        deliveryReceipts: false },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', implemented: true,  paid: true,  billingLabel: 'Per message', deliveryReceipts: true  },
  sms:      { id: 'sms',      label: 'SMS',      implemented: false, paid: true,  billingLabel: 'Unavailable', deliveryReceipts: false },
  push:     { id: 'push',     label: 'Push',     implemented: false, paid: false, billingLabel: 'Unavailable', deliveryReceipts: false },
}

/** True when a channel has a real send transport. The honesty gate: any UI that shows a
 *  channel as active/enabled/priced MUST first check this. SMS/Push return false today. */
export function isChannelImplemented(channel: CommChannelId): boolean {
  return CHANNEL_CAPABILITIES[channel]?.implemented ?? false
}

/** Dynamic signals the server resolver measures for a channel. */
export interface ChannelSignals {
  /** Provider credentials present (isChannelConfigured). */
  configured:         boolean
  /** Channel switched on in Business Configuration. */
  platformEnabled:    boolean
  /** Provider health probe passed. Phase 2 has no live probe ⇒ pass `true` (config-level). */
  healthy:            boolean
  /** Wallet covers at least one message. null ⇒ free channel or balance unknown. */
  funded:             boolean | null
  /** A resolvable template exists for this channel (email always true via global fallback). */
  templatesAvailable: boolean
  /** Event-scope overlay (only when resolving for a specific event). */
  event?: {
    enabled:          boolean
  }
}

/**
 * Derive a channel's ChannelState from real signals. PURE — the authoritative
 * composition used by every surface. Never fabricates status: an unimplemented channel
 * is always 'unavailable'; an unfunded paid channel is 'degraded' (recoverable), etc.
 */
export function computeChannelState(channel: CommChannelId, s: ChannelSignals): ChannelState {
  if (!isChannelImplemented(channel)) return 'unavailable'
  if (!s.configured)                  return 'available'   // implemented, no credentials
  if (!s.platformEnabled)             return 'down'        // switched off in Business Config
  if (!s.healthy)                     return 'down'        // provider unhealthy

  const paid = CHANNEL_CAPABILITIES[channel].paid
  if (paid && s.funded === false)     return 'degraded'    // empty wallet — recoverable via top-up

  // Configured + enabled + healthy + funded(or free). Event overlay refines to READY.
  if (s.event) {
    if (!s.event.enabled)     return 'configured'          // usable, but off for this event
    if (!s.templatesAvailable) return 'degraded'           // will fall back to global template
    return 'ready'
  }
  return 'configured'
}

/** Map a ChannelState to a traffic-light status. `enabled` = the org/event asked for this
 *  channel (used to flag the "enabled an unavailable channel" misconfiguration as red). */
export function statusForState(state: ChannelState, enabled: boolean): HealthStatus {
  switch (state) {
    case 'ready':
    case 'configured':  return 'green'
    case 'degraded':
    case 'available':   return 'amber'
    case 'down':        return 'red'
    case 'unavailable': return enabled ? 'red' : 'amber'   // enabled-but-can't-send = red
  }
}

/** Human one-liner for a channel state (for honest UI summaries). */
export function summarizeState(channel: CommChannelId, state: ChannelState): string {
  const label = CHANNEL_CAPABILITIES[channel].label
  switch (state) {
    case 'unavailable': return `${label} is not available yet`
    case 'available':   return `${label} transport not configured`
    case 'configured':  return `${label} configured and ready`
    case 'ready':       return `${label} ready for this event`
    case 'degraded':    return `${label} enabled with a caveat`
    case 'down':        return `${label} will not send`
  }
}

/** Roll several statuses into one (red beats amber beats green). */
export function rollupStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes('red')) return 'red'
  if (statuses.includes('amber')) return 'amber'
  return 'green'
}
