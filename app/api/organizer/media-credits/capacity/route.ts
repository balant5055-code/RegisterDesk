// GET /api/organizer/media-credits/capacity — RETIRED (RD-PHOTO-01, 2026-10-06).
//
// This reported how many organizer-level Media Credits could still be bought for an event, bounded by
// the legacy `maxPhotosPerEvent` (e.g. 500). Both concepts are gone: an event's photo capacity is the
// PAID units bought on its License & Services step (at most 3,000), reported by
// GET /api/organizer/media-studio/limits. Kept as an explicit 410 so an old client gets an answer
// instead of a ceiling that no longer exists.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Still authorized like every organizer route (moderation seam), even though it now returns nothing.
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  return NextResponse.json({
    error: 'Media Credits are no longer sold. Photo capacity is purchased per event on License & Services (up to 3,000 photos).',
    code: 'MEDIA_CREDITS_RETIRED',
  }, { status: 410, headers: { 'Cache-Control': 'no-store' } })
}
