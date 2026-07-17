// Phase H.3.5 — System-field registry ("the audit, as code").
//
// Declares the EXISTING fields of each entity as metadata descriptors so the
// platform knows about them. These are READ-ONLY descriptors — this module never
// reads or writes Firestore and never changes the entities themselves. System
// fields come from here; configurable fields come from a stored Schema. Keeping
// system fields in code (not storage) avoids any duplication/drift.
//
// SDK-free.

import type { EntityType, FieldDefinition, FieldType, FieldClassification } from './types'

// Compact builder for system descriptors.
function f(
  key: string, label: string, type: FieldType, classification: FieldClassification,
  extra: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    key, label, type, classification,
    immutable: classification === 'immutable',
    ...extra,
  }
}

const COMMON_SYS: FieldDefinition[] = [
  f('organizerUid', 'Workspace',  'reference', 'immutable', { sensitive: true, api: { apiVisible: false } }),
  f('createdAt',    'Created',    'datetime',  'system',    { index: { sortable: true } }),
  f('updatedAt',    'Updated',    'datetime',  'system',    { index: { sortable: true } }),
]

// ─── Registries ─────────────────────────────────────────────────────────────

const REGISTRATION_SYS: FieldDefinition[] = [
  f('id',            'Registration ID', 'text',       'immutable', { index: { searchable: true } }),
  f('eventSlug',     'Event',           'reference',  'immutable', { reference: { entityType: 'event' }, index: { filterable: true } }),
  f('ticketCode',    'Ticket Code',     'text',       'immutable', { index: { searchable: true }, certificateToken: true }),
  f('status',        'Status',          'dropdown',   'system',    { index: { filterable: true, facetable: true },
    options: ['confirmed', 'pending', 'cancelled', 'waitlisted', 'rejected'].map(v => ({ value: v, label: v })) }),
  f('paymentStatus', 'Payment Status',  'dropdown',   'system',    { index: { filterable: true, facetable: true } }),
  f('amount',        'Amount',          'currency',   'computed',  { index: { sortable: true, filterable: true } }),
  f('checkedIn',     'Checked In',      'boolean',    'system',    { index: { filterable: true, facetable: true } }),
  f('registeredAt',  'Registered At',   'datetime',   'immutable', { index: { sortable: true, filterable: true } }),
  // Core identity (configurable label only).
  f('attendee.name',  'Full Name', 'text',  'system', { index: { searchable: true }, certificateToken: true, export: { exportable: true } }),
  f('attendee.email', 'Email',     'email', 'system', { index: { searchable: true, filterable: true }, sensitive: true, export: { exportable: true } }),
  f('attendee.phone', 'Phone',     'phone', 'system', { index: { searchable: true }, sensitive: true }),
  // Identifier engine mirror (H.1.5).
  f('identifier', 'Identifier', 'identifier', 'system', { index: { searchable: true, filterable: true }, certificateToken: true }),
]

// "Participant" is the registration viewed as a person at an event — same store,
// participant-centric lens. Custom participant attributes (blood group, company,
// passport, chip…) attach as configurable fields, NOT new hardcoded columns.
const PARTICIPANT_SYS: FieldDefinition[] = REGISTRATION_SYS

const EVENT_SYS: FieldDefinition[] = [
  f('slug',          'Slug',        'text',     'immutable', { index: { searchable: true } }),
  f('eventDetails.info.name', 'Event Name', 'text', 'system', { index: { searchable: true }, certificateToken: true }),
  f('status',        'Status',      'dropdown', 'system',    { index: { filterable: true, facetable: true } }),
  f('eventType',     'Event Type',  'dropdown', 'configurable', { index: { filterable: true, facetable: true } }),
  ...COMMON_SYS,
]

const CRM_CONTACT_SYS: FieldDefinition[] = [
  f('contactId', 'Contact ID', 'text',  'immutable', {}),
  f('email',     'Email',      'email', 'immutable', { index: { searchable: true }, sensitive: true }),
  f('name',      'Name',       'text',  'system',    { index: { searchable: true } }),
  f('phone',     'Phone',      'phone', 'system',    { sensitive: true }),
  f('tags',      'Tags',       'multiselect', 'configurable', { index: { filterable: true, facetable: true } }),
  f('notes',     'Notes',      'textarea',    'configurable', {}),
  f('totalRegistrations', 'Registrations', 'number', 'derived', { index: { sortable: true } }),
  f('totalDonationAmountPaise', 'Lifetime Donations', 'currency', 'derived', { index: { sortable: true } }),
  ...COMMON_SYS,
]

const SESSION_SYS: FieldDefinition[] = [
  f('sessionId',   'Session ID',  'text',     'immutable', {}),
  f('eventSlug',   'Event',       'reference', 'immutable', { reference: { entityType: 'event' } }),
  f('title',       'Title',       'text',     'configurable', { index: { searchable: true } }),
  f('description', 'Description',  'textarea', 'configurable', {}),
  f('startTime',   'Start',       'datetime', 'configurable', { index: { sortable: true, filterable: true } }),
  f('endTime',     'End',         'datetime', 'configurable', { index: { sortable: true } }),
  f('capacity',    'Capacity',    'number',   'configurable', {}),
  f('registeredCount', 'Registered', 'number', 'computed', { index: { sortable: true } }),
  f('checkedInCount',  'Checked In', 'number', 'computed', {}),
  ...COMMON_SYS,
]

const DONATION_SYS: FieldDefinition[] = [
  f('donationId',  'Donation ID', 'text',     'immutable', {}),
  f('donorEmail',  'Donor Email', 'email',    'immutable', { sensitive: true, index: { searchable: true } }),
  f('amountPaise', 'Amount',      'currency', 'computed',  { index: { sortable: true, filterable: true } }),
  f('status',      'Status',      'dropdown', 'system',    { index: { filterable: true, facetable: true } }),
  ...COMMON_SYS,
]

const CERTIFICATE_SYS: FieldDefinition[] = [
  f('certificateId', 'Certificate ID', 'text',  'immutable', { index: { searchable: true } }),
  f('attendeeEmail', 'Attendee Email', 'email', 'immutable', { sensitive: true }),
  f('generatedAt',   'Issued At',      'datetime', 'system', { index: { sortable: true } }),
  ...COMMON_SYS,
]

const CAMPAIGN_SYS: FieldDefinition[] = [
  f('slug',   'Slug',   'text',     'immutable', { index: { searchable: true } }),
  f('status', 'Status', 'dropdown', 'system',    { index: { filterable: true } }),
  ...COMMON_SYS,
]

// Volunteer / Team have no dedicated store yet — they inherit the participant /
// member shape. Declared empty so the resolver treats them as fully-configurable.
const EMPTY_SYS: FieldDefinition[] = [...COMMON_SYS]

export const SYSTEM_FIELDS: Record<EntityType, FieldDefinition[]> = {
  participant:  PARTICIPANT_SYS,
  registration: REGISTRATION_SYS,
  event:        EVENT_SYS,
  crmContact:   CRM_CONTACT_SYS,
  donation:     DONATION_SYS,
  certificate:  CERTIFICATE_SYS,
  session:      SESSION_SYS,
  campaign:     CAMPAIGN_SYS,
  volunteer:    EMPTY_SYS,
  team:         EMPTY_SYS,
}

export function systemFields(entityType: EntityType): FieldDefinition[] {
  return SYSTEM_FIELDS[entityType] ?? []
}
