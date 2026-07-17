// Server-only. THE single runtime source for security POLICY after RD-CONF-11.
// Resolves the effective security configuration via the Business Configuration
// Engine (runtime override → Firestore config → code default), so nothing reads
// security policy constants directly.
//
// POLICY ONLY. Secrets (JWT/HMAC, Firebase, Razorpay, Meta, SES keys) NEVER pass
// through here — they stay in lib/env.ts / environment variables.
//
// EXTENSIBLE (Step 8 of prior phases): an optional resolution context
// (organizerUid / eventId) is accepted now but NOT yet applied — future
// organizer/event override layers slot in here without changing any caller.

import { businessConfig } from '@/lib/config/businessConfigService'
import type { SecurityConfig } from '@/lib/config/businessConfig'

export interface SecurityResolutionContext {
  organizerUid?: string   // reserved for a future organizer-override layer
  eventId?:      string   // reserved for a future event-override layer
}

/** The effective security policy configuration. Never undefined. */
export async function getSecurityConfig(context?: SecurityResolutionContext): Promise<SecurityConfig> {
  void context   // reserved: future organizer/event override layers hook in here
  return businessConfig.getSection('security')
}
