// Phase P.2.11 — /platform/security route. Server Component (config only).

import type { Metadata } from 'next'
import { PlatformPage } from '@/components/marketing/platform/PlatformPage'
import { buildPlatformMetadata } from '@/lib/marketing/platform/seo'
import { SECURITY_PAGE } from '@/content/marketing/platform-security'

export const metadata: Metadata = buildPlatformMetadata(SECURITY_PAGE)

export default function SecurityPlatformPage() {
  return <PlatformPage config={SECURITY_PAGE} />
}
