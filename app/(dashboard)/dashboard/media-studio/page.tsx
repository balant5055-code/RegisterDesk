// RD-MEDIA-01 · Media Studio hub.
//
// A real page at the nav group's href — the collapsed 72px sidebar links each group
// straight to group.href, so a group without one 404s.
//
// The grid lives in a CLIENT component because its entries carry icon COMPONENTS, and a
// server component cannot pass a function across the client boundary.

import { PageHeader } from '@/components/ui'
import { MediaStudioHub } from '@/features/media-studio/components/MediaStudioHub'

export const metadata = { title: 'Media Studio — RegisterDesk' }

export default function MediaStudioHubPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Media Studio"
        subtitle="Bulk photo import, galleries, albums and storage for your events."
        breadcrumb={[{ label: 'Operations' }, { label: 'Media Studio' }]}
      />
      <MediaStudioHub />
    </div>
  )
}
