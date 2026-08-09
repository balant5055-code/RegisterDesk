// RD-RACEOPS-01 · Race Operations — module hub.
//
// Thin route file: header + gate + the module's own hub component. All behaviour
// lives in features/race-operations/, imported through its public barrel only.

import { PageHeader } from '@/components/ui'
import { RaceOpsAccessGate, RaceOpsOverview } from '@/features/race-operations'

export const metadata = {
  title: 'Race Operations — RegisterDesk',
}

export default function RaceOperationsPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Race Operations"
        subtitle="Publish finishing results, manage race photography, and issue certificates for your races."
        breadcrumb={[{ label: 'Operations' }, { label: 'Race Operations' }]}
      />
      <RaceOpsAccessGate>
        <RaceOpsOverview />
      </RaceOpsAccessGate>
    </div>
  )
}
