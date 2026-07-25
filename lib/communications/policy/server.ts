// RD-PLATFORM-COMMS-01 Phase 4D — server aggregate for notification policies.
//
// Resolves the policy for EVERY notification by running each resolved registry entry through
// the ONE canonical pure resolver (./resolve). Reuses the canonical registry — no duplicated
// policy state. Server-only (the registry resolver reads the WhatsApp registry + config).
// READ-ONLY.

import { resolveCommunicationRegistry } from '@/lib/communications/registry/resolve'
import { resolveNotificationPolicy, type ResolvedNotificationPolicy } from './resolve'

export async function resolveAllNotificationPolicies(): Promise<ResolvedNotificationPolicy[]> {
  const registry = await resolveCommunicationRegistry()
  return registry.map(e => resolveNotificationPolicy(e, e.supports))
}
