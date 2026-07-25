// RD-PLATFORM-COMMS-02 Phase 5B — the canonical Audience FIELD registry (isomorphic).
//
// The ONE source of truth for the fields an audience rule may target. A rule that references a
// field outside this registry, or an operator invalid for the field's type, is flagged by the
// audience resolver. Pure + read-only — describes the segmentation contract; evaluates nothing.

import type { RuleCondition } from './types'

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum'
export type FieldCategory = 'organization' | 'license' | 'verification' | 'finance' | 'activity' | 'account' | 'location'

export interface AudienceField {
  id:       string
  label:    string
  type:     FieldType
  category: FieldCategory
  reserved?: boolean   // declared for the model but not yet evaluable (future field)
}

/** Conditions valid for each field type. */
export const CONDITIONS_FOR_TYPE: Record<FieldType, RuleCondition[]> = {
  string:  ['equals', 'not_equals', 'contains', 'starts_with', 'ends_with', 'exists', 'not_exists', 'in', 'not_in'],
  number:  ['equals', 'not_equals', 'greater_than', 'less_than', 'exists', 'not_exists', 'in', 'not_in'],
  boolean: ['equals', 'not_equals', 'exists', 'not_exists'],
  date:    ['greater_than', 'less_than', 'exists', 'not_exists'],
  enum:    ['equals', 'not_equals', 'in', 'not_in', 'exists', 'not_exists'],
}

/** THE canonical supported-field registry. */
export const AUDIENCE_FIELDS: AudienceField[] = [
  { id: 'organizationName',  label: 'Organization',      type: 'string',  category: 'organization' },
  { id: 'licenseTier',       label: 'License Tier',      type: 'enum',    category: 'license' },
  { id: 'licenseStatus',     label: 'License Status',    type: 'enum',    category: 'license' },
  { id: 'emailVerified',     label: 'Email Verified',    type: 'boolean', category: 'verification' },
  { id: 'phoneVerified',     label: 'Phone Verified',    type: 'boolean', category: 'verification' },
  { id: 'walletBalancePaise',label: 'Wallet Balance',    type: 'number',  category: 'finance' },
  { id: 'registrationCount', label: 'Registration Count',type: 'number',  category: 'activity' },
  { id: 'eventsPublished',   label: 'Events Published',  type: 'number',  category: 'activity' },
  { id: 'createdAt',         label: 'Created Date',      type: 'date',    category: 'account' },
  { id: 'lastLoginAt',       label: 'Last Login',        type: 'date',    category: 'account' },
  { id: 'country',           label: 'Country',           type: 'string',  category: 'location' },
  { id: 'state',             label: 'State',             type: 'string',  category: 'location' },
  { id: 'role',              label: 'Role',              type: 'enum',    category: 'account' },
  { id: 'status',            label: 'Status',            type: 'enum',    category: 'account' },
]

const BY_ID: Record<string, AudienceField> = Object.fromEntries(AUDIENCE_FIELDS.map(f => [f.id, f]))

export function getAudienceField(id: string): AudienceField | undefined { return BY_ID[id] }
export function isKnownField(id: string): boolean { return id in BY_ID }
