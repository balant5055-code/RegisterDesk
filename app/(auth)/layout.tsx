// RD-LAUNCH-07 — metadata for the authentication route group.
//
// The pages in this group (login/signup, forgot-password, verify-email, welcome) are
// all Client Components, and a Client Component cannot export `metadata`. That is why
// RD-LAUNCH-01 P1-7 found them with no title, description or canonical at all — not
// neglect, an architectural constraint. A Server Component layout is the correct place.
//
// noIndex: sign-in and verification screens must never appear in search results. They
// carry no public content, and an indexed verification page is an invitation to
// phishing look-alikes.

import type { Metadata } from 'next'
import { buildMetadata } from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'Sign in | RegisterDesk',
  description: 'Sign in to your RegisterDesk organizer account to create and manage events.',
  path:        '/login',
  noIndex:     true,
})

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
