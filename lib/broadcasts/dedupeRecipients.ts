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
