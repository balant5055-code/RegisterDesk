// RD-COMMS-01 Phase 2 — Communication read-model public API (barrel).
//
// One import surface for the canonical communication read models. Client UI imports the
// isomorphic pieces (capabilities, pure state); server code imports the resolver.

// Isomorphic (client-safe): capability SSOT + pure state machine + pure builders + types.
export {
  CHANNEL_CAPABILITIES,
  isChannelImplemented,
  computeChannelState,
  statusForState,
  summarizeState,
  rollupStatus,
  type ChannelCapability,
  type ChannelSignals,
} from './channels'
export { buildChannelHealth, buildCommunicationReadiness } from './build'
export type * from './types'

// Server-only: the canonical resolver (reads provider config + wallet). Importing this
// into a client bundle will pull server deps — client UI should use the capability SSOT
// above or consume the resolver's output via an API/props.
export {
  resolveCommunicationContext,
  resolveCommunicationHealth,
  resolveCommunicationReadiness,
  type ResolvedCommunicationContext,
  type CommunicationResolveOptions,
} from './resolve'
