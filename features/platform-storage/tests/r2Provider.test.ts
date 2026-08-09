// RD-STORAGE-01 · Cloudflare R2 provider — configuration, keying and policy.
//
// The provider's NETWORK behaviour is not exercised here: doing so honestly needs live R2
// credentials, and a mocked S3 client would only assert that the mock was called, which
// proves nothing. What IS tested is everything that can be wrong without a network — the
// config boundary, the endpoint, URL construction, and the path/validation policy the
// provider inherits.
//
// See "Not verified" in the changelog for exactly what remains unproven.

import { describe, it, expect } from 'vitest'
import { CloudflareR2Provider } from '@/features/platform-storage/providers/cloudflare-r2/CloudflareR2Provider'
import {
  LIST_MAX_KEYS, PRIVATE_CACHE_CONTROL, PUBLIC_CACHE_CONTROL, R2_REGION,
  SIGNED_URL_DEFAULT_SECONDS, SIGNED_URL_MAX_SECONDS, isR2Configured, missingR2Vars,
  r2Endpoint,
} from '@/features/platform-storage/providers/cloudflare-r2/config'
import { getProvider, DEFAULT_PROVIDER_ID } from '@/features/platform-storage/providers'
import { StorageError } from '@/features/platform-storage/types/errors'
import {
  buildEventPrefix, buildObjectKey, buildPrefix, defaultVisibility, isEventScoped,
} from '@/features/platform-storage/utils/paths'
import {
  extensionForMime, generateObjectId, sanitizeOriginalFilename,
} from '@/features/platform-storage/utils/objectKey'
import {
  allowedMimeTypes, assertVisibilityAllowed, maxBytesFor, normalizeMimeType,
} from '@/features/platform-storage/utils/validation'
import { sha256Hex } from '@/features/platform-storage/utils/checksum'
import type { StorageAssetType } from '@/features/platform-storage/types'

const ALL_TYPES: StorageAssetType[] = [
  'event-banner', 'event-photo-original', 'event-photo-medium', 'event-photo-thumbnail',
  'event-certificate', 'event-finisher-badge', 'event-report',
  'marketing-logo', 'marketing-sponsor', 'system',
]

// ─── Configuration boundary ───────────────────────────────────────────────────

