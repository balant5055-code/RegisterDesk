// GET /api/organizer/media-studio/limits?eventId=
//
// RD-MEDIA-08. The EFFECTIVE limits for one event, plus which layer supplied each value.
//
// The organizer UI displays what this returns and computes nothing. That is the whole point
// of the sprint: one resolver decides, the API reports, the page renders. A limit shown to an
// organizer and a limit enforced at upload can no longer disagree, because they are the same
// call.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia, resolveOwnedEvent } from '@/features/media-studio/services/authorize'
import { readEventPhotoCapacity } from '@/features/media-studio/services/photoCapacityGate'
import { increaseLimitHref } from '@/lib/wallet/purchaseIntent'
import { listGalleries } from '@/features/media-studio/repositories/galleryRepo'
import {
  resolveMediaConfig, type MediaLimitProvenance,
} from '@/lib/config/resolveMediaConfig'
import type { EventLicenseTierV2 } from '@/lib/licensing/eventLicense'

export interface MediaLimitsResponse {
  /** The licence tier the plan layer was read from; null ⇒ the global layer applied. */
  tier: EventLicenseTierV2 | null

  limits: {
    /**
     * RD-PHOTO-01 — the event's PAID photo capacity (0 until photo capacity is bought on License &
     * Services; at most MAX_EVENT_PHOTO_CAPACITY). Never null: there is no unlimited/free photo tier.
     */
    maxPhotosPerEvent:      number
    maxUploadBatchSize:     number
    maxUploadFileSizeBytes: number
    maxGalleriesPerEvent:   number
    maxAlbumsPerGallery:    number
  }

  defaults: {
    defaultCompressionProfileId: string
    generateThumbnail:      boolean
    generateMedium:         boolean
    keepOriginal:           boolean
    defaultVisibility:      'PUBLIC' | 'SIGNED_URL'
    signedUrlExpirySeconds: number
    publicGalleryEnabled:   boolean
  }

  /** What the event has used, so the UI can show headroom rather than only a ceiling. */
  used: {
    /** Photos occupying paid capacity: stored + in-flight uploads (the number the upload gate counts). */
    photos:    number
    galleries: number
  }

  /** RD-PHOTO-01 — the event's paid photo capacity, exactly as the upload gate enforces it. */
  photoCapacity: {
    capacity:      number
    used:          number
    stored:        number
    inFlight:      number
    remaining:     number
    max:           number
    maxAdditional: number
    /** The ONE place photo capacity is bought: this event's License & Services step. */
    purchaseHref:  string
  }

  /** Which layer each value came from — 'event' | 'plan' | 'global'. */
  source: MediaLimitProvenance
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const [config, photo, galleries] = await Promise.all([
    resolveMediaConfig({
      organizerUid: authz.workspaceUid,
      eventId:      event.event.eventId,
      eventSlug:    event.event.eventSlug,
    }),
    readEventPhotoCapacity(authz.workspaceUid, event.event.eventId),
    listGalleries(authz.workspaceUid, event.event.eventId),
  ])

  const body: MediaLimitsResponse = {
    tier: config.tier,
    limits: {
      maxPhotosPerEvent:      photo.capacity,
      maxUploadBatchSize:     config.maxUploadBatchSize,
      maxUploadFileSizeBytes: config.maxUploadFileSizeBytes,
      maxGalleriesPerEvent:   config.maxGalleriesPerEvent,
      maxAlbumsPerGallery:    config.maxAlbumsPerGallery,
    },
    defaults: {
      defaultCompressionProfileId: config.defaultCompressionProfileId,
      generateThumbnail:      config.generateThumbnail,
      generateMedium:         config.generateMedium,
      keepOriginal:           config.keepOriginal,
      defaultVisibility:      config.defaultVisibility,
      signedUrlExpirySeconds: config.signedUrlExpirySeconds,
      publicGalleryEnabled:   config.publicGalleryEnabled,
    },
    used: { photos: photo.used, galleries: galleries.length },
    photoCapacity: { ...photo, purchaseHref: increaseLimitHref(event.event.eventId, 'media') },
    source: config.source,
  }

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
