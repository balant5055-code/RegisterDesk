// RD-WAIVER-01 — the sports participation waiver. Server-only (node:crypto).
//
// ONE rule for whether an event requires a waiver, used by every surface that decides or shows
// it: the register page (what the attendee reads), /submit and /create-order (enforcement),
// createRegistration (the in-transaction re-check and the stamp) and the paid settlement copy.
//
//   required  ⇔  eventType === 'sports'
//             ∧  eventDetails.typeDetails.requireWaiver === true
//             ∧  eventDetails.typeDetails.waiverText is non-empty
//
// There is NO default wording. `lib/sports/waiverConfig.ts` holds a default text that nothing
// uses; it is deliberately not used here — an organizer who switches the waiver on must supply
// their own words (the publish gate refuses "on" with no wording), and a waiver nobody wrote is
// not one anybody can accept.
//
// What an acceptance records on the registration (all four, or none for a non-waiver event):
//   waiverRequired:   true
//   waiverAccepted:   true | false     — false = created without the attendee (walk-in, import)
//   waiverAcceptedAt: ISO string | null — server clock at the moment the attendee submitted
//   waiverTextHash:   sha256 hex of the exact wording that was shown and accepted
// `waiverAcceptedAt` keeps the ISO-string shape `RegistrationDocument` already declares and the
// participant export already reads.

import { createHash } from 'node:crypto'

export type EventWaiver =
  | { required: true; text: string; textHash: string }
  | { required: false }

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** The exact bytes that are hashed — trimmed and with normalised line endings, nothing more. */
export function normalizeWaiverText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

export function waiverTextHash(text: string): string {
  return createHash('sha256').update(normalizeWaiverText(text), 'utf8').digest('hex')
}

/** The waiver an event requires, from the event (or draft) document itself. */
export function resolveEventWaiver(event: unknown): EventWaiver {
  const e = rec(event)
  if (e.eventType !== 'sports') return { required: false }
  const td = rec(rec(e.eventDetails).typeDetails)
  if (td.requireWaiver !== true) return { required: false }
  const text = typeof td.waiverText === 'string' ? normalizeWaiverText(td.waiverText) : ''
  if (!text) return { required: false }
  return { required: true, text, textHash: waiverTextHash(text) }
}

// ─── Enforcement ──────────────────────────────────────────────────────────────

export interface WaiverAcceptanceInput {
  waiverAccepted?: unknown
  waiverTextHash?: unknown
}

export type WaiverCheck =
  | { ok: true; acceptance: { textHash: string } | null }
  | { ok: false; status: 400 | 409; code: 'WAIVER_NOT_ACCEPTED' | 'WAIVER_CHANGED'; error: string }

/**
 * The attendee's acceptance, checked against the waiver the event requires NOW.
 *
 * Only a literal `true` counts — never a truthy string. The hash must match the current
 * wording: an acceptance of text the organizer has since changed is not an acceptance of the
 * text in force, so the attendee is asked to re-read (409) rather than silently recorded.
 * For an event without a waiver the input is ignored and nothing is recorded.
 */
export function checkWaiverAcceptance(waiver: EventWaiver, input: WaiverAcceptanceInput): WaiverCheck {
  if (!waiver.required) return { ok: true, acceptance: null }
  if (input.waiverAccepted !== true) {
    return { ok: false, status: 400, code: 'WAIVER_NOT_ACCEPTED', error: 'Please read and accept the event waiver to register.' }
  }
  if (input.waiverTextHash !== waiver.textHash) {
    return { ok: false, status: 409, code: 'WAIVER_CHANGED', error: 'The event waiver has been updated. Please reload the page, read it and accept it again.' }
  }
  return { ok: true, acceptance: { textHash: waiver.textHash } }
}

/**
 * The fields a registration carries for its waiver.
 *
 * `acceptance` is present only when the ATTENDEE accepted, validated by checkWaiverAcceptance at
 * the moment they submitted. It is recorded as-is, with the hash of the wording THEY accepted:
 * on the paid path the organizer may edit the wording between checkout and settlement, and the
 * truthful record is still "accepted this text at this time" — not "not accepted". (The free path
 * refuses a mismatch inside its transaction, so there the hashes are always equal.)
 *
 * Without an acceptance — walk-in, import — a waiver event records `waiverAccepted: false`,
 * never an acceptance on the attendee's behalf. A non-waiver event records nothing at all.
 */
export function waiverRegistrationFields(
  waiver: EventWaiver,
  acceptance: { textHash: string; acceptedAt: string } | null,
): Record<string, unknown> {
  if (acceptance) {
    return { waiverRequired: waiver.required, waiverAccepted: true, waiverAcceptedAt: acceptance.acceptedAt, waiverTextHash: acceptance.textHash }
  }
  if (!waiver.required) return {}
  return { waiverRequired: true, waiverAccepted: false, waiverAcceptedAt: null, waiverTextHash: waiver.textHash }
}
