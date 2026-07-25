// RD-COMMS-01 Phase 2 — Communication read-model TYPES (isomorphic).
//
// Pure type contracts for the canonical communication read models: channel state,
// per-dimension health, readiness, and the resolved context. READ-ONLY — these types
// describe TRUTH derived from existing runtime; nothing here sends, charges, or mutates.
// No server imports, so both server resolvers and client UI can consume these.

/** Traffic-light status for a health dimension or an overall rollup. */
export type HealthStatus = 'green' | 'amber' | 'red'

/**
 * Channel lifecycle state (RD-COMMS-01 architecture Part 3). Derived ONLY from real
 * runtime signals — never faked.
 *  - unavailable: no transport implemented at all (SMS, Push today)
 *  - available:   transport exists but provider not configured (no credentials)
 *  - configured:  provider configured + platform-enabled + (if paid) funded — usable
 *  - ready:       configured AND enabled for a specific event with a resolvable template
 *  - degraded:    usable but with a caveat (paid channel with insufficient wallet balance)
 *  - down:        configured but will not send (platform-disabled or provider unhealthy)
 */
export type ChannelState =
  | 'unavailable'
  | 'available'
  | 'configured'
  | 'ready'
  | 'degraded'
  | 'down'

/** The communication channels the platform models. */
export type CommChannelId = 'email' | 'whatsapp' | 'sms' | 'push'

/** Health dimensions (RD-COMMS-01 architecture Part 6). */
export type HealthDimensionId =
  | 'provider'
  | 'configuration'
  | 'templates'
  | 'credits'
  | 'runtime'
  | 'authentication'

/** One dimension's assessment — always carries a reason and a recommended action. */
export interface DimensionResult {
  dimension:          HealthDimensionId
  status:             HealthStatus
  reason:             string
  recommendedAction:  string
}

/** Per-channel health: the authoritative state + a transparent dimension breakdown. */
export interface ChannelHealth {
  channel:            CommChannelId
  /** Whether a real transport is implemented (false ⇒ never 'active'/'enabled' in UI). */
  implemented:        boolean
  state:              ChannelState
  status:             HealthStatus
  /** One-line human summary of `state`. */
  summary:            string
  dimensions:         DimensionResult[]
}

/** Communication health for a scope (platform / organizer / event). */
export interface CommunicationHealth {
  scope:              CommunicationScope
  channels:           ChannelHealth[]
  overall:            HealthStatus
}

/** Per-channel readiness — is this channel/service ready to actually deliver? */
export interface ChannelReadiness {
  channel:            CommChannelId | 'certificate'
  ready:              boolean
  state:              ChannelState
  status:             HealthStatus
  /** Hard reasons the channel will not deliver (empty ⇒ nothing blocking). */
  blockers:           string[]
  /** Non-blocking caveats (e.g. low balance, template will fall back). */
  warnings:           string[]
}

/** Communication readiness for an organizer/event (RD-COMMS-01 architecture Part 7). */
export interface CommunicationReadiness {
  email:              ChannelReadiness
  whatsapp:           ChannelReadiness
  sms:                ChannelReadiness
  certificate:        ChannelReadiness
  overall: {
    ready:            boolean
    status:           HealthStatus
    blockers:         string[]
    warnings:         string[]
  }
}

/** The scope a read model was resolved for. */
export interface CommunicationScope {
  organizerUid?:      string
  eventId?:           string
}

/** Point-in-time wallet snapshot exposed to the read models (read-only). */
export interface WalletSnapshot {
  balancePaise:       number
  /** null when balance could not be resolved (no organizer in scope). */
  known:              boolean
}
