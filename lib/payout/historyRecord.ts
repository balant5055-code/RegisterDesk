// RD-FINANCE-CLOSURE-02 · What a payout-change audit record CONTAINS.
//
// PURE. No Firestore, no Admin SDK, no server timestamp — so the security property that
// matters ("this record can never be used to send money anywhere") is unit-tested directly
// in Node, with no emulator and no Firebase boot.
//
// The Firestore half — the append-only write and the scoped read — is `lib/payout/history.ts`.
// Splitting them is the same contract `registrationMatch.ts` / `registrationVerify.ts`
// already follow in this codebase: the RULE is pure and testable, the QUERY lives in the
// module that owns the database.
//
// `createdAt` is deliberately NOT set here. The write layer stamps it, so this module has
// no dependency on the SDK at all.

import { decryptPii } from '@/lib/payout/encryption'
import { maskDestination, maskPan, type MaskedDestination } from '@/lib/payout/mask'
import type { OrganizerPayoutProfileDoc, PayoutMethod } from '@/lib/payout/types'

/** The fields a change is reported against. Order is the display order. */
export const AUDITED_FIELDS = [
  'accountHolderName', 'payoutMethod', 'bankName',
  'accountNumber', 'ifscCode', 'upiId', 'panNumber', 'gstNumber',
] as const

export type AuditedField = typeof AUDITED_FIELDS[number]

/** Plaintext snapshot, used ONLY to compute the diff and the mask. Never stored. */
export interface PayoutSnapshot {
  accountHolderName: string
  payoutMethod:      PayoutMethod
  bankName:          string | null
  accountNumber:     string | null
  ifscCode:          string | null
  upiId:             string | null
  panNumber:         string
  gstNumber:         string | null
}

/** The stored document, minus the timestamp the write layer adds. */
export interface PayoutHistoryFields {
  organizerUid:  string
  actorUid:      string
  action:        'created' | 'updated'
  changedFields: AuditedField[]
  /** Null on the first save — there was no previous destination. */
  previous:      MaskedDestination | null
  next:          MaskedDestination
  previousPanMasked:  string | null
  nextPanMasked:      string | null
  previousHolderName: string | null
  nextHolderName:     string
  /** True whenever this save cleared an existing verification. */
  verificationReset: boolean
  /** Whether the profile was verified immediately BEFORE this change. */
  wasVerified:   boolean
  source:        'organizer_portal'
  requestIp:     string | null
  userAgent:     string | null
}

/**
 * Decrypts a stored profile into the plaintext snapshot the diff needs.
 *
 * `encryptPii` uses a random IV, so encrypting the SAME account number twice produces
 * different ciphertext. Comparing stored values directly would report every field as
 * changed on every save, so the comparison has to happen on plaintext.
 */
export function snapshotFromDoc(d: OrganizerPayoutProfileDoc): PayoutSnapshot {
  return {
    accountHolderName: d.accountHolderName ?? '',
    payoutMethod:      d.payoutMethod,
    bankName:          d.bankName ?? null,
    accountNumber:     decryptPii(d.accountNumber),
    ifscCode:          decryptPii(d.ifscCode),
    upiId:             d.upiId ?? null,
    panNumber:         decryptPii(d.panNumber) ?? '',
    gstNumber:         d.gstNumber ?? null,
  }
}

const norm = (v: string | null | undefined): string => (v ?? '').trim()

/** Which audited fields actually differ. Empty when the organizer re-saved unchanged data. */
export function diffSnapshots(
  before: PayoutSnapshot | null, after: PayoutSnapshot,
): AuditedField[] {
  if (!before) return [...AUDITED_FIELDS]
  return AUDITED_FIELDS.filter(f => norm(before[f]) !== norm(after[f]))
}

/** Builds the record's fields. Every payout identifier is masked on the way in. */
export function buildHistoryRecord(params: {
  organizerUid: string
  actorUid:     string
  before:       PayoutSnapshot | null
  after:        PayoutSnapshot
  wasVerified:  boolean
  requestIp:    string | null
  userAgent:    string | null
}): PayoutHistoryFields {
  const { organizerUid, actorUid, before, after, wasVerified, requestIp, userAgent } = params

  return {
    organizerUid,
    actorUid,
    action:        before ? 'updated' : 'created',
    changedFields: diffSnapshots(before, after),
    previous:      before ? maskDestination(before) : null,
    next:          maskDestination(after),
    previousPanMasked:  before ? maskPan(before.panNumber) : null,
    nextPanMasked:      maskPan(after.panNumber),
    previousHolderName: before ? before.accountHolderName : null,
    nextHolderName:     after.accountHolderName,
    // Every PUT resets verification; it is only a RESET when something was verified.
    verificationReset: wasVerified,
    wasVerified,
    source:    'organizer_portal',
    requestIp,
    userAgent,
  }
}
