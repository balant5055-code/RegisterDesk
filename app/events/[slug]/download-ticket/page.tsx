// /events/[slug]/download-ticket — public "Download Your Ticket".
//
// The destination attendees are sent to after registering, and the answer to "how do I get
// my ticket again?". It carries ONLY the event slug: no name, registration id, ticket code
// or token. Identity is established here, by the attendee, and every lookup is scoped to
// this slug server-side.
//
// Server component: it resolves the event name for the header and hands off to the client
// island. NO registration data is fetched here — that happens only after the attendee
// proves who they are through the rate-limited lookup API.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { adminDb } from '@/lib/firebase/admin'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { DownloadTicketClient } from './DownloadTicketClient'

type Params = { params: Promise<{ slug: string }> }

/** Event name for the page header, or null when the slug is not a real event. */
async function getEventName(slug: string): Promise<string | null> {
  try {
    const snap = await adminDb.collection('events').doc(slug).get()
    if (!snap.exists) return null
    const d    = snap.data() as Record<string, unknown>
    const ed   = (d.eventDetails as Record<string, unknown> | undefined) ?? {}
    const info = (ed.info as Record<string, unknown> | undefined) ?? {}
    const name = typeof info.name === 'string' ? info.name.trim() : ''
    return name || slug
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const name = await getEventName(slug)
  return {
    title:       name ? `Download Your Ticket — ${name}` : 'Download Your Ticket',
    description: 'Enter your ticket ID and registered mobile number to download your ticket.',
    // A per-attendee action behind an identity check — nothing here is worth indexing, and
    // keeping it out of search results avoids advertising a lookup surface.
    robots: { index: false, follow: false },
  }
}

export default async function DownloadTicketPage({ params }: Params) {
  const { slug } = await params
  const eventName = await getEventName(slug)
  if (!eventName) notFound()

  return (
    // Same shell and background as the Certificate Center, so the two attendee-facing
    // lookup pages read as one product rather than two.
    <MarketingPageLayout>
      <div className="min-h-[60vh] bg-[#f7f8fa]">
        <DownloadTicketClient slug={slug} eventName={eventName} />
      </div>
    </MarketingPageLayout>
  )
}
