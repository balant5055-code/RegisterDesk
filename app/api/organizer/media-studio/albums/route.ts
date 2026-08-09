// GET  /api/organizer/media-studio/albums?galleryId=…  — albums in one gallery
// POST /api/organizer/media-studio/albums              — create one

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia } from '@/features/media-studio/services/authorize'
import {
  createAlbum, getOwnedGallery, listAlbums, serializeAlbum,
} from '@/features/media-studio/repositories/galleryRepo'
import { toSlug, uniqueSlug, validateDescription, validateName } from '@/features/media-studio/utils/naming'
import type { AlbumView } from '@/features/media-studio/types'
import { checkCount, resolveMediaConfig } from '@/lib/config/resolveMediaConfig'

export interface AlbumListResponse   { albums: AlbumView[] }
export interface AlbumCreateResponse { album: AlbumView }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const galleryId = new URL(req.url).searchParams.get('galleryId')?.trim() ?? ''
  if (!galleryId) return NextResponse.json({ error: 'galleryId is required' }, { status: 400 })

  // Tenant check on the PARENT before listing children.
  const gallery = await getOwnedGallery(galleryId, authz.workspaceUid)
  if (!gallery) return NextResponse.json({ error: 'Gallery not found' }, { status: 404 })

  const docs = await listAlbums(authz.workspaceUid, galleryId)
  const body: AlbumListResponse = { albums: docs.map(serializeAlbum) }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const galleryId = typeof raw.galleryId === 'string' ? raw.galleryId.trim() : ''
  if (!galleryId) return NextResponse.json({ error: 'galleryId is required' }, { status: 400 })

  const name = validateName(raw.name, 'Album name')
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })

  const description = validateDescription(raw.description)
  if (!description.ok) return NextResponse.json({ error: description.error }, { status: 400 })

  const gallery = await getOwnedGallery(galleryId, authz.workspaceUid)
  if (!gallery) return NextResponse.json({ error: 'Gallery not found' }, { status: 404 })

  // RD-MEDIA-08 — how many albums this gallery may hold.
  const limits = await resolveMediaConfig({
    organizerUid: authz.workspaceUid,
    eventId:      gallery.eventId,
    eventSlug:    gallery.eventSlug,
  })
  const siblings = await listAlbums(authz.workspaceUid, galleryId)
  const verdict = checkCount(siblings.length, 1, limits.maxAlbumsPerGallery, 'albums per gallery')
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status })

  const taken = new Set(siblings.map(a => a.slug))
  const slug  = uniqueSlug(toSlug(name.value, 'album'), taken)

  const album = await createAlbum({
    organizerUid: authz.workspaceUid,
    eventId:      gallery.eventId,
    eventSlug:    gallery.eventSlug,
    galleryId,
    name:         name.value,
    slug,
    description:  description.value || null,
    createdBy:    authz.callerUid,
  })

  const body: AlbumCreateResponse = { album: serializeAlbum(album) }
  return NextResponse.json(body, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}
