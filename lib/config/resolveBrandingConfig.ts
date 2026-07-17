// Server-only. THE single runtime source for platform branding after RD-CONF-10.
// Resolves the effective branding configuration via the Business Configuration
// Engine (runtime override → Firestore config → code default), so nothing reads
// platform-identity constants directly.
//
// NOTE: This reads Firestore (via the 60s-cached service). Call it ONLY from code
// paths that are already dynamic (route handlers, ISR pages with revalidate,
// dynamic [slug] metadata, client provider). Statically-rendered pages source the
// same values from BUSINESS_CONFIG_DEFAULTS.branding at build time instead, so
// they keep prerendering (see app/layout.tsx, lib/marketing/seo.ts).
//
// EXTENSIBLE (Step 8 of prior phases): an optional resolution context
// (organizerUid / eventId) is accepted now but NOT yet applied — future
// organizer/event override layers slot in here without changing any caller.

import { businessConfig } from '@/lib/config/businessConfigService'
import type { BrandingConfig } from '@/lib/config/businessConfig'

export interface BrandingResolutionContext {
  organizerUid?: string   // reserved for a future organizer-override layer
  eventId?:      string   // reserved for a future event-override layer
}

/** The effective platform branding configuration. Never undefined. */
export async function getBrandingConfig(context?: BrandingResolutionContext): Promise<BrandingConfig> {
  void context   // reserved: future organizer/event override layers hook in here
  return businessConfig.getSection('branding')
}
