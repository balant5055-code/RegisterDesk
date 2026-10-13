// RD-PRINT-BILL-P5 · ID-badge GENERATION billing — the PURE decisions. No Firestore, no network.
//
// Approved decisions (2026-10-11):
//   D1  ONE billing claim per attendee per event — ID cards and badges share it.
//   D2  Reprints and regeneration are FREE once an attendee has been billed.
//   D3  Owner-only when a job contains chargeable attendees; staff keep free jobs and reprints.
//   D4  Chargeable count UP after the quote ⇒ a new quote is required; DOWN ⇒ proceed, and the
//       unused reserved units are trimmed at settlement.
//   D5  A paid job needs a stable requestId. Free jobs are unchanged.
//
// The server half (Firestore) is ./store.ts; the job wiring is lib/printAssets/generationJob.ts.

import crypto from 'crypto'
import { isChargeableBadgeAssetType, type EffectivePrintBadgeTerms } from '@/lib/licensing/printBadgeCommercial'

/** printBadgeClaims/{draftId}__{registrationId} — create-only; the ONE claim (D1). Retained on event deletion. */
export const PRINT_BADGE_CLAIMS = 'printBadgeClaims'
/** printBadgeRounds/{jobId}_r{n} — one reservation of units for one job. Retained on event deletion. */
export const PRINT_BADGE_ROUNDS = 'printBadgeRounds'

/** How long a quote may be relied on. */
export const BADGE_QUOTE_TTL_MS = 15 * 60_000
/** A reserved round older than this whose job is not running is reported by reconciliation. */
export const STALE_ROUND_MS = 24 * 60 * 60_000

/** The billing a job runs under. Absent on the job ⇒ free (every job created before Phase 5). */
export type PrintJobBillingMode = 'free' | 'complimentary' | 'paid'

/** printGenerationJobs/{jobId}.billing — written once at creation; `round` advances only on a re-quoted reopen. */
export interface PrintJobBilling {
  mode:            'complimentary' | 'paid'
  /** The CURRENT round (paid); 0 for complimentary. */
  round:           number
  /** Chargeable attendees at creation (paid); 0 for complimentary. */
  chargeable:      number
  /** Hash of the create request (paid) — a requestId reused with a different body is refused. */
  requestHash?:    string
  unitPricePaise:  number | null
}

export const claimDocId = (draftId: string, registrationId: string) => `${draftId}__${registrationId}`
export const roundDocId = (jobId: string, round: number) => `${jobId}_r${round}`
/** The ledger usage key of a round: `pgen_<id>_r<n>` (job ids already start with `pgen_`). */
export const roundUnitKey = roundDocId

/** The mode a NEW job runs in: non-chargeable asset types (and certificates) are always free. */
export function jobBillingModeFor(assetType: unknown, terms: Pick<EffectivePrintBadgeTerms, 'mode'>): PrintJobBillingMode {
  if (!isChargeableBadgeAssetType(assetType)) return 'free'
  return terms.mode
}

/** The billing mode an EXISTING job runs under (no snapshot ⇒ free, as it always was). */
export function billingOf(job: { billing?: unknown }): PrintJobBilling | null {
  const b = job.billing as Partial<PrintJobBilling> | undefined | null
  if (!b || (b.mode !== 'paid' && b.mode !== 'complimentary')) return null
  return {
    mode: b.mode, round: Number.isInteger(b.round) ? b.round as number : 0,
    chargeable: Number.isInteger(b.chargeable) ? b.chargeable as number : 0,
    ...(typeof b.requestHash === 'string' ? { requestHash: b.requestHash } : {}),
    unitPricePaise: typeof b.unitPricePaise === 'number' ? b.unitPricePaise : null,
  }
}

// ─── Reservation (badges BLOCK; there is no pay-as-you-go for badges) ─────────────

export type BadgeReserveDecision =
  | { ok: true }
  | { ok: false; available: number; shortfall: number }

/**
 * Unlike decideReserve (messaging), an event with no badge units is NOT "use PAYG": paid badge
 * generation has no other way to pay, so too few units always blocks — nothing is reserved.
 * `available` is availableUnits(ledgerLine(ledger, 'print_badges')).
 */
export function decideBadgeReserve(available: number, needed: number): BadgeReserveDecision {
  if (needed <= 0 || available >= needed) return { ok: true }
  return { ok: false, available, shortfall: needed - available }
}

// ─── Quote ────────────────────────────────────────────────────────────────────────

/** What a quote is about: a NEW job's selection, or a reopen of an existing job into round n. */
export type QuoteSubject =
  | { kind: 'create'; templateId: string; assetType: string; filters: unknown }
  | { kind: 'reopen'; jobId: string; round: number; mode: 'retry' | 'regenerate'; registrationIds: string[] }

