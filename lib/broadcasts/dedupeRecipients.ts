// "Ignore duplicate email IDs" — collapse an email audience to one recipient per address.
// PURE: no Firebase, no React, no I/O. Server and test both import it directly.
//
// ═══ WHY THIS IS NEEDED ══════════════════════════════════════════════════════
// The audience query returns one row per REGISTRATION, and `limitPerEmail` defaults to false
// (see walkin/route.ts), so one person may legitimately hold several registrations — family
// or team sign-ups, multiple passes, a repeat entry. Broadcasting to that audience mails them
// once per registration. This is the organizer's opt-in to mail them once per address.
//
// ═══ WHY THE KEY IS trim().toLowerCase() ═════════════════════════════════════
// It is already the platform's email identity rule: every one of the four registration
// writers normalises this way (submit, walk-in, CSV import, and the paid path via
// create-order), the organizer edit path uses normalizeEmail(), and the broadcast pipeline
// itself matches the suppression list with `email.toLowerCase().trim()`. Re-normalising here
// is therefore usually a no-op — kept because it costs nothing and makes the result correct
// for any row written before that rule existed, and for the paid path, which inherits its
// normalisation from an upstream file rather than asserting it locally.
//
// ═══ WHAT IS DELIBERATELY NOT DONE ═══════════════════════════════════════════
// Nothing is mutated and no stored value is rewritten. This picks WHICH registrations to keep;
// the registration documents, and the exact `attendee.email` string that gets mailed, are
// untouched.

import { normalizeEmail } from '@/lib/crm/identity'
import { normalizePhoneNumber } from '@/lib/communication/phone'

/** The audience row shape both resolvers already use. Structural, so neither caller casts. */
export interface DedupableRecipient {
  id: string
  data: { attendee: { email?: string | null } }
}

/**
 * One recipient per normalized, NON-EMPTY email address; first occurrence wins.
 *
 * ═══ BLANK EMAILS ARE NEVER COLLAPSED ════════════════════════════════════════
 * A missing or whitespace-only address normalises to '', and '' is not an identity — every
 * blank-email registration would otherwise merge into a single recipient and silently drop
 * the rest of the audience. Rows without a usable address are therefore passed through
 * UNCHANGED, exactly as they are today. This function decides duplicates; it does not decide
 * eligibility, and it introduces no validation that could change who is eligible to receive.
 *
 * ═══ FIRST WINS, IN THE CALLER'S ORDER ═══════════════════════════════════════
 * The audience query carries no `orderBy`, so Firestore returns document-id order — already
 * deterministic and identical across the create-time and send-time resolutions. Keeping the
 * first occurrence preserves that order rather than imposing a new sort, and it fixes WHICH
 * registration represents the address: its name, ticketCode and registrationId are what the
 * per-recipient template variables will render. (Two people sharing one address means one of
 * them is not the one named — unavoidable when only one email may be sent.)
 */
