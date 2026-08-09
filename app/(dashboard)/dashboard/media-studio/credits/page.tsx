// MC-07 · Media Studio → Credits.
//
// The destination for every "Buy credits" button. Display only — every figure comes from an
// existing endpoint and nothing on this page computes a balance, a price or a charge.

import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'
import { CreditsDashboardClient } from '@/features/media-credits/components/CreditsDashboardClient'

export const metadata = { title: 'Credits — Media Studio' }

export default function MediaStudioCreditsPage() {
  return (
    <div className="space-y-5">
      {/* The same header as every other Media Studio page — a bare PageHeader here would
          drop the module breadcrumb and make navigation read differently on this one page. */}
      <MediaStudioHeader
        title="Credits"
        subtitle="Your balance, purchases and upload usage."
      />
      <CreditsDashboardClient />
    </div>
  )
}
