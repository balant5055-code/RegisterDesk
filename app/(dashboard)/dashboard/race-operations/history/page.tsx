// RD-RACEOPS-01 · Race Operations — History.
//
// RD-RESULTS-CLOSURE-01 · this used to render a permanent empty state and read nothing,
// which stopped being honest the moment import and publish shipped. It now reads the real
// import sessions and published version records.

import { PageHeader } from '@/components/ui'
import { HistoryPanel, RaceOpsAccessGate } from '@/features/race-operations'
import { ROUTES } from '@/config/navigation'

export const metadata = {
  title: 'Race Operations History — RegisterDesk',
}

export default function RaceOpsHistoryPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="History"
        subtitle="Import history, publish logs and rollback information for every race."
        breadcrumb={[
          { label: 'Race Operations', href: ROUTES.RACE_OPS },
          { label: 'History' },
        ]}
      />
      <RaceOpsAccessGate>
        <HistoryPanel />
      </RaceOpsAccessGate>
    </div>
  )
}
