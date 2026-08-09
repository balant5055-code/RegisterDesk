// RD-MEDIA-01 · Import Media.

import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'
import { ImportClient } from '@/features/media-studio/components/ImportClient'

export const metadata = { title: 'Import Media — Media Studio' }

export default function MediaStudioImportPage() {
  return (
    <div className="space-y-5">
      <MediaStudioHeader title="Import Media" subtitle="Bulk upload photos by folder or selection. Compression is automatic." />
      <ImportClient />
    </div>
  )
}
