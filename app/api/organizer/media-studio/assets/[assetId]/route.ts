// PATCH  /api/organizer/media-studio/assets/[assetId]  — move and/or publish
// DELETE /api/organizer/media-studio/assets/[assetId]
//
// RD-MEDIA-04 added PATCH. Before it, a photo's gallery, album and visibility were fixed at
// upload forever: an organizer who filed a photo in the wrong gallery had to delete and
// re-upload it, and one who uploaded a gallery as PUBLIC had no way to withdraw it.
//
// Two-step by design: the record is marked deleted and its counters reversed FIRST (one
// transaction), then the objects are removed from storage best-effort. Deleting the record
// last would risk stranding objects with no way to find them; this order can at worst leave
// an orphaned object, which is recoverable.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia } from '@/features/media-studio/services/authorize'
import {
  getOwnedAsset, markAssetDeleted, moveAsset, setAssetVisibility,
} from '@/features/media-studio/repositories/assetRepo'
import { resolveRenditionUrl } from '@/features/media-studio/services/uploadService'
import { serializeAsset } from '@/features/media-studio/repositories/assetRepo'
import { isAssignableVisibility, type MediaAssetView } from '@/features/media-studio/types'
import { removeObjects } from '@/features/media-studio/services/uploadService'
import { deleteLinksForAsset } from '@/features/bib-detection/repositories/photoBibLinkRepo'

type Params = { params: Promise<{ assetId: string }> }

export interface AssetDeleteResponse {
  deleted:        boolean
  objectsRemoved: number
  objectsFailed:  number
  /** RD-BIB-01 — bib links removed alongside the photo. */
  linksRemoved:   number
}

export interface AssetPatchResponse { asset: MediaAssetView }

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { assetId } = await params

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const wantsMove       = 'galleryId' in raw || 'albumId' in raw
  const wantsVisibility = 'visibility' in raw
  if (!wantsMove && !wantsVisibility) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  // Ownership, the destination's tenant and event, and the asset's readiness are all
  // re-checked INSIDE the repository transaction — this route validates shape only.
  if (wantsMove) {
    const existing = await getOwnedAsset(assetId, authz.workspaceUid)
    if (!existing) return NextResponse.json({ error: 'Photo not found' }, { status: 404 })

    const toGalleryId = typeof raw.galleryId === 'string' && raw.galleryId.trim() !== ''
      ? raw.galleryId.trim() : existing.galleryId
    const toAlbumId = 'albumId' in raw
      ? (typeof raw.albumId === 'string' && raw.albumId.trim() !== '' ? raw.albumId.trim() : null)
      : existing.albumId

    const moved = await moveAsset({
      assetId, organizerUid: authz.workspaceUid, toGalleryId, toAlbumId,
    })
    if (!moved.ok) return NextResponse.json({ error: moved.error }, { status: moved.status })
  }

  if (wantsVisibility) {
    if (!isAssignableVisibility(raw.visibility)) {
      return NextResponse.json(
        { error: 'visibility must be PUBLIC, PRIVATE or SIGNED_URL.' },
        { status: 400 },
      )
    }
    const published = await setAssetVisibility({
      assetId, organizerUid: authz.workspaceUid, visibility: raw.visibility,
    })
    if (!published.ok) {
      return NextResponse.json({ error: published.error }, { status: published.status })
    }
  }

  // Re-read rather than trusting the in-memory result: a move and a visibility change in one
  // request are two transactions, and the response must reflect both.
  const updated = await getOwnedAsset(assetId, authz.workspaceUid)
  if (!updated) return NextResponse.json({ error: 'Photo not found' }, { status: 404 })

  const thumb = updated.renditions.thumbnail ?? updated.renditions.medium ?? updated.renditions.original
  const thumbnailUrl = thumb ? await resolveRenditionUrl(thumb.path, updated.visibility) : null

  const body: AssetPatchResponse = { asset: serializeAsset(updated, thumbnailUrl) }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { assetId } = await params

  const existing = await getOwnedAsset(assetId, authz.workspaceUid)
  if (!existing) return NextResponse.json({ error: 'Photo not found' }, { status: 404 })

  const outcome = await markAssetDeleted(assetId)
  if (!outcome.ok) return NextResponse.json({ error: 'Photo not found' }, { status: 404 })

  const { removed, failed } = await removeObjects(outcome.paths)

  // RD-BIB-01: a link points at a photograph. Once the photograph is gone the link asserts
  // something about an image that no longer exists, so it goes with it. FAIL-SOFT — a photo
  // the organizer asked to delete must be reported as deleted even if cleanup stumbles.
  let linksRemoved = 0
  try {
    linksRemoved = await deleteLinksForAsset(assetId)
  } catch (err) {
    console.error('[media-studio/assets] bib link cleanup failed:', { assetId, err })
  }

  const body: AssetDeleteResponse = {
    deleted: true, objectsRemoved: removed, objectsFailed: failed, linksRemoved,
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
