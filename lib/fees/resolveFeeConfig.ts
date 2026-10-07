// Server-only. THE single runtime source for a transaction's FeeConfig after
// RD-CONF-06. Starts from the per-license fee matrix (lib/fees/config.ts — the code
// default) and overlays the Business Configuration `fees` section: the GLOBAL knobs
// (GST, gateway) always apply; `platformFeePercent` / `donationPlatformFee` are
// OPTIONAL overrides (null → inherit the per-tier matrix), so with no stored config
// the resolved FeeConfig is byte-for-byte the code default (zero regression).
//
// The pure calculation (lib/fees/engine.ts calculateFee) and the FeeConfig shape are
// unchanged — only where the rates come from moves to config.
//
// EXTENSIBLE (Step 8): an optional context (organizerUid / eventId) is accepted but
// NOT yet applied — future organizer/event override layers slot in here without
// changing any caller.

import { businessConfig } from '@/lib/config/businessConfigService'
import { getDefaultFeeConfig, getTransactionCategory } from './config'
import type { FeeConfig, PlatformPlanTier, PlatformTransactionType } from './types'
import type { FeeResolutionContext } from './feeModelResolution'

// RD-PAYMENT-02 Phase 3: the fee-model resolver, its default, and FeeResolutionContext now
// live in the PURE feeModelResolution module (client- and server-safe). Re-exported here so
// every existing server importer of this module keeps its import path unchanged.
export type { FeeResolutionContext } from './feeModelResolution'
export { DEFAULT_FEE_MODEL, resolveEffectiveFeeModel } from './feeModelResolution'

export async function resolveFeeConfig(
  type: PlatformTransactionType,
  planTier: PlatformPlanTier = 'starter',
  context?: FeeResolutionContext,
  /**
   * RD-PHASE4-S3 · Q2 — the EVENT's Super-Admin-configured attendee transaction fee percentage,
   * resolved server-side by resolveEventFeeConfig. A number replaces the effective GLOBAL attendee
   * percentage (and only that — GST, gateway, the fixed/min fee and the global platform-fee switch
   * are untouched); null / absent ⇒ the global precedence below applies unchanged. Ignored for
   * donations.
   */
  eventTerms?: { attendeeTransactionFeePercent?: number | null },
): Promise<FeeConfig> {
  void context   // reserved: future organizer/event override layers hook in here
  const base = getDefaultFeeConfig(type, planTier)   // per-tier/category code default
  const [fees, licensing] = await Promise.all([
    businessConfig.getSection('fees'),
    businessConfig.getSection('licensing'),
  ])

  const isDonation = getTransactionCategory(type) === 'donation'

  // ══ RD-CAPACITY-01 · where the ATTENDEE TRANSACTION FEE comes from ═══════════════
  //
  // The capacity-based commercial model retires licence tiers, and with them the
  // tier-specific transaction rate (2.0% / 1.5% / 1.0% / 0.5%). One platform rate replaces
  // them, and `licensing.commercial.attendeeTransactionFeePercent` is its single source —
  // Super Admin editable, like every other commercial value.
  //
  // Precedence, highest first:
  //   1. `fees.platformFeeEnabled === false`   → the component is zero
  //   2. `fees.platformFeePercent` (non-null)  → an EXPLICIT admin override still wins, so
  //                                              an operator who already set one keeps it
  //   3. the commercial attendee rate          → the new default for every ticketed sale
  //   4. the per-tier matrix                   → only if the commercial value is unusable
  //
  // DONATIONS are untouched: they keep their own `donationPlatformFee` / matrix rate. The
  // 2.5% figure is the fee on money an ATTENDEE pays for a ticket, and applying it to
  // donations would silently reprice a different product.
  const commercialAttendeeFee = typeof licensing.commercial?.attendeeTransactionFeePercent === 'number'
    && Number.isFinite(licensing.commercial.attendeeTransactionFeePercent)
    && licensing.commercial.attendeeTransactionFeePercent >= 0
      ? licensing.commercial.attendeeTransactionFeePercent
      : null

  const eventAttendeeFee = !isDonation && typeof eventTerms?.attendeeTransactionFeePercent === 'number'
    && Number.isFinite(eventTerms.attendeeTransactionFeePercent) && eventTerms.attendeeTransactionFeePercent >= 0
      ? eventTerms.attendeeTransactionFeePercent
      : null

  const platformOverride = isDonation
    ? fees.donationPlatformFee
    // RD-PHASE4-S3 — an event's own percentage wins over the effective global one; otherwise the
    // existing global precedence (fees.platformFeePercent ?? commercial rate) is unchanged.
    : eventAttendeeFee ?? fees.platformFeePercent ?? commercialAttendeeFee

  // Master enable switches (default true → no-op): disabling zeroes the component.
  // The per-tier `platformFeeType`/flat/min/max completion fields stay reserved —
  // the pure calculation is intentionally unchanged this sprint.
  const platformBps = fees.platformFeeEnabled === false
    ? 0
    : platformOverride != null ? Math.round(platformOverride * 100) : base.platformFeePercentBps

  return {
    ...base,
    platformFeePercentBps: platformBps,
    gstRatePercent:        fees.gstEnabled === false ? 0 : fees.gstPercent,
    gatewayFeePercentBps:  fees.gatewayFeeEnabled ? Math.round(fees.gatewayFeePercent * 100) : 0,
  }
}
