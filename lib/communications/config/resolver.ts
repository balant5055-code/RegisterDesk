// RD-COMMS-01 Phase 3 — the canonical Communication Configuration Resolver.
//
// ONE place merges communication configuration across the layers defined by the approved
// architecture (Part 2):
//
//     Platform default  <  Organizer override  <  Event override   →   Resolved config
//
// It reuses the SAME deep-merge and validator the Business Configuration engine uses for the
// platform layer (lib/config/businessConfig) — so there is NO duplicated merge or validation
// logic anywhere. Pure and side-effect-free: inputs in, resolved CommunicationConfig out.
//
// Backward compatibility is structural: when the organizer/event override layers are absent
// (they have no storage yet — that lands with the Phase 4 settings UI), the resolver returns
// the platform configuration unchanged, so today's behavior is byte-identical.

import { deepMerge, validateCommunication, type CommunicationConfig } from '@/lib/config/businessConfig'

/** A partial, nested override of the communication configuration. Any subset of fields at any
 *  depth may be supplied; unspecified fields inherit from the layer below. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
export type CommunicationConfigOverride = DeepPartial<CommunicationConfig>

function hasKeys(o: CommunicationConfigOverride | null | undefined): boolean {
  return !!o && Object.keys(o).length > 0
}

/**
 * Resolve the effective communication configuration from the three layers. Precedence is
 * Platform (base) < Organizer < Event — later layers win, field by field, at any depth.
 *
 * Each override layer is validated with the canonical `validateCommunication` before it is
 * applied; a layer that would produce an invalid configuration is skipped (the lower,
 * already-valid layer is kept) so a bad override can NEVER break resolution or a send.
 *
 * Fast path: when neither override layer has any keys, the platform configuration is returned
 * as-is with no merge and no revalidation — identical to the pre-Phase-3 behavior.
 */
export function resolveCommunicationConfiguration(
  platform:  CommunicationConfig,
  organizer?: CommunicationConfigOverride | null,
  event?:     CommunicationConfigOverride | null,
): CommunicationConfig {
  const hasOrg   = hasKeys(organizer)
  const hasEvent = hasKeys(event)
  if (!hasOrg && !hasEvent) return platform   // no overrides → today's behavior, zero cost

  let resolved: CommunicationConfig = platform
  if (hasOrg) {
    const candidate = deepMerge(resolved, organizer)
    if (validateCommunication(candidate).valid) resolved = candidate
  }
  if (hasEvent) {
    const candidate = deepMerge(resolved, event)
    if (validateCommunication(candidate).valid) resolved = candidate
  }
  return resolved
}
