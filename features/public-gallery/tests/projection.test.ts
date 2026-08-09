// RD-PUBGAL-01 — the public projection.
//
// This is the boundary between an organizer's media library and the open web. It is kept
// pure and outside the service precisely so it can be proven here rather than inferred from
// a Firestore trace.

import { describe, it, expect } from 'vitest'
import {
  DOWNLOAD_RENDITION_PREFERENCE, GRID_RENDITION_PREFERENCE, LIGHTBOX_RENDITION_PREFERENCE,
  isPubliclyVisible, photoAltText, pickRendition, toPublicGallery, toPublicPhoto,
  withPublicPhotos,
} from '@/features/public-gallery/utils/projection'
import { MEDIA_SCHEMA_VERSION, type GalleryDoc, type MediaAssetDoc } from '@/features/media-studio/types'
import type { PublicGallerySummary } from '@/features/public-gallery/types'

const asset = (over: Partial<MediaAssetDoc> = {}): MediaAssetDoc => ({
  assetId: 'med_abc', schemaVersion: MEDIA_SCHEMA_VERSION,
  organizerUid: 'org_1', eventId: 'evt_1', eventSlug: 'kochi-marathon-YYw3OU',
  galleryId: 'gal_1', albumId: null,
  checksum: 'a'.repeat(64), originalFilename: 'DSC_0001.jpg',
  renditions: {
    original:  { path: 'events/kochi-marathon-YYw3OU/photos/original/o1',  size: 4_000_000, mimeType: 'image/jpeg', width: 6000, height: 4000 },
    medium:    { path: 'events/kochi-marathon-YYw3OU/photos/medium/o1',    size: 400_000,   mimeType: 'image/jpeg', width: 1600, height: 1067 },
    thumbnail: { path: 'events/kochi-marathon-YYw3OU/photos/thumbnail/o1', size: 40_000,    mimeType: 'image/jpeg', width: 400,  height: 267 },
  },
  bytesStored: 4_440_000, bytesOriginalSource: 8_000_000,
  mimeType: 'image/jpeg', width: 6000, height: 4000,
  profileId: 'balanced', status: 'ready', visibility: 'PUBLIC',
  uploadedBy: 'user_1',
  uploadedAt: { toDate: () => new Date('2026-07-01T10:00:00.000Z') },
  updatedAt: null,
  ...over,
})

const gallery = (over: Partial<GalleryDoc> = {}): GalleryDoc => ({
  galleryId: 'gal_1', schemaVersion: MEDIA_SCHEMA_VERSION,
  organizerUid: 'org_1', eventId: 'evt_1', eventSlug: 'kochi-marathon-YYw3OU',
  name: 'Finish Line', preset: 'finish-line', slug: 'finish-line',
  description: 'Every runner crossing the line.',
  assetCount: 120, albumCount: 2, bytesStored: 1, bytesOriginalSource: 2,
  coverAssetId: 'med_abc', createdBy: 'user_1', createdAt: null, updatedAt: null,
  ...over,
})

// ═══════════════ The visibility allow-list ═══════════════

describe('isPubliclyVisible', () => {
  it('shows a ready PUBLIC photo', () => {
    expect(isPubliclyVisible(asset(), MEDIA_SCHEMA_VERSION)).toBe(true)
  })

  it('NEVER shows a SIGNED_URL photo — that is the gated, participant-only surface', () => {
    // RD-RUNNER-01 serves those after email verification. Leaking one here would make the
    // two surfaces overlap and quietly publish a gated photo.
    expect(isPubliclyVisible(asset({ visibility: 'SIGNED_URL' }), MEDIA_SCHEMA_VERSION)).toBe(false)
  })

  it('NEVER shows a PRIVATE photo', () => {
    expect(isPubliclyVisible(asset({ visibility: 'PRIVATE' }), MEDIA_SCHEMA_VERSION)).toBe(false)
  })

  it('is an ALLOW-LIST — an unrecognised visibility is withheld, not admitted', () => {
    const exotic = asset({ visibility: 'UNLISTED' as never })
    expect(isPubliclyVisible(exotic, MEDIA_SCHEMA_VERSION)).toBe(false)
  })

  it('refuses a photo that is not fully uploaded', () => {
    for (const status of ['pending', 'failed', 'deleted'] as const) {
      expect(isPubliclyVisible(asset({ status }), MEDIA_SCHEMA_VERSION), status).toBe(false)
    }
  })

  it('refuses a document written by an unknown schema version', () => {
    expect(isPubliclyVisible(asset({ schemaVersion: 99 }), MEDIA_SCHEMA_VERSION)).toBe(false)
  })
})

// ═══════════════ Renditions ═══════════════

