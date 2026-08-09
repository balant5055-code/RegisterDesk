// RD-MEDIA-01 · Albums.

import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'
import { GalleriesClient } from '@/features/media-studio/components/GalleriesClient'

export const metadata = { title: 'Albums — Media Studio' }

export default function MediaStudioAlbumsPage() {
  return (
    <div className="space-y-5">
      <MediaStudioHeader title="Albums" subtitle="Subdivide a gallery by camera or vantage point." />
      <GalleriesClient focus="albums" />
    </div>
  )
}
