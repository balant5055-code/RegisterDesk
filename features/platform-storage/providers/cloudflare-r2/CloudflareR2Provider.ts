// RD-STORAGE-01 · CloudflareR2Provider — SERVER ONLY.
//
// The ONLY file in RegisterDesk permitted to import an S3/R2 SDK. Everything else in the
// codebase talks to StorageService, which talks to the StorageProvider interface.
//
// R2 is S3-API-compatible, so `@aws-sdk/client-s3` is the client. That SDK family is
// already trusted in this repo (`@aws-sdk/client-sesv2` powers email), so this adds
// siblings to a present vendor rather than a new supply-chain root. The alternative —
// hand-rolling SigV4 — would mean writing security-critical signing code by hand.
//
// Every vendor error is translated into a `StorageError` before it leaves this file, so no
// caller ever catches an `S3ServiceException`.

import {
  CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand,
  ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { StorageError } from '@/features/platform-storage/types/errors'
import type {
  DownloadResult, ListOptions, ListResult, ObjectMetadata, SignedUrlOptions,
} from '@/features/platform-storage/types'
import type { ProviderPutInput, StorageProvider } from '@/features/platform-storage/interfaces/StorageProvider'
import { assertSafeKey } from '@/features/platform-storage/utils/paths'
import {
  LIST_MAX_KEYS, R2_REGION, SIGNED_URL_DEFAULT_SECONDS, SIGNED_URL_MAX_SECONDS,
  isR2Configured, requireR2Config, type R2Config,
} from './config'

/** Vendor error shape we read without importing a class. */
interface AwsLikeError {
  name?:      string
  message?:   string
  $metadata?: { httpStatusCode?: number }
  Code?:      string
}

/**
 * Maps a vendor failure onto the module's error vocabulary.
 *
 * The vendor's own code is preserved in `providerCode` for logs, never in the message a
 * route might surface.
 */
function translate(err: unknown, context: string): StorageError {
  const e = (err ?? {}) as AwsLikeError
  const code   = e.name ?? e.Code ?? 'UnknownError'
  const status = e.$metadata?.httpStatusCode

  if (code === 'NoSuchKey' || code === 'NotFound' || status === 404) {
    return new StorageError('NOT_FOUND', `${context}: object not found.`, code)
  }
  if (code === 'NoSuchBucket') {
    return new StorageError('BUCKET_NOT_FOUND', `${context}: the configured bucket does not exist.`, code)
  }
  if (
    code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch' ||
    code === 'AccessDenied' || status === 401 || status === 403
  ) {
    return new StorageError(
      'INVALID_CREDENTIALS',
      `${context}: the storage credentials were rejected.`,
      code,
    )
  }
  return new StorageError('PROVIDER_ERROR', `${context}: storage operation failed.`, code)
}

/** Collects a streamed body into bytes, whatever stream flavour the SDK returns. */
async function toBytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array()

  // Node 18+ / undici streams and Blobs expose these directly.
  const maybe = body as {
    transformToByteArray?: () => Promise<Uint8Array>
    arrayBuffer?: () => Promise<ArrayBuffer>
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>
  }

  if (typeof maybe.transformToByteArray === 'function') return await maybe.transformToByteArray()
  if (typeof maybe.arrayBuffer === 'function') return new Uint8Array(await maybe.arrayBuffer())

  if (typeof maybe[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk); total += chunk.length
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) { out.set(c, offset); offset += c.length }
    return out
  }

  throw new StorageError('PROVIDER_ERROR', 'Unrecognised response body from the storage provider.')
}

function isoOrNull(d: Date | undefined): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null
}

/** R2 returns an ETag; for a single-part upload it is the md5, quoted. Strip the quotes. */
function cleanEtag(etag: string | undefined): string | null {
  return etag ? etag.replace(/^"|"$/g, '') : null
}

export class CloudflareR2Provider implements StorageProvider {
  readonly id   = 'cloudflare-r2'
  readonly name = 'Cloudflare R2'

  private client: S3Client | null = null
  private config: R2Config | null = null

  /** Never throws — lets a caller degrade instead of failing a cold path. */
  isConfigured(): boolean {
    return isR2Configured()
  }

