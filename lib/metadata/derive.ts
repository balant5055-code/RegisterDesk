// Phase H.3.5 — Derivations (Deliverables 10–14). Pure + SDK-free.
//
// Every downstream capability — certificate tokens, report columns, filters,
// search, import mapping, API contract — is DERIVED from a single FieldDefinition.
// Add a field once → it automatically becomes a token, a column, a filter, a
// search facet, an import target and an API field. No code changes per feature.

import type { EntityType, FieldDefinition, Audience } from './types'
import { CUSTOM_NAMESPACE } from './types'

// ─── Step 10 — Certificate tokens ───────────────────────────────────────────

/** Returns the `{{...}}` token for a field, or null when not token-exposable. */
export function certificateTokenFor(entityType: EntityType, field: FieldDefinition): string | null {
  if (!field.certificateToken) return null
  const ns = field.classification === 'configurable'
    ? CUSTOM_NAMESPACE[entityType]            // {{participant.custom.bloodGroup}}
    : entityType                              // {{registration.ticketCode}}
  return `{{${ns}.${field.key}}}`
}

// ─── Step 11 — Dynamic report columns ───────────────────────────────────────

export interface ReportColumn { key: string; label: string; order: number; sortable: boolean }

export function isExportable(field: FieldDefinition): boolean {
  if (field.export?.exportable === false) return false
  if (field.export?.exportable === true)  return true
  // Default: export non-sensitive fields that aren't internal references.
  return !field.sensitive && field.type !== 'reference'
}

export function reportColumnFor(field: FieldDefinition): ReportColumn | null {
  if (!isExportable(field)) return null
  return {
    key:   field.key,
    label: field.export?.columnLabel ?? field.label,
    order: field.order ?? 0,
    sortable: field.index?.sortable ?? false,
  }
}

// ─── Step 12 — Dynamic filters & search ─────────────────────────────────────

export type FilterOp = 'eq' | 'neq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'

export interface FilterDescriptor { key: string; label: string; type: string; ops: FilterOp[]; facetable: boolean }

function opsForType(field: FieldDefinition): FilterOp[] {
  switch (field.type) {
    case 'number': case 'decimal': case 'currency': case 'date': case 'datetime': case 'time':
      return ['eq', 'gt', 'gte', 'lt', 'lte', 'between']
    case 'dropdown': case 'radio': case 'multiselect': case 'checkbox': case 'boolean': case 'country': case 'state':
      return ['eq', 'neq', 'in']
    default:
      return ['eq', 'contains', 'in']
  }
}

export function filterDescriptorFor(field: FieldDefinition): FilterDescriptor | null {
  if (!field.index?.filterable) return null
  return {
    key: field.key, label: field.label, type: field.type,
    ops: opsForType(field), facetable: field.index?.facetable ?? false,
  }
}

export interface SearchDescriptor { key: string; weight: number; facetable: boolean }

export function searchDescriptorFor(field: FieldDefinition): SearchDescriptor | null {
  if (!field.index?.searchable && !field.index?.facetable) return null
  // Identity-ish fields score higher.
  const weight = field.classification === 'immutable' ? 3 : field.type === 'email' ? 2 : 1
  return { key: field.key, weight, facetable: field.index?.facetable ?? false }
}

// ─── Step 13 — Import mapping (CSV / Excel / API) ───────────────────────────

export interface ImportMapping { header: string; key: string; type: string; required: boolean }

export function importMappingFor(field: FieldDefinition): ImportMapping | null {
  // Only writable, non-computed fields can be import targets.
  if (field.classification === 'computed' || field.classification === 'derived' || field.classification === 'immutable') return null
  if (field.validation?.readonly) return null
  return {
    header:   field.export?.columnLabel ?? field.label,
    key:      field.key,
    type:     field.type,
    required: field.validation?.required ?? false,
  }
}

// ─── Step 14 — API contract ─────────────────────────────────────────────────

export interface ApiFieldContract { key: string; readable: boolean; writable: boolean }

const DEFAULT_READ:  Audience[] = ['organizer', 'admin']
const DEFAULT_WRITE: Audience[] = ['organizer', 'admin']

export function apiFieldFor(field: FieldDefinition, audience: Audience): ApiFieldContract | null {
  if (field.api?.apiVisible === false) return null
  const readable = (field.api?.readable ?? field.permissions?.read ?? DEFAULT_READ).includes(audience)
  const writableBase = field.classification === 'configurable' || field.classification === 'system'
  const writable = writableBase
    && !field.validation?.readonly
    && (field.api?.writable ?? field.permissions?.write ?? DEFAULT_WRITE).includes(audience)
  if (!readable && !writable) return null
  return { key: field.key, readable, writable }
}

// ─── Convenience: derive a full set for a resolved field list ───────────────

export function deriveColumns(fields: FieldDefinition[]): ReportColumn[] {
  return fields.map(reportColumnFor).filter((c): c is ReportColumn => c !== null)
    .sort((a, b) => a.order - b.order)
}
export function deriveFilters(fields: FieldDefinition[]): FilterDescriptor[] {
  return fields.map(filterDescriptorFor).filter((d): d is FilterDescriptor => d !== null)
}
export function deriveTokens(entityType: EntityType, fields: FieldDefinition[]): string[] {
  return fields.map(field => certificateTokenFor(entityType, field)).filter((t): t is string => t !== null)
}
