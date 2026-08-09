// RD-FINANCE-CLOSURE-02 · Append-only payout-profile change history — SERVER ONLY.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// RD-FINANCE-CLOSURE-01 found that an organizer could change the bank account money is
// paid into with no record of who changed it, when, or what it was before. Changing the
// destination and then requesting a settlement is the classic payout-fraud path, and there
// was nothing to detect or investigate it with. Re-verification was already forced (the
// PUT resets `isVerified`), which is the right control — but a control with no trail.
//
// ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
// It is NOT a second copy of the payout credentials. Nothing stored here is reversible into
// an account number: destinations are MASKED (lib/payout/mask.ts) — not plaintext, and not
// ciphertext either, because a second encrypted copy is a second thing to leak and a second
// thing to rotate. The encrypted profile remains the one and only source of the real values.
//
// ═══ APPEND-ONLY ═════════════════════════════════════════════════════════════
// This module exposes exactly ONE write, and it uses `batch.create()` on a fresh auto-id
// reference. `create` fails if the document already exists, so a record can never be
// overwritten even by a bug. There is deliberately no update and no delete function — not a
// guarded one, not a private one. Firestore rules deny all client access to the collection.
//
// The record's CONTENT is decided by the pure `lib/payout/historyRecord.ts`.

import { FieldValue, type WriteBatch } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import type { PayoutHistoryFields } from '@/lib/payout/historyRecord'

export const PAYOUT_PROFILE_HISTORY = 'payoutProfileHistory'

/** What the read API returns — the stored fields plus an id and an ISO timestamp. */
export interface PayoutProfileHistoryEntry extends PayoutHistoryFields {
  id:        string
  createdAt: string | null
}

/**
 * Stages the history write on the CALLER's batch.
 *
 * A batch participant rather than its own write, so the profile change and its audit record
 * commit together — see the PUT handler for why a batch and not a transaction. The point is
 * that a saved payout change can never exist without its record.
 *
 * `create` on a fresh auto-id ref: append-only enforced at the call site, not merely by
 * convention. The server timestamp is applied here, which is what keeps `historyRecord.ts`
 * free of any SDK dependency.
 */
export function stageHistoryRecord(batch: WriteBatch, fields: PayoutHistoryFields): void {
  batch.create(adminDb.collection(PAYOUT_PROFILE_HISTORY).doc(), {
    ...fields,
    createdAt: FieldValue.serverTimestamp(),
  })
}

/** ISO-serialises a Firestore timestamp for the read API. */
function tsToISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

/**
 * One workspace's history, newest first.
 *
 * Scoped by `organizerUid` IN THE QUERY — the caller passes `authz.workspaceUid`, which is
 * derived from the caller's own membership and can never be supplied by the client. Tenant
 * isolation is therefore a property of the query, not a filter applied afterwards.
 *
 * Requires the composite index (organizerUid ASC, createdAt DESC) declared in
 * firestore.indexes.json.
 */
export async function listPayoutHistory(
  organizerUid: string, limit = 50,
): Promise<PayoutProfileHistoryEntry[]> {
  const snap = await adminDb.collection(PAYOUT_PROFILE_HISTORY)
    .where('organizerUid', '==', organizerUid)
    .orderBy('createdAt', 'desc')
    .limit(Math.min(Math.max(1, limit), 200))
    .get()

  return snap.docs.map(d => {
    const data = d.data() as PayoutHistoryFields & { createdAt?: unknown }
    return { ...data, id: d.id, createdAt: tsToISO(data.createdAt) }
  })
}