export interface QuoteBinding {
  workspaceUid: string
  draftId:      string
  subject:      QuoteSubject
  chargeable:   number
  issuedAt:     number
}

/** Canonical JSON (sorted keys, arrays kept in order) so equal inputs hash equally. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/** Normalises a selection so the same selection always hashes the same (ids de-duplicated + sorted). */
export function normalizeSubject(s: QuoteSubject): QuoteSubject {
  if (s.kind === 'reopen') return { ...s, registrationIds: [...new Set(s.registrationIds)].sort() }
  const f = (s.filters ?? {}) as { pass?: string; category?: string; registrationIds?: string[] }
  return {
    ...s,
    filters: {
      ...(f.pass ? { pass: f.pass } : {}),
      ...(f.category ? { category: f.category } : {}),
      ...(f.registrationIds?.length ? { registrationIds: [...new Set(f.registrationIds)].sort() } : {}),
    },
  }
}

/**
 * The quote hash. Not a secret signature: a quote is the organizer's CONSENT to use up to
 * `chargeable` units for exactly this selection. Forging one cannot lower a charge — the job is
 * always charged its own recount, and a recount above the quoted number is refused (D4).
 */
export function badgeQuoteHash(b: QuoteBinding): string {
  return crypto.createHash('sha256')
    .update(canonical({ v: 1, ...b, subject: normalizeSubject(b.subject) }))
    .digest('hex')
}

export interface ClientQuote { quoteHash: string; chargeable: number; issuedAt: number }

export function parseClientQuote(raw: unknown): ClientQuote | null {
  if (!raw || typeof raw !== 'object') return null
  const q = raw as Record<string, unknown>
  if (typeof q.quoteHash !== 'string' || !/^[0-9a-f]{64}$/.test(q.quoteHash)) return null
  if (!Number.isInteger(q.chargeable) || (q.chargeable as number) < 0) return null
  if (!Number.isInteger(q.issuedAt) || (q.issuedAt as number) <= 0) return null
  return { quoteHash: q.quoteHash, chargeable: q.chargeable as number, issuedAt: q.issuedAt as number }
}

export type QuoteCheck =
  | { ok: true }
  | { ok: false; code: 'BILLING_QUOTE_REQUIRED' | 'QUOTE_INVALID' | 'QUOTE_EXPIRED' | 'QUOTE_CHANGED' }

/** Validates a client's quote against the server's own binding and the server's recount `actual`. */
export function checkQuote(
  quote: ClientQuote | null, binding: Omit<QuoteBinding, 'chargeable' | 'issuedAt'>, actual: number, nowMs: number,
): QuoteCheck {
  if (!quote) return { ok: false, code: 'BILLING_QUOTE_REQUIRED' }
  if (badgeQuoteHash({ ...binding, chargeable: quote.chargeable, issuedAt: quote.issuedAt }) !== quote.quoteHash) {
    return { ok: false, code: 'QUOTE_INVALID' }
  }
  if (quote.issuedAt > nowMs + 60_000 || nowMs - quote.issuedAt > BADGE_QUOTE_TTL_MS) return { ok: false, code: 'QUOTE_EXPIRED' }
  // D4 — more attendees to bill than the organizer agreed to ⇒ a new quote; fewer ⇒ proceed.
  if (actual > quote.chargeable) return { ok: false, code: 'QUOTE_CHANGED' }
  return { ok: true }
}

// ─── Per-attendee claim ─────────────────────────────────────────────────────────

export interface RoundState { status: 'reserved' | 'settled'; reserved: number; claimed: number }

export type ClaimDecision =
  /** Already billed (any job, any asset type, any round) — free (D1/D2). */
  | 'prior'
  /** Complimentary job: record the claim, no units. */
  | 'complimentary'
  /** Paid job: record the claim and count it against the round's reservation. */
  | 'new'
  /** The round is settled (or missing): billing for this run is closed — nothing is charged. */
  | 'closed'
  /** The round's reservation is used up — nothing is charged. */
  | 'exhausted'

export function decideClaim(mode: 'paid' | 'complimentary', claimExists: boolean, round: RoundState | null): ClaimDecision {
  if (claimExists) return 'prior'
  if (mode === 'complimentary') return 'complimentary'
  if (!round || round.status !== 'reserved') return 'closed'
  if (round.claimed >= round.reserved) return 'exhausted'
  return 'new'
}

export const BILLING_CLOSED_MESSAGE    = 'Badge billing for this run has closed — retry the job to get a new quote.'
export const UNITS_EXHAUSTED_MESSAGE   = 'The ID badges reserved for this job are used up — retry the job to get a new quote.'

/** Whether a job's status lets its open round be settled (terminal, and nobody can still claim against it). */
export function settleableJobStatus(status: unknown): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
