// Phase H.4 — Event Setup Center: types.
//
// A metadata-driven ORCHESTRATION layer. No business logic, no new collections,
// no writes. Every card state is derived from REAL signals already exposed by
// existing APIs; where no check exists, the state is 'unknown' / 'not_yet_available'.
//
// SDK-free — pure types + derivation context.

import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'

// The ONLY card states. Each must come from real data — never fabricated.
export type SetupState =
  | 'ready'
  | 'needs_attention'
  | 'disabled'
  | 'unknown'
  | 'not_yet_available'

export type SetupGroup =
  | 'core' | 'operations' | 'communications' | 'finance' | 'certificates' | 'integrations'

export const SETUP_GROUP_ORDER: { key: SetupGroup; label: string }[] = [
  { key: 'core',           label: 'Core' },
  { key: 'operations',     label: 'Operations' },
  { key: 'communications', label: 'Communications' },
  { key: 'finance',        label: 'Finance' },
  { key: 'certificates',   label: 'Certificates' },
  { key: 'integrations',   label: 'Integrations' },
]

export interface SetupAction {
  label:     string
  /** In-place event-workspace tab to open. */
  tab?:      string
  /** External / cross-page link. */
  href?:     string
  external?: boolean
}

export interface SetupCardResult {
  state:        SetupState
  /** Plain-language explanation of WHY the card has this state (from real data). */
  reason:       string
  lastUpdated?: string | null     // ISO; only when a real timestamp exists
  primary?:     SetupAction
  secondary?:   SetupAction
}

// ─── Enrichment signals (from existing endpoints; 'unknown' on any failure) ──

export type CertSignal      = { generated: number; pending: number } | 'unknown'
export type IdentifierSignal = { configured: boolean } | 'unknown'
export type SessionSignal    = { count: number } | 'unknown'

export interface EnrichmentSignals {
  cert:       CertSignal
  identifier: IdentifierSignal
  sessions:   SessionSignal
}

export const EMPTY_ENRICHMENT: EnrichmentSignals = {
  cert: 'unknown', identifier: 'unknown', sessions: 'unknown',
}

/** Everything a module needs to derive its state — all REAL, already-loaded data. */
export interface SetupContext {
  event:  EventDetailResponse
  enrich: EnrichmentSignals
}

export interface SetupModule {
  key:         string
  group:       SetupGroup
  label:       string
  description: string
  /** Pure: maps real signals → a card result. Never invents a status. */
  derive:      (ctx: SetupContext) => SetupCardResult
}
