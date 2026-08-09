// MC-09 · What makes a grant request acceptable — PURE. No Firestore, no auth, no I/O.
//
// A grant creates credits out of nothing. There is no payment to reconcile it against and no
// organizer request that justifies it, so the only defences are the authorization gate and
// these rules. Extracted here so each one is provable by a unit test rather than by reading
// a route handler.

import { CREDIT_GRANT_REASONS, type CreditGrantReason } from '@/features/media-credits/types'

/**
 * The most credits one grant may create.
 *
 * Not a policy about generosity — a blast radius. A typo of 100000 instead of 1000 should be
 * refused by the system rather than caught by whoever reads the audit log afterwards. Larger
 * legitimate grants are still possible; they take several deliberate actions, each audited.
 */
export const MAX_GRANT_CREDITS = 100_000

/** Enough to say why. A one-word note explains nothing to whoever reads it in six months. */
export const MIN_NOTE_LENGTH = 10
export const MAX_NOTE_LENGTH = 500
export const MAX_REFERENCE_LENGTH = 120

export interface GrantRequest {
  organizerUid: string
  credits:      number
  reason:       string
  note:         string
  reference?:   string | null
}

export type GrantValidation =
  | { ok: true;  value: {
        organizerUid: string
        credits:      number
        reason:       CreditGrantReason
        note:         string
        reference:    string | null
      } }
  | { ok: false; field: string; message: string }

/**
 * Validates and NORMALISES a grant request.
 *
 * Returns the cleaned value rather than a boolean, so a caller cannot validate one shape and
 * then store a different one — the trimmed note and the truncated reference are what get
 * written, because they are what came back from here.
 */
export function validateGrant(input: GrantRequest): GrantValidation {
  const organizerUid = String(input.organizerUid ?? '').trim()
  if (!organizerUid) {
    return { ok: false, field: 'organizerUid', message: 'Choose an organizer to grant to.' }
  }

  const credits = input.credits
  if (typeof credits !== 'number' || !Number.isFinite(credits)) {
    return { ok: false, field: 'credits', message: 'Enter a number of credits.' }
  }
  if (!Number.isInteger(credits)) {
    // Credits are whole units everywhere else in the module; rounding here would make the
    // granted amount differ from the amount that was typed.
    return { ok: false, field: 'credits', message: 'Credits must be a whole number.' }
  }
  if (credits <= 0) {
    // A negative grant is a debit. Allowing it here would put a second, unaudited path to
    // removing credits beside the refund engine that owns that.
    return { ok: false, field: 'credits', message: 'Credits must be greater than zero.' }
  }
  if (credits > MAX_GRANT_CREDITS) {
    return {
      ok: false, field: 'credits',
      message: `A single grant is limited to ${MAX_GRANT_CREDITS.toLocaleString('en-IN')} credits.`,
    }
  }

  const reason = String(input.reason ?? '').trim()
  if (!CREDIT_GRANT_REASONS.includes(reason as CreditGrantReason)) {
    return { ok: false, field: 'reason', message: 'Choose a valid reason.' }
  }

  const note = String(input.note ?? '').trim()
  if (note.length < MIN_NOTE_LENGTH) {
    return {
      ok: false, field: 'note',
      message: `Explain why in at least ${MIN_NOTE_LENGTH} characters.`,
    }
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return {
      ok: false, field: 'note',
      message: `Keep the note under ${MAX_NOTE_LENGTH} characters.`,
    }
  }

  const rawRef   = String(input.reference ?? '').trim()
  const reference = rawRef.length > 0 ? rawRef.slice(0, MAX_REFERENCE_LENGTH) : null

  return {
    ok: true,
    value: { organizerUid, credits, reason: reason as CreditGrantReason, note, reference },
  }
}

/**
 * The ledger entry id for a grant.
 *
 * ONE definition, used by the writer and by the replay check. Two sites deriving this
 * separately is how an idempotency key drifts and a replay becomes a second grant.
 */
export function grantEntryId(grantId: string): string {
  return `grant:${grantId}`
}
