// RD-LAUNCH-07 — metadata for the admin sign-in route group.
//
// The page is a Client Component and cannot export `metadata` itself. Indexing an
// internal admin entry point would be actively harmful, so this is noIndex.

import type { Metadata } from 'next'
import { buildMetadata } from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'Admin sign in | RegisterDesk',
  description: 'Internal administration access for the RegisterDesk platform.',
  path:        '/admin/login',
  noIndex:     true,
})

export default function AdminAuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
