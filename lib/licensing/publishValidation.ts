// Event License publish-eligibility validation — PURE (Phase D5.1).
//
// Decides whether an event may be published under the new Event License model.
// This is READ-FREE: the caller reads any stored license (inside the publish
// transaction) and passes the intended tier + license status in. It performs no
// Firestore access, creates nothing, and returns a structured result. Failures are
// mapped by the caller to business errors that abort the publish transaction
// before any writes occur.

import type {
  EventLicenseTier,
  EventLicenseStatus,
  EventLicenseDefinition,
} from './eventLicense'

export type PublishLicenseFailureCode =
  | 'LICENSE_REQUIRED'
  | 'LICENSE_NOT_ACTIVE'
  | 'STARTER_LIMIT_REACHED'
  | 'INVALID_LICENSE'

export interface PublishLicenseContext {
  intendedTier:  EventLicenseTier
  licenseStatus: EventLicenseStatus | null   // null = no license document stored yet
  // The EFFECTIVE (config-resolved) definition for the intended tier. The caller
  // resolves it (via lib/licensing/resolveCatalog) and passes the fields this pure
  // validator needs, so validation reflects any configured price override.
  definition:    Pick<EventLicenseDefinition, 'name' | 'licensePricePaise'>
  /**
   * Placeholder for the Starter "1 active event" rule. When undefined the limit is
   * NOT enforced (not yet implemented); when provided, a value >= 1 triggers it.
   */
  starterActiveEventCount?: number
}

export type PublishLicenseValidation =
  | { ok: true }
  | { ok: false; code: PublishLicenseFailureCode; message: string }

/**
 * Validate publish eligibility for an event's intended license tier.
 *
 *   Starter                      — always eligible (the 1-active-event limit is a placeholder).
 *   Growth / Pro / Enterprise    — require a purchased, ACTIVE license.
 */
export function validatePublishEligibility(ctx: PublishLicenseContext): PublishLicenseValidation {
  const def = ctx.definition

  // Free tier (Starter) — eligible. The 1-active-event limit is enforced only when
  // the count is supplied (placeholder until implemented in a later phase).
  if (def.licensePricePaise === 0) {
    if (ctx.starterActiveEventCount !== undefined && ctx.starterActiveEventCount >= 1) {
      return {
        ok: false, code: 'STARTER_LIMIT_REACHED',
        message: 'Starter allows only one active event at a time. Archive the current event to publish another.',
      }
    }
    return { ok: true }
  }

  // Paid tiers (Growth / Professional / Enterprise) — require a valid, active purchased license.
  if (ctx.licenseStatus === null) {
    return {
      ok: false, code: 'LICENSE_REQUIRED',
      message: `Publishing a ${def.name} event requires a purchased ${def.name} license.`,
    }
  }
  if (ctx.licenseStatus !== 'active') {
    return { ok: false, code: 'LICENSE_NOT_ACTIVE', message: `The ${def.name} license for this event is not active.` }
  }
  return { ok: true }
}
