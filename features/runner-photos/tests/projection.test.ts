// RD-RUNNER-01 — the public projection.
//
// This is the boundary between a machine's guess about a person and that person's browser.
// It is kept pure and outside the service precisely so it can be proven here, rather than
// inferred from a Firestore trace (the lesson of Sprint 4's `toPublicRace`).

import { describe, it, expect } from 'vitest'
import {
  DISPLAY_RENDITION_PREFERENCE, DOWNLOAD_RENDITION_PREFERENCE, UNKNOWN_GALLERY_NAME,
  isServableAsset, isVisibleLink, pickRendition, toRunnerPhoto,
} from '@/features/runner-photos/utils/projection'
import { BIB_SCHEMA_VERSION, type PhotoBibLinkDoc } from '@/features/bib-detection/types'
import { MEDIA_SCHEMA_VERSION, type MediaAssetDoc } from '@/features/media-studio/types'

const link = (over: Partial<PhotoBibLinkDoc> = {}): PhotoBibLinkDoc => ({
  linkId: 'med_abc__137', schemaVersion: BIB_SCHEMA_VERSION,
  organizerUid: 'org_1', eventId: 'evt_1', eventSlug: 'kochi-marathon-YYw3OU',
  assetId: 'med_abc', galleryId: 'gal_1', albumId: null,
  bibNumber: '137', bibKey: '137', confidence: 0.82,
  boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
  provider: 'fake', modelVersion: 'v1', pipelineVersion: 1,
  jobId: 'med_abc__bib-detect', resultId: 'med_abc__bib-detect',
  matchStatus: 'matched',
  candidates: [{ passId: '10k', passSlug: '10-km', passName: '10 KM', snapshotVersion: 2 }],
  snapshotVersion: 2,
  reviewStatus: 'pending', reviewedBy: null, reviewedAt: null,
  detectedAt: null, createdAt: null, updatedAt: null,
  ...over,
})

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

// ═══════════════ Which links a participant may see ═══════════════

describe('isVisibleLink', () => {
  it('shows a matched link that a human has APPROVED', () => {
    expect(isVisibleLink(link({ reviewStatus: 'verified' }), BIB_SCHEMA_VERSION)).toBe(true)
  })

  it('WITHHOLDS an unreviewed match — the architecture-review requirement', () => {
    // A pending link is a machine's unreviewed guess about which human is in a photograph.
    // Getting it wrong shows one runner another runner's picture, and there is no undo for
    // having shown it. Nothing reaches a participant until a person says so.
    expect(isVisibleLink(link({ reviewStatus: 'pending' }), BIB_SCHEMA_VERSION)).toBe(false)
  })

  it('is an ALLOW-LIST — an unrecognised review status is withheld, not admitted', () => {
    // A deny-list ("hide rejected") silently admits every status anyone adds later.
    const exotic = link({ reviewStatus: 'escalated' as never })
    expect(isVisibleLink(exotic, BIB_SCHEMA_VERSION)).toBe(false)
  })

  it('NEVER shows an ambiguous link, even once approved', () => {
    // Two races in one event both have a bib 137 and the pipeline refused to guess. Showing
    // it to every candidate would hand a runner a stranger's photograph. An approval cannot
    // resolve which of two people it is.
    expect(isVisibleLink(link({ matchStatus: 'ambiguous', reviewStatus: 'verified' }), BIB_SCHEMA_VERSION)).toBe(false)
  })

  it('never shows an unmatched link — there is no runner to show it to', () => {
    expect(isVisibleLink(link({ matchStatus: 'unmatched', reviewStatus: 'verified' }), BIB_SCHEMA_VERSION)).toBe(false)
  })

  it('HONOURS an organizer rejection — a takedown wins over anything a model said', () => {
    expect(isVisibleLink(link({ reviewStatus: 'rejected' }), BIB_SCHEMA_VERSION)).toBe(false)
  })

  it('withholds EVERY status except verified', () => {
    for (const reviewStatus of ['pending', 'rejected'] as const) {
      expect(isVisibleLink(link({ reviewStatus }), BIB_SCHEMA_VERSION), reviewStatus).toBe(false)
    }
    expect(isVisibleLink(link({ reviewStatus: 'verified' }), BIB_SCHEMA_VERSION)).toBe(true)
  })

  it('TODAY that means nothing is visible — no review UI exists, so nothing is approved', () => {
    // The honest consequence of the approved-only rule, pinned so it is a decision rather
    // than a surprise. It changes the day a review workflow ships.
    const asDetected = link()   // exactly what RD-BIB-01 writes: reviewStatus 'pending'
    expect(asDetected.reviewStatus).toBe('pending')
    expect(isVisibleLink(asDetected, BIB_SCHEMA_VERSION)).toBe(false)
  })

  it('refuses a document written by an unknown schema version', () => {
    expect(isVisibleLink(link({ schemaVersion: 99, reviewStatus: 'verified' }), BIB_SCHEMA_VERSION)).toBe(false)
    expect(isVisibleLink(link({ schemaVersion: 0,  reviewStatus: 'verified' }), BIB_SCHEMA_VERSION)).toBe(false)
  })

  it('ignores confidence entirely — approval is a human decision, not a score', () => {
    // A confidence threshold would hide correct matches AND admit confident wrong ones.
    for (const confidence of [0, 0.01, 0.5, 0.99, 1]) {
      const approved = link({ confidence, reviewStatus: 'verified' })
      expect(isVisibleLink(approved, BIB_SCHEMA_VERSION), String(confidence)).toBe(true)
    }
  })
})

