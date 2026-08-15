// RD-STORAGE-01 · StorageService — SERVER ONLY. The API every module uses.
//
// ─── Why the policy lives here and not in the provider ───────────────────────
// Path building, id generation, validation, checksums and the certificate rule all run in
// this layer, ABOVE the provider. A new provider therefore inherits every policy for free
// and cannot forget one. A provider is a dumb byte store; this is where RegisterDesk's
// rules are.
//
// ─── The contract with the rest of the codebase ──────────────────────────────
//   • Business modules import from `@/features/platform-storage` and nothing deeper.
//   • Nothing outside `providers/cloudflare-r2/` may import an S3 SDK.
//   • Uploads are SERVER-ONLY. This module is never imported by a client component: it
//     reads secrets and computes signatures.

import { StorageError } from '@/features/platform-storage/types/errors'
import type {
  DownloadResult, ListResult, ObjectMetadata, SignedUrlOperation,
  StorageAssetMetadata, StorageAssetType, StorageVisibility, UploadInput, UploadResult,
} from '@/features/platform-storage/types'
import type { StorageProvider } from '@/features/platform-storage/interfaces/StorageProvider'
import { DEFAULT_PROVIDER_ID, getProvider, type StorageProviderId } from '@/features/platform-storage/providers'
import {
  PRIVATE_CACHE_CONTROL, PUBLIC_CACHE_CONTROL, SIGNED_URL_DEFAULT_SECONDS,
} from '@/features/platform-storage/providers/cloudflare-r2/config'
import { sha256Hex } from '@/features/platform-storage/utils/checksum'
import { generateObjectId, sanitizeOriginalFilename } from '@/features/platform-storage/utils/objectKey'
import {
  assertSafeKey, buildEventPrefix, buildObjectKey, buildPrefix, defaultVisibility,
} from '@/features/platform-storage/utils/paths'
import {
  assertExtensionConsistent, assertMimeAllowed, assertSizeAllowed, assertVisibilityAllowed,
} from '@/features/platform-storage/utils/validation'

export class StorageService {
  private readonly provider: StorageProvider

  constructor(providerOrId: StorageProvider | StorageProviderId = DEFAULT_PROVIDER_ID) {
    this.provider = typeof providerOrId === 'string' ? getProvider(providerOrId) : providerOrId
  }

  /** Which provider is in use — for logs and diagnostics. */
  get providerId(): string { return this.provider.id }

  /** Never throws. Lets a caller degrade instead of failing a cold path. */
  isConfigured(): boolean { return this.provider.isConfigured() }

  // ── Upload ──────────────────────────────────────────────────────────────────