export function dedupeRecipientsByEmail<T extends DedupableRecipient>(recipients: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []

  for (const r of recipients) {
    const key = normalizeEmail(r.data?.attendee?.email)
    if (!key) { out.push(r); continue }   // blank ⇒ never a dedupe key; pass through
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/**
 * How many DISTINCT addresses an audience would receive, for the composer's preview.
 *
 * Counted the same way `dedupeRecipientsByEmail` collapses, so the number the organizer is
 * shown and the number actually mailed cannot disagree: each blank-email row still counts as
 * its own recipient, because that is what the send will do.
 */
export function countUniqueRecipients(
  emails: (string | null | undefined)[],
): number {
  const seen = new Set<string>()
  let blanks = 0

  for (const e of emails) {
    const key = normalizeEmail(e)
    if (!key) { blanks++; continue }
    seen.add(key)
  }
  return seen.size + blanks
}

// ═══════════════════════════════════════════════════════════════════════════════
// "Ignore duplicate WhatsApp numbers" — the phone-channel counterpart.
//
// SEPARATE FROM THE EMAIL PATH ON PURPOSE. Same shape, different identity: an address is a
// string the platform lower-cases, a phone number is a value five different spellings can
// express. Sharing one generic function would mean one call site deciding which identity rule
// applies, and that is exactly the kind of switch that eventually gets the wrong argument.
// ═══════════════════════════════════════════════════════════════════════════════

/** The audience row shape the WhatsApp resolvers already use. Structural, so no caller casts. */
export interface PhoneDedupableRecipient {
  id: string
  data: { attendee: { phone?: string | null } }
}

/**
 * The canonical identity of a WhatsApp recipient.
 *
 * ═══ WHY normalizePhoneNumber AND NOTHING ELSE ═══════════════════════════════
 * `whatsappJob.ts` calls `validatePhoneNumber` — and therefore this same
 * `normalizePhoneNumber` — on every recipient immediately before handing it to Meta. Keying
 * on it means the dedupe key IS the address Meta is dialled with:
 *
 *   • two rows that collapse here would provably have produced the SAME Meta recipient;
 *   • two rows that do not collapse would provably have produced DIFFERENT ones.
 *
 * So this can never merge two people who would otherwise have received separate messages, and
 * never splits one person into two. Any other rule — raw string, last-10-digits, a regex —
 * would be a second definition of "who this is" that could disagree with the send path.
 * The helper is idempotent, so a stored value that is already canonical keys to itself.
 */
function phoneKey(raw: string | null | undefined): string {
  return typeof raw === 'string' ? normalizePhoneNumber(raw) : ''
}

/**
 * One recipient per canonical WhatsApp number; FIRST occurrence wins.
 *
 * ═══ BLANK AND MALFORMED NUMBERS ARE NEVER COLLAPSED ═════════════════════════
 * `normalizePhoneNumber` returns '' for anything with no digits at all — '', '   ', 'abc',
 * '---'. Those are NOT one recipient who appears four times; they are four different rows
 * that happen to be equally unusable. Keying on '' would silently drop three real attendees
 * and the organizer would never see it happen. So an empty key is not an identity: the row
 * passes through UNCHANGED, exactly as it does today, and the send path decides its fate —
 * `whatsappJob` already logs an invalid number as failed, charges 0, and never sends it.
 *
 * This function decides duplicates. It does not decide eligibility, and it introduces no
 * validation that could change who is eligible to receive.
 *
 * ═══ FIRST WINS, IN THE CALLER'S ORDER ═══════════════════════════════════════
 * The audience query carries no `orderBy`, so Firestore returns document-id order — already
 * deterministic and identical between the create-time and send-time resolutions. Keeping the
 * first occurrence preserves that order rather than imposing a new one, and it fixes WHICH
 * registration represents the number: the whole row survives, so the snapshot's
 * registrationId, name, ticketCode and every template variable come from that one
 * registration. (Two people sharing a phone means one of them is not the one named —
 * unavoidable when only one message may be sent.)
 *
 * Nothing is mutated: no sort in place, no stored value rewritten.
 */
export function dedupeRecipientsByPhone<T extends PhoneDedupableRecipient>(recipients: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []

  for (const r of recipients) {
    const key = phoneKey(r.data?.attendee?.phone)
    if (!key) { out.push(r); continue }   // blank/malformed ⇒ never a dedupe key; pass through
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/**
 * How many DISTINCT WhatsApp recipients an audience would reach, for the composer's preview.
 *
 * Counted the same way `dedupeRecipientsByPhone` collapses — including counting each
 * blank/malformed row as its own recipient — so the number the organizer is shown, the
 * number WhatsApp billing charges for, and the number of rows written into the send snapshot
 * cannot disagree.
 */
export function countUniquePhones(
  phones: (string | null | undefined)[],
): number {
  const seen = new Set<string>()
  let unkeyed = 0

  for (const p of phones) {
    const key = phoneKey(p)
    if (!key) { unkeyed++; continue }
    seen.add(key)
  }
  return seen.size + unkeyed
}
