// Phase P.2.6 — /platform/check-in route. Server Component (config only).
//
// The shared PlatformPage renderer builds the page from CHECKIN_PAGE config.

import type { Metadata } from 'next'
import { PlatformPage } from '@/components/marketing/platform/PlatformPage'
import { buildPlatformMetadata } from '@/lib/marketing/platform/seo'
import { CHECKIN_PAGE } from '@/content/marketing/platform-checkin'

export const metadata: Metadata = buildPlatformMetadata(CHECKIN_PAGE)

export default function CheckinPlatformPage() {
  return <PlatformPage config={CHECKIN_PAGE} />
}
