// GET    /api/organizer/media-studio/branding?eventId=   — current overlay
// POST   /api/organizer/media-studio/branding            — decide, prepare an upload, or finalise one
// PATCH  /api/organizer/media-studio/branding            — enable / disable
// DELETE /api/organizer/media-studio/branding?eventId=   — remove
//
// RD-PHOTO-01. NOT a licensing feature — every organizer with the existing `events`
// permission can use it. `authorizeMedia` is the same gate the rest of Media Studio uses;
// nothing here consults a tier.
//
// Upload is the platform's established two-step: `POST {action:'prepare'}` returns a signed
// PUT, the browser sends the bytes straight to storage, then `POST {action:'complete'}`
// records it with the size read FROM the bucket. No byte passes through this route.
//
// RD-PHOTO-03: every mutation is additionally gated by the BRANDING LOCK. Branding is now
// baked into pixels at import time, so an event that already holds photos cannot change it
// without re-importing. That is refused here, on the server — not merely disabled in the UI.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia, resolveOwnedEvent } from '@/features/media-studio/services/authorize'
import {
  getBrandingLock, getBrandingState, getBrandingWorkflow, prepareOverlayUpload, removeOverlay,
  saveOverlay, setBrandingIntent, setEnabled,
} from '@/features/photo-branding/services/brandingService'
import { isBlockedByLock, type BrandingMutation } from '@/features/photo-branding/utils/brandingLock'
import type { BrandingLock } from '@/features/photo-branding/utils/brandingLock'
import { isBrandingIntent, type BrandingWorkflow } from '@/features/photo-branding/utils/brandingIntent'
import type { BrandingState } from '@/features/photo-branding/types'

/**
 * RD-PHOTO-03: the state AND whether it may still be changed.
 *
 * Returned together so the page never has to infer "can I edit this?" from a photo count it
 * fetched separately — the button's enabled state and the server's answer come from one
 * field.
 */
export type BrandingResponse = BrandingState & { lock: BrandingLock; workflow: BrandingWorkflow }
export interface BrandingPrepareResponse { path: string; uploadUrl: string }

const NO_STORE = { 'Cache-Control': 'no-store' }

async function brandingBody(organizerUid: string, eventId: string): Promise<BrandingResponse> {
  const [state, lock, workflow] = await Promise.all([
    getBrandingState(organizerUid, eventId),
    getBrandingLock(organizerUid, eventId),
    getBrandingWorkflow(organizerUid, eventId),
  ])
  return { ...state, lock, workflow }
}

/**
 * The lock is enforced HERE, on the server, for every mutation.
 *
 * "Do not silently allow changes" is the requirement: a disabled button is a courtesy, not
 * a control. 409 Conflict, because the request is well-formed and the caller is authorized
 * — the event's state is what refuses it.
 */
async function refusedByLock(
  organizerUid: string, eventId: string, mutation: BrandingMutation,
): Promise<NextResponse | null> {
  const lock = await getBrandingLock(organizerUid, eventId)
  if (!isBlockedByLock(lock, mutation)) return null
  return NextResponse.json({ error: lock.reason, lock }, { status: 409, headers: NO_STORE })
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  return NextResponse.json(await brandingBody(authz.workspaceUid, eventId), { headers: NO_STORE })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId = typeof raw.eventId === 'string' ? raw.eventId.trim() : ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  // ── RD-PHOTO-04: record the per-event decision ──
  // Asked ONCE, before the first import. This is the gate that stops an organizer
  // importing thousands of photos and only then learning branding is unavailable.
  if (raw.action === 'decide') {
    if (!isBrandingIntent(raw.intent)) {
      return NextResponse.json(
        { error: "intent must be 'branded' or 'unbranded'" }, { status: 400 })
    }
    const blocked = await refusedByLock(authz.workspaceUid, eventId, 'enable')
    if (blocked) return blocked

    await setBrandingIntent(authz.workspaceUid, eventId, raw.intent)
    return NextResponse.json(await brandingBody(authz.workspaceUid, eventId), { headers: NO_STORE })
  }

  // ── Step 1: authorize an upload ──
  if (raw.action === 'prepare') {
    // Refused before any signed URL exists, so a locked event never receives an upload
    // capability at all.
    const blocked = await refusedByLock(authz.workspaceUid, eventId, 'upload')
    if (blocked) return blocked

    const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : ''
    const bytes    = typeof raw.bytes === 'number' ? Math.floor(raw.bytes) : NaN
    if (!mimeType || !Number.isFinite(bytes) || bytes <= 0) {
      return NextResponse.json({ error: 'mimeType and a positive size are required.' }, { status: 400 })
    }

    const outcome = await prepareOverlayUpload({
      eventSlug: event.event.eventSlug, mimeType, bytes,
    })
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

    const body: BrandingPrepareResponse = { path: outcome.path, uploadUrl: outcome.uploadUrl }
    return NextResponse.json(body, { headers: NO_STORE })
  }

  // ── Step 2: record what actually landed ──
  if (raw.action === 'complete') {
    // Checked again: photos could have been imported between prepare and complete.
    const blocked = await refusedByLock(authz.workspaceUid, eventId, 'upload')
    if (blocked) return blocked

    const path   = typeof raw.path === 'string' ? raw.path : ''
    const width  = typeof raw.width === 'number' ? Math.floor(raw.width) : 0
    const height = typeof raw.height === 'number' ? Math.floor(raw.height) : 0

    if (!path) return NextResponse.json({ error: 'path is required' }, { status: 400 })
    // The key must sit under THIS event's prefix. A signed URL is scoped to one key, but
    // this stops a caller recording someone else's object as their branding.
    if (!path.startsWith(`events/${event.event.eventSlug}/branding/`)) {
      return NextResponse.json({ error: 'That artwork does not belong to this event.' }, { status: 400 })
    }
    if (width <= 0 || height <= 0) {
      return NextResponse.json({ error: 'Artwork dimensions are required.' }, { status: 400 })
    }

    const saved = await saveOverlay({
      organizerUid: authz.workspaceUid,
      eventId, path, width, height,
      uploadedBy: authz.callerUid,
    })
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status })

    // Uploading artwork IS choosing branding. Recording it here means an organizer who
    // came via "Use Photo Branding" is never asked the same question twice.
    await setBrandingIntent(authz.workspaceUid, eventId, 'branded')

    return NextResponse.json(await brandingBody(authz.workspaceUid, eventId), { status: 201, headers: NO_STORE })
  }

  return NextResponse.json(
    { error: "action must be 'decide', 'prepare' or 'complete'" }, { status: 400 })
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId = typeof raw.eventId === 'string' ? raw.eventId.trim() : ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })
  if (typeof raw.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 })
  }

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const blocked = await refusedByLock(authz.workspaceUid, eventId, 'enable')
  if (blocked) return blocked

  const changed = await setEnabled(authz.workspaceUid, eventId, raw.enabled)
  if (!changed) return NextResponse.json({ error: 'No branding artwork to change.' }, { status: 404 })

  return NextResponse.json(await brandingBody(authz.workspaceUid, eventId), { headers: NO_STORE })
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const blocked = await refusedByLock(authz.workspaceUid, eventId, 'remove')
  if (blocked) return blocked

  await removeOverlay(authz.workspaceUid, eventId)

  return NextResponse.json(await brandingBody(authz.workspaceUid, eventId), { headers: NO_STORE })
}
