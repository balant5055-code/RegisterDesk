// MC-09 · Manual credit grants — SERVER ONLY.
//
// The last financial mutation in the module, and the only one with no counterparty: a
// purchase has a payment, a refund has a request, a consumption has an upload. A grant has
// nothing but an admin's judgement, which is why it is the most heavily guarded and the most
// heavily recorded.
//
// ═══ THIS FILE DOES NOT WRITE THE WALLET ═════════════════════════════════════
// It calls `creditInTx` — the same single writer that MC-04's purchase completion uses. The
// balance arithmetic, the ledger append, the `lifetimeGranted` accumulation and the
// idempotency check all live there and are not reimplemented here. This file owns the
// justification record and nothing else.
//
// ═══ ONE TRANSACTION ═════════════════════════════════════════════════════════
//   creditInTx     reads the wallet, appends `grant:{grantId}`, writes the balance
//   createInTx     appends the justification with `tx.create`
//
// Both or neither. A granted balance with no record of why would be indistinguishable from a
// bug, and a justification with no movement would be a lie in the audit trail.
//
// ═══ IDEMPOTENCY, TWICE ══════════════════════════════════════════════════════
// The grantId is supplied by the CALLER and is the whole key. `creditInTx` short-circuits a
// replay on `entryId`, and `tx.create` on the grant document then fails a concurrent second
// attempt outright. A retried request — a double-clicked button, a proxy replay, a client
// that timed out and resent — returns the original grant rather than creating a second one.

import { adminDb } from '@/lib/firebase/admin'
import { creditInTx, getCreditPolicy } from '@/features/media-credits/services'
import * as grantRepo  from '@/features/media-credits/repositories/grantRepo'
import { CreditsDisabledError, InvalidCreditOperationError } from '@/features/media-credits/errors'
import { grantEntryId, validateGrant, type GrantRequest } from '@/features/media-credits/utils/grantValidation'
import type { CreditGrantDto } from '@/features/media-credits/types'

export interface CreateGrantInput extends GrantRequest {
  /**
   * Caller-supplied idempotency key AND the document id.
   *
   * Required, never generated here: a key minted inside the service would be new on every
   * retry, which is the opposite of what it is for.
   */
  grantId:  string
  /** The admin. Never the organizer — nobody grants credits to themselves through this. */
  actorUid: string
}

export interface CreateGrantResult {
  grant: CreditGrantDto
  /** True when this call created the grant; false when it returned an existing one. */
  created: boolean
}

/**
 * Grants credits to an organizer.
 *
 * Safe to call repeatedly with the same `grantId`.
 */
export async function createGrant(input: CreateGrantInput): Promise<CreateGrantResult> {
  // Granting into a module that is switched off would create a liability nobody can spend
  // and nothing would surface it — the organizer's dashboard renders "credits are not in use".
  const policy = await getCreditPolicy()
  if (!policy.creditsEnabled) throw new CreditsDisabledError()

  const grantId = String(input.grantId ?? '').trim()
  if (!grantId) throw new InvalidCreditOperationError('a grant id is required')

  const check = validateGrant(input)
  if (!check.ok) throw new InvalidCreditOperationError(check.message)
  const v = check.value

  const actorUid = String(input.actorUid ?? '').trim()
  if (!actorUid) throw new InvalidCreditOperationError('an actor is required')

  // Cheap pre-check, outside the transaction. Not the guard — the transaction is — but it
  // turns the common replay into one read instead of a contended write that must fail.
  const existing = await grantRepo.read(grantId)
  if (existing) return { grant: grantRepo.toDto(existing), created: false }

  try {
    const doc = await adminDb.runTransaction(async tx => {
      // Re-read inside the transaction: between the pre-check and here, a concurrent request
      // with the same id may have committed.
      const replay = await grantRepo.readInTx(tx, grantId)
      if (replay) return { doc: replay, created: false }

      // MUST precede the first write — it reads the wallet, and Firestore forbids a read
      // after a write in one transaction.
      //
      // The resulting balance comes back from the movement itself. Reading the wallet after
      // this call is what Firestore rejects, and recomputing `prior + credits` here would be
      // a second implementation of arithmetic the ledger already did — so the grant record
      // and the ledger entry carry the same number by construction, not by agreement.
      const balanceAfter = await creditInTx(tx, {
        organizerUid: v.organizerUid,
        entryId:      grantEntryId(grantId),
        credits:      v.credits,
        reason:       'grant',
        actorUid,
        actorKind:    'platform',
      })

      grantRepo.createInTx(tx, {
        grantId,
        organizerUid: v.organizerUid,
        credits:      v.credits,
        reason:       v.reason,
        note:         v.note,
        reference:    v.reference,
        actorUid,
        entryId:      grantEntryId(grantId),
        balanceAfter,
      })

      return {
        doc: {
          grantId, schemaVersion: 0,
          organizerUid: v.organizerUid, credits: v.credits, reason: v.reason,
          note: v.note, reference: v.reference, actorUid,
          entryId: grantEntryId(grantId), balanceAfter,
          createdAt: null,
        },
        created: true,
      }
    })

    // Deliberately no opsLog here. That logger is scoped 'media-credits.sessions' and a
    // grant is not a session event. The grant is already recorded in three places that
    // matter — the ledger entry, the grant document and adminAuditLogs — and a fourth line
    // under the wrong scope would make the session log harder to read, not the grant easier.

    // Re-read so the caller gets the committed document with its real server timestamp,
    // rather than the placeholder assembled inside the transaction.
    const stored = await grantRepo.read(grantId)
    return {
      grant:   stored ? grantRepo.toDto(stored) : grantRepo.toDto(doc.doc),
      created: doc.created,
    }
  } catch (err) {
    // `tx.create` on an existing id lands here when two requests raced. The grant that won
    // is the correct answer — reporting a failure would invite an admin to grant again.
    const raced = await grantRepo.read(grantId)
    if (raced) return { grant: grantRepo.toDto(raced), created: false }
    throw err
  }
}

export async function listGrants(
  organizerUid: string | null, limit: number, cursor?: string | null,
): Promise<{ grants: CreditGrantDto[]; nextCursor: string | null }> {
  const page = await grantRepo.list({ organizerUid, limit, cursor })
  return { grants: page.grants.map(grantRepo.toDto), nextCursor: page.nextCursor }
}

export async function grantTotals(): Promise<{
  count: number; credits: number; truncated: boolean
}> {
  return grantRepo.totals()
}

export const grantService = { createGrant, listGrants, grantTotals }
