// RD-STORAGE-01 · Platform Storage — StorageService behaviour.
//
// The brief's required coverage: upload, download, delete, signed URL, invalid credentials,
// missing bucket, duplicate upload, metadata, visibility.
//
// Driven through the SAME StorageProvider interface the R2 provider implements, using an
// in-memory fake. That is the point: if StorageService needed to know it was talking to R2,
// none of this would work.

import { describe, it, expect } from 'vitest'
import { StorageService } from '@/features/platform-storage/services/StorageService'
import { StorageError } from '@/features/platform-storage/types/errors'
import type { StorageAssetType, UploadInput } from '@/features/platform-storage/types'
import { FakeStorageProvider, type FakeProviderOptions } from './fakeProvider'

const bytes = (s: string) => new TextEncoder().encode(s)
const PNG = bytes('fake-png-content')

function make(opts: FakeProviderOptions = {}) {
  const provider = new FakeStorageProvider(opts)
  return { provider, service: new StorageService(provider) }
}

function upload(overrides: Partial<UploadInput> = {}): UploadInput {
  return {
    type:       'event-banner' as StorageAssetType,
    eventSlug:  'coimbatore-marathon-2026',
    body:       PNG,
    mimeType:   'image/png',
    uploadedBy: 'uid_organizer',
    ...overrides,
  }
}

/** Asserts a promise rejects with a specific StorageError code. */
async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(StorageError)
  await p.catch((e: StorageError) => expect(e.code).toBe(code))
}

// ─── Upload ───────────────────────────────────────────────────────────────────

describe('upload', () => {
  it('stores the bytes and returns a complete metadata record', async () => {
    const { service, provider } = make()
    const { metadata } = await service.upload(upload())

    expect(provider.objects.has(metadata.path)).toBe(true)
    // Every field the brief requires.
    expect(Object.keys(metadata).sort()).toEqual(expect.arrayContaining([
      'id', 'eventId', 'type', 'path', 'size', 'mimeType', 'checksum',
      'visibility', 'uploadedBy', 'uploadedAt', 'status', 'originalFilename',
    ]))
    expect(metadata.size).toBe(PNG.byteLength)
    expect(metadata.status).toBe('active')
    expect(metadata.uploadedBy).toBe('uid_organizer')
    expect(Date.parse(metadata.uploadedAt)).not.toBeNaN()
  })

  it('places the object in the documented hierarchy', async () => {
    const { service } = make()
    const { metadata } = await service.upload(upload())
    expect(metadata.path).toMatch(/^events\/coimbatore-marathon-2026\/banners\/[0-9a-f-]+\.png$/)
  })

  it('NEVER uses the uploader filename as the key — it is kept only as metadata', async () => {
    const { service } = make()
    const { metadata } = await service.upload(upload({
      originalFilename: 'Q3-layoffs-CONFIDENTIAL.png',
    }))
    expect(metadata.path).not.toContain('layoffs')
    expect(metadata.path).not.toContain('CONFIDENTIAL')
    expect(metadata.originalFilename).toBe('Q3-layoffs-CONFIDENTIAL.png')
  })

  it('neutralises a traversal filename rather than letting it near a key', async () => {
    const { service } = make()
    const { metadata } = await service.upload(upload({
      originalFilename: '../../etc/passwd.png',
    }))
    expect(metadata.path).not.toContain('..')
    expect(metadata.originalFilename).toBe('.._.._etc_passwd.png')
  })

  it('computes a sha256 checksum of the content', async () => {
    const { service } = make()
    const a = await service.upload(upload())
    const b = await service.upload(upload())
    expect(a.metadata.checksum).toMatch(/^[0-9a-f]{64}$/)
    // Same bytes ⇒ same checksum, which is what makes duplicate detection possible…
    expect(a.metadata.checksum).toBe(b.metadata.checksum)
    // …while distinct objects still get distinct keys.
    expect(a.metadata.path).not.toBe(b.metadata.path)
  })

  it('is idempotent when the caller supplies an id', async () => {
    const { service, provider } = make()
    const a = await service.upload(upload({ id: 'fixed-id.png' }))
    const b = await service.upload(upload({ id: 'fixed-id.png' }))
    expect(a.metadata.path).toBe(b.metadata.path)
    expect(provider.objects.size).toBe(1)   // duplicate upload overwrote, did not duplicate
  })

  it('rejects a disallowed content type', async () => {
    const { service } = make()
    await expectCode(service.upload(upload({ mimeType: 'image/svg+xml' })), 'UNSUPPORTED_TYPE')
    await expectCode(service.upload(upload({ mimeType: 'text/html' })), 'UNSUPPORTED_TYPE')
  })

  it('rejects a file over the type limit', async () => {
    const { service } = make()
    const huge = new Uint8Array(11 * 1024 * 1024)   // banner cap is 10 MB
    await expectCode(service.upload(upload({ body: huge })), 'FILE_TOO_LARGE')
  })

  it('rejects an empty upload', async () => {
    const { service } = make()
    await expectCode(service.upload(upload({ body: new Uint8Array() })), 'INVALID_INPUT')
  })

  it('rejects an extension that contradicts the content type', async () => {
    const { service } = make()
    await expectCode(
      service.upload(upload({ originalFilename: 'payload.exe', mimeType: 'image/png' })),
      'UNSUPPORTED_TYPE',
    )
  })

  it('accepts .jpeg for image/jpeg', async () => {
    const { service } = make()
    await expect(service.upload(upload({
      mimeType: 'image/jpeg', originalFilename: 'photo.jpeg',
    }))).resolves.toBeDefined()
  })

  it('requires an eventSlug for event-scoped types, and forbids one otherwise', async () => {
    const { service } = make()
    await expectCode(service.upload(upload({ eventSlug: null })), 'INVALID_INPUT')
    await expectCode(
      service.upload(upload({ type: 'marketing-logo', eventSlug: 'some-event' })),
      'INVALID_INPUT',
    )
  })

  it('rejects an unsafe event slug instead of silently rewriting it', async () => {
    const { service } = make()
    await expectCode(service.upload(upload({ eventSlug: '../escape' })), 'INVALID_INPUT')
    await expectCode(service.upload(upload({ eventSlug: 'Has Spaces' })), 'INVALID_INPUT')
  })
})

