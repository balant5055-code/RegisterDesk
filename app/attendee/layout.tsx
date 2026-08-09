// RD-LAUNCH-07 — attendee portal layout. Server Component.
//
// The interactive shell moved to components/attendee/AttendeeLayoutShell so this file
// can export `metadata`; the rendered output is identical.
//
// noIndex: the attendee portal shows one person's own registrations, tickets and
// certificates. It is private by nature and must never be indexed.

import type { Metadata } from 'next'
import { buildMetadata } from '@/lib/marketing/seo'
import { AttendeeLayoutShell } from '@/components/attendee/AttendeeLayoutShell'

export const metadata: Metadata = buildMetadata({
  title:       'My Account | RegisterDesk',
  description: 'View your event registrations, tickets and certificates.',
  path:        '/attendee',
  noIndex:     true,
})

export default function AttendeeLayout({ children }: { children: React.ReactNode }) {
  return <AttendeeLayoutShell>{children}</AttendeeLayoutShell>
}