describe('R2 configuration', () => {
  it('reports exactly which variables are missing', () => {
    // The test environment has no R2 credentials, which is the point: an unconfigured
    // deployment must report itself clearly rather than crash.
    const missing = missingR2Vars()
    expect(Array.isArray(missing)).toBe(true)
    for (const name of missing) {
      expect(['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])
        .toContain(name)
    }
  })

  it('isConfigured() agrees with missingR2Vars() and never throws', () => {
    expect(() => isR2Configured()).not.toThrow()
    expect(isR2Configured()).toBe(missingR2Vars().length === 0)
  })

  it('R2_PUBLIC_URL is NOT required — a bucket with no public domain is a valid setup', () => {
    expect(missingR2Vars()).not.toContain('R2_PUBLIC_URL')
  })

  it('builds the S3-compatible endpoint and uses the auto region', () => {
    expect(r2Endpoint('abc123')).toBe('https://abc123.r2.cloudflarestorage.com')
    expect(R2_REGION).toBe('auto')
  })

  it('clamps signed-URL lifetimes to something short', () => {
    expect(SIGNED_URL_DEFAULT_SECONDS).toBeLessThanOrEqual(SIGNED_URL_MAX_SECONDS)
    expect(SIGNED_URL_MAX_SECONDS).toBeLessThanOrEqual(60 * 60 * 24 * 7)  // AWS SigV4 ceiling
    expect(SIGNED_URL_DEFAULT_SECONDS).toBeLessThanOrEqual(900)           // ≤ 15 min default
  })

  it('caps list pages so one call cannot fetch an unbounded page', () => {
    expect(LIST_MAX_KEYS).toBeLessThanOrEqual(1000)
  })

  it('uses immutable caching for public objects and no-store for private ones', () => {
    expect(PUBLIC_CACHE_CONTROL).toContain('immutable')
    expect(PUBLIC_CACHE_CONTROL).toContain('public')
    expect(PRIVATE_CACHE_CONTROL).toContain('no-store')
    expect(PRIVATE_CACHE_CONTROL).toContain('private')
  })
})

describe('CloudflareR2Provider (no network)', () => {
  const provider = new CloudflareR2Provider()

  it('identifies itself', () => {
    expect(provider.id).toBe('cloudflare-r2')
    expect(provider.name).toBe('Cloudflare R2')
  })

  it('isConfigured() never throws, even with no credentials', () => {
    expect(() => provider.isConfigured()).not.toThrow()
  })

  it('publicUrl() returns null rather than throwing when unconfigured', () => {
    if (!provider.isConfigured()) {
      expect(provider.publicUrl('events/e/banners/a.png')).toBeNull()
    }
  })

  it('fails with NOT_CONFIGURED — not a vendor error — when credentials are absent', async () => {
    if (provider.isConfigured()) return   // a configured dev machine skips this
    await expect(provider.download('events/e/banners/a.png')).rejects.toBeInstanceOf(StorageError)
    await provider.download('events/e/banners/a.png').catch((e: StorageError) => {
      expect(e.code).toBe('NOT_CONFIGURED')
    })
  })
})

describe('provider registry', () => {
  it('defaults to Cloudflare R2 and returns a singleton', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('cloudflare-r2')
    expect(getProvider()).toBe(getProvider())
    expect(getProvider().id).toBe('cloudflare-r2')
  })
})

// ─── Bucket hierarchy ─────────────────────────────────────────────────────────

describe('bucket hierarchy', () => {
  it('matches the documented structure', () => {
    const id = 'abc.png'
    expect(buildObjectKey({ type: 'event-banner',          eventSlug: 'run-26', objectId: id })).toBe('events/run-26/banners/abc.png')
    expect(buildObjectKey({ type: 'event-photo-original',  eventSlug: 'run-26', objectId: id })).toBe('events/run-26/photos/original/abc.png')
    expect(buildObjectKey({ type: 'event-photo-medium',    eventSlug: 'run-26', objectId: id })).toBe('events/run-26/photos/medium/abc.png')
    expect(buildObjectKey({ type: 'event-photo-thumbnail', eventSlug: 'run-26', objectId: id })).toBe('events/run-26/photos/thumbnail/abc.png')
    expect(buildObjectKey({ type: 'event-certificate',     eventSlug: 'run-26', objectId: id })).toBe('events/run-26/certificates/abc.png')
    expect(buildObjectKey({ type: 'event-finisher-badge',  eventSlug: 'run-26', objectId: id })).toBe('events/run-26/finisher-badges/abc.png')
    expect(buildObjectKey({ type: 'event-report',          eventSlug: 'run-26', objectId: id })).toBe('events/run-26/reports/abc.png')
    expect(buildObjectKey({ type: 'marketing-logo',        eventSlug: null,     objectId: id })).toBe('marketing/logos/abc.png')
    expect(buildObjectKey({ type: 'marketing-sponsor',     eventSlug: null,     objectId: id })).toBe('marketing/sponsors/abc.png')
    expect(buildObjectKey({ type: 'system',                eventSlug: null,     objectId: id })).toBe('system/abc.png')
  })

  it('every prefix ends with a slash, so a prefix never matches a sibling folder', () => {
    for (const type of ALL_TYPES) {
      const prefix = buildPrefix(type, isEventScoped(type) ? 'run-26' : null)
      expect(prefix.endsWith('/')).toBe(true)
    }
    expect(buildEventPrefix('run-26')).toBe('events/run-26/')
  })

  it('every asset type has a default visibility, and neither certificates nor reports are public', () => {
    for (const type of ALL_TYPES) {
      expect(defaultVisibility(type)).toBeDefined()
    }
    expect(defaultVisibility('event-certificate')).not.toBe('PUBLIC')
    expect(defaultVisibility('event-report')).not.toBe('PUBLIC')
  })
})

// ─── Naming ───────────────────────────────────────────────────────────────────

describe('object naming', () => {
  it('generates a uuid key with an extension derived from the CONTENT TYPE', () => {
    expect(generateObjectId('image/png')).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(generateObjectId('application/pdf')).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    expect(generateObjectId('image/jpeg')).toMatch(/^[0-9a-f-]{36}\.jpg$/)
  })

  it('never repeats an id', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateObjectId('image/png')))
    expect(ids.size).toBe(500)
  })

  it('maps only allow-listed mime types to an extension', () => {
    expect(extensionForMime('image/svg+xml')).toBeNull()
    expect(extensionForMime('text/html')).toBeNull()
    expect(extensionForMime('image/PNG')).toBe('png')   // case-insensitive
  })

  it('sanitises an original filename for safe storage as metadata', () => {
    expect(sanitizeOriginalFilename('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(sanitizeOriginalFilename('  spaced.png  ')).toBe('spaced.png')
    expect(sanitizeOriginalFilename('')).toBeNull()
    expect(sanitizeOriginalFilename(null)).toBeNull()
    expect((sanitizeOriginalFilename('x'.repeat(500)) ?? '').length).toBeLessThanOrEqual(200)
  })

  it('strips control characters that would break a log line or a header', () => {
    const nasty = `evil${String.fromCharCode(10)}Set-Cookie: x.png`
    const clean = sanitizeOriginalFilename(nasty) ?? ''
    expect(clean).not.toContain(String.fromCharCode(10))
  })
})

