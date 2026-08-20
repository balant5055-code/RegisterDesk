// Organizer-level broadcast rate limits.
//
// Defaults apply to every organizer. Per-organizer overrides are stored in
// Firestore under organizerLimits/{uid} and are set by admins only.
//
// The daily counters are derived from the broadcastCampaigns collection so
// they stay consistent across serverless instances (unlike in-process counters).
//
// Day boundary: UTC midnight — consistent across all server instances.

import { Timestamp }    from 'firebase-admin/firestore'
import { adminDb }      from '@/lib/firebase/admin'

// ─── Default limits ───────────────────────────────────────────────────────────

export const DEFAULT_MAX_RECIPIENTS_PER_BROADCAST = 5_000
export const DEFAULT_MAX_BROADCASTS_PER_DAY       = 10
export const DEFAULT_MAX_RECIPIENTS_PER_DAY       = 25_000

// ─── Firestore schema for admin overrides ────────────────────────────────────

/**
 * RD-BCAST-LIMIT-01 — an explicit opt-out from the daily CAMPAIGN-COUNT cap.
 *
 * A literal, not a magic number. `999999` would work arithmetically and would be a lie:
 * nobody reading the document could tell a deliberate exemption from a typo, and every
 * future reader would have to guess whether 999999 meant "unlimited" or "someone leaned on
 * the 9 key". The word says what it means.
 *
 * It exempts ONLY the campaign-count check. Recipient caps, wallet billing, provider
 * limits and authorization are untouched — see checkBroadcastLimits.
 */
export const BROADCASTS_PER_DAY_UNLIMITED = 'unlimited' as const
export type BroadcastsPerDayLimit = number | typeof BROADCASTS_PER_DAY_UNLIMITED

// Collection: organizerLimits/{organizerUid}
// Any absent field falls back to the default above.
export interface OrganizerLimitsDoc {
  /** Max campaigns in a UTC calendar day, or 'unlimited' to disable that check. */
  broadcastsPerDay?:       BroadcastsPerDayLimit
  recipientsPerDay?:       number   // max total recipients across all campaigns today
  recipientsPerBroadcast?: number   // max recipients in a single campaign
}

/**
 * Normalises a stored `broadcastsPerDay` into something enforceable.
 *
 * Pure and exported so the precedence is testable without Firestore.
 *
 *   absent / null            → the default (10)
 *   'unlimited'              → unlimited (case- and whitespace-tolerant, since this is
 *                              typed by a human into a Firestore console)
 *   integer >= 0             → that exact limit (0 legitimately blocks; suspension has its
 *                              own mechanism, but an explicit 0 is still an explicit 0)
 *   anything else            → the default
 *
 * FAILS TO THE DEFAULT, NEVER TO UNLIMITED. A malformed value must not silently remove a
 * protection — the only way to be unlimited is to say so.
 */
export function resolveBroadcastsPerDay(raw: unknown): BroadcastsPerDayLimit {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === BROADCASTS_PER_DAY_UNLIMITED) {
    return BROADCASTS_PER_DAY_UNLIMITED
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw
  return DEFAULT_MAX_BROADCASTS_PER_DAY
}

// ─── Result types ─────────────────────────────────────────────────────────────

export type BroadcastLimitCode =
  | 'BROADCAST_TOO_LARGE'   // single campaign exceeds per-broadcast cap
  | 'DAILY_LIMIT_REACHED'   // too many campaigns sent today
  | 'RECIPIENT_LIMIT_REACHED' // daily recipient quota would be exceeded

/**
 * A refusal now carries WHY, not just a token. The organizer was previously shown the raw
 * string `DAILY_LIMIT_REACHED` with no number and no reset time — technically accurate and
 * practically useless.
 */
export interface BroadcastLimitRefusal {
  ok:     false
  code:   BroadcastLimitCode
  status: 422 | 429
  /** Human-readable, safe to display verbatim. */
  message: string
  /** How much of the limit is already consumed (campaigns or recipients, per `code`). */
  used?:   number
  limit?:  BroadcastsPerDayLimit
  /** ISO instant at which the daily window rolls over. Absent for non-daily refusals. */
  resetAt?: string
}

export type BroadcastLimitResult = { ok: true } | BroadcastLimitRefusal

// ─── Cap resolver (shared) ──────────────────────────────────────────────────────

/**
 * RD-ORGANIZER-04 P1-1: the effective per-broadcast recipient cap for `uid` (admin
 * override or default). Used to BOUND recipient discovery — an indexed count() aggregate
 * gates oversized audiences and every doc load is capped at this value + 1, so a broadcast
 * never loads an entire registration collection into memory. One organizerLimits doc read.
 */