// ═══════════════ Which assets may be served ═══════════════

describe('isServableAsset', () => {
  it('serves a ready, non-private asset', () => {
    expect(isServableAsset(asset(), link(), MEDIA_SCHEMA_VERSION)).toBe(true)
  })

  it('serves nothing for a DELETED photo', () => {
    // The links are removed with the asset, but a soft-deleted record must never resolve
    // even if one survived.
    expect(isServableAsset(asset({ status: 'deleted' }), link(), MEDIA_SCHEMA_VERSION)).toBe(false)
  })

  it('serves nothing for a missing asset — an INVALID LINK resolves to nothing', () => {
    expect(isServableAsset(undefined, link(), MEDIA_SCHEMA_VERSION)).toBe(false)
  })

  it('refuses a photo that never finished uploading', () => {
    expect(isServableAsset(asset({ status: 'pending' }), link(), MEDIA_SCHEMA_VERSION)).toBe(false)
    expect(isServableAsset(asset({ status: 'failed' }),  link(), MEDIA_SCHEMA_VERSION)).toBe(false)
  })

  it('refuses a PRIVATE photo — the organizer withheld it', () => {
    expect(isServableAsset(asset({ visibility: 'PRIVATE' }), link(), MEDIA_SCHEMA_VERSION)).toBe(false)
  })

  it('serves a SIGNED_URL photo — that is the normal gated case', () => {
    expect(isServableAsset(asset({ visibility: 'SIGNED_URL' }), link(), MEDIA_SCHEMA_VERSION)).toBe(true)
  })

  it('CROSS-CHECKS the tenant — a data fault must not become a disclosure', () => {
    expect(isServableAsset(asset({ organizerUid: 'org_2' }), link(), MEDIA_SCHEMA_VERSION)).toBe(false)
  })

  it('cross-checks the event', () => {
    expect(isServableAsset(asset({ eventSlug: 'another-event' }), link(), MEDIA_SCHEMA_VERSION)).toBe(false)
  })

  it('refuses an unknown schema version', () => {
    expect(isServableAsset(asset({ schemaVersion: 99 }), link(), MEDIA_SCHEMA_VERSION)).toBe(false)
  })
})

// ═══════════════ Rendition choice ═══════════════

describe('pickRendition', () => {
  it('shows the medium and downloads the original', () => {
    expect(pickRendition(asset(), DISPLAY_RENDITION_PREFERENCE)?.rendition).toBe('medium')
    expect(pickRendition(asset(), DOWNLOAD_RENDITION_PREFERENCE)?.rendition).toBe('original')
  })

  it('falls back in order when a rendition is missing', () => {
    const noMedium = asset({ renditions: { thumbnail: asset().renditions.thumbnail } })
    expect(pickRendition(noMedium, DISPLAY_RENDITION_PREFERENCE)?.rendition).toBe('thumbnail')
    expect(pickRendition(noMedium, DOWNLOAD_RENDITION_PREFERENCE)?.rendition).toBe('thumbnail')
  })

  it('returns null when nothing was stored', () => {
    expect(pickRendition(asset({ renditions: {} }), DISPLAY_RENDITION_PREFERENCE)).toBeNull()
  })

  it('never returns a rendition whose path is empty', () => {
    const broken = asset({ renditions: { medium: { path: '', size: 1, mimeType: 'image/jpeg', width: null, height: null } } })
    expect(pickRendition(broken, DISPLAY_RENDITION_PREFERENCE)).toBeNull()
  })
})

// ═══════════════ What actually reaches the browser ═══════════════

const projected = () => toRunnerPhoto({
  link: link(), asset: asset(),
  galleryName: 'Finish Line',
  thumbnailUrl: 'https://signed.example/medium?X-Amz-Signature=abc',
  downloadUrl:  '/api/attendee/photos/download?photoId=med_abc__137',
})

