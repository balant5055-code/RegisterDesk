// RD-MEDIA-06 · One gallery's photos.
//
// The page that was missing. Before it, an organizer could upload photos and see only a
// counter go up — the Galleries page listed metadata and nothing anywhere rendered a
// thumbnail, even though the asset endpoint had existed since RD-MEDIA-01.
//
// The gallery id is in the path so a gallery is deep-linkable and the browser Back button
// returns to the list. The workspace context (RD-MEDIA-03) still supplies the event, so
// arriving here directly resumes the same workspace as every other Media Studio page.

import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'
import { GalleryBrowserClient } from '@/features/media-studio/components/GalleryBrowserClient'

export const metadata = { title: 'Gallery — Media Studio' }

type Params = { params: Promise<{ galleryId: string }> }

export default async function MediaStudioGalleryPage({ params }: Params) {
  const { galleryId } = await params

  return (
    <div className="space-y-5">
      <MediaStudioHeader
        title="Gallery"
        subtitle="Every photo in this gallery. Publish, download or remove them."
        crumb="Gallery"
      />
      <GalleryBrowserClient galleryId={galleryId} />
    </div>
  )
}
