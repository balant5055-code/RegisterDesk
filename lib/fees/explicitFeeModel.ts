// RD-FEE-RESTORE-01 — the EXPLICIT fee-collection record, and why the legacy field is ignored.
//
// ═══ THE PROBLEM THIS SOLVES ═════════════════════════════════════════════════
// `pricing.feeModel` has existed on every event for months, but nothing has ever charged by
// it: RD-PHASE4-S3 · Q1 fixed collection to organizer-pays, and checkout passes
// `SUPPORTED_FEE_MODEL` with the stored value documented as "NOT an input". So a live event
// carrying `attendee_pays` has ALWAYS been charged organizer-absorbs. The value is not a
// record of behaviour; it is a record of something an organizer once picked in a UI that was
// later removed.
//
// Restoring organizer choice therefore cannot simply start reading that field. Doing so would
// silently begin charging attendees platform fees on existing published events whose real,
// observed behaviour has never included them — changing live economics by reinterpreting
// stale data.
//
// ═══ THE RULE ════════════════════════════════════════════════════════════════
// A SEPARATE field, `pricing.feeCollection`, written only by the restored flow. Its ABSENCE
// is the whole compatibility story: every event that exists today lacks it, so every event
// that exists today keeps organizer-absorbs, by construction — no backfill, no migration, no
// data rewrite, and nothing to get wrong at scale.
//
// `pricing.feeModel` is deliberately left in place and deliberately never read here. It stays
// as audit of what was once selected; this module is the only thing that decides what is
// CHARGED.
//
// Pure: no I/O, no Firebase, client- and server-safe, so the builder, the checkout route and
// the preview route all share one definition rather than three copies of a precedence rule.

import type { FeeModel as EngineFeeModel } from '@/lib/fees/types'

/** The builder's vocabulary. Mirrors lib/events/builder/types.ts FeeModel, duplicated as a
 *  string union rather than imported so this module stays free of the builder's type graph
 *  (which reaches lucide-react and component props). */
export type BuilderFeeModel = 'attendee_pays' | 'organizer_absorbs'

export const FEE_COLLECTION_VERSION = 1 as const

/**
 * `pricing.feeCollection` — an organizer's EXPLICIT, recorded choice.
 *
 * Written only when the pricing engine is enabled and an organizer actually selected a model.
 * Never written by a migration, a default, or a coercion: if it is present, a human chose it.
 */
export interface FeeCollectionRecord {
  model:   BuilderFeeModel
  /** ISO-8601. When the choice was recorded — lets a reader reason about which checkouts predate it. */
  setAt:   string
  /** Authenticated organizer uid (or the admin uid for an administrative change). */
  setBy:   string
  version: typeof FEE_COLLECTION_VERSION
}

function isBuilderFeeModel(v: unknown): v is BuilderFeeModel {
  return v === 'attendee_pays' || v === 'organizer_absorbs'
}

/**
 * Read the explicit record off a pricing object, or null when there isn't one.
 *
 * Null means "this event never opted in" — the caller must then use its existing default.
 * Anything malformed is also null: a half-written or hand-edited record must fall back to
 * today's behaviour rather than be guessed at, because the guess would move money.
 */
export function readFeeCollection(pricing: unknown): FeeCollectionRecord | null {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return null
  const raw = (pricing as { feeCollection?: unknown }).feeCollection
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!isBuilderFeeModel(r.model)) return null
  if (typeof r.setAt !== 'string' || !r.setAt) return null
  if (typeof r.setBy !== 'string' || !r.setBy) return null
  return { model: r.model, setAt: r.setAt, setBy: r.setBy, version: FEE_COLLECTION_VERSION }
}

/**
 * The ENGINE fee model this event has explicitly opted into, or null for every legacy event.
 *
 * The mapping is the canonical one (`builderFeeModelToEngine`), inlined as a single ternary
 * rather than imported for the same reason the union above is duplicated — keeping this
 * module out of the builder's type graph. The two must agree; `feeModelRestore.test.ts`
 * asserts they do, against the real `builderFeeModelToEngine`.
 */
export function explicitFeeModel(pricing: unknown): EngineFeeModel | null {
  const rec = readFeeCollection(pricing)
  if (!rec) return null
  return rec.model === 'attendee_pays' ? 'customer_pays' : 'organizer_pays'
}

/**
 * Build a record to persist. `setAt` is passed in rather than read from the clock so callers
 * inside a Firestore transaction (which may retry) produce a stable value, and so tests are
 * deterministic.
 */
export function buildFeeCollection(model: BuilderFeeModel, setBy: string, setAtIso: string): FeeCollectionRecord {
  return { model, setAt: setAtIso, setBy, version: FEE_COLLECTION_VERSION }
}
