// Server-only. "Approved Contact List" registration access — the ONE rule, shared by
// POST /api/registrations/submit (free) and POST /api/registrations/create-order (paid).
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// The event builder offers "Only pre-approved contacts can register" and stores the list at
// accessControl.approvedContacts — but the only server-side access check was validateInviteCode,
// which returns valid for every mode except invite_code. Anyone with the link could register.
//
// ═══ IDENTITY: ONLY A VERIFIED EMAIL COUNTS ══════════════════════════════════
// The attendee email in a registration request is typed by the client, so matching it against
// the list alone would let anyone register by typing an approved person's address. Eligibility
// is decided from an email the platform has VERIFIED, from the two mechanisms that already exist:
//   • the attendee session (Email OTP → HMAC-signed httpOnly cookie, server-revocable), and
//   • a Firebase ID token whose `email_verified` claim is true.
// The registration must also be FOR that verified email — an approved contact cannot register
// someone else under their own verification.
//
// Phone numbers in the list cannot be verified by either mechanism, so a contact listed with a
// phone only cannot register; that is reported to the attendee rather than silently allowed.
// Everything fails CLOSED: no verified identity, an empty or malformed list, or a mismatch all
// refuse. The list itself never leaves the server — refusals never say who IS on it.

import type { DecodedIdToken } from 'firebase-admin/auth'
import { normalizeEmail } from '@/lib/attendee/identity'
import { verifyAttendeeSession } from '@/lib/attendee/auth'

export type ApprovedContactCheck =
  | { ok: true }
  | { ok: false; status: 403; reason: string; error: string }

const isApprovedContactsMode = (accessControl: unknown): boolean =>
  !!accessControl && typeof accessControl === 'object' && (accessControl as { type?: unknown }).type === 'approved_contacts'

/** Normalised, plausibly-valid emails from the stored list (malformed rows are ignored). */
export function approvedContactEmails(accessControl: unknown): Set<string> {
  const list = (accessControl as { approvedContacts?: unknown } | null)?.approvedContacts
  const out = new Set<string>()
  if (!Array.isArray(list)) return out
  for (const row of list) {
    const raw = row && typeof row === 'object' ? (row as { email?: unknown }).email : undefined
    if (typeof raw !== 'string') continue
    const e = normalizeEmail(raw)
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) out.add(e)
  }
  return out
}

/**
 * PURE. May this registration proceed under the event's access control?
 * Any mode other than approved_contacts is not this function's concern (open / invite_code
 * keep their existing handling) and always passes.
 */
export function checkApprovedContactAccess(input: {
  accessControl:  unknown
  attendeeEmail:  string
  verifiedEmails: (string | null | undefined)[]
}): ApprovedContactCheck {
  if (!isApprovedContactsMode(input.accessControl)) return { ok: true }

  const approved = approvedContactEmails(input.accessControl)
  if (approved.size === 0) {
    return { ok: false, status: 403, reason: 'APPROVED_CONTACTS_UNAVAILABLE', error: 'This event is not accepting registrations.' }
  }
  const verified = new Set(input.verifiedEmails.filter((e): e is string => typeof e === 'string' && !!e.trim()).map(normalizeEmail))
  if (verified.size === 0) {
    return {
      ok: false, status: 403, reason: 'APPROVED_CONTACT_VERIFICATION_REQUIRED',
      error: 'Registration for this event is limited to approved contacts. Verify your email address (attendee sign-in) to continue.',
    }
  }
  const attendee = normalizeEmail(input.attendeeEmail ?? '')
  if (!verified.has(attendee)) {
    return {
      ok: false, status: 403, reason: 'APPROVED_CONTACT_EMAIL_MISMATCH',
      error: 'Please register with the email address you verified.',
    }
  }
  if (!approved.has(attendee)) {
    return {
      ok: false, status: 403, reason: 'NOT_APPROVED_CONTACT',
      error: 'Registration for this event is limited to approved contacts, and this email address is not on the list.',
    }
  }
  return { ok: true }
}

/**
 * The emails this request has VERIFIED. Reads the attendee session cookie only when the event
 * actually uses approved contacts, so open / invite-code checkouts do no extra work.
 */
export async function verifiedRegistrationEmails(
  accessControl: unknown,
  decodedToken:  DecodedIdToken | null | undefined,
): Promise<string[]> {
  if (!isApprovedContactsMode(accessControl)) return []
  const out: string[] = []
  if (decodedToken?.email && decodedToken.email_verified === true) out.push(decodedToken.email)
  try {
    const session = await verifyAttendeeSession()
    if (session?.normalizedEmail) out.push(session.normalizedEmail)
  } catch {
    // no request cookie context / unreadable session ⇒ no verified identity from it (fail closed)
  }
  return out
}
