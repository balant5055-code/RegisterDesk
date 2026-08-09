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
  //
  // A FAILED QUERY MUST NOT RENDER AS "no events". This page is ISR (`revalidate = 60`), so a
  // render that SUCCEEDS is written to the page cache and served to everyone until the next
  // revalidation. Swallowing the rejection here therefore did not degrade one request — it baked
  // an empty discovery page into the cache for the whole window, which is exactly the
  // intermittent "shell renders, cards missing, even on hard refresh" report.
  //
  // Letting it throw is what makes the page self-healing: Next.js does not cache a render that
  // threw, so the last good page keeps being served and the next request retries. The root
  // `app/error.tsx` boundary surfaces a branded, recoverable screen; in production Next.js
  // replaces the message with a generic one and exposes only a `digest`, so nothing sensitive
  // reaches the browser. The real cause is logged here, server-side, before rethrowing.
  // Only the await is guarded — the JSX is constructed outside the try, so a render error is
  // left to the error boundary rather than being caught here (react-hooks/error-boundaries).
  let data: Awaited<ReturnType<typeof listPublishedEvents>>
  try {
    data = await listPublishedEvents({ limit: 48 })
  } catch (err) {
    console.error('[events/page] discovery query failed:', err)
    throw err
  }

  return (
    <DiscoveryClient
      initialEvents={data.events}
      initialStats={data.stats}
      initialNextCursor={data.nextCursor}
    />
  )
}
