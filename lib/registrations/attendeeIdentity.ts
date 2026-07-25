// RD-ATTENDEE-03A C1 — the ONE canonical attendee-identity resolver.
//
// An attendee's identity (name / email / phone) is never stored as a discrete field —
// it is derived from the free-form registration responses. This is the SINGLE place
// that derivation happens, shared by the client (RegisterClient, to build the request
// + Razorpay prefill) and the server (create-order + submit, authoritative for the
// stored registration / ticket). No schema change: identity is inferred from field
// `type` + `label`, exactly as before, but with the fragile inline heuristic replaced
// by one hardened, deterministic, unit-tested function so registration, checkout,
// payment, confirmation and ticket generation all agree.
//
// Pure + dependency-free (only a type import) so it is safe on both client and server.

import type { FieldType } from '@/components/wizard/registrationFormConfig'

export interface IdentityField {
  id:    string
  type:  FieldType
  label: string
}

export interface AttendeeIdentity {
  name:   string
  email:  string
  phone?: string
}

// A field labelled with "name" that is NOT the attendee's own name (company/team/etc).
// Keeping this list explicit is what makes the previous `/name/i` heuristic safe: a
// "Company Name" or "Emergency Contact Name" field can no longer become the ticket name.
const NON_ATTENDEE_NAME =
  /(company|organi[sz]ation|organisation|team|group|college|institut|university|school|startup|campaign|performer|booth|publication|club|district|cause|channel|business|brand|project|product|event|parent|guardian|emergency|next\s*of\s*kin|referr?er|sponsor|vendor|partner)/i

const ATTENDEE_NAME = /\bname\b/i

/**
 * Derive the canonical attendee identity from the submitted form values.
 *
 * name  — the first non-empty `text` field whose label reads like a person's name
 *         (contains "name" but not an org/team/emergency qualifier); then the first
 *         non-empty text field that isn't an org-type name; then, as a last resort,
 *         the first text field at all (preserving the prior fallback so a derived
 *         name is never *worse* than before).
 * email — the first non-empty `email` field, in field order.
 * phone — the first non-empty `mobile` field, in field order.
 *
 * Deterministic and order-stable, so client and server always produce the same result.
 */
export function resolveAttendeeIdentity(
  fields: IdentityField[],
  values: Record<string, string>,
): AttendeeIdentity {
  let name = ''
  let email = ''
  let phone = ''

  // Pass 1 — strong signals: email/mobile by type, name by curated label.
  for (const field of fields) {
    const val = (values[field.id] ?? '').trim()
    if (!val) continue
    if (!email && field.type === 'email') email = val
    if (!phone && field.type === 'mobile') phone = val
    if (!name && field.type === 'text' && ATTENDEE_NAME.test(field.label) && !NON_ATTENDEE_NAME.test(field.label)) {
      name = val
    }
  }

  // Pass 2 — first non-empty text field that is not an org/team-type name.
  if (!name) {
    for (const field of fields) {
      if (field.type !== 'text' || NON_ATTENDEE_NAME.test(field.label)) continue
      const val = (values[field.id] ?? '').trim()
      if (val) { name = val; break }
    }
  }

  // Pass 3 — last-resort fallback to the first text field (matches the prior behaviour
  // so the derived name is never empty where the old heuristic would have found one).
  if (!name) {
    const first = fields.find(f => f.type === 'text')
    if (first) name = (values[first.id] ?? '').trim()
  }

  return { name, email, ...(phone ? { phone } : {}) }
}
