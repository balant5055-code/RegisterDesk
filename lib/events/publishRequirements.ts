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

export interface PublishRequirement {
  /** Stable id — used as a React key and to correlate blockers. */
  id:          string
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
      title: 'Event Name Missing', description: 'Add a name so attendees can find your event',
      passed: nonEmpty(info?.name),
    },
    {
      id: 'event_schedule', stepName: 'Event Details', stepIndex: 5, fieldHint: 'rd-start-date',
      title: 'Dates & Times Not Set', description: 'Schedule when your event starts and ends',
      passed: nonEmpty(schedule?.startDate),
    },
    {
      id: 'event_venue', stepName: 'Event Details', stepIndex: 5, fieldHint: 'rd-venue-type',
      title: 'Venue Not Configured', description: 'Add the event location or online platform',
      passed: hasVenueType && hasVenueName,
    },
    {
      id: 'event_organizer', stepName: 'Event Details', stepIndex: 5, fieldHint: 'rd-organizer-name',
      title: 'Organizer Info Missing', description: 'Add organizer name and contact email',
      passed: nonEmpty(organizer?.name) && nonEmpty(organizer?.email),
    },
    {
      id: 'pricing_model', stepName: 'Passes & Pricing', stepIndex: 3,
      title: 'Pricing Model Not Set', description: 'Choose free or paid event type',
      passed: nonEmpty(pricing?.eventType),
    },
    {
      id: 'passes', stepName: 'Passes & Pricing', stepIndex: 3,
      title: 'No Ticket Passes Created', description: 'Add at least one ticket or pass type',
      passed: passes.length > 0,
    },
    {
      id: 'registration_form', stepName: 'Registration Form', stepIndex: 4,
      title: 'Registration Form Missing', description: 'Select a template or build a custom form',
      passed: nonEmpty(rfTemplate) || rfSections.length > 0,
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
}

export interface PublishValidationSummary {
  canPublish:        boolean
  blockers:          PublishBlocker[]
  warnings:          PublishBlocker[]
  score:             number   // 0–100 (share of mandatory requirements met)
  completedSections: number
  /** Full requirement list (passed + failed) — for the Action Required UI. */
  requirements:      PublishRequirement[]
}

/** Serialize a requirement into the wire/UI blocker shape. */
export function toPublishBlocker(r: PublishRequirement): PublishBlocker {
  return { id: r.id, title: r.title, description: r.description, step: r.stepName }
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

  return {
    canPublish:        failed.length === 0,
    blockers:          failed.map(toPublishBlocker),
    warnings:          [],   // all current requirements are mandatory (no soft warnings)
    score,
    completedSections,
    requirements,
  }
}