  /**
   * Validates, keys, hashes and stores an object, returning its metadata record.
   *
   * Order matters and is deliberate: everything cheap and rejecting runs BEFORE any byte
   * leaves the process, so an oversized or disallowed upload costs no bandwidth.
   */
  async upload(input: UploadInput): Promise<UploadResult> {
    // 1. Content type — normalised and allow-listed for this asset type.
    const mimeType = assertMimeAllowed(input.type, input.mimeType)

    // 2. Size.
    assertSizeAllowed(input.type, input.body.byteLength)

    // 3. Extension must not contradict the declared type.
    assertExtensionConsistent(input.originalFilename, mimeType)

    // 4. Visibility — resolved, then checked. A PUBLIC certificate is refused, never
    //    silently downgraded.
    const visibility: StorageVisibility = input.visibility ?? defaultVisibility(input.type)
    assertVisibilityAllowed(input.type, visibility)

    // 5. Key. Always a generated id — never the uploader's filename.
    const objectId = input.id ?? generateObjectId(mimeType)
    const key = buildObjectKey({ type: input.type, eventSlug: input.eventSlug, objectId })

    // 6. Checksum, computed on OUR side so it attests to what we sent.
    const checksum = sha256Hex(input.body)

    const originalFilename = sanitizeOriginalFilename(input.originalFilename)

    await this.provider.upload({
      key,
      body:     input.body,
      mimeType,
      cacheControl: visibility === 'PUBLIC' ? PUBLIC_CACHE_CONTROL : PRIVATE_CACHE_CONTROL,
      // Object metadata is bounded and non-PII. The uploader's filename is included because
      // it is already stored in the metadata record; nothing sensitive is added here.
      metadata: {
        assetType:  input.type,
        visibility,
        checksum,
        uploadedBy: input.uploadedBy,
        ...(originalFilename ? { originalFilename } : {}),
      },
    })

    const metadata: StorageAssetMetadata = {
      id:         objectId,
      eventId:    input.eventId ?? null,
      type:       input.type,
      path:       key,
      size:       input.body.byteLength,
      mimeType,
      checksum,
      visibility,
      uploadedBy: input.uploadedBy,
      uploadedAt: new Date().toISOString(),
      status:     'active',
      originalFilename,
      ...(input.tags ? { tags: input.tags } : {}),
    }

    return {
      metadata,
      // A private object has no durable URL, by design.
      publicUrl: visibility === 'PUBLIC' ? this.provider.publicUrl(key) : null,
    }
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  async download(path: string): Promise<DownloadResult> {
    assertSafeKey(path)
    return this.provider.download(path)
  }

  async getMetadata(path: string): Promise<ObjectMetadata> {
    assertSafeKey(path)
    return this.provider.getMetadata(path)
  }

  async exists(path: string): Promise<boolean> {
    assertSafeKey(path)
    return this.provider.exists(path)
  }

  /** Lists under a prefix built by the module — a caller never passes a raw prefix. */
  async list(type: StorageAssetType, eventSlug: string | null, options?: {
    limit?: number; cursor?: string | null
  }): Promise<ListResult> {
    return this.provider.list({
      prefix: buildPrefix(type, eventSlug),
      limit:  options?.limit,
      cursor: options?.cursor ?? null,
    })
  }

  /** Everything belonging to one event — for a lifecycle or migration job. */
  async listEvent(eventSlug: string, options?: {
    limit?: number; cursor?: string | null
  }): Promise<ListResult> {
    return this.provider.list({
      prefix: buildEventPrefix(eventSlug),
      limit:  options?.limit,
      cursor: options?.cursor ?? null,
    })
  }

  // ── Move / copy / delete ────────────────────────────────────────────────────

  async copy(sourcePath: string, destinationPath: string): Promise<void> {
    assertSafeKey(sourcePath)
    assertSafeKey(destinationPath)
    return this.provider.copy(sourcePath, destinationPath)
  }

  async move(sourcePath: string, destinationPath: string): Promise<void> {
    assertSafeKey(sourcePath)
    assertSafeKey(destinationPath)
    return this.provider.move(sourcePath, destinationPath)
  }

  /** Idempotent — deleting a missing object succeeds. */
  async delete(path: string): Promise<void> {
    assertSafeKey(path)
    return this.provider.delete(path)
  }

  // ── URLs ────────────────────────────────────────────────────────────────────

  /**
   * A short-lived signed URL. SERVER ONLY.
   *
   * Callers pass the VISIBILITY they stored the object with, so the service can refuse to
   * sign something that should never have been private in the first place — and, more
   * importantly, so a PUBLIC asset is served from its cacheable public URL rather than
   * burning a signature on every request.
   */
  async generateSignedUrl(params: {
    path:       string
    operation?: SignedUrlOperation
    expiresIn?: number
    mimeType?:  string
    /** RD-CERT-ARTIFACT-01 — `read` only; see SignedUrlOptions. */
    responseContentDisposition?: string
  }): Promise<string> {
    assertSafeKey(params.path)
    return this.provider.generateSignedUrl({
      path:      params.path,
      operation: params.operation ?? 'read',
      expiresIn: params.expiresIn ?? SIGNED_URL_DEFAULT_SECONDS,
      mimeType:  params.mimeType,
      responseContentDisposition: params.responseContentDisposition,
    })
  }

  /**
   * The right URL for an object given its visibility.
   *
   *   PUBLIC              → the durable public URL (cacheable, free to serve)
   *   PRIVATE             → refused; a private object is fetched server-side only
   *   SIGNED_URL          → a short-lived signed URL
   */
  async resolveUrl(params: {
    path:       string
    visibility: StorageVisibility
    expiresIn?: number
  }): Promise<string> {
    assertSafeKey(params.path)

    if (params.visibility === 'PUBLIC') {
      const url = this.provider.publicUrl(params.path)
      if (!url) {
        throw new StorageError(
          'NOT_CONFIGURED',
          'This object is PUBLIC but the bucket has no public base URL configured (R2_PUBLIC_URL).',
        )
      }
      return url
    }

    if (params.visibility === 'PRIVATE') {
      throw new StorageError(
        'FORBIDDEN',
        'A PRIVATE object has no URL. Download it server-side, or store it as SIGNED_URL.',
      )
    }

    return this.generateSignedUrl({ path: params.path, operation: 'read', expiresIn: params.expiresIn })
  }

  /** The durable public URL, or null. Does not throw — for optional rendering. */
  publicUrl(path: string): string | null {
    return this.provider.publicUrl(path)
  }
}

/** The shared instance. Business modules use this. */
export const storage = new StorageService()
