// RD-LAUNCH-07 — metadata for the team-invitation acceptance page.
//
// Client Component page → metadata must live in a Server Component layout. noIndex:
// the URL carries a single-use invitation token and must never be indexed.

import type { Metadata } from 'next'
import { buildMetadata } from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'Accept invitation | RegisterDesk',
  description: 'Accept your invitation to join a RegisterDesk workspace.',
  path:        '/team/accept',
  noIndex:     true,
})

export default function TeamAcceptLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
