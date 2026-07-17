// Phase P.2.5 — /platform/identifiers route. Server Component (config only).
//
// The shared PlatformPage renderer builds the page from IDENTIFIERS_PAGE config.

import type { Metadata } from 'next'
import { PlatformPage } from '@/components/marketing/platform/PlatformPage'
import { buildPlatformMetadata } from '@/lib/marketing/platform/seo'
import { IDENTIFIERS_PAGE } from '@/content/marketing/platform-identifiers'

export const metadata: Metadata = buildPlatformMetadata(IDENTIFIERS_PAGE)

export default function IdentifiersPlatformPage() {
  return <PlatformPage config={IDENTIFIERS_PAGE} />
}
