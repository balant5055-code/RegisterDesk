// PATCH  /api/organizer/media-studio/albums/[albumId]
// DELETE /api/organizer/media-studio/albums/[albumId]   — empty albums only

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia } from '@/features/media-studio/services/authorize'
import {
  deleteEmptyAlbum, getOwnedAlbum, serializeAlbum, takenAlbumSlugs, updateAlbum,
} from '@/features/media-studio/repositories/galleryRepo'
import { toSlug, uniqueSlug, validateDescription, validateName } from '@/features/media-studio/utils/naming'
import type { AlbumView } from '@/features/media-studio/types'

type Params = { params: Promise<{ albumId: string }> }

export interface AlbumPatchResponse { album: AlbumView }

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { albumId } = await params
  const existing = await getOwnedAlbum(albumId, authz.workspaceUid)
  if (!existing) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const patch: Record<string, unknown> = {}

  if ('name' in raw) {
    const name = validateName(raw.name, 'Album name')
    if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })
    patch.name = name.value
    if (name.value !== existing.name) {
      const taken = await takenAlbumSlugs(authz.workspaceUid, existing.galleryId)
      taken.delete(existing.slug)
      patch.slug = uniqueSlug(toSlug(name.value, 'album'), taken)
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

  await updateAlbum(albumId, patch)
  const updated = await getOwnedAlbum(albumId, authz.workspaceUid)
  if (!updated) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

  const body: AlbumPatchResponse = { album: serializeAlbum(updated) }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { albumId } = await params
  const existing = await getOwnedAlbum(albumId, authz.workspaceUid)
  if (!existing) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

  const outcome = await deleteEmptyAlbum(albumId)
  if (!outcome.ok) return NextResponse.json({ error: outcome.reason }, { status: 409 })

  return NextResponse.json({ deleted: true }, { headers: { 'Cache-Control': 'no-store' } })
}
