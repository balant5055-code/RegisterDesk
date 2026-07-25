// RD-PRICING-02E — snapshot-first finance READ model. PURE, read-only.
//
// Finance / settlement / revenue / accounting read models call this to source their
// figures from the immutable Order Pricing Snapshot, falling back to the stored ledger
// values. It NEVER recalculates pricing (Phase 3): no calculateFee, no
// resolveEffectivePricingSummary — it only DESERIALIZES the stored snapshot.
//
// To keep finance byte-identical to the historical ledger (Phase 5), the snapshot is
// used ONLY when EVERY figure equals the stored ledger value; any difference (or a
// missing/invalid/checksum-failed snapshot) falls back to the ledger. Reporting is
// never failed.

import { deserializeOrderPricingSnapshot } from './orderSnapshot'
import {
  recordPricingMetric, recordFinanceVersions, recordReportVersions,
  type PricingMetricsSnapshot,
} from './pricingMetrics'
import type { FeeBreakdownRecord, FeeModel } from '@/lib/fees/types'

// RD-PAYMENT-02 Phase 6 — 'financials' is the highest-priority canonical source (the
// persisted FeeBreakdownRecord); 'snapshot' and 'fallback' are the existing sources.
export type FinanceSource = 'financials' | 'snapshot' | 'fallback'

// A metric namespace lets finance (02E) and reports (02F) share the identical read
// logic while tracking separate counters/gauges.
interface MetricNamespace {
  used:        keyof PricingMetricsSnapshot
  fallback:    keyof PricingMetricsSnapshot
  checksum:    keyof PricingMetricsSnapshot
  setVersions: (snapshotVersion: number, pricingVersion: number) => void
}

const FINANCE_NS: MetricNamespace = {
  used: 'financeSnapshotUsed', fallback: 'financeFallbackUsed',
  checksum: 'financeChecksumFailures', setVersions: recordFinanceVersions,
}

const REPORT_NS: MetricNamespace = {
  used: 'reportSnapshotUsed', fallback: 'reportFallbackUsed',
  checksum: 'reportChecksumFailures', setVersions: recordReportVersions,
}

export interface FinanceFigures {
  source:                  FinanceSource
  grossAmountPaise:        number   // attendee paid (organizer_pays: == ticket/gross)
  platformFeeBasePaise:    number
  platformFeeGstPaise:     number
  platformFeeTotalPaise:   number
  gatewayFeeEstimatePaise: number
  netSettlementPaise:      number   // organizer settlement
  // RD-PAYMENT-02 Phase 6 — richer canonical fields, present ONLY when a financials
  // breakdown was the source (undefined for snapshot/ledger fallback = legacy records).
  feeModel?:               FeeModel
  ticketBasePaise?:        number
  chargeAmountPaise?:      number
  attendeeFeeTotalPaise?:  number
  organizerFeeTotalPaise?: number
  financialVersion?:       number
  snapshotVersion?:        number
  pricingVersion?:         number
}

/** The stored ledger fields the finance reader needs (a subset of PlatformTransactionDocument). */
export interface FinanceLedgerDoc {
  grossAmountPaise:        number
  platformFeeBasePaise:    number
  platformFeeGstPaise:     number
  platformFeeTotalPaise:   number
  gatewayFeeEstimatePaise: number
  netSettlementPaise:      number
  pricingSnapshot?:        string
  // RD-PAYMENT-02 Phase 6 — the canonical breakdown; preferred when present. Optional and
  // absent on every current/legacy ledger, so reads fall back to the flat fields above.
  financials?:             FeeBreakdownRecord
}

function fromLedger(doc: FinanceLedgerDoc): FinanceFigures {
  return {
    source:                  'fallback',
    grossAmountPaise:        doc.grossAmountPaise,
    platformFeeBasePaise:    doc.platformFeeBasePaise,
    platformFeeGstPaise:     doc.platformFeeGstPaise,
    platformFeeTotalPaise:   doc.platformFeeTotalPaise,
    gatewayFeeEstimatePaise: doc.gatewayFeeEstimatePaise,
    netSettlementPaise:      doc.netSettlementPaise,
  }
}

// RD-PAYMENT-02 Phase 6 — project the persisted canonical breakdown into finance figures.
// Highest-priority source. Under organizer_pays the FeeBreakdownRecord mirrors the flat
// ledger fields (ticketBasePaise === gross, netSettlementPaise identical), so the core
// figures are byte-identical; the extra fields (feeModel, charge, attendee/organizer split)
// are additive.
function fromFinancials(f: FeeBreakdownRecord): FinanceFigures {
  return {
    source:                  'financials',
    grossAmountPaise:        f.ticketBasePaise,
    platformFeeBasePaise:    f.platformFeeBasePaise,
    platformFeeGstPaise:     f.platformFeeGstPaise,
    platformFeeTotalPaise:   f.platformFeeTotalPaise,
    gatewayFeeEstimatePaise: f.gatewayFeeEstimatePaise,
    netSettlementPaise:      f.netSettlementPaise,
    feeModel:                f.feeModel,
    ticketBasePaise:         f.ticketBasePaise,
    chargeAmountPaise:       f.chargeAmountPaise,
    attendeeFeeTotalPaise:   f.attendeeFeeTotalPaise,
    organizerFeeTotalPaise:  f.organizerFeeTotalPaise,
    financialVersion:        f.financialVersion,
  }
}