  /** Lazy: the client is built on first use, so importing this file costs nothing and an
   *  unconfigured deployment fails only when storage is actually used. */
  private conn(): { client: S3Client; config: R2Config } {
    if (!this.client || !this.config) {
      const config = requireR2Config()
      this.config = config
      this.client = new S3Client({
        region:   R2_REGION,
        endpoint: config.endpoint,
        credentials: {
          accessKeyId:     config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      })
    }
    return { client: this.client, config: this.config }
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  async upload(input: ProviderPutInput): Promise<ObjectMetadata> {
    assertSafeKey(input.key)
    const { client, config } = this.conn()

    if (input.overwrite === false && await this.exists(input.key)) {
      throw new StorageError('ALREADY_EXISTS', `An object already exists at ${input.key}.`)
    }

    try {
      await client.send(new PutObjectCommand({
        Bucket:       config.bucket,
        Key:          input.key,
        Body:         input.body,
        ContentType:  input.mimeType,
        CacheControl: input.cacheControl,
        Metadata:     input.metadata,
      }))
    } catch (err) {
      throw translate(err, `upload ${input.key}`)
    }

    return {
      path:      input.key,
      size:      input.body.byteLength,
      mimeType:  input.mimeType,
      updatedAt: new Date().toISOString(),
      checksum:  null,   // the service supplies the sha256 it computed before upload
    }
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  async download(key: string): Promise<DownloadResult> {
    assertSafeKey(key)
    const { client, config } = this.conn()

    try {
      const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
      const body = await toBytes(res.Body)
      return {
        body,
        mimeType: res.ContentType ?? 'application/octet-stream',
        size:     body.byteLength,
      }
    } catch (err) {
      throw translate(err, `download ${key}`)
    }
  }

  async getMetadata(key: string): Promise<ObjectMetadata> {
    assertSafeKey(key)
    const { client, config } = this.conn()

    try {
      const res = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
      return {
        path:      key,
        size:      res.ContentLength ?? 0,
        mimeType:  res.ContentType ?? 'application/octet-stream',
        updatedAt: isoOrNull(res.LastModified),
        checksum:  cleanEtag(res.ETag),
      }
    } catch (err) {
      throw translate(err, `metadata ${key}`)
    }
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key)
    const { client, config } = this.conn()

    try {
      await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
      return true
    } catch (err) {
      const translated = translate(err, `exists ${key}`)
      if (translated.code === 'NOT_FOUND') return false
      // A credential or bucket problem must NOT be reported as "the object is absent".
      throw translated
    }
  }

  async list(options: ListOptions): Promise<ListResult> {
    const { client, config } = this.conn()
    const limit = Math.min(Math.max(1, options.limit ?? LIST_MAX_KEYS), LIST_MAX_KEYS)

    try {
      const res = await client.send(new ListObjectsV2Command({
        Bucket:            config.bucket,
        Prefix:            options.prefix,
        MaxKeys:           limit,
        ContinuationToken: options.cursor ?? undefined,
      }))

      const objects: ObjectMetadata[] = (res.Contents ?? []).map(o => ({
        path:      o.Key ?? '',
        size:      o.Size ?? 0,
        // ListObjectsV2 does not return content types; a caller needing one calls
        // getMetadata for that key rather than being handed a guess.
        mimeType:  'application/octet-stream',
        updatedAt: isoOrNull(o.LastModified),
        checksum:  cleanEtag(o.ETag),
      })).filter(o => o.path !== '')

      return {
        objects,
        nextCursor: res.IsTruncated ? (res.NextContinuationToken ?? null) : null,
      }
    } catch (err) {
      throw translate(err, `list ${options.prefix}`)
    }
  }

  // ── Move / copy / delete ────────────────────────────────────────────────────

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    assertSafeKey(sourceKey)
    assertSafeKey(destinationKey)
    const { client, config } = this.conn()

    try {
      await client.send(new CopyObjectCommand({
        Bucket:     config.bucket,
        // CopySource is `{bucket}/{key}` and must be URI-encoded.
        CopySource: `${config.bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
        Key:        destinationKey,
      }))
    } catch (err) {
      throw translate(err, `copy ${sourceKey}`)
    }
  }

  /** Copy then delete. NOT atomic — no object store offers an atomic move. If the delete
   *  fails the copy stands, which leaves a duplicate rather than losing data. */
  async move(sourceKey: string, destinationKey: string): Promise<void> {
    await this.copy(sourceKey, destinationKey)
    await this.delete(sourceKey)
  }

  /** Idempotent: deleting a missing key succeeds, so a retry is always safe. */
  async delete(key: string): Promise<void> {
    assertSafeKey(key)
    const { client, config } = this.conn()

    try {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
    } catch (err) {
      const translated = translate(err, `delete ${key}`)
      if (translated.code === 'NOT_FOUND') return
      throw translated
    }
  }

  // ── URLs ────────────────────────────────────────────────────────────────────

  /**
   * Signed URL. SERVER ONLY — minting one requires the secret key.
   *
   * The lifetime is clamped: a signed URL is a bearer token, and an over-long one is a
   * durable public link by another name.
   */
  async generateSignedUrl(options: SignedUrlOptions): Promise<string> {
    assertSafeKey(options.path)
    const { client, config } = this.conn()

    const expiresIn = Math.min(
      Math.max(1, options.expiresIn ?? SIGNED_URL_DEFAULT_SECONDS),
      SIGNED_URL_MAX_SECONDS,
    )

    // RD-CERT-ARTIFACT-01 — `ResponseContentDisposition` is folded into the SIGNATURE, so a
    // recipient cannot strip or rewrite it to turn an attachment into an inline render.
    // Ignored for `write`, where the header has no meaning.
    const command = options.operation === 'write'
      ? new PutObjectCommand({ Bucket: config.bucket, Key: options.path, ContentType: options.mimeType })
      : new GetObjectCommand({
          Bucket: config.bucket,
          Key:    options.path,
          ...(options.responseContentDisposition
            ? { ResponseContentDisposition: options.responseContentDisposition }
            : {}),
        })

    try {
      return await getSignedUrl(client, command, { expiresIn })
    } catch (err) {
      throw translate(err, `sign ${options.path}`)
    }
  }

  /** Null when no public domain is attached to the bucket — the stricter, valid setup. */
  publicUrl(key: string): string | null {
    if (!this.isConfigured()) return null
    const { config } = this.conn()
    if (!config.publicUrl) return null
    assertSafeKey(key)
    return `${config.publicUrl}/${key}`
  }
}
