// Phase H.3.5 — Universal Metadata & Schema Platform: core type system.
//
// The permanent, strongly-typed contract for EVERY configurable entity in
// RegisterDesk. After this phase, new fields/entities are added by configuration
// (a stored Schema) — never by adding hardcoded business fields.
//
// SDK-free — safe to import from client and server. This module only DEFINES the
// model; it never reads or writes Firestore and never touches existing data.

// ─── Entities ───────────────────────────────────────────────────────────────
//
// Strongly typed, yet extensible: adding a future entity is a one-line union
// addition — the storage layer and resolver are generic over EntityType, so NO
// schema/collection redesign is ever required.

export type EntityType =
  | 'participant'
  | 'registration'
  | 'event'
  | 'crmContact'
  | 'donation'
  | 'certificate'
  | 'session'
  | 'campaign'
  | 'volunteer'
  | 'team'

export const ENTITY_TYPES: readonly EntityType[] = [
  'participant', 'registration', 'event', 'crmContact', 'donation',
  'certificate', 'session', 'campaign', 'volunteer', 'team',
] as const

// ─── Field classification (Step 1) ──────────────────────────────────────────

export type FieldClassification =
  | 'system'        // platform-managed (status, ticketCode, timestamps)
  | 'configurable'  // organizer-defined custom field
  | 'computed'      // maintained by code (counters, amounts)
  | 'derived'       // projected from other data (CRM totals)
  | 'immutable'     // identity; set once, never editable

// ─── Field types (Step 4) ───────────────────────────────────────────────────

export type FieldType =
  | 'text' | 'textarea' | 'number' | 'decimal' | 'currency' | 'boolean'
  | 'email' | 'phone' | 'url'
  | 'date' | 'time' | 'datetime'
  | 'dropdown' | 'multiselect' | 'radio' | 'checkbox'
  | 'country' | 'state' | 'city' | 'address'
  | 'file' | 'image' | 'qr' | 'barcode'
  | 'identifier' | 'formula' | 'lookup' | 'reference'
  | 'signature' | 'json' | 'richtext'

export const FIELD_TYPES: readonly FieldType[] = [
  'text', 'textarea', 'number', 'decimal', 'currency', 'boolean',
  'email', 'phone', 'url', 'date', 'time', 'datetime',
  'dropdown', 'multiselect', 'radio', 'checkbox',
  'country', 'state', 'city', 'address',
  'file', 'image', 'qr', 'barcode',
  'identifier', 'formula', 'lookup', 'reference',
  'signature', 'json', 'richtext',
] as const

export interface FieldOption {
  value: string
  label: string
  /** Optional per-option colour/icon for badge designers etc. */
  color?: string
}

// ─── Validation (Step 5) ────────────────────────────────────────────────────

export interface ValidationRule {
  required?:     boolean
  regex?:        string
  min?:          number
  max?:          number
  minLength?:    number
  maxLength?:    number
  unique?:       boolean      // enforced server-side at write time
  readonly?:     boolean
  hidden?:       boolean
  /** A conditional expression key; evaluated by the rule engine (future). */
  conditional?:  string
  /** Named server validator (resolved by a server registry). */
  customServer?: string
}

// ─── Visibility (Step 6) ────────────────────────────────────────────────────

export type VisibilityRuleType =
  | 'always' | 'role' | 'plan' | 'event_type'
  | 'registration_status' | 'payment_status' | 'expression'

export interface VisibilityRule {
  type:        VisibilityRuleType
  roles?:      string[]
  plans?:      string[]
  eventTypes?: string[]
  statuses?:   string[]      // registration / payment statuses
  expression?: string        // evaluated by the rule engine (future)
}

// ─── Audience / permissions (Step 14, 17) ───────────────────────────────────

export type Audience = 'public' | 'attendee' | 'organizer' | 'admin'

export interface FieldPermissions {
  read:  Audience[]
  write: Audience[]
}

// ─── Index / search / export / API metadata (Steps 11–14) ───────────────────

export interface FieldIndexMeta {
  searchable?: boolean
  filterable?: boolean
  sortable?:   boolean
  indexed?:    boolean
  facetable?:  boolean
}

export interface FieldExportMeta {
  exportable?:  boolean
  columnLabel?: string
}

export interface FieldApiMeta {
  apiVisible?: boolean       // exposed via the public/organizer API
  readable?:   Audience[]
  writable?:   Audience[]
}

