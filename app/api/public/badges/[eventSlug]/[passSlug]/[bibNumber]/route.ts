// GET /api/public/badges/{eventSlug}/{passSlug}/{bibNumber}
// GET …?download=1   → forces a file download rather than inline display
//
// RD-BADGE-01. The participant's badge.
//
// PUBLIC by design — a finisher badge is a shareable achievement, and the data on it
// (name, bib, time, rank) is already published on the public leaderboard. Nothing
// organizer-only appears on the image or in this response.
//
// Generation is LAZY: the first request for a published result renders and stores the PNG;
// every later request serves the stored one. Rendering 20,000 badges eagerly at publish time
// would cost hours of compute for images most participants never open.
//
// It CANNOT serve a badge for an unpublished result: the service reads live snapshots only.

import { NextRequest, NextResponse } from 'next/server'
import { ensureBadge, readBadgeBytes } from '@/features/finisher-badges/services/badgeService'
import { isPlausibleBib } from '@/features/race-operations/utils/publicKeys'
import { BADGE_MIME } from '@/features/finisher-badges/types'

type Params = { params: Promise<{ eventSlug: string; passSlug: string; bibNumber: string }> }

/** Badges are immutable for a given snapshot version, so they cache hard. A corrected
 *  result bumps the snapshot version, which re-renders on the next request. */
const CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400'

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventSlug, passSlug, bibNumber } = await params
  const bib = decodeURIComponent(bibNumber)

  // Rejected before any read, so a junk or traversal-style URL costs zero database work.
  if (!isPlausibleBib(bib)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const outcome = await ensureBadge({ eventSlug, passSlug, bib })
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status })
  }

  const bytes = await readBadgeBytes(outcome.value.badge)
  if (!bytes) {
    return NextResponse.json({ error: 'The badge image is not available yet.' }, { status: 503 })
  }

  const download = new URL(req.url).searchParams.get('download') === '1'
  const filename = `${eventSlug}-${passSlug}-bib-${outcome.value.badge.bibNumber}.png`

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type':  BADGE_MIME,
      'Cache-Control': CACHE_CONTROL,
      'Content-Disposition': download
        ? `attachment; filename="${filename}"`
        : `inline; filename="${filename}"`,
    },
  })
}
