// RD-CERT-PHOTO-04 — the storage contract behind persistent certificate photos.
//
// Pure functions only: asset-type registration, the two namespaces, and the bytes policy.
// No Firestore, no routes, no emulator — so this pins the layer the persistence design
// rests on without any harness at all.
//
// The namespaces are the load-bearing part. `certificate-photos/` is PERSISTENT and
// referenced by certificates/{id}.attendeePhotoKey; `certificate-photos-tmp/` is the
// in-flight upload the grant owns and the expiry sweep reclaims. Collapsing the two would
// either strand temporary objects forever or let the cleanup sweep delete a live photo.

import { describe, it, expect } from 'vitest'
import { buildObjectKey, buildPrefix, defaultVisibility, isEventScoped } from '@/features/platform-storage/utils/paths'
import { assertMimeAllowed, assertSizeAllowed } from '@/features/platform-storage/utils/validation'
import { isStorageError } from '@/features/platform-storage/types/errors'

const SLUG = 'profiling-marathon-2026--event'
const CERT = 'RDC-2026-DO1D5B'
const MB = 1024 * 1024

describe('18 · the permanent asset type is registered', () => {
  it('is event-scoped and private', () => {
    expect(isEventScoped('event-certificate-photo')).toBe(true)
    expect(defaultVisibility('event-certificate-photo')).toBe('SIGNED_URL')
  })

  it('never defaults to PUBLIC — it is a photograph of a named person', () => {
    expect(defaultVisibility('event-certificate-photo')).not.toBe('PUBLIC')
    expect(defaultVisibility('event-certificate-photo-tmp')).not.toBe('PUBLIC')
  })
})

describe('19/20 · the two namespaces stay distinct', () => {
  const perm = buildObjectKey({ type: 'event-certificate-photo',     eventSlug: SLUG, scopeId: CERT, objectId: 'a.jpg' })
  const tmp  = buildObjectKey({ type: 'event-certificate-photo-tmp', eventSlug: SLUG, scopeId: CERT, objectId: 'a.jpg' })

  it('permanent keys live under /certificate-photos/', () => {
    expect(perm).toBe(`events/${SLUG}/certificate-photos/${CERT}/a.jpg`)
    expect(perm).toContain('/certificate-photos/')
    expect(perm).not.toContain('-tmp/')
  })

  it('temporary keys live under /certificate-photos-tmp/', () => {
    expect(tmp).toBe(`events/${SLUG}/certificate-photos-tmp/${CERT}/a.jpg`)
  })

  it('neither prefix is a prefix of the other — cleanup cannot cross over', () => {
    const permPrefix = buildPrefix('event-certificate-photo', SLUG)
    const tmpPrefix  = buildPrefix('event-certificate-photo-tmp', SLUG)
    expect(tmp.startsWith(permPrefix)).toBe(false)
    expect(perm.startsWith(tmpPrefix)).toBe(false)
  })

  it('scopes per certificate, so one certificate cannot reach another', () => {
    const other = buildObjectKey({ type: 'event-certificate-photo', eventSlug: SLUG, scopeId: 'RDC-2026-OTHER1', objectId: 'a.jpg' })
    expect(other.startsWith(`events/${SLUG}/certificate-photos/${CERT}/`)).toBe(false)
  })

  it('refuses a traversal scopeId rather than building an escaping key', () => {
    expect(() => buildObjectKey({
      type: 'event-certificate-photo', eventSlug: SLUG, scopeId: '../evil', objectId: 'a.jpg',
    })).toThrow()
  })

  it('requires an event slug — the type is event-scoped', () => {
    expect(() => buildObjectKey({
      type: 'event-certificate-photo', eventSlug: null, scopeId: CERT, objectId: 'a.jpg',
    })).toThrow()
  })
})

describe('21 · bytes policy matches the temporary form exactly', () => {
  // The finalized object is the SAME bytes, copied. A looser policy here would let the
  // permanent namespace hold something the upload path would have refused.
  it('accepts the same image types', () => {
    for (const m of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(assertMimeAllowed('event-certificate-photo', m)).toBe(m)
      expect(assertMimeAllowed('event-certificate-photo-tmp', m)).toBe(m)
    }
  })

  it('refuses non-images on both', () => {
    for (const t of ['event-certificate-photo', 'event-certificate-photo-tmp'] as const) {
      for (const m of ['application/pdf', 'text/html', 'image/svg+xml']) {
        expect(() => assertMimeAllowed(t, m), `${t} ${m}`).toThrow()
      }
    }
  })

  it('enforces the same 4 MB ceiling on both', () => {
    for (const t of ['event-certificate-photo', 'event-certificate-photo-tmp'] as const) {
      expect(() => assertSizeAllowed(t, 4 * MB)).not.toThrow()
      expect(() => assertSizeAllowed(t, 4 * MB + 1)).toThrow()
    }
  })

  it('reports a StorageError, not a raw throw', () => {
    try { assertMimeAllowed('event-certificate-photo', 'application/pdf'); expect.unreachable() }
    catch (e) { expect(isStorageError(e)).toBe(true) }
  })
})