// ─── Visibility ───────────────────────────────────────────────────────────────

describe('visibility', () => {
  it('applies the per-type default', async () => {
    const { service } = make()
    const banner = await service.upload(upload())
    const cert   = await service.upload(upload({ type: 'event-certificate', mimeType: 'application/pdf' }))

    expect(banner.metadata.visibility).toBe('PUBLIC')
    expect(cert.metadata.visibility).toBe('SIGNED_URL')
  })

  it('REFUSES a PUBLIC certificate — the rule the certificate module depends on', async () => {
    const { service } = make()
    await expectCode(
      service.upload(upload({
        type: 'event-certificate', mimeType: 'application/pdf', visibility: 'PUBLIC',
      })),
      'FORBIDDEN',
    )
  })

  it('refuses a PUBLIC report too', async () => {
    const { service } = make()
    await expectCode(
      service.upload(upload({ type: 'event-report', mimeType: 'text/csv', visibility: 'PUBLIC' })),
      'FORBIDDEN',
    )
  })

  it('allows PRIVATE for a certificate', async () => {
    const { service } = make()
    const { metadata, publicUrl } = await service.upload(upload({
      type: 'event-certificate', mimeType: 'application/pdf', visibility: 'PRIVATE',
    }))
    expect(metadata.visibility).toBe('PRIVATE')
    expect(publicUrl).toBeNull()   // a private object has no durable URL
  })

  it('returns a public URL only for PUBLIC assets', async () => {
    const { service } = make()
    const banner = await service.upload(upload())
    const cert   = await service.upload(upload({ type: 'event-certificate', mimeType: 'application/pdf' }))
    expect(banner.publicUrl).toContain('/events/coimbatore-marathon-2026/banners/')
    expect(cert.publicUrl).toBeNull()
  })

  it('sets an immutable cache header for public objects and no-store for private ones', async () => {
    const { service, provider } = make()
    const banner = await service.upload(upload())
    const cert   = await service.upload(upload({ type: 'event-certificate', mimeType: 'application/pdf' }))

    expect(provider.objects.get(banner.metadata.path)?.cacheControl).toContain('immutable')
    expect(provider.objects.get(cert.metadata.path)?.cacheControl).toContain('no-store')
  })
})

