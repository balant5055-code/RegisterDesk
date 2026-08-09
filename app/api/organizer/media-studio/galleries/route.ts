// GET  /api/organizer/media-studio/galleries?eventId=…   — galleries for one event
// POST /api/organizer/media-studio/galleries             — create one
//
// RD-MEDIA-01. Thin: authorize → resolve event → validate → repository → respond.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia, resolveOwnedEvent } from '@/features/media-studio/services/authorize'
import {
  createGallery, listGalleries, serializeGallery,
} from '@/features/media-studio/repositories/galleryRepo'
import { toSlug, uniqueSlug, validateDescription, validateName, isGalleryPreset, presetName } from '@/features/media-studio/utils/naming'
import type { GalleryView } from '@/features/media-studio/types'
import { checkCount, resolveMediaConfig } from '@/lib/config/resolveMediaConfig'

export interface GalleryListResponse   { galleries: GalleryView[] }
export interface GalleryCreateResponse { gallery: GalleryView }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = new URL(req.url).searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const docs = await listGalleries(authz.workspaceUid, eventId)
  const body: GalleryListResponse = { galleries: docs.map(serializeGallery) }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId = typeof raw.eventId === 'string' ? raw.eventId.trim() : ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const preset = isGalleryPreset(raw.preset) ? raw.preset : 'custom'
  // A preset gallery takes the preset's name unless the organizer supplied one.
  const nameInput = typeof raw.name === 'string' && raw.name.trim() !== ''
    ? raw.name
    : presetName(preset)

  const name = validateName(nameInput, 'Gallery name')
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })

  const description = validateDescription(raw.description)
  if (!description.ok) return NextResponse.json({ error: description.error }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  // RD-MEDIA-08 — how many galleries this event may hold. Event override → licence tier →
  // global default; this route knows none of those numbers.
  const limits = await resolveMediaConfig({
    organizerUid: authz.workspaceUid, eventId, eventSlug: event.event.eventSlug,
  })
  const existing = await listGalleries(authz.workspaceUid, eventId)
  const verdict = checkCount(existing.length, 1, limits.maxGalleriesPerEvent, 'galleries')
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status })

  // Slugs are unique per event, so two "Camera 1" galleries get camera-1 and camera-1-2.
  const taken = new Set(existing.map(g => g.slug))
  const slug  = uniqueSlug(toSlug(name.value, preset), taken)

  const gallery = await createGallery({
    organizerUid: authz.workspaceUid,
    eventId:      event.event.eventId,
    eventSlug:    event.event.eventSlug,
    name:         name.value,
    slug,
    preset,
    description:  description.value || null,
    createdBy:    authz.callerUid,
  })

  const body: GalleryCreateResponse = { gallery: serializeGallery(gallery) }
  return NextResponse.json(body, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}
