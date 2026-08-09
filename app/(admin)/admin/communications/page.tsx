// RD-ADMIN-CLOSURE-01 · Server wrapper so this route can export `metadata`.
//
// Next.js supports `metadata` only in Server Components and this console is a Client
// Component, so the page is split exactly as the framework documents: the route file is a
// Server Component and the interactive module sits beside it in PageClient.tsx. No logic
// moved — the client file is the previous page.tsx, byte for byte.

import { adminMetadata } from '@/app/(admin)/adminMetadata'
import PageClient from './PageClient'

export const metadata = adminMetadata("Communications", "Usage, failures, costs and broadcasts.")

export default function Page() {
  return <PageClient />
}