// ─── Field definition (Deliverable 4) ───────────────────────────────────────

export interface FieldDefinition {
  /** Stable key. For custom fields this is the namespaced storage key. */
  key:            string
  label:          string
  type:           FieldType
  classification: FieldClassification

  description?:   string
  placeholder?:   string
  group?:         string       // GroupDefinition.key
  section?:       string       // SectionDefinition.key
  order?:         number

  options?:       FieldOption[]      // for dropdown/multiselect/radio
  defaultValue?:  unknown
  computedFormula?: string           // for type 'formula' (evaluated later)
  reference?:     { entityType: EntityType; displayField?: string }  // lookup/reference

  validation?:    ValidationRule
  visibility?:    VisibilityRule[]
  permissions?:   FieldPermissions

  index?:         FieldIndexMeta
  export?:        FieldExportMeta
  api?:           FieldApiMeta

  /** When set, this field is exposable as a certificate token. */
  certificateToken?: boolean
  /** Append every change to the audit timeline. */
  auditEnabled?:  boolean
  /** PII / sensitive — masked + access-restricted. */
  sensitive?:     boolean
  /** Convenience mirror of classification === 'immutable'. */
  immutable?:     boolean
}

// ─── Layout: sections & groups (Step 8) ─────────────────────────────────────

export interface SectionDefinition {
  key:          string
  label:        string
  order:        number
  description?: string
  /** Render as a review/summary page in a multi-step builder. */
  reviewPage?:  boolean
  visibility?:  VisibilityRule[]
}

export interface GroupDefinition {
  key:        string
  label:      string
  sectionKey: string
  order:      number
}

// ─── Schema (Deliverable 3) ─────────────────────────────────────────────────

export type SchemaStatus = 'draft' | 'published'

/**
 * The scope a schema applies to. `global` ships in code; `org:` / `event:`
 * scopes are organizer-authored overrides resolved on top of the global one.
 */
export type SchemaScope = 'global' | `org:${string}` | `event:${string}`

export interface SchemaDefinition {
  entityType: EntityType
  scope:      SchemaScope
  version:    number
  status:     SchemaStatus
  sections:   SectionDefinition[]
  groups:     GroupDefinition[]
  /** ONLY the configurable/custom fields. System fields come from the registry. */
  fields:     FieldDefinition[]
  createdAt?: unknown
  updatedAt?: unknown
  publishedAt?: unknown
}

/**
 * The fully-resolved schema a consumer reads: system fields (from the code
 * registry) merged with the configured custom fields, ordered by section/group.
 */
export interface ResolvedSchema {
  entityType:  EntityType
  scope:       SchemaScope
  version:     number
  sections:    SectionDefinition[]
  groups:      GroupDefinition[]
  fields:      FieldDefinition[]   // system + configurable, merged
  byKey:       Record<string, FieldDefinition>
  customFields: FieldDefinition[]  // configurable subset
}

// ─── Storage documents (Step 7 — additive collections) ──────────────────────
//
// New collections only. Nothing here redesigns or migrates an existing
// collection. `metadataSchemas` stores authored schemas; `metadataSchemaPointers`
// records the published/draft version per (scope, entityType).

export const METADATA_SCHEMAS_COLLECTION  = 'metadataSchemas'
export const METADATA_POINTERS_COLLECTION = 'metadataSchemaPointers'

/** metadataSchemas/{scope}__{entityType}__v{version} */
export interface MetadataSchemaDoc extends SchemaDefinition {
  id: string
}

/** metadataSchemaPointers/{scope}__{entityType} */
export interface MetadataPointerDoc {
  scope:            SchemaScope
  entityType:       EntityType
  publishedVersion: number | null
  draftVersion:     number | null
  updatedAt:        unknown
}

// ─── Custom value namespace (Steps 9, 15 — adapters) ────────────────────────
//
// Custom values live in an additive `custom` map on each entity document; the
// existing registration form continues to use attendee.formResponses (bridged by
// the adapter). No existing field is moved or renamed.

export type CustomValues = Record<string, unknown>

export const CUSTOM_NAMESPACE: Record<EntityType, string> = {
  participant:  'participant.custom',
  registration: 'registration.custom',
  event:        'event.custom',
  crmContact:   'contact.custom',
  donation:     'donation.custom',
  certificate:  'certificate.custom',
  session:      'session.custom',
  campaign:     'campaign.custom',
  volunteer:    'volunteer.custom',
  team:         'team.custom',
}
