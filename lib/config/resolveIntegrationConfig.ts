// Server-only. THE single runtime source for integration OPERATIONAL policy after
// RD-CONF-12 (the final Business Configuration migration). Resolves the effective
// integration configuration via the Business Configuration Engine (runtime override
// → Firestore config → code default), so provider policy is not hardcoded.
//
// POLICY ONLY. Secrets/tokens/keys/signing-secrets (Meta, Razorpay, SES) NEVER pass
// through here — they stay in lib/env.ts / environment variables. This resolver
// carries provider selection + non-secret tunables (API version, request timeout).
//
// EXTENSIBLE: an optional resolution context (organizerUid / eventId) is accepted
// now but NOT yet applied — future organizer/event override layers slot in here
// without changing any caller.

import { businessConfig } from '@/lib/config/businessConfigService'
import type { IntegrationsConfig } from '@/lib/config/businessConfig'

export interface IntegrationResolutionContext {
  organizerUid?: string   // reserved for a future organizer-override layer
  eventId?:      string   // reserved for a future event-override layer
}

/** The effective integration policy configuration. Never undefined. */
export async function getIntegrationConfig(context?: IntegrationResolutionContext): Promise<IntegrationsConfig> {
  void context   // reserved: future organizer/event override layers hook in here
  return businessConfig.getSection('integrations')
}
