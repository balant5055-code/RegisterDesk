// RD-DASHBOARD-08 · Event type / subtype DISPLAY NAMES — the shared, pure half.
//
// ═══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════
// The Create Event wizard stores `eventType` and `eventSubtype` as ids (`'sports'`,
// `'running'`). The names an organizer actually chose from — "Sports & Fitness",
// "Running" — lived only inside `components/event-builder/steps/Step1View.tsx`, a heavy
// client component that pulls in framer-motion, a dozen Lucide icons and the whole
// wizard footer.
//
// The Dashboard header has to name the selected event's category, and it must be the
// SAME name the organizer picked. Two ways to get that wrong:
//
//   • Import Step1View → drags the wizard into the dashboard bundle.
//   • Retype the labels in the header → a second catalog, guaranteed to drift the first
//     time a subtype is renamed. That is the duplication this codebase keeps paying for.
//
// So the label maps live here — pure data, no React, no icons — and Step1View derives its
// option names from this module. One catalog, two consumers.
//
// ═══ WHAT IS NOT HERE ════════════════════════════════════════════════════════
// Icons, colours, descriptions, hints and the picker's ordering stay in Step1View: they
// are Step-1 presentation, not identity. Only the id → name mapping is shared, because
// only that is needed to describe an event that already exists.

/** Event type id → the name shown in the wizard's type picker. */
export const EVENT_TYPE_NAMES: Readonly<Record<string, string>> = {
  conference:  'Conference',
  exhibition:  'Exhibition & Expo',
  sports:      'Sports & Fitness',
  workshop:    'Workshop & Training',
  meetup:      'Business Meetup',
  community:   'Community & Awareness',
  cultural:    'Cultural & Entertainment',
  awards:      'Awards & Recognition',
  fundraising: 'Fundraising & Charity',
  custom:      'Custom Event',
}

/**
 * `eventType` → (`eventSubtype` → display name).
 *
 * Nested rather than flat because subtype ids are NOT globally unique — `other` exists
 * under every type, `summit` under both conference and awards, `corporate` under both
 * conference and meetup. A flat map would silently label an Awards Summit "Summit
 * (Conference)".
 */
export const EVENT_SUBTYPE_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  conference: {
    business: 'Business', corporate: 'Corporate', rotary: 'Rotary', summit: 'Summit',
    academic: 'Academic', medical: 'Medical', tech: 'Tech', other: 'Other',
  },
  exhibition: {
    trade_show: 'Trade Show', fair: 'Fair', product: 'Product Showcase', auto: 'Auto Expo',
    education: 'Education Expo', property: 'Property Expo', other: 'Other',
  },
  sports: {
    running: 'Running', cycling: 'Cycling', cricket: 'Cricket', football: 'Football',
    hockey: 'Hockey', tennis: 'Tennis', badminton: 'Badminton', swimming: 'Swimming',
    basketball: 'Basketball', volleyball: 'Volleyball', triathlon: 'Triathlon', other: 'Other',
  },
  workshop: {
    workshop: 'Workshop', bootcamp: 'Bootcamp', certification: 'Certification Course',
    masterclass: 'Masterclass', seminar: 'Seminar', live_training: 'Live Training', other: 'Other',
  },
  meetup: {
    networking: 'Networking', startup: 'Startup Meetup', investor: 'Investor Meetup',
    founder: 'Founder Circle', corporate: 'Corporate Meetup', alumni: 'Alumni Meetup', other: 'Other',
  },
  community: {
    awareness: 'Awareness', ngo: 'NGO Event', volunteer: 'Volunteer Program',
    donation: 'Donation Drive', cleanup: 'Clean-up Drive', social: 'Social Impact', other: 'Other',
  },
  cultural: {
    concert: 'Concert', festival: 'Festival', dance: 'Dance Show', drama: 'Drama',
    dj_night: 'DJ Night', talent: 'Talent Show', cultural: 'Cultural Program', other: 'Other',
  },
  awards: {
    awards_night: 'Awards Night', recognition: 'Recognition Ceremony', graduation: 'Graduation',
    felicitation: 'Felicitation', excellence: 'Excellence Awards', summit: 'Summit Awards', other: 'Other',
  },
  fundraising: {
    charity_run: 'Charity Run', donation_drive: 'Donation Drive', benefit_dinner: 'Benefit Dinner',
    gala: 'Gala Night', campaign: 'Campaign Event', fundraiser: 'Fundraiser', other: 'Other',
  },
}

/**
 * Display name for a stored event type id.
 *
 * Returns null for an absent or unrecognised id rather than a guess. A "Custom Event"
 * fallback would put a category on an event that has none, and title-casing the raw id
 * would invent a name the organizer never chose.
 */
export function eventTypeLabel(typeId: string | null | undefined): string | null {
  if (!typeId) return null
  return EVENT_TYPE_NAMES[typeId] ?? null
}

/**
 * Display name for a stored subtype id, resolved WITHIN its event type.
 *
 * `custom` is the organizer's own free-text subtype (stored as `customEventSubtype` when
 * they pick "Other"); it is returned verbatim because it is real configured data.
 *
 * Returns null when there is no subtype, when the type is unknown, or when the id is not
 * in that type's list. An event with no subtype simply HAS no subtype — inventing one is
 * the exact failure this module exists to prevent.
 */
export function eventSubtypeLabel(
  typeId: string | null | undefined,
  subtypeId: string | null | undefined,
  custom?: string | null,
): string | null {
  const trimmedCustom = typeof custom === 'string' ? custom.trim() : ''
  // A free-text subtype outranks the catalog: the organizer typed it precisely because
  // no option fitted, so "Other" would be a worse answer than their own words.
  if (subtypeId === 'other' && trimmedCustom) return trimmedCustom
  if (!typeId || !subtypeId) return trimmedCustom || null
  return EVENT_SUBTYPE_NAMES[typeId]?.[subtypeId] ?? (trimmedCustom || null)
}

/**
 * The header's category line, e.g. "Sports & Fitness → Running".
 *
 * Returns just the type when there is no subtype, and null when there is no type at all —
 * so the caller renders nothing rather than a stray arrow or an empty row.
 */
export function eventTaxonomyLine(
  typeId: string | null | undefined,
  subtypeId: string | null | undefined,
  custom?: string | null,
): string | null {
  const type = eventTypeLabel(typeId)
  const sub  = eventSubtypeLabel(typeId, subtypeId, custom)
  if (!type) return sub                       // unknown type but a real custom subtype
  return sub ? `${type} → ${sub}` : type
}
