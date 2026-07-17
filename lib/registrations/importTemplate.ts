// Shared contract for the Bulk Registration Import template + parser.
// PURE + isomorphic — no Firebase, no server/client-only imports — so the SERVER
// template generator (RM-2.1) and the CLIENT parser (RM-2.2A) agree on one source
// of truth for sheet names, the template version, required headers, and limits.

export const IMPORT_TEMPLATE_VERSION = '1'

// Sheet names inside the generated workbook.
export const IMPORT_SHEET_PARTICIPANTS  = 'Participants'
export const IMPORT_SHEET_FIELD_OPTIONS = 'Field Options'
export const IMPORT_SHEET_INSTRUCTIONS  = 'Instructions'
export const IMPORT_SHEET_META          = 'Meta'

// Standard header cells that MUST be present in the Participants sheet for the file
// to be structurally valid (the required standard columns carry a " *" marker).
export const IMPORT_REQUIRED_HEADERS = ['Full Name *', 'Email *', 'Pass *'] as const

// Structural limits (enforced by the parser — NOT value validation).
export const IMPORT_MAX_ROWS       = 2000
export const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024   // 5 MB

// Row keys used in the Meta sheet (Key | Value pairs).
export const IMPORT_META_KEYS = {
  version:     'Template Version',
  eventId:     'Event ID',
  eventSlug:   'Event Slug',
  generatedAt: 'Generated At',
} as const

export interface ImportTemplateMetadata {
  version:     string
  eventId:     string
  eventSlug:   string
  generatedAt: string   // ISO 8601
}
