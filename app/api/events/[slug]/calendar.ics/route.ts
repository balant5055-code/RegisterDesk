// GET /api/events/[slug]/calendar.ics
//
// Returns a RFC5545-compliant .ics file for the given published event.
// Works for all event types; no authentication required.
//
// Cache: 5 minutes (max-age=300) — matches the ISR revalidate on the event page.

import { NextResponse }    from 'next/server'
import { getEventBySlug }  from '@/lib/firebase/firestore/events'
import { canExposePublicEvent } from '@/lib/events/publicVisibility'
import { generateIcs }     from '@/lib/calendar/ics'
import type { EventDetailsDraft } from '@/components/wizard/eventDetailsConfig'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params

  const event = await getEventBySlug(slug)
  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  // Only serve ICS for publicly-visible events (shared allow-list)
  if (!canExposePublicEvent(event.lifecycleStatus)) {
    return NextResponse.json({ error: 'Event not available' }, { status: 404 })
  }

  const ed       = event.eventDetails as unknown as EventDetailsDraft
  const schedule = ed.schedule
  const venue    = ed.venue

  const startDate  = schedule?.startDate ?? ''
  const endDate    = schedule?.endDate   ?? startDate
  const startTime  = schedule?.startTime ?? ''
  const endTime    = schedule?.endTime   ?? ''
  const title      = ed.info?.name?.trim() || 'Event'
  const description = (ed.info?.shortDesc || ed.info?.fullDesc || '').trim()

  // Build location string
  const venueType = venue?.type ?? 'physical'
  const physical  = venue?.physical
  const online    = venue?.online
  let location = ''
  if (venueType === 'online' || venueType === 'hybrid') {
    location = online?.platform ? `${online.platform} (Online)` : 'Online'
  } else {
    const parts = [physical?.name, physical?.addressLine1, physical?.city, physical?.state].filter(Boolean)
    location = parts.join(', ')
  }

  const icsContent = generateIcs({
    uid:         `${slug}@registerdesk.in`,
    title,
    description,
    location,
    url:         `${BASE_URL}/events/${slug}`,
    startDate,
    endDate,
    startTime,
    endTime,
  })

  return new Response(icsContent, {
    status: 200,
    headers: {
      'Content-Type':        'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}.ics"`,
      'Cache-Control':       'public, max-age=300, stale-while-revalidate=60',
    },
  })
}
