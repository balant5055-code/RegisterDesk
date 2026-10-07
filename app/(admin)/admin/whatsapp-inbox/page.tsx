// WhatsApp Inbox (Phase 1c) — Super Admin view of attendee replies across organizers, and the
// unmatched-message queue. Server wrapper so the route can export `metadata`; the console
// itself is PageClient.tsx, as every admin page is split.

import { Suspense } from 'react'
import { adminMetadata } from '@/app/(admin)/adminMetadata'
import PageClient from './PageClient'

export const metadata = adminMetadata('WhatsApp Inbox', 'Attendee WhatsApp replies across organizers, and unmatched messages.')

export default function Page() {
  return (
    <Suspense>
      <PageClient />
    </Suspense>
  )
}
