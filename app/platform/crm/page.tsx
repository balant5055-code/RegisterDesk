// Phase P.2.8 — /platform/crm route. Server Component (config only).

import type { Metadata } from 'next'
import { PlatformPage } from '@/components/marketing/platform/PlatformPage'
import { buildPlatformMetadata } from '@/lib/marketing/platform/seo'
import { CRM_PAGE } from '@/content/marketing/platform-crm'

export const metadata: Metadata = buildPlatformMetadata(CRM_PAGE)

export default function CrmPlatformPage() {
  return <PlatformPage config={CRM_PAGE} />
}
