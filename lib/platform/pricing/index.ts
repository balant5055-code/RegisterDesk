// RD-PRICING-01B — Platform Pricing Engine · public entry.
//
// Owner of pricing/gateway/gst/platform-fee computation for the ledger. RD-GA-01: the
// order-pricing/finance/report/settlement surfaces (buildOrderPricingEvidence,
// resolveLedgerFinancials, readReportFromLedgerData, readFinanceFromLedger,
// resolveWalletSettlementPure) ARE live-consumed by payments/donations/webhook/reports.
// The LICENSING-config layer (resolveEffectivePlatformConfiguration, the tier-override
// resolver) stays gated behind features.pricingEngineEnabled (currently false).
//
// NOTE: this barrel re-exports the SERVER-ONLY resolver/service (they import the
// Admin SDK). Import from './types' directly if you only need the type contracts on
// the client.

export * from './types'
export {
  DEFAULT_PLATFORM_SETTINGS,
  PLATFORM_SETTINGS_VERSION,
  cloneDefaultPlatformSettings,
} from './defaults'
export {
  validatePlatformSettings,
  PLATFORM_FEE_AMOUNT_MIN, PLATFORM_FEE_AMOUNT_MAX,
  GATEWAY_PERCENT_MIN, GATEWAY_PERCENT_MAX,
  GST_MIN, GST_MAX,
  REGISTRATION_LIMIT_MIN, REGISTRATION_LIMIT_MAX,
} from './validation'
export {
  resolvePlatformPricing,
  platformSettingsRef,
  PLATFORM_SETTINGS_COLLECTION,
  PLATFORM_SETTINGS_DOC,
} from './resolver'
export {
  getPlatformSettings,
  updatePlatformSettings,
  type UpdateResult,
} from './service'

// RD-PRICING-01C-PREP — reconciliation layer (production licensing ↔ engine).
export {
  PRODUCTION_TO_ENGINE_TIER,
  ENGINE_TO_PRODUCTION_TIER,
  mapProductionTierToEngine,
  mapEngineTierToProduction,
  resolveTierForProductionLicense,
} from './tierMap'
export {
  PAISE_PER_RUPEE,
  rupeesToPaise,
  paiseToRupees,
} from './units'

// RD-PRICING-01C/01D — effective-configuration API. The ONLY surface business modules
// (registration/publish/edit/admin-approval, later payments) may consume; they must
// not reach past these into the resolver/tierMap/units directly. Every consumer-facing
// value resolves through the per-field override hierarchy (01D).
export {
  resolveEffectivePlatformConfiguration,
  resolveEffectiveRegistrationLimit,
  resolveEffectivePlatformFee,
  resolveEffectiveGatewayCharges,
  resolveEffectiveLicense,
} from './api'
export {
  validateAdminEventOverride,
  validateOrganizerEventOverride,
  validatePricingSummary,
} from './validation'
export { getStoredPlatformSettingsRaw } from './resolver'

// RD-PRICING-02A — commercial model reconciliation. The reconciled fee algorithm +
// production fee-structure resolution + the shadow-compare that proves the engine
// reproduces production under the default commercial model. computeReconciledFees is
// consumed transitively via the order-pricing evidence path (buildOrderPricingEvidence).
export {
  DEFAULT_COMMERCIAL_MODEL,
  computeReconciledFees,
  commercialToFeeModel,
} from './commercial'
export {
  resolveEngineFeeConfig,
  licenseTierToFeeTier,
} from './feeStructure'
export {
  compareFeeComputation,
  type FeeComparison,
  type FeeFieldDifference,
} from './shadowCompare'

// RD-PRICING-01E-PREP — the unified pricing summary: the pricing contract for
// Payments/Wallet/Finance/Reports, consumed via the order-pricing evidence + ledger
// finance/report readers wired in RD-PRICING-02B..02F.
export {
  resolveEffectivePricingSummary,
  PRICING_SUMMARY_VERSION,
  type PricingSummaryOptions,
} from './pricingSummary'

// RD-PRICING-01F — immutable Order pricing snapshot (the permanent financial record).
// Storage/consumers NOT wired yet (RD-PRICING-02A). Historical orders must ALWAYS read
// their own stored snapshot, NEVER re-resolve — see orderSnapshot.ts / RECONCILIATION.
export {
  createOrderPricingSnapshot,
  validateOrderPricingSnapshot,
  serializeOrderPricingSnapshot,
  deserializeOrderPricingSnapshot,
  computePricingChecksum,
  ORDER_SNAPSHOT_VERSION,
} from './orderSnapshot'

// RD-PRICING-02B — order snapshot integration (informational; lib/fees stays SoT).
export {
  buildOrderPricingEvidence,
  type OrderPricingEvidence,
  type OrderPricingEvidenceInput,
  type OrderPricingSnapshotMeta,
} from './orderIntegration'

// RD-PRICING-02C — snapshot-first financial resolution + payment diagnostics. The
// production fee engine (lib/fees) remains the automatic fallback throughout.
export {
  resolveLedgerFinancials,
  readStoredSnapshotFinancials,
  type LedgerFinancials,
  type FinancialSource,
} from './orderFinancials'
export {
  getPricingMetrics,
  recordPricingMetric,
  resetPricingMetrics,
  type PricingMetricsSnapshot,
} from './pricingMetrics'

// RD-PRICING-02D — snapshot-first wallet settlement (credit + refund-reversal debit).
export {
  resolveWalletSettlementPure,
  recordWalletSettlementMetric,
  recordWalletCreditMetric,
  type WalletSettlementResolution,
  type WalletSettlementSource,
  type WalletSettlementDoc,
} from './walletSettlement'

// RD-PRICING-02E/02F — snapshot-first finance + report READ models (read-only; never
// recalculate). Identical logic + guarantees; separate diagnostic namespaces.
export {
  readFinanceFromLedger,
  readReportFromLedger,
  readReportFromLedgerData,
  type FinanceFigures,
  type FinanceSource,
  type FinanceLedgerDoc,
} from './financeSnapshot'
export { recordFinanceVersions, recordReportVersions } from './pricingMetrics'
