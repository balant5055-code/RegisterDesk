// RD-STORAGE-01 · In-memory StorageProvider for tests.
//
// This file is the proof that the abstraction works: it implements the SAME interface the
// R2 provider implements, in ~120 lines, with no SDK — and StorageService drives it without
// a single change. If a future LocalStorageProvider or S3Provider needed StorageService to
// change, this fake would not compile.
//
// It also lets every policy in StorageService (validation, keying, checksums, the
// certificate rule, visibility → URL) be tested deterministically with no network.

import { StorageError } from '@/features/platform-storage/types/errors'
import type {
  DownloadResult, ListOptions, ListResult, ObjectMetadata, SignedUrlOptions,
} from '@/features/platform-storage/types'
import type { ProviderPutInput, StorageProvider } from '@/features/platform-storage/interfaces/StorageProvider'

interface StoredObject {
  body:         Uint8Array
  mimeType:     string
  metadata:     Record<string, string>
  cacheControl: string | null
  updatedAt:    string
}

export interface FakeProviderOptions {
  /** Simulate an unconfigured deployment. */
  configured?: boolean
  /** Simulate rejected credentials on every operation. */
  invalidCredentials?: boolean
  /** Simulate a bucket that does not exist. */
  missingBucket?: boolean
  /** Public base URL; empty string ⇒ the bucket has no public domain. */
  publicBase?: string
}

export class FakeStorageProvider implements StorageProvider {
  readonly id   = 'fake'
  readonly name = 'In-memory (test)'

  readonly objects = new Map<string, StoredObject>()
  /** Every signed URL minted, so tests can assert on expiry and operation. */
  readonly signed: SignedUrlOptions[] = []

  constructor(private readonly opts: FakeProviderOptions = {}) {}

  isConfigured(): boolean {
    return this.opts.configured !== false
  }

  private guard(context: string): void {
    if (!this.isConfigured()) {
      throw new StorageError('NOT_CONFIGURED', `${context}: storage is not configured.`)
    }
    if (this.opts.invalidCredentials) {
      throw new StorageError('INVALID_CREDENTIALS', `${context}: credentials rejected.`, 'InvalidAccessKeyId')
    }
    if (this.opts.missingBucket) {
      throw new StorageError('BUCKET_NOT_FOUND', `${context}: bucket missing.`, 'NoSuchBucket')
    }
  }

  async upload(input: ProviderPutInput): Promise<ObjectMetadata> {
    this.guard(`upload ${input.key}`)

    if (input.overwrite === false && this.objects.has(input.key)) {
      throw new StorageError('ALREADY_EXISTS', `An object already exists at ${input.key}.`)
    }

    const updatedAt = new Date().toISOString()
    this.objects.set(input.key, {
      body:         input.body,
      mimeType:     input.mimeType,
      metadata:     input.metadata ?? {},
      cacheControl: input.cacheControl ?? null,
      updatedAt,
    })

    return {
      path: input.key, size: input.body.byteLength, mimeType: input.mimeType,
      updatedAt, checksum: null,
    }
  }

  async download(key: string): Promise<DownloadResult> {
    this.guard(`download ${key}`)
    const obj = this.objects.get(key)
    if (!obj) throw new StorageError('NOT_FOUND', `download ${key}: object not found.`)
    return { body: obj.body, mimeType: obj.mimeType, size: obj.body.byteLength }
  }

  async getMetadata(key: string): Promise<ObjectMetadata> {
    this.guard(`metadata ${key}`)
    const obj = this.objects.get(key)
    if (!obj) throw new StorageError('NOT_FOUND', `metadata ${key}: object not found.`)
    return {
      path: key, size: obj.body.byteLength, mimeType: obj.mimeType,
      updatedAt: obj.updatedAt, checksum: obj.metadata.checksum ?? null,
    }
  }

  async exists(key: string): Promise<boolean> {
    this.guard(`exists ${key}`)
    return this.objects.has(key)
  }

  async list(options: ListOptions): Promise<ListResult> {
    this.guard(`list ${options.prefix}`)

    const keys = [...this.objects.keys()].filter(k => k.startsWith(options.prefix)).sort()
    const start = options.cursor ? keys.indexOf(options.cursor) + 1 : 0
    const limit = options.limit ?? 1000
    const page  = keys.slice(start, start + limit)

    return {
      objects: page.map(k => {
        const o = this.objects.get(k)!
        return {
          path: k, size: o.body.byteLength, mimeType: o.mimeType,
          updatedAt: o.updatedAt, checksum: o.metadata.checksum ?? null,
        }
      }),
      nextCursor: start + limit < keys.length ? page[page.length - 1] : null,
    }
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    this.guard(`copy ${sourceKey}`)
    const obj = this.objects.get(sourceKey)
    if (!obj) throw new StorageError('NOT_FOUND', `copy ${sourceKey}: object not found.`)
    this.objects.set(destinationKey, { ...obj })
  }

  async move(sourceKey: string, destinationKey: string): Promise<void> {
    await this.copy(sourceKey, destinationKey)
    await this.delete(sourceKey)
  }

  /** Idempotent, matching the real provider. */
  async delete(key: string): Promise<void> {
    this.guard(`delete ${key}`)
    this.objects.delete(key)
  }

  async generateSignedUrl(options: SignedUrlOptions): Promise<string> {
    this.guard(`sign ${options.path}`)
    this.signed.push(options)
    const exp = options.expiresIn ?? 300
    return `https://signed.test/${options.path}?op=${options.operation}&exp=${exp}&sig=fake`
  }

  publicUrl(key: string): string | null {
    if (!this.isConfigured()) return null
    const base = this.opts.publicBase ?? 'https://cdn.test'
    return base === '' ? null : `${base}/${key}`
  }
}
