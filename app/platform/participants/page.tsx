// Phase P.2.4 — /platform/participants route. Server Component (config only).
//
// The shared PlatformPage renderer builds the page from PARTICIPANTS_PAGE config.

import type { Metadata } from 'next'
import { PlatformPage } from '@/components/marketing/platform/PlatformPage'
import { buildPlatformMetadata } from '@/lib/marketing/platform/seo'
import { PARTICIPANTS_PAGE } from '@/content/marketing/platform-participants'

export const metadata: Metadata = buildPlatformMetadata(PARTICIPANTS_PAGE)

export default function ParticipantsPlatformPage() {
  return <PlatformPage config={PARTICIPANTS_PAGE} />
}
