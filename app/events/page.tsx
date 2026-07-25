import type { Metadata }       from 'next'
import { listPublishedEvents } from '@/lib/firebase/firestore/publicEvents'
import { DiscoveryClient }     from './DiscoveryClient'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

export const revalidate = 60

export const metadata: Metadata = {
  title:       'Discover Events — RegisterDesk',
  description: 'Find conferences, workshops, marathons, startup meetups, and more across India. Register instantly with secure payments.',
  metadataBase: new URL(BASE_URL),
  alternates:  { canonical: `${BASE_URL}/events` },
  keywords:    ['events', 'conferences', 'workshops', 'marathon', 'startup events', 'India events', 'RegisterDesk'],
  openGraph: {
    type:        'website',
    url:         `${BASE_URL}/events`,
    title:       'Discover Events — RegisterDesk',
    description: 'Find conferences, workshops, marathons, and more. Register instantly.',
    siteName:    'RegisterDesk',
  },
  twitter: {
    card:        'summary_large_image',
    title:       'Discover Events — RegisterDesk',
    description: 'Find conferences, workshops, marathons, and more. Register instantly.',
  },
}

export default async function EventsDiscoveryPage() {
  // First page (48) — keeps the initial render + hero stats identical to before; discovery is
  // now cursor-paginated so events beyond the first page are reachable (RD-DISCOVERY-01 / D-C1).
  const { events, stats, nextCursor } = await listPublishedEvents({ limit: 48 }).catch(() => ({
    events:     [],
    stats:      { totalEvents: 0, totalRegistrations: 0, totalCities: 0, totalOrganizers: 0 },
    nextCursor: null,
  }))

  return <DiscoveryClient initialEvents={events} initialStats={stats} initialNextCursor={nextCursor} />
}
