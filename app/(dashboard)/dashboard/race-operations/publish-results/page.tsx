// RD-RACEOPS-01 · Race Operations — Publish Results.
//
// The complete flow: event → race → prepare & upload → map → validate → verify → rank →
// review → publish. Gated for the workspace owner / admin and for sports events
// (RD-RACEOPS-02B); the flow itself lives in features/race-operations.

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
        subtitle="Select a race, prepare or upload its results file, check it against the start list, then rank and publish."
        breadcrumb={[
          { label: 'Race Operations', href: ROUTES.RACE_OPS },
          { label: 'Publish Results' },
        ]}
      />
      <RaceOpsAccessGate>
        <PublishResultsFlow />
      </RaceOpsAccessGate>
    </div>
  )
}
