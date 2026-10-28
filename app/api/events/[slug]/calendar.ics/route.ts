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
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'
import { stripMarkdown } from '@/components/event-templates/shared/ui/RichText'

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
  // RD-CUSTOM-AUDIT-02 — calendars show plain text, never the organizer's Markdown markers.
  const description = (ed.info?.shortDesc?.trim() || stripMarkdown(ed.info?.fullDesc)).trim()

  // Build location string
  const venueType = venue?.type ?? 'physical'
  const physical  = venue?.physical
  const online    = venue?.online
  // RD-CUSTOM-AUDIT-02 — the platform's NAME (it printed the raw id, "zoom"), and a hybrid event
  // keeps its physical address. Never the meeting link, ID or passcode: this file is public.
  const platform = online?.platform
    ? (online.platform === 'custom' && online.platformCustomName?.trim() ? online.platformCustomName.trim() : ONLINE_PLATFORM_LABELS[online.platform] ?? 'Online')
    : 'Online'
  const address  = [physical?.name, physical?.addressLine1, physical?.city, physical?.state].filter(Boolean).join(', ')
  const location = venueType === 'online' ? `${platform} (Online)`
    : venueType === 'hybrid' ? (address ? `${address} · also online via ${platform}` : `${platform} (Online)`)
    : address

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
