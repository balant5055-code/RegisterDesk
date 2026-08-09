// PATCH  /api/organizer/media-studio/galleries/[galleryId]  — rename / re-describe
// DELETE /api/organizer/media-studio/galleries/[galleryId]  — empty galleries only
//
// Delete refuses a non-empty gallery on purpose: cascading would orphan objects in storage
// that the transaction cannot reach, leaving an invisible bill.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia } from '@/features/media-studio/services/authorize'
import {
  deleteEmptyGallery, getOwnedGallery, serializeGallery, takenGallerySlugs, updateGallery,
} from '@/features/media-studio/repositories/galleryRepo'
import { toSlug, uniqueSlug, validateDescription, validateName } from '@/features/media-studio/utils/naming'
import type { GalleryView } from '@/features/media-studio/types'

type Params = { params: Promise<{ galleryId: string }> }

export interface GalleryPatchResponse { gallery: GalleryView }

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { galleryId } = await params
  const existing = await getOwnedGallery(galleryId, authz.workspaceUid)
  if (!existing) return NextResponse.json({ error: 'Gallery not found' }, { status: 404 })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const patch: Record<string, unknown> = {}

  if ('name' in raw) {
    const name = validateName(raw.name, 'Gallery name')
    if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })
    patch.name = name.value
    if (name.value !== existing.name) {
      const taken = await takenGallerySlugs(authz.workspaceUid, existing.eventId)
      taken.delete(existing.slug)
      patch.slug = uniqueSlug(toSlug(name.value, existing.preset), taken)
    }
  }

  if ('description' in raw) {
    const description = validateDescription(raw.description)
    if (!description.ok) return NextResponse.json({ error: description.error }, { status: 400 })
    patch.description = description.value || null
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  await updateGallery(galleryId, patch)
  const updated = await getOwnedGallery(galleryId, authz.workspaceUid)
  if (!updated) return NextResponse.json({ error: 'Gallery not found' }, { status: 404 })

  const body: GalleryPatchResponse = { gallery: serializeGallery(updated) }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { galleryId } = await params
  const existing = await getOwnedGallery(galleryId, authz.workspaceUid)
  if (!existing) return NextResponse.json({ error: 'Gallery not found' }, { status: 404 })

  const outcome = await deleteEmptyGallery(galleryId)
  if (!outcome.ok) return NextResponse.json({ error: outcome.reason }, { status: 409 })

  return NextResponse.json({ deleted: true }, { headers: { 'Cache-Control': 'no-store' } })
}
