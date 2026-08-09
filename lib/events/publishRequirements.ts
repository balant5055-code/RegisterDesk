// Shared publish requirements — the SINGLE source of truth for the mandatory
// fields an event must have before it can be submitted / published.
//
// Consumed by BOTH:
//   • the client Review & Submit page  (drives the "Action Required" list and
//     gates the "Continue to Payment" button), and
//   • the server /api/events/publish route (via validateEventPublish).
//
// Because both sides evaluate the SAME function against the SAME raw draft
// fields, the client can never let the organizer reach Razorpay while a
// mandatory field is still missing, and it can never fail server-side for a
// field the client reported as complete.
//
// PURE + isomorphic: no Firestore, no Firebase, no client-only or server-only
// imports. Reads defensively from raw draft data (optional chaining) so partial
// documents never throw.

/**
 * RD-EVENT-20 — how a finding affects publishing.
 *
 * `critical` is the ONLY tier that blocks. Every requirement that exists today is critical,
 * and the default below keeps it that way, so adding this taxonomy does not move a single
 * event's publishability. Reclassifying an existing requirement is a product decision, not a
 * refactor, and is deliberately NOT taken here.
 */
export type PublishSeverity = 'critical' | 'warning' | 'suggestion'

/**
 * The organizer-facing area a finding belongs to.
 *
 * Distinct from `stepName`: a step is where you go to FIX something, a section is what part
 * of the event it concerns. They coincide today but must not be conflated — Branding and
 * Media both live in the Details step, and Legal spans Details and License.
 */
export type PublishSection =
  | 'Event Information' | 'Visibility' | 'Registration' | 'Pricing'
  | 'Branding' | 'Media' | 'Location' | 'Contact' | 'Legal' | 'Publish Settings'

export interface PublishRequirement {
  /** Stable id — used as a React key and to correlate blockers. */
  id:          string
  /** Blocking tier. Omitted ⇒ `critical`, preserving today's behaviour exactly. */
  severity?:   PublishSeverity
  /** Organizer-facing area. Omitted ⇒ derived from `stepName`. */
  section?:    PublishSection
  /** Whether this mandatory requirement is currently satisfied. */
  passed:      boolean
  /** Action-Required card title. */
  title:       string
  /** One-line description of what to fix. */
  description: string
  /** Human step label ("Event Details", "Passes & Pricing", …). */
  stepName:    string
  /** Wizard step index to jump to when the organizer clicks "Fix now".
   *  Indices 3 (Passes & Pricing), 4 (Registration Form) and 5 (Event Details)
   *  are identical across the standard and event_plus_donation wizards. */
  stepIndex:   number
  /** Optional DOM id to focus inside the Event Details builder. */
  fieldHint?:  string
}

