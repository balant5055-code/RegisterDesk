// PA-3 — Print variable resolver. Pure (client + server safe).
//
// The renderer NEVER queries Firestore. A caller resolves the raw values from
// their sources (Registration, Event, Organizer, Pass, Sponsor, System, Custom
// Fields) and hands them here as plain primitives; this module flattens them
// into a token map and substitutes `{{token}}` placeholders in element text.

export type VariableSource =
  | 'registration' | 'event' | 'organizer' | 'pass' | 'sponsor' | 'system' | 'custom'

/** A resolved scalar. null/undefined → the token renders as an empty string. */
export type VarValue = string | number | null | undefined

/**
 * Already-resolved values, grouped by source. Every field is optional; a missing
 * field makes its token resolve to empty. `custom` backs the `{{custom.xxx}}`
 * namespace.
 */
export interface PrintVariableSources {
  registration?: {
    name?: VarValue; email?: VarValue; phone?: VarValue
    ticket?: VarValue; id?: VarValue; company?: VarValue
    designation?: VarValue; category?: VarValue; bibNumber?: VarValue
  }
  event?:     { name?: VarValue; date?: VarValue; location?: VarValue }
  organizer?: { name?: VarValue }
  pass?:      { label?: VarValue; type?: VarValue }
  sponsor?:   { name?: VarValue; logo?: VarValue }
  system?:    { qr?: VarValue }
  // White-label branding (PA-5) — resolved via resolvePublicBranding(); `logo` is
  // an image URL usable as an image element source, colors/company as text tokens.
  branding?:  { logo?: VarValue; primaryColor?: VarValue; secondaryColor?: VarValue; company?: VarValue }
  custom?:    Record<string, VarValue>
}

export interface PrintVariableDef {
  token:       string
  source:      VariableSource
  label:       string
  description: string
  example:     string
}

/** The supported flat placeholders (the `{{custom.xxx}}` namespace is dynamic). */
export const PRINT_VARIABLES: readonly PrintVariableDef[] = [
  { token: 'name',         source: 'registration', label: 'Name',         description: "Attendee's full name.",     example: 'Priya Sharma' },
  { token: 'email',        source: 'registration', label: 'Email',        description: 'Attendee email.',            example: 'priya@example.com' },
  { token: 'phone',        source: 'registration', label: 'Phone',        description: 'Attendee phone.',            example: '+91 98765 43210' },
  { token: 'ticket',       source: 'registration', label: 'Ticket',       description: 'Ticket / pass code.',        example: 'TKT-9F3A2B' },
  { token: 'registration', source: 'registration', label: 'Registration', description: 'Registration ID.',           example: 'REG-2026-001234' },
  { token: 'company',      source: 'registration', label: 'Company',      description: 'Company / organisation.',    example: 'Acme Corp' },
  { token: 'designation',  source: 'registration', label: 'Designation',  description: 'Job title / role.',          example: 'Head of Product' },
  { token: 'category',     source: 'registration', label: 'Category',     description: 'Registration category.',     example: 'Delegate' },
  { token: 'bibNumber',    source: 'registration', label: 'Bib Number',   description: 'Assigned race bib number.',   example: '1024' },
  { token: 'event',        source: 'event',        label: 'Event',        description: 'Event name.',                example: 'Tech Summit 2026' },
  { token: 'eventDate',    source: 'event',        label: 'Event Date',   description: 'Event date.',                example: '15 June 2026' },
  { token: 'eventLocation',source: 'event',        label: 'Event Location',description: 'Event venue / city.',        example: 'Chennai, India' },
  { token: 'pass',         source: 'pass',         label: 'Pass',         description: 'Pass label / tier.',         example: 'VIP' },
  { token: 'qr',           source: 'system',       label: 'QR value',     description: 'Encoded QR payload (text).', example: 'https://rd.co/v/abc' },
] as const

const CUSTOM_PREFIX = 'custom.'

function str(v: VarValue): string {
  return v === null || v === undefined ? '' : String(v)
}

/**
 * Flattens the grouped sources into a `{ token → resolved string }` map, matching
 * the tokens declared in PRINT_VARIABLES plus the dynamic `custom.*` namespace.
 */
export function buildVariableMap(sources: PrintVariableSources): Map<string, string> {
  const r = sources.registration ?? {}
  const map = new Map<string, string>([
    ['name',         str(r.name)],
    ['email',        str(r.email)],
    ['phone',        str(r.phone)],
    ['ticket',       str(r.ticket)],
    ['registration', str(r.id)],
    ['company',      str(r.company)],
    ['designation',  str(r.designation)],
    ['category',     str(r.category)],
    ['bibNumber',    str(r.bibNumber)],
    ['event',        str(sources.event?.name)],
    ['eventDate',    str(sources.event?.date)],
    ['eventLocation',str(sources.event?.location)],
    ['pass',         str(sources.pass?.label ?? sources.pass?.type)],
    ['sponsor',      str(sources.sponsor?.name)],
    ['qr',           str(sources.system?.qr)],
    // Organizer / white-label branding (PA-5).
    ['organizer',    str(sources.branding?.company ?? sources.organizer?.name)],
    ['logo',         str(sources.branding?.logo)],          // image URL
    ['sponsorLogo',  str(sources.sponsor?.logo)],           // image URL
    ['brandColor',   str(sources.branding?.primaryColor)],
    ['brandColor2',  str(sources.branding?.secondaryColor)],
  ])
  for (const [k, v] of Object.entries(sources.custom ?? {})) {
    map.set(`${CUSTOM_PREFIX}${k}`, str(v))
  }
  return map
}

// {{ token }} / {{ custom.field_id }} — token is alnum, dot, dash, underscore.
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g

/**
 * Replaces every recognised `{{token}}` in `template` with its resolved value.
 * A recognised token with no value → empty string. An *unrecognised* token is
 * left untouched, so incidental `{{…}}` text is never silently eaten.
 */
export function resolvePrintText(template: string, map: Map<string, string>): string {
  if (!template) return ''
  return template.replace(TOKEN_RE, (match, rawKey: string) =>
    map.has(rawKey) ? map.get(rawKey)! : match,
  )
}

/** Convenience: build the map and resolve in one call. */
export function resolveWithSources(template: string, sources: PrintVariableSources): string {
  return resolvePrintText(template, buildVariableMap(sources))
}

/** Sample values (used by previews when no real registration is supplied). */
export function sampleVariableSources(): PrintVariableSources {
  const reg: Record<string, string> = {}
  for (const v of PRINT_VARIABLES) if (v.source === 'registration') reg[v.token === 'registration' ? 'id' : v.token] = v.example
  return {
    registration: reg,
    event:     { name: 'Tech Summit 2026', date: '15 June 2026', location: 'Chennai, India' },
    organizer: { name: 'RegisterDesk' },
    pass:      { label: 'VIP', type: 'vip' },
    sponsor:   { name: 'Acme Corp' },
    system:    { qr: 'https://rd.co/v/sample' },
    custom:    {},
  }
}
