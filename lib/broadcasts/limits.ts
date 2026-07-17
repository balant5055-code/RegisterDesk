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

// Collection: organizerLimits/{organizerUid}
// Any absent field falls back to the default above.
export interface OrganizerLimitsDoc {
  broadcastsPerDay?:       number   // max campaigns in a UTC calendar day
  recipientsPerDay?:       number   // max total recipients across all campaigns today
  recipientsPerBroadcast?: number   // max recipients in a single campaign
}

// ─── Result types ─────────────────────────────────────────────────────────────

export type BroadcastLimitCode =
  | 'BROADCAST_TOO_LARGE'   // single campaign exceeds per-broadcast cap
  | 'DAILY_LIMIT_REACHED'   // too many campaigns sent today
  | 'RECIPIENT_LIMIT_REACHED' // daily recipient quota would be exceeded

export type BroadcastLimitResult =
  | { ok: true }
  | { ok: false; code: BroadcastLimitCode; status: 422 | 429 }

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
  const maxBroadcasts   = overrides?.broadcastsPerDay       ?? DEFAULT_MAX_BROADCASTS_PER_DAY
  const maxRcpPerDay    = overrides?.recipientsPerDay       ?? DEFAULT_MAX_RECIPIENTS_PER_DAY

  // ── 2. BROADCAST_TOO_LARGE ────────────────────────────────────────────────
  if (newRecipientCount > maxPerBroadcast) {
    return { ok: false, code: 'BROADCAST_TOO_LARGE', status: 422 }
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
  if (broadcastsToday >= maxBroadcasts) {
    return { ok: false, code: 'DAILY_LIMIT_REACHED', status: 429 }
  }

  // ── 5. RECIPIENT_LIMIT_REACHED ────────────────────────────────────────────
  if (recipientsToday + newRecipientCount > maxRcpPerDay) {
    return { ok: false, code: 'RECIPIENT_LIMIT_REACHED', status: 429 }
  }

  return { ok: true }
}
