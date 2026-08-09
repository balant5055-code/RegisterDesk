// RD-STORAGE-01 · Platform Storage — THE provider contract.
//
// SDK-FREE by contract. Nothing in this file may reference S3, R2, Azure, GCS or Firebase.
// If a signature ever needs a vendor concept to express itself, the abstraction has leaked
// and the fix belongs in the provider, not here.
//
// ─── What a provider is, and is not ──────────────────────────────────────────
// A provider is a DUMB byte store. It moves bytes to and from keys and reports what it
// knows about them.
//
// It does NOT:
//   • decide where an object goes            → utils/paths.ts
//   • generate object ids                    → utils/objectKey.ts
//   • validate type, size or extension       → utils/validation.ts
//   • compute checksums                      → utils/checksum.ts
//   • enforce the certificate rule           → utils/validation.ts
//
// All of that lives in StorageService, ABOVE the provider, so every provider inherits it
// identically and a new provider cannot forget a policy.
//
// ─── Adding a provider ───────────────────────────────────────────────────────
//   1. implement this interface
//   2. register it in providers/index.ts
// No business module changes. That is the entire point of this sprint.

import type {
  DownloadResult, ListOptions, ListResult, ObjectMetadata, SignedUrlOptions,
} from '@/features/platform-storage/types'

export interface ProviderPutInput {
  key:         string
  body:        Uint8Array
  mimeType:    string
  /** Small, provider-agnostic key/value pairs stored alongside the object. */
  metadata?:   Record<string, string>
  /** When false, an existing key must NOT be overwritten. */
  overwrite?:  boolean
  /** Cache-Control to serve with the object. Set for public, immutable assets. */
  cacheControl?: string
}

/**
 * The storage contract.
 *
 * Every method throws `StorageError` (types/errors.ts) and never a vendor error, so a
 * caller's error handling is identical across providers.
 */
export interface StorageProvider {
  /** Stable id, e.g. 'cloudflare-r2'. Recorded in logs and metadata. */
  readonly id: string

  /** Human name for diagnostics. */
  readonly name: string

  /**
   * True when the provider has everything it needs to run. Callers can degrade gracefully
   * instead of throwing on a cold path — this never throws.
   */
  isConfigured(): boolean

  upload(input: ProviderPutInput): Promise<ObjectMetadata>

  download(key: string): Promise<DownloadResult>

  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>

  copy(sourceKey: string, destinationKey: string): Promise<void>

  /** Copy then delete the source. Not atomic — no object store offers an atomic move. */
  move(sourceKey: string, destinationKey: string): Promise<void>

  exists(key: string): Promise<boolean>

  list(options: ListOptions): Promise<ListResult>

  /**
   * A short-lived URL. MUST be generated server-side: minting one requires the secret key,
   * which never reaches a browser.
   */
  generateSignedUrl(options: SignedUrlOptions): Promise<string>

  getMetadata(key: string): Promise<ObjectMetadata>

  /**
   * The durable public URL for a key, or null when the provider has no public base URL
   * configured. Only meaningful for objects stored with PUBLIC visibility.
   */
  publicUrl(key: string): string | null
}
