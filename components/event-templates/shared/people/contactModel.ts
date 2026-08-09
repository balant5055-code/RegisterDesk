// contactModel — the ONE canonical answer to "where does Contact Organizer go?".
//
// RD-ST15.0 QA finding. The event page rendered three "Contact Organizer" actions from
// TWO different Firestore fields: OrganizerShowcase resolved `organizer.email`, while
// the FAQ and Policies sections resolved the top-level `supportEmail`. One label, one
// page, two possible destinations — and the same mailto expression was duplicated
// verbatim at two call sites.
//
// Precedence: supportEmail → organizer.email → organizer.phone. `supportEmail` wins
// because it is the field the organizer sets specifically for attendee support, whereas
// `organizer.email` is the profile's general address.
//
// Directive-free on purpose: Server Components must be able to call this.

export interface OrganizerContactSources {
  /** Top-level attendee-support address for the event. */
  supportEmail?:   string
  /** The organizer profile's general address. */
  organizerEmail?: string
  /** The organizer profile's phone number. */
  organizerPhone?: string
}

export interface OrganizerContact {
  /** '' when the organizer configured no contact method at all. */
  href:  string
  label: string
}

/**
 * Resolves the single contact target for an event. Returns an empty href when no
 * method exists, so callers can hide the action rather than render a dead link.
 */
export function resolveOrganizerContact(sources: OrganizerContactSources): OrganizerContact {
  const support = sources.supportEmail?.trim()
  const email   = sources.organizerEmail?.trim()
  const phone   = sources.organizerPhone?.trim()

  if (support) return { href: `mailto:${support}`, label: 'Contact Organizer' }
  if (email)   return { href: `mailto:${email}`,   label: 'Contact Organizer' }
  if (phone)   return { href: `tel:${phone}`,      label: 'Call Organizer' }
  return { href: '', label: 'Contact Organizer' }
}
