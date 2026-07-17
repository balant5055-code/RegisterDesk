// Phase P.2.10 — /platform/api route. Server Component (config only).

import type { Metadata } from 'next'
import { PlatformPage } from '@/components/marketing/platform/PlatformPage'
import { buildPlatformMetadata } from '@/lib/marketing/platform/seo'
import { API_PAGE } from '@/content/marketing/platform-api'

export const metadata: Metadata = buildPlatformMetadata(API_PAGE)

export default function ApiPlatformPage() {
  return <PlatformPage config={API_PAGE} />
}
