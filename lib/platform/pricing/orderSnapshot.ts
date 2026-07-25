// RD-PRICING-01F — immutable Order pricing snapshot. SERVER-ONLY, side-effect free.
//
// An OrderPricingSnapshot is the PERMANENT financial record stamped on an Order at
// creation time from a resolved PricingSummary. Once created it is immutable and
// self-verifying (SHA-256 checksum).
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ BUSINESS RULE (Phase 6):                                                      │
// │   A historical Order must NEVER call resolveEffectivePricingSummary() to      │
// │   re-derive its pricing — configuration changes after the order was placed    │
// │   would corrupt the historical record. It must ALWAYS read its OWN stored     │
// │   snapshot. resolveEffectivePricingSummary() is for NEW orders only.          │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// Storage is NOT wired here (Phase 5/8): this module only prepares the type, creator,
// checksum, validation, and (de)serialization. Consumer wiring is RD-PRICING-02A.
//
// Future integration points (Phase 7) — where the STORED snapshot (never a fresh
// resolve) will be read:
//   • Payments    — the amount charged (attendeePays) at order/capture.
//   • Wallet      — organizer credit = organizerReceives.
//   • Refunds     — reverse the STORED attendeePays / platformRevenue, never re-resolve.
//   • Settlements — payout math from the stored organizerReceives / gatewayCost.
//   • Finance     — ledger postings keyed to platformRevenue / GST components.
//   • Reports     — historical revenue/tax reporting off the stored breakdown.
//   • Invoices    — line items rendered from the snapshot (immutable).
//   • Analytics / Exports — aggregate over stored snapshots, not live config.

import crypto from 'crypto'
import { validatePricingSummary } from './validation'
import type { OrderPricingSnapshot, PricingSummary, ValidationResult } from './types'

/** Snapshot ENVELOPE version. Bump if the snapshot shape / canonicalization changes. */
export const ORDER_SNAPSHOT_VERSION = 1

// ─── Canonicalization + checksum ───────────────────────────────────────────────────
//
// Canonical JSON = recursively KEY-SORTED JSON, so the same logical snapshot always
// hashes identically regardless of field insertion order. JSON.stringify maps the
// `Infinity` in an unlimited registrationLimit to `null` deterministically; that is
// the Firestore-safe wire form, and it round-trips (deserialize restores Infinity).

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** SHA-256 (hex) over the canonical snapshot content (the snapshot WITHOUT pricingChecksum). */
export function computePricingChecksum(content: Omit<OrderPricingSnapshot, 'pricingChecksum'>): string {
  return crypto.createHash('sha256').update(canonicalJson(content)).digest('hex')
}

function deepFreeze<T>(o: T): T {
  Object.freeze(o)
  for (const key of Object.keys(o as object)) {
    const v = (o as Record<string, unknown>)[key]
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v)
  }
  return o
}

// Restore unlimited limits (null → Infinity) after JSON parse, for the three
// registrationLimit-bearing fields. Defensive against malformed input.
function reviveUnlimited(s: OrderPricingSnapshot): OrderPricingSnapshot {
  const fix = (t: { value: number | null } | undefined | null): void => {
    if (t && t.value === null) t.value = Infinity
  }
  fix(s.registrationLimit as { value: number | null } | undefined)
  fix(s.license?.registrationLimit as { value: number | null } | undefined)
  fix(s.trace?.registrationLimit as { value: number | null } | undefined)
  return s
}

// ─── Creator (Phase 2) ───────────────────────────────────────────────────────────

/**
 * Build the immutable OrderPricingSnapshot from a resolved PricingSummary. The result
 * is deep-frozen (consumers must never mutate it — Phase 8) and carries a SHA-256
 * checksum over its canonical content.
 */
export function createOrderPricingSnapshot(summary: PricingSummary): OrderPricingSnapshot {
  const content: Omit<OrderPricingSnapshot, 'pricingChecksum'> = {
    ...summary,
    snapshotVersion: ORDER_SNAPSHOT_VERSION,
  }
  const pricingChecksum = computePricingChecksum(content)
  return deepFreeze({ ...content, pricingChecksum })
}

// ─── Validation (Phase 4) ──────────────────────────────────────────────────────────

/**
 * Verify a snapshot: required fields, versions, the money-total invariants (reusing
 * the summary invariants), and the checksum (tamper/corruption detection).
 */
export function validateOrderPricingSnapshot(snapshot: OrderPricingSnapshot): ValidationResult {
  const errors: string[] = []

  // required fields + versions
  if (!Number.isInteger(snapshot.snapshotVersion) || snapshot.snapshotVersion < 1) errors.push('snapshotVersion must be a positive integer')
  if (!Number.isInteger(snapshot.pricingVersion)  || snapshot.pricingVersion  < 1) errors.push('pricingVersion must be a positive integer')
  if (!Number.isInteger(snapshot.configurationVersion) || snapshot.configurationVersion < 0) errors.push('configurationVersion must be a non-negative integer')
  if (snapshot.currency !== 'INR') errors.push("currency must be 'INR'")
  if (typeof snapshot.resolvedAt !== 'string' || !snapshot.resolvedAt) errors.push('resolvedAt is required')
  if (typeof snapshot.pricingChecksum !== 'string' || !snapshot.pricingChecksum) errors.push('pricingChecksum is required')

  // money totals (same invariants the summary guarantees)
  const money = validatePricingSummary(snapshot)
  if (!money.ok) errors.push(...money.errors)

  // checksum integrity
  if (typeof snapshot.pricingChecksum === 'string' && snapshot.pricingChecksum) {
    const { pricingChecksum, ...content } = snapshot
    if (computePricingChecksum(content) !== pricingChecksum) {
      errors.push('pricingChecksum mismatch — snapshot tampered or corrupted')
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true }
}

// ─── Serialization (Phase 5) ────────────────────────────────────────────────────────

/** Canonical, Firestore-safe JSON string (sorted keys; unlimited → null). */
export function serializeOrderPricingSnapshot(snapshot: OrderPricingSnapshot): string {
  return canonicalJson(snapshot)
}

/** Parse + revive + validate. Returns the frozen snapshot, or the validation errors. */
export function deserializeOrderPricingSnapshot(
  json: string,
): { ok: true; snapshot: OrderPricingSnapshot } | { ok: false; errors: string[] } {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return { ok: false, errors: ['invalid JSON'] } }
  if (!parsed || typeof parsed !== 'object') return { ok: false, errors: ['snapshot must be an object'] }

  const snapshot = reviveUnlimited(parsed as OrderPricingSnapshot)
  const check = validateOrderPricingSnapshot(snapshot)
  if (!check.ok) return { ok: false, errors: check.errors }
  return { ok: true, snapshot: deepFreeze(snapshot) }
}