// ─── resolveUrl ───────────────────────────────────────────────────────────────

describe('resolveUrl', () => {
  it('returns the durable URL for PUBLIC', async () => {
    const { service } = make()
    const url = await service.resolveUrl({ path: 'marketing/logos/a.png', visibility: 'PUBLIC' })
    expect(url).toBe('https://cdn.test/marketing/logos/a.png')
  })

  it('mints a signed URL for SIGNED_URL', async () => {
    const { service, provider } = make()
    const url = await service.resolveUrl({ path: 'events/e/certificates/a.pdf', visibility: 'SIGNED_URL' })
    expect(url).toContain('sig=fake')
    expect(provider.signed[0].operation).toBe('read')
  })

  it('REFUSES to hand out any URL for PRIVATE', async () => {
    const { service } = make()
    await expectCode(
      service.resolveUrl({ path: 'system/secret.json', visibility: 'PRIVATE' }),
      'FORBIDDEN',
    )
  })

  it('reports a misconfiguration when a PUBLIC asset has no public base URL', async () => {
    const { service } = make({ publicBase: '' })
    await expectCode(
      service.resolveUrl({ path: 'marketing/logos/a.png', visibility: 'PUBLIC' }),
      'NOT_CONFIGURED',
    )
  })
})

// ─── Signed URLs ──────────────────────────────────────────────────────────────

describe('generateSignedUrl', () => {
  it('defaults to a read URL with a short lifetime', async () => {
    const { service, provider } = make()
    await service.generateSignedUrl({ path: 'events/e/reports/r.csv' })
    expect(provider.signed[0]).toMatchObject({ operation: 'read', expiresIn: 300 })
  })

  it('supports a write URL carrying its content type', async () => {
    const { service, provider } = make()
    await service.generateSignedUrl({
      path: 'events/e/photos/original/p.jpg', operation: 'write', mimeType: 'image/jpeg',
    })
    expect(provider.signed[0]).toMatchObject({ operation: 'write', mimeType: 'image/jpeg' })
  })

  it('rejects an unsafe path before signing anything', async () => {
    const { service, provider } = make()
    await expectCode(service.generateSignedUrl({ path: '../../etc/passwd' }), 'INVALID_INPUT')
    expect(provider.signed).toHaveLength(0)
  })
})

// ─── Download / metadata / exists / delete ────────────────────────────────────

describe('download, metadata, exists, delete', () => {
  it('round-trips the exact bytes', async () => {
    const { service } = make()
    const { metadata } = await service.upload(upload())
    const got = await service.download(metadata.path)
    expect(new TextDecoder().decode(got.body)).toBe('fake-png-content')
    expect(got.mimeType).toBe('image/png')
    expect(got.size).toBe(PNG.byteLength)
  })

  it('reports NOT_FOUND for a missing object', async () => {
    const { service } = make()
    await expectCode(service.download('events/e/banners/missing.png'), 'NOT_FOUND')
    await expectCode(service.getMetadata('events/e/banners/missing.png'), 'NOT_FOUND')
  })

  it('exists() distinguishes present from absent', async () => {
    const { service } = make()
    const { metadata } = await service.upload(upload())
    expect(await service.exists(metadata.path)).toBe(true)
    expect(await service.exists('events/e/banners/nope.png')).toBe(false)
  })

  it('returns metadata for a stored object', async () => {
    const { service } = make()
    const { metadata } = await service.upload(upload())
    const meta = await service.getMetadata(metadata.path)
    expect(meta.path).toBe(metadata.path)
    expect(meta.size).toBe(PNG.byteLength)
    expect(meta.mimeType).toBe('image/png')
  })

  it('delete is idempotent — deleting twice succeeds', async () => {
    const { service, provider } = make()
    const { metadata } = await service.upload(upload())
    await service.delete(metadata.path)
    await expect(service.delete(metadata.path)).resolves.toBeUndefined()
    expect(provider.objects.size).toBe(0)
  })

  it('rejects an unsafe path on every read/write entry point', async () => {
    const { service } = make()
    for (const bad of ['../secret', '/absolute', 'a//b', 'back\\slash']) {
      await expectCode(service.download(bad), 'INVALID_INPUT')
      await expectCode(service.delete(bad), 'INVALID_INPUT')
    }
  })
})

