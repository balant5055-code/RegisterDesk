// Phase P.2.9 — /platform/finance route. Server Component (config only).

import type { Metadata } from 'next'
import { PlatformPage } from '@/components/marketing/platform/PlatformPage'
import { buildPlatformMetadata } from '@/lib/marketing/platform/seo'
import { FINANCE_PAGE } from '@/content/marketing/platform-finance'

export const metadata: Metadata = buildPlatformMetadata(FINANCE_PAGE)

export default function FinancePlatformPage() {
  return <PlatformPage config={FINANCE_PAGE} />
}
