// RD-MEDIA-05 · Media maintenance.
//
// The manual replacement for a scheduler. This deployment runs no cron, so the pipeline that
// advances bulk jobs and reclaims stranded storage needs a person to press a button — and
// this is that button. It executes the SAME service a cron tick would
// (`features/media-studio/services/maintenanceService.ts`), so scheduling it later changes
// nothing about how the work is done.
//
// Platform-admin only, enforced by the API. The page renders an explanation rather than a
// dead button for anyone else.

import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'
import { MaintenanceClient } from '@/features/media-studio/components/MaintenanceClient'

export const metadata = { title: 'Maintenance — Media Studio' }

export default function MediaStudioMaintenancePage() {
  return (
    <div className="space-y-5">
      <MediaStudioHeader
        title="Maintenance"
        subtitle="Advance queued bulk operations and reclaim storage that nothing points at."
      />
      <MaintenanceClient />
    </div>
  )
}