describe('toRunnerPhoto', () => {
  it('returns EXACTLY the seven public fields, and nothing else', () => {
    expect(Object.keys(projected()).sort()).toEqual([
      'capturedAt', 'downloadUrl', 'galleryName', 'photoId',
      'thumbnailUrl', 'uploadedAt', 'width', 'height',
    ].sort())
  })

  it('NEVER carries a storage key, a bucket or an object path', () => {
    const serialised = JSON.stringify(projected())
    expect(serialised).not.toContain('events/kochi-marathon-YYw3OU/photos')
    expect(serialised).not.toContain('original/o1')
    expect(serialised).not.toContain('r2')
    expect(serialised).not.toContain('cloudflare')
  })

  it('NEVER carries organizer or pipeline metadata', () => {
    const view = projected() as unknown as Record<string, unknown>
    for (const field of [
      'organizerUid', 'eventId', 'assetId', 'galleryId', 'albumId', 'jobId', 'resultId',
      'confidence', 'boundingBox', 'provider', 'modelVersion', 'reviewStatus', 'matchStatus',
      'candidates', 'snapshotVersion', 'checksum', 'originalFilename', 'renditions',
      'bytesStored', 'uploadedBy',
    ]) {
      expect(view[field], field).toBeUndefined()
    }
  })

  it('NEVER leaks the uploader\'s original filename', () => {
    expect(JSON.stringify(projected())).not.toContain('DSC_0001')
  })

  it('carries the link id as an opaque handle', () => {
    expect(projected().photoId).toBe('med_abc__137')
  })

  it('reports capturedAt as null — the platform has never had one', () => {
    // EXIF is discarded by the browser-side re-encode. Substituting the upload time would
    // be a small lie repeated thousands of times.
    expect(projected().capturedAt).toBeNull()
  })

  it('reports the upload time separately, as an ISO string', () => {
    expect(projected().uploadedAt).toBe('2026-07-01T10:00:00.000Z')
  })

  it('survives a missing or malformed timestamp instead of throwing', () => {
    for (const uploadedAt of [undefined, null, 42, {}, 'not-a-date']) {
      expect(() => toRunnerPhoto({
        link: link(), asset: asset({ uploadedAt }),
        galleryName: 'x', thumbnailUrl: 'u', downloadUrl: 'd',
      })).not.toThrow()
    }
  })

  it('reports the ORIGINAL dimensions — that is what a download will be', () => {
    const view = projected()
    expect(view.width).toBe(6000)
    expect(view.height).toBe(4000)
  })

  it('uses a neutral label when the gallery was deleted', () => {
    const view = toRunnerPhoto({
      link: link(), asset: asset(),
      galleryName: UNKNOWN_GALLERY_NAME, thumbnailUrl: 'u', downloadUrl: 'd',
    })
    expect(view.galleryName).toBe('Race photos')
  })

  it('points downloads at OUR route, never at storage', () => {
    expect(projected().downloadUrl.startsWith('/api/attendee/photos/download')).toBe(true)
  })
})

// ═══════════════ Zero, one, many ═══════════════

describe('the shapes a gallery can be in', () => {
  const project = (n: number) =>
    Array.from({ length: n }, (_, i) => toRunnerPhoto({
      link: link({ linkId: `med_${i}__137`, assetId: `med_${i}` }),
      asset: asset({ assetId: `med_${i}` }),
      galleryName: 'Finish Line', thumbnailUrl: `u${i}`, downloadUrl: `d${i}`,
    }))

  it('zero photos projects to an empty list', () => {
    expect(project(0)).toEqual([])
  })

  it('one photo projects to one', () => {
    expect(project(1)).toHaveLength(1)
  })

  it('many photos keep distinct handles', () => {
    const many = project(250)
    expect(many).toHaveLength(250)
    expect(new Set(many.map(p => p.photoId)).size).toBe(250)
  })

  it('a page of links containing hidden ones yields only the visible', () => {
    const links = [
      link({ linkId: 'a__137', reviewStatus: 'verified' }),
      link({ linkId: 'b__137', matchStatus: 'ambiguous', reviewStatus: 'verified' }),
      link({ linkId: 'c__137', reviewStatus: 'rejected' }),
      link({ linkId: 'd__137', matchStatus: 'unmatched', reviewStatus: 'verified' }),
      link({ linkId: 'e__137', reviewStatus: 'verified' }),
      link({ linkId: 'f__137', reviewStatus: 'pending' }),
    ]
    const visible = links.filter(l => isVisibleLink(l, BIB_SCHEMA_VERSION))
    expect(visible.map(l => l.linkId)).toEqual(['a__137', 'e__137'])
  })
})
