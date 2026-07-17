// Phase P.2.7 — /platform/certificates route. Server Component (config only).
//
// The shared PlatformPage renderer builds the page from CERTIFICATES_PAGE config.

import type { Metadata } from 'next'
import { PlatformPage } from '@/components/marketing/platform/PlatformPage'
import { buildPlatformMetadata } from '@/lib/marketing/platform/seo'
import { CERTIFICATES_PAGE } from '@/content/marketing/platform-certificates'

export const metadata: Metadata = buildPlatformMetadata(CERTIFICATES_PAGE)

export default function CertificatesPlatformPage() {
  return <PlatformPage config={CERTIFICATES_PAGE} />
}