// ─── copy / move / list ───────────────────────────────────────────────────────

describe('copy, move, list', () => {
  it('copy leaves the source in place', async () => {
    const { service, provider } = make()
    const { metadata } = await service.upload(upload())
    await service.copy(metadata.path, 'events/coimbatore-marathon-2026/banners/copy.png')
    expect(provider.objects.size).toBe(2)
    expect(provider.objects.has(metadata.path)).toBe(true)
  })

  it('move removes the source', async () => {
    const { service, provider } = make()
    const { metadata } = await service.upload(upload())
    await service.move(metadata.path, 'events/coimbatore-marathon-2026/banners/moved.png')
    expect(provider.objects.has(metadata.path)).toBe(false)
    expect(provider.objects.has('events/coimbatore-marathon-2026/banners/moved.png')).toBe(true)
  })

  it('lists under a module-built prefix, cursor-paginated', async () => {
    const { service } = make()
    for (let i = 0; i < 5; i++) await service.upload(upload({ id: `p${i}.png` }))

    const first = await service.list('event-banner', 'coimbatore-marathon-2026', { limit: 2 })
    expect(first.objects).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const second = await service.list('event-banner', 'coimbatore-marathon-2026', {
      limit: 2, cursor: first.nextCursor,
    })
    expect(second.objects).toHaveLength(2)
    expect(second.objects[0].path).not.toBe(first.objects[0].path)
  })

  it('listEvent spans every folder of one event', async () => {
    const { service } = make()
    await service.upload(upload())
    await service.upload(upload({ type: 'event-report', mimeType: 'text/csv' }))

    const all = await service.listEvent('coimbatore-marathon-2026')
    expect(all.objects).toHaveLength(2)
    expect(all.objects.every(o => o.path.startsWith('events/coimbatore-marathon-2026/'))).toBe(true)
  })
})

// ─── Failure modes ────────────────────────────────────────────────────────────

describe('provider failure modes', () => {
  it('surfaces NOT_CONFIGURED without throwing from isConfigured()', async () => {
    const { service } = make({ configured: false })
    expect(service.isConfigured()).toBe(false)
    await expectCode(service.upload(upload()), 'NOT_CONFIGURED')
  })

  it('surfaces INVALID_CREDENTIALS distinctly from NOT_FOUND', async () => {
    const { service } = make({ invalidCredentials: true })
    await expectCode(service.upload(upload()), 'INVALID_CREDENTIALS')
    await expectCode(service.download('events/e/banners/a.png'), 'INVALID_CREDENTIALS')
  })

  it('surfaces BUCKET_NOT_FOUND', async () => {
    const { service } = make({ missingBucket: true })
    await expectCode(service.upload(upload()), 'BUCKET_NOT_FOUND')
  })

  it('a credentials failure never masquerades as "object absent"', async () => {
    // The dangerous bug this guards: exists() swallowing an auth error and returning false
    // would make a caller believe an object was deleted.
    const { service } = make({ invalidCredentials: true })
    await expectCode(service.exists('events/e/banners/a.png'), 'INVALID_CREDENTIALS')
  })
})

// ─── The abstraction itself ───────────────────────────────────────────────────

describe('provider independence', () => {
  it('StorageService drives a non-R2 provider with no changes', async () => {
    // The whole suite proves this, but state it explicitly: the fake implements only
    // StorageProvider, imports no SDK, and every policy above still held.
    const { service } = make()
    expect(service.providerId).toBe('fake')
    const { metadata } = await service.upload(upload())
    expect(metadata.path).toMatch(/^events\//)
  })
})
