// Phase H.3.5 — Metadata storage (Deliverable 7 + Step 16). Server-only (Admin SDK).
//
// ADDITIVE collections only — nothing here reads or writes any existing
// collection, and there is no migration. When no schema has been authored, every
// reader returns null and the resolver falls back to system fields, so existing
// behaviour is unchanged.
//
// Collections:
//   metadataSchemas/{scope}__{entityType}__v{version}   — authored schema versions
//   metadataSchemaPointers/{scope}__{entityType}        — published/draft pointers
//
// Read cost is bounded and cached (see SCHEMA_CACHE): at most 2 doc reads per
// (scope, entityType) on a cache miss, 0 on a hit.

import { adminDb } from '@/lib/firebase/admin'
import {
  METADATA_SCHEMAS_COLLECTION, METADATA_POINTERS_COLLECTION,
} from './types'
import type {
  EntityType, SchemaScope, SchemaDefinition, MetadataPointerDoc,
} from './types'

const schemaDocId  = (scope: SchemaScope, e: EntityType, v: number) => `${scope}__${e}__v${v}`
const pointerDocId = (scope: SchemaScope, e: EntityType) => `${scope}__${e}`

// ─── In-memory schema cache (Step 16) ───────────────────────────────────────
//
// Process-local cache keyed by (scope, entityType). TTL keeps published schema
// reads off the hot path; published schemas change rarely. A real deployment can
// swap this for a shared cache without touching callers.

const TTL_MS = 60_000
interface CacheEntry { schema: SchemaDefinition | null; at: number }
const SCHEMA_CACHE = new Map<string, CacheEntry>()

function cacheKey(scope: SchemaScope, e: EntityType): string { return `${scope}__${e}` }

/** Clears the cache (call after an authoring write). */
export function invalidateSchemaCache(scope?: SchemaScope, entityType?: EntityType): void {
  if (scope && entityType) SCHEMA_CACHE.delete(cacheKey(scope, entityType))
  else SCHEMA_CACHE.clear()
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** The currently-published schema for (scope, entityType), or null. Cached. */
export async function getPublishedSchema(
  scope: SchemaScope, entityType: EntityType, now: number,
): Promise<SchemaDefinition | null> {
  const key = cacheKey(scope, entityType)
  const hit = SCHEMA_CACHE.get(key)
  if (hit && now - hit.at < TTL_MS) return hit.schema

  const pointerSnap = await adminDb.collection(METADATA_POINTERS_COLLECTION).doc(pointerDocId(scope, entityType)).get()
  const version = pointerSnap.exists ? (pointerSnap.data() as MetadataPointerDoc).publishedVersion : null

  let schema: SchemaDefinition | null = null
  if (version !== null && version !== undefined) {
    const snap = await adminDb.collection(METADATA_SCHEMAS_COLLECTION).doc(schemaDocId(scope, entityType, version)).get()
    if (snap.exists) schema = snap.data() as SchemaDefinition
  }

  SCHEMA_CACHE.set(key, { schema, at: now })
  return schema
}

/** A specific draft version (uncached — authoring path). */
export async function getDraftSchema(
  scope: SchemaScope, entityType: EntityType,
): Promise<SchemaDefinition | null> {
  const pointerSnap = await adminDb.collection(METADATA_POINTERS_COLLECTION).doc(pointerDocId(scope, entityType)).get()
  const version = pointerSnap.exists ? (pointerSnap.data() as MetadataPointerDoc).draftVersion : null
  if (version === null || version === undefined) return null
  const snap = await adminDb.collection(METADATA_SCHEMAS_COLLECTION).doc(schemaDocId(scope, entityType, version)).get()
  return snap.exists ? (snap.data() as SchemaDefinition) : null
}
