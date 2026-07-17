// Phase P.2.2B — /platform/registration route. Server Component (config only).
//
// No layout/hero/CTA/FAQ here — the shared PlatformPage renderer builds the page
// from REGISTRATION_PAGE config. Metadata reuses buildPlatformMetadata.

import type { Metadata } from 'next'
import { PlatformPage } from '@/components/marketing/platform/PlatformPage'
import { buildPlatformMetadata } from '@/lib/marketing/platform/seo'
import { REGISTRATION_PAGE } from '@/content/marketing/platform-registration'

export const metadata: Metadata = buildPlatformMetadata(REGISTRATION_PAGE)

export default function RegistrationPlatformPage() {
  return <PlatformPage config={REGISTRATION_PAGE} />
}