describe('pickRendition', () => {
  it('shows the medium in the grid and the original in the lightbox', () => {
    expect(pickRendition(asset(), GRID_RENDITION_PREFERENCE)?.rendition).toBe('medium')
    expect(pickRendition(asset(), LIGHTBOX_RENDITION_PREFERENCE)?.rendition).toBe('original')
  })

  it('downloads the same rendition the lightbox shows', () => {
    expect([...DOWNLOAD_RENDITION_PREFERENCE]).toEqual([...LIGHTBOX_RENDITION_PREFERENCE])
  })

  it('falls back in order when a rendition is missing', () => {
    const thumbOnly = asset({ renditions: { thumbnail: asset().renditions.thumbnail } })
    expect(pickRendition(thumbOnly, GRID_RENDITION_PREFERENCE)?.rendition).toBe('thumbnail')
    expect(pickRendition(thumbOnly, LIGHTBOX_RENDITION_PREFERENCE)?.rendition).toBe('thumbnail')
  })

  it('returns null when nothing was stored, or a path is empty', () => {
    expect(pickRendition(asset({ renditions: {} }), GRID_RENDITION_PREFERENCE)).toBeNull()
    const broken = asset({ renditions: { medium: { path: '', size: 1, mimeType: 'image/jpeg', width: null, height: null } } })
    expect(pickRendition(broken, GRID_RENDITION_PREFERENCE)).toBeNull()
  })
})

// ═══════════════ What reaches the browser ═══════════════

const projected = () => toPublicPhoto({
  asset: asset(),
  url:      'https://cdn.example/medium/o1',
  largeUrl: 'https://cdn.example/original/o1',
  downloadUrl: '/api/public/events/kochi/photos/download?photoId=med_abc',
})

describe('toPublicPhoto', () => {
  it('returns EXACTLY the seven public fields', () => {
    expect(Object.keys(projected()).sort()).toEqual([
      'capturedAt', 'downloadUrl', 'height', 'largeUrl', 'photoId', 'url', 'width',
    ])
  })

  it('NEVER carries a storage key, a bucket or an object path', () => {
    const serialised = JSON.stringify(projected())
    expect(serialised).not.toContain('events/kochi-marathon-YYw3OU/photos')
    expect(serialised).not.toContain('r2')
    expect(serialised).not.toContain('cloudflare')
  })

  it('NEVER carries organizer or library metadata', () => {
    const view = projected() as unknown as Record<string, unknown>
    for (const field of [
      'organizerUid', 'eventId', 'galleryId', 'albumId', 'checksum', 'originalFilename',
      'renditions', 'bytesStored', 'uploadedBy', 'uploadedAt', 'visibility', 'profileId',
      'status',
    ]) {
      expect(view[field], field).toBeUndefined()
    }
  })

  it("NEVER leaks the uploader's original filename", () => {
    expect(JSON.stringify(projected())).not.toContain('DSC_0001')
  })

  it('reports the ORIGINAL dimensions — that is what a download delivers', () => {
    expect(projected().width).toBe(6000)
    expect(projected().height).toBe(4000)
  })

  it('reports capturedAt as null — the platform has never had one', () => {
    expect(projected().capturedAt).toBeNull()
  })

  it('points downloads at OUR route, never at storage', () => {
    expect(projected().downloadUrl.startsWith('/api/public/')).toBe(true)
  })
})

// ═══════════════ Gallery cards ═══════════════

describe('toPublicGallery', () => {
  it('publishes the PUBLIC count, never the gallery total', () => {
    // `assetCount` is 120 and counts every ready asset whatever its visibility. Publishing
    // it would misstate the gallery AND disclose how many photos are withheld.
    const card = toPublicGallery(gallery(), 30, 'https://cdn.example/cover')
    expect(card.photoCount).toBe(30)
    expect(card.photoCount).not.toBe(gallery().assetCount)
  })

  it('exposes a SLUG and never an id', () => {
    const card = toPublicGallery(gallery(), 30, null) as unknown as Record<string, unknown>
    expect(card.slug).toBe('finish-line')
    for (const field of ['galleryId', 'organizerUid', 'eventId', 'coverAssetId', 'preset']) {
      expect(card[field], field).toBeUndefined()
    }
  })
})

describe('withPublicPhotos', () => {
  const cards: PublicGallerySummary[] = [
    { slug: 'a', name: 'A', description: null, photoCount: 3, coverUrl: null },
    { slug: 'b', name: 'B', description: null, photoCount: 0, coverUrl: null },
    { slug: 'c', name: 'C', description: null, photoCount: 1, coverUrl: null },
  ]

  it('HIDES a gallery with no public photos entirely', () => {
    // An empty card would advertise that the gallery exists and its contents are withheld —
    // which the organizer did not publish.
    expect(withPublicPhotos(cards).map(g => g.slug)).toEqual(['a', 'c'])
  })

  it('an event with nothing published yields no galleries at all', () => {
    expect(withPublicPhotos([cards[1]])).toEqual([])
    expect(withPublicPhotos([])).toEqual([])
  })
})

// ═══════════════ Accessibility ═══════════════

describe('photoAltText', () => {
  it('describes the photo without inventing anything about it', () => {
    expect(photoAltText('Kochi Marathon', 'Finish Line', 0)).toBe('Kochi Marathon — Finish Line, photo 1')
  })

  it('is 1-based, matching what a visitor is told in the lightbox', () => {
    expect(photoAltText('E', 'G', 41)).toContain('photo 42')
  })
})
