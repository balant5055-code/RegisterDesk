// RD-MEDIA-01 · Storage usage.

import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'
import { StorageDashboardClient } from '@/features/media-studio/components/StorageDashboardClient'

export const metadata = { title: 'Storage Usage — Media Studio' }

export default function MediaStudioStoragePage() {
  return (
    <div className="space-y-5">
      <MediaStudioHeader title="Storage Usage" subtitle="Storage used, photo count, compression savings and average file size." />
      <StorageDashboardClient />
    </div>
  )
}
