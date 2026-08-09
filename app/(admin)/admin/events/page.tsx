// RD-ADMIN-CLOSURE-01 · Events list — the parent Event 360 never had.
//
// A Server Component so the page can export `metadata`; the console itself is the client
// module beside it. This is the pattern Next.js documents for a client page that needs a
// title, and the one `/admin/media-credits` already uses.

import { adminMetadata } from '@/app/(admin)/adminMetadata'
import PageClient from './PageClient'

export const metadata = adminMetadata(
  'Events',
  'Every published event on the platform, with a link to its Event 360 console.',
)

export default function AdminEventsPage() {
  return <PageClient />
}
