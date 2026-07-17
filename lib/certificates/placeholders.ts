// Certificate placeholder registry + variable substitution.
// Safe to import from both client and server — no SDK dependencies.
//
// Placeholders are the dynamic tokens an organizer can drop into certificate
// text (and, later, the drag-and-drop builder in Phase 10). Every supported
// token is declared once here so the UI, the renderer, and validation all read
// from a single source of truth — no hardcoded token lists elsewhere.

/** Canonical key for every supported placeholder. */
export type PlaceholderKey =
  | 'participantName'
  | 'eventName'
  | 'eventDate'
  | 'eventLocation'
  | 'registrationId'
  | 'ticketCode'
  | 'certificateId'
  | 'issueDate'
  | 'organizerName'
  | 'bibNumber'
  | 'distance'
  | 'finishTime'
  | 'position'
  | 'category'

/** Grouping used to organise placeholders in the builder UI. */
export type PlaceholderCategory = 'identity' | 'event' | 'certificate' | 'sports'

export interface PlaceholderDef {
  key:         PlaceholderKey
  token:       string              // e.g. "{{participantName}}"
  label:       string              // human label for the picker
  description: string
  category:    PlaceholderCategory
  /** Whether the token is only meaningful for sports / timed events. */
  sportsOnly:  boolean
  example:     string
}

/** The complete, ordered placeholder registry. */
export const PLACEHOLDERS: readonly PlaceholderDef[] = [
  // ── Identity ──────────────────────────────────────────────────────────────
  { key: 'participantName', token: '{{participantName}}', label: 'Participant Name',
    description: "The attendee's full name.", category: 'identity', sportsOnly: false,
    example: 'Priya Sharma' },
  { key: 'registrationId', token: '{{registrationId}}', label: 'Registration ID',
    description: 'Internal registration identifier.', category: 'identity', sportsOnly: false,
    example: 'REG-2026-001234' },
  { key: 'ticketCode', token: '{{ticketCode}}', label: 'Ticket Code',
    description: 'The attendee ticket / pass code.', category: 'identity', sportsOnly: false,
    example: 'TKT-9F3A2B' },

  // ── Event ─────────────────────────────────────────────────────────────────
  { key: 'eventName', token: '{{eventName}}', label: 'Event Name',
    description: 'The name of the event.', category: 'event', sportsOnly: false,
    example: 'Tech Marathon 2026' },
  { key: 'eventDate', token: '{{eventDate}}', label: 'Event Date',
    description: 'The date the event was held.', category: 'event', sportsOnly: false,
    example: '15 June 2026' },
  { key: 'eventLocation', token: '{{eventLocation}}', label: 'Event Location',
    description: 'Venue or city of the event.', category: 'event', sportsOnly: false,
    example: 'Chennai, India' },
  { key: 'organizerName', token: '{{organizerName}}', label: 'Organizer Name',
    description: 'The organising body / brand.', category: 'event', sportsOnly: false,
    example: 'Rotary Club of Chennai' },

  // ── Certificate ─────────────────────────────────────────────────────────────
  { key: 'certificateId', token: '{{certificateId}}', label: 'Certificate ID',
    description: 'The unique, verifiable certificate identifier.', category: 'certificate', sportsOnly: false,
    example: 'RDC-2026-AB12CD' },
  { key: 'issueDate', token: '{{issueDate}}', label: 'Issue Date',
    description: 'The date the certificate was issued.', category: 'certificate', sportsOnly: false,
    example: '19 June 2026' },

  // ── Sports / timed events ───────────────────────────────────────────────────
  { key: 'bibNumber', token: '{{bibNumber}}', label: 'Bib Number',
    description: 'Race bib number.', category: 'sports', sportsOnly: true,
    example: '4521' },
  { key: 'distance', token: '{{distance}}', label: 'Distance',
    description: 'Distance category completed.', category: 'sports', sportsOnly: true,
    example: '21.1 km' },
  { key: 'finishTime', token: '{{finishTime}}', label: 'Finish Time',
    description: 'Recorded finish / chip time.', category: 'sports', sportsOnly: true,
    example: '01:48:32' },
  { key: 'position', token: '{{position}}', label: 'Position',
    description: 'Finishing position / rank.', category: 'sports', sportsOnly: true,
    example: '3rd' },
  { key: 'category', token: '{{category}}', label: 'Category',
    description: 'Competition category / age group.', category: 'sports', sportsOnly: true,
    example: 'Men 30-39' },
] as const

/** O(1) lookup by key. */
export const PLACEHOLDER_BY_KEY: Readonly<Record<PlaceholderKey, PlaceholderDef>> =
  Object.fromEntries(PLACEHOLDERS.map(p => [p.key, p])) as Record<PlaceholderKey, PlaceholderDef>

/** The set of every recognised key (used for fast membership checks). */
const KNOWN_KEYS = new Set<string>(PLACEHOLDERS.map(p => p.key))

/**
 * Values supplied at render time. A value may be absent (the placeholder
 * resolves to an empty string), null/undefined (also empty), or a string/number.
 */
export type PlaceholderContext = Partial<Record<PlaceholderKey, string | number | null | undefined>>

// Matches {{ key }} with optional surrounding whitespace; key is alphanumeric.
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9]+)\s*\}\}/g

/**
 * Replaces every recognised `{{placeholder}}` token in `template` with the
 * matching value from `context`.
 *
 *  - A recognised token with no value (missing/null/undefined) → empty string.
 *  - An *unrecognised* token (not in the registry) is left untouched, so
 *    incidental `{{...}}` text in user content is never silently eaten.
 */
export function replaceVariables(template: string, context: PlaceholderContext): string {
  if (!template) return ''
  return template.replace(TOKEN_RE, (match, rawKey: string) => {
    if (!KNOWN_KEYS.has(rawKey)) return match
    const value = context[rawKey as PlaceholderKey]
    return value === null || value === undefined ? '' : String(value)
  })
}

/**
 * Returns the recognised placeholder keys actually used in a template string,
 * in first-seen order, de-duplicated. Useful for validation and previews.
 */
export function extractPlaceholders(template: string): PlaceholderKey[] {
  if (!template) return []
  const seen = new Set<PlaceholderKey>()
  for (const m of template.matchAll(TOKEN_RE)) {
    const key = m[1]
    if (KNOWN_KEYS.has(key)) seen.add(key as PlaceholderKey)
  }
  return [...seen]
}
