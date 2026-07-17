// Phase P.2.3 — /platform/payments route. Server Component (config only).
//
// No layout/hero/CTA/FAQ here — the shared PlatformPage renderer builds the page
// from PAYMENTS_PAGE config. Metadata reuses buildPlatformMetadata.

import type { Metadata } from 'next'
import { PlatformPage } from '@/components/marketing/platform/PlatformPage'
import { buildPlatformMetadata } from '@/lib/marketing/platform/seo'
import { PAYMENTS_PAGE } from '@/content/marketing/platform-payments'

export const metadata: Metadata = buildPlatformMetadata(PAYMENTS_PAGE)

export default function PaymentsPlatformPage() {
  return <PlatformPage config={PAYMENTS_PAGE} />
}
