// Phase H.3.5 — Universal Metadata Platform: public barrel.
//
// Import surface for the platform. Pure modules (types/registry/validation/
// visibility/derive/adapters) are SDK-free and safe anywhere; storage/resolve are
// server-only (Admin SDK).

export * from './types'
export { systemFields, SYSTEM_FIELDS } from './registry'
export { validateValue, validateValues, type ValidationResult } from './validation'
export { isVisible, type VisibilityContext } from './visibility'
export {
  certificateTokenFor, reportColumnFor, filterDescriptorFor, searchDescriptorFor,
  importMappingFor, apiFieldFor, isExportable, deriveColumns, deriveFilters, deriveTokens,
  type ReportColumn, type FilterDescriptor, type SearchDescriptor, type ImportMapping,
  type ApiFieldContract, type FilterOp,
} from './derive'
export { readCustomValues, readCustomValue, buildCustomPatch } from './adapters'

// Server-only (Admin SDK) — import directly where a server context is guaranteed:
//   import { resolveSchema } from '@/lib/metadata/resolve'
//   import { getPublishedSchema, invalidateSchemaCache } from '@/lib/metadata/storage'