export interface PublishRequirementInput {
  pricing:          Record<string, unknown> | null | undefined
  eventDetails:     Record<string, unknown> | null | undefined
  registrationForm: Record<string, unknown> | null | undefined
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const nonEmpty = (v: unknown): boolean => str(v).trim().length > 0

/**
 * Evaluate every mandatory publish requirement against a raw draft.
 * Returns the requirements in display order, each flagged passed / failed.
 */
export function evaluatePublishRequirements(input: PublishRequirementInput): PublishRequirement[] {
  const details   = (input.eventDetails ?? null) as Record<string, unknown> | null
  const info      = (details?.info      as Record<string, unknown> | null | undefined) ?? null
  const venue     = (details?.venue     as Record<string, unknown> | null | undefined) ?? null
  const schedule  = (details?.schedule  as Record<string, unknown> | null | undefined) ?? null
  const organizer = (details?.organizer as Record<string, unknown> | null | undefined) ?? null
  const physical  = (venue?.physical    as Record<string, unknown> | null | undefined) ?? null

  const pricing   = (input.pricing ?? null) as Record<string, unknown> | null
  const passes    = Array.isArray(pricing?.passes) ? (pricing!.passes as unknown[]) : []

  const rf         = (input.registrationForm ?? null) as Record<string, unknown> | null
  const rfTemplate = str(rf?.template)
  const rfSections = Array.isArray(rf?.sections) ? (rf!.sections as unknown[]) : []

  // Physical / hybrid events must have a named venue — type alone is not enough.
  const venueType         = str(venue?.type)
  const hasVenueType      = nonEmpty(venueType)
  const needsPhysicalName = venueType === 'physical' || venueType === 'hybrid'
  const hasVenueName      = needsPhysicalName ? nonEmpty(physical?.name) : true

  return [
    {
      id: 'event_title', stepName: 'Event Details', stepIndex: 5, fieldHint: 'rd-event-name',
      severity: 'critical', section: 'Event Information',
      title: 'Event Name Missing', description: 'Add a name so attendees can find your event',
      passed: nonEmpty(info?.name),
    },
    {
      id: 'event_schedule', stepName: 'Event Details', stepIndex: 5, fieldHint: 'rd-start-date',
      severity: 'critical', section: 'Event Information',
      title: 'Dates & Times Not Set', description: 'Schedule when your event starts and ends',
      passed: nonEmpty(schedule?.startDate),
    },
    {
      id: 'event_venue', stepName: 'Event Details', stepIndex: 5, fieldHint: 'rd-venue-type',
      severity: 'critical', section: 'Location',
      title: 'Venue Not Configured', description: 'Add the event location or online platform',
      passed: hasVenueType && hasVenueName,
    },
    {
      id: 'event_organizer', stepName: 'Event Details', stepIndex: 5, fieldHint: 'rd-organizer-name',
      severity: 'critical', section: 'Contact',
      title: 'Organizer Info Missing', description: 'Add organizer name and contact email',
      passed: nonEmpty(organizer?.name) && nonEmpty(organizer?.email),
    },
    {
      id: 'pricing_model', stepName: 'Passes & Pricing', stepIndex: 3,
      severity: 'critical', section: 'Pricing',
      title: 'Pricing Model Not Set', description: 'Choose free or paid event type',
      passed: nonEmpty(pricing?.eventType),
    },
    {
      id: 'passes', stepName: 'Passes & Pricing', stepIndex: 3,
      severity: 'critical', section: 'Pricing',
      title: 'No Ticket Passes Created', description: 'Add at least one ticket or pass type',
      passed: passes.length > 0,
    },
    {
      id: 'registration_form', stepName: 'Registration Form', stepIndex: 4,
      severity: 'critical', section: 'Registration',
      title: 'Registration Form Missing', description: 'Select a template or build a custom form',
      passed: nonEmpty(rfTemplate) || rfSections.length > 0,
    },

    // ═══ WARNINGS — publishing is allowed, but the event will underperform ══════
    // Each of these is genuinely optional: an event with none of them is a valid,
    // sellable event. They are surfaced because organizers consistently regret
    // shipping without them, not because the platform requires them.
    {
      id: 'event_description', stepName: 'Event Details', stepIndex: 5, fieldHint: 'rd-event-description',
      severity: 'warning', section: 'Event Information',
      title: 'Description Is Thin',
      description: 'Add at least 120 characters so attendees know what to expect',
      passed: str(info?.description ?? details?.description).trim().length >= 120,
    },
    {
      id: 'organizer_phone', stepName: 'Event Details', stepIndex: 5, fieldHint: 'rd-organizer-name',
      severity: 'warning', section: 'Contact',
      title: 'No Contact Phone',
      description: 'Attendees with urgent questions have no way to reach you',
      passed: nonEmpty(organizer?.phone),
    },
    {
      id: 'event_cover', stepName: 'Event Details', stepIndex: 5,
      severity: 'warning', section: 'Media',
      title: 'No Cover Image',
      description: 'Events with a cover image are significantly more likely to convert',
      passed: nonEmpty(info?.coverImage ?? details?.coverImage) || nonEmpty(info?.bannerUrl ?? details?.bannerUrl),
    },

    // ═══ SUGGESTIONS — pure polish ═════════════════════════════════════════════
    {
      id: 'event_branding', stepName: 'Event Details', stepIndex: 5,
      severity: 'suggestion', section: 'Branding',
      title: 'No Organizer Logo',
      description: 'Add a logo so your event page and emails carry your brand',
      passed: nonEmpty(info?.logoUrl ?? details?.logoUrl),
    },
    {
      id: 'event_social', stepName: 'Event Details', stepIndex: 5,
      severity: 'suggestion', section: 'Contact',
      title: 'No Social Links',
      description: 'Link your social profiles to help attendees share the event',
      passed: Array.isArray(info?.socialLinks ?? details?.socialLinks) && ((info?.socialLinks ?? details?.socialLinks) as unknown[]).length > 0,
    },
  ]
}

/** True when at least one mandatory requirement is unmet. */
export function hasIncompletePublishRequirements(input: PublishRequirementInput): boolean {
  return evaluatePublishRequirements(input).some(r => !r.passed)
}

// ─── Structured validation summary (Phase 1) ──────────────────────────────────
// The ONE object both the Review page and /api/events/publish build from, so
// canPublish can never diverge between client and server.

export interface PublishBlocker {
  id:          string
  title:       string
  description: string
  step:        string
  /**
   * RD-EVENT-25 — navigation + classification metadata.
   *
   * Carried so the Findings UI can render and navigate without re-deriving anything.
   * `toPublishBlocker` previously dropped these, which left a findings card unable to offer
   * "Fix now" without building a second step mapping in the component — the exact
   * duplication the shared engine exists to prevent.
   *
   * Additive only: no existing consumer reads them, and no logic changed.
   */
  severity:    PublishSeverity
  section:     PublishSection
  stepIndex:   number
  fieldHint?:  string
}

/** RD-EVENT-20 — per-section rollup for the readiness dashboard. */
export interface PublishSectionHealth {
  section:   PublishSection
  total:     number
  passed:    number
  /** 0–100. A section with no requirements is 100 — nothing is outstanding. */
  score:     number
  /** Worst unmet severity in this section, or null when the section is clean. */
  status:    PublishSeverity | 'complete'
  /** Where "Fix now" should navigate for this section's first unmet requirement. */
  stepIndex: number | null
  stepName:  string | null
}

export interface PublishValidationSummary {
  canPublish:        boolean
  blockers:          PublishBlocker[]
  warnings:          PublishBlocker[]
  /** RD-EVENT-20 — non-blocking, non-urgent improvements. Never mixed with the above. */
  suggestions:       PublishBlocker[]
  score:             number   // 0–100 (share of mandatory requirements met)
  completedSections: number
  /** Full requirement list (passed + failed) — for the Action Required UI. */
  requirements:      PublishRequirement[]
  /** RD-EVENT-20 — health per organizer-facing section. */
  sections:          PublishSectionHealth[]
}

/** Severity of a requirement, defaulting to the pre-RD-EVENT-20 behaviour. */
export function severityOf(r: PublishRequirement): PublishSeverity {
  return r.severity ?? 'critical'
}

/**
 * Section of a requirement.
 *
 * Falls back to a mapping from `stepName` so existing requirements need no edit — and so a
 * new requirement that forgets `section` lands somewhere sensible rather than nowhere.
 */
export function sectionOf(r: PublishRequirement): PublishSection {
  if (r.section) return r.section
  switch (r.stepName) {
    case 'Passes & Pricing':    return 'Pricing'
    case 'Registration Form':   return 'Registration'
    case 'Visibility':          return 'Visibility'
    case 'License':             return 'Legal'
    default:                    return 'Event Information'
  }
}

/** Every section the readiness dashboard displays, in presentation order. */
export const PUBLISH_SECTIONS: readonly PublishSection[] = [
  'Event Information', 'Visibility', 'Registration', 'Pricing',
  'Branding', 'Media', 'Location', 'Contact', 'Legal', 'Publish Settings',
]

/** Rolls requirements up per section. Sections with no requirements report complete. */
export function buildSectionHealth(requirements: PublishRequirement[]): PublishSectionHealth[] {
  return PUBLISH_SECTIONS.map(section => {
    const mine   = requirements.filter(r => sectionOf(r) === section)
    const failed = mine.filter(r => !r.passed)
    const worst  = failed.length
      ? (['critical', 'warning', 'suggestion'] as const).find(s => failed.some(r => severityOf(r) === s))
      : undefined
    const first  = failed[0] ?? null
    return {
      section,
      total:     mine.length,
      passed:    mine.length - failed.length,
      score:     mine.length ? Math.round(((mine.length - failed.length) / mine.length) * 100) : 100,
      status:    worst ?? 'complete',
      stepIndex: first ? first.stepIndex : null,
      stepName:  first ? first.stepName  : null,
    }
  })
}

/** Serialize a requirement into the wire/UI blocker shape. */
export function toPublishBlocker(r: PublishRequirement): PublishBlocker {
  return {
    id: r.id, title: r.title, description: r.description, step: r.stepName,
    severity: severityOf(r), section: sectionOf(r), stepIndex: r.stepIndex, fieldHint: r.fieldHint,
  }
}

/**
 * The single validation engine. Returns the structured summary consumed by both
 * the Review & Submit page and the publish API.
 */
export function validatePublish(input: PublishRequirementInput): PublishValidationSummary {
  const requirements      = evaluatePublishRequirements(input)
  const failed            = requirements.filter(r => !r.passed)
  const completedSections = requirements.length - failed.length
  const score             = requirements.length
    ? Math.round((completedSections / requirements.length) * 100)
    : 100

  // RD-EVENT-20 — the three tiers are now derived, never mixed, and never hardcoded.
  //
  // `canPublish` depends on CRITICAL findings only. Because every requirement today defaults
  // to critical, `blockers` is still the full failed set and this is byte-identical to the
  // previous `failed.length === 0`. The taxonomy becomes meaningful the moment a requirement
  // declares `severity: 'warning'` — which is a product decision, not made here.
  const bySeverity = (s: PublishSeverity) => failed.filter(r => severityOf(r) === s).map(toPublishBlocker)
  const criticals  = bySeverity('critical')

  return {
    canPublish:        criticals.length === 0,
    blockers:          criticals,
    warnings:          bySeverity('warning'),
    suggestions:       bySeverity('suggestion'),
    score,
    completedSections,
    requirements,
    sections:          buildSectionHealth(requirements),
  }
}
