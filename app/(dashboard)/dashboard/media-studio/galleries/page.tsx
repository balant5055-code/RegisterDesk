// RD-MEDIA-01 · Galleries.

import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'
import { GalleriesClient } from '@/features/media-studio/components/GalleriesClient'

export const metadata = { title: 'Galleries — Media Studio' }

export default function MediaStudioGalleriesPage() {
  return (
    <div className="space-y-5">
      <MediaStudioHeader title="Galleries" subtitle="Organise photos by race, location or moment." />
      <GalleriesClient focus="galleries" />
    </div>
  )
}