export async function resolveMaxRecipientsPerBroadcast(uid: string): Promise<number> {
  const snap = await adminDb.doc(`organizerLimits/${uid}`).get()
  const o    = snap.exists ? (snap.data() as OrganizerLimitsDoc) : null
  return o?.recipientsPerBroadcast ?? DEFAULT_MAX_RECIPIENTS_PER_BROADCAST
}

// ─── Guard ────────────────────────────────────────────────────────────────────

/**
 * Checks all three broadcast limits for `uid` given that the proposed broadcast
 * would reach `newRecipientCount` recipients (after suppression filtering).
 *
 * Checks are ordered cheapest-first: the per-broadcast size check requires no
 * extra Firestore reads beyond the organizerLimits fetch.
 */
export async function checkBroadcastLimits(
  uid:              string,
  newRecipientCount: number,
): Promise<BroadcastLimitResult> {
  // ── 1. Fetch organizer-specific overrides (one doc read) ──────────────────
  const limitsSnap = await adminDb.doc(`organizerLimits/${uid}`).get()
  const overrides  = limitsSnap.exists
    ? limitsSnap.data() as OrganizerLimitsDoc
    : null

  const maxPerBroadcast = overrides?.recipientsPerBroadcast ?? DEFAULT_MAX_RECIPIENTS_PER_BROADCAST
  const maxBroadcasts   = resolveBroadcastsPerDay(overrides?.broadcastsPerDay)
  const maxRcpPerDay    = overrides?.recipientsPerDay       ?? DEFAULT_MAX_RECIPIENTS_PER_DAY

  // ── 2. BROADCAST_TOO_LARGE ────────────────────────────────────────────────
  if (newRecipientCount > maxPerBroadcast) {
    return {
      ok: false, code: 'BROADCAST_TOO_LARGE', status: 422,
      message: `This broadcast would reach ${newRecipientCount.toLocaleString()} recipients, above the per-broadcast limit of ${maxPerBroadcast.toLocaleString()}.`,
      used: newRecipientCount, limit: maxPerBroadcast,
    }
  }

  // ── 3. Fetch today's usage from Firestore ─────────────────────────────────
  // UTC midnight so the window is consistent across all server instances.
  const now = new Date()
  const startOfDayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const todayTs = Timestamp.fromDate(startOfDayUtc)

  // Select only 'recipientCount' — avoids fetching stored HTML (can be large).
  // Index required: broadcastCampaigns (organizerUid ASC, createdAt ASC)
  const todaySnap = await adminDb
    .collection('broadcastCampaigns')
    .where('organizerUid', '==', uid)
    .where('createdAt',    '>=', todayTs)
    .select('recipientCount')
    .get()

  const broadcastsToday = todaySnap.size
  let   recipientsToday = 0
  for (const doc of todaySnap.docs) {
    const d = doc.data() as { recipientCount?: number }
    recipientsToday += typeof d.recipientCount === 'number' ? d.recipientCount : 0
  }

  // ── 4. DAILY_LIMIT_REACHED ────────────────────────────────────────────────
  // Skipped ONLY when an admin has explicitly set this organizer to unlimited. Every
  // other organizer keeps the default cap, and the recipient checks below still run —
  // exemption from a campaign-COUNT limit is not exemption from volume protection.
  const resetAt = new Date(startOfDayUtc.getTime() + 24 * 60 * 60 * 1000).toISOString()
  if (maxBroadcasts !== BROADCASTS_PER_DAY_UNLIMITED && broadcastsToday >= maxBroadcasts) {
    return {
      ok: false, code: 'DAILY_LIMIT_REACHED', status: 429,
      message: `Daily broadcast limit reached — ${broadcastsToday} of ${maxBroadcasts} campaigns used today.`,
      used: broadcastsToday, limit: maxBroadcasts, resetAt,
    }
  }

  // ── 5. RECIPIENT_LIMIT_REACHED ────────────────────────────────────────────
  if (recipientsToday + newRecipientCount > maxRcpPerDay) {
    return {
      ok: false, code: 'RECIPIENT_LIMIT_REACHED', status: 429,
      message: `This broadcast would bring today’s recipients to ${(recipientsToday + newRecipientCount).toLocaleString()}, above the daily limit of ${maxRcpPerDay.toLocaleString()}.`,
      used: recipientsToday, limit: maxRcpPerDay, resetAt,
    }
  }

  return { ok: true }
}
