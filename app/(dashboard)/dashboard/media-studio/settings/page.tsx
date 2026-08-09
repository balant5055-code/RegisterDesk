// RD-MEDIA-01 · Media Studio settings.

import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'
import { SettingsClient } from '@/features/media-studio/components/SettingsClient'
import { MediaLimitsPanel } from '@/features/media-studio/components/MediaLimitsPanel'
import { EventOverridesPanel } from '@/features/media-studio/components/EventOverridesPanel'
import { EventContextBar } from '@/features/media-studio/components/EventContextBar'

export const metadata = { title: 'Media Settings — Media Studio' }

export default function MediaStudioSettingsPage() {
  return (
    <div className="space-y-5">
      {/* RD-MEDIA-UX-04 — the SAME header as every other Media Studio page. A bare
          PageHeader dropped the event from the breadcrumb, so navigation read differently
          depending on which page you landed on. */}
      <MediaStudioHeader
        title="Settings"
        subtitle="Defaults applied to every new import in this workspace."
      />
      {/* RD-MEDIA-08 — the effective limits for the workspace's event, resolved by the
          backend. This page displays them and computes nothing. */}
      <EventContextBar />
      <MediaLimitsPanel />
      <EventOverridesPanel />
      <SettingsClient />
    </div>
  )
}
