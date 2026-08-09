// GET /api/organizer/media-studio/storage?eventId=…
//
// The storage dashboard. Computed from GALLERY COUNTERS, not a scan — a 50,000-photo event
// costs a handful of reads. The counters are maintained transactionally with every asset
// write, which is what makes that safe.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia, resolveOwnedEvent } from '@/features/media-studio/services/authorize'
import { computeUsage } from '@/features/media-studio/repositories/settingsRepo'
import { isStorageReady } from '@/features/media-studio/services/uploadService'
import type { StorageUsageView } from '@/features/media-studio/types'

export interface StorageUsageResponse {
  usage:        StorageUsageView
  /** False when the deployment has no object-storage credentials — the UI says so plainly
   *  instead of showing an empty dashboard that looks like "no photos yet". */
  storageReady: boolean
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = new URL(req.url).searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const body: StorageUsageResponse = {
    usage:        await computeUsage(authz.workspaceUid, eventId),
    storageReady: isStorageReady(),
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
