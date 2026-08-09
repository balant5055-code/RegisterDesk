// RD-RACEOPS-01 · Race Operations — Publish Results.
//
// Sprint 1 shell: event + race selection are live; upload, validation, preview and
// publish are declared placeholders. No backend logic, no writes.

import { PageHeader } from '@/components/ui'
import { PublishResultsFlow, RaceOpsAccessGate } from '@/features/race-operations'
import { ROUTES } from '@/config/navigation'

export const metadata = {
  title: 'Publish Results — RegisterDesk',
}

export default function PublishResultsPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Publish Results"
        subtitle="Select an event and race, then upload, validate and publish finishing results."
        breadcrumb={[
          { label: 'Race Operations', href: ROUTES.RACE_OPS },
          { label: 'Publish Results' },
        ]}
        status={[{ label: 'Foundation', tone: 'warning' }]}
      />
      <RaceOpsAccessGate>
        <PublishResultsFlow />
      </RaceOpsAccessGate>
    </div>
  )
}