// Validate an untyped `doc.financials` before trusting it — a malformed breakdown must
// never corrupt a read; it transparently falls back to the flat fields.
function coerceFinancials(v: unknown): FeeBreakdownRecord | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const f = v as Record<string, unknown>
  if (typeof f.financialVersion !== 'number' || typeof f.feeModel !== 'string') return undefined
  const numeric = [
    'ticketBasePaise', 'chargeAmountPaise', 'platformFeeBasePaise', 'platformFeeGstPaise',
    'platformFeeTotalPaise', 'gatewayFeeEstimatePaise', 'attendeeFeeTotalPaise',
    'organizerFeeTotalPaise', 'netSettlementPaise',
  ] as const
  for (const k of numeric) if (typeof f[k] !== 'number' || !Number.isFinite(f[k] as number)) return undefined
  return v as FeeBreakdownRecord
}

// Shared core: snapshot-first with ledger fallback, guaranteed byte-equal to the
// stored ledger. Never throws, never recalculates. `ns` selects the metric counters.
function resolveFigures(doc: FinanceLedgerDoc, ns: MetricNamespace): FinanceFigures {
  const ledger = fromLedger(doc)
  // RD-PAYMENT-02 Phase 6: prefer the canonical financials breakdown when present — the
  // single, highest-priority source. Absent on every current/legacy ledger, so this branch
  // is dormant today and finance stays byte-identical to the stored ledger.
  if (doc.financials) {
    recordPricingMetric(ns.used)   // a canonical (non-fallback) source was used
    return fromFinancials(doc.financials)
  }
  if (!doc.pricingSnapshot) { recordPricingMetric(ns.fallback); return ledger }

  const de = deserializeOrderPricingSnapshot(doc.pricingSnapshot)
  if (!de.ok) {
    if (de.errors.some(e => /checksum/i.test(e))) recordPricingMetric(ns.checksum)
    recordPricingMetric(ns.fallback)
    return ledger
  }

  const s = de.snapshot
  const equal =
    s.ticketPrice.paise       === ledger.grossAmountPaise &&
    s.platformFee.paise       === ledger.platformFeeBasePaise &&
    s.platformGst.paise       === ledger.platformFeeGstPaise &&
    s.platformFeeTotal.paise  === ledger.platformFeeTotalPaise &&
    s.gatewayFee.paise        === ledger.gatewayFeeEstimatePaise &&
    s.organizerReceives.paise === ledger.netSettlementPaise

  if (!equal) { recordPricingMetric(ns.fallback); return ledger }

  recordPricingMetric(ns.used)
  ns.setVersions(s.snapshotVersion, s.pricingVersion)
  return {
    source:                  'snapshot',
    grossAmountPaise:        s.ticketPrice.paise,
    platformFeeBasePaise:    s.platformFee.paise,
    platformFeeGstPaise:     s.platformGst.paise,
    platformFeeTotalPaise:   s.platformFeeTotal.paise,
    gatewayFeeEstimatePaise: s.gatewayFee.paise,
    netSettlementPaise:      s.organizerReceives.paise,
    snapshotVersion:         s.snapshotVersion,
    pricingVersion:          s.pricingVersion,
  }
}

/**
 * Read a ledger doc's FINANCE figures, snapshot-first with ledger fallback. Guarantees
 * the returned figures equal the stored ledger values (snapshot used only when
 * byte-equal). Records finance diagnostics. Never throws, never recalculates. (02E)
 */
export function readFinanceFromLedger(doc: FinanceLedgerDoc): FinanceFigures {
  return resolveFigures(doc, FINANCE_NS)
}

/**
 * Read a ledger doc's REPORT figures — identical logic + guarantees to
 * readFinanceFromLedger, but records report diagnostics. For reports / analytics /
 * dashboards / exports (RD-PRICING-02F).
 */
export function readReportFromLedger(doc: FinanceLedgerDoc): FinanceFigures {
  return resolveFigures(doc, REPORT_NS)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Lenient REPORT reader for an untyped Firestore `doc.data()` — coerces the stored
 * ledger fields and reads snapshot-first (report namespace). Returned figures are
 * guaranteed byte-equal to the stored ledger values.
 */
export function readReportFromLedgerData(d: Record<string, unknown>): FinanceFigures {
  return readReportFromLedger({
    grossAmountPaise:        num(d.grossAmountPaise),
    platformFeeBasePaise:    num(d.platformFeeBasePaise),
    platformFeeGstPaise:     num(d.platformFeeGstPaise),
    platformFeeTotalPaise:   num(d.platformFeeTotalPaise),
    gatewayFeeEstimatePaise: num(d.gatewayFeeEstimatePaise),
    netSettlementPaise:      num(d.netSettlementPaise),
    pricingSnapshot:         typeof d.pricingSnapshot === 'string' ? d.pricingSnapshot : undefined,
    financials:              coerceFinancials(d.financials),
  })
}