// ─── Validation policy ────────────────────────────────────────────────────────

describe('validation policy', () => {
  it('never allows SVG anywhere — it is an executable document', () => {
    for (const type of ALL_TYPES) {
      expect(allowedMimeTypes(type)).not.toContain('image/svg+xml')
    }
  })

  it('never allows HTML or JavaScript anywhere', () => {
    for (const type of ALL_TYPES) {
      const allowed = allowedMimeTypes(type)
      expect(allowed).not.toContain('text/html')
      expect(allowed).not.toContain('application/javascript')
    }
  })

  it('gives every type a positive, finite size ceiling', () => {
    for (const type of ALL_TYPES) {
      const max = maxBytesFor(type)
      expect(max).toBeGreaterThan(0)
      expect(Number.isFinite(max)).toBe(true)
    }
  })

  it('normalises a content type with parameters and casing', () => {
    expect(normalizeMimeType('image/JPEG; charset=binary')).toBe('image/jpeg')
    expect(normalizeMimeType('  application/PDF  ')).toBe('application/pdf')
  })

  it('assertVisibilityAllowed is the single certificate guard', () => {
    expect(() => assertVisibilityAllowed('event-certificate', 'PUBLIC')).toThrow(StorageError)
    expect(() => assertVisibilityAllowed('event-certificate', 'PRIVATE')).not.toThrow()
    expect(() => assertVisibilityAllowed('event-certificate', 'SIGNED_URL')).not.toThrow()
    expect(() => assertVisibilityAllowed('event-banner', 'PUBLIC')).not.toThrow()
  })
})

// ─── Checksum ─────────────────────────────────────────────────────────────────

describe('checksum', () => {
  it('is a stable sha256 hex digest', () => {
    const a = sha256Hex(new TextEncoder().encode('hello'))
    expect(a).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(sha256Hex(new TextEncoder().encode('hello'))).toBe(a)
  })

  it('differs for different content', () => {
    const a = sha256Hex(new TextEncoder().encode('a'))
    const b = sha256Hex(new TextEncoder().encode('b'))
    expect(a).not.toBe(b)
  })
})
